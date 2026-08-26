// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cognito Pre Token Generation V2_0 trigger event types.
 * V2_0 is required for access token customization.
 *
 * These types are defined here because @types/aws-lambda (as of v8.10.161)
 * only includes V1 types (claimsOverrideDetails). V2 types
 * (claimsAndScopeOverrideDetails with separate idTokenGeneration and
 * accessTokenGeneration) have not been added to the community package yet.
 *
 * @see https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-pre-token-generation.html
 */

export interface PreTokenGenerationV2Event {
  version: string;
  triggerSource:
    | "TokenGeneration_HostedAuth"
    | "TokenGeneration_Authentication"
    | "TokenGeneration_NewPasswordChallenge"
    | "TokenGeneration_AuthenticateDevice"
    | "TokenGeneration_RefreshTokens";
  region: string;
  userPoolId: string;
  userName: string;
  callerContext: {
    awsSdkVersion: string;
    clientId: string;
  };
  request: {
    userAttributes: Record<string, string>;
    groupConfiguration: {
      groupsToOverride?: string[];
      iamRolesToOverride?: string[];
      preferredRole?: string;
    };
    scopes?: string[];
  };
  response: PreTokenGenerationV2Response;
}

export interface PreTokenGenerationV2Response {
  claimsAndScopeOverrideDetails: {
    idTokenGeneration?: {
      claimsToAddOrOverride?: Record<string, string>;
      claimsToSuppress?: string[];
    };
    accessTokenGeneration?: {
      claimsToAddOrOverride?: Record<string, string>;
      claimsToSuppress?: string[];
      scopesToAdd?: string[];
      scopesToSuppress?: string[];
    };
    groupOverrideDetails?: {
      groupsToOverride?: string[];
      iamRolesToOverride?: string[];
      preferredRole?: string;
    };
  };
}
