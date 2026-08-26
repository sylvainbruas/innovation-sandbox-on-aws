// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";

export const AssignmentProcessorEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    LEASE_TABLE_NAME: z.string(),
    PRINCIPAL_TABLE_NAME: z.string(),
    ISB_EVENT_BUS: z.string(),
    ISB_NAMESPACE: z.string(),
    IDC_CONFIG_PARAM_ARN: z.string(),
  });

export type AssignmentProcessorEnvironment = z.infer<
  typeof AssignmentProcessorEnvironmentSchema
>;
