// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";

export const PreTokenGenerationEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    INTERMEDIATE_ROLE_ARN: z.string(),
    IDC_ROLE_ARN: z.string(),
    IDC_CONFIG_PARAM_ARN: z.string(),
    ISB_NAMESPACE: z.string(),
  });

export type PreTokenGenerationEnvironment = z.infer<
  typeof PreTokenGenerationEnvironmentSchema
>;
