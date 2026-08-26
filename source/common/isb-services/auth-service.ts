// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import {
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
  DescribeUserPoolCommand,
  UpdateUserPoolClientCommand,
  UpdateUserPoolCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const logger = new Logger();

export class AuthService {
  private readonly cognitoIdpClient: CognitoIdentityProviderClient;

  constructor(props: { cognitoIdpClient: CognitoIdentityProviderClient }) {
    this.cognitoIdpClient = props.cognitoIdpClient;
  }

  /**
   * Attaches a Pre Token Generation V2_0 trigger to a Cognito User Pool.
   * Reads the current pool configuration first to preserve all existing settings,
   * since UpdateUserPool resets unspecified fields to defaults.
   */
  async attachPreTokenGenerationTrigger(props: {
    userPoolId: string;
    lambdaArn: string;
  }): Promise<void> {
    const { userPoolId, lambdaArn } = props;

    logger.info("Reading current User Pool configuration", { userPoolId });

    const describePoolResponse = await this.cognitoIdpClient.send(
      new DescribeUserPoolCommand({ UserPoolId: userPoolId }),
    );

    const currentPool = describePoolResponse.UserPool;
    if (!currentPool) {
      throw new Error(`User Pool ${userPoolId} not found`);
    }

    logger.info("Attaching Pre Token Generation trigger to User Pool", {
      userPoolId,
      lambdaArn,
    });

    // Remove V1 PreTokenGeneration if present — Cognito does not allow both V1 and V2 simultaneously
    const { PreTokenGeneration: _v1Removed, ...restLambdaConfig } =
      currentPool.LambdaConfig ?? {};

    await this.cognitoIdpClient.send(
      new UpdateUserPoolCommand({
        ...currentPool,
        UserPoolId: userPoolId,
        LambdaConfig: {
          ...restLambdaConfig,
          PreTokenGenerationConfig: {
            LambdaArn: lambdaArn,
            LambdaVersion: "V2_0",
          },
        },
      }),
    );

    logger.info("Pre Token Generation trigger attached successfully");
  }

  /**
   * Updates the callback and logout URLs on a Cognito App Client.
   * Reads the current client configuration first to preserve all existing settings,
   * since UpdateUserPoolClient resets unspecified fields to defaults.
   */
  async updateAppClientUrls(props: {
    userPoolId: string;
    appClientId: string;
    callbackUrls: string[];
    logoutUrls: string[];
  }): Promise<void> {
    const { userPoolId, appClientId, callbackUrls, logoutUrls } = props;

    if (callbackUrls.length === 0) {
      throw new Error("At least one callback URL is required");
    }

    if (logoutUrls.length === 0) {
      throw new Error("At least one logout URL is required");
    }

    logger.info("Reading current App Client configuration", {
      userPoolId,
      appClientId,
    });

    const describeResponse = await this.cognitoIdpClient.send(
      new DescribeUserPoolClientCommand({
        UserPoolId: userPoolId,
        ClientId: appClientId,
      }),
    );

    const currentClient = describeResponse.UserPoolClient;
    if (!currentClient) {
      throw new Error(
        `App Client ${appClientId} not found in User Pool ${userPoolId}`,
      );
    }

    logger.info("Updating App Client callback and logout URLs", {
      callbackUrls,
      logoutUrls,
    });

    await this.cognitoIdpClient.send(
      new UpdateUserPoolClientCommand({
        ...currentClient,
        UserPoolId: userPoolId,
        ClientId: appClientId,
        // Override URLs only
        CallbackURLs: callbackUrls,
        LogoutURLs: logoutUrls,
        DefaultRedirectURI: callbackUrls[0],
      }),
    );

    logger.info("App Client URLs updated successfully");
  }
}
