// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DynamoSandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/dynamo-sandbox-account-store.js";

const mockDynamoClient = mockClient(DynamoDBDocumentClient);

describe("DynamoSandboxAccountStore - update()", () => {
  let store: DynamoSandboxAccountStore;
  const tableName = "test-account-table";

  beforeEach(() => {
    mockDynamoClient.reset();
    store = new DynamoSandboxAccountStore({
      accountTableName: tableName,
      client: mockDynamoClient as unknown as DynamoDBDocumentClient,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  describe("SET-only params", () => {
    test("builds correct UpdateExpression with SET clause", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      await store.update("123456789012", {
        set: { status: "CleanUp" },
      });

      const calls = mockDynamoClient.commandCalls(UpdateCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]!.args[0].input;
      expect(input.UpdateExpression).toBe(
        "SET #meta.#lastEditTime = :lastEditTime, #status = :status",
      );
    });

    test("includes correct ExpressionAttributeNames for SET fields", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      await store.update("123456789012", {
        set: { status: "Active", name: "my-sandbox" },
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      expect(input.ExpressionAttributeNames).toEqual({
        "#meta": "meta",
        "#lastEditTime": "lastEditTime",
        "#status": "status",
        "#name": "name",
      });
    });

    test("includes correct ExpressionAttributeValues for SET fields", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      await store.update("123456789012", {
        set: { status: "Active" },
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      expect(input.ExpressionAttributeValues).toEqual({
        ":lastEditTime": "2024-06-01T12:00:00.000Z",
        ":status": "Active",
      });
    });
  });

  describe("REMOVE-only params", () => {
    test("builds correct UpdateExpression with REMOVE clause", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      await store.update("123456789012", {
        remove: ["activeCleanup"],
      });

      const calls = mockDynamoClient.commandCalls(UpdateCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]!.args[0].input;
      expect(input.UpdateExpression).toBe(
        "SET #meta.#lastEditTime = :lastEditTime REMOVE #activeCleanup",
      );
    });

    test("includes correct ExpressionAttributeNames for REMOVE fields", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      await store.update("123456789012", {
        remove: ["activeCleanup", "driftAtLastScan"],
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      expect(input.ExpressionAttributeNames).toEqual({
        "#meta": "meta",
        "#lastEditTime": "lastEditTime",
        "#activeCleanup": "activeCleanup",
        "#driftAtLastScan": "driftAtLastScan",
      });
    });

    test("REMOVE expression lists all fields to remove", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      await store.update("123456789012", {
        remove: ["activeCleanup", "cleanupExecutionContext"],
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      expect(input.UpdateExpression).toContain(
        "REMOVE #activeCleanup, #cleanupExecutionContext",
      );
    });
  });

  describe("SET + REMOVE combined", () => {
    test("builds UpdateExpression with both SET and REMOVE clauses", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      await store.update("123456789012", {
        set: { status: "Available" },
        remove: ["activeCleanup"],
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      expect(input.UpdateExpression).toBe(
        "SET #meta.#lastEditTime = :lastEditTime, #status = :status REMOVE #activeCleanup",
      );
    });
  });

  describe("meta.lastEditTime always included", () => {
    test("SET expression always includes meta.lastEditTime even with no set params", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      await store.update("123456789012", {
        remove: ["activeCleanup"],
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      expect(input.UpdateExpression).toContain(
        "SET #meta.#lastEditTime = :lastEditTime",
      );
      expect(input.ExpressionAttributeValues![":lastEditTime"]).toBe(
        "2024-06-01T12:00:00.000Z",
      );
    });

    test("meta.lastEditTime uses current timestamp", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      await store.update("123456789012", {
        set: { status: "CleanUp" },
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      expect(input.ExpressionAttributeValues![":lastEditTime"]).toBe(
        "2024-06-01T12:00:00.000Z",
      );
    });
  });

  describe("null values stored as DynamoDB NULL", () => {
    test("undefined value in set is stored as null (via value ?? null)", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      await store.update("123456789012", {
        set: { cleanupExecutionContext: undefined },
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      expect(
        input.ExpressionAttributeValues![":cleanupExecutionContext"],
      ).toBeNull();
    });
  });

  describe("ConditionExpression", () => {
    test("uses attribute_exists(awsAccountId) condition", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      await store.update("123456789012", {
        set: { status: "Active" },
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      expect(input.ConditionExpression).toBe("attribute_exists(awsAccountId)");
    });
  });

  describe("ConditionalCheckFailedException propagation", () => {
    test("propagates ConditionalCheckFailedException when account does not exist", async () => {
      mockDynamoClient.on(UpdateCommand).rejects(
        new ConditionalCheckFailedException({
          message: "The conditional request failed",
          $metadata: {},
        }),
      );

      await expect(
        store.update("999999999999", { set: { status: "Active" } }),
      ).rejects.toThrow(ConditionalCheckFailedException);
    });
  });

  describe("table name and key structure", () => {
    test("uses correct TableName from constructor", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      await store.update("123456789012", {
        set: { status: "Active" },
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      expect(input.TableName).toBe(tableName);
    });

    test("uses awsAccountId as the partition key", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      await store.update("111222333444", {
        set: { status: "CleanUp" },
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      expect(input.Key).toEqual({ awsAccountId: "111222333444" });
    });
  });

  describe("complex SET values", () => {
    test("stores activeCleanup object correctly", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      const activeCleanup = {
        status: "NUKE_PHASE_1" as const,
        executionArn:
          "arn:aws:states:us-east-1:123456789012:execution:cleanup:exec-1",
        startedAt: "2024-06-01T12:00:00.000Z",
      };

      await store.update("123456789012", {
        set: { activeCleanup },
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      expect(input.ExpressionAttributeValues![":activeCleanup"]).toEqual(
        activeCleanup,
      );
    });
  });
});
