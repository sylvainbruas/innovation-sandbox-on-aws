// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { CleanupReportStore } from "@amzn/innovation-sandbox-commons/data/cleanup-report/cleanup-report-store.js";
import type { CleanupReport } from "@amzn/innovation-sandbox-commons/data/cleanup-report/cleanup-report.js";
import { CleanupReportKey } from "@amzn/innovation-sandbox-commons/data/cleanup-report/cleanup-report.js";
import { CleanupReportWriter } from "@amzn/innovation-sandbox-durable-cleanup-orchestration/cleanup-report-writer.js";

describe("CleanupReportWriter", () => {
  let writer: CleanupReportWriter;
  let mockStore: {
    create: ReturnType<typeof vi.fn>;
    updateReport: ReturnType<typeof vi.fn>;
    addStep: ReturnType<typeof vi.fn>;
    updateStepAtIndex: ReturnType<typeof vi.fn>;
    getLatestReport: ReturnType<typeof vi.fn>;
    listRecentReports: ReturnType<typeof vi.fn>;
  };

  const accountId = "123456789012";
  const startedAt = "2024-06-01T12:00:00.000Z";
  const reportKey = new CleanupReportKey(accountId, startedAt);
  const executionArn =
    "arn:aws:states:us-east-1:123456789012:execution:cleanup:exec-1";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-01T12:00:00.000Z"));

    mockStore = {
      create: vi.fn(),
      updateReport: vi.fn(),
      addStep: vi.fn(),
      updateStepAtIndex: vi.fn(),
      getLatestReport: vi.fn(),
      listRecentReports: vi.fn(),
    };

    writer = new CleanupReportWriter(
      mockStore as unknown as CleanupReportStore,
    );
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  describe("createReport()", () => {
    test("constructs report with correct fields and TTL", async () => {
      mockStore.create.mockResolvedValue(buildMockReport());

      await writer.createReport(reportKey, {
        durableExecutionArn: executionArn,
        reasonForCleanup: "LEASE_TERMINATION",
      });

      expect(mockStore.create).toHaveBeenCalledWith(
        expect.objectContaining({
          key: reportKey,
          durableExecutionArn: executionArn,
          reasonForCleanup: "LEASE_TERMINATION",
          // startedAt + 365d placeholder retention
          ttl: DateTime.fromISO("2025-06-01T12:00:00.000Z", {
            zone: "utc",
          }).toUnixInteger(),
        }),
      );
    });
  });

  describe("updateRetentionTtl()", () => {
    test("anchors TTL to retention plus the cooldown that elapses in-execution", async () => {
      mockStore.updateReport.mockResolvedValue(buildMockReport());

      await writer.updateRetentionTtl(reportKey, {
        reportRetentionDays: 730,
        cooldownPeriodHours: 24,
      });

      expect(mockStore.updateReport).toHaveBeenCalledWith({
        key: reportKey,
        // startedAt + 730d retention + 24h cooldown
        ttl: DateTime.fromISO("2026-06-02T12:00:00.000Z", {
          zone: "utc",
        }).toUnixInteger(),
      });
    });

    test("keeps the report alive past a cooldown longer than the retention window", async () => {
      mockStore.updateReport.mockResolvedValue(buildMockReport());

      // Minimum retention (14d) with the maximum cooldown (8640h = 360d) is the
      // case that expired the record mid-cooldown when TTL ignored cooldown.
      await writer.updateRetentionTtl(reportKey, {
        reportRetentionDays: 14,
        cooldownPeriodHours: 8640,
      });

      const { ttl } = mockStore.updateReport.mock.calls[0]![0];
      const cooldownEnds = DateTime.fromISO(startedAt, { zone: "utc" })
        .plus({ hours: 8640 })
        .toUnixInteger();
      expect(ttl).toBeGreaterThan(cooldownEnds);
    });
  });

  describe("appendStep()", () => {
    test("appends step with name and startedAt", async () => {
      mockStore.addStep.mockResolvedValue(0);

      const index = await writer.appendStep(reportKey, "nuke-phase-1");

      expect(mockStore.addStep).toHaveBeenCalledWith({
        key: reportKey,
        step: { name: "nuke-phase-1", startedAt: "2024-06-01T12:00:00.000Z" },
      });
      expect(index).toBe(0);
    });

    test("includes meta when provided", async () => {
      mockStore.addStep.mockResolvedValue(2);

      const buildArn =
        "arn:aws:codebuild:us-east-1:123456789012:build/cleanup:abc-123";
      const index = await writer.appendStep(reportKey, "nuke-phase-1", {
        codeBuildExecutionArn: buildArn,
      });

      expect(mockStore.addStep).toHaveBeenCalledWith(
        expect.objectContaining({
          step: expect.objectContaining({
            meta: { codeBuildExecutionArn: buildArn },
          }),
        }),
      );
      expect(index).toBe(2);
    });
  });

  describe("completeStep()", () => {
    test("calls updateStepAtIndex with completedAt and meta", async () => {
      mockStore.updateStepAtIndex.mockResolvedValue(undefined);

      await writer.completeStep(reportKey, 3, {
        codeBuildExecutionArn:
          "arn:aws:codebuild:us-east-1:123456789012:build/cleanup:abc-123",
        outcome: "SUCCEEDED",
      });

      expect(mockStore.updateStepAtIndex).toHaveBeenCalledWith({
        key: reportKey,
        index: 3,
        completedAt: "2024-06-01T12:00:00.000Z",
        meta: {
          codeBuildExecutionArn:
            "arn:aws:codebuild:us-east-1:123456789012:build/cleanup:abc-123",
          outcome: "SUCCEEDED",
        },
      });
    });

    test("calls updateStepAtIndex without meta when not provided", async () => {
      mockStore.updateStepAtIndex.mockResolvedValue(undefined);

      await writer.completeStep(reportKey, 1);

      expect(mockStore.updateStepAtIndex).toHaveBeenCalledWith({
        key: reportKey,
        index: 1,
        completedAt: "2024-06-01T12:00:00.000Z",
        meta: undefined,
      });
    });

    test("records failure outcome with error message", async () => {
      mockStore.updateStepAtIndex.mockResolvedValue(undefined);

      await writer.completeStep(reportKey, 0, {
        codeBuildExecutionArn:
          "arn:aws:codebuild:us-east-1:123456789012:build/cleanup:def-456",
        outcome: "FAILED",
        errorMessage: "CodeBuild build timed out",
      });

      expect(mockStore.updateStepAtIndex).toHaveBeenCalledWith({
        key: reportKey,
        index: 0,
        completedAt: "2024-06-01T12:00:00.000Z",
        meta: {
          codeBuildExecutionArn:
            "arn:aws:codebuild:us-east-1:123456789012:build/cleanup:def-456",
          outcome: "FAILED",
          errorMessage: "CodeBuild build timed out",
        },
      });
    });
  });

  describe("updateReport()", () => {
    test("passes fields through to store with correct key", async () => {
      mockStore.updateReport.mockResolvedValue(buildMockReport());

      await writer.updateReport(reportKey, { cleanupStatus: "VALIDATING" });

      expect(mockStore.updateReport).toHaveBeenCalledWith({
        key: reportKey,
        cleanupStatus: "VALIDATING",
      });
    });
  });

  describe("finalizeReport()", () => {
    beforeEach(() => {
      mockStore.updateReport.mockResolvedValue(buildMockReport());
    });

    test("sets terminal status with completedAt", async () => {
      await writer.finalizeReport(reportKey, {
        status: "COMPLETED",
        cleanupStatus: "COMPLETED",
        completedAt: "2024-06-01T13:00:00.000Z",
      });

      expect(mockStore.updateReport).toHaveBeenCalledWith({
        key: reportKey,
        status: "COMPLETED",
        cleanupStatus: "COMPLETED",
        completedAt: "2024-06-01T13:00:00.000Z",
      });
    });

    test("includes error on failure and defaults completedAt to now", async () => {
      await writer.finalizeReport(reportKey, {
        status: "FAILED",
        cleanupStatus: "FAILED",
        error: { step: "nuke-phase-1", message: "Nuke timed out" },
      });

      expect(mockStore.updateReport).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "FAILED",
          completedAt: "2024-06-01T12:00:00.000Z",
          error: { step: "nuke-phase-1", message: "Nuke timed out" },
        }),
      );
    });
  });

  describe("CleanupReportKey", () => {
    test("stores accountId and startedAt", () => {
      const key = new CleanupReportKey(
        "111222333444",
        "2024-07-01T00:00:00.000Z",
      );
      expect(key.accountId).toBe("111222333444");
      expect(key.startedAt).toBe("2024-07-01T00:00:00.000Z");
    });

    test("toString() returns readable representation", () => {
      const key = new CleanupReportKey(
        "111222333444",
        "2024-07-01T00:00:00.000Z",
      );
      expect(key.toString()).toBe(
        "CleanupReportKey(111222333444, 2024-07-01T00:00:00.000Z)",
      );
    });
  });
});

function buildMockReport(
  overrides: Partial<CleanupReport> = {},
): CleanupReport {
  return {
    pk: "123456789012",
    sk: "CleanupReport#2024-06-01T12:00:00.000Z",
    accountId: "123456789012",
    durableExecutionArn:
      "arn:aws:states:us-east-1:123456789012:execution:cleanup:exec-1",
    status: "IN_PROGRESS",
    cleanupStatus: "INITIALIZING",
    startedAt: "2024-06-01T12:00:00.000Z",
    reasonForCleanup: "LEASE_TERMINATION",
    steps: [],
    ttl: 1717329600,
    meta: {
      schemaVersion: 1,
      createdTime: "2024-06-01T12:00:00.000Z",
      lastEditTime: "2024-06-01T12:00:00.000Z",
    },
    ...overrides,
  };
}
