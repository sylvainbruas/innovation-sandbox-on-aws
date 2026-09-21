// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  ApprovalDeniedLeaseView,
  ApprovalDeniedLeaseViewSchema,
  ExpiredLeaseView,
  ExpiredLeaseViewSchema,
  LeaseView,
  LeaseViewSchema,
  MonitoredLeaseView,
  MonitoredLeaseViewSchema,
  PendingLeaseView,
  PendingLeaseViewSchema,
} from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import { generateSchemaData } from "@amzn/innovation-sandbox-shared/test/generate-schema-data";

export function createLease(overrides?: Partial<LeaseView>): LeaseView {
  return generateSchemaData(LeaseViewSchema, {
    resourceLock: undefined,
    ...overrides,
  });
}

/** Overrides the generated read-path ID when a test needs a stable route ID. */
export function withLeaseId<T extends LeaseView>(
  lease: T,
  leaseId: string,
): T & { leaseId: string } {
  return { ...lease, leaseId };
}

export function createActiveLease(
  overrides?: Partial<MonitoredLeaseView>,
): MonitoredLeaseView {
  return generateSchemaData(MonitoredLeaseViewSchema, {
    status: "Active",
    resourceLock: undefined,
    ...overrides,
  });
}

export function createPendingLease(
  overrides?: Partial<PendingLeaseView>,
): PendingLeaseView {
  return generateSchemaData(PendingLeaseViewSchema, {
    status: "PendingApproval",
    resourceLock: undefined,
    ...overrides,
  });
}

export function createApprovalDeniedLease(
  overrides?: Partial<ApprovalDeniedLeaseView>,
): ApprovalDeniedLeaseView {
  return generateSchemaData(ApprovalDeniedLeaseViewSchema, {
    status: "ApprovalDenied",
    resourceLock: undefined,
    ...overrides,
  });
}

export function createExpiredLease(
  overrides?: Partial<ExpiredLeaseView>,
): ExpiredLeaseView {
  return generateSchemaData(ExpiredLeaseViewSchema, {
    status: "Expired",
    resourceLock: undefined,
    ...overrides,
  });
}
