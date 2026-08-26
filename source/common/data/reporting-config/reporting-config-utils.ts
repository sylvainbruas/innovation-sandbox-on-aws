// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { CostReportingConfig } from "@amzn/innovation-sandbox-commons/data/config/config.js";
import { ValidationException } from "@amzn/innovation-sandbox-commons/data/global-config/global-config-utils.js";

export function validateCostReportGroup(
  costReportGroup: string | undefined,
  reportingConfig: CostReportingConfig,
  options?: { previousCostReportGroup?: string },
) {
  // On updates (when a previous value is provided), don't retroactively block
  // edits to unrelated fields just because a required cost report group is
  // missing — only enforce the requirement when the group is actually being
  // set or cleared. On creates (no `options`), always enforce.
  const isUnchangedUpdate =
    options !== undefined &&
    costReportGroup === options.previousCostReportGroup;

  if (
    reportingConfig.requireCostReportGroup &&
    !costReportGroup &&
    !isUnchangedUpdate
  ) {
    throw new ValidationException(
      "A cost report group must be provided as required by administrator settings. Please contact your administrator if you need to create a lease without specifying a cost report group.",
    );
  }

  if (
    costReportGroup &&
    !reportingConfig.costReportGroups.includes(costReportGroup)
  ) {
    throw new ValidationException("Invalid cost report group");
  }
}
