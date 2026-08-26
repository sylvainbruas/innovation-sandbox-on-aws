// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { LeaseTemplateSchema } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import {
  createItemWithMetadataSchema,
  createVersionRangeSchema,
} from "@amzn/innovation-sandbox-commons/data/metadata.js";
import { IdcPrincipalIdSchema } from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import { ResourceLockSchema } from "@amzn/innovation-sandbox-commons/data/resource-lock.js";
import {
  AwsAccountIdSchema,
  enumErrorMap,
  FreeTextSchema,
} from "@amzn/innovation-sandbox-commons/utils/zod.js";

// IMPORTANT -- this value must be updated whenever the schema changes.
export const LeaseSchemaVersion = 4; // Target: ISB v1.3.0

// Intents that can override a non-critical lock (security-critical operations)
export const CriticalLockIntents = ["TERMINATE", "FREEZE"] as const;

// Intents that CAN be overridden by critical operations
export const OverridableLockIntents = [
  "UPDATE",
  "PUBLISH",
  "UNFREEZE",
] as const;

// Lease-specific lock meta: constrains the generic ResourceLock.meta to valid lock operations
export const LeaseLockIntentSchema = z.enum([
  ...CriticalLockIntents,
  ...OverridableLockIntents,
]);

export const LeaseLockMetaSchema = z
  .object({
    intent: LeaseLockIntentSchema,
  })
  .strict();

export type LeaseLockMeta = z.infer<typeof LeaseLockMetaSchema>;
export type LeaseLockIntent = z.infer<typeof LeaseLockIntentSchema>;

/**
 * Held intents that block a critical intent from acquiring the lock; it preempts
 * anything outside its list. Non-critical intents are not keyed here and preempt
 * nothing, so any live lock blocks them.
 *
 * TERMINATE: blocked only by TERMINATE (preempts FREEZE and all non-critical)
 * FREEZE:    blocked by TERMINATE or FREEZE (preempts all non-critical)
 * UPDATE/PUBLISH/UNFREEZE: blocked by any live lock (no entry = no override)
 */
export const BlockingLockIntents = {
  TERMINATE: ["TERMINATE"],
  FREEZE: ["TERMINATE", "FREEZE"],
} as const satisfies Record<
  (typeof CriticalLockIntents)[number],
  readonly LeaseLockIntent[]
>;

// Lease-specific ResourceLock with typed meta field
export const LeaseResourceLockSchema = ResourceLockSchema.omit({
  meta: true,
})
  .extend({
    meta: LeaseLockMetaSchema.optional(),
  })
  .strict();

export type LeaseResourceLock = z.infer<typeof LeaseResourceLockSchema>;

export const DesiredAssignmentSchema = z.object({
  principalId: IdcPrincipalIdSchema,
  principalType: z.enum(["USER", "GROUP"]),
});
export type DesiredAssignment = z.infer<typeof DesiredAssignmentSchema>;

/**
 * Maximum number of principals that can be assigned to a lease, including
 * the owner. The owner always occupies one slot, leaving
 * MAX_USER_MANAGED_ASSIGNMENTS slots for additional users/groups.
 */
export const MAX_ASSIGNMENTS = 20;

/**
 * Maximum number of principals a caller can supply in a PUT or POST request.
 * The owner is auto-injected server-side so this is MAX_ASSIGNMENTS minus the
 * implicit owner slot.
 */
export const MAX_USER_MANAGED_ASSIGNMENTS = MAX_ASSIGNMENTS - 1;

export const DesiredAssignmentWithDisplaySchema =
  DesiredAssignmentSchema.extend({
    displayName: z.string().optional(),
    email: z.email().optional(),
  });
export type DesiredAssignmentWithDisplay = z.infer<
  typeof DesiredAssignmentWithDisplaySchema
>;

// Define supported version range for backwards compatibility
const LeaseSupportedVersionsSchema = createVersionRangeSchema(
  1,
  LeaseSchemaVersion,
);

// Create ItemWithMetadata schema with version validation
const LeaseItemWithMetadataSchema = createItemWithMetadataSchema(
  LeaseSupportedVersionsSchema,
);

/*
Leases pass through 3 general stages of their lifecycle: Pending, Active, and Expired. A lease will end either
by being denied in the pending stage, or by reaching one of the terminal states defined by the Expired schema
 */

// Leases that have been requested but yet to be approved or denied
export const PendingLeaseStatusSchema = z.literal("PendingApproval");

// Leases whose request has been denied
export const ApprovalDeniedLeaseStatusSchema = z.literal("ApprovalDenied");

// Leases that are active and are being monitored
export const MonitoredLeaseStatusSchema = z.enum(
  ["Active", "Frozen", "Provisioning"],
  {
    error: enumErrorMap,
  },
);

// Leases that are no longer active (terminal, no more actions should occur on these leases)
export const ExpiredLeaseStatusSchema = z.enum(
  [
    "Expired",
    "BudgetExceeded",
    "ManuallyTerminated",
    "UserTerminated",
    "AccountQuarantined",
    "Ejected",
    "ProvisioningFailed",
  ],
  {
    error: enumErrorMap,
  },
);

