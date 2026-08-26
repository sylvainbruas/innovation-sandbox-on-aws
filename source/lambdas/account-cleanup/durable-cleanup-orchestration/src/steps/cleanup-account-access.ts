// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { fromTemporaryIsbIdcCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import {
  AccountAssignment,
  DeleteAccountAssignmentCommand,
  DescribeAccountAssignmentDeletionStatusCommand,
  ListAccountAssignmentsCommandInput,
  paginateListAccountAssignments,
  SSOAdminClient,
  SSOAdminPaginationConfiguration,
  StatusValues,
  TargetType,
} from "@aws-sdk/client-sso-admin";
import { backOff } from "exponential-backoff";
import pThrottle from "p-throttle";

import type { CleanupContext } from "./types.js";

/**
 * Result of the Account access cleanup step.
 */
export interface CleanupAccountAccessResult {
  assignmentsFound: number;
  assignmentsDeleted: number;
  principalRecordsFound: number;
  principalRecordsDeleted: number;
}

// 1 IDC mutation per second — conservative to stay well within 20 TPS shared limit.
const throttledIdcOperation = pThrottle({ limit: 1, interval: 1000 });

/**
 * Remediates lingering IDC assignments for a sandbox account before nuke
 * destroys resources, so users cannot interact with the account during cleanup.
 *
 * Flow:
 * 1. List all assignments on the user permission set
 * 2. Delete each assignment and poll for completion (throttled to 1 TPS)
 * 3. Delete orphaned Principal Table records for the lease
 *
 * All operations use attempt-all-then-throw semantics: every operation is
 * attempted regardless of individual failures, and the step throws at the
 * end if any failures occurred — quarantining the account.
 */
