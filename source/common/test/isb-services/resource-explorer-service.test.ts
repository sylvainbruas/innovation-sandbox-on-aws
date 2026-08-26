// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ResourceExclusionFilter } from "@amzn/innovation-sandbox-commons/isb-services/resource-exclusion-filter.js";
import { ResourceExplorerService } from "@amzn/innovation-sandbox-commons/isb-services/resource-explorer-service.js";
import { paginateListViews } from "@aws-sdk/client-resource-explorer-2";

// Mock the ResourceExplorer2Client
const mockSend = vi.fn();

vi.mock("@aws-sdk/client-resource-explorer-2", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@aws-sdk/client-resource-explorer-2")
    >();
  return {
    ...actual,
    ResourceExplorer2Client: class MockResourceExplorer2Client {
      private readonly region: string;
      constructor(config: { region: string }) {
        this.region = config.region;
      }
      // Pass the client's region so region-aware tests (parallel index
      // creation) can dispatch without depending on call ordering.
      send = (command: unknown) => mockSend(command, this.region);
    },
    paginateListViews: vi.fn(),
  };
});

vi.mock(
  "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js",
  () => ({
    fromTemporaryIsbSandboxAccountCredentials: () => async () => ({
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
      sessionToken: "TOKEN",
    }),
  }),
);

function createService(
  managedRegions: string[] = ["us-east-1"],
): ResourceExplorerService {
  return new ResourceExplorerService({
    intermediateRoleArn: "arn:aws:iam::111111111111:role/IntermediateRole",
    spokeRoleName: "InnovationSandbox-CleanupRole",
    customUserAgent: "test-user-agent",
    managedRegions,
    exclusionFilter: new ResourceExclusionFilter({
      excludedResourceTypes: [],
      excludedArnPatterns: ["arn:aws:iam::*:role/InnovationSandbox-*"],
    }),
  });
}

/** Drives the mocked ListViews paginator with the given pages, in order. */
function setupListViewsPaginator(pages: { Views?: string[] }[]) {
  vi.mocked(paginateListViews).mockImplementation(async function* () {
    for (const page of pages) {
      yield page;
    }
  } as any);
}

