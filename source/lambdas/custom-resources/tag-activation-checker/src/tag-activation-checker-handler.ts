// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { Context } from "aws-lambda";

import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  TagActivationCheckerEnvironment,
  TagActivationCheckerEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/tag-activation-checker-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { SubscribableLog } from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import { assertNever } from "@amzn/innovation-sandbox-commons/types/type-guards.js";
import { fromTemporaryIsbOrgManagementCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import {
  ISB_ACCOUNT_TAG_SUFFIXES,
  IsbAccountTagSuffix,
  toCeTagKey,
  toIsbTagKey,
} from "@amzn/innovation-sandbox-commons/utils/isb-account-tags.js";

const tracer = new Tracer();
const logger = new Logger();

export type TagActivationCheckerPhase = "SEED" | "CHECK";

export type TagActivationCheckerSeedEvent = {
  phase: "SEED";
  hubAccountId: string;
};

export type TagActivationCheckerCheckEvent = {
  phase: "CHECK";
  hubAccountId: string;
  maxAttempts: number;
  attempt: number;
};

export type TagActivationCheckerEvent =
  | TagActivationCheckerSeedEvent
  | TagActivationCheckerCheckEvent;

export type TagActivationCheckerSeedResult = {
  seeded: true;
};

export type TagActivationCheckerCheckResult = {
  completed: boolean;
};

export type TagActivationCheckerResult =
  | TagActivationCheckerSeedResult
  | TagActivationCheckerCheckResult;

type TagActivationCheckerContext = Context &
  ValidatedEnvironment<TagActivationCheckerEnvironment>;

const SEED_TAG_VALUE = "seed";

const tagActivationCheckerHandler = async (
  event: TagActivationCheckerEvent,
  context: TagActivationCheckerContext,
): Promise<TagActivationCheckerResult> => {
  const credentials = fromTemporaryIsbOrgManagementCredentials(context.env);

  switch (event.phase) {
    case "SEED":
      return seedHubAccount(event, context, credentials);
    case "CHECK":
      return checkAndActivateTags(event, context, credentials);
    default:
      return assertNever(event);
  }
};

async function seedHubAccount(
  event: TagActivationCheckerSeedEvent,
  context: TagActivationCheckerContext,
  credentials: ReturnType<typeof fromTemporaryIsbOrgManagementCredentials>,
): Promise<TagActivationCheckerSeedResult> {
  const taggingService = IsbServices.organizationsTaggingService(
    context.env,
    credentials,
  );

  const seedTags = Object.fromEntries(
    ISB_ACCOUNT_TAG_SUFFIXES.map((suffix) => [suffix, SEED_TAG_VALUE]),
  );
  await taggingService.tagAccount(event.hubAccountId, seedTags);

  return { seeded: true };
}

async function checkAndActivateTags(
  event: TagActivationCheckerCheckEvent,
  context: TagActivationCheckerContext,
  credentials: ReturnType<typeof fromTemporaryIsbOrgManagementCredentials>,
): Promise<TagActivationCheckerCheckResult> {
  const ceService = IsbServices.costExplorer(context.env, credentials);
  const toTagKey = (suffix: IsbAccountTagSuffix) =>
    toIsbTagKey(context.env.ISB_NAMESPACE, suffix);
  const toCeKey = (suffix: IsbAccountTagSuffix) => toCeTagKey(toTagKey(suffix));

  const tagStatuses = await ceService.listCostAllocationTags(
    ISB_ACCOUNT_TAG_SUFFIXES.map(toCeKey),
  );

  const tagsActive: IsbAccountTagSuffix[] = [];
  const tagsInactive: IsbAccountTagSuffix[] = [];
  const tagsMissing: IsbAccountTagSuffix[] = [];
  for (const suffix of ISB_ACCOUNT_TAG_SUFFIXES) {
    const status = tagStatuses.get(toCeKey(suffix));
    if (!status) {
      tagsMissing.push(suffix);
    } else if (status === "Active") {
      tagsActive.push(suffix);
    } else {
      tagsInactive.push(suffix);
    }
  }

  logger.info("Tag activation check", {
    logDetailType: "TagActivationCheck",
    attempt: event.attempt,
    maxAttempts: event.maxAttempts,
    tagsActive: tagsActive.map(toTagKey),
    tagsInactive: tagsInactive.map(toTagKey),
    tagsMissing: tagsMissing.map(toTagKey),
  } satisfies SubscribableLog);

  if (
    tagsActive.length === ISB_ACCOUNT_TAG_SUFFIXES.length &&
    tagsInactive.length === 0 &&
    tagsMissing.length === 0
  ) {
    await removeSeedTags(event, context, credentials);

    logger.info("Tag activation succeeded", {
      logDetailType: "TagActivationSucceeded",
      attempt: event.attempt,
      tagsActivated: tagsActive.map(toTagKey),
    } satisfies SubscribableLog);

    return { completed: true };
  }

  if (tagsInactive.length > 0) {
    await ceService.setCostAllocationTagsStatus(
      tagsInactive.map(toCeKey),
      "Active",
    );
  }

  // The state machine's IncrementAttempt step bumps `$.attempt` after this
  // returns, so the next-attempt comparison here uses `event.attempt + 1` to
  // mirror what the loop will see. Logged as a metric-filterable signal — the
  // Fail state itself doesn't emit structured logs.
  if (event.attempt + 1 >= event.maxAttempts) {
    logger.error("Tag activation failed", {
      logDetailType: "TagActivationFailed",
      reason: "MaxAttemptsReached",
      attempt: event.attempt + 1,
      maxAttempts: event.maxAttempts,
      tagsInactive: tagsInactive.map(toTagKey),
      tagsMissing: tagsMissing.map(toTagKey),
    } satisfies SubscribableLog);
  }

  return { completed: false };
}

async function removeSeedTags(
  event: TagActivationCheckerCheckEvent,
  context: TagActivationCheckerContext,
  credentials: ReturnType<typeof fromTemporaryIsbOrgManagementCredentials>,
): Promise<void> {
  try {
    const taggingService = IsbServices.organizationsTaggingService(
      context.env,
      credentials,
    );
    await taggingService.untagAccount(event.hubAccountId, [
      ...ISB_ACCOUNT_TAG_SUFFIXES,
    ]);
  } catch (error) {
    logger.warn("Failed to remove seed tags from hub account", {
      logDetailType: "UntagResourceFailed",
      accountId: event.hubAccountId,
      tagKeys: [...ISB_ACCOUNT_TAG_SUFFIXES],
      errorName: error instanceof Error ? error.name : undefined,
      errorMessage: error instanceof Error ? error.message : undefined,
    } satisfies SubscribableLog);
  }
}

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: TagActivationCheckerEnvironmentSchema,
  moduleName: "tag-activation-checker",
}).handler(tagActivationCheckerHandler);
