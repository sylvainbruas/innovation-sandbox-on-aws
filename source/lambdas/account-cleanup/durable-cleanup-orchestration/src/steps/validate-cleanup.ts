// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  ResourceCount,
  ResourceEntry,
  ResourceSummary,
} from "@amzn/innovation-sandbox-commons/data/cleanup-report/cleanup-report.js";
import { GlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { ExclusionConfig } from "@amzn/innovation-sandbox-commons/isb-services/resource-exclusion-filter.js";
import { ListResourcesResult } from "@amzn/innovation-sandbox-commons/isb-services/resource-explorer-service.js";

import {
  enumerateResources,
  summarizeResources,
} from "./enumerate-resources.js";
import type { CleanupContext } from "./types.js";

/** Maximum number of remaining resource ARNs stored in the report. */
const MAX_REMAINING_RESOURCES = 100;

/** Maximum number of ignored resource ARNs stored in the report. */
const MAX_IGNORED_RESOURCES = 100;

/**
 * Result of the post-cleanup validation step.
 */
export interface ValidationResult {
  /** Whether validation passed (no remaining resources after exclusions). */
  passed: boolean;
  /** Whether validation failure was enforced (Quarantine) or just warned. */
  enforced: boolean;
  /** The full resource summary written to the cleanup report. */
  resourceSummary: ResourceSummary;
  /** Remaining resources (capped at MAX_REMAINING_RESOURCES) for the report. */
  remainingResources: ResourceEntry[];
  /** Total count of remaining resources (may exceed the capped array length). */
  remainingResourcesTotalCount: number;
}

/**
 * Performs post-cleanup validation:
 *   1. Diffs before/after resource summaries
 *   2. Checks failureAction config to determine enforcement
 *   3. Builds ResourceSummary for the cleanup report
 *   4. Produces anonymized resource type metrics log entry
 *
 * Returns a ValidationResult indicating whether cleanup should proceed or fail.
 */
export function validateCleanup(
  ctx: CleanupContext,
  cleanupConfig: GlobalConfig["cleanup"],
  beforeCleanup: ResourceCount,
  afterCleanup: ResourceCount,
  afterResult: ListResourcesResult,
): ValidationResult {
  const { durableContext, accountId } = ctx;
  const { failureAction } = cleanupConfig.validation;

  const afterCooldown = summarizeResources(afterResult);

  const remainingTypes = Object.keys(afterCooldown.byType);

  // Build remaining resources array (capped at MAX_REMAINING_RESOURCES) for the report
  const remainingResourcesTotalCount = afterResult.remainingResources.length;
  const remainingResources: ResourceEntry[] = afterResult.remainingResources
    .slice(0, MAX_REMAINING_RESOURCES)
    .map((r) => ({
      arn: r.Arn ?? "unknown",
      resourceType: r.ResourceType ?? "unknown",
      region: r.Region ?? "unknown",
    }));

  // Build ignored resources list (capped at 100)
  const ignoredResourcesTotalCount = afterResult.ignoredResources.length;
  const ignoredResources: ResourceEntry[] = afterResult.ignoredResources
    .slice(0, MAX_IGNORED_RESOURCES)
    .map((r) => ({
      arn: r.Arn ?? "unknown",
      resourceType: r.ResourceType ?? "unknown",
      region: r.Region ?? "unknown",
    }));

  const passed = afterCooldown.totalCount === 0;
  const enforced = failureAction === "Quarantine";

  const resourceSummary: ResourceSummary = {
    validationMode: failureAction,
    beforeCleanup,
    afterCleanup,
    afterCooldown,
    remainingTypes,
    remainingResources,
    remainingResourcesTotalCount,
    ignoredResources,
    ignoredResourcesTotalCount,
  };

  if (passed) {
    durableContext.logger.info(
      "Post-cleanup validation passed: account is clean",
      { accountId },
    );
  } else if (failureAction === "Quarantine") {
    durableContext.logger.error(
      "Post-cleanup validation FAILED: resources remain and failureAction is Quarantine",
      {
        accountId,
        remainingTypes,
        remainingResourcesTotalCount,
      },
    );
  } else if (failureAction === "Warn") {
    durableContext.logger.warn(
      "Post-cleanup validation detected remaining resources but failureAction is Warn — proceeding",
      {
        accountId,
        remainingTypes,
        remainingResourcesTotalCount,
      },
    );
  } else {
    // Silent: run validation and record metrics in the background, but do not
    // surface remaining resources to the user or block the account.
    durableContext.logger.info(
      "Post-cleanup validation detected remaining resources but failureAction is Silent — proceeding (metrics only)",
      {
        accountId,
        remainingTypes,
        remainingResourcesTotalCount,
      },
    );
  }

  return {
    passed,
    enforced,
    resourceSummary,
    remainingResources,
    remainingResourcesTotalCount,
  };
}

/**
 * Self-contained step for post-cleanup validation:
 *   1. Renews the account lock
 *   2. Enumerates resources via Resource Explorer (post-cleanup)
 *   3. Diffs before vs after and determines pass/fail
 *   4. Writes the full resource summary to the cleanup report
 *   5. Throws if validation fails and enforcement is enabled
 *
 * Returns the ValidationResult for the handler (only reached if validation
 * passed or enforcement is disabled).
 */
export async function validateCleanupStep(
  ctx: CleanupContext,
  cleanupConfig: GlobalConfig["cleanup"],
  beforeCleanup: ResourceCount,
  afterCleanup: ResourceCount,
  deps: { managedRegions: string[]; exclusionConfig: ExclusionConfig },
): Promise<ValidationResult> {
  await ctx.accountStore.acquireLock(ctx.accountId, ctx.executionArn, 900, {
    step: "validate-cleanup",
    reason: ctx.cleanupReason,
  });

  const resourceExplorer = IsbServices.resourceExplorer(ctx.env, {
    managedRegions: deps.managedRegions,
    exclusionConfig: deps.exclusionConfig,
  });
  const afterResult = await enumerateResources(ctx, resourceExplorer);

  const result = validateCleanup(
    ctx,
    cleanupConfig,
    beforeCleanup,
    afterCleanup,
    afterResult,
  );

  await ctx.reportWriter.updateReport(ctx.reportKey, {
    resourceSummary: result.resourceSummary,
  });

  if (!result.passed && result.enforced) {
    throw new Error(
      `Post-cleanup validation failed: ${result.remainingResourcesTotalCount} resources remain in account ${ctx.accountId}. ` +
        `Remaining types: ${result.resourceSummary.remainingTypes?.join(", ") ?? "unknown"}`,
    );
  }

  return result;
}
