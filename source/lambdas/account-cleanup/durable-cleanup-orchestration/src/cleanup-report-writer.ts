// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DateTime } from "luxon";

import { CleanupReportStore } from "@amzn/innovation-sandbox-commons/data/cleanup-report/cleanup-report-store.js";
import {
  CleanupReport,
  CleanupReportKey,
  CleanupStatusDetail,
  ReasonForCleanup,
} from "@amzn/innovation-sandbox-commons/data/cleanup-report/cleanup-report.js";
import { nowAsIsoDatetimeString } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";

/**
 * Retention used for the placeholder TTL written at report creation, before
 * the cleanup config (and therefore the real retention) has been fetched.
 * Replaced by {@link CleanupReportWriter.updateRetentionTtl} in the
 * initialize-cleanup step.
 */
const DEFAULT_REPORT_RETENTION_DAYS = 365;

/**
 * Stateless helper class that encapsulates all cleanup report write operations.
 * Every method accepts a `CleanupReportKey` so there is no mutable state —
 * safe for use inside durable replay loops.
 *
 * Usage pattern (inside durable handler):
 *   const reportKey = new CleanupReportKey(accountId, executionStartTime);
 *
 *   await context.step("create-report", async () => {
 *     await reportWriter.createReport(reportKey, { ... });
 *   });
 *   await context.step("nuke-phase-1", async () => {
 *     await reportWriter.appendStep(reportKey, "nuke-phase-1", { codeBuildExecutionArn: buildArn });
 *     await reportWriter.updateReport(reportKey, { cleanupStatus: "NUKE_PHASE_1" });
 *   });
 */
export class CleanupReportWriter {
  private readonly store: CleanupReportStore;

  constructor(store: CleanupReportStore) {
    this.store = store;
  }

  /**
   * Creates a new cleanup report at the start of cleanup.
   * Should be called inside the first durable step after lock acquisition.
   *
   * The TTL written here is a placeholder based on
   * {@link DEFAULT_REPORT_RETENTION_DAYS}, because the cleanup config has not
   * been fetched yet. `updateRetentionTtl` replaces it moments later.
   */
  async createReport(
    key: CleanupReportKey,
    params: {
      durableExecutionArn: string;
      reasonForCleanup: ReasonForCleanup;
      initiatedBy?: string;
    },
  ): Promise<CleanupReport> {
    const ttl = DateTime.fromISO(key.startedAt, { zone: "utc" })
      .plus({ days: DEFAULT_REPORT_RETENTION_DAYS })
      .toUnixInteger();

    const report = await this.store.create({
      key,
      durableExecutionArn: params.durableExecutionArn,
      reasonForCleanup: params.reasonForCleanup,
      initiatedBy: params.initiatedBy,
      ttl,
    });

    return report;
  }

  /**
   * Re-anchors the report TTL once the cleanup config is known.
   *
   * The cooldown period is added on top of the retention window because the
   * cooldown elapses *inside* this execution: a TTL of `startedAt + retention`
   * alone would expire the record mid-cooldown whenever the cooldown exceeds
   * the configured retention, causing the finalize step's conditional update
   * to fail after an otherwise successful cleanup.
   *
   * Must be called inside a durable step for replay safety.
   */
  async updateRetentionTtl(
    key: CleanupReportKey,
    params: { reportRetentionDays: number; cooldownPeriodHours: number },
  ): Promise<void> {
    const ttl = DateTime.fromISO(key.startedAt, { zone: "utc" })
      .plus({
        days: params.reportRetentionDays,
        hours: params.cooldownPeriodHours,
      })
      .toUnixInteger();

    await this.store.updateReport({ key, ttl });
  }

  /**
   * Appends a new step to the cleanup report's steps array.
   * Steps are append-only — no index tracking needed by the caller unless
   * they intend to update the step later (e.g., recording nuke iteration outcomes).
   *
   * Pass additional step-specific fields via meta (e.g., codeBuildExecutionArn, cooldownDurationHours).
   *
   * @returns The zero-based index of the appended step (for use with `completeStep`).
   */
  async appendStep(
    key: CleanupReportKey,
    stepName: string,
    meta?: Record<string, unknown>,
  ): Promise<number> {
    const step = {
      name: stepName,
      startedAt: nowAsIsoDatetimeString(),
      ...(meta && Object.keys(meta).length > 0 && { meta }),
    };

    return this.store.addStep({
      key,
      step,
    });
  }

  /**
   * Records the outcome of a step that was previously appended.
   * Sets `completedAt` and merges outcome data into the step's `meta` field.
   *
   * Used after nuke iterations complete (success or failure) to record
   * per-iteration outcomes in the cleanup report.
   *
   * Note: The `meta` update is a full replacement — the caller must include
   * all fields (e.g., codeBuildExecutionArn) alongside new fields (e.g., outcome).
   */
  async completeStep(
    key: CleanupReportKey,
    index: number,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    await this.store.updateStepAtIndex({
      key,
      index,
      completedAt: nowAsIsoDatetimeString(),
      meta,
    });
  }

  /**
   * Updates top-level fields on the report. Accepts any combination of
   * updatable fields (cleanupStatus, resourceSummary, skipCooldownCallbackId, etc.).
   */
  async updateReport(
    key: CleanupReportKey,
    fields: Omit<Parameters<CleanupReportStore["updateReport"]>[0], "key">,
  ): Promise<void> {
    await this.store.updateReport({
      key,
      ...fields,
    });
  }

  /**
   * Finalizes the report with a terminal status and completion timestamp.
   * Called at the end of cleanup (success or failure).
   */
  async finalizeReport(
    key: CleanupReportKey,
    params: {
      status: "COMPLETED" | "FAILED";
      cleanupStatus: CleanupStatusDetail;
      completedAt?: string;
      error?: { step: string; message: string };
    },
  ): Promise<void> {
    const completedAt = params.completedAt ?? nowAsIsoDatetimeString();

    await this.store.updateReport({
      key,
      status: params.status,
      cleanupStatus: params.cleanupStatus,
      completedAt,
      ...(params.error !== undefined && { error: params.error }),
    });
  }

  /**
   * Returns the underlying CleanupReportStore for read operations.
   * Used by the metric log builder to read back the full report.
   */
  getStore(): CleanupReportStore {
    return this.store;
  }
}
