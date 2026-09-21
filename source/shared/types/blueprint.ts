// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { enumErrorMap } from "../utils/zod.js";

/** Deployment-history records are retained for 90 days. */
export const DEPLOYMENT_HISTORY_RETENTION_DAYS = 90;

export const RegionConcurrencyTypeSchema = z.enum(["SEQUENTIAL", "PARALLEL"], {
  error: enumErrorMap,
});

export const ConcurrencyModeSchema = z.enum([
  "STRICT_FAILURE_TOLERANCE",
  "SOFT_FAILURE_TOLERANCE",
]);

export const DeploymentStatusSchema = z.enum(
  ["RUNNING", "SUCCEEDED", "FAILED", "QUEUED"],
  { error: enumErrorMap },
);

export const BlueprintTagsSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_\-:./@ +=$%&*()[\]{}|\\!#^~?]+$/)
      .refine((key) => !key.toLowerCase().startsWith("aws:")),
    z
      .string()
      .max(256)
      .regex(/^[a-zA-Z0-9_\-:./@ +=$%&*()[\]{}|\\!#^~?]*$/),
  )
  .refine((tags) => Object.keys(tags).length <= 10);

export const BlueprintMetadataSchema = z.object({
  createdTime: z.iso.datetime().optional(),
  lastEditTime: z.iso.datetime().optional(),
  schemaVersion: z.number().int(),
});

export const BlueprintHealthMetricsSchema = z.object({
  totalDeploymentCount: z.number().default(0),
  totalSuccessfulCount: z.number().default(0),
  lastDeploymentAt: z.iso.datetime().optional(),
});

/**
 * Blueprint business fields shared by persistence and frontend read models.
 * DynamoDB keys and frontend-only presentation fields belong in their owners.
 */
export const BlueprintItemSchema = z.strictObject({
  blueprintId: z.uuid(),
  name: z
    .string()
    .min(1, "Blueprint name is required")
    .max(50, "Blueprint name must be 50 characters or less")
    .regex(
      /^[a-zA-Z][a-zA-Z0-9-]{0,49}$/,
      "Blueprint name must start with a letter and contain only letters, numbers, and hyphens",
    ),
  tags: BlueprintTagsSchema.optional(),
  createdBy: z.email(),
  deploymentTimeoutMinutes: z.number().min(5).max(480).default(30),
  regionConcurrencyType: RegionConcurrencyTypeSchema.default("SEQUENTIAL"),
  totalHealthMetrics: BlueprintHealthMetricsSchema.default({
    totalDeploymentCount: 0,
    totalSuccessfulCount: 0,
  }),
  meta: BlueprintMetadataSchema.optional(),
});

export const StackSetHealthMetricsSchema = z.object({
  deploymentCount: z.number().default(0),
  successfulDeploymentCount: z.number().default(0),
  lastFailureAt: z.iso.datetime().optional(),
  lastSuccessAt: z.iso.datetime().optional(),
  consecutiveFailures: z.number().default(0),
});

export const StackSetItemSchema = z.strictObject({
  blueprintId: z.uuid(),
  stackSetId: z.string().min(1),
  administrationRoleArn: z.string().min(1),
  executionRoleName: z.string().min(1),
  regions: z
    .array(z.string())
    .min(1, "At least one region is required")
    .refine((regions) => new Set(regions).size === regions.length, {
      message: "Duplicate regions are not allowed. Each region must be unique.",
    }),
  deploymentOrder: z.number().min(1).default(1),
  maxConcurrentPercentage: z.number().int().min(1).max(100).default(100),
  failureTolerancePercentage: z.number().int().min(0).max(100).default(0),
  concurrencyMode: ConcurrencyModeSchema.default("STRICT_FAILURE_TOLERANCE"),
  healthMetrics: StackSetHealthMetricsSchema.default({
    deploymentCount: 0,
    successfulDeploymentCount: 0,
    consecutiveFailures: 0,
  }),
  meta: BlueprintMetadataSchema.optional(),
});

export const DeploymentHistoryItemSchema = z.strictObject({
  stackSetId: z.string(),
  leaseId: z.uuid(),
  accountId: z.string(),
  status: DeploymentStatusSchema,
  operationId: z.string(),
  deploymentStartedAt: z.iso.datetime(),
  deploymentCompletedAt: z.iso.datetime().optional(),
  duration: z.number().optional(),
  errorType: z.string().optional(),
  errorMessage: z.string().optional(),
});

export const BlueprintWithStackSetsSchema = z.strictObject({
  blueprint: BlueprintItemSchema,
  stackSets: z.array(StackSetItemSchema),
  recentDeployments: z.array(DeploymentHistoryItemSchema).optional(),
});

export type RegionConcurrencyType = z.infer<typeof RegionConcurrencyTypeSchema>;
export type ConcurrencyMode = z.infer<typeof ConcurrencyModeSchema>;
export type DeploymentStatus = z.infer<typeof DeploymentStatusSchema>;
export type BlueprintItem = z.infer<typeof BlueprintItemSchema>;
export type StackSetItem = z.infer<typeof StackSetItemSchema>;
export type DeploymentHistoryItem = z.infer<typeof DeploymentHistoryItemSchema>;
export type BlueprintWithStackSets = z.infer<
  typeof BlueprintWithStackSetsSchema
>;
