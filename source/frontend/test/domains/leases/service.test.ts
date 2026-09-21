// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  LeaseView,
  SharedLeaseView,
} from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import { LeaseService } from "@amzn/innovation-sandbox-frontend/domains/leases/service";
import { SmithyLeaseApi } from "@amzn/innovation-sandbox-frontend/domains/leases/smithy-client";

function stubApi(overrides: Partial<SmithyLeaseApi> = {}): SmithyLeaseApi {
  return {
    listLeases: vi.fn(),
    getLease: vi.fn(),
    requestLease: vi.fn(),
    updateLease: vi.fn(),
    reviewLease: vi.fn(),
    terminateLease: vi.fn(),
    freezeLease: vi.fn(),
    unfreezeLease: vi.fn(),
    getAssignments: vi.fn(),
    updateAssignments: vi.fn(),
    listSharedLeases: vi.fn(),
    ...overrides,
  };
}

const lease = (leaseId: string): LeaseView =>
  ({
    leaseId,
    userEmail: "owner@example.com",
    status: "Active",
  }) as unknown as LeaseView;

const shared = (leaseId: string): SharedLeaseView =>
  ({
    leaseId,
    userEmail: "owner@example.com",
    uuid: `uuid-${leaseId}`,
    status: "Active",
    accessType: "direct",
  }) as unknown as SharedLeaseView;

