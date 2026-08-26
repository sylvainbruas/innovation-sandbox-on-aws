// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { GlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";

import { updateCleanupStatus } from "../utils/update-cleanup-status.js";
import { runStep } from "./run-step.js";
import type { CleanupContext } from "./types.js";

/**
 * Implements the post-cleanup account cooldown step.
 *
 * When `cooldownPeriodHours > 0`, the account is held in the CleanUp OU
 * for the configured duration to allow AWS cost data to fully propagate.
 * An administrator can skip the remaining cooldown via the UI, which sends
 * a callback to resume the execution immediately.
 *
 * When `cooldownPeriodHours = 0`, this function is a no-op.
 */
export async function runAccountCooldown(
  ctx: CleanupContext,
  cleanupConfig: GlobalConfig["cleanup"],
): Promise<void> {
  const cooldownPeriodHours = cleanupConfig.cooldownPeriodHours;

  if (cooldownPeriodHours <= 0) {
    return;
  }

  const {
    durableContext,
    accountStore,
    accountId,
    executionArn,
    cleanupReason,
    reportWriter,
    reportKey,
  } = ctx;

  // Renew lock and set COOLING_DOWN status
  await runStep(
    ctx,
    "account-cooldown",
    async () => {
      await accountStore.acquireLock(
        accountId,
        executionArn,
        cooldownPeriodHours * 3600 + 3600, // cooldownPeriodHours + 1 hour margin
        { step: "account-cooldown", reason: cleanupReason },
      );
      await updateCleanupStatus(ctx, "COOLING_DOWN");
    },
    { stepMetadata: { cooldownDurationHours: cooldownPeriodHours } },
  );

  // Suspend execution: wait for either timeout (natural expiry) or callback (admin skip)
  try {
    await durableContext.waitForCallback(
      "account-cooldown-wait",
      async (callbackId) => {
        // Store the callback ID in the report so the skip-cooldown API can read it
        await reportWriter.updateReport(reportKey, {
          skipCooldownCallbackId: callbackId,
        });
        durableContext.logger.info("Account cooldown started", {
          accountId,
          cooldownPeriodHours,
        });
      },
      { timeout: { hours: cooldownPeriodHours } },
    );
    // Callback received — admin skipped the cooldown
    durableContext.logger.info("Account cooldown skipped by administrator", {
      accountId,
    });
  } catch (error) {
    // Bare catch is intentional. waitForCallback throws on both timeout expiry
    // (CallbackError) and callback failure signal. Both mean "cooldown is done, proceed."
    // Log at warn for operational visibility in case of unexpected errors.
    durableContext.logger.warn("Account cooldown wait ended", {
      accountId,
      cooldownPeriodHours,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
