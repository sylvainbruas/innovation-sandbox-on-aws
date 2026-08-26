// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";

export const CognitoPostDeployEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({});

export type CognitoPostDeployEnvironment = z.infer<
  typeof CognitoPostDeployEnvironmentSchema
>;
