// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { SSOAdminClient } from "@aws-sdk/client-sso-admin";
import { z } from "zod";

import { IdcStackConfigStore } from "@amzn/innovation-sandbox-commons/data/idc-stack-config/ssm-idc-stack-config-store.js";
import { LeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/lease-store.js";
import {
  Lease,
  LeaseLockIntentSchema,
  type LeaseResourceLock,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { PrincipalStore } from "@amzn/innovation-sandbox-commons/data/principal/principal-store.js";
import { PrincipalType } from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import { IdcService } from "@amzn/innovation-sandbox-commons/isb-services/idc-service.js";
import { IsbEventBridgeClient } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";

export type LeaseLockIntent = z.infer<typeof LeaseLockIntentSchema>;

export interface DesiredAssignment {
  principalId: string;
  principalType: PrincipalType;
}

export interface EnrichedUserAssignment {
  principalId: string;
  principalType: "USER";
  email: string;
  displayName?: string;
}

export interface EnrichedGroupAssignment {
  principalId: string;
  principalType: "GROUP";
  displayName?: string;
  email?: string;
}

export type EnrichedAssignment =
  | EnrichedUserAssignment
  | EnrichedGroupAssignment;

export interface UpdateAssignmentsResult {
  desiredCount: number;
}

export interface ProcessAssignmentInput {
  leaseId: string;
  action: "GRANT" | "REVOKE";
  principalId: string;
  principalType: PrincipalType;
  accountId: string;
  permissionSetArn: string;
  leaseOwnerEmail: string;
  displayName?: string;
  email?: string;
  requestedBy?: string;
}

export interface ProcessAssignmentResult {
  status: "SUCCEEDED" | "SKIPPED";
  principalId: string;
  principalType: PrincipalType;
  action: string;
  reason?: string;
}

/** The action to perform for a single principal, decided via a JIT diff. */
export type AssignmentAction = "GRANT" | "REVOKE" | "NO_OP";

export interface ResolveAssignmentActionInput {
  leaseId: string;
  leaseOwnerEmail: string;
  principalId: string;
  principalType: PrincipalType;
  intent: LeaseLockIntent;
}

export interface ResolveAssignmentActionServices {
  principalStore: PrincipalStore;
  leaseStore: LeaseStore;
  logger: Logger;
}

export interface EnrichDesiredAssignmentsServices {
  principalStore: PrincipalStore;
  /** Cache misses are JIT-resolved via IDC DescribeUser/DescribeGroup. */
  idcService: IdcService;
  logger: Logger;
}

export interface UpdateAssignmentsServices {
  principalStore: PrincipalStore;
  leaseStore: LeaseStore;
  eventBridgeClient: IsbEventBridgeClient;
  logger: Logger;
}

export interface ProcessAssignmentServices {
  principalStore: PrincipalStore;
  ssoAdminClient: SSOAdminClient;
  idcStackConfigStore: IdcStackConfigStore;
  logger: Logger;
}

export interface TriggerAssignmentProcessingServices {
  leaseStore: LeaseStore;
  eventBridgeClient: IsbEventBridgeClient;
  principalStore?: PrincipalStore;
  idcService?: IdcService;
  tracer: Tracer;
  logger: Logger;
}

export interface TriggerAssignmentProcessingProps {
  leaseId: string;
  userEmail: string;
  intent: LeaseLockIntent;
  /** Raw desired assignments — enriched internally when provided. */
  desiredAssignments?: DesiredAssignment[];
  /**
   * If true, release the lock when the event publish fails.
   * Defaults based on intent criticality (false for TERMINATE/FREEZE).
   */
  releaseLockOnEventFailure?: boolean;
  /** Who initiated the operation. Defaults to userEmail (lease owner). */
  requestedBy?: string;
}

/**
 * Per-principal reconciliation status.
 *
 * - active:       desired and assigned
 * - granting:     desired, not yet assigned, operation in flight
 * - revoking:     assigned, being revoked
 * - suspended:    unassigned because the lease grants nobody access (frozen or
 *                 terminal) — expected, not a failure
 * - grantFailed:  settled, desired, but unassigned
 * - revokeFailed: settled, but assigned when it should not be
 */
export const AssignmentSyncStatusSchema = z.enum([
  "active",
  "granting",
  "revoking",
  "suspended",
  "grantFailed",
  "revokeFailed",
]);

export type AssignmentSyncStatus = z.infer<typeof AssignmentSyncStatusSchema>;

/**
 * One row of the assignments view: the union of the lease's desired set and its
 * live assignments. Rows sourced only from the desired set have no assignment
 * yet, so addedBy/addedDate/assigneeEmail are absent.
 */
export interface AssignmentView {
  principalId: string;
  principalType: PrincipalType;
  displayName: string;
  assigneeEmail?: string;
  addedBy?: string;
  addedDate?: string;
  /** True for the lease owner, whose access is implicit and not removable. */
  isOwner: boolean;
  /**
   * Whether this principal is in the lease's desired set. Cannot be inferred
   * from syncStatus: `revoking` means "no longer desired" during an UPDATE but
   * "still desired" during a FREEZE. Clients echoing the view back as the new
   * desired set must honour this, or a pending revoke is silently cancelled.
   */
  isDesired: boolean;
  syncStatus: AssignmentSyncStatus;
}

/** The assignments view plus the operation currently reconciling it. */
export interface LeaseAssignmentsView {
  assignments: AssignmentView[];
  operationInProgress?: LeaseLockIntent;
}

/** An acquired lock whose AssignmentRequested event is not yet published. */
export interface AssignmentProcessingLock {
  leaseId: string;
  userEmail: string;
  intent: LeaseLockIntent;
  requestedBy: string;
  lockOwnerId: string;
  /** Total desired assignments persisted with the lock, or 0 when none. */
  desiredCount: number;
  /** The lock as persisted. See LeaseStore.acquireLock. */
  lock: LeaseResourceLock;
  releaseLockOnEventFailure: boolean;
}

export class MaxAssignmentsExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaxAssignmentsExceededError";
  }
}

export interface GetLeasesForUserProps {
  userId: string;
  pageIdentifier?: string;
  pageSize?: number;
}

export interface GetLeasesForUserDirectServices {
  leaseStore: LeaseStore;
  principalStore: PrincipalStore;
  logger: Logger;
}

export interface GetLeasesForUserViaGroupsServices {
  leaseStore: LeaseStore;
  principalStore: PrincipalStore;
  idcService: IdcService;
  logger: Logger;
}

export type SharedLeaseAccessType = "direct" | "group";

export type SharedLease = Lease & {
  accessType: SharedLeaseAccessType;
  sourceGroupName?: string;
};
