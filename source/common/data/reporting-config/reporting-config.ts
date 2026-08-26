// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

export const ReportingConfigSchema = z.object({
  costReportGroups: z
    .array(z.string().max(50).min(1))
    .max(100)
    .default([])
    .meta({ description: "List of valid cost report groups that can be used" }),
  requireCostReportGroup: z
    .boolean()
    .default(false)
    .meta({
      description:
        "Whether cost report group is required when creating/updating lease templates",
    }),
});

export type ReportingConfig = z.infer<typeof ReportingConfigSchema>;
