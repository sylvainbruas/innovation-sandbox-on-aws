// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { CfnOutput, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";

import {
  addParameterGroup,
  ParameterWithLabel,
} from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-utils";
import { NamespaceParam } from "@amzn/innovation-sandbox-infrastructure/helpers/shared-cfn-params";
import { applyIsbTag } from "@amzn/innovation-sandbox-infrastructure/helpers/tagging-helper";
import { IsbM2mClientResources } from "@amzn/innovation-sandbox-infrastructure/isb-m2m-client-resources";

export class IsbM2mClientStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const namespaceParam = new NamespaceParam(this);

    const clientNameParam = new ParameterWithLabel(this, "ClientName", {
      label: "Client Name",
      description:
        "Short identifier for this M2M client (e.g. 'deploy-pipeline'). Becomes part of the IAM role name and CloudTrail audit. 3-32 chars, lowercase alphanumeric and hyphens, no leading/trailing hyphen.",
      allowedPattern: "^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$",
      constraintDescription:
        "Client name must be 3-32 chars, lowercase alphanumeric and hyphens, no leading/trailing hyphen (e.g., 'deploy-pipeline', 'qa-bot').",
    });

    const roleParam = new ParameterWithLabel(this, "Role", {
      label: "ISB Role",
      description:
        "The ISB role this M2M client gets. Admin > Manager > User in the role hierarchy.",
      allowedValues: ["Admin", "Manager", "User"],
    });

    const trustedPrincipalParam = new ParameterWithLabel(
      this,
      "TrustedPrincipal",
      {
        label: "Trusted Principal",
        description:
          "An IAM ARN (arn:aws:iam::<accountId>:role/<name> or :user/<name>) to pin to a specific principal, OR a 12-digit account ID to trust any principal in that account that has sts:AssumeRole permission. Both forms also require the per-stack ExternalId.",
        allowedPattern:
          "^(arn:aws:iam::[0-9]{12}:(role|user)/.+|[0-9]{12})$",
        constraintDescription:
          "TrustedPrincipal must be either an IAM ARN (arn:aws:iam::<accountId>:role/<name> or arn:aws:iam::<accountId>:user/<name>) or a 12-digit AWS account ID.",
      },
    );

    const maxSessionDurationParam = new ParameterWithLabel(
      this,
      "MaxSessionDuration",
      {
        label: "Max Session Duration (seconds)",
        description:
          "Maximum STS session duration for AssumeRole calls against this role, in seconds. Default 3600 (1 hour). Up to 43200 (12 hours) for long-running jobs.",
        type: "Number",
        default: "3600",
        minValue: 3600,
        maxValue: 43200,
      },
    );

    addParameterGroup(this, {
      label: "M2M Client Configuration",
      parameters: [
        namespaceParam,
        clientNameParam,
        roleParam,
        trustedPrincipalParam,
        maxSessionDurationParam,
      ],
    });

    const m2mResources = new IsbM2mClientResources(this, {
      namespace: namespaceParam.valueAsString,
      clientName: clientNameParam.valueAsString,
      role: roleParam.valueAsString,
      trustedPrincipal: trustedPrincipalParam.valueAsString,
      maxSessionDuration: maxSessionDurationParam.valueAsNumber,
    });

    applyIsbTag(this, namespaceParam.valueAsString);

    new CfnOutput(this, "M2MRoleArnOutput", {
      key: "M2MRoleArn",
      value: m2mResources.m2mRole.roleArn,
      description: "ARN of the M2M IAM role for this client.",
    });

    new CfnOutput(this, "M2MExternalIdOutput", {
      key: "M2MExternalId",
      value: m2mResources.externalId,
      description:
        "ExternalId for AssumeRole calls against this client's role. Required by the trust policy condition.",
    });

    new CfnOutput(this, "ApiGatewayArnOutput", {
      key: "ApiGatewayArn",
      value: m2mResources.apiArn,
      description:
        "API Gateway ARN this client role is scoped to. Constructed from the REST API ID parameter.",
    });

    new CfnOutput(this, "ApiGatewayUrlOutput", {
      key: "ApiGatewayUrl",
      value: m2mResources.apiUrl,
      description:
        "Base URL for invoking the API. Append the API path (e.g. /leases) to make a request.",
    });
  }
}
