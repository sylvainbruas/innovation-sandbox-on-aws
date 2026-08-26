// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AccountCleanupFailureEvent } from "@amzn/innovation-sandbox-commons/events/account-cleanup-failure-event.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleCleanupFailure } from "@amzn/innovation-sandbox-durable-cleanup-orchestration/steps/handle-cleanup-failure.js";
import { CleanupStepError } from "@amzn/innovation-sandbox-durable-cleanup-orchestration/steps/run-step.js";
import type { CleanupContext } from "@amzn/innovation-sandbox-durable-cleanup-orchestration/steps/types.js";

function createMockContext(releaseLockResult: boolean): {
  ctx: CleanupContext;
  sendIsbEvent: ReturnType<typeof vi.fn>;
  releaseLock: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  finalizeReport: ReturnType<typeof vi.fn>;
} {
  const sendIsbEvent = vi.fn().mockResolvedValue(undefined);
  const releaseLock = vi.fn().mockResolvedValue(releaseLockResult);
  const update = vi.fn().mockResolvedValue(undefined);
  const finalizeReport = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    durableContext: {
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    },
    env: {},
    accountId: "123456789012",
    executionArn: "arn:aws:states:us-east-1:123456789012:execution:A",
    cleanupReason: "LEASE_TERMINATION",
    executionStartTime: "2024-12-20T08:45:00.000Z",
    accountStore: {
      update,
      releaseLock,
    },
    eventBridge: { sendIsbEvent },
    organizationsTaggingService: {},
    reportWriter: {
      updateReport: vi.fn().mockResolvedValue(undefined),
      appendStep: vi.fn().mockResolvedValue(undefined),
      finalizeReport,
      getStore: vi.fn().mockReturnValue({
        get: vi.fn().mockResolvedValue({ result: undefined }),
      }),
    },
    reportKey: { awsAccountId: "123456789012", cleanupExecutionId: "A" },
  } as unknown as CleanupContext;

  return { ctx, sendIsbEvent, releaseLock, update, finalizeReport };
}

describe("handleCleanupFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishes AccountCleanupFailureEvent when this execution still owns the lock", async () => {
    const { ctx, sendIsbEvent } = createMockContext(true);

    await handleCleanupFailure(
      ctx,
      new CleanupStepError("summarize-account", new Error("boom")),
    );

    expect(sendIsbEvent).toHaveBeenCalledOnce();
    const publishedEvent = sendIsbEvent.mock.calls[0]![1];
    expect(publishedEvent).toBeInstanceOf(AccountCleanupFailureEvent);
  });

  it("suppresses the failure event when the lock is owned by another execution (preempted)", async () => {
    // releaseLock returns false => a concurrent execution stole the lock, so
    // this execution's failure is not a real cleanup failure. Publishing the
    // event would spuriously quarantine an account another execution is
    // actively (and successfully) cleaning.
    const { ctx, sendIsbEvent } = createMockContext(false);

    await handleCleanupFailure(
      ctx,
      new CleanupStepError("summarize-account", new Error("boom")),
    );

    expect(sendIsbEvent).not.toHaveBeenCalled();
  });

  it("does not resolve cleanup status (shared-state writes) when preempted", async () => {
    // A preempted execution must not touch the shared account record or report:
    // resolveCleanupStatus removes activeCleanup (which the new owner set) and
    // finalizes the report. Ownership is established via releaseLock first, so
    // these writes are skipped when the lock was taken over.
    const { ctx, update, finalizeReport, releaseLock } =
      createMockContext(false);

    await handleCleanupFailure(
      ctx,
      new CleanupStepError("summarize-account", new Error("boom")),
    );

    expect(releaseLock).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
    expect(finalizeReport).not.toHaveBeenCalled();
  });

  it("resolves cleanup status when this execution still owns the lock", async () => {
    const { ctx, update, finalizeReport } = createMockContext(true);

    await handleCleanupFailure(
      ctx,
      new CleanupStepError("summarize-account", new Error("boom")),
    );

    expect(update).toHaveBeenCalled();
    expect(finalizeReport).toHaveBeenCalled();
  });

  it("still publishes (fails safe to quarantine) when releaseLock throws", async () => {
    // A releaseLock error is not proof of preemption, so ownsLock stays true
    // and the failure event is still published — favoring quarantine over a
    // silently-dropped failure.
    const { ctx, sendIsbEvent, releaseLock } = createMockContext(true);
    releaseLock.mockRejectedValue(new Error("DynamoDB throttled"));

    await handleCleanupFailure(
      ctx,
      new CleanupStepError("summarize-account", new Error("boom")),
    );

    expect(sendIsbEvent).toHaveBeenCalledOnce();
  });

  it("still publishes when resolveCleanupStatus throws (best-effort)", async () => {
    const { ctx, sendIsbEvent, update } = createMockContext(true);
    update.mockRejectedValue(new Error("DynamoDB throttled"));

    await handleCleanupFailure(
      ctx,
      new CleanupStepError("summarize-account", new Error("boom")),
    );

    expect(sendIsbEvent).toHaveBeenCalledOnce();
  });

  it("does not throw when publishing the failure event fails", async () => {
    const { ctx, sendIsbEvent } = createMockContext(true);
    sendIsbEvent.mockRejectedValue(new Error("EventBridge unavailable"));

    // Best-effort: a publish failure is logged, not propagated.
    await expect(
      handleCleanupFailure(
        ctx,
        new CleanupStepError("summarize-account", new Error("boom")),
      ),
    ).resolves.toBeUndefined();
  });
});
