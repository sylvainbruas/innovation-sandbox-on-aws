// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";

export const AssignmentWorkerEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    PRINCIPAL_TABLE_NAME: z.string(),
    LEASE_TABLE_NAME: z.string(),
    IDC_CONFIG_PARAM_ARN: z.string(),
    IDC_ROLE_ARN: z.string(),
    INTERMEDIATE_ROLE_ARN: z.string(),
    ASSIGNMENT_MAX_RECEIVE_COUNT: z.string(),
  });

export type AssignmentWorkerEnvironment = z.infer<
  typeof AssignmentWorkerEnvironmentSchema
>;
