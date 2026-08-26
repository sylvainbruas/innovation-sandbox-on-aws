// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Lease,
  type LeaseLockIntent,
  LeaseWithLeaseId,
  MonitoredLease,
} from "@amzn/innovation-sandbox-commons/data/lease/lease";

export type NewLeaseRequest = {
  leaseTemplateUuid: string;
  comments?: string;
  userEmail?: string;
  assignments?: AssignmentPrincipalRef[];
};

export type LeasePatchRequest = {
  leaseId: LeaseWithLeaseId["leaseId"];
  maxSpend?: MonitoredLease["maxSpend"] | null;
  budgetThresholds?: MonitoredLease["budgetThresholds"];
  expirationDate?: MonitoredLease["expirationDate"] | null;
  durationThresholds?: MonitoredLease["durationThresholds"];
  costReportGroup?: MonitoredLease["costReportGroup"] | null;
  allowOwnerToShareLease?: boolean;
};

export type LeaseFormData = LeasePatchRequest & {
  maxBudgetEnabled?: boolean;
  maxDurationEnabled?: boolean;
};

export type MonitoredLeaseWithLeaseId = MonitoredLease & LeaseWithLeaseId;

export type PrincipalType = "USER" | "GROUP";

export type IdcPrincipal = {
  principalId: string;
  principalType: PrincipalType;
  displayName: string;
  email?: string;
};

export type PrincipalSearchType = "users" | "groups" | "all";

export type PrincipalSearchResponse = {
  principals: IdcPrincipal[];
  totalMatches: number;
};

/**
 * Per-principal reconciliation status, computed by the API. Mirrors
 * AssignmentSyncStatus in lease-assignment.types.ts, which documents each value.
 */
export type AssignmentSyncStatus =
  | "active"
  | "granting"
  | "revoking"
  | "suspended"
  | "grantFailed"
  | "revokeFailed";

export type LeaseAssignment = {
  principalId: string;
  principalType: PrincipalType;
  /** Set for USER assignments only. */
  assigneeEmail?: string;
  displayName: string;
  /** Absent until the access assignment exists. */
  addedBy?: string;
  addedDate?: string;
  isOwner: boolean;
  /**
   * Whether the API considers this principal part of the desired set; a
   * lingering assignment pending revoke is not. Must be honoured when echoing
   * the list back as the new desired set, or the pending revoke is cancelled.
   */
  isDesired: boolean;
  syncStatus: AssignmentSyncStatus;
};

export type GetLeaseAssignmentsResponse = {
  assignments: LeaseAssignment[];
  /** Set while the Assignment Processor is reconciling this lease. */
  operationInProgress?: LeaseLockIntent;
};

// Identifier for one principal in a desired-state PUT body — backend matches
// (principalType, principalId) against current records to compute the diff.
export type AssignmentPrincipalRef = {
  principalId: string;
  principalType: PrincipalType;
};

export type UpdateLeaseAssignmentsResponse = {
  desiredCount: number;
};

export type SharedLeaseAccessType = "direct" | "group" | "owner" | "global";

export type SharedLease = Lease & {
  leaseId: string;
  accessType: SharedLeaseAccessType;
  sourceGroupName?: string;
};

export type SharedLeasesResponse = {
  result: SharedLease[];
  nextPageIdentifier: string | null;
  error?: string;
};
