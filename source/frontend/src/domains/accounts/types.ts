// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import { CleanupValidationModeSchema } from "@amzn/innovation-sandbox-shared/types/sandbox-account";

const CleanupReportStepMetaViewSchema = z
  .object({
    codeBuildExecutionArn: z.string().optional(),
    outcome: z.enum(["SUCCEEDED", "FAILED"]).optional(),
    cooldownDurationHours: z.number().optional(),
    skippedBy: z.string().optional(),
    skippedAt: z.string().optional(),
  })
  .catchall(z.unknown());

export const CleanupReportStepViewSchema = z.strictObject({
  name: z.string(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  meta: CleanupReportStepMetaViewSchema.optional(),
});

export type CleanupReportStepView = z.infer<typeof CleanupReportStepViewSchema>;

const CleanupResourceCountViewSchema = z.strictObject({
  totalCount: z.number(),
  ignoredCount: z.number(),
  byType: z.record(z.string(), z.number()),
});

export const CleanupRemainingResourceViewSchema = z.strictObject({
  arn: z.string(),
  resourceType: z.string(),
  region: z.string(),
});

export type CleanupRemainingResourceView = z.infer<
  typeof CleanupRemainingResourceViewSchema
>;

export const CleanupResourceSummaryViewSchema = z.strictObject({
  validationMode: CleanupValidationModeSchema.optional(),
  beforeCleanup: CleanupResourceCountViewSchema.optional(),
  afterCleanup: CleanupResourceCountViewSchema.optional(),
  afterCooldown: CleanupResourceCountViewSchema.optional(),
  remainingTypes: z.array(z.string()).optional(),
  remainingResources: z.array(CleanupRemainingResourceViewSchema).optional(),
  remainingResourcesTotalCount: z.number().optional(),
  ignoredResources: z.array(CleanupRemainingResourceViewSchema).optional(),
  ignoredResourcesTotalCount: z.number().optional(),
});

export type CleanupResourceSummaryView = z.infer<
  typeof CleanupResourceSummaryViewSchema
>;

const CleanupReportErrorViewSchema = z.strictObject({
  step: z.string(),
  message: z.string(),
});

export const CleanupReportViewSchema = z.strictObject({
  accountId: z.string(),
  durableExecutionArn: z.string(),
  status: z.enum(["IN_PROGRESS", "COMPLETED", "FAILED"]),
  cleanupStatus: z.string(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  reasonForCleanup: z.string(),
  initiatedBy: z.string().optional(),
  resourceSummary: CleanupResourceSummaryViewSchema.optional(),
  steps: z.array(CleanupReportStepViewSchema),
  cooldownSkippedBy: z.string().optional(),
  error: CleanupReportErrorViewSchema.optional(),
});

export type CleanupReportView = z.infer<typeof CleanupReportViewSchema>;
