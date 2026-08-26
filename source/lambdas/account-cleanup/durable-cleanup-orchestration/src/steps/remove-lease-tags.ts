// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SubscribableLog } from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import { ISB_LEASE_TAG_SUFFIXES } from "@amzn/innovation-sandbox-commons/utils/isb-account-tags.js";

import type { CleanupContext } from "./types.js";

/**
 * Quarantined accounts (failure path) intentionally retain their lease tags so
 * historical Cost Explorer queries continue to attribute spend correctly.
 */
export async function removeLeaseTags(ctx: CleanupContext): Promise<void> {
  const {
    accountId,
    accountStore,
    executionArn,
    cleanupReason,
    organizationsTaggingService,
    durableContext,
  } = ctx;

  await accountStore.acquireLock(accountId, executionArn, 300, {
    step: "remove-lease-tags",
    reason: cleanupReason,
  });

  try {
    await organizationsTaggingService.removeLeaseTags(accountId);
  } catch (error) {
    durableContext.logger.warn("Failed to untag account", {
      logDetailType: "UntagResourceFailed",
      accountId,
      tagKeys: [...ISB_LEASE_TAG_SUFFIXES],
      errorName: error instanceof Error ? error.name : undefined,
      errorMessage: error instanceof Error ? error.message : undefined,
    } satisfies SubscribableLog);
  }
}
