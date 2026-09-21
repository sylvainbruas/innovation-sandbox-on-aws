// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PrincipalType } from "@amzn/innovation-sandbox-shared/types/principal.js";

import type { LeaseView, MonitoredLeaseView, SharedLeaseView } from "./model";

export type NewLeaseRequest = {
  leaseTemplateUuid: string;
  comments?: string;
  userEmail?: string;
  assignments?: AssignmentPrincipalRef[];
};

export type LeasePatchRequest = {
  leaseId: LeaseView["leaseId"];
  maxSpend?: MonitoredLeaseView["maxSpend"] | null;
  budgetThresholds?: MonitoredLeaseView["budgetThresholds"];
  expirationDate?: MonitoredLeaseView["expirationDate"] | null;
  durationThresholds?: MonitoredLeaseView["durationThresholds"];
  costReportGroup?: MonitoredLeaseView["costReportGroup"] | null;
  allowOwnerToShareLease?: boolean;
};

export type LeaseFormData = LeasePatchRequest & {
  maxBudgetEnabled?: boolean;
  maxDurationEnabled?: boolean;
};

// Identifier for one principal in a desired-state PUT body. The backend matches
// (principalType, principalId) against current records to compute the diff.
export type AssignmentPrincipalRef = {
  principalId: string;
  principalType: PrincipalType;
};

export type SharedLeasesResponse = {
  result: SharedLeaseView[];
  nextPageIdentifier: string | null;
  error?: string;
};
