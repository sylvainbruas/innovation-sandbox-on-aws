// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";

export const LogArchivingEnvironmentSchema = BaseLambdaEnvironmentSchema.extend(
  {
    LOG_GROUP_NAMES: z.string(),
    DESTINATION_BUCKET_NAME: z.string(),
    DESTINATION_PREFIX: z.string(),
    ISB_NAMESPACE: z.string(),
    EXPORT_PERIOD_DAYS: z.string(),
  },
);

export type LogArchivingEnvironment = z.infer<
  typeof LogArchivingEnvironmentSchema
>;
