// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CostExplorerClient,
  UpdateCostAllocationTagsStatusCommand,
} from "@aws-sdk/client-cost-explorer";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import type {
  CloudFormationCustomResourceCreateEvent,
  CloudFormationCustomResourceDeleteEvent,
  CloudFormationCustomResourceUpdateEvent,
} from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TagActivationTriggerEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/tag-activation-trigger-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { mockContext } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { isbAccountTagKeys } from "@amzn/innovation-sandbox-commons/utils/isb-account-tags.js";
import { handler } from "@amzn/innovation-sandbox-tag-activation-trigger/tag-activation-trigger-handler.js";

const STATE_MACHINE_ARN =
  "arn:aws:states:us-east-1:123456789012:stateMachine:TagActivationWorkflow";

const sfnMock = mockClient(SFNClient);
const ceMock = mockClient(CostExplorerClient);

const NAMESPACE = "myisb";

const testEnv = generateSchemaData(TagActivationTriggerEnvironmentSchema, {
  ISB_NAMESPACE: NAMESPACE,
  STATE_MACHINE_ARN,
});

beforeEach(() => {
  bulkStubEnv(testEnv);
  sfnMock.reset();
  ceMock.reset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const baseEvent = {
  LogicalResourceId: "TagActivationTrigger",
  RequestId: "RequestId",
  ResourceProperties: { ServiceToken: "ServiceToken" },
  ResourceType: "Custom::TagActivationTrigger",
  ResponseURL: "ResponseURL",
  ServiceToken: "ServiceToken",
  StackId: "StackId",
};

const createEvent = (): CloudFormationCustomResourceCreateEvent => ({
  ...baseEvent,
  RequestType: "Create",
});

const updateEvent = (): CloudFormationCustomResourceUpdateEvent => ({
  ...baseEvent,
  RequestType: "Update",
  PhysicalResourceId: "IsbTagActivationTrigger",
  OldResourceProperties: { ServiceToken: "ServiceToken" },
});

const deleteEvent = (): CloudFormationCustomResourceDeleteEvent => ({
  ...baseEvent,
  RequestType: "Delete",
  PhysicalResourceId: "IsbTagActivationTrigger",
});

describe("tag-activation-trigger handler — Create / Update", () => {
  it("starts the activation workflow on Create and returns a stable PhysicalResourceId", async () => {
    sfnMock.on(StartExecutionCommand).resolves({});

    const result = await handler(createEvent(), mockContext(testEnv));

    expect(result).toEqual({ PhysicalResourceId: "IsbTagActivationTrigger" });
    const calls = sfnMock.commandCalls(StartExecutionCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({
      stateMachineArn: STATE_MACHINE_ARN,
    });
  });

  it("starts the activation workflow on Update and preserves the existing PhysicalResourceId", async () => {
    sfnMock.on(StartExecutionCommand).resolves({});

    const result = await handler(updateEvent(), mockContext(testEnv));

    expect(result).toEqual({ PhysicalResourceId: "IsbTagActivationTrigger" });
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(1);
  });

  it("swallows StartExecution failure so CloudFormation is never blocked", async () => {
    sfnMock.on(StartExecutionCommand).rejects(new Error("boom"));

    const result = await handler(createEvent(), mockContext(testEnv));

    expect(result).toEqual({ PhysicalResourceId: "IsbTagActivationTrigger" });
  });
});

describe("tag-activation-trigger handler — Delete", () => {
  it("deactivates all 5 ISB tag keys with the accountTag/ prefix", async () => {
    ceMock.on(UpdateCostAllocationTagsStatusCommand).resolves({});

    const result = await handler(deleteEvent(), mockContext(testEnv));

    expect(result).toEqual({ PhysicalResourceId: "IsbTagActivationTrigger" });

    const calls = ceMock.commandCalls(UpdateCostAllocationTagsStatusCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.CostAllocationTagsStatus).toEqual(
      isbAccountTagKeys(NAMESPACE).map((key) => ({
        TagKey: `accountTag/${key}`,
        Status: "Inactive",
      })),
    );
  });

  it("swallows CE deactivation failure so stack deletion is never blocked", async () => {
    ceMock.on(UpdateCostAllocationTagsStatusCommand).rejects(new Error("boom"));

    const result = await handler(deleteEvent(), mockContext(testEnv));

    expect(result).toEqual({ PhysicalResourceId: "IsbTagActivationTrigger" });
  });
});
