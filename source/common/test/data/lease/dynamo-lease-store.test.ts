// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  BatchUnprocessedItemsError,
  ResourceLockConflictError,
} from "@amzn/innovation-sandbox-commons/data/errors.js";
import { DynamoLeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/dynamo-lease-store.js";
import {
  LeaseKey,
  PendingLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";

import { randomUUID } from "node:crypto";

const mockDynamoClient = mockClient(DynamoDBDocumentClient);

const NOW = "2024-06-01T12:00:00.000Z";
const TABLE_NAME = "test-lease-table";
const USER_EMAIL = "user@example.com";
const LEASE_ID = "550e8400-e29b-41d4-a716-446655440000";
const OWNER_ID = "owner-1";

const conditionalCheckFailed = new ConditionalCheckFailedException({
  message: "The conditional request failed",
  $metadata: {},
});

describe("DynamoLeaseStore", () => {
  let store: DynamoLeaseStore;

  beforeEach(() => {
    mockDynamoClient.reset();
    store = new DynamoLeaseStore({
      leaseTableName: TABLE_NAME,
      client: mockDynamoClient as any,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  describe("acquireLock()", () => {
    test("builds correct UpdateCommand without critical override", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      await store.acquireLock({
        leaseId: LEASE_ID,
        userEmail: USER_EMAIL,
        ownerId: OWNER_ID,
        timeoutSeconds: 300,
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;

      // Override clause absent when no intent is supplied at all
      expect(input.ConditionExpression).not.toContain("resourceLock.meta");
      expect(input.ExpressionAttributeValues).not.toHaveProperty(":terminate");
      expect(input.ExpressionAttributeValues).not.toHaveProperty(":freeze");
    });

    test("TERMINATE is blocked only by another termination, so it preempts a freeze", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      await store.acquireLock({
        leaseId: LEASE_ID,
        userEmail: USER_EMAIL,
        ownerId: OWNER_ID,
        timeoutSeconds: 900,
        meta: { intent: "TERMINATE" },
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;

      // Only :terminate is in the blocking set — terminate is the escape hatch
      // and must not be stopped by an in-flight freeze.
      expect(input.ConditionExpression).toContain(
        "OR (attribute_not_exists(resourceLock.meta.intent) OR NOT resourceLock.meta.intent IN (:terminate))",
      );
      expect(input.ExpressionAttributeValues).toMatchObject({
        ":terminate": "TERMINATE",
      });
      // DynamoDB rejects unused ExpressionAttributeValues, so :freeze must not
      // be declared when the expression does not reference it.
      expect(input.ExpressionAttributeValues).not.toHaveProperty(":freeze");
    });

    test("FREEZE is blocked by a termination or another freeze", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      await store.acquireLock({
        leaseId: LEASE_ID,
        userEmail: USER_EMAIL,
        ownerId: OWNER_ID,
        timeoutSeconds: 900,
        meta: { intent: "FREEZE" },
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;

      expect(input.ConditionExpression).toContain(
        "OR (attribute_not_exists(resourceLock.meta.intent) OR NOT resourceLock.meta.intent IN (:terminate, :freeze))",
      );
      expect(input.ExpressionAttributeValues).toMatchObject({
        ":terminate": "TERMINATE",
        ":freeze": "FREEZE",
      });
    });

    test.each(["UPDATE", "PUBLISH", "UNFREEZE"] as const)(
      "%s gets no override clause, so any live lock blocks it",
      async (intent) => {
        mockDynamoClient.on(UpdateCommand).resolves({});

        await store.acquireLock({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ownerId: OWNER_ID,
          timeoutSeconds: 300,
          meta: { intent },
        });

        const input =
          mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;

        expect(input.ConditionExpression).not.toContain("resourceLock.meta");
        expect(input.ExpressionAttributeValues).not.toHaveProperty(
          ":terminate",
        );
      },
    );

    test("returns the persisted lock so callers can carry it onto a full-item put", async () => {
      // update()/transactionalUpdate() replace the whole item, so a caller that
      // holds this lock must write it back or the put erases it.
      mockDynamoClient.on(UpdateCommand).resolves({});

      const lock = await store.acquireLock({
        leaseId: LEASE_ID,
        userEmail: USER_EMAIL,
        ownerId: OWNER_ID,
        timeoutSeconds: 900,
        meta: { intent: "FREEZE" },
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      expect(lock).toEqual(input.ExpressionAttributeValues![":lock"]);
      expect(lock).toEqual({
        ownerId: OWNER_ID,
        acquiredAt: NOW,
        expiresAt: "2024-06-01T12:15:00.000Z",
        meta: { intent: "FREEZE" },
      });
    });

    test("maps ConditionalCheckFailedException to ResourceLockConflictError", async () => {
      mockDynamoClient.on(UpdateCommand).rejects(conditionalCheckFailed);

      await expect(
        store.acquireLock({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ownerId: OWNER_ID,
          timeoutSeconds: 300,
        }),
      ).rejects.toThrow(ResourceLockConflictError);
    });

    test("propagates non-conditional errors", async () => {
      mockDynamoClient
        .on(UpdateCommand)
        .rejects(new Error("ServiceUnavailable"));

      await expect(
        store.acquireLock({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ownerId: OWNER_ID,
          timeoutSeconds: 300,
        }),
      ).rejects.toThrow("ServiceUnavailable");
    });
  });

  describe("acquireLockWithDesiredAssignments()", () => {
    const desiredAssignments = [
      {
        principalId: "a0b1c2d3-e4f5-6789-abcd-ef0123456789",
        principalType: "USER" as const,
        displayName: "Alice Smith",
        email: "alice@example.com",
      },
    ];

    async function acquireWithDesired(meta?: {
      intent: "UPDATE" | "PUBLISH" | "FREEZE" | "UNFREEZE" | "TERMINATE";
    }) {
      mockDynamoClient.on(UpdateCommand).resolves({});
      const lock = await store.acquireLockWithDesiredAssignments({
        leaseId: LEASE_ID,
        userEmail: USER_EMAIL,
        ownerId: OWNER_ID,
        timeoutSeconds: 900,
        desiredAssignments,
        meta,
      });
      return {
        lock,
        input: mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input,
      };
    }

    test("writes the lock and the desired set in one update", async () => {
      const { input } = await acquireWithDesired({ intent: "UPDATE" });

      // Both attributes must land in the same conditional write — that
      // atomicity is the point of this method existing alongside acquireLock.
      expect(input.UpdateExpression).toBe(
        "SET resourceLock = :lock, desiredAssignments = :desiredAssignments",
      );
      expect(input.ExpressionAttributeValues).toHaveProperty(":lock");
      expect(input.ExpressionAttributeValues![":desiredAssignments"]).toEqual(
        desiredAssignments,
      );
    });

    test("returns the persisted lock so callers can carry it onto a full-item put", async () => {
      const { lock, input } = await acquireWithDesired({ intent: "FREEZE" });

      expect(lock).toEqual(input.ExpressionAttributeValues![":lock"]);
      expect(lock).toEqual({
        ownerId: OWNER_ID,
        acquiredAt: NOW,
        expiresAt: "2024-06-01T12:15:00.000Z",
        meta: { intent: "FREEZE" },
      });
    });

    test.each([
      "TERMINATE",
      "FREEZE",
      "UPDATE",
      "PUBLISH",
      "UNFREEZE",
    ] as const)(
      "builds the same condition as acquireLock for %s",
      async (intent) => {
        // Both paths share buildLockAcquisitionCondition. Asserting they agree
        // is what stops one from silently reverting to a hand-rolled condition.
        const { input: withDesired } = await acquireWithDesired({ intent });

        mockDynamoClient.reset();
        mockDynamoClient.on(UpdateCommand).resolves({});
        await store.acquireLock({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ownerId: OWNER_ID,
          timeoutSeconds: 900,
          meta: { intent },
        });
        const lockOnly =
          mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;

        expect(withDesired.ConditionExpression).toBe(
          lockOnly.ConditionExpression,
        );
        // Same intent placeholders, and no extras that DynamoDB would reject.
        const intentValues = (i: Record<string, unknown>) =>
          Object.fromEntries(
            Object.entries(i).filter(
              ([k]) => k !== ":lock" && k !== ":desiredAssignments",
            ),
          );
        expect(intentValues(withDesired.ExpressionAttributeValues!)).toEqual(
          intentValues(lockOnly.ExpressionAttributeValues!),
        );
      },
    );

    test("maps ConditionalCheckFailedException to ResourceLockConflictError", async () => {
      mockDynamoClient.on(UpdateCommand).rejects(conditionalCheckFailed);

      await expect(
        store.acquireLockWithDesiredAssignments({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ownerId: OWNER_ID,
          timeoutSeconds: 300,
          desiredAssignments,
        }),
      ).rejects.toThrow(ResourceLockConflictError);
    });

    test("propagates non-conditional errors", async () => {
      mockDynamoClient
        .on(UpdateCommand)
        .rejects(new Error("ProvisionedThroughputExceeded"));

      await expect(
        store.acquireLockWithDesiredAssignments({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ownerId: OWNER_ID,
          timeoutSeconds: 300,
          desiredAssignments,
        }),
      ).rejects.toThrow("ProvisionedThroughputExceeded");
    });

    test("rejects a desired assignment that fails schema validation", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      await expect(
        store.acquireLockWithDesiredAssignments({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ownerId: OWNER_ID,
          timeoutSeconds: 300,
          desiredAssignments: [
            {
              principalId: "a0b1c2d3-e4f5-6789-abcd-ef0123456789",
              principalType: "USER",
              email: "not-an-email",
            },
          ],
        }),
      ).rejects.toThrow();
      // Validation must happen before the write, not after.
      expect(mockDynamoClient.commandCalls(UpdateCommand)).toHaveLength(0);
    });
  });

  describe("releaseLock()", () => {
    test("no-ops on ConditionalCheckFailedException (lock held by different owner or item missing)", async () => {
      mockDynamoClient.on(UpdateCommand).rejects(conditionalCheckFailed);

      await expect(
        store.releaseLock({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ownerId: OWNER_ID,
        }),
      ).resolves.toBeUndefined();
    });

    test("propagates non-conditional errors", async () => {
      mockDynamoClient
        .on(UpdateCommand)
        .rejects(new Error("InternalServerError"));

      await expect(
        store.releaseLock({
          leaseId: LEASE_ID,
          userEmail: USER_EMAIL,
          ownerId: OWNER_ID,
        }),
      ).rejects.toThrow("InternalServerError");
    });
  });

  describe("get()", () => {
    test("should pass ConsistentRead: true when consistentRead option is set", async () => {
      mockDynamoClient.on(GetCommand).resolves({ Item: undefined });

      await store.get(
        { userEmail: USER_EMAIL, uuid: LEASE_ID },
        { consistentRead: true },
      );

      const calls = mockDynamoClient.commandCalls(GetCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0].input.ConsistentRead).toBe(true);
    });

    test("should not set ConsistentRead when option is not provided", async () => {
      mockDynamoClient.on(GetCommand).resolves({ Item: undefined });

      await store.get({ userEmail: USER_EMAIL, uuid: LEASE_ID });

      const calls = mockDynamoClient.commandCalls(GetCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0].input.ConsistentRead).toBeUndefined();
    });
  });

  describe("batchGet()", () => {
    function makeLease(overrides: Partial<LeaseKey> = {}) {
      return generateSchemaData(PendingLeaseSchema, {
        status: "PendingApproval",
        userEmail: overrides.userEmail ?? USER_EMAIL,
        uuid: overrides.uuid ?? LEASE_ID,
      });
    }

    test("returns empty array without calling DynamoDB when keys is empty", async () => {
      const result = await store.batchGet([]);
      expect(result).toEqual([]);
      expect(mockDynamoClient.commandCalls(BatchGetCommand)).toHaveLength(0);
    });

    test("issues a single BatchGetCommand for keys within the chunk size", async () => {
      const lease1 = makeLease({
        userEmail: "a@example.com",
        uuid: randomUUID(),
      });
      const lease2 = makeLease({
        userEmail: "b@example.com",
        uuid: randomUUID(),
      });
      mockDynamoClient.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [lease1, lease2] },
      });

      const result = await store.batchGet([
        { userEmail: lease1.userEmail, uuid: lease1.uuid },
        { userEmail: lease2.userEmail, uuid: lease2.uuid },
      ]);

      expect(result).toHaveLength(2);
      expect(result.map((l) => l.uuid).sort()).toEqual(
        [lease1.uuid, lease2.uuid].sort(),
      );

      const calls = mockDynamoClient.commandCalls(BatchGetCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0].input.RequestItems?.[TABLE_NAME]?.Keys).toEqual([
        { userEmail: lease1.userEmail, uuid: lease1.uuid },
        { userEmail: lease2.userEmail, uuid: lease2.uuid },
      ]);
    });

    test("deduplicates input keys before calling BatchGet", async () => {
      const lease = makeLease();
      mockDynamoClient.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [lease] },
      });

      await store.batchGet([
        { userEmail: lease.userEmail, uuid: lease.uuid },
        { userEmail: lease.userEmail, uuid: lease.uuid },
      ]);

      const calls = mockDynamoClient.commandCalls(BatchGetCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0].input.RequestItems?.[TABLE_NAME]?.Keys).toEqual([
        { userEmail: lease.userEmail, uuid: lease.uuid },
      ]);
    });

    test("chunks at 100 keys", async () => {
      const leases = Array.from({ length: 105 }, (_, i) =>
        makeLease({
          userEmail: `u${i}@example.com`,
          uuid: randomUUID(),
        }),
      );
      mockDynamoClient
        .on(BatchGetCommand)
        .callsFakeOnce(() => ({
          Responses: { [TABLE_NAME]: leases.slice(0, 100) },
        }))
        .callsFakeOnce(() => ({
          Responses: { [TABLE_NAME]: leases.slice(100) },
        }));

      const result = await store.batchGet(
        leases.map((l) => ({ userEmail: l.userEmail, uuid: l.uuid })),
      );

      expect(result).toHaveLength(105);
      const calls = mockDynamoClient.commandCalls(BatchGetCommand);
      expect(calls).toHaveLength(2);
      expect(
        calls[0]!.args[0].input.RequestItems?.[TABLE_NAME]?.Keys,
      ).toHaveLength(100);
      expect(
        calls[1]!.args[0].input.RequestItems?.[TABLE_NAME]?.Keys,
      ).toHaveLength(5);
    });

    test("retries unprocessed keys until they succeed", async () => {
      vi.useRealTimers(); // backOff uses real setTimeout
      const lease1 = makeLease({
        userEmail: "a@example.com",
        uuid: randomUUID(),
      });
      const lease2 = makeLease({
        userEmail: "b@example.com",
        uuid: randomUUID(),
      });

      mockDynamoClient
        .on(BatchGetCommand)
        .callsFakeOnce(() => ({
          Responses: { [TABLE_NAME]: [lease1] },
          UnprocessedKeys: {
            [TABLE_NAME]: {
              Keys: [{ userEmail: lease2.userEmail, uuid: lease2.uuid }],
            },
          },
        }))
        .callsFakeOnce(() => ({
          Responses: { [TABLE_NAME]: [lease2] },
        }));

      const result = await store.batchGet([
        { userEmail: lease1.userEmail, uuid: lease1.uuid },
        { userEmail: lease2.userEmail, uuid: lease2.uuid },
      ]);

      expect(result).toHaveLength(2);
      expect(mockDynamoClient.commandCalls(BatchGetCommand)).toHaveLength(2);
    });

    test("silently omits keys that DynamoDB does not return", async () => {
      const lease = makeLease();
      mockDynamoClient.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [lease] },
      });

      const result = await store.batchGet([
        { userEmail: lease.userEmail, uuid: lease.uuid },
        {
          userEmail: "missing@example.com",
          uuid: randomUUID(),
        },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0]!.uuid).toBe(lease.uuid);
    });

    test("gives up after 4 retry attempts when UnprocessedKeys never clear", async () => {
      vi.useRealTimers(); // backOff uses real setTimeout

      const lease = makeLease();
      const key = { userEmail: lease.userEmail, uuid: lease.uuid };
      mockDynamoClient.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [] },
        UnprocessedKeys: {
          [TABLE_NAME]: { Keys: [key] },
        },
      });

      await expect(store.batchGet([key])).rejects.toThrow(
        BatchUnprocessedItemsError,
      );

      expect(mockDynamoClient.commandCalls(BatchGetCommand)).toHaveLength(4);
    });
  });
});
