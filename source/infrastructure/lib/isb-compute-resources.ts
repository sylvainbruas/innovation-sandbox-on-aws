// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Aws, CfnCondition, CfnOutput, Fn, Lazy, aws_ssm } from "aws-cdk-lib";
import {
  Policy,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

import { computeRestApiIdSsmParamName } from "@amzn/innovation-sandbox-commons/types/isb-types";
import { AccountCleaner } from "@amzn/innovation-sandbox-infrastructure/components/account-cleaner/account-cleaner";
import { RestApi } from "@amzn/innovation-sandbox-infrastructure/components/api/rest-api-all";
import { AssignmentProcessing } from "@amzn/innovation-sandbox-infrastructure/components/assignment-processing/assignment-processing";
import { IsbAuthResources } from "@amzn/innovation-sandbox-infrastructure/components/auth/isb-auth-resources";
import { BlueprintDeployment } from "@amzn/innovation-sandbox-infrastructure/components/blueprint-deployment/blueprint-deployment";
import { PrincipalCacheSync } from "@amzn/innovation-sandbox-infrastructure/components/cache/principal-cache-sync";
import { CloudfrontUiApi } from "@amzn/innovation-sandbox-infrastructure/components/cloudfront/cloudfront-ui-api";
import { DeploymentUUID } from "@amzn/innovation-sandbox-infrastructure/components/custom-resources/deployment-uuid";
import { TagActivationWorkflow } from "@amzn/innovation-sandbox-infrastructure/components/custom-resources/tag-activation-workflow";
import { IsbInternalCore } from "@amzn/innovation-sandbox-infrastructure/components/events/isb-internal-core";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import { AnonymizedMetricsReporting } from "@amzn/innovation-sandbox-infrastructure/components/observability/anonymized-metrics-reporting";
import { CostReportingLambda } from "@amzn/innovation-sandbox-infrastructure/components/observability/cost-reporting-lambda";
import { LogArchiving } from "@amzn/innovation-sandbox-infrastructure/components/observability/log-archiving";
import { IsbLogGroups } from "@amzn/innovation-sandbox-infrastructure/components/observability/log-groups";
import { LogInsightsQueries } from "@amzn/innovation-sandbox-infrastructure/components/observability/log-insights-queries";
import { TaggingFailureAlarm } from "@amzn/innovation-sandbox-infrastructure/components/observability/tagging-failure-alarm";
import { getContextFromMapping } from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";
import { addCfnGuardSuppression } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-guard";
import { YesNoParameter } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-utils";
import { IntermediateRole } from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import { GroupCostReportingLambda } from "./components/observability/group-cost-reporting-lambda";

export interface IsbComputeResourcesProps {
  namespace: string;
  orgMgtAccountId: string;
  idcAccountId: string;
  allowListedCidr: string[];
  useStableTaggingParameter: YesNoParameter;
  cognitoUserPoolId: string;
  cognitoUserPoolArn: string;
  cognitoAppClientId: string;
  cognitoIdentityPoolId: string;
  cognitoDomain: string;
  awsAccessPortalUrl: string;
  identityPoolAdminRoleName: string;
  identityPoolManagerRoleName: string;
  identityPoolUserRoleName: string;
  customDomainName: string;
  customDomainCertificateArn: string;
}

export class IsbComputeResources {
  public static namespace: string;
  public static globalLogGroup: LogGroup;
  public static cleanupLogGroup: LogGroup;

  constructor(scope: Construct, props: IsbComputeResourcesProps) {
    //init global log group for use by rest of solution
    const kmsKey = IsbKmsKeys.get(scope, props.namespace);
    kmsKey.grantEncryptDecrypt(
      new ServicePrincipal("logs.amazonaws.com", { region: Aws.REGION }),
    );

    IsbComputeResources.namespace = props.namespace;
    IsbComputeResources.globalLogGroup = IsbLogGroups.globalLogGroup(
      scope,
      props.namespace,
    );
    IsbComputeResources.cleanupLogGroup = IsbLogGroups.cleanupLogGroup(
      scope,
      props.namespace,
    );

    kmsKey.grantEncryptDecrypt(new ServicePrincipal("events.amazonaws.com"));
    //log group initialized

    const deploymentUUID = new DeploymentUUID(scope, "DeploymentUUID", {
      namespace: props.namespace,
    });

    const intermediateRole = IntermediateRole.getInstance(scope, {
      namespace: props.namespace,
      idcAccountId: props.idcAccountId,
      orgMgtAccountId: props.orgMgtAccountId,
    });

    addCfnGuardSuppression(intermediateRole, [
      "CFN_NO_EXPLICIT_RESOURCE_NAMES",
    ]);

    // Use Lazy.string to defer webAppUrl resolution until after CloudFront is created.
    let resolvedBaseUrl: string;

    const isbInternalCore = new IsbInternalCore(scope, {
      namespace: props.namespace,
      kmsKey,
      orgMgtAccountId: props.orgMgtAccountId,
      idcAccountId: props.idcAccountId,
      webAppUrl: Lazy.string({
        produce: () => resolvedBaseUrl,
      }),
    });

    const accountCleaner = new AccountCleaner(scope, "AccountCleaner", {
      eventBus: isbInternalCore.eventBus,
      namespace: props.namespace,
      orgMgtAccountId: props.orgMgtAccountId,
      idcAccountId: props.idcAccountId,
      useStableTaggingCondition: props.useStableTaggingParameter.getCondition(),
    });

    new BlueprintDeployment(scope, "BlueprintDeployment", {
      eventBus: isbInternalCore.eventBus,
      namespace: props.namespace,
      orgManagementAccountId: props.orgMgtAccountId,
      hubAccountId: Aws.ACCOUNT_ID,
    });

    new AssignmentProcessing(scope, "AssignmentProcessing", {
      namespace: props.namespace,
      eventBus: isbInternalCore.eventBus,
      idcAccountId: props.idcAccountId,
    });

    new PrincipalCacheSync(scope, "PrincipalCacheSync", {
      namespace: props.namespace,
      idcAccountId: props.idcAccountId,
    });

    new TagActivationWorkflow(scope, "TagActivationWorkflow", {
      namespace: props.namespace,
      orgMgtAccountId: props.orgMgtAccountId,
    });

    new TaggingFailureAlarm(scope, "TaggingFailureAlarm", {
      globalLogGroup: IsbComputeResources.globalLogGroup,
      cleanupLogGroup: IsbComputeResources.cleanupLogGroup,
    });

    const restApi = new RestApi(scope, "IsbRestApi", {
      intermediateRole: intermediateRole,
      namespace: props.namespace,
      idcAccountId: props.idcAccountId,
      orgMgtAccountId: props.orgMgtAccountId,
      isbEventBus: isbInternalCore.eventBus,
      allowListedCidr: props.allowListedCidr,
      durableCleanupFunctionArn: accountCleaner.durableCleanupFunctionArn,
    });

    // Per-client M2M stacks (IsbM2mClientStack) import this to construct the
    // execute-api ARN they grant to their client role.
    new aws_ssm.StringParameter(scope, "IsbRestApiIdParameter", {
      parameterName: computeRestApiIdSsmParamName(props.namespace),
      description:
        "API Gateway REST API ID for the Innovation Sandbox API. Imported by per-client M2M client stacks to construct execute-api ARNs and invoke URLs.",
      stringValue: restApi.restApiId,
      simpleName: true,
    });

    // Scope `execute-api:Invoke` to this deployment's specific REST API,
    // preventing Identity Pool credentials from reaching other IAM-authed
    // APIs in the same account.
    const identityPoolRoles = [
      { tier: "Admin", roleName: props.identityPoolAdminRoleName },
      { tier: "Manager", roleName: props.identityPoolManagerRoleName },
      { tier: "User", roleName: props.identityPoolUserRoleName },
    ];
    for (const { tier, roleName } of identityPoolRoles) {
      const importedRole = Role.fromRoleName(
        scope,
        `IsbIdentityPool${tier}Role`,
        roleName,
      );
      new Policy(scope, `IsbIdentityPool${tier}ApiInvokePolicy`, {
        roles: [importedRole],
        statements: [
          new PolicyStatement({
            actions: ["execute-api:Invoke"],
            resources: [restApi.arnForExecuteApi()],
          }),
        ],
      });
    }

    const cloudfrontUiApi = new CloudfrontUiApi(scope, "CloudFrontUiApi", {
      restApi,
      namespace: props.namespace,
      cognitoUserPoolId: props.cognitoUserPoolId,
      cognitoAppClientId: props.cognitoAppClientId,
      cognitoIdentityPoolId: props.cognitoIdentityPoolId,
      cognitoDomain: props.cognitoDomain,
      awsAccessPortalUrl: props.awsAccessPortalUrl,
      customDomainName: props.customDomainName,
      customDomainCertificateArn: props.customDomainCertificateArn,
    });

    // Compute the resolved base URL: use the custom domain if provided, otherwise
    // the CloudFront URL. Both are CFN tokens, so we use Fn.conditionIf at deploy time.
    // Note: OptionalParameter can't be used here because its valueIfEmpty is set at
    // construction time, but the CloudFront URL isn't available until after this point.
    const cloudfrontBaseUrl = `https://${cloudfrontUiApi.distributionDomainName}`;
    const hasCustomDomain = new CfnCondition(scope, "HasCustomDomain", {
      expression: Fn.conditionNot(
        Fn.conditionEquals(props.customDomainName, ""),
      ),
    });
    resolvedBaseUrl = Fn.conditionIf(
      hasCustomDomain.logicalId,
      `https://${props.customDomainName}`,
      cloudfrontBaseUrl,
    ).toString();

    new LogInsightsQueries(scope, "LogInsightsQueries", {
      namespace: props.namespace,
    });

    new AnonymizedMetricsReporting(scope, "AnonymizedMetrics", {
      metricsUrl: "https://metrics.awssolutionsbuilder.com/generic",
      solutionId: getContextFromMapping(scope, "solutionId"),
      solutionVersion: getContextFromMapping(scope, "version"),
      deploymentUUID: deploymentUUID.deploymentUUID,
      namespace: props.namespace,
      hubAccountId: Aws.ACCOUNT_ID,
      orgManagementAccountId: props.orgMgtAccountId,
      isStableTaggingEnabled: props.useStableTaggingParameter.valueAsString,
      wafWebAclName: restApi.wafWebAclName,
    });

    new CostReportingLambda(scope, "CostReportingLambda", {
      namespace: props.namespace,
      orgMgtAccountId: props.orgMgtAccountId,
      idcAccountId: props.idcAccountId,
    });

    new GroupCostReportingLambda(scope, "GroupCostReportingLambda", {
      namespace: props.namespace,
      orgMgtAccountId: props.orgMgtAccountId,
      isbEventBus: isbInternalCore.eventBus,
    });

    new LogArchiving(scope, "LogArchiving", {
      namespace: props.namespace,
    });

    new IsbAuthResources(scope, "AuthResources", {
      namespace: props.namespace,
      idcAccountId: props.idcAccountId,
      cognitoUserPoolId: props.cognitoUserPoolId,
      cognitoUserPoolArn: props.cognitoUserPoolArn,
      cognitoAppClientId: props.cognitoAppClientId,
      resolvedBaseUrl,
      awsAccessPortalUrl: props.awsAccessPortalUrl,
    });

    new CfnOutput(scope, "ResolvedUrlOutput", {
      value: resolvedBaseUrl,
      key: "ResolvedUrl",
      description:
        "The resolved base URL for the deployment. Uses the Custom Domain Name if provided, otherwise the CloudFront distribution URL.",
    });

    new CfnOutput(scope, "RestApiIdOutput", {
      value: restApi.restApiId,
      key: "RestApiId",
      description:
        "The API Gateway REST API ID. M2M client stacks accept this as the RestApiId parameter; also published at SSM /InnovationSandbox_<namespace>_Compute_RestApiId.",
    });

    new CfnOutput(scope, "DeploymentUUIDOutput", {
      value: deploymentUUID.deploymentUUID,
    });
  }
}
