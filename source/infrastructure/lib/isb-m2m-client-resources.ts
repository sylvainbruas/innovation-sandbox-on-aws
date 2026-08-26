// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Aws, CfnCondition, CfnMapping, Fn, Tags } from "aws-cdk-lib";
import {
  ArnPrincipal,
  CfnRole,
  PolicyStatement,
  Role,
} from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

import { computeRestApiIdSsmParamName } from "@amzn/innovation-sandbox-commons/types/isb-types";
import {
  buildM2mRolePrefix,
  M2M_STACK_TYPE_TAG_KEY,
  M2M_STACK_TYPE_TAG_VALUE,
} from "@amzn/innovation-sandbox-commons/utils/m2m-role-arn";
import { addCfnGuardSuppression } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-guard";
import { UniqueStackIdPart } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-utils";

export interface IsbM2mClientResourcesProps {
  readonly namespace: string;
  readonly clientName: string;
  readonly role: string;
  readonly trustedPrincipal: string;
  readonly maxSessionDuration: number;
}

export class IsbM2mClientResources {
  public readonly m2mRole: Role;
  public readonly externalId: string;
  public readonly apiArn: string;
  public readonly apiUrl: string;

  constructor(scope: Construct, props: IsbM2mClientResourcesProps) {
    // CFN doesn't auto-tag IAM roles with aws:cloudformation:stack-name,
    // so we carry our own stack-name tag for tag-based discovery.
    Tags.of(scope).add(M2M_STACK_TYPE_TAG_KEY, M2M_STACK_TYPE_TAG_VALUE);
    Tags.of(scope).add("aws-solutions:isb-stack-name", Aws.STACK_NAME);

    const restApiIdSsmName = computeRestApiIdSsmParamName("${Namespace}");
    const restApiId = Fn.sub(`{{resolve:ssm:/${restApiIdSsmName}}}`);
    this.apiArn = `arn:${Aws.PARTITION}:execute-api:${Aws.REGION}:${Aws.ACCOUNT_ID}:${restApiId}/*`;
    this.apiUrl = `https://${restApiId}.execute-api.${Aws.REGION}.${Aws.URL_SUFFIX}/prod`;

    // An ARN's first colon-segment is "arn"; a bare 12-digit account ID
    // has no colons, so its split[0] is the ID itself.
    const trustedPrincipalIsArnCondition = new CfnCondition(
      scope,
      "TrustedPrincipalIsArn",
      {
        expression: Fn.conditionEquals(
          Fn.select(0, Fn.split(":", props.trustedPrincipal)),
          "arn",
        ),
      },
    );

    const normalizedTrustedPrincipalArn = Fn.conditionIf(
      trustedPrincipalIsArnCondition.logicalId,
      props.trustedPrincipal,
      `arn:${Aws.PARTITION}:iam::${props.trustedPrincipal}:root`,
    ).toString();

    this.externalId = UniqueStackIdPart;

    // The auth middleware regex matches against the lowercased role tier in
    // the role name (<ns>-isb-m2m-<lowercased-role>-<client>). CFN has no
    // native lowercase function — use a Mapping.
    const roleLowercaseMapping = new CfnMapping(scope, "RoleLowercaseMapping", {
      mapping: {
        Admin: { lowercased: "admin" },
        Manager: { lowercased: "manager" },
        User: { lowercased: "user" },
      },
    });
    const lowercasedRole = roleLowercaseMapping.findInMap(
      props.role,
      "lowercased",
    );

    // IAM caps role names at 64 chars. Worst case the constructed name is
    //   8 (Namespace max)  +  9 (`-isb-m2m-`)  +  7 (longest lowercased
    //   role: "manager")  +  1 (`-`)  +  32 (ClientName max)  =  57 chars.
    // Bounded by the Namespace and ClientName allowedPattern constraints.
    const roleName = `${props.namespace}-isb-m2m-${lowercasedRole}-${props.clientName}`;

    this.m2mRole = new Role(scope, "M2mClientRole", {
      roleName,
      path: `/${buildM2mRolePrefix(props.namespace)}/`,
      assumedBy: new ArnPrincipal(normalizedTrustedPrincipalArn).withConditions(
        {
          StringEquals: {
            "sts:ExternalId": this.externalId,
          },
        },
      ),
      description: `ISB M2M client role for ${props.clientName}`,
    });

    addCfnGuardSuppression(this.m2mRole, ["CFN_NO_EXPLICIT_RESOURCE_NAMES"]);

    // CDK's Role token-validates the duration and rejects parameter refs.
    (this.m2mRole.node.defaultChild as CfnRole).maxSessionDuration =
      props.maxSessionDuration;

    this.m2mRole.addToPolicy(
      new PolicyStatement({
        actions: ["execute-api:Invoke"],
        resources: [this.apiArn],
      }),
    );
  }
}
