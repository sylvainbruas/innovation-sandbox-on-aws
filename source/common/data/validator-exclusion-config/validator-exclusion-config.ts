// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Schema for the validator exclusion config stored in AppConfig.
 *
 * This config defines which resources the post-cleanup validator should ignore
 * when checking Resource Explorer results. Resources matching these exclusions
 * are intentionally preserved by Nuke and should not trigger validation failures.
 *
 * The excludedArnPatterns must be kept in sync with the nuke config filters.
 * See internal/docs/cleanup/validation.md for the mapping reference.
 */
export const ValidatorExclusionConfigSchema = z.object({
  validation: z.object({
    excludedArnPatterns: z
      .array(z.string().min(1))
      .describe(
        "ARN glob patterns to exclude from validation (e.g., 'arn:aws:iam::*:role/aws-service-role/*')",
      ),
  }),
});

export type ValidatorExclusionConfig = z.infer<
  typeof ValidatorExclusionConfigSchema
>;