export async function cleanupAccountAccess(
  ctx: CleanupContext,
): Promise<CleanupAccountAccessResult> {
  const { accountId, durableContext } = ctx;

  // Step 1 + 2: List and delete IDC assignments
  const idcResults = await deleteAllAssignments(ctx);

  // Step 3: Delete Principal Table records
  const principalResults = await deleteLeaseAssignmentRecords(ctx);

  const idcFailed = idcResults.filter((r) => r.status === "rejected").length;
  const idcSucceeded = idcResults.length - idcFailed;
  const principalFailed = principalResults.filter(
    (r) => r.status === "rejected",
  ).length;
  const principalSucceeded = principalResults.length - principalFailed;

  durableContext.logger.info("Account access cleanup complete", {
    accountId,
    assignmentsFound: idcResults.length,
    assignmentsDeleted: idcSucceeded,
    idcDeletionsFailed: idcFailed,
    principalRecordsFound: principalResults.length,
    principalRecordsDeleted: principalSucceeded,
    principalDeletionsFailed: principalFailed,
  });

  const errors: string[] = [];
  if (idcFailed > 0) {
    errors.push(
      `${idcFailed}/${idcResults.length} IDC assignment deletions failed`,
    );
  }
  if (principalFailed > 0) {
    errors.push(`${principalFailed} Principal Table record deletions failed`);
  }

  // Write access cleanup summary to the report for the finalize step's metric
  const { reportWriter, reportKey } = ctx;
  await reportWriter
    .updateReport(reportKey, {
      accessCleanupSummary: {
        assignmentsFound: idcResults.length,
        assignmentsDeleted: idcSucceeded,
        principalRecordsFound: principalResults.length,
        principalRecordsDeleted: principalSucceeded,
        failed: idcFailed > 0 || principalFailed > 0,
      },
    })
    .catch((error: unknown) => {
      durableContext.logger.warn(
        "Failed to write access cleanup summary to report",
        {
          accountId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    });

  if (errors.length > 0) {
    throw new Error(
      `Account access cleanup failed for account ${accountId}: ${errors.join("; ")}`,
    );
  }

  return {
    assignmentsFound: idcResults.length,
    assignmentsDeleted: idcSucceeded,
    principalRecordsFound: principalResults.length,
    principalRecordsDeleted: principalSucceeded,
  };
}

async function listUserPermissionSetAssignments(
  ssoAdminClient: SSOAdminClient,
  instanceArn: string,
  accountId: string,
  permissionSetArn: string,
): Promise<AccountAssignment[]> {
  const assignments: AccountAssignment[] = [];

  const paginatorConfig: SSOAdminPaginationConfiguration = {
    client: ssoAdminClient,
  };
  const input: ListAccountAssignmentsCommandInput = {
    InstanceArn: instanceArn,
    AccountId: accountId,
    PermissionSetArn: permissionSetArn,
  };

  const paginator = paginateListAccountAssignments(paginatorConfig, input);

  for await (const page of paginator) {
    if (page.AccountAssignments) {
      assignments.push(...page.AccountAssignments);
    }
  }

  return assignments;
}

async function deleteAllAssignments(
  ctx: CleanupContext,
): Promise<PromiseSettledResult<void>[]> {
  const { accountId, env, durableContext } = ctx;

  const idcCredentials = fromTemporaryIsbIdcCredentials(env);
  const ssoAdminClient = IsbClients.ssoAdmin(env, idcCredentials);
  const idcConfig = await IsbServices.idcStackConfigStore(env).get();
  const { ssoInstanceArn, userPermissionSetArn } = idcConfig;

  const assignments = await listUserPermissionSetAssignments(
    ssoAdminClient,
    ssoInstanceArn,
    accountId,
    userPermissionSetArn,
  );

  durableContext.logger.info("Account access cleanup: assignments found", {
    accountId,
    assignmentsFound: assignments.length,
  });

  const throttledDelete = throttledIdcOperation(
    async (assignment: AccountAssignment) => {
      const response = await ssoAdminClient.send(
        new DeleteAccountAssignmentCommand({
          InstanceArn: ssoInstanceArn,
          PermissionSetArn: userPermissionSetArn,
          PrincipalId: assignment.PrincipalId,
          PrincipalType: assignment.PrincipalType,
          TargetId: accountId,
          TargetType: TargetType.AWS_ACCOUNT,
        }),
      );

      const requestId = response.AccountAssignmentDeletionStatus?.RequestId;
      if (requestId) {
        await pollDeletionStatus(ssoAdminClient, ssoInstanceArn, requestId);
      }
    },
  );

  return Promise.allSettled(
    assignments.map((assignment) =>
      throttledDelete(assignment)
        .then(() => {
          durableContext.logger.info(
            "Account access cleanup: deleted assignment",
            {
              accountId,
              principalId: assignment.PrincipalId,
              principalType: assignment.PrincipalType,
            },
          );
        })
        .catch((error: unknown) => {
          durableContext.logger.error(
            "Account access cleanup: failed to delete assignment",
            {
              accountId,
              principalId: assignment.PrincipalId,
              principalType: assignment.PrincipalType,
              error: error instanceof Error ? error.message : String(error),
            },
          );
          throw error;
        }),
    ),
  );
}

async function pollDeletionStatus(
  ssoAdminClient: SSOAdminClient,
  instanceArn: string,
  requestId: string,
): Promise<void> {
  await backOff(
    async () => {
      const response = await ssoAdminClient.send(
        new DescribeAccountAssignmentDeletionStatusCommand({
          InstanceArn: instanceArn,
          AccountAssignmentDeletionRequestId: requestId,
        }),
      );

      const status = response.AccountAssignmentDeletionStatus?.Status;

      if (status === StatusValues.SUCCEEDED) {
        return;
      }

      if (status === StatusValues.FAILED) {
        throw new Error(
          `IDC DeleteAccountAssignment failed: ${response.AccountAssignmentDeletionStatus?.FailureReason ?? "Unknown"} (requestId: ${requestId})`,
        );
      }

      throw new DeletionInProgressError(requestId);
    },
    {
      numOfAttempts: 5,
      startingDelay: 2000,
      jitter: "full",
      retry: (error: unknown) => error instanceof DeletionInProgressError,
    },
  );
}

async function deleteLeaseAssignmentRecords(
  ctx: CleanupContext,
): Promise<PromiseSettledResult<void>[]> {
  const { accountId, env, durableContext, accountStore } = ctx;

  const accountResult = await accountStore.get(accountId);
  const leaseId = accountResult.result?.currentLease?.leaseId;

  if (!leaseId) {
    durableContext.logger.info(
      "Account access cleanup: no currentLease on account record, skipping Principal Table cleanup",
      { accountId },
    );
    return [];
  }

  const principalStore = IsbServices.principalStore(env);
  const { result: records } = await principalStore.getAssignmentsForLease({
    leaseId,
  });

  return Promise.allSettled(
    records.map((record) =>
      (record.principalType === "USER"
        ? principalStore.deleteUserAssignment(record.userId, leaseId)
        : principalStore.deleteGroupAssignment(record.groupId, leaseId)
      )
        .then(() => {
          durableContext.logger.info(
            "Account access cleanup: deleted Principal Table record",
            {
              accountId,
              leaseId,
              principalType: record.principalType,
            },
          );
        })
        .catch((error: unknown) => {
          durableContext.logger.error(
            "Account access cleanup: failed to delete Principal Table record",
            {
              accountId,
              leaseId,
              principalType: record.principalType,
              error: error instanceof Error ? error.message : String(error),
            },
          );
          throw error;
        }),
    ),
  );
}

class DeletionInProgressError extends Error {
  constructor(requestId: string) {
    super(
      `IDC DeleteAccountAssignment still in progress (requestId: ${requestId})`,
    );
    this.name = "DeletionInProgressError";
  }
}
