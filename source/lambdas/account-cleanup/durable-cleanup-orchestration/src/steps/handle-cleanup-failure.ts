// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AccountCleanupFailureEvent } from "@amzn/innovation-sandbox-commons/events/account-cleanup-failure-event.js";
import { SubscribableLog } from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import { Tracer } from "@aws-lambda-powertools/tracer";

import { buildCleanupCompletedLog } from "../utils/build-cleanup-completed-log.js";
import { resolveCleanupStatus } from "../utils/update-cleanup-status.js";
import { CleanupStepError } from "./run-step.js";
import type { CleanupContext } from "./types.js";

const tracer = new Tracer();

/**
 * Handles cleanup failure: releases the lock, sets account status to FAILED,
 * publishes a failure event so the ALM can quarantine the account, and emits a
 * structured metric log for the log subscriber.
 *
 * The lock is released first to establish ownership. If a concurrent execution
 * has taken the lock over, this execution has been preempted (the other one is
 * now cleaning the account), so it returns early without touching shared state
 * or publishing — avoiding a spurious quarantine of an account still being
 * cleaned.
 *
 * All operations are best-effort — errors are logged but do not propagate.
 */
export async function handleCleanupFailure(
  ctx: CleanupContext,
  error: unknown,
): Promise<void> {
  const {
    accountId,
    executionArn,
    cleanupReason,
    executionStartTime,
    accountStore,
    eventBridge,
    durableContext,
  } = ctx;

  const rootCause = error instanceof CleanupStepError ? error.cause : error;
  const rootError =
    rootCause instanceof Error ? rootCause : new Error(String(rootCause));

  durableContext.logger.error("Cleanup failed", {
    accountId,
    step: error instanceof CleanupStepError ? error.stepName : "unknown",
    error: rootError.message,
    stack: rootError.stack,
  });

  // Release the lock first to establish ownership. releaseLock returns false
  // when a concurrent execution has taken the lock over; that execution is now
  // cleaning the account, so this one is preempted and must not touch shared
  // state (the account record, the report) or publish a failure event.
  // Default to owning the lock so a release error still fails safe (quarantine).
  let ownsLock = true;
  try {
    ownsLock = await accountStore.releaseLock(accountId, executionArn);
  } catch (releaseError) {
    durableContext.logger.error("Failed to release lock", {
      accountId,
      releaseError:
        releaseError instanceof Error
          ? releaseError.message
          : String(releaseError),
    });
  }

  if (!ownsLock) {
    durableContext.logger.warn(
      "Preempted by another execution: skipping failure resolution and event",
      { accountId, executionArn },
    );
    return;
  }

  // Resolve cleanup as failed — best-effort.
  try {
    const failedStep =
      error instanceof CleanupStepError ? error.stepName : "unknown";
    const errorMessage = error instanceof Error ? error.message : String(error);
    await resolveCleanupStatus(ctx, "FAILED", {
      step: failedStep,
      message: errorMessage,
    });
  } catch (cleanupError) {
    durableContext.logger.error("Failed to update account status", {
      accountId,
      cleanupError:
        cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError),
    });
  }

  // Notify ALM so it can quarantine the account.
  await eventBridge
    .sendIsbEvent(
      tracer,
      new AccountCleanupFailureEvent({
        accountId,
        cleanupExecutionContext: {
          executionArn: executionArn,
          executionStartTime: executionStartTime,
        },
        reason: cleanupReason,
      }),
    )
    .catch((publishError) => {
      durableContext.logger.error("Failed to publish cleanup failure event", {
        accountId,
        publishError:
          publishError instanceof Error
            ? publishError.message
            : String(publishError),
      });
    });

  // Structured metric log — AccountCleanupCompleted v1
  try {
    const metricLog: SubscribableLog = await buildCleanupCompletedLog(ctx, {
      outcome: "FAILED",
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
