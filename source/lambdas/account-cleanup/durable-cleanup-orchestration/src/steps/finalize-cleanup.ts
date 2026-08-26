// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AccountCleanupSuccessfulEvent } from "@amzn/innovation-sandbox-commons/events/account-cleanup-successful-event.js";
import { SubscribableLog } from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import { nowAsIsoDatetimeString } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import { Tracer } from "@aws-lambda-powertools/tracer";

import { buildCleanupCompletedLog } from "../utils/build-cleanup-completed-log.js";
import { resolveCleanupStatus } from "../utils/update-cleanup-status.js";
import type { CleanupContext } from "./types.js";

const tracer = new Tracer();

/**
 * Finalizes a successful cleanup: updates account status, releases the lock,
 * publishes the success event, and emits a structured metric log.
 */
export async function finalizeCleanup(ctx: CleanupContext): Promise<void> {
  const {
    accountId,
    executionArn,
    cleanupReason,
    executionStartTime,
    accountStore,
    eventBridge,
    durableContext,
  } = ctx;

  // Renew lock (5-minute timeout covers finalization)
  await accountStore.acquireLock(accountId, executionArn, 300, {
    step: "finalize-cleanup",
    reason: cleanupReason,
  });

  // Resolve cleanup as completed and release the lock.
  await resolveCleanupStatus(ctx, "COMPLETED");
  await accountStore.update(accountId, {
    set: { lastCleanupCompletedAt: nowAsIsoDatetimeString() },
    remove: ["currentLease"],
  });
  await accountStore.releaseLock(accountId, executionArn);

  // Publish success event
  await eventBridge.sendIsbEvent(
    tracer,
    new AccountCleanupSuccessfulEvent({
      accountId,
      cleanupExecutionContext: {
        executionArn: executionArn,
        executionStartTime: executionStartTime,
      },
      reason: cleanupReason,
    }),
  );

  // Structured metric log — AccountCleanupCompleted v1
  try {
    const metricLog: SubscribableLog = await buildCleanupCompletedLog(ctx, {
      outcome: "SUCCESS",
    });
    durableContext.logger.info("AccountCleanupCompleted", metricLog);
  } catch (metricError) {
    durableContext.logger.error(
      "Failed to emit AccountCleanupCompleted metric log",
      {
        accountId,
        metricError:
          metricError instanceof Error
            ? metricError.message
            : String(metricError),
      },
    );
  }
}
