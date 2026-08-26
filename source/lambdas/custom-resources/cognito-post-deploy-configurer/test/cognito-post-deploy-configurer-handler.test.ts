// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { CdkCustomResourceEvent } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handler } from "@amzn/innovation-sandbox-cognito-post-deploy-configurer/cognito-post-deploy-configurer-handler.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { CognitoPostDeployEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/cognito-post-deploy-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { mockContext } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";

const testEnv = generateSchemaData(CognitoPostDeployEnvironmentSchema);

const mockAttachPreTokenGenerationTrigger = vi.fn();
const mockUpdateAppClientUrls = vi.fn();

vi.spyOn(IsbServices, "authService").mockReturnValue({
  attachPreTokenGenerationTrigger: mockAttachPreTokenGenerationTrigger,
  updateAppClientUrls: mockUpdateAppClientUrls,
} as any);

const baseResourceProperties = {
  ServiceToken: "ServiceToken",
  UserPoolId: "us-east-1_TestPool",
  AppClientId: "test-client-id",
  PreTokenGenLambdaArn:
    "arn:aws:lambda:us-east-1:123456789012:function:PreTokenGen",
  CallbackUrls: ["https://example.com/callback"],
  LogoutUrls: ["https://example.com/"],
};

beforeEach(() => {
  bulkStubEnv(testEnv);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("cognito-post-deploy-configurer handler", () => {
  it("should attach trigger and update URLs on Create", async () => {
    const event: CdkCustomResourceEvent = {
      LogicalResourceId: "LogicalResourceId",
      RequestId: "RequestId",
      RequestType: "Create",
      ResourceProperties: baseResourceProperties,
      ResourceType: "Custom::CognitoPostDeployConfigurer",
      ResponseURL: "ResponseURL",
      ServiceToken: "ServiceToken",
      StackId: "StackId",
    };

    const result = await handler(event, mockContext(testEnv));

    expect(mockAttachPreTokenGenerationTrigger).toHaveBeenCalledWith({
      userPoolId: "us-east-1_TestPool",
      lambdaArn: "arn:aws:lambda:us-east-1:123456789012:function:PreTokenGen",
    });
    expect(mockUpdateAppClientUrls).toHaveBeenCalledWith({
      userPoolId: "us-east-1_TestPool",
      appClientId: "test-client-id",
      callbackUrls: ["https://example.com/callback"],
      logoutUrls: ["https://example.com/"],
    });
    expect(result).toMatchObject({
      PhysicalResourceId: "cognito-post-deploy-us-east-1_TestPool",
      Data: {
        Status: "SUCCESS",
        CallbackUrls: ["https://example.com/callback"],
        LogoutUrls: ["https://example.com/"],
      },
    });
  });

  it("should attach trigger and update URLs on Update", async () => {
    const event: CdkCustomResourceEvent = {
      LogicalResourceId: "LogicalResourceId",
      OldResourceProperties: { ServiceToken: "ServiceToken" },
      PhysicalResourceId: "cognito-post-deploy-us-east-1_TestPool",
      RequestId: "RequestId",
      RequestType: "Update",
      ResourceProperties: baseResourceProperties,
      ResourceType: "Custom::CognitoPostDeployConfigurer",
      ResponseURL: "ResponseURL",
      ServiceToken: "ServiceToken",
      StackId: "StackId",
    };

    const result = await handler(event, mockContext(testEnv));

    expect(mockAttachPreTokenGenerationTrigger).toHaveBeenCalledOnce();
    expect(mockUpdateAppClientUrls).toHaveBeenCalledOnce();
    expect(result.Data.Status).toBe("SUCCESS");
  });

  it("should retain configuration on Delete", async () => {
    const event: CdkCustomResourceEvent = {
      LogicalResourceId: "LogicalResourceId",
      RequestId: "RequestId",
      RequestType: "Delete",
      ResourceProperties: baseResourceProperties,
      ResourceType: "Custom::CognitoPostDeployConfigurer",
      ResponseURL: "ResponseURL",
      ServiceToken: "ServiceToken",
      StackId: "StackId",
      PhysicalResourceId: "cognito-post-deploy-us-east-1_TestPool",
    };

    const result = await handler(event, mockContext(testEnv));

    expect(mockAttachPreTokenGenerationTrigger).not.toHaveBeenCalled();
    expect(mockUpdateAppClientUrls).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      PhysicalResourceId: "cognito-post-deploy-us-east-1_TestPool",
      Data: { Status: "RETAINED" },
    });
  });

  it("should propagate error when trigger attachment fails", async () => {
    mockAttachPreTokenGenerationTrigger.mockRejectedValue(
      new Error("User Pool us-east-1_TestPool not found"),
    );

    const event: CdkCustomResourceEvent = {
      LogicalResourceId: "LogicalResourceId",
      RequestId: "RequestId",
      RequestType: "Create",
      ResourceProperties: baseResourceProperties,
      ResourceType: "Custom::CognitoPostDeployConfigurer",
      ResponseURL: "ResponseURL",
      ServiceToken: "ServiceToken",
      StackId: "StackId",
    };

    await expect(handler(event, mockContext(testEnv))).rejects.toThrow(
      "User Pool us-east-1_TestPool not found",
    );
  });

  it("should propagate error when URL update fails", async () => {
    mockAttachPreTokenGenerationTrigger.mockResolvedValue(undefined);
    mockUpdateAppClientUrls.mockRejectedValue(
      new Error(
        "App Client test-client-id not found in User Pool us-east-1_TestPool",
      ),
    );

    const event: CdkCustomResourceEvent = {
      LogicalResourceId: "LogicalResourceId",
      RequestId: "RequestId",
      RequestType: "Create",
      ResourceProperties: baseResourceProperties,
      ResourceType: "Custom::CognitoPostDeployConfigurer",
      ResponseURL: "ResponseURL",
      ServiceToken: "ServiceToken",
      StackId: "StackId",
    };

    await expect(handler(event, mockContext(testEnv))).rejects.toThrow(
      "App Client test-client-id not found",
    );
  });
});
