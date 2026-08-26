// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  GROUP_MEMBERSHIP_SK,
  userPk,
} from "@amzn/innovation-sandbox-commons/data/principal/principal-dynamodb-keys.js";
import { GroupMembershipCache } from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import {
  calculateTtlInEpochSeconds,
  now,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";

import {
  GROUP_MEMBERSHIP_CACHE_TTL_DAYS,
  GetGroupMembershipsServices,
} from "./group-membership.types.js";

/**
 * Returns the IDC group IDs that the given user is a member of.
 *
 * Reads from the Principal Table cache; on miss or expiry, calls IDC
 * `ListGroupMembershipsForMember` and writes a fresh cache record with a
 * 24-hour TTL.
 *
 * Concurrent callers may both miss and refresh — that's safe because the
 * IDC response is deterministic and the cache record is idempotent.
 */
export async function getGroupMemberships(
  userId: string,
  services: GetGroupMembershipsServices,
): Promise<string[]> {
  const { principalStore, idcService, logger } = services;

  const cacheResult = await principalStore.getGroupMembershipCache(userId);
  const cached = cacheResult.result;
  const nowEpochSeconds = Math.floor(now().valueOf() / 1000);

  if (cached && cached.ttl > nowEpochSeconds) {
    logger.debug("Group membership cache hit", {
      userId,
      groupCount: cached.groupIds.length,
      ttl: cached.ttl,
    });
    return cached.groupIds;
  }

  logger.info("Group membership cache miss or expired, refreshing from IDC", {
    userId,
    cacheExpired: cached !== undefined,
  });

  const groupMemberships = await idcService.listGroupsForUser(userId);
  const groupIds = groupMemberships
    .map((m) => m.GroupId)
    .filter((id): id is string => !!id);

  const cacheRecord: GroupMembershipCache = {
    pk: userPk(userId),
    sk: GROUP_MEMBERSHIP_SK,
    groupIds,
    ttl: calculateTtlInEpochSeconds(GROUP_MEMBERSHIP_CACHE_TTL_DAYS),
  };

  await principalStore.putGroupMembershipCache(cacheRecord);

  logger.info("Group membership cache refreshed", {
    userId,
    groupCount: groupIds.length,
  });

  return groupIds;
}
