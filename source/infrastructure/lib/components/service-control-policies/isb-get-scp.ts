// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Effect, PolicyDocument, PolicyStatement } from "aws-cdk-lib/aws-iam";

import {
  buildNukeScpConditionBlock,
  injectBedrockInferenceProfilePatterns,
  injectPrincipalExceptions,
  loadPolicyFromFile,
  type ScpPolicy,
  type ScpStatement,
} from "./scp-policy-utils.js";

function createScpStatement(props: {
  sid: string;
  effect: Effect;
  actions?: string[];
  notActions?: string[];
  resources: string[];
  conditions?: Record<string, Record<string, any>>;
}): PolicyStatement {
  const statement = new PolicyStatement({
    effect: props.effect,
    actions: props.actions,
    resources: props.resources,
    conditions: props.conditions,
  });

  // Set either actions or notActions, but not both
  if (props.actions) {
    statement.addActions(...props.actions);
  } else if (props.notActions) {
    statement.addNotActions(...props.notActions);
  }

  statement.sid = props.sid;
  return statement;
}

function convertToStatements(rawStatements: ScpStatement[]): PolicyStatement[] {
  const statements: PolicyStatement[] = [];

  for (const stmt of rawStatements) {
    const statement = createScpStatement({
      sid: stmt.Sid,
      effect: stmt.Effect === "Deny" ? Effect.DENY : Effect.ALLOW,
      actions: stmt.Action,
      notActions: stmt.NotAction,
      resources: stmt.Resource,
      conditions: stmt.Condition,
    });
    statements.push(statement);
  }

  return statements;
}

function convertToPolicyDocument(policy: ScpPolicy): PolicyDocument {
  const statements = convertToStatements(policy.Statement);
  return new PolicyDocument({
    statements: statements,
  });
}

export interface IsbScpPolicyProps {
  namespace?: string;
  isbManagedRegions?: string[];
  scpDirectoryPath?: string;
  additionalPrincipalExceptions?: string[];
  hasAdditionalPrincipalExceptionsConditionId?: string;
  bedrockInferenceProfilePatterns?: string[];
  hasBedrockInferenceProfilePatternsConditionId?: string;
}

export function getInnovationSandboxProtectScp(
  props: IsbScpPolicyProps,
): PolicyDocument {
  // Note: Protect ISB Resources SCP is intentionally excluded from principal exceptions
  // per design. Customer-added principals should NOT bypass ISB control plane protection.
  const protectPolicy = loadPolicyFromFile(
    "isb-protect-control-plane-resource-scp.json",
    props.namespace,
    props.isbManagedRegions,
    props.scpDirectoryPath,
  );

  return convertToPolicyDocument(protectPolicy);
}

export function getInnovationSandboxRestrictionsScp(
  props: IsbScpPolicyProps,
): PolicyDocument {
  const restrictionsPolicy = loadPolicyFromFile(
    "isb-restrictions-scp.json",
    props.namespace,
    props.isbManagedRegions,
    props.scpDirectoryPath,
  );

  injectPrincipalExceptions(
    restrictionsPolicy,
    props.additionalPrincipalExceptions,
    props.hasAdditionalPrincipalExceptionsConditionId,
  );

  return convertToPolicyDocument(restrictionsPolicy);
}

export function getInnovationSandboxLimitRegionsScp(
  props: IsbScpPolicyProps,
): PolicyDocument {
  const limitRegionsPolicy = loadPolicyFromFile(
    "isb-limit-managed-regions.json",
    props.namespace,
    props.isbManagedRegions,
    props.scpDirectoryPath,
  );

  injectPrincipalExceptions(
    limitRegionsPolicy,
    props.additionalPrincipalExceptions,
    props.hasAdditionalPrincipalExceptionsConditionId,
  );

  injectBedrockInferenceProfilePatterns(
    limitRegionsPolicy,
    props.bedrockInferenceProfilePatterns,
    props.hasBedrockInferenceProfilePatternsConditionId,
  );

  return convertToPolicyDocument(limitRegionsPolicy);
}

export function getInnovationSandboxWriteProtectionScp(
  props: IsbScpPolicyProps,
): PolicyDocument {
  const writeProtectionPolicy = loadPolicyFromFile(
    "isb-deny-all-non-control-plane-actions.json",
    props.namespace,
    props.isbManagedRegions,
    props.scpDirectoryPath,
  );
  return convertToPolicyDocument(writeProtectionPolicy);
}

/**
 * Builds the Allowed Services SCP content as a CloudFormation Fn::Join intrinsic.
 *
 * CDK's PolicyStatement validates NotAction entries at synth time, rejecting
 * unresolved CloudFormation tokens. AWS Organizations Policy Content property
 * also does not support intrinsic function resolution within the policy body.
 * This function constructs the SCP as a raw JSON string using Fn::Join/Fn::If
 * that CloudFormation resolves before passing to the Organizations API.
 *
 * @param namespace - The ISB namespace for principal ARN patterns
 * @param additionalServices - CDK token for the CommaDelimitedList parameter (valueAsList)
 * @param hasAdditionalServicesConditionId - Logical ID of the CfnCondition for empty check
 * @param additionalPrincipalExceptions - CDK token for the CommaDelimitedList parameter (valueAsList)
 * @param hasAdditionalPrincipalExceptionsConditionId - Logical ID of the CfnCondition for empty check
 * @returns A CloudFormation intrinsic object suitable for CfnPolicy.content
 */
export function getInnovationSandboxAwsNukeSupportedServicesScp(
  namespace: string,
  additionalServices: string[],
  hasAdditionalServicesConditionId: string,
  additionalPrincipalExceptions: string[],
  hasAdditionalPrincipalExceptionsConditionId: string,
  scpDirectoryPath?: string,
): Record<string, unknown> {
  const policy = loadPolicyFromFile(
    "isb-aws-nuke-supported-services-scp.json",
    namespace,
    undefined,
    scpDirectoryPath,
  );

  const statement = policy.Statement[0];
  if (!statement?.NotAction || !statement.Condition) {
    throw new Error(
      "Invalid Allowed Services SCP: missing NotAction or Condition in first statement",
    );
  }

  const baselineNotActionJson = statement.NotAction.map((action) =>
    JSON.stringify(action),
  ).join(",");
  const resourceJson = JSON.stringify(statement.Resource);

  const {
    conditionBlockStart,
    basePrincipalArnsJson,
    principalExceptionsFnIf,
    conditionBlockEnd,
  } = buildNukeScpConditionBlock(
    policy,
    additionalPrincipalExceptions,
    hasAdditionalPrincipalExceptionsConditionId,
  );

  return {
    "Fn::Join": [
      "",
      [
        `{"Version":"${policy.Version}","Statement":[{"Sid":"${statement.Sid}","Effect":"${statement.Effect}","NotAction":[`,
        baselineNotActionJson,
        {
          "Fn::If": [
            hasAdditionalServicesConditionId,
            {
              "Fn::Join": [
                "",
                [',"', { "Fn::Join": ['","', additionalServices] }, '"'],
              ],
            },
            "",
          ],
        },
        `],"Resource":${resourceJson},"Condition":`,
        conditionBlockStart,
        basePrincipalArnsJson,
        principalExceptionsFnIf,
        conditionBlockEnd,
        "}]}",
      ],
    ],
  };
}
