// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  now,
  parseDatetime,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";

import { updateCleanupStatus } from "../utils/update-cleanup-status.js";
import { cleanupAccountAccess } from "./cleanup-account-access.js";
import { runStep } from "./run-step.js";
import type { CleanupContext } from "./types.js";

// Maximum time to wait for the lease lock to be released before falling
// through to the authoritative sweep. With exponential backoff starting at
// 5s and doubling up to 60s, 20 attempts covers ~10 minutes.
const MAX_POLL_ATTEMPTS = 20;
const INITIAL_DELAY_SECONDS = 5;
const MAX_DELAY_SECONDS = 60;

interface LeaseLockPollState {
  cleared: boolean;
  reason?: string;
}

/**
 * Validates that assignment cleanup has completed by polling the lease
 * resourceLock until it is released. Reported as a single
 * "revoke-access" step in the cleanup report.
 *
 * The assignment revocation Step Function (fired immediately by terminateLease)
 * releases the lease's resourceLock in HANDLE_COMPLETION. This step polls
 * for that release using `waitForCondition` with exponential backoff — no
 * cross-component coupling, no callback coordination, no shared state.
 *
 * Conditions that resolve immediately (first poll):
 *  - Account has no currentLease (pre-v1.3.0 records)
 *  - Lease has no resourceLock (Step Function already completed)
 *  - Lease resourceLock is expired (orphaned from a crashed Step Function)
 *
 * On max attempts reached, the step proceeds (does NOT quarantine) — the
 * authoritative sweep (cleanupAccountAccess) is the backstop.
 *
 * After the poll resolves (or times out), the authoritative sweep runs:
 * ListAccountAssignments + DeleteAccountAssignment for any remnants.
 * Quarantines the account on sweep failure.
 */
export async function revokeAccess(ctx: CleanupContext): Promise<void> {
  const {
    durableContext,
    accountStore,
    accountId,
    executionArn,
    cleanupReason,
    reportWriter,
    reportKey,
    env,
  } = ctx;

  // Append the report step and set status (runs on first invocation, idempotent on replay)
  await runStep(
    ctx,
    "revoke-access",
    async () => {
      await reportWriter.appendStep(reportKey, "revoke-access");
      await updateCleanupStatus(ctx, "REVOKING_ACCESS");
    },
    { skipReport: true },
  );

  // Poll until the lease lock is released (or max attempts / immediate resolution)
  const accountResult = await accountStore.get(accountId);
  const currentLease = accountResult.result?.currentLease;

  if (currentLease) {
    await durableContext
      .waitForCondition<LeaseLockPollState>(
        "wait-for-lease-lock-release",
        async (state) => {
          // Renew our account lock each iteration. This poll can run for many
          // minutes; without renewal the 300s account lock would expire
          // mid-poll and a concurrent retry could steal it. Re-acquiring with
          // the same ownerId refreshes the TTL.
          await accountStore.acquireLock(accountId, executionArn, 300, {
            step: "revoke-access",
            reason: cleanupReason,
          });

          const leaseResult = await IsbServices.leaseStore(env).get(
            {
              userEmail: currentLease.ownerEmail,
              uuid: currentLease.leaseId,
            },
            { consistentRead: true },
          );
          const leaseLock = leaseResult.result?.resourceLock;

          if (!leaseLock) {
            return { cleared: true, reason: "lock_released" };
          }
          if (parseDatetime(leaseLock.expiresAt) < now()) {
            return { cleared: true, reason: "lock_expired" };
          }
          return state;
        },
        {
          initialState: { cleared: false },
          // Exponential backoff capped at MAX_DELAY_SECONDS.
          // Max total wait: 5+10+20+40+(16×60) = ~17 minutes (exceeds 15-min lock TTL).
          waitStrategy: (state, attempt) => {
            if (state.cleared) {
              return { shouldContinue: false };
            }
            if (attempt >= MAX_POLL_ATTEMPTS) {
              return { shouldContinue: false };
            }
            const delay = Math.min(
              INITIAL_DELAY_SECONDS * Math.pow(2, attempt),
              MAX_DELAY_SECONDS,
            );
            return { shouldContinue: true, delay: { seconds: delay } };
          },
        },
      )
      .then((finalState) => {
        if (finalState.cleared) {
          durableContext.logger.info(
            "Assignment processing confirmed complete",
            { accountId, reason: finalState.reason },
          );
        } else {
          durableContext.logger.warn(
            "Max poll attempts reached waiting for lease lock release; proceeding to sweep",
            { accountId },
          );
        }
      });
  } else {
    durableContext.logger.info(
      "No currentLease on account; skipping lease lock poll",
      { accountId },
    );
  }

  // Authoritative sweep: revoke any remaining IDC assignments.
  // Part of the same report step (skipReport). Quarantines on failure.
  await runStep(ctx, "revoke-access-sweep", () => cleanupAccountAccess(ctx), {
    skipReport: true,
  });
}
