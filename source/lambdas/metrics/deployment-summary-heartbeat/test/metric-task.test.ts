// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { describe, expect, it, vi } from "vitest";

import {
  collectMetric,
  withTimeout,
} from "@amzn/innovation-sandbox-deployment-summary-heartbeat/metric-task.js";

function fakeLogger() {
  return { warn: vi.fn() } as unknown as Logger;
}

describe("withTimeout", () => {
  it("rejects with a timeout error when the work outlasts the budget", async () => {
    const never = new Promise<number>(() => {});

    await expect(withTimeout(never, 10, "slowMetric")).rejects.toThrow(
      /slowMetric timed out after 10ms/,
    );
  });

  it("resolves with the work's value when it finishes in time", async () => {
    await expect(
      withTimeout(Promise.resolve(42), 1000, "fastMetric"),
    ).resolves.toBe(42);
  });
});

describe("collectMetric", () => {
  it("returns the collector's value on success", async () => {
    const logger = fakeLogger();

    await expect(
      collectMetric(logger, "ok", 1000, -1, async () => 7),
    ).resolves.toBe(7);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns the fallback and warns when the collector throws", async () => {
    const logger = fakeLogger();

    await expect(
      collectMetric(logger, "boom", 1000, "fallback", async () => {
        throw new Error("kaboom");
      }),
    ).resolves.toBe("fallback");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("boom"),
      expect.objectContaining({ error: "kaboom" }),
    );
  });

  it("returns the fallback and warns when the collector times out", async () => {
    const logger = fakeLogger();

    await expect(
      collectMetric(logger, "slow", 10, 0, () => new Promise<number>(() => {})),
    ).resolves.toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("slow"),
      expect.objectContaining({ error: expect.stringContaining("timed out") }),
    );
  });
});
