// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import {
  BlueprintHealthMetricsSchema,
  BlueprintItemSchema,
  BlueprintMetadataSchema,
  DeploymentHistoryItemSchema,
  StackSetItemSchema,
} from "@amzn/innovation-sandbox-shared/types/blueprint";

const BlueprintViewMetadataSchema = z.strictObject({
  ...BlueprintMetadataSchema.required().shape,
});

export const DeploymentHistoryViewSchema = DeploymentHistoryItemSchema;
export type DeploymentHistoryView = z.infer<typeof DeploymentHistoryViewSchema>;

/**
 * Canonical blueprint representation consumed by frontend code.
 *
 * The API and persisted blueprint supply complete metadata. Missing tags
 * normalize to an empty record for the UI, and recent deployments are attached
 * by the list-page projection.
 */
export const BlueprintViewSchema = z.strictObject({
  ...BlueprintItemSchema.shape,
  tags: BlueprintItemSchema.shape.tags.default({}),
  totalHealthMetrics: BlueprintHealthMetricsSchema,
  meta: BlueprintViewMetadataSchema,
  recentDeployments: z.array(DeploymentHistoryViewSchema).optional(),
});

export type BlueprintView = z.infer<typeof BlueprintViewSchema>;

export const StackSetConfigViewSchema = z.strictObject({
  ...StackSetItemSchema.shape,
  meta: BlueprintViewMetadataSchema,
});

export type StackSetConfigView = z.infer<typeof StackSetConfigViewSchema>;

export const BlueprintWithStackSetsViewSchema = z.strictObject({
  blueprint: BlueprintViewSchema,
  stackSets: z.array(StackSetConfigViewSchema),
  recentDeployments: z.array(DeploymentHistoryViewSchema).optional(),
});

export type BlueprintWithStackSetsView = z.infer<
  typeof BlueprintWithStackSetsViewSchema
>;

export const StackSetViewSchema = z.strictObject({
  stackSetName: z.string(),
  stackSetId: z.string(),
  description: z.string().optional(),
  status: z.enum(["ACTIVE", "DELETED", "DELETING"]),
  permissionModel: z
    .enum(["SERVICE_MANAGED", "SELF_MANAGED"])
    .nullable()
    .optional(),
});

export type StackSetView = z.infer<typeof StackSetViewSchema>;
