// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import { SandboxAccountSchema } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";

describe("SandboxAccount schema migration", () => {
  test("V1 records without new fields parse successfully", () => {
    const v1Account = {
      awsAccountId: "123456789012",
      status: "Available",
      cleanupExecutionContext: {
        stateMachineExecutionArn:
          "arn:aws:states:us-east-1:123456789012:execution:cleanup-state-machine:execution-1",
        stateMachineExecutionStartTime: "2026-03-17T18:30:00.000Z",
      },
      meta: {
        schemaVersion: 1,
        createdTime: "2026-03-17T18:30:00.000Z",
        lastEditTime: "2026-03-17T18:30:00.000Z",
      },
    };

    const result = SandboxAccountSchema.safeParse(v1Account);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cleanupExecutionContext).toEqual(
        v1Account.cleanupExecutionContext,
      );
      expect(result.data.activeCleanup).toBeUndefined();
    }
  });

  test("V2 records with activeCleanup parse successfully", () => {
    const v2Account = {
      awsAccountId: "123456789012",
      status: "CleanUp",
      activeCleanup: {
        status: "NUKE_PHASE_1",
        executionArn:
          "arn:aws:lambda:us-east-1:123456789012:function:ISB-DurableOrchestrationLambda:1/durable-execution/abc-123",
        startedAt: "2026-03-17T18:30:00.000Z",
      },
      meta: {
        schemaVersion: 2,
        createdTime: "2026-03-17T18:30:00.000Z",
        lastEditTime: "2026-03-17T18:30:00.000Z",
      },
    };

    const result = SandboxAccountSchema.safeParse(v2Account);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.activeCleanup?.status).toBe("NUKE_PHASE_1");
      expect(result.data.activeCleanup?.executionArn).toBe(
        v2Account.activeCleanup.executionArn,
      );
      expect(result.data.activeCleanup?.startedAt).toBe(
        "2026-03-17T18:30:00.000Z",
      );
      expect(result.data.cleanupExecutionContext).toBeUndefined();
    }
  });

  test("V2 records with both old cleanupExecutionContext and activeCleanup parse successfully", () => {
    const v2AccountBothFields = {
      awsAccountId: "123456789012",
      status: "CleanUp",
      cleanupExecutionContext: {
        stateMachineExecutionArn:
          "arn:aws:states:us-east-1:123456789012:execution:cleanup-state-machine:execution-1",
        stateMachineExecutionStartTime: "2026-03-17T18:30:00.000Z",
      },
      activeCleanup: {
        status: "INITIALIZING",
        executionArn:
          "arn:aws:lambda:us-east-1:123456789012:function:ISB-DurableOrchestrationLambda:1/durable-execution/abc-123",
        startedAt: "2026-03-17T18:30:00.000Z",
      },
      meta: {
        schemaVersion: 2,
        createdTime: "2026-03-17T18:30:00.000Z",
        lastEditTime: "2026-03-17T18:30:00.000Z",
      },
    };

    const result = SandboxAccountSchema.safeParse(v2AccountBothFields);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cleanupExecutionContext).toEqual(
        v2AccountBothFields.cleanupExecutionContext,
      );
      expect(result.data.activeCleanup?.status).toBe("INITIALIZING");
    }
  });

  test("activeCleanup.status validates all known statuses", () => {
    const knownStatuses = [
      "INITIALIZING",
      "VALIDATING",
      "COOLING_DOWN",
      "COMPLETED",
      "FAILED",
    ];

    for (const status of knownStatuses) {
      const account = {
        awsAccountId: "123456789012",
        status: "CleanUp",
        activeCleanup: {
          status,
          executionArn:
            "arn:aws:lambda:us-east-1:123456789012:function:test:1/durable-execution/abc",
          startedAt: "2026-03-17T18:30:00.000Z",
        },
        meta: {
          schemaVersion: 2,
          createdTime: "2026-03-17T18:30:00.000Z",
          lastEditTime: "2026-03-17T18:30:00.000Z",
        },
      };

      const result = SandboxAccountSchema.safeParse(account);
      expect(result.success).toBe(true);
    }
  });

  test("activeCleanup.status validates NUKE_PHASE_N pattern", () => {
    const nukePhases = ["NUKE_PHASE_1", "NUKE_PHASE_2", "NUKE_PHASE_10"];

    for (const phase of nukePhases) {
      const account = {
        awsAccountId: "123456789012",
        status: "CleanUp",
        activeCleanup: {
          status: phase,
          executionArn:
            "arn:aws:lambda:us-east-1:123456789012:function:test:1/durable-execution/abc",
          startedAt: "2026-03-17T18:30:00.000Z",
        },
        meta: {
          schemaVersion: 2,
          createdTime: "2026-03-17T18:30:00.000Z",
          lastEditTime: "2026-03-17T18:30:00.000Z",
        },
      };

      const result = SandboxAccountSchema.safeParse(account);
      expect(result.success).toBe(true);
    }
  });

  test("activeCleanup.status rejects invalid values", () => {
    const invalidStatuses = [
      "INVALID",
      "NUKE_PHASE_",
      "NUKE_PHASE_abc",
      "nuke_phase_1",
    ];

    for (const status of invalidStatuses) {
      const account = {
        awsAccountId: "123456789012",
        status: "CleanUp",
        activeCleanup: {
          status,
          executionArn:
            "arn:aws:lambda:us-east-1:123456789012:function:test:1/durable-execution/abc",
          startedAt: "2026-03-17T18:30:00.000Z",
        },
        meta: {
          schemaVersion: 2,
          createdTime: "2026-03-17T18:30:00.000Z",
          lastEditTime: "2026-03-17T18:30:00.000Z",
        },
      };

      const result = SandboxAccountSchema.safeParse(account);
      expect(result.success).toBe(false);
    }
  });

  test("V1 records without cleanupExecutionContext parse successfully", () => {
    const v1AccountNoContext = {
      awsAccountId: "123456789012",
      status: "Available",
      meta: {
        schemaVersion: 1,
        createdTime: "2026-03-17T18:30:00.000Z",
        lastEditTime: "2026-03-17T18:30:00.000Z",
      },
    };

    const result = SandboxAccountSchema.safeParse(v1AccountNoContext);
    expect(result.success).toBe(true);
  });

  test("V2 records without resourceLock parse successfully (backward compat)", () => {
    const v2AccountNoLock = {
      awsAccountId: "123456789012",
      status: "CleanUp",
      activeCleanup: {
        status: "NUKE_PHASE_1",
        executionArn:
          "arn:aws:lambda:us-east-1:123456789012:function:ISB-DurableOrchestrationLambda:1/durable-execution/abc-123",
        startedAt: "2026-03-17T18:30:00.000Z",
      },
      meta: {
        schemaVersion: 2,
        createdTime: "2026-03-17T18:30:00.000Z",
        lastEditTime: "2026-03-17T18:30:00.000Z",
      },
    };

    const result = SandboxAccountSchema.safeParse(v2AccountNoLock);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resourceLock).toBeUndefined();
    }
  });

  test("V2 records with resourceLock parse successfully", () => {
    const v2AccountWithLock = {
      awsAccountId: "123456789012",
      status: "CleanUp",
      activeCleanup: {
        status: "INITIALIZING",
        executionArn:
          "arn:aws:lambda:us-east-1:123456789012:function:ISB-DurableOrchestrationLambda:1/durable-execution/abc-123",
        startedAt: "2026-03-17T18:30:00.000Z",
      },
      resourceLock: {
        ownerId:
          "arn:aws:lambda:us-east-1:123456789012:function:ISB-DurableOrchestrationLambda:1/durable-execution/abc-123",
        acquiredAt: "2026-03-17T18:30:00.000Z",
        expiresAt: "2026-03-17T18:35:00.000Z",
        meta: { reason: "cleanup" },
      },
      meta: {
        schemaVersion: 2,
        createdTime: "2026-03-17T18:30:00.000Z",
        lastEditTime: "2026-03-17T18:30:00.000Z",
      },
    };

    const result = SandboxAccountSchema.safeParse(v2AccountWithLock);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resourceLock).toBeDefined();
      expect(result.data.resourceLock!.ownerId).toBe(
        v2AccountWithLock.resourceLock.ownerId,
      );
      expect(result.data.resourceLock!.meta).toEqual({ reason: "cleanup" });
    }
  });
});
