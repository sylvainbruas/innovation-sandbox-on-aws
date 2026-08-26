// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  LeaseTemplate,
  LeaseTemplateSchema,
} from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";

export function createLeaseTemplate(
  overrides?: Partial<LeaseTemplate>,
): LeaseTemplate {
  return generateSchemaData(LeaseTemplateSchema, {
    requiresApproval: false,
    maxSpend: 100,
    leaseDurationInHours: 48,
    costReportGroup: "default-group",
    ...overrides,
  });
}

export function createAdvancedLeaseTemplate(
  overrides?: Partial<LeaseTemplate>,
): LeaseTemplate {
  return generateSchemaData(LeaseTemplateSchema, {
    requiresApproval: true,
    maxSpend: 500,
    leaseDurationInHours: 72,
    costReportGroup: "default-group",
    budgetThresholds: [{ dollarsSpent: 250, action: "ALERT" }],
    durationThresholds: [{ hoursRemaining: 24, action: "ALERT" }],
    ...overrides,
  });
}
