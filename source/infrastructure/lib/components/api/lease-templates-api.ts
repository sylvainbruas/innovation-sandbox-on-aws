// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { IFunction } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import path from "path";

import { LeaseTemplateLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-template-lambda-environment.js";
import type { RestApiProps } from "@amzn/innovation-sandbox-infrastructure/components/api/rest-api-all";
import { IsbApiLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import {
  grantIsbDbReadOnly,
  grantIsbDbReadWrite,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export class LeaseTemplatesApi {
  public readonly lambdaFunction: IFunction;

  constructor(scope: Construct, props: RestApiProps) {
    const { namespace } = props;
    const {
      configTableName,
      leaseTemplateTable,
      blueprintTable,
      cognitoUserPoolId,
      cognitoAppClientId,
    } = IsbComputeStack.sharedSpokeConfig.data;

    const leaseTemplatesLambdaFunction = new IsbApiLambdaFunction(
      scope,
      "LeaseTemplatesLambdaFunction",
      {
        description:
          "Lambda used as API GW method integration for lease-templates resources",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "api",
          "lease-templates",
          "src",
          "lease-templates-handler.ts",
        ),
        handler: "handler",
        namespace: namespace,
        environment: {
          CONFIG_TABLE_NAME: configTableName,
          LEASE_TEMPLATE_TABLE_NAME: leaseTemplateTable,
          BLUEPRINT_TABLE_NAME: blueprintTable,
          COGNITO_USER_POOL_ID: cognitoUserPoolId,
          COGNITO_APP_CLIENT_ID: cognitoAppClientId,
          ISB_NAMESPACE: namespace,
        },
        envSchema: LeaseTemplateLambdaEnvironmentSchema,
      },
    );
    this.lambdaFunction = leaseTemplatesLambdaFunction.lambdaFunction;

    grantIsbDbReadWrite(
      scope,
      leaseTemplatesLambdaFunction,
      leaseTemplateTable,
    );
    grantIsbDbReadOnly(
      scope,
      leaseTemplatesLambdaFunction,
      configTableName,
      blueprintTable,
    );

    IsbKmsKeys.get(scope, namespace).grantEncryptDecrypt(
      leaseTemplatesLambdaFunction.lambdaFunction,
    );
  }
}