export const AllLeaseStatusSchema = z.enum(
  [
    PendingLeaseStatusSchema.value,
    ApprovalDeniedLeaseStatusSchema.value,
    ...MonitoredLeaseStatusSchema.options,
    ...ExpiredLeaseStatusSchema.options,
  ],
  {
    error: enumErrorMap,
  },
);

export const LeaseKeySchema = z.object({
  userEmail: z.email(),
  uuid: z.uuid(),
});

export const PendingLeaseSchema = LeaseKeySchema.extend({
  status: PendingLeaseStatusSchema,
  originalLeaseTemplateUuid: LeaseTemplateSchema.shape.uuid,
  originalLeaseTemplateName: LeaseTemplateSchema.shape.name,
  comments: FreeTextSchema.optional(),
  createdBy: z.email().optional(),
  blueprintId: z.uuid().nullable().optional(), // Copied from template for blueprint deployment
  blueprintName: z.string().nullable().optional(), // Copied from blueprint for display/logging
  allowOwnerToShareLease: z.boolean().optional(), // Denormalized from lease template for multi-user leases
  desiredAssignments: z.array(DesiredAssignmentWithDisplaySchema).optional(), // Declarative model: desired principal assignments
  resourceLock: LeaseResourceLockSchema.nullable().optional(), // Concurrency lock for assignment operations
}).merge(
  LeaseTemplateSchema.pick({
    maxSpend: true,
    leaseDurationInHours: true,
    budgetThresholds: true,
    durationThresholds: true,
    costReportGroup: true,
  }).merge(LeaseItemWithMetadataSchema),
);

// TTL attribute for DynamoDB automatic deletion (Unix timestamp in seconds)
export const TtlSchema = z.number().int().nonnegative();

export const ApprovalDeniedLeaseSchema = PendingLeaseSchema.extend({
  //overrides
  status: ApprovalDeniedLeaseStatusSchema,
  //extra values
  ttl: TtlSchema,
});

export const ApprovedBySchema = z.union([
  z.email(),
  z.literal("AUTO_APPROVED"),
]);

export const MonitoredLeaseSchema = PendingLeaseSchema.extend({
  //overrides
  status: MonitoredLeaseStatusSchema,
  //extra values
  awsAccountId: AwsAccountIdSchema,
  approvedBy: ApprovedBySchema,
  startDate: z.iso.datetime(), // ISO 8601 -- https://zod.dev/?id=datetimes
  expirationDate: z.iso.datetime().optional(), // ISO 8601 -- https://zod.dev/?id=datetimes
  lastCheckedDate: z.iso.datetime(), // ISO 8601 -- https://zod.dev/?id=datetimes
  totalCostAccrued: z.number(),
});

export const ExpiredLeaseSchema = MonitoredLeaseSchema.extend({
  //overrides
  status: ExpiredLeaseStatusSchema,
  //extra values
  endDate: z.iso.datetime(),
  ttl: TtlSchema,
});

export const LeaseSchema = z.discriminatedUnion("status", [
  PendingLeaseSchema,
  ApprovalDeniedLeaseSchema,
  MonitoredLeaseSchema,
  ExpiredLeaseSchema,
]);

export type LeaseStatus = z.infer<typeof AllLeaseStatusSchema>;
export type PendingLeaseStatus = z.infer<typeof PendingLeaseStatusSchema>;
export type ApprovalDeniedLeaseStatus = z.infer<
  typeof ApprovalDeniedLeaseStatusSchema
>;
export type MonitoredLeaseStatus = z.infer<typeof MonitoredLeaseStatusSchema>;
export type ExpiredLeaseStatus = z.infer<typeof ExpiredLeaseStatusSchema>;

export type Lease = z.infer<typeof LeaseSchema>;
export type PendingLease = z.infer<typeof PendingLeaseSchema>;
export type ApprovalDeniedLease = z.infer<typeof ApprovalDeniedLeaseSchema>;
export type MonitoredLease = z.infer<typeof MonitoredLeaseSchema>;
export type ExpiredLease = z.infer<typeof ExpiredLeaseSchema>;
export type LeaseWithLeaseId = Lease & { leaseId: string };

export type LeaseKey = z.infer<typeof LeaseKeySchema>;

export function isPendingLease(lease: Lease): lease is PendingLease {
  return PendingLeaseStatusSchema.safeParse(lease.status).success;
}

export function isApprovalDeniedLease(
  lease: Lease,
): lease is ApprovalDeniedLease {
  return ApprovalDeniedLeaseStatusSchema.safeParse(lease.status).success;
}

export function isMonitoredLease(lease: Lease): lease is MonitoredLease {
  return MonitoredLeaseStatusSchema.safeParse(lease.status).success;
}

export function isActiveLease(lease: Lease): lease is MonitoredLease {
  return lease.status === "Active";
}

export function isFrozenLease(lease: Lease): lease is MonitoredLease {
  return lease.status === "Frozen";
}

export function isExpiredLease(lease: Lease): lease is ExpiredLease {
  return ExpiredLeaseStatusSchema.safeParse(lease.status).success;
}

// Shared so the frontend can match this specific 409 and skip it in a batch
// review, without drifting from the message the handler returns.
export const LEASE_NOT_PENDING_REVIEW_ERROR =
  "Only leases in a pending state can be approved/denied.";
