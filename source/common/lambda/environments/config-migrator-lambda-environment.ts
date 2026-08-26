// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";

/**
 * Environment for the Upgrade Migrator custom resource. The migrator discovers
 * the GlobalConfig/ReportingConfig profiles by name via `ListConfigurationProfiles`
 * (it cannot receive their profile IDs as env vars because those profiles are
 * being deleted in the same deployment), so only the AppConfig application and
 * environment IDs plus the destination table name are needed.
 */
export const ConfigMigratorLambdaEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    APP_CONFIG_APPLICATION_ID: z.string(),
    APP_CONFIG_ENVIRONMENT_ID: z.string(),
    CONFIG_TABLE_NAME: z.string(),
  });

export type ConfigMigratorLambdaEnvironment = z.infer<
  typeof ConfigMigratorLambdaEnvironmentSchema
>;
