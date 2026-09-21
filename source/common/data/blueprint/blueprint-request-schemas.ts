// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { ConcurrencyMode } from "@aws-sdk/client-cloudformation";
import { z } from "zod";

import { enumErrorMap } from "@amzn/innovation-sandbox-commons/utils/zod.js";
import { BlueprintItemSchema } from "@amzn/innovation-sandbox-shared/types/blueprint.js";

// The strict request schemas the blueprint Register/Update operations re-parse the
// raw body with (deviation #6): they compose shared blueprint fields (via omit/pick)
// with StackSet-level params that have no persistence equivalent, reject unknown
// keys, and own the reserved `aws:` tag-prefix refinement — none of which the Smithy
// model can fully express.
//
// Defined here (commons) rather than inline in the operation so the model-parity
// suite can compare the Smithy `RegisterBlueprintInput`/`UpdateBlueprintInput`
// against the *actual* runtime schema — a single source of truth, so model↔Zod
// request drift is caught rather than silently diverging.
//
// Both `concurrencyMode` enums pass `{ error: enumErrorMap }` so a Zod enum failure
// never echoes the caller's value back (the commons convention against user-input
// reflection). The pre-Smithy update schema omitted it — an inconsistency that is
// harmless under Smithy (the model validates the enum first, with a non-reflecting
// message) but is fixed here for symmetry and defense-in-depth. See
// internal/docs/design-docs/smithy/accepted-deviations.md.

export const RegisterBlueprintRequestSchema = BlueprintItemSchema.omit({
  blueprintId: true,
  createdBy: true,
  meta: true,
  totalHealthMetrics: true,
}).extend({
  stackSetId: z.string().min(1),
  regions: z.array(z.string()).min(1),
  maxConcurrentPercentage: z.number().int().min(1).max(100).optional(),
  failureTolerancePercentage: z.number().int().min(0).max(100).optional(),
  concurrencyMode: z
    .enum(
      [
        ConcurrencyMode.STRICT_FAILURE_TOLERANCE,
        ConcurrencyMode.SOFT_FAILURE_TOLERANCE,
      ],
      { error: enumErrorMap },
    )
    .optional(),
});

export const UpdateBlueprintRequestSchema = BlueprintItemSchema.pick({
  name: true,
  tags: true,
  deploymentTimeoutMinutes: true,
  regionConcurrencyType: true,
})
  .partial()
  .extend({
    maxConcurrentPercentage: z.number().int().min(1).max(100).optional(),
    failureTolerancePercentage: z.number().int().min(0).max(100).optional(),
    concurrencyMode: z
      .enum(
        [
          ConcurrencyMode.STRICT_FAILURE_TOLERANCE,
          ConcurrencyMode.SOFT_FAILURE_TOLERANCE,
        ],
        { error: enumErrorMap },
      )
      .optional(),
  });
