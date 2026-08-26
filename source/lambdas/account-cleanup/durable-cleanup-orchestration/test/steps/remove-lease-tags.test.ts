// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { mockedOrganizationsTaggingService } from "@amzn/innovation-sandbox-commons/test/mocking/common-mocks.js";
import { ISB_LEASE_TAG_SUFFIXES } from "@amzn/innovation-sandbox-commons/utils/isb-account-tags.js";

import { removeLeaseTags } from "@amzn/innovation-sandbox-durable-cleanup-orchestration/steps/remove-lease-tags.js";
import type { CleanupContext } from "@amzn/innovation-sandbox-durable-cleanup-orchestration/steps/types.js";

function createMockContext(
  overrides?: Partial<CleanupContext>,
): CleanupContext {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    durableContext: { logger } as unknown as CleanupContext["durableContext"],
    env: {} as CleanupContext["env"],
    accountId: "123456789012",
    executionArn:
      "arn:aws:states:us-east-1:111111111111:execution:DurableCleanup:exec-abc",
    cleanupReason: "LEASE_TERMINATION",
    executionStartTime: "2024-06-01T12:00:00.000Z",
    accountStore: {
      acquireLock: vi.fn().mockResolvedValue(undefined),
    } as unknown as CleanupContext["accountStore"],
    eventBridge: {} as CleanupContext["eventBridge"],
    organizationsTaggingService: mockedOrganizationsTaggingService(),
    reportWriter: {} as CleanupContext["reportWriter"],
    reportKey: {} as CleanupContext["reportKey"],
    ...overrides,
  };
}

describe("removeLeaseTags()", () => {
  it("calls organizationsTaggingService.removeLeaseTags with the account id", async () => {
    const ctx = createMockContext();

    await removeLeaseTags(ctx);

    expect(
      ctx.organizationsTaggingService.removeLeaseTags,
    ).toHaveBeenCalledWith(ctx.accountId);
  });

  it("swallows errors and logs UntagResourceFailed when removeLeaseTags rejects", async () => {
    const ctx = createMockContext();
    ctx.organizationsTaggingService.removeLeaseTags = vi
      .fn()
      .mockRejectedValue(new Error("AccessDenied"));

    await expect(removeLeaseTags(ctx)).resolves.toBeUndefined();

    expect(ctx.durableContext.logger.warn).toHaveBeenCalledWith(
      "Failed to untag account",
      expect.objectContaining({
        logDetailType: "UntagResourceFailed",
        accountId: ctx.accountId,
        tagKeys: [...ISB_LEASE_TAG_SUFFIXES],
        errorName: "Error",
        errorMessage: "AccessDenied",
      }),
    );
  });
});
