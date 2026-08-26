// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Duration } from "aws-cdk-lib";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnSchedule } from "aws-cdk-lib/aws-scheduler";
import { Construct } from "constructs";
import path from "path";

import { PrincipalCacheSyncEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/principal-cache-sync-environment.js";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import {
  getIdcRoleArn,
  IntermediateRole,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import {
  grantIsbDbReadWrite,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export interface PrincipalCacheSyncProps {
  namespace: string;
  idcAccountId: string;
}

export class PrincipalCacheSync extends Construct {
  constructor(scope: Construct, id: string, props: PrincipalCacheSyncProps) {
    super(scope, id);

    const { principalTable } = IsbComputeStack.sharedSpokeConfig.data;

    const syncLambda = new IsbLambdaFunction(this, "SyncLambdaFunction", {
      description:
        "Syncs IDC principals (users and groups) to DynamoDB cache for fast typeahead search",
      entry: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "lambdas",
        "cache",
        "principal-cache-sync",
        "src",
        "principal-cache-sync-handler.ts",
      ),
      handler: "handler",
      namespace: props.namespace,
      timeout: Duration.minutes(15),
      reservedConcurrentExecutions: 1,
      environment: {
        PRINCIPAL_TABLE_NAME: principalTable,
        IDC_CONFIG_PARAM_ARN:
          IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
        IDC_ROLE_ARN: getIdcRoleArn(scope, props.namespace, props.idcAccountId),
        INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
      },
      envSchema: PrincipalCacheSyncEnvironmentSchema,
      logGroup: IsbComputeResources.globalLogGroup,
    });

    // Grant DynamoDB read/write on Principal Table
    grantIsbDbReadWrite(this, syncLambda, principalTable);

    // Grant SSM read for IDC configuration
    grantIsbSsmParameterRead(
      syncLambda.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
    );

    // Grant KMS for table encryption
    IsbKmsKeys.get(scope, props.namespace).grantEncryptDecrypt(
      syncLambda.lambdaFunction,
    );

    // Grant cross-account IDC access via IntermediateRole
    IntermediateRole.addTrustedRole(syncLambda.lambdaFunction.role! as Role);

    // EventBridge Scheduler: invoke every hour
    const schedulerRole = new Role(this, "SchedulerInvokeRole", {
      description:
        "Allows EventBridge Scheduler to invoke the Principal Cache Sync Lambda",
      assumedBy: new ServicePrincipal("scheduler.amazonaws.com"),
    });

    syncLambda.lambdaFunction.grantInvoke(schedulerRole);

    new CfnSchedule(this, "HourlySyncSchedule", {
      description:
        "Syncs IDC principals to DynamoDB cache every hour for fast typeahead search",
      scheduleExpression: "rate(1 hour)",
      flexibleTimeWindow: {
        mode: "FLEXIBLE",
        maximumWindowInMinutes: 5,
      },
      target: {
        input: JSON.stringify({ source: "scheduled" }),
        retryPolicy: {
          maximumRetryAttempts: 2,
        },
        arn: syncLambda.lambdaFunction.functionArn,
        roleArn: schedulerRole.roleArn,
      },
    });
  }
}
