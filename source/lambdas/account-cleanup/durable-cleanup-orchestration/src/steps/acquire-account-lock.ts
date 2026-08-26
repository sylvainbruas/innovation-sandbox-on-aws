// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account-store.js";
import { CleanupReason } from "@amzn/innovation-sandbox-commons/events/clean-account-request.js";
import { searchableAccountProperties } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { nowAsIsoDatetimeString } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import { DurableContext } from "@aws/durable-execution-sdk-js";

/**
 * Acquires the cleanup lock on the account and sets initial status.
 * Returns the execution start time (checkpointed so it survives replay).
 */
export async function acquireAccountLock(
  context: DurableContext,
  accountStore: SandboxAccountStore,
  params: {
    accountId: string;
    executionArn: string;
    cleanupReason: CleanupReason;
  },
): Promise<string> {
  const { accountId, executionArn, cleanupReason } = params;

  const accountResult = await accountStore.get(accountId);
  if (!accountResult.result) {
    throw new Error(`Account ${accountId} not found in DynamoDB`);
  }

  const lockedAccount = await accountStore.acquireLock(
    accountId,
    executionArn,
    300,
    { step: "acquire-account-lock", reason: cleanupReason },
  );

  const startedAt = nowAsIsoDatetimeString();

  await accountStore.put({
    ...lockedAccount,
    activeCleanup: {
      status: "INITIALIZING",
      executionArn,
      startedAt,
    },
  });

  context.logger.info("Cleanup lock acquired and status set to INITIALIZING", {
    ...searchableAccountProperties(lockedAccount),
    executionArn,
    reason: cleanupReason,
  });

  return startedAt;
}
