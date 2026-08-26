// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
  DescribeUserPoolCommand,
  UpdateUserPoolClientCommand,
  UpdateUserPoolCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { AuthService } from "@amzn/innovation-sandbox-commons/isb-services/auth-service.js";

const mockCognitoClient = mockClient(CognitoIdentityProviderClient);

const userPoolId = "us-east-1_TestPool";
const appClientId = "test-client-id";
const lambdaArn = "arn:aws:lambda:us-east-1:123456789012:function:PreTokenGen";

const describePoolResponse = {
  UserPool: {
    Id: userPoolId,
    Policies: {
      PasswordPolicy: {
        MinimumLength: 8,
        RequireUppercase: true,
        RequireLowercase: true,
        RequireNumbers: true,
        RequireSymbols: true,
      },
    },
    DeletionProtection: "ACTIVE" as const,
    AutoVerifiedAttributes: ["email" as const],
    MfaConfiguration: "OFF" as const,
    LambdaConfig: {},
    AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    VerificationMessageTemplate: {
      DefaultEmailOption: "CONFIRM_WITH_CODE" as const,
    },
    UserAttributeUpdateSettings: {
      AttributesRequireVerificationBeforeUpdate: ["email" as const],
    },
  },
};

const describeClientResponse = {
  UserPoolClient: {
    ClientId: appClientId,
    ClientName: "isb-web",
    ExplicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH" as const],
    SupportedIdentityProviders: ["IAMIdentityCenter"],
    AllowedOAuthFlows: ["code" as const],
    AllowedOAuthScopes: ["openid", "email", "profile"],
    AllowedOAuthFlowsUserPoolClient: true,
    AccessTokenValidity: 60,
    IdTokenValidity: 60,
    RefreshTokenValidity: 10080,
    TokenValidityUnits: {
      AccessToken: "minutes" as const,
      IdToken: "minutes" as const,
      RefreshToken: "minutes" as const,
    },
    PreventUserExistenceErrors: "ENABLED" as const,
    CallbackURLs: ["https://localhost/callback"],
    LogoutURLs: ["https://localhost/logout"],
  },
};

