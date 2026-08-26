// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";

import {
  PRINCIPAL_CACHE_GROUP_SK_PREFIX,
  PRINCIPAL_CACHE_PK,
  PRINCIPAL_CACHE_USER_SK_PREFIX,
  PrincipalCacheItem,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  PrincipalCacheSyncEnvironment,
  PrincipalCacheSyncEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/principal-cache-sync-environment.js";
import baseMiddlewareBundle, {
  IsbLambdaContext,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { fromTemporaryIsbIdcCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import {
  calculateTtlInEpochSeconds,
  nowAsIsoDatetimeString,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";

const serviceName = "PrincipalCacheSync";
const tracer = new Tracer({ serviceName });
const logger = new Logger({ serviceName });

type SyncContext = IsbLambdaContext<PrincipalCacheSyncEnvironment>;

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: PrincipalCacheSyncEnvironmentSchema,
  moduleName: "principal-cache-sync",
}).handler(handlePrincipalCacheSync);

async function handlePrincipalCacheSync(_event: unknown, context: SyncContext) {
  const { env } = context;
  const credentials = fromTemporaryIsbIdcCredentials(env);
  const idcService = IsbServices.idcService(env, credentials);
  const principalStore = IsbServices.principalStore(env);

  logger.info("Starting principal cache sync");

  const isbMemberIds = await idcService.listAllIsbMemberIds();
  const allUsers = await idcService.listAllUsers();
  const users = allUsers.filter((u) => isbMemberIds.has(u.principalId));
  const groups = await idcService.listAllGroups();

  logger.info("Fetched and filtered principals from Identity Store", {
    totalIdentityStoreUsers: allUsers.length,
    isbMembers: isbMemberIds.size,
    isbUsers: users.length,
    groupCount: groups.length,
  });

  const now = nowAsIsoDatetimeString();
  const ttl = calculateTtlInEpochSeconds(2);

  const cacheItems = [
    ...users.map((u) => ({
      pk: PRINCIPAL_CACHE_PK,
      sk: `${PRINCIPAL_CACHE_USER_SK_PREFIX}${u.principalId}`,
      principalId: u.principalId,
      principalType: u.principalType,
      displayName: u.displayName,
      ...(u.email && { email: u.email }),
      syncedAt: now,
      ttl,
    })),
    ...groups.map((g) => ({
      pk: PRINCIPAL_CACHE_PK,
      sk: `${PRINCIPAL_CACHE_GROUP_SK_PREFIX}${g.principalId}`,
      principalId: g.principalId,
      principalType: g.principalType,
      displayName: g.displayName,
      syncedAt: now,
      ttl,
    })),
  ] satisfies PrincipalCacheItem[];

  const existingItems = await principalStore.getCacheItems({});
  const existingSks = new Set(existingItems.map((item) => item.sk));
  const newSks = new Set(cacheItems.map((item) => item.sk));
  const staleSks = [...existingSks].filter((sk) => !newSks.has(sk));

  await principalStore.batchPutCacheItems(cacheItems);

  if (staleSks.length > 0) {
    await principalStore.batchDeleteCacheItemsBySk(staleSks);
    logger.info("Deleted stale cache records", { count: staleSks.length });
  }

  logger.info("Principal cache sync complete", {
    usersWritten: users.length,
    groupsWritten: groups.length,
    staleDeleted: staleSks.length,
  });
}
