// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Aws } from "aws-cdk-lib";
import { LambdaIntegration } from "aws-cdk-lib/aws-apigateway";
import { PolicyStatement, Role } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import path from "path";

import { AccountLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/account-lambda-environment.js";
import {
  RestApi,
  RestApiProps,
} from "@amzn/innovation-sandbox-infrastructure/components/api/rest-api-all";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import {
  getIdcRoleArn,
  getOrgMgtRoleArn,
  getSandboxAccountRoleName,
  IntermediateRole,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import {
  grantCfnStackSetCleanupPermissions,
  grantIsbDbReadOnly,
  grantIsbDbReadWrite,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export class AccountsApi {
  constructor(restApi: RestApi, scope: Construct, props: RestApiProps) {
    const { namespace } = props;
    const {
      configTableName,
      accountTable,
      leaseTable,
      blueprintTable,
      cleanupReportTable,
      cognitoUserPoolId,
      cognitoAppClientId,
    } = IsbComputeStack.sharedSpokeConfig.data;

    const accountsLambdaFunction = new IsbLambdaFunction(
      scope,
      "AccountsLambdaFunction",
      {
        description:
          "Lambda used as API GW method integration for account resources",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "api",
          "accounts",
          "src",
          "accounts-handler.ts",
        ),
        handler: "handler",
        namespace: namespace,
        environment: {
          CONFIG_TABLE_NAME: configTableName,
          ACCOUNT_TABLE_NAME: accountTable,
          LEASE_TABLE_NAME: leaseTable,
          BLUEPRINT_TABLE_NAME: blueprintTable,
          CLEANUP_REPORT_TABLE_NAME: cleanupReportTable,
          SANDBOX_ACCOUNT_ROLE_NAME: getSandboxAccountRoleName(namespace),
          ISB_NAMESPACE: namespace,
          INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
          ORG_MGT_ROLE_ARN: getOrgMgtRoleArn(
            scope,
            namespace,
            props.orgMgtAccountId,
          ),
          IDC_ROLE_ARN: getIdcRoleArn(
            scope,
            namespace,
            props.idcAccountId,
          ),
          ACCOUNT_POOL_CONFIG_PARAM_ARN:
            IsbComputeStack.sharedSpokeConfig.parameterArns
              .accountPoolConfigParamArn,
          IDC_CONFIG_PARAM_ARN:
            IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
          ISB_EVENT_BUS: props.isbEventBus.eventBusName,
          ORG_MGT_ACCOUNT_ID: props.orgMgtAccountId,
          IDC_ACCOUNT_ID: props.idcAccountId,
          HUB_ACCOUNT_ID: Aws.ACCOUNT_ID,
          COGNITO_USER_POOL_ID: cognitoUserPoolId,
          COGNITO_APP_CLIENT_ID: cognitoAppClientId,
        },
        logGroup: restApi.logGroup,
        envSchema: AccountLambdaEnvironmentSchema,
      },
    );

    grantIsbSsmParameterRead(
      accountsLambdaFunction.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
    );
    grantIsbSsmParameterRead(
      accountsLambdaFunction.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.accountPoolConfigParamArn,
    );
    grantIsbDbReadWrite(
      scope,
      accountsLambdaFunction,
      IsbComputeStack.sharedSpokeConfig.data.accountTable,
      IsbComputeStack.sharedSpokeConfig.data.leaseTable,
      IsbComputeStack.sharedSpokeConfig.data.blueprintTable,
      IsbComputeStack.sharedSpokeConfig.data.cleanupReportTable,
    );
    grantIsbDbReadOnly(scope, accountsLambdaFunction, configTableName);
    props.isbEventBus.grantPutEventsTo(accountsLambdaFunction.lambdaFunction);

    IsbKmsKeys.get(scope, namespace).grantEncryptDecrypt(
      accountsLambdaFunction.lambdaFunction,
    );

    // Grant CloudFormation permissions for stack instance cleanup during account ejection.
    grantCfnStackSetCleanupPermissions(
      accountsLambdaFunction.lambdaFunction.role! as Role,
    );

    IntermediateRole.addTrustedRole(
      accountsLambdaFunction.lambdaFunction.role! as Role,
    );

    // Grant permission to skip account cooldown via durable execution callback
    (accountsLambdaFunction.lambdaFunction.role! as Role).addToPolicy(
      new PolicyStatement({
        actions: ["lambda:SendDurableExecutionCallbackSuccess"],
        resources: [`${props.durableCleanupFunctionArn}:*/durable-execution/*`],
      }),
    );

    const accountsResource = restApi.root.addResource("accounts", {
      defaultIntegration: new LambdaIntegration(
        accountsLambdaFunction.lambdaFunction,
        { allowTestInvoke: true, proxy: true },
      ),
    });
    accountsResource.addMethod("GET");
    accountsResource.addMethod("POST");

    const accountIdResource = accountsResource.addResource("{awsAccountId}");
    accountIdResource.addMethod("GET");

    const accountRetryCleanupResource =
      accountIdResource.addResource("retryCleanup");
    accountRetryCleanupResource.addMethod("POST");

    const accountEjectResource = accountIdResource.addResource("eject");
    accountEjectResource.addMethod("POST");

    const accountQuarantineResource =
      accountIdResource.addResource("quarantine");
    accountQuarantineResource.addMethod("POST");

    const accountsUnregisteredResource =
      accountsResource.addResource("unregistered");
    accountsUnregisteredResource.addMethod("GET");

    const cleanupReportsResource =
      accountIdResource.addResource("cleanup-reports");
    cleanupReportsResource.addMethod("GET");

    const skipCooldownResource = accountIdResource.addResource("skipCooldown");
    skipCooldownResource.addMethod("POST");
  }
}
