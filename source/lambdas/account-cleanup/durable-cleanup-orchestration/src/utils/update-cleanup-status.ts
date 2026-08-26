// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { CleanupStatus } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";

import type { CleanupContext } from "../steps/types.js";

/**
 * Sets the `activeCleanup` object on the account record with the given status
 * and updates the cleanup report's `cleanupStatus` field.
 * Preserves the execution ARN and start time from the cleanup context.
 *
 * Must be called inside a durable step for replay safety.
 */
export async function updateCleanupStatus(
  ctx: CleanupContext,
  status: CleanupStatus,
): Promise<void> {
  const {
    accountStore,
    accountId,
    executionArn,
    executionStartTime,
    reportWriter,
    reportKey,
  } = ctx;

  await accountStore.update(accountId, {
    set: {
      activeCleanup: {
        status,
        executionArn,
        startedAt: executionStartTime,
      },
    },
  });

  await reportWriter.updateReport(reportKey, {
    cleanupStatus: status,
  });
}

export type CleanupOutcome = "COMPLETED" | "FAILED";

/**
 * Resolves a cleanup by clearing `activeCleanup` from the account record,
 * appending the terminal step to the report, and finalizing the report
 * with the given outcome.
 *
 * On COMPLETED: appends "cleanup-complete" step, report status = COMPLETED.
 * On FAILED: appends "cleanup-failed" step, report status = FAILED, with error details.
 *
 * Must be called inside a durable step for replay safety.
 */
export async function resolveCleanupStatus(
  ctx: CleanupContext,
  outcome: CleanupOutcome,
  error?: { step: string; message: string },
): Promise<void> {
  const { accountStore, accountId, reportWriter, reportKey } = ctx;

  await accountStore.update(accountId, {
    remove: ["activeCleanup"],
  });

  const terminalStep =
    outcome === "COMPLETED" ? "cleanup-complete" : "cleanup-failed";
  await reportWriter.appendStep(reportKey, terminalStep);

  await reportWriter.finalizeReport(reportKey, {
    status: outcome,
    cleanupStatus: outcome,
    ...(error && { error }),
  });
}