describe("ResourceExplorerService", () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) so a mockImplementation set by one test
    // does not leak into tests that rely on the mockResolvedValueOnce queue.
    vi.resetAllMocks();
  });

  describe("input validation", () => {
    it("rejects non-12-digit account ID", async () => {
      const service = createService();

      await expect(service.listResources("1234")).rejects.toThrow(
        "Invalid account ID format: expected exactly 12 digits",
      );
    });

    it("rejects account ID with non-digit characters", async () => {
      const service = createService();

      await expect(service.listResources("12345678901a")).rejects.toThrow(
        "Invalid account ID format: expected exactly 12 digits",
      );
    });

    it("accepts valid 12-digit account ID", async () => {
      mockSend.mockResolvedValueOnce({ Resources: [], NextToken: undefined });

      const service = createService();
      const result = await service.listResources("123456789012");

      expect(result.remainingResources).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.exhaustive).toBe(true);
    });
  });

  describe("enumeration", () => {
    it("always searches us-east-1 for global resources even with no managed regions", async () => {
      // us-east-1 is always included so global/edge resources are validated.
      mockSend.mockResolvedValueOnce({ Resources: [], NextToken: undefined });

      const service = createService([]);
      const result = await service.listResources("123456789012");

      expect(result.remainingResources).toEqual([]);
      expect(result.ignoredResources).toEqual([]);
      expect(result.errors).toEqual([]);
      // Exactly one region searched: us-east-1
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("adds us-east-1 to the searched regions when not already managed", async () => {
      mockSend
        .mockResolvedValueOnce({
          Resources: [
            { Arn: "arn:aws:s3:::eu-bucket", ResourceType: "s3:bucket" },
          ],
          NextToken: undefined,
        }) // eu-west-1
        .mockResolvedValueOnce({ Resources: [], NextToken: undefined }); // us-east-1 (added)

      const service = createService(["eu-west-1"]);
      const result = await service.listResources("123456789012");

      expect(result.remainingResources).toHaveLength(1);
      // eu-west-1 + us-east-1
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("does not duplicate us-east-1 when it is already a managed region", async () => {
      mockSend
        .mockResolvedValueOnce({ Resources: [], NextToken: undefined }) // us-east-1
        .mockResolvedValueOnce({ Resources: [], NextToken: undefined }); // eu-west-1

      const service = createService(["us-east-1", "eu-west-1"]);
      await service.listResources("123456789012");

      // Two regions only — us-east-1 is not searched twice
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("returns empty results when no resources exist", async () => {
      mockSend.mockResolvedValueOnce({ Resources: [], NextToken: undefined });

      const service = createService();
      const result = await service.listResources("123456789012");

      expect(result.remainingResources).toEqual([]);
      expect(result.ignoredResources).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it("paginates through all results", async () => {
      mockSend
        .mockResolvedValueOnce({
          Resources: [
            {
              Arn: "arn:aws:ec2:us-east-1:123456789012:instance/i-1",
              ResourceType: "ec2:instance",
            },
          ],
          NextToken: "page2",
        })
        .mockResolvedValueOnce({
          Resources: [
            { Arn: "arn:aws:s3:::bucket-1", ResourceType: "s3:bucket" },
          ],
          NextToken: undefined,
        });

      const service = createService();
      const result = await service.listResources("123456789012");

      expect(result.remainingResources).toHaveLength(2);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("queries multiple managed regions", async () => {
      mockSend
        .mockResolvedValueOnce({
          Resources: [
            {
              Arn: "arn:aws:ec2:us-east-1:123456789012:instance/i-1",
              ResourceType: "ec2:instance",
            },
          ],
          NextToken: undefined,
        })
        .mockResolvedValueOnce({
          Resources: [
            { Arn: "arn:aws:s3:::eu-bucket", ResourceType: "s3:bucket" },
          ],
          NextToken: undefined,
        });

      const service = createService(["us-east-1", "eu-west-1"]);
      const result = await service.listResources("123456789012");

      expect(result.remainingResources).toHaveLength(2);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("handles undefined Resources in response", async () => {
      mockSend.mockResolvedValueOnce({
        Resources: undefined,
        NextToken: undefined,
      });

      const service = createService();
      const result = await service.listResources("123456789012");

      expect(result.remainingResources).toEqual([]);
      expect(result.ignoredResources).toEqual([]);
    });
  });

  describe("region failure isolation", () => {
    it("returns partial results when one region fails", async () => {
      mockSend
        .mockResolvedValueOnce({
          Resources: [
            {
              Arn: "arn:aws:ec2:us-east-1:123456789012:instance/i-1",
              ResourceType: "ec2:instance",
            },
          ],
          NextToken: undefined,
        })
        .mockRejectedValueOnce(
          new Error("Resource Explorer not enabled in this region"),
        );

      const service = createService(["us-east-1", "eu-west-1"]);
      const result = await service.listResources("123456789012");

      expect(result.remainingResources).toHaveLength(1);
      expect(result.remainingResources[0]!.ResourceType).toBe("ec2:instance");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.region).toBe("eu-west-1");
      expect(result.errors[0]!.error).toContain("not enabled");
    });

    it("returns all errors when all regions fail", async () => {
      mockSend
        .mockRejectedValueOnce(new Error("Region 1 failed"))
        .mockRejectedValueOnce(new Error("Region 2 failed"));

      const service = createService(["us-east-1", "eu-west-1"]);
      const result = await service.listResources("123456789012");

      expect(result.remainingResources).toEqual([]);
      expect(result.ignoredResources).toEqual([]);
      expect(result.errors).toHaveLength(2);
    });
  });

  describe("pagination guard", () => {
    it("returns partial results with exhaustive=false when max pages exceeded", async () => {
      // Mock 10 pages all with NextToken to trigger the safety limit
      for (let i = 0; i < 10; i++) {
        mockSend.mockResolvedValueOnce({
          Resources: [
            {
              Arn: `arn:aws:ec2:us-east-1:123456789012:instance/i-${i}`,
              ResourceType: "ec2:instance",
            },
          ],
          NextToken: `page-${i + 1}`,
        });
      }

      const service = createService();
      const result = await service.listResources("123456789012");

      // Partial results are preserved
      expect(result.remainingResources).toHaveLength(10);
      // No error — truncation is graceful
      expect(result.errors).toHaveLength(0);
      // Signals that enumeration was not exhaustive
      expect(result.exhaustive).toBe(false);
    });

    it("returns exhaustive=true when pagination completes naturally at max pages", async () => {
      // Mock exactly 10 pages where the last page has no NextToken
      for (let i = 0; i < 9; i++) {
        mockSend.mockResolvedValueOnce({
          Resources: [
            {
              Arn: `arn:aws:ec2:us-east-1:123456789012:instance/i-${i}`,
              ResourceType: "ec2:instance",
            },
          ],
          NextToken: `page-${i + 1}`,
        });
      }
      mockSend.mockResolvedValueOnce({
        Resources: [
          {
            Arn: "arn:aws:ec2:us-east-1:123456789012:instance/i-9",
            ResourceType: "ec2:instance",
          },
        ],
        NextToken: undefined,
      });

      const service = createService();
      const result = await service.listResources("123456789012");

      expect(result.remainingResources).toHaveLength(10);
      expect(result.errors).toHaveLength(0);
      expect(result.exhaustive).toBe(true);
    });
  });

  describe("ensureIndexes", () => {
    it("rejects non-12-digit account ID", async () => {
      const service = createService();

      await expect(service.ensureIndexes("1234")).rejects.toThrow(
        "Invalid account ID format: expected exactly 12 digits",
      );
    });

    it("is a no-op create when the index and default view already exist", async () => {
      // GetIndex → ACTIVE, GetDefaultView → has ViewArn
      mockSend
        .mockResolvedValueOnce({ Arn: "arn:index", State: "ACTIVE" })
        .mockResolvedValueOnce({ ViewArn: "arn:view" });

      const service = createService(["us-east-1"]);
      const result = await service.ensureIndexes("123456789012");

      expect(result.indexes).toEqual([
        { region: "us-east-1", created: false, state: "ACTIVE" },
      ]);
      // GetIndex + GetDefaultView only — no create calls
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("creates a default view when the index exists without one", async () => {
      mockSend
        .mockResolvedValueOnce({ Arn: "arn:index", State: "ACTIVE" }) // GetIndex
        .mockResolvedValueOnce({ ViewArn: undefined }) // GetDefaultView (none)
        .mockResolvedValueOnce({ View: { ViewArn: "arn:new-view" } }) // CreateView
        .mockResolvedValueOnce({}); // AssociateDefaultView

      const service = createService(["us-east-1"]);
      const result = await service.ensureIndexes("123456789012");

      expect(result.indexes[0]).toEqual({
        region: "us-east-1",
        created: false,
        state: "ACTIVE",
      });
      expect(mockSend).toHaveBeenCalledTimes(4);
    });

    it("creates an index + default view when none exists", async () => {
      const { ResourceNotFoundException } =
        await import("@aws-sdk/client-resource-explorer-2");
      mockSend
        .mockRejectedValueOnce(
          new ResourceNotFoundException({
            message: "no index",
            $metadata: {},
          }),
        ) // GetIndex → not found
        .mockResolvedValueOnce({ Arn: "arn:index", State: "CREATING" }) // CreateIndex
        .mockResolvedValueOnce({ ViewArn: undefined }) // GetDefaultView
        .mockResolvedValueOnce({ View: { ViewArn: "arn:new-view" } }) // CreateView
        .mockResolvedValueOnce({}); // AssociateDefaultView

      const service = createService(["us-east-1"]);
      const result = await service.ensureIndexes("123456789012");

      expect(result.indexes[0]).toEqual({
        region: "us-east-1",
        created: true,
        state: "CREATING",
      });
      expect(mockSend).toHaveBeenCalledTimes(5);
    });

    it("creates a replacement index when GetIndex reports a DELETED index", async () => {
      // GetIndex returns 200 with State=DELETED (not ResourceNotFoundException)
      // after the index is deleted, so a replacement must still be created.
      mockSend
        .mockResolvedValueOnce({ Arn: "arn:index", State: "DELETED" }) // GetIndex
        .mockResolvedValueOnce({ Arn: "arn:index2", State: "CREATING" }) // CreateIndex
        .mockResolvedValueOnce({ ViewArn: undefined }) // GetDefaultView
        .mockResolvedValueOnce({ View: { ViewArn: "arn:new-view" } }) // CreateView
        .mockResolvedValueOnce({}); // AssociateDefaultView

      const service = createService(["us-east-1"]);
      const result = await service.ensureIndexes("123456789012");

      expect(result.indexes[0]).toEqual({
        region: "us-east-1",
        created: true,
        state: "CREATING",
        viewError: undefined,
      });
    });

    it("creates a replacement index when GetIndex reports a DELETING index", async () => {
      mockSend
        .mockResolvedValueOnce({ Arn: "arn:index", State: "DELETING" }) // GetIndex
        .mockResolvedValueOnce({ Arn: "arn:index2", State: "CREATING" }) // CreateIndex
        .mockResolvedValueOnce({ ViewArn: "arn:view" }); // GetDefaultView

      const service = createService(["us-east-1"]);
      const result = await service.ensureIndexes("123456789012");

      expect(result.indexes[0]!.created).toBe(true);
    });

    it("reports a view failure without discarding a successful index creation", async () => {
      // View creation against a not-yet-ACTIVE index can be rejected; the index
      // result must survive so the region is not reported as index-less.
      mockSend
        .mockResolvedValueOnce({ Arn: "arn:index", State: "DELETED" }) // GetIndex
        .mockResolvedValueOnce({ Arn: "arn:index2", State: "CREATING" }) // CreateIndex
        .mockResolvedValueOnce({ ViewArn: undefined }) // GetDefaultView
        .mockRejectedValueOnce(new Error("Unauthorized")); // CreateView

      const service = createService(["us-east-1"]);
      const result = await service.ensureIndexes("123456789012");

      expect(result.indexes[0]).toMatchObject({
        region: "us-east-1",
        created: true,
        state: "CREATING",
        viewError: "Unauthorized",
      });
      // Not an index-level error — the index exists.
      expect(result.indexes[0]!.error).toBeUndefined();
    });

    it("recovers the existing view when CreateView conflicts on the name", async () => {
      // A prior run created the view but failed before associating it as
      // default: CreateView now conflicts, so the ARN must be looked up and
      // associated rather than failing the region.
      const { ConflictException } =
        await import("@aws-sdk/client-resource-explorer-2");
      mockSend
        .mockResolvedValueOnce({ Arn: "arn:index", State: "ACTIVE" }) // GetIndex
        .mockResolvedValueOnce({ ViewArn: undefined }) // GetDefaultView (none)
        .mockRejectedValueOnce(
          new ConflictException({
            message: "error",
            Message: "error",
            $metadata: {},
          }),
        ) // CreateView
        .mockResolvedValueOnce({}); // AssociateDefaultView
      setupListViewsPaginator([
        {
          Views: [
            "arn:aws:resource-explorer-2:us-east-1:123456789012:view/other-view/abc",
            "arn:aws:resource-explorer-2:us-east-1:123456789012:view/isb-post-cleanup-validator/def",
          ],
        },
      ]);

      const service = createService(["us-east-1"]);
      const result = await service.ensureIndexes("123456789012");

      expect(result.indexes[0]!.viewError).toBeUndefined();
      // The existing validator view was associated as the default.
      expect(mockSend).toHaveBeenLastCalledWith(
        expect.objectContaining({
          input: {
            ViewArn:
              "arn:aws:resource-explorer-2:us-east-1:123456789012:view/isb-post-cleanup-validator/def",
          },
        }),
        "us-east-1",
      );
    });

    it("pages through ListViews to find the validator view on a later page", async () => {
      // The per-region view quota (10) means one page suffices today, but the
      // lookup must still walk every page if that quota is ever raised.
      const { ConflictException } =
        await import("@aws-sdk/client-resource-explorer-2");
      mockSend
        .mockResolvedValueOnce({ Arn: "arn:index", State: "ACTIVE" }) // GetIndex
        .mockResolvedValueOnce({ ViewArn: undefined }) // GetDefaultView (none)
        .mockRejectedValueOnce(
          new ConflictException({
            message: "exists",
            Message: "exists",
            $metadata: {},
          }),
        ) // CreateView
        .mockResolvedValueOnce({}); // AssociateDefaultView
      setupListViewsPaginator([
        {
          Views: [
            "arn:aws:resource-explorer-2:us-east-1:123456789012:view/other-view/abc",
          ],
        }, // page 1 — no match
        {
          Views: [
            "arn:aws:resource-explorer-2:us-east-1:123456789012:view/isb-post-cleanup-validator/def",
          ],
        }, // page 2 — match
      ]);

      const service = createService(["us-east-1"]);
      const result = await service.ensureIndexes("123456789012");

      expect(result.indexes[0]!.viewError).toBeUndefined();
      // The view from the second page was associated as the default.
      expect(mockSend).toHaveBeenLastCalledWith(
        expect.objectContaining({
          input: {
            ViewArn:
              "arn:aws:resource-explorer-2:us-east-1:123456789012:view/isb-post-cleanup-validator/def",
          },
        }),
        "us-east-1",
      );
    });

    it("isolates per-region failures without aborting other regions", async () => {
      // Regions are ensured in parallel, so dispatch on region rather than call
      // order: eu-west-1 fails, us-east-1 succeeds.
      mockSend.mockImplementation(
        (command: { constructor: { name: string } }, region: string) => {
          if (region === "eu-west-1") {
            return Promise.reject(new Error("index creation blocked"));
          }
          switch (command.constructor.name) {
            case "GetIndexCommand":
              return Promise.resolve({ Arn: "arn:index", State: "ACTIVE" });
            case "GetDefaultViewCommand":
              return Promise.resolve({ ViewArn: "arn:view" });
            default:
              return Promise.resolve({});
          }
        },
      );

      const service = createService(["us-east-1", "eu-west-1"]);
      const result = await service.ensureIndexes("123456789012");

      expect(result.indexes).toHaveLength(2);
      expect(result.indexes[0]).toEqual({
        region: "us-east-1",
        created: false,
        state: "ACTIVE",
      });
      expect(result.indexes[1]!.region).toBe("eu-west-1");
      expect(result.indexes[1]!.error).toContain("index creation blocked");
    });

    it("propagates a non-ResourceNotFound GetIndex error as a region error", async () => {
      mockSend.mockRejectedValueOnce(new Error("AccessDenied"));

      const service = createService(["us-east-1"]);
      const result = await service.ensureIndexes("123456789012");

      expect(result.indexes[0]!.error).toContain("AccessDenied");
    });

    it("ensures an index in us-east-1 for global resources when not managed", async () => {
      // Both regions: existing ACTIVE index with a default view.
      mockSend.mockImplementation(
        (command: { constructor: { name: string } }) => {
          switch (command.constructor.name) {
            case "GetIndexCommand":
              return Promise.resolve({ Arn: "arn:index", State: "ACTIVE" });
            case "GetDefaultViewCommand":
              return Promise.resolve({ ViewArn: "arn:view" });
            default:
              return Promise.resolve({});
          }
        },
      );

      const service = createService(["eu-west-1"]);
      const result = await service.ensureIndexes("123456789012");

      expect(result.indexes.map((i) => i.region)).toEqual([
        "eu-west-1",
        "us-east-1",
      ]);
      expect(result.indexes.every((i) => !i.error)).toBe(true);
    });
  });

  describe("filtering", () => {
    it("delegates filtering to the exclusion filter", async () => {
      mockSend.mockResolvedValueOnce({
        Resources: [
          {
            Arn: "arn:aws:ec2:us-east-1:123456789012:instance/i-1",
            ResourceType: "ec2:instance",
          },
          {
            Arn: "arn:aws:iam::123456789012:role/InnovationSandbox-CleanupRole",
            ResourceType: "iam:role",
          },
        ],
        NextToken: undefined,
      });

      const service = createService();
      const result = await service.listResources("123456789012");

      expect(result.remainingResources).toHaveLength(1);
      expect(result.remainingResources[0]!.ResourceType).toBe("ec2:instance");
      expect(result.ignoredResources).toHaveLength(1);
      expect(result.ignoredResources[0]!.Arn).toContain(
        "InnovationSandbox-CleanupRole",
      );
      expect(result.errors).toEqual([]);
    });
  });
});
