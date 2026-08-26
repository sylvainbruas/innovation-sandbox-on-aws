// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Stack } from "aws-cdk-lib";
import {
  AccountPrincipal,
  CompositePrincipal,
  Effect,
  PolicyDocument,
  PolicyStatement,
  PrincipalWithConditions,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

import { addCfnGuardSuppression } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-guard";
import {
  getIntermediateRoleName,
  getSandboxAccountRoleName,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";

export interface IsbSandboxAccountResourcesProps {
  hubAccountId: string;
  namespace: string;
}

export class IsbSandboxAccountResources {
  constructor(scope: Construct, props: IsbSandboxAccountResourcesProps) {
    const sandboxAccountRole = new Role(scope, "SandboxAccountRole", {
      roleName: getSandboxAccountRoleName(props.namespace),
      description: "Role to be assumed when operating on sandbox accounts",
      // CloudFormation trust is required so that aws-nuke's UseCurrentRoleToDeleteStack
      // feature can pass this role as RoleARN on DeleteStack calls. Without it,
      // CloudFormation cannot assume the spoke role to perform stack deletion.
      // Confused deputy is mitigated by the ProtectIsbControlPlaneResources SCP on
      // sandboxOu, which denies all actions on ISB role resources from non-ISB principals.
      assumedBy: new CompositePrincipal(
        new PrincipalWithConditions(
          new AccountPrincipal(props.hubAccountId),
          {
            ArnEquals: {
              "aws:PrincipalArn": Stack.of(scope).formatArn({
                service: "iam",
                resource: "role",
                region: "",
                account: props.hubAccountId,
                resourceName: getIntermediateRoleName(props.namespace),
              }),
            },
          },
        ),
        new ServicePrincipal("cloudformation.amazonaws.com"),
      ),
      inlinePolicies: {
        SandboxAccountAdministration: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["*"], // NOSONAR typescript:S6302 - this is a full access role used by the account cleaner
              resources: ["*"],
            }),
          ],
        }),
      },
    });

    addCfnGuardSuppression(sandboxAccountRole, [
      "CFN_NO_EXPLICIT_RESOURCE_NAMES",
      "IAM_NO_INLINE_POLICY_CHECK",
      "IAM_POLICYDOCUMENT_NO_WILDCARD_RESOURCE",
    ]);
  }
}
