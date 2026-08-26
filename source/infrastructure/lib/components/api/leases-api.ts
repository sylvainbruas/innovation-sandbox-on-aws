// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Aws, Stack } from "aws-cdk-lib";
import { LambdaIntegration } from "aws-cdk-lib/aws-apigateway";
import { Effect, PolicyStatement, Role } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import path from "path";

import { LeaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-lambda-environment.js";
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

export class LeasesApi {
  constructor(restApi: RestApi, scope: Construct, props: RestApiProps) {
    const { namespace } = props;
    const {
      configTableName,
      leaseTemplateTable,
      leaseTable,
      accountTable,
      principalTable,
      cognitoUserPoolId,
      cognitoAppClientId,
    } = IsbComputeStack.sharedSpokeConfig.data;

    const leasesLambdaFunction = new IsbLambdaFunction(
      scope,
      "LeasesLambdaFunction",
      {
        description:
          "Lambda used as API GW method integration for leases resources",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "api",
          "leases",
          "src",
          "leases-handler.ts",
        ),
        handler: "handler",
        namespace: namespace,
        environment: {
          CONFIG_TABLE_NAME: configTableName,
          ISB_NAMESPACE: namespace,
          ACCOUNT_TABLE_NAME: accountTable,
          LEASE_TABLE_NAME: leaseTable,
          LEASE_TEMPLATE_TABLE_NAME: leaseTemplateTable,
          PRINCIPAL_TABLE_NAME: principalTable,
          ISB_EVENT_BUS: props.isbEventBus.eventBusName,
          INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
          IDC_ROLE_ARN: getIdcRoleArn(
            scope,
            namespace,
            props.idcAccountId,
          ),
          ORG_MGT_ROLE_ARN: getOrgMgtRoleArn(
            scope,
            namespace,
            props.orgMgtAccountId,
          ),
          BLUEPRINT_TABLE_NAME:
            IsbComputeStack.sharedSpokeConfig.data.blueprintTable,
          SANDBOX_ACCOUNT_ROLE_NAME: getSandboxAccountRoleName(namespace),
          ACCOUNT_POOL_CONFIG_PARAM_ARN:
            IsbComputeStack.sharedSpokeConfig.parameterArns
              .accountPoolConfigParamArn,
          IDC_CONFIG_PARAM_ARN:
            IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
          ORG_MGT_ACCOUNT_ID: props.orgMgtAccountId,
          HUB_ACCOUNT_ID: Aws.ACCOUNT_ID,
          COGNITO_USER_POOL_ID: cognitoUserPoolId,
          COGNITO_APP_CLIENT_ID: cognitoAppClientId,
        },
        logGroup: restApi.logGroup,
        envSchema: LeaseLambdaEnvironmentSchema,
      },
    );

    grantIsbSsmParameterRead(
      leasesLambdaFunction.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
    );
    grantIsbSsmParameterRead(
      leasesLambdaFunction.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.accountPoolConfigParamArn,
    );
    grantIsbDbReadWrite(
      scope,
      leasesLambdaFunction,
      leaseTable,
      leaseTemplateTable,
      accountTable,
      IsbComputeStack.sharedSpokeConfig.data.blueprintTable,
      principalTable,
    );
    grantIsbDbReadOnly(scope, leasesLambdaFunction, configTableName);

    props.isbEventBus.grantPutEventsTo(leasesLambdaFunction.lambdaFunction);

    // Grant CloudFormation StackSet read-only permissions for blueprint validation
    leasesLambdaFunction.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["cloudformation:DescribeStackSet"],
        resources: [
          Stack.of(scope).formatArn({
            service: "cloudformation",
            resource: "stackset",
            resourceName: "*:*",
          }),
        ],
      }),
    );

    IsbKmsKeys.get(scope, namespace).grantEncryptDecrypt(
      leasesLambdaFunction.lambdaFunction,
    );

    // Grant CloudFormation permissions for stack instance cleanup during manual lease termination.
    // POST /leases/{leaseId}/terminate calls deleteStackInstancesMetadata() which needs DeleteStackInstances.
    grantCfnStackSetCleanupPermissions(
      leasesLambdaFunction.lambdaFunction.role! as Role,
    );

    IntermediateRole.addTrustedRole(
      leasesLambdaFunction.lambdaFunction.role! as Role,
    );

    const leasesResource = restApi.root.addResource("leases", {
      defaultIntegration: new LambdaIntegration(
        leasesLambdaFunction.lambdaFunction,
        {
          allowTestInvoke: true,
          proxy: true,
        },
      ),
    });
    leasesResource.addMethod("GET");
    leasesResource.addMethod("POST");

    const leaseIdResource = leasesResource.addResource("{leaseId}");
    leaseIdResource.addMethod("GET");
    leaseIdResource.addMethod("PATCH");

    const leaseReviewResource = leaseIdResource.addResource("review");
    leaseReviewResource.addMethod("POST");

    const leaseFreezeResource = leaseIdResource.addResource("freeze");
    leaseFreezeResource.addMethod("POST");

    const leaseUnfreezeResource = leaseIdResource.addResource("unfreeze");
    leaseUnfreezeResource.addMethod("POST");

    const leaseTerminateResource = leaseIdResource.addResource("terminate");
    leaseTerminateResource.addMethod("POST");

    const leaseAssignmentsResource = leaseIdResource.addResource("assignments");
    leaseAssignmentsResource.addMethod("GET");
    leaseAssignmentsResource.addMethod("PUT");

    const leaseSharedResource = leasesResource.addResource("shared");
    leaseSharedResource.addMethod("GET");
  }
}
