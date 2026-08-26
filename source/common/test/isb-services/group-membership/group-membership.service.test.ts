// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { randomUUID } from "crypto";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GroupMembershipCache } from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import {
  GROUP_MEMBERSHIP_CACHE_TTL_DAYS,
  getGroupMemberships,
} from "@amzn/innovation-sandbox-commons/isb-services/group-membership/index.js";
import { IdcService } from "@amzn/innovation-sandbox-commons/isb-services/idc-service.js";
import { now } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";

describe("getGroupMemberships", () => {
  const testUserId = randomUUID();
  const testGroupId1 = randomUUID();
  const testGroupId2 = randomUUID();

  const mockPrincipalStore = {
    getGroupMembershipCache: vi.fn(),
    putGroupMembershipCache: vi.fn(),
  };

  const mockIdcService = {
    listGroupsForUser: vi.fn(),
  } as unknown as IdcService;

  const mockLogger = {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  } as unknown as Logger;

  const services = {
    principalStore: mockPrincipalStore as any,
    idcService: mockIdcService,
    logger: mockLogger,
  };

  function getFirstCacheWritten(): GroupMembershipCache {
    const calls = mockPrincipalStore.putGroupMembershipCache.mock.calls;
    if (calls.length === 0 || !calls[0]) {
      throw new Error("putGroupMembershipCache was not called");
    }
    return calls[0][0] as GroupMembershipCache;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  describe("cache hit", () => {
    it("returns cached groupIds without calling IDC when ttl is in the future", async () => {
      const futureTtl = Math.floor(now().valueOf() / 1000) + 60 * 60 * 23; // 23h from now
      const cached: GroupMembershipCache = {
        pk: `user#${testUserId}`,
        sk: "groupMembership",
        groupIds: [testGroupId1, testGroupId2],
        ttl: futureTtl,
      };
      mockPrincipalStore.getGroupMembershipCache.mockResolvedValue({
        result: cached,
      });

      const result = await getGroupMemberships(testUserId, services);

      expect(result).toEqual([testGroupId1, testGroupId2]);
      expect((mockIdcService as any).listGroupsForUser).not.toHaveBeenCalled();
      expect(mockPrincipalStore.putGroupMembershipCache).not.toHaveBeenCalled();
    });

    it("returns empty array when cached membership is empty and ttl is fresh", async () => {
      const futureTtl = Math.floor(now().valueOf() / 1000) + 60 * 60 * 23;
      mockPrincipalStore.getGroupMembershipCache.mockResolvedValue({
        result: {
          pk: `user#${testUserId}`,
          sk: "groupMembership",
          groupIds: [],
          ttl: futureTtl,
        },
      });

      const result = await getGroupMemberships(testUserId, services);

      expect(result).toEqual([]);
      expect((mockIdcService as any).listGroupsForUser).not.toHaveBeenCalled();
    });
  });

  describe("cache miss", () => {
    it("calls IDC and writes a new cache record when no cache exists", async () => {
      mockPrincipalStore.getGroupMembershipCache.mockResolvedValue({
        result: undefined,
      });
      (mockIdcService as any).listGroupsForUser.mockResolvedValue([
        { GroupId: testGroupId1 },
        { GroupId: testGroupId2 },
      ]);
      mockPrincipalStore.putGroupMembershipCache.mockResolvedValue(undefined);

      const result = await getGroupMemberships(testUserId, services);

      expect(result).toEqual([testGroupId1, testGroupId2]);
      expect((mockIdcService as any).listGroupsForUser).toHaveBeenCalledWith(
        testUserId,
      );
      expect(mockPrincipalStore.putGroupMembershipCache).toHaveBeenCalledTimes(
        1,
      );
      const written = getFirstCacheWritten();
      expect(written.pk).toBe(`user#${testUserId}`);
      expect(written.sk).toBe("groupMembership");
      expect(written.groupIds).toEqual([testGroupId1, testGroupId2]);
      expect(written.ttl).toBeGreaterThan(Math.floor(now().valueOf() / 1000));
    });

    it("writes cache record with TTL approximately 24 hours in the future", async () => {
      const fixedNow = DateTime.fromISO("2026-01-15T12:00:00Z", {
        zone: "utc",
      });
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow.toJSDate());

      mockPrincipalStore.getGroupMembershipCache.mockResolvedValue({
        result: undefined,
      });
      (mockIdcService as any).listGroupsForUser.mockResolvedValue([
        { GroupId: testGroupId1 },
      ]);

      await getGroupMemberships(testUserId, services);

      const written = getFirstCacheWritten();
      const expectedTtl = Math.floor(
        fixedNow.plus({ days: GROUP_MEMBERSHIP_CACHE_TTL_DAYS }).valueOf() /
          1000,
      );
      expect(written.ttl).toBe(expectedTtl);
    });

    it("writes empty cache record when user belongs to no groups", async () => {
      mockPrincipalStore.getGroupMembershipCache.mockResolvedValue({
        result: undefined,
      });
      (mockIdcService as any).listGroupsForUser.mockResolvedValue([]);

      const result = await getGroupMemberships(testUserId, services);

      expect(result).toEqual([]);
      const written = getFirstCacheWritten();
      expect(written.groupIds).toEqual([]);
    });
  });

  describe("cache expired", () => {
    it("refreshes cache when ttl is in the past", async () => {
      const pastTtl = Math.floor(now().valueOf() / 1000) - 60 * 60; // 1h ago
      mockPrincipalStore.getGroupMembershipCache.mockResolvedValue({
        result: {
          pk: `user#${testUserId}`,
          sk: "groupMembership",
          groupIds: ["stale-group-id"],
          ttl: pastTtl,
        },
      });
      (mockIdcService as any).listGroupsForUser.mockResolvedValue([
        { GroupId: testGroupId1 },
      ]);

      const result = await getGroupMemberships(testUserId, services);

      expect(result).toEqual([testGroupId1]);
      expect((mockIdcService as any).listGroupsForUser).toHaveBeenCalledWith(
        testUserId,
      );
      expect(mockPrincipalStore.putGroupMembershipCache).toHaveBeenCalledTimes(
        1,
      );
    });

    it("treats ttl exactly equal to now as expired", async () => {
      const fixedNow = DateTime.fromISO("2026-01-15T12:00:00Z", {
        zone: "utc",
      });
      vi.useFakeTimers();
      vi.setSystemTime(fixedNow.toJSDate());

      const nowEpochSeconds = Math.floor(fixedNow.valueOf() / 1000);
      mockPrincipalStore.getGroupMembershipCache.mockResolvedValue({
        result: {
          pk: `user#${testUserId}`,
          sk: "groupMembership",
          groupIds: ["stale"],
          ttl: nowEpochSeconds,
        },
      });
      (mockIdcService as any).listGroupsForUser.mockResolvedValue([
        { GroupId: testGroupId1 },
      ]);

      const result = await getGroupMemberships(testUserId, services);

      expect(result).toEqual([testGroupId1]);
      expect((mockIdcService as any).listGroupsForUser).toHaveBeenCalled();
    });
  });

  describe("error propagation", () => {
    it("propagates errors from getGroupMembershipCache", async () => {
      mockPrincipalStore.getGroupMembershipCache.mockRejectedValue(
        new Error("DDB read failed"),
      );

      await expect(getGroupMemberships(testUserId, services)).rejects.toThrow(
        "DDB read failed",
      );
      expect((mockIdcService as any).listGroupsForUser).not.toHaveBeenCalled();
    });

    it("propagates errors from listGroupsForUser without writing cache", async () => {
      mockPrincipalStore.getGroupMembershipCache.mockResolvedValue({
        result: undefined,
      });
      (mockIdcService as any).listGroupsForUser.mockRejectedValue(
        new Error("IDC throttled"),
      );

      await expect(getGroupMemberships(testUserId, services)).rejects.toThrow(
        "IDC throttled",
      );
      expect(mockPrincipalStore.putGroupMembershipCache).not.toHaveBeenCalled();
    });

    it("propagates errors from putGroupMembershipCache after successful IDC call", async () => {
      mockPrincipalStore.getGroupMembershipCache.mockResolvedValue({
        result: undefined,
      });
      (mockIdcService as any).listGroupsForUser.mockResolvedValue([
        { GroupId: testGroupId1 },
      ]);
      mockPrincipalStore.putGroupMembershipCache.mockRejectedValue(
        new Error("DDB write failed"),
      );

      await expect(getGroupMemberships(testUserId, services)).rejects.toThrow(
        "DDB write failed",
      );
    });
  });
});