describe("AuthService", () => {
  const service = new AuthService({
    // aws-sdk-client-mock's AwsStub doesn't extend the real client type
    cognitoIdpClient:
      mockCognitoClient as unknown as CognitoIdentityProviderClient,
  });

  beforeEach(() => {
    mockCognitoClient.reset();
  });

  describe("attachPreTokenGenerationTrigger", () => {
    it("should describe pool then update with V2_0 trigger", async () => {
      mockCognitoClient
        .on(DescribeUserPoolCommand)
        .resolves(describePoolResponse);
      mockCognitoClient.on(UpdateUserPoolCommand).resolves({});

      await service.attachPreTokenGenerationTrigger({
        userPoolId,
        lambdaArn,
      });

      expect(
        mockCognitoClient.commandCalls(DescribeUserPoolCommand),
      ).toHaveLength(1);

      const updateCalls = mockCognitoClient.commandCalls(UpdateUserPoolCommand);
      expect(updateCalls).toHaveLength(1);

      const updateInput = updateCalls[0]!.args[0].input;
      expect(updateInput.LambdaConfig?.PreTokenGenerationConfig).toEqual({
        LambdaArn: lambdaArn,
        LambdaVersion: "V2_0",
      });
    });

    it("should preserve existing pool settings in update", async () => {
      mockCognitoClient
        .on(DescribeUserPoolCommand)
        .resolves(describePoolResponse);
      mockCognitoClient.on(UpdateUserPoolCommand).resolves({});

      await service.attachPreTokenGenerationTrigger({
        userPoolId,
        lambdaArn,
      });

      const updateInput = mockCognitoClient.commandCalls(
        UpdateUserPoolCommand,
      )[0]!.args[0].input;
      expect(updateInput).toMatchObject({
        UserPoolId: userPoolId,
        Policies: describePoolResponse.UserPool.Policies,
        DeletionProtection: describePoolResponse.UserPool.DeletionProtection,
        AutoVerifiedAttributes:
          describePoolResponse.UserPool.AutoVerifiedAttributes,
        MfaConfiguration: describePoolResponse.UserPool.MfaConfiguration,
        AdminCreateUserConfig:
          describePoolResponse.UserPool.AdminCreateUserConfig,
        VerificationMessageTemplate:
          describePoolResponse.UserPool.VerificationMessageTemplate,
        UserAttributeUpdateSettings:
          describePoolResponse.UserPool.UserAttributeUpdateSettings,
      });
    });

    it("should preserve existing LambdaConfig and merge trigger", async () => {
      const poolWithExistingTrigger = {
        UserPool: {
          ...describePoolResponse.UserPool,
          LambdaConfig: {
            PostConfirmation:
              "arn:aws:lambda:us-east-1:123456789012:function:PostConfirm",
          },
        },
      };
      mockCognitoClient
        .on(DescribeUserPoolCommand)
        .resolves(poolWithExistingTrigger);
      mockCognitoClient.on(UpdateUserPoolCommand).resolves({});

      await service.attachPreTokenGenerationTrigger({
        userPoolId,
        lambdaArn,
      });

      const updateInput = mockCognitoClient.commandCalls(
        UpdateUserPoolCommand,
      )[0]!.args[0].input;
      expect(updateInput.LambdaConfig).toEqual({
        PostConfirmation:
          "arn:aws:lambda:us-east-1:123456789012:function:PostConfirm",
        PreTokenGenerationConfig: {
          LambdaArn: lambdaArn,
          LambdaVersion: "V2_0",
        },
      });
    });

    it("should throw when User Pool not found", async () => {
      mockCognitoClient
        .on(DescribeUserPoolCommand)
        .resolves({ UserPool: undefined });

      await expect(
        service.attachPreTokenGenerationTrigger({ userPoolId, lambdaArn }),
      ).rejects.toThrow(`User Pool ${userPoolId} not found`);

      expect(
        mockCognitoClient.commandCalls(UpdateUserPoolCommand),
      ).toHaveLength(0);
    });
  });

  describe("updateAppClientUrls", () => {
    it("should describe client then update with new URLs", async () => {
      mockCognitoClient
        .on(DescribeUserPoolClientCommand)
        .resolves(describeClientResponse);
      mockCognitoClient.on(UpdateUserPoolClientCommand).resolves({});

      await service.updateAppClientUrls({
        userPoolId,
        appClientId,
        callbackUrls: ["https://example.com/callback"],
        logoutUrls: ["https://example.com/"],
      });

      expect(
        mockCognitoClient.commandCalls(DescribeUserPoolClientCommand),
      ).toHaveLength(1);

      const updateCalls = mockCognitoClient.commandCalls(
        UpdateUserPoolClientCommand,
      );
      expect(updateCalls).toHaveLength(1);

      const updateInput = updateCalls[0]!.args[0].input;
      expect(updateInput.CallbackURLs).toEqual([
        "https://example.com/callback",
      ]);
      expect(updateInput.LogoutURLs).toEqual(["https://example.com/"]);
    });

    it("should register multiple URLs and use the first callback as DefaultRedirectURI", async () => {
      mockCognitoClient
        .on(DescribeUserPoolClientCommand)
        .resolves(describeClientResponse);
      mockCognitoClient.on(UpdateUserPoolClientCommand).resolves({});

      await service.updateAppClientUrls({
        userPoolId,
        appClientId,
        callbackUrls: [
          "https://example.com/callback",
          "http://localhost:5173/callback",
        ],
        logoutUrls: ["https://d-1234567890.awsapps.com/start"],
      });

      const updateInput = mockCognitoClient.commandCalls(
        UpdateUserPoolClientCommand,
      )[0]!.args[0].input;
      expect(updateInput.CallbackURLs).toEqual([
        "https://example.com/callback",
        "http://localhost:5173/callback",
      ]);
      expect(updateInput.LogoutURLs).toEqual([
        "https://d-1234567890.awsapps.com/start",
      ]);
      expect(updateInput.DefaultRedirectURI).toEqual(
        "https://example.com/callback",
      );
    });

    it("should throw when no callback URLs are provided", async () => {
      await expect(
        service.updateAppClientUrls({
          userPoolId,
          appClientId,
          callbackUrls: [],
          logoutUrls: [],
        }),
      ).rejects.toThrow("At least one callback URL is required");

      expect(
        mockCognitoClient.commandCalls(DescribeUserPoolClientCommand),
      ).toHaveLength(0);
    });

    it("should throw when no logout URLs are provided", async () => {
      await expect(
        service.updateAppClientUrls({
          userPoolId,
          appClientId,
          callbackUrls: ["https://example.com/callback"],
          logoutUrls: [],
        }),
      ).rejects.toThrow("At least one logout URL is required");

      expect(
        mockCognitoClient.commandCalls(DescribeUserPoolClientCommand),
      ).toHaveLength(0);
    });

    it("should preserve existing client settings in update", async () => {
      mockCognitoClient
        .on(DescribeUserPoolClientCommand)
        .resolves(describeClientResponse);
      mockCognitoClient.on(UpdateUserPoolClientCommand).resolves({});

      await service.updateAppClientUrls({
        userPoolId,
        appClientId,
        callbackUrls: ["https://example.com/callback"],
        logoutUrls: ["https://example.com/"],
      });

      const updateInput = mockCognitoClient.commandCalls(
        UpdateUserPoolClientCommand,
      )[0]!.args[0].input;
      const {
        CallbackURLs: _cb,
        LogoutURLs: _lo,
        ...preserved
      } = describeClientResponse.UserPoolClient;
      expect(updateInput).toMatchObject(preserved);
    });

    it("should throw when App Client not found", async () => {
      mockCognitoClient
        .on(DescribeUserPoolClientCommand)
        .resolves({ UserPoolClient: undefined });

      await expect(
        service.updateAppClientUrls({
          userPoolId,
          appClientId,
          callbackUrls: ["https://example.com/callback"],
          logoutUrls: ["https://example.com/"],
        }),
      ).rejects.toThrow(
        `App Client ${appClientId} not found in User Pool ${userPoolId}`,
      );

      expect(
        mockCognitoClient.commandCalls(UpdateUserPoolClientCommand),
      ).toHaveLength(0);
    });
  });
});
