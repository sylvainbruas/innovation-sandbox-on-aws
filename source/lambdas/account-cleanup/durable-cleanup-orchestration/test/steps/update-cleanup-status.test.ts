// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { SandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account-store.js";

import type { CleanupContext } from "@amzn/innovation-sandbox-durable-cleanup-orchestration/steps/types.js";
import {
  resolveCleanupStatus,
  updateCleanupStatus,
} from "@amzn/innovation-sandbox-durable-cleanup-orchestration/utils/update-cleanup-status.js";

function createMockContext(
  overrides?: Partial<CleanupContext>,
): CleanupContext {
  return {
    durableContext: {} as CleanupContext["durableContext"],
    env: {} as CleanupContext["env"],
    accountId: "123456789012",
    executionArn:
      "arn:aws:states:us-east-1:111111111111:execution:DurableCleanup:exec-abc",
    cleanupReason: "LEASE_TERMINATION",
    executionStartTime: "2024-06-01T12:00:00.000Z",
    accountStore: {
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as SandboxAccountStore,
    eventBridge: {} as CleanupContext["eventBridge"],
    organizationsTaggingService:
      {} as CleanupContext["organizationsTaggingService"],
    reportWriter: {
      updateReport: vi.fn().mockResolvedValue(undefined),
      finalizeReport: vi.fn().mockResolvedValue(undefined),
      appendStep: vi.fn().mockResolvedValue(undefined),
    } as unknown as CleanupContext["reportWriter"],
    reportKey: {
      accountId: "123456789012",
      startedAt: "2024-06-01T12:00:00.000Z",
    } as unknown as CleanupContext["reportKey"],
    ...overrides,
  };
}

describe("updateCleanupStatus()", () => {
  it("calls accountStore.update with NUKE_PHASE_1 status", async () => {
    const ctx = createMockContext();

    await updateCleanupStatus(ctx, "NUKE_PHASE_1");

    expect(ctx.accountStore.update).toHaveBeenCalledWith("123456789012", {
      set: {
        activeCleanup: {
          status: "NUKE_PHASE_1",
          executionArn:
            "arn:aws:states:us-east-1:111111111111:execution:DurableCleanup:exec-abc",
          startedAt: "2024-06-01T12:00:00.000Z",
        },
      },
    });
  });

  it("calls accountStore.update with INITIALIZING status", async () => {
    const ctx = createMockContext();

    await updateCleanupStatus(ctx, "INITIALIZING");

    expect(ctx.accountStore.update).toHaveBeenCalledWith("123456789012", {
      set: {
        activeCleanup: {
          status: "INITIALIZING",
          executionArn:
            "arn:aws:states:us-east-1:111111111111:execution:DurableCleanup:exec-abc",
          startedAt: "2024-06-01T12:00:00.000Z",
        },
      },
    });
  });

  it("uses accountId from context", async () => {
    const ctx = createMockContext({ accountId: "999888777666" });

    await updateCleanupStatus(ctx, "VALIDATING");

    expect(ctx.accountStore.update).toHaveBeenCalledWith(
      "999888777666",
      expect.objectContaining({
        set: expect.objectContaining({
          activeCleanup: expect.objectContaining({
            status: "VALIDATING",
          }),
        }),
      }),
    );
  });
});

describe("resolveCleanupStatus()", () => {
  it("removes activeCleanup, appends cleanup-complete step, and finalizes report as COMPLETED", async () => {
    const ctx = createMockContext();

    await resolveCleanupStatus(ctx, "COMPLETED");

    expect(ctx.accountStore.update).toHaveBeenCalledWith("123456789012", {
      remove: ["activeCleanup"],
    });
    expect((ctx.reportWriter as any).appendStep).toHaveBeenCalledWith(
      ctx.reportKey,
      "cleanup-complete",
    );
    expect((ctx.reportWriter as any).finalizeReport).toHaveBeenCalledWith(
      ctx.reportKey,
      { status: "COMPLETED", cleanupStatus: "COMPLETED" },
    );
  });

  it("appends cleanup-failed step and finalizes report as FAILED with error details", async () => {
    const ctx = createMockContext();
    const error = { step: "validate-cleanup", message: "Resources remain" };

    await resolveCleanupStatus(ctx, "FAILED", error);

    expect(ctx.accountStore.update).toHaveBeenCalledWith("123456789012", {
      remove: ["activeCleanup"],
    });
    expect((ctx.reportWriter as any).appendStep).toHaveBeenCalledWith(
      ctx.reportKey,
      "cleanup-failed",
    );
    expect((ctx.reportWriter as any).finalizeReport).toHaveBeenCalledWith(
      ctx.reportKey,
      {
        status: "FAILED",
        cleanupStatus: "FAILED",
        error: { step: "validate-cleanup", message: "Resources remain" },
      },
    );
  });

  it("uses accountId from context", async () => {
    const ctx = createMockContext({ accountId: "555444333222" });

    await resolveCleanupStatus(ctx, "COMPLETED");

    expect(ctx.accountStore.update).toHaveBeenCalledWith("555444333222", {
      remove: ["activeCleanup"],
    });
  });
});
