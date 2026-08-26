// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { isCleanupLockActive } from "@amzn/innovation-sandbox-frontend/domains/accounts/helpers";
import { createSandboxAccount } from "@amzn/innovation-sandbox-frontend/mocks/factories/accountFactory";

const lock = (expiresAt: string) => ({
  ownerId: "cleanup-execution",
  acquiredAt: "2026-07-24T00:00:00.000Z",
  expiresAt,
});

describe("isCleanupLockActive", () => {
  it("is false when the account has no resource lock", () => {
    const account = createSandboxAccount({ resourceLock: undefined });
    expect(isCleanupLockActive(account)).toBe(false);
  });

  it("is true while the lock has not expired (a cleanup is running)", () => {
    const account = createSandboxAccount({
      resourceLock: lock(new Date(Date.now() + 60_000).toISOString()),
    });
    expect(isCleanupLockActive(account)).toBe(true);
  });

  it("is false once the lock has expired (the stuck-cleanup recovery case)", () => {
    const account = createSandboxAccount({
      resourceLock: lock(new Date(Date.now() - 60_000).toISOString()),
    });
    expect(isCleanupLockActive(account)).toBe(false);
  });
});
