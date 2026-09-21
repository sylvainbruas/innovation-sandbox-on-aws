// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { enumErrorMap, FreeTextSchema } from "../utils/zod.js";

/**
 * Lease-template values shared by the API supplement validation, persistence
 * schema, and frontend model. Persistence-specific version bounds and UI-only
 * state do not belong in this module.
 */
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

export const LeaseTemplateMetadataSchema = z.object({
  createdTime: z.iso.datetime().optional(),
  lastEditTime: z.iso.datetime().optional(),
  schemaVersion: z.number().int(),
});

export const LeaseTemplateWritableSchema = z.strictObject({
  name: z.string().max(50).min(1),
  description: FreeTextSchema.optional(),
  requiresApproval: z.boolean(),
  visibility: VisibilitySchema.default("PUBLIC"),
  costReportGroup: z.string().min(1).max(50).optional(),
  blueprintId: z.uuid().nullable().optional(),
  allowOwnerToShareLease: z.boolean().default(false),
  ...BudgetConfigSchema.shape,
  ...DurationConfigSchema.shape,
});

export type ThresholdAction = z.infer<typeof ThresholdActionSchema>;
export type BudgetThreshold = z.infer<typeof BudgetThresholdSchema>;
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;
export type DurationThreshold = z.infer<typeof DurationThresholdSchema>;
export type DurationConfig = z.infer<typeof DurationConfigSchema>;
export type Visibility = z.infer<typeof VisibilitySchema>;
export type LeaseTemplateMetadata = z.infer<typeof LeaseTemplateMetadataSchema>;
export type LeaseTemplateWritable = z.infer<typeof LeaseTemplateWritableSchema>;
