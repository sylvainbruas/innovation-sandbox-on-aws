// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { LeaseService } from "@amzn/innovation-sandbox-frontend/domains/leases/service";
import { IApiProxy } from "@amzn/innovation-sandbox-frontend/helpers/ApiProxy";

const createMockApi = (): IApiProxy => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
});

describe("LeaseService", () => {
  describe("getSharedLeases", () => {
    it("should fetch all pages exhaustively and return combined results", async () => {
      const mockApi = createMockApi();
      const service = new LeaseService(mockApi);

      const page1Lease = {
        leaseId: "lease-1",
        userEmail: "owner@example.com",
        uuid: "uuid-1",
        status: "Active",
        accessType: "direct",
      };
      const page2Lease = {
        leaseId: "lease-2",
        userEmail: "owner2@example.com",
        uuid: "uuid-2",
        status: "Active",
        accessType: "direct",
      };

      (mockApi.get as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          result: [page1Lease],
          nextPageIdentifier: "cursor-2",
        })
        .mockResolvedValueOnce({
          result: [page2Lease],
          nextPageIdentifier: null,
        });

      const result = await service.getSharedLeases("user-id-1", "direct");

      expect(result.result).toHaveLength(2);
      expect(result.result[0]).toEqual(page1Lease);
      expect(result.result[1]).toEqual(page2Lease);
      expect(result.nextPageIdentifier).toBeNull();

      // Verify pagination params
      expect(mockApi.get).toHaveBeenCalledTimes(2);
      expect(mockApi.get).toHaveBeenCalledWith(
        expect.stringContaining("userId=user-id-1"),
      );
      expect(mockApi.get).toHaveBeenCalledWith(
        expect.stringContaining("accessType=direct"),
      );
      expect(mockApi.get).toHaveBeenCalledWith(
        expect.stringContaining("maxResults=100"),
      );
      // Second call should include pageIdentifier
      expect(mockApi.get).toHaveBeenLastCalledWith(
        expect.stringContaining("pageIdentifier=cursor-2"),
      );
    });

    it("should return single page when nextPageIdentifier is null on first call", async () => {
      const mockApi = createMockApi();
      const service = new LeaseService(mockApi);

      const lease = {
        leaseId: "lease-1",
        userEmail: "owner@example.com",
        uuid: "uuid-1",
        status: "Active",
        accessType: "group",
        sourceGroupName: "Team A",
      };

      (mockApi.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        result: [lease],
        nextPageIdentifier: null,
      });

      const result = await service.getSharedLeases("user-id-1", "group");

      expect(result.result).toHaveLength(1);
      expect(result.result[0]).toEqual(lease);
      expect(result.nextPageIdentifier).toBeNull();
      expect(mockApi.get).toHaveBeenCalledTimes(1);
    });

    it("should return empty result when no shared leases exist", async () => {
      const mockApi = createMockApi();
      const service = new LeaseService(mockApi);

      (mockApi.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        result: [],
        nextPageIdentifier: null,
      });

      const result = await service.getSharedLeases("user-id-1", "direct");

      expect(result.result).toHaveLength(0);
      expect(result.nextPageIdentifier).toBeNull();
    });

    it("should pass accessType=group when specified", async () => {
      const mockApi = createMockApi();
      const service = new LeaseService(mockApi);

      (mockApi.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        result: [],
        nextPageIdentifier: null,
      });

      await service.getSharedLeases("user-id-1", "group");

      expect(mockApi.get).toHaveBeenCalledWith(
        expect.stringContaining("accessType=group"),
      );
    });

    it("should handle three pages of results", async () => {
      const mockApi = createMockApi();
      const service = new LeaseService(mockApi);

      (mockApi.get as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          result: [{ leaseId: "1" }],
          nextPageIdentifier: "cursor-2",
        })
        .mockResolvedValueOnce({
          result: [{ leaseId: "2" }],
          nextPageIdentifier: "cursor-3",
        })
        .mockResolvedValueOnce({
          result: [{ leaseId: "3" }],
          nextPageIdentifier: null,
        });

      const result = await service.getSharedLeases("user-id-1", "direct");

      expect(result.result).toHaveLength(3);
      expect(mockApi.get).toHaveBeenCalledTimes(3);
    });

    it("should propagate errors that occur mid-pagination", async () => {
      const mockApi = createMockApi();
      const service = new LeaseService(mockApi);

      (mockApi.get as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          result: [{ leaseId: "1" }],
          nextPageIdentifier: "cursor-2",
        })
        .mockRejectedValueOnce(new Error("Network error on page 2"));

      await expect(
        service.getSharedLeases("user-id-1", "direct"),
      ).rejects.toThrow("Network error on page 2");
    });

    it("should stop at MAX_PAGES to prevent infinite loops", async () => {
      const mockApi = createMockApi();
      const service = new LeaseService(mockApi);

      // Always return a non-null cursor (simulates broken backend)
      (mockApi.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        result: [{ leaseId: "item" }],
        nextPageIdentifier: "always-more",
      });

      const result = await service.getSharedLeases("user-id-1", "direct");

      // Should stop at 50 pages (MAX_PAGES)
      expect(mockApi.get).toHaveBeenCalledTimes(50);
      expect(result.result).toHaveLength(50);
      // Preserves nextPageIdentifier to indicate truncation
      expect(result.nextPageIdentifier).toBe("always-more");
    });
  });
});
