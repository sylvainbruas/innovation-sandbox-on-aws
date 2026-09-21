// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { createVersionRangeSchema } from "@amzn/innovation-sandbox-commons/data/metadata.js";
import {
  ApprovalDeniedLeaseSchema,
  ExpiredLeaseSchema,
  LeaseMetadataSchema,
  LeaseSchema,
  MonitoredLeaseSchema,
  PendingLeaseSchema,
} from "@amzn/innovation-sandbox-shared/types/lease.js";

// IMPORTANT -- this value must be updated whenever the persisted schema changes.
export const LeaseSchemaVersion = 4; // Target: ISB v1.3.0

const LeaseSupportedVersionsSchema = createVersionRangeSchema(
  1,
  LeaseSchemaVersion,
);

export const PersistedLeaseMetadataSchema = LeaseMetadataSchema.extend({
  schemaVersion: LeaseSupportedVersionsSchema,
});

export const PersistedPendingLeaseSchema = PendingLeaseSchema.extend({
  meta: PersistedLeaseMetadataSchema.optional(),
});

export const PersistedApprovalDeniedLeaseSchema =
  ApprovalDeniedLeaseSchema.extend({
    meta: PersistedLeaseMetadataSchema.optional(),
  });

export const PersistedMonitoredLeaseSchema = MonitoredLeaseSchema.extend({
  meta: PersistedLeaseMetadataSchema.optional(),
});

export const PersistedExpiredLeaseSchema = ExpiredLeaseSchema.extend({
  meta: PersistedLeaseMetadataSchema.optional(),
});

export const PersistedLeaseSchema = z.discriminatedUnion("status", [
  PersistedPendingLeaseSchema,
  PersistedApprovalDeniedLeaseSchema,
  PersistedMonitoredLeaseSchema,
  PersistedExpiredLeaseSchema,
]) satisfies z.ZodType<z.infer<typeof LeaseSchema>>;

export type PersistedLease = z.infer<typeof PersistedLeaseSchema>;
export type PersistedPendingLease = z.infer<typeof PersistedPendingLeaseSchema>;
export type PersistedApprovalDeniedLease = z.infer<
  typeof PersistedApprovalDeniedLeaseSchema
>;
export type PersistedMonitoredLease = z.infer<
  typeof PersistedMonitoredLeaseSchema
>;
export type PersistedExpiredLease = z.infer<typeof PersistedExpiredLeaseSchema>;
