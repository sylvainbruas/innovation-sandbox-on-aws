// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CleanupReport,
  CleanupReportStep,
} from "@amzn/innovation-sandbox-commons/data/cleanup-report/cleanup-report.js";
import { DateTime } from "luxon";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CleanupContext } from "@amzn/innovation-sandbox-durable-cleanup-orchestration/steps/types.js";
import {
  buildCleanupCompletedLog,
  computeStepDurations,
} from "@amzn/innovation-sandbox-durable-cleanup-orchestration/utils/build-cleanup-completed-log.js";

/** Helper to create a minimal report with just steps and optional cooldownSkippedBy */
function reportWithSteps(
  steps: CleanupReportStep[],
  extra?: { cooldownSkippedBy?: string },
): Partial<CleanupReport> {
  return { steps, ...extra } as Partial<CleanupReport>;
}

describe("computeStepDurations", () => {
  it("should return empty array for undefined report", () => {
    const result = computeStepDurations(undefined);
    expect(result).toEqual([]);
  });

  it("should return empty array for empty steps", () => {
    const result = computeStepDurations(reportWithSteps([]) as CleanupReport);
    expect(result).toEqual([]);
  });

  it("should compute duration as diff between consecutive steps", () => {
    const baseTime = DateTime.fromISO("2026-03-25T14:30:00.000Z");
    const steps: CleanupReportStep[] = [
      { name: "initialize-cleanup", startedAt: baseTime.toISO()! },
      {
        name: "summarize-account-before-cleanup",
        startedAt: baseTime.plus({ seconds: 5 }).toISO()!,
      },
      {
        name: "nuke-phase-1",
        startedAt: baseTime.plus({ seconds: 17 }).toISO()!,
      },
      {
        name: "finalize-cleanup",
        startedAt: baseTime.plus({ seconds: 2717 }).toISO()!,
      },
      {
        name: "cleanup-complete",
        startedAt: baseTime.plus({ seconds: 2719 }).toISO()!,
      },
    ];

    const result = computeStepDurations(
      reportWithSteps(steps) as CleanupReport,
    );

    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({
      name: "initialize-cleanup",
      durationSeconds: 5,
    });
    expect(result[1]).toEqual({
      name: "summarize-account-before-cleanup",
      durationSeconds: 12,
    });
    expect(result[2]).toEqual({ name: "nuke-phase-1", durationSeconds: 2700 });
    expect(result[3]).toEqual({ name: "finalize-cleanup", durationSeconds: 2 });
  });

  it("should detect account-cooldown step and include metadata", () => {
    const baseTime = DateTime.fromISO("2026-03-25T14:30:00.000Z");
    const steps: CleanupReportStep[] = [
      { name: "validate-cleanup", startedAt: baseTime.toISO()! },
      {
        name: "account-cooldown",
        startedAt: baseTime.plus({ seconds: 630 }).toISO()!,
        meta: { cooldownDurationHours: 24 },
      },
      {
        name: "finalize-cleanup",
        startedAt: baseTime.plus({ seconds: 630 + 3600 }).toISO()!,
      },
    ];

    const result = computeStepDurations(
      reportWithSteps(steps, {
        cooldownSkippedBy: "admin@example.com",
      }) as CleanupReport,
    );

    expect(result[1]).toEqual({
      name: "account-cooldown",
      durationSeconds: 3600,
      configuredHours: 24,
      skipped: true,
    });
  });

  it("should mark cooldown as not skipped when cooldownSkippedBy is absent", () => {
    const baseTime = DateTime.fromISO("2026-03-25T14:30:00.000Z");
    const cooldownHours = 1;
    const cooldownSeconds = cooldownHours * 3600;

    const steps: CleanupReportStep[] = [
      { name: "validate-cleanup", startedAt: baseTime.toISO()! },
      {
        name: "account-cooldown",
        startedAt: baseTime.plus({ seconds: 10 }).toISO()!,
        meta: { cooldownDurationHours: cooldownHours },
      },
      {
        name: "finalize-cleanup",
        startedAt: baseTime.plus({ seconds: 10 + cooldownSeconds }).toISO()!,
      },
    ];

    const result = computeStepDurations(
      reportWithSteps(steps) as CleanupReport,
    );

    expect(result[1]).toEqual({
      name: "account-cooldown",
      durationSeconds: cooldownSeconds,
      configuredHours: cooldownHours,
      skipped: false,
    });
  });

  it("should not include cooldown metadata when step has no meta", () => {
    const baseTime = DateTime.fromISO("2026-03-25T14:30:00.000Z");
    const steps: CleanupReportStep[] = [
      { name: "initialize-cleanup", startedAt: baseTime.toISO()! },
      {
        name: "nuke-phase-1",
        startedAt: baseTime.plus({ seconds: 5 }).toISO()!,
      },
    ];

    const result = computeStepDurations(
      reportWithSteps(steps) as CleanupReport,
    );

    expect(result[0]).toEqual({
      name: "initialize-cleanup",
      durationSeconds: 5,
    });
    expect(result[0]).not.toHaveProperty("configuredHours");
    expect(result[0]).not.toHaveProperty("skipped");
  });

  it("should return -1 duration when step has no following step (missing terminal marker)", () => {
    const steps: CleanupReportStep[] = [
      { name: "initialize-cleanup", startedAt: "2026-03-25T14:30:00.000Z" },
    ];

    const result = computeStepDurations(
      reportWithSteps(steps) as CleanupReport,
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("initialize-cleanup");
    expect(result[0]!.durationSeconds).toBe(-1);
  });
});

describe("buildCleanupCompletedLog", () => {
  const mockStore = {
    getReport: vi.fn(),
  };

  const mockReportWriter = {
    getStore: () => mockStore,
  };

  const baseCtx = {
    accountId: "123456789012",
    cleanupReason: "LEASE_TERMINATION" as const,
    executionStartTime: DateTime.utc().minus({ minutes: 105 }).toISO()!,
    executionArn:
      "arn:aws:states:us-east-1:123456789012:execution:cleanup:test",
    reportKey: {
      accountId: "123456789012",
      startedAt: "2026-03-25T14:30:00.000Z",
    },
    reportWriter: mockReportWriter,
    durableContext: { logger: { info: vi.fn(), error: vi.fn() } },
    accountStore: {},
    eventBridge: {},
    env: {},
    organizationsTaggingService: {},
  } as unknown as CleanupContext;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should build success log with full resource summary", async () => {
    const baseTime = DateTime.fromISO("2026-03-25T14:30:00.000Z");
    mockStore.getReport.mockResolvedValue({
      result: {
        resourceSummary: {
          beforeCleanup: {
            totalCount: 42,
            ignoredCount: 5,
            byType: { "ec2:instance": 3, "s3:bucket": 2, "logs:log-group": 12 },
          },
          afterCooldown: {
            totalCount: 0,
            ignoredCount: 5,
            byType: {},
          },
        },
        steps: [
          { name: "initialize-cleanup", startedAt: baseTime.toISO()! },
          {
            name: "summarize-account-before-cleanup",
            startedAt: baseTime.plus({ seconds: 5 }).toISO()!,
          },
          {
            name: "finalize-cleanup",
            startedAt: baseTime.plus({ seconds: 17 }).toISO()!,
          },
        ],
        error: undefined,
      },
    });

    const result = await buildCleanupCompletedLog(baseCtx, {
      outcome: "SUCCESS",
    });

    expect(result).toMatchObject({
      logDetailType: "AccountCleanupCompleted",
      outcome: "SUCCESS",
      reason: "LEASE_TERMINATION",
      failedStep: null,
      totalResourcesBefore: 42,
      totalResourcesIgnored: 5,
      resourcesBefore: {
        "ec2:instance": 3,
        "s3:bucket": 2,
        "logs:log-group": 12,
      },
      resourcesRemaining: {},
    });
    expect(result.logDetailType).toBe("AccountCleanupCompleted");
    expect((result as any).steps).toHaveLength(3);
  });

  it("should build failure log with failedStep from report error", async () => {
    mockStore.getReport.mockResolvedValue({
      result: {
        resourceSummary: {
          beforeCleanup: {
            totalCount: 10,
            ignoredCount: 0,
            byType: { "ec2:instance": 5 },
          },
          afterCooldown: {
            totalCount: 3,
            ignoredCount: 0,
            byType: { "ec2:instance": 3 },
          },
        },
        steps: [
          {
            name: "initialize-cleanup",
            startedAt: DateTime.fromISO("2026-03-25T14:30:00.000Z").toISO()!,
          },
        ],
        error: { step: "validate-cleanup", message: "Validation failed" },
      },
    });

    const result = await buildCleanupCompletedLog(baseCtx, {
      outcome: "FAILED",
    });

    expect(result).toMatchObject({
      logDetailType: "AccountCleanupCompleted",
      outcome: "FAILED",
      failedStep: "validate-cleanup",
    });
  });

  it("should compute resourcesClearedDuringCooldown as the afterCleanup − afterCooldown diff", async () => {
    const baseTime = DateTime.fromISO("2026-03-25T14:30:00.000Z");
    mockStore.getReport.mockResolvedValue({
      result: {
        resourceSummary: {
          validationMode: "Silent",
          beforeCleanup: {
            totalCount: 20,
            ignoredCount: 0,
            byType: { "ec2:instance": 10, "s3:bucket": 10 },
          },
          afterCleanup: {
            totalCount: 6,
            ignoredCount: 0,
            byType: { "ec2:instance": 4, "s3:bucket": 2 },
          },
          afterCooldown: {
            totalCount: 1,
            ignoredCount: 0,
            byType: { "ec2:instance": 1 },
          },
        },
        steps: [
          { name: "initialize-cleanup", startedAt: baseTime.toISO()! },
          {
            name: "finalize-cleanup",
            startedAt: baseTime.plus({ seconds: 10 }).toISO()!,
          },
        ],
        error: undefined,
      },
    });

    const result = await buildCleanupCompletedLog(baseCtx, {
      outcome: "SUCCESS",
    });

    expect((result as any).resourcesClearedDuringCooldown).toEqual({
      "ec2:instance": 3,
      "s3:bucket": 2,
    });
    expect((result as any).resourcesRemaining).toEqual({ "ec2:instance": 1 });
  });

  it("should promote cooldown duration, configured hours, and skip flag to top level", async () => {
    const baseTime = DateTime.fromISO("2026-03-25T14:30:00.000Z");
    mockStore.getReport.mockResolvedValue({
      result: {
        steps: [
          {
            name: "account-cooldown",
            startedAt: baseTime.toISO()!,
            meta: { cooldownDurationHours: 24 },
          },
          // The wait itself appends no step, so the following step marks the end
          // of cooldown — here the admin skipped it after 2 hours.
          {
            name: "validate-cleanup",
            startedAt: baseTime.plus({ hours: 2 }).toISO()!,
          },
          {
            name: "cleanup-complete",
            startedAt: baseTime.plus({ hours: 2, seconds: 30 }).toISO()!,
          },
        ],
        cooldownSkippedBy: "admin@example.com",
        error: undefined,
      },
    });

    const result = await buildCleanupCompletedLog(baseCtx, {
      outcome: "SUCCESS",
    });

    expect(result).toMatchObject({
      cooldownConfiguredHours: 24,
      cooldownActualSeconds: 7200,
      cooldownSkipped: true,
    });
  });

  it("should report zeroed cooldown fields when cooldown did not run", async () => {
    mockStore.getReport.mockResolvedValue({
      result: {
        steps: [
          {
            name: "validate-cleanup",
            startedAt: "2026-03-25T14:30:00.000Z",
          },
          {
            name: "cleanup-complete",
            startedAt: "2026-03-25T14:30:10.000Z",
          },
        ],
        error: undefined,
      },
    });

    const result = await buildCleanupCompletedLog(baseCtx, {
      outcome: "SUCCESS",
    });

    expect(result).toMatchObject({
      cooldownConfiguredHours: 0,
      cooldownActualSeconds: 0,
      cooldownSkipped: false,
    });
  });

  it("should not report a negative cooldown duration when the end time is unknown", async () => {
    // A cooldown step with no following step yields the -1 duration sentinel.
    mockStore.getReport.mockResolvedValue({
      result: {
        steps: [
          {
            name: "account-cooldown",
            startedAt: "2026-03-25T14:30:00.000Z",
            meta: { cooldownDurationHours: 12 },
          },
        ],
        error: undefined,
      },
    });

    const result = await buildCleanupCompletedLog(baseCtx, {
      outcome: "FAILED",
    });

    expect(result).toMatchObject({
      cooldownConfiguredHours: 12,
      cooldownActualSeconds: 0,
      cooldownSkipped: false,
    });
  });

  it("should return empty resourcesClearedDuringCooldown when afterCleanup is absent", async () => {
    mockStore.getReport.mockResolvedValue({
      result: {
        resourceSummary: {
          beforeCleanup: { totalCount: 5, ignoredCount: 0, byType: {} },
          afterCooldown: { totalCount: 0, ignoredCount: 0, byType: {} },
        },
        steps: [],
        error: undefined,
      },
    });

    const result = await buildCleanupCompletedLog(baseCtx, {
      outcome: "SUCCESS",
    });

    expect((result as any).resourcesClearedDuringCooldown).toEqual({});
  });

  it("should handle missing resource summary gracefully", async () => {
    mockStore.getReport.mockResolvedValue({
      result: {
        resourceSummary: undefined,
        steps: [],
        error: undefined,
      },
    });

    const result = await buildCleanupCompletedLog(baseCtx, {
      outcome: "FAILED",
    });

    expect(result).toMatchObject({
      logDetailType: "AccountCleanupCompleted",
      outcome: "FAILED",
      totalResourcesBefore: 0,
      totalResourcesIgnored: 0,
      resourcesBefore: {},
      resourcesRemaining: {},
      steps: [],
    });
  });

  it("should handle missing report gracefully", async () => {
    mockStore.getReport.mockResolvedValue({ result: undefined });

    const result = await buildCleanupCompletedLog(baseCtx, {
      outcome: "FAILED",
    });

    expect(result).toMatchObject({
      logDetailType: "AccountCleanupCompleted",
      outcome: "FAILED",
      totalResourcesBefore: 0,
      totalResourcesIgnored: 0,
      resourcesBefore: {},
      resourcesRemaining: {},
      steps: [],
      failedStep: null,
    });
  });
});