describe("LeaseService", () => {
  describe("getLeases", () => {
    it("follows the continuation token across pages", async () => {
      const listLeases = vi
        .fn()
        .mockResolvedValueOnce({
          result: [lease("lease-1")],
          nextPageIdentifier: "page-2",
        })
        .mockResolvedValueOnce({
          result: [lease("lease-2")],
          nextPageIdentifier: null,
        });
      const service = new LeaseService(stubApi({ listLeases }));

      const leases = await service.getLeases();

      expect(leases.map((l) => l.leaseId)).toEqual(["lease-1", "lease-2"]);
      // pageIdentifier is undefined on the first call, then the returned cursor.
      expect(listLeases).toHaveBeenNthCalledWith(1, undefined, undefined);
      expect(listLeases).toHaveBeenNthCalledWith(2, "page-2", undefined);
    });

    it("forwards the userEmail filter on every page", async () => {
      const listLeases = vi.fn().mockResolvedValue({
        result: [],
        nextPageIdentifier: null,
      });
      const service = new LeaseService(stubApi({ listLeases }));

      await service.getLeases("user@example.com");

      expect(listLeases).toHaveBeenCalledWith(undefined, "user@example.com");
    });
  });

  describe("delegation", () => {
    it("delegates single-target methods to the adapter", async () => {
      const api = stubApi();
      const service = new LeaseService(api);

      await service.getLeaseById("lease-1");
      await service.requestNewLease({ leaseTemplateUuid: "tmpl-1" });
      await service.updateLease({ leaseId: "lease-1", maxSpend: 10 });
      await service.reviewLease("lease-1", true);
      await service.terminateLease("lease-1");
      await service.freezeLease("lease-1");
      await service.unfreezeLease("lease-1");
      await service.getAssignments("lease-1");
      await service.updateAssignments("lease-1", [
        { principalId: "p1", principalType: "USER" },
      ]);

      expect(api.getLease).toHaveBeenCalledWith("lease-1");
      expect(api.requestLease).toHaveBeenCalledWith({
        leaseTemplateUuid: "tmpl-1",
      });
      expect(api.updateLease).toHaveBeenCalledWith({
        leaseId: "lease-1",
        maxSpend: 10,
      });
      expect(api.reviewLease).toHaveBeenCalledWith("lease-1", true);
      expect(api.terminateLease).toHaveBeenCalledWith("lease-1");
      expect(api.freezeLease).toHaveBeenCalledWith("lease-1");
      expect(api.unfreezeLease).toHaveBeenCalledWith("lease-1");
      expect(api.getAssignments).toHaveBeenCalledWith("lease-1");
      expect(api.updateAssignments).toHaveBeenCalledWith("lease-1", [
        { principalId: "p1", principalType: "USER" },
      ]);
    });
  });

  describe("getSharedLeases", () => {
    it("should fetch all pages exhaustively and return combined results", async () => {
      const listSharedLeases = vi
        .fn()
        .mockResolvedValueOnce({
          result: [shared("lease-1")],
          nextPageIdentifier: "cursor-2",
        })
        .mockResolvedValueOnce({
          result: [shared("lease-2")],
          nextPageIdentifier: null,
        });
      const service = new LeaseService(stubApi({ listSharedLeases }));

      const result = await service.getSharedLeases("user-id-1", "direct");

      expect(result.result).toHaveLength(2);
      expect(result.result[0]!.leaseId).toBe("lease-1");
      expect(result.result[1]!.leaseId).toBe("lease-2");
      expect(result.nextPageIdentifier).toBeNull();

      expect(listSharedLeases).toHaveBeenCalledTimes(2);
      // userId, accessType, maxResults=100, then the returned cursor.
      expect(listSharedLeases).toHaveBeenNthCalledWith(
        1,
        "user-id-1",
        "direct",
        100,
        undefined,
      );
      expect(listSharedLeases).toHaveBeenNthCalledWith(
        2,
        "user-id-1",
        "direct",
        100,
        "cursor-2",
      );
    });

    it("should return single page when nextPageIdentifier is null on first call", async () => {
      const listSharedLeases = vi.fn().mockResolvedValueOnce({
        result: [shared("lease-1")],
        nextPageIdentifier: null,
      });
      const service = new LeaseService(stubApi({ listSharedLeases }));

      const result = await service.getSharedLeases("user-id-1", "group");

      expect(result.result).toHaveLength(1);
      expect(result.nextPageIdentifier).toBeNull();
      expect(listSharedLeases).toHaveBeenCalledTimes(1);
    });

    it("should return empty result when no shared leases exist", async () => {
      const listSharedLeases = vi.fn().mockResolvedValueOnce({
        result: [],
        nextPageIdentifier: null,
      });
      const service = new LeaseService(stubApi({ listSharedLeases }));

      const result = await service.getSharedLeases("user-id-1", "direct");

      expect(result.result).toHaveLength(0);
      expect(result.nextPageIdentifier).toBeNull();
    });

    it("should pass accessType=group when specified", async () => {
      const listSharedLeases = vi.fn().mockResolvedValueOnce({
        result: [],
        nextPageIdentifier: null,
      });
      const service = new LeaseService(stubApi({ listSharedLeases }));

      await service.getSharedLeases("user-id-1", "group");

      expect(listSharedLeases).toHaveBeenCalledWith(
        "user-id-1",
        "group",
        100,
        undefined,
      );
    });

    it("should handle three pages of results", async () => {
      const listSharedLeases = vi
        .fn()
        .mockResolvedValueOnce({
          result: [shared("1")],
          nextPageIdentifier: "cursor-2",
        })
        .mockResolvedValueOnce({
          result: [shared("2")],
          nextPageIdentifier: "cursor-3",
        })
        .mockResolvedValueOnce({
          result: [shared("3")],
          nextPageIdentifier: null,
        });
      const service = new LeaseService(stubApi({ listSharedLeases }));

      const result = await service.getSharedLeases("user-id-1", "direct");

      expect(result.result).toHaveLength(3);
      expect(listSharedLeases).toHaveBeenCalledTimes(3);
    });

    it("should propagate errors that occur mid-pagination", async () => {
      const listSharedLeases = vi
        .fn()
        .mockResolvedValueOnce({
          result: [shared("1")],
          nextPageIdentifier: "cursor-2",
        })
        .mockRejectedValueOnce(new Error("Network error on page 2"));
      const service = new LeaseService(stubApi({ listSharedLeases }));

      await expect(
        service.getSharedLeases("user-id-1", "direct"),
      ).rejects.toThrow("Network error on page 2");
    });

    it("should stop at MAX_PAGES to prevent infinite loops", async () => {
      // Always return a non-null cursor (simulates a broken backend).
      const listSharedLeases = vi.fn().mockResolvedValue({
        result: [shared("item")],
        nextPageIdentifier: "always-more",
      });
      const service = new LeaseService(stubApi({ listSharedLeases }));

      const result = await service.getSharedLeases("user-id-1", "direct");

      // Should stop at 50 pages (MAX_PAGES).
      expect(listSharedLeases).toHaveBeenCalledTimes(50);
      expect(result.result).toHaveLength(50);
      // Preserves nextPageIdentifier to indicate truncation.
      expect(result.nextPageIdentifier).toBe("always-more");
    });
  });
});
