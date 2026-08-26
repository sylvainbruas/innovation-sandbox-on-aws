// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BatchGetBuildsCommand,
  CodeBuildClient,
} from "@aws-sdk/client-codebuild";
import {
  LambdaClient,
  SendDurableExecutionCallbackFailureCommand,
  SendDurableExecutionCallbackSuccessCommand,
} from "@aws-sdk/client-lambda";
import { mockClient } from "aws-sdk-client-mock";

import { handler } from "@amzn/innovation-sandbox-callback-relay/callback-relay-handler.js";

const codeBuildClient = mockClient(CodeBuildClient);
const lambdaClient = mockClient(LambdaClient);

function createEvent(buildStatus: string, buildId = "project:build-123") {
  return {
    id: "test-id",
    version: "0",
    account: "123456789012",
    time: "2026-01-01T00:00:00Z",
    region: "us-east-1",
    source: "aws.codebuild",
    resources: [],
    "detail-type": "CodeBuild Build State Change" as const,
    detail: {
      "build-status": buildStatus,
      "project-name": "cleanup-project",
      "build-id": buildId,
    },
  };
}

function mockBuildWithCallbackId(callbackId: string) {
  codeBuildClient.on(BatchGetBuildsCommand).resolves({
    builds: [
      {
        id: "project:build-123",
        environment: {
          type: "LINUX_CONTAINER",
          image: "aws/codebuild/standard:7.0",
          computeType: "BUILD_GENERAL1_SMALL",
          environmentVariables: [
            { name: "CLEANUP_ACCOUNT_ID", value: "123456789012" },
            { name: "DURABLE_CALLBACK_ID", value: callbackId },
          ],
        },
      },
    ],
  });
}

function mockBuildWithoutCallbackId() {
  codeBuildClient.on(BatchGetBuildsCommand).resolves({
    builds: [
      {
        id: "project:build-123",
        environment: {
          type: "LINUX_CONTAINER",
          image: "aws/codebuild/standard:7.0",
          computeType: "BUILD_GENERAL1_SMALL",
          environmentVariables: [
            { name: "CLEANUP_ACCOUNT_ID", value: "123456789012" },
          ],
        },
      },
    ],
  });
}

beforeEach(() => {
  vi.stubEnv("NODE_OPTIONS", "--enable-source-maps");
  vi.stubEnv("USER_AGENT_EXTRA", "test-agent");
  vi.stubEnv("POWERTOOLS_LOG_LEVEL", "INFO");
  vi.stubEnv("POWERTOOLS_SERVICE_NAME", "test");
  vi.stubEnv("AWS_XRAY_CONTEXT_MISSING", "IGNORE_ERROR");

  codeBuildClient.reset();
  lambdaClient.reset();
  lambdaClient.on(SendDurableExecutionCallbackSuccessCommand).resolves({});
  lambdaClient.on(SendDurableExecutionCallbackFailureCommand).resolves({});
});

afterEach(() => {
  vi.unstubAllEnvs();
  codeBuildClient.reset();
  lambdaClient.reset();
});

describe("Callback Relay Handler", () => {
  it("should send callback success for SUCCEEDED builds", async () => {
    mockBuildWithCallbackId("test-callback-id");

    await handler(createEvent("SUCCEEDED"));

    const successCalls = lambdaClient.commandCalls(
      SendDurableExecutionCallbackSuccessCommand,
    );
    expect(successCalls).toHaveLength(1);
    expect(successCalls[0]!.args[0].input.CallbackId).toBe("test-callback-id");
  });

  it("should send callback failure for FAILED builds", async () => {
    mockBuildWithCallbackId("test-callback-id");

    await handler(createEvent("FAILED"));

    const failureCalls = lambdaClient.commandCalls(
      SendDurableExecutionCallbackFailureCommand,
    );
    expect(failureCalls).toHaveLength(1);
    expect(failureCalls[0]!.args[0].input.CallbackId).toBe("test-callback-id");
    expect(failureCalls[0]!.args[0].input.Error?.ErrorType).toBe(
      "CodeBuildFailure",
    );
  });

  it("should send callback failure for FAULT builds", async () => {
    mockBuildWithCallbackId("test-callback-id");

    await handler(createEvent("FAULT"));

    expect(
      lambdaClient.commandCalls(SendDurableExecutionCallbackFailureCommand),
    ).toHaveLength(1);
  });

  it("should send callback failure for STOPPED builds", async () => {
    mockBuildWithCallbackId("test-callback-id");

    await handler(createEvent("STOPPED"));

    expect(
      lambdaClient.commandCalls(SendDurableExecutionCallbackFailureCommand),
    ).toHaveLength(1);
  });

  it("should send callback failure for TIMED_OUT builds", async () => {
    mockBuildWithCallbackId("test-callback-id");

    await handler(createEvent("TIMED_OUT"));

    expect(
      lambdaClient.commandCalls(SendDurableExecutionCallbackFailureCommand),
    ).toHaveLength(1);
  });

  it("should skip builds without DURABLE_CALLBACK_ID", async () => {
    mockBuildWithoutCallbackId();

    await handler(createEvent("SUCCEEDED"));

    expect(
      lambdaClient.commandCalls(SendDurableExecutionCallbackSuccessCommand),
    ).toHaveLength(0);
    expect(
      lambdaClient.commandCalls(SendDurableExecutionCallbackFailureCommand),
    ).toHaveLength(0);
  });

  it("should handle build not found gracefully", async () => {
    codeBuildClient.on(BatchGetBuildsCommand).resolves({ builds: [] });

    await handler(createEvent("SUCCEEDED"));

    expect(
      lambdaClient.commandCalls(SendDurableExecutionCallbackSuccessCommand),
    ).toHaveLength(0);
  });
});
