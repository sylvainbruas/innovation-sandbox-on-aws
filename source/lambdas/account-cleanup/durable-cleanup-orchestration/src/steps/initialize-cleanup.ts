// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ConfigSchemas } from "@amzn/innovation-sandbox-commons/data/config/config.js";
import { GlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { searchableAccountProperties } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { fromTemporaryIsbSandboxAccountCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

import type { CleanupContext } from "./types.js";

/**
 * Validates that the cleanup spoke role exists in the sandbox account
 * by attempting to assume it through the intermediate role chain.
 * Throws if the role cannot be assumed.
 */
async function validateCleanupSpokeRole(
  spokeRoleArn: string,
  env: {
    INTERMEDIATE_ROLE_ARN: string;
    USER_AGENT_EXTRA: string;
  },
): Promise<void> {
  try {
    const stsClient = new STSClient({
      credentials: fromTemporaryIsbSandboxAccountCredentials(spokeRoleArn, env),
      customUserAgent: env.USER_AGENT_EXTRA,
    });
    await stsClient.send(new GetCallerIdentityCommand());
  } catch (error) {
    throw new Error(
      `Cleanup spoke role ${spokeRoleArn} is not assumable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Fetches the cleanup config section, re-anchors the report TTL against the
 * now-known retention and cooldown, and validates the cleanup spoke role.
 * Renews the lock with a 5-minute timeout to cover initialization.
 */
export async function initializeCleanup(
  ctx: CleanupContext,
): Promise<GlobalConfig["cleanup"]> {
  const {
    accountId,
    executionArn,
    cleanupReason,
    accountStore,
    env,
    durableContext,
    reportWriter,
    reportKey,
  } = ctx;

  // Renew lock (5-minute timeout covers initialization)
  const lockedAccount = await accountStore.acquireLock(
    accountId,
    executionArn,
    300,
    { step: "initialize-cleanup", reason: cleanupReason },
  );

  // Fetch cleanup config from the DynamoDB Config table; fall back to code
  // defaults when the section has never been saved (defaults-first model).
  const configStore = IsbServices.configStore(env);
  const storedCleanup = await configStore.getSection("cleanup");
  let cleanupConfig: GlobalConfig["cleanup"];
  if (storedCleanup) {
    // Project only the schema-defined section fields. `.strip()` drops the
    // audit envelope (lastSavedBy/meta) and any other non-section key so
    // operator PII does not enter the 30-day durable execution history.
    // Deriving the projection from the schema (rather than a hand-maintained
    // destructure) keeps it in sync as cleanup fields are added.
    cleanupConfig = ConfigSchemas.cleanup.strip().parse(storedCleanup);
  } else {
    durableContext.logger.warn(
      "Cleanup config section has never been saved; using code defaults",
      { executionArn },
    );
    cleanupConfig = ConfigSchemas.cleanup.parse({});
  }

  // Re-anchor the report TTL now that retention and cooldown are known. The
  // placeholder written at report creation predates the config fetch.
  await reportWriter.updateRetentionTtl(reportKey, {
    reportRetentionDays: cleanupConfig.reportRetentionDays,
    cooldownPeriodHours: cleanupConfig.cooldownPeriodHours,
  });

  // Validate cleanup spoke role exists in the sandbox account
  const spokeRoleArn = `arn:aws:iam::${accountId}:role/${env.CLEANUP_SPOKE_ROLE_NAME}`;
  await validateCleanupSpokeRole(spokeRoleArn, env);

  durableContext.logger.info("Cleanup initialization complete", {
    ...searchableAccountProperties(lockedAccount),
    executionArn,
  });

  return cleanupConfig;
}
