// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ResourceCount } from "@amzn/innovation-sandbox-commons/data/cleanup-report/cleanup-report.js";
import { GlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { ExclusionConfig } from "@amzn/innovation-sandbox-commons/isb-services/resource-exclusion-filter.js";
import {
  ListResourcesResult,
  ResourceExplorerService,
} from "@amzn/innovation-sandbox-commons/isb-services/resource-explorer-service.js";

import type { CleanupContext } from "./types.js";

/**
 * Summarizes a ListResourcesResult into a ResourceCount for checkpointing.
 * Only stores resource types and counts — not full resource objects —
 * to conserve the durable execution storage budget.
 */
export function summarizeResources(result: ListResourcesResult): ResourceCount {
  const byType: Record<string, number> = {};

  for (const resource of result.remainingResources) {
    const type = resource.ResourceType ?? "unknown";
    byType[type] = (byType[type] ?? 0) + 1;
  }

  return {
    totalCount: result.remainingResources.length,
    ignoredCount: result.ignoredResources.length,
    byType,
  };
}

/**
 * Enumerates all resources in the sandbox account using Resource Explorer.
 * Queries across all managed regions and logs partial failures.
 *
 * Returns the full ListResourcesResult — caller decides whether to summarize
 * (for pre-cleanup baseline) or use directly (for post-cleanup validation).
 *
 * Lock renewal is the caller's responsibility.
 */
export async function enumerateResources(
  ctx: CleanupContext,
  resourceExplorer: ResourceExplorerService,
): Promise<ListResourcesResult> {
  const { accountId, durableContext } = ctx;

  durableContext.logger.info("Enumerating resources", { accountId });

  const result = await resourceExplorer.listResources(accountId);

  if (result.errors.length > 0) {
    durableContext.logger.warn(
      "Resource Explorer enumeration had partial failures",
      {
        accountId,
        errors: result.errors,
        exhaustive: result.exhaustive,
      },
    );
  }

  durableContext.logger.info("Resource enumeration complete", {
    accountId,
    totalCount: result.remainingResources.length,
    ignoredCount: result.ignoredResources.length,
    typeCount: new Set(
      result.remainingResources.map((r) => r.ResourceType ?? "unknown"),
    ).size,
  });

  return result;
}

/**
 * Self-contained step for the pre-cleanup resource enumeration:
 *   1. Renews the account lock
 *   2. Enumerates resources via Resource Explorer
 *   3. Summarizes to a ResourceCount (lightweight for durable checkpoint)
 *   4. Writes the baseline snapshot to the cleanup report
 *
 * Returns the baseline ResourceCount for later comparison during validation.
 */
export async function enumerateResourcesBeforeCleanup(
  ctx: CleanupContext,
  deps: { managedRegions: string[]; exclusionConfig: ExclusionConfig },
  cleanupConfig: GlobalConfig["cleanup"],
): Promise<ResourceCount> {
  await ctx.accountStore.acquireLock(ctx.accountId, ctx.executionArn, 900, {
    step: "summarize-account-before-cleanup",
    reason: ctx.cleanupReason,
  });

  const resourceExplorer = IsbServices.resourceExplorer(ctx.env, {
    managedRegions: deps.managedRegions,
    exclusionConfig: deps.exclusionConfig,
  });

  // Ensure indexes exist before enumerating, at cleanup start so a freshly
  // created index has the nuke + cooldown window to populate before validation.
  const indexResult = await resourceExplorer.ensureIndexes(ctx.accountId);
  const indexErrors = indexResult.indexes.filter((index) => index.error);
  if (indexErrors.length > 0) {
    ctx.durableContext.logger.warn(
      "Resource Explorer index creation had partial failures",
      { accountId: ctx.accountId, indexErrors },
    );
  }
  // A view failure leaves the index usable, so it is reported separately from
  // index errors to keep the two failure modes distinguishable in the logs.
  const viewErrors = indexResult.indexes.filter((index) => index.viewError);
  if (viewErrors.length > 0) {
    ctx.durableContext.logger.warn(
      "Resource Explorer default view setup had partial failures",
      { accountId: ctx.accountId, viewErrors },
    );
  }
  ctx.durableContext.logger.info("Resource Explorer index readiness", {
    accountId: ctx.accountId,
    indexes: indexResult.indexes,
  });

  const result = await enumerateResources(ctx, resourceExplorer);
  const baseline = summarizeResources(result);

  await ctx.reportWriter.updateReport(ctx.reportKey, {
    resourceSummary: {
      validationMode: cleanupConfig.validation.failureAction,
      beforeCleanup: baseline,
    },
  });

  return baseline;
}

/**
 * Post-nuke, pre-cooldown snapshot. Diffed against the post-cooldown snapshot to
 * find Resource Explorer ghosts that cleared during cooldown. Indexes were
 * already ensured pre-nuke, so this only enumerates.
 */
export async function enumerateResourcesAfterCleanup(
  ctx: CleanupContext,
  deps: { managedRegions: string[]; exclusionConfig: ExclusionConfig },
): Promise<ResourceCount> {
  await ctx.accountStore.acquireLock(ctx.accountId, ctx.executionArn, 900, {
    step: "summarize-account-after-cleanup",
    reason: ctx.cleanupReason,
  });

  const resourceExplorer = IsbServices.resourceExplorer(ctx.env, {
    managedRegions: deps.managedRegions,
    exclusionConfig: deps.exclusionConfig,
  });

  const result = await enumerateResources(ctx, resourceExplorer);
  return summarizeResources(result);
}
