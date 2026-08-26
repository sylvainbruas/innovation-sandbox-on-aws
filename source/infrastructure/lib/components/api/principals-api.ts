// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { LambdaIntegration } from "aws-cdk-lib/aws-apigateway";
import { Role } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import path from "path";

import { PrincipalsLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/principals-lambda-environment.js";
import {
  RestApi,
  RestApiProps,
} from "@amzn/innovation-sandbox-infrastructure/components/api/rest-api-all";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import {
  getIdcRoleArn,
  IntermediateRole,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import {
  grantIsbDbReadOnly,
  grantIsbDbReadWrite,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export class PrincipalsApi {
  constructor(restApi: RestApi, scope: Construct, props: RestApiProps) {
    const { namespace } = props;
    const {
      configTableName,
      principalTable,
      cognitoUserPoolId,
      cognitoAppClientId,
    } = IsbComputeStack.sharedSpokeConfig.data;

    const principalsLambdaFunction = new IsbLambdaFunction(
      scope,
      "PrincipalsLambdaFunction",
      {
        description:
          "Lambda used as API GW method integration for principals search. Reads from DynamoDB cache for fast typeahead.",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "api",
          "principals",
          "src",
          "principals-handler.ts",
        ),
        handler: "handler",
        namespace: namespace,
        environment: {
          PRINCIPAL_TABLE_NAME: principalTable,
          CONFIG_TABLE_NAME: configTableName,
          COGNITO_USER_POOL_ID: cognitoUserPoolId,
          COGNITO_APP_CLIENT_ID: cognitoAppClientId,
          ISB_NAMESPACE: namespace,
          INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
          IDC_ROLE_ARN: getIdcRoleArn(scope, namespace, props.idcAccountId),
          IDC_CONFIG_PARAM_ARN:
            IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
        },
        logGroup: restApi.logGroup,
        envSchema: PrincipalsLambdaEnvironmentSchema,
      },
    );

    // Read-only on config table; read-write on principal table for cache write-through
    grantIsbDbReadOnly(scope, principalsLambdaFunction, configTableName);
    grantIsbDbReadWrite(scope, principalsLambdaFunction, principalTable);

    grantIsbSsmParameterRead(
      principalsLambdaFunction.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
    );

    // Allow the Principals Lambda to assume the IntermediateRole for JIT IDC lookups.
    IntermediateRole.addTrustedRole(
      principalsLambdaFunction.lambdaFunction.role! as Role,
    );

    // API Gateway route: GET /principals/search
    const principalsResource = restApi.root.addResource("principals");
    const searchResource = principalsResource.addResource("search");
    searchResource.addMethod(
      "GET",
      new LambdaIntegration(principalsLambdaFunction.lambdaFunction, {
        allowTestInvoke: true,
        proxy: true,
      }),
    );
  }
}
