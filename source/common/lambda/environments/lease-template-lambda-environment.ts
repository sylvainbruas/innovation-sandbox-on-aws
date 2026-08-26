// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseApiLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-api-lambda-environment.js";

export const LeaseTemplateLambdaEnvironmentSchema =
  BaseApiLambdaEnvironmentSchema.extend({
    CONFIG_TABLE_NAME: z.string(),
    LEASE_TEMPLATE_TABLE_NAME: z.string(),
    BLUEPRINT_TABLE_NAME: z.string(),
  });

export type LeaseTemplateLambdaEnvironment = z.infer<
  typeof LeaseTemplateLambdaEnvironmentSchema
>;
