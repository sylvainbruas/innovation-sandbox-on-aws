// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { LambdaIntegration } from "aws-cdk-lib/aws-apigateway";
import { Effect, PolicyStatement, Role } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import path from "path";

import { ConfigurationLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/config-lambda-environment.js";
import {
  RestApi,
  RestApiProps,
} from "@amzn/innovation-sandbox-infrastructure/components/api/rest-api-all";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import {
  grantIsbDbReadWrite,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export class ConfigurationsApi {
  constructor(restApi: RestApi, scope: Construct, props: RestApiProps) {
    const { namespace } = props;
    const {
      configTableName,
      awsAccessPortalUrl,
      cognitoUserPoolId,
      cognitoAppClientId,
    } = IsbComputeStack.sharedSpokeConfig.data;

    const configurationsLambdaFunction = new IsbLambdaFunction(
      scope,
      "ConfigurationsLambdaFunction",
      {
        description:
          "Lambda used as API GW method integration for configurations resources",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "api",
          "configurations",
          "src",
          "configurations-handler.ts",
        ),
        handler: "handler",
        namespace: namespace,
        environment: {
          CONFIG_TABLE_NAME: configTableName,
          AWS_ACCESS_PORTAL_URL: awsAccessPortalUrl,
          ACCOUNT_POOL_CONFIG_PARAM_ARN:
            IsbComputeStack.sharedSpokeConfig.parameterArns
              .accountPoolConfigParamArn,
          COGNITO_USER_POOL_ID: cognitoUserPoolId,
          COGNITO_APP_CLIENT_ID: cognitoAppClientId,
          ISB_NAMESPACE: namespace,
        },
        logGroup: restApi.logGroup,
        envSchema: ConfigurationLambdaEnvironmentSchema,
      },
    );

    // Configurations Lambda both reads and writes config sections.
    grantIsbDbReadWrite(scope, configurationsLambdaFunction, configTableName);

    // Grant access to read AccountPoolConfiguration SSM parameter for isbManagedRegions
    grantIsbSsmParameterRead(
      configurationsLambdaFunction.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.accountPoolConfigParamArn,
    );

    IsbKmsKeys.get(scope, namespace).grantEncryptDecrypt(
      configurationsLambdaFunction.lambdaFunction,
    );

    // SES read-only: validate email-from against verified identities on save.
    // GetIdentityVerificationAttributes does not support resource-level
    // permissions, so the resource must be "*".
    configurationsLambdaFunction.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["ses:GetIdentityVerificationAttributes"],
        resources: ["*"],
      }),
    );

    const configurationsResource = restApi.root.addResource("configurations", {
      defaultIntegration: new LambdaIntegration(
        configurationsLambdaFunction.lambdaFunction,
        { allowTestInvoke: true, proxy: true },
      ),
    });
    configurationsResource.addMethod("GET");

    const sectionResource = configurationsResource.addResource("{section}");
    sectionResource.addMethod("GET");
    sectionResource.addMethod("PUT");
  }
}
