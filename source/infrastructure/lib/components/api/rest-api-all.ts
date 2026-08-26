// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Aws, Token } from "aws-cdk-lib";
import {
  RestApi as ApiGatewayRestApi,
  AuthorizationType,
  LogGroupLogDestination,
} from "aws-cdk-lib/aws-apigateway";
import { EventBus } from "aws-cdk-lib/aws-events";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

import { AccountsApi } from "@amzn/innovation-sandbox-infrastructure/components/api/accounts-api";
import { BlueprintsApi } from "@amzn/innovation-sandbox-infrastructure/components/api/blueprints-api";
import { ConfigurationsApi } from "@amzn/innovation-sandbox-infrastructure/components/api/configurations-api";
import { LeaseTemplatesApi } from "@amzn/innovation-sandbox-infrastructure/components/api/lease-templates-api";
import { LeasesApi } from "@amzn/innovation-sandbox-infrastructure/components/api/leases-api";
import { PrincipalsApi } from "@amzn/innovation-sandbox-infrastructure/components/api/principals-api";
import { Waf } from "@amzn/innovation-sandbox-infrastructure/components/api/waf";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import { getContextFromMapping } from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";
import { addCfnGuardSuppression } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-guard";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";

export interface RestApiProps {
  intermediateRole: Role;
  namespace: string;
  idcAccountId: string;
  orgMgtAccountId: string;
  isbEventBus: EventBus;
  allowListedCidr: string[];
  durableCleanupFunctionArn: string;
}

export class RestApi extends ApiGatewayRestApi {
  public readonly logGroup: LogGroup;
  public readonly wafWebAclName: string;

  constructor(scope: Construct, id: string, props: RestApiProps) {
    const kmsKey = IsbKmsKeys.get(scope, props.namespace);
    kmsKey.grantEncryptDecrypt(
      new ServicePrincipal("logs.amazonaws.com", { region: Aws.REGION }),
    );

    super(scope, id, {
      description: "Innovation Sandbox on AWS Rest API",
      deployOptions: {
        accessLogDestination: new LogGroupLogDestination(
          IsbComputeResources.globalLogGroup,
        ),
        tracingEnabled: true,
        throttlingRateLimit: Token.asNumber(
          getContextFromMapping(scope, "apiThrottlingRateLimit"),
        ),
        throttlingBurstLimit: Token.asNumber(
          getContextFromMapping(scope, "apiThrottlingBurstLimit"),
        ),
        cacheClusterEnabled: true,
        cacheClusterSize: "0.5",
        cachingEnabled: false,
        cacheDataEncrypted: true,
      },
      defaultMethodOptions: {
        authorizationType: AuthorizationType.IAM,
      },
    });

    addCfnGuardSuppression(this.deploymentStage, [
      "API_GW_CACHE_ENABLED_AND_ENCRYPTED",
    ]);

    // Configure WAF with logging and alarms
    const waf = new Waf(this, "Waf", {
      namespace: props.namespace,
      resourceArn: this.deploymentStage.stageArn,
      allowListedCidr: props.allowListedCidr,
      kmsKey,
    });
    this.wafWebAclName = waf.webAcl.webAclRef.webAclName;

    this.logGroup = IsbComputeResources.globalLogGroup;

    new LeasesApi(this, scope, props);
    new LeaseTemplatesApi(this, scope, props);
    new AccountsApi(this, scope, props);
    new BlueprintsApi(this, scope, props);
    new ConfigurationsApi(this, scope, props);
    new PrincipalsApi(this, scope, props);
  }
}
