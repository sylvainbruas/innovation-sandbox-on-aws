// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import {
  createItemWithMetadataSchema,
  createVersionRangeSchema,
} from "@amzn/innovation-sandbox-commons/data/metadata.js";
import {
  enumErrorMap,
  FreeTextSchema,
} from "@amzn/innovation-sandbox-commons/utils/zod.js";

// IMPORTANT -- this value must be updated whenever the schema changes.
export const LeaseTemplateSchemaVersion = 4; // v1.3.0 - Added allowOwnerToShareLease for multi-user leases

// Define supported version range for backwards compatibility
const LeaseTemplateSupportedVersionsSchema = createVersionRangeSchema(
  1,
  LeaseTemplateSchemaVersion,
);

// Create ItemWithMetadata schema with version validation
const LeaseTemplateItemWithMetadataSchema = createItemWithMetadataSchema(
  LeaseTemplateSupportedVersionsSchema,
);

export const ThresholdActionSchema = z.enum(["ALERT", "FREEZE_ACCOUNT"], {
  error: enumErrorMap,
});

export const VisibilitySchema = z.enum(["PUBLIC", "PRIVATE"], {
  error: enumErrorMap,
});

export const BudgetThresholdSchema = z.strictObject({
  dollarsSpent: z.number().gt(0),
  action: ThresholdActionSchema,
});

export const BudgetConfigSchema = z.strictObject({
  maxSpend: z.number().gt(0).optional(),
  budgetThresholds: z.array(BudgetThresholdSchema).optional(),
});

export const DurationThresholdSchema = z.strictObject({
  hoursRemaining: z.number().gt(0),
  action: ThresholdActionSchema,
});

export const DurationConfigSchema = z.strictObject({
  leaseDurationInHours: z.number().gt(0).optional(),
  durationThresholds: z.array(DurationThresholdSchema).optional(),
});

export const LeaseTemplateSchema = z.strictObject({
  uuid: z.uuid(),
  name: z.string().max(50).min(1),
  description: FreeTextSchema.optional(),
  requiresApproval: z.boolean(),
  createdBy: z.email(),
  visibility: VisibilitySchema.default("PUBLIC"),
  costReportGroup: z.string().min(1).max(50).optional(),
  blueprintId: z.uuid().nullable().optional(), // References attached blueprint (null = no blueprint, undefined = field removed by DynamoDB transformation)
  blueprintName: z.string().nullable().optional(), // Resolved from blueprint store on create/update (not client-provided)
  allowOwnerToShareLease: z.boolean().default(false), // Controls whether lease owners can manage additional users
  ...BudgetConfigSchema.shape,
  ...DurationConfigSchema.shape,
  ...LeaseTemplateItemWithMetadataSchema.shape,
});

export type ThresholdAction = z.infer<typeof ThresholdActionSchema>;
export type BudgetThreshold = z.infer<typeof BudgetThresholdSchema>;
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;
export type DurationThreshold = z.infer<typeof DurationThresholdSchema>;
export type DurationConfig = z.infer<typeof DurationConfigSchema>;
export type Visibility = z.infer<typeof VisibilitySchema>;
export type LeaseTemplate = z.infer<typeof LeaseTemplateSchema>;
