// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";

import { ResourceExplorerService } from "@amzn/innovation-sandbox-commons/isb-services/resource-explorer-service.js";

import {
  enumerateResources,
  summarizeResources,
} from "@amzn/innovation-sandbox-durable-cleanup-orchestration/steps/enumerate-resources.js";

import type { ListResourcesResult } from "@amzn/innovation-sandbox-commons/isb-services/resource-explorer-service.js";
import type { CleanupContext } from "@amzn/innovation-sandbox-durable-cleanup-orchestration/steps/types.js";

function createMockContext(
  overrides?: Partial<CleanupContext>,
): CleanupContext {
  return {
    durableContext: {
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    },
    env: {} as any,
    accountId: "123456789012",
    executionArn: "arn:aws:lambda:us-east-1:123:function:cleanup:exec-1",
    cleanupReason: "LEASE_TERMINATION",
    executionStartTime: "2026-01-01T00:00:00.000Z",
    accountStore: {
      acquireLock: vi.fn().mockResolvedValue({}),
    },
    eventBridge: {} as any,
    organizationsTaggingService: {} as any,
    reportWriter: {} as any,
    reportKey: {} as any,
    ...overrides,
  } as unknown as CleanupContext;
}

function createMockResourceExplorerService(
  listResourcesResult: ListResourcesResult,
): ResourceExplorerService {
  return {
    listResources: vi.fn().mockResolvedValue(listResourcesResult),
  } as unknown as ResourceExplorerService;
}

describe("summarizeResources", () => {
  it("should summarize resources by type and count", () => {
    const result: ListResourcesResult = {
      remainingResources: [
        {
          Arn: "arn:aws:ec2:us-east-1:123:instance/i-1",
          ResourceType: "ec2:instance",
          Region: "us-east-1",
        },
        {
          Arn: "arn:aws:ec2:us-east-1:123:instance/i-2",
          ResourceType: "ec2:instance",
          Region: "us-east-1",
        },
        {
          Arn: "arn:aws:s3:::my-bucket",
          ResourceType: "s3:bucket",
          Region: "us-east-1",
        },
      ],
      ignoredResources: [
        {
          Arn: "arn:aws:iam::123:role/aws-service-role/foo",
          ResourceType: "iam:role",
          Region: "global",
        },
      ],
      errors: [],
      exhaustive: true,
    };

    const summary = summarizeResources(result);

    expect(summary.totalCount).toBe(3);
    expect(summary.ignoredCount).toBe(1);
    expect(summary.byType).toEqual({
      "ec2:instance": 2,
      "s3:bucket": 1,
    });
  });

  it("should handle empty resources", () => {
    const result: ListResourcesResult = {
      remainingResources: [],
      ignoredResources: [],
      errors: [],
      exhaustive: true,
    };

    const summary = summarizeResources(result);

    expect(summary.totalCount).toBe(0);
    expect(summary.ignoredCount).toBe(0);
    expect(summary.byType).toEqual({});
  });

  it("should handle resources with undefined ResourceType", () => {
    const result: ListResourcesResult = {
      remainingResources: [
        { Arn: "arn:aws:foo:us-east-1:123:bar", Region: "us-east-1" },
      ],
      ignoredResources: [],
      errors: [],
      exhaustive: true,
    };

    const summary = summarizeResources(result);

    expect(summary.totalCount).toBe(1);
    expect(summary.byType).toEqual({ unknown: 1 });
  });
});

describe("enumerateResources (before cleanup)", () => {
  it("should renew lock, enumerate resources, and return summary", async () => {
    const ctx = createMockContext();
    const service = createMockResourceExplorerService({
      remainingResources: [
        {
          Arn: "arn:aws:ec2:us-east-1:123:instance/i-1",
          ResourceType: "ec2:instance",
          Region: "us-east-1",
        },
      ],
      ignoredResources: [],
      errors: [],
      exhaustive: true,
    });

    const result = await enumerateResources(ctx, service);

    expect(service.listResources).toHaveBeenCalledWith("123456789012");
    expect(result.remainingResources).toHaveLength(1);
    expect(result.remainingResources[0]!.ResourceType).toBe("ec2:instance");
  });

  it("should log warning on partial failures but still return results", async () => {
    const ctx = createMockContext();
    const service = createMockResourceExplorerService({
      remainingResources: [
        {
          Arn: "arn:aws:s3:::bucket",
          ResourceType: "s3:bucket",
          Region: "us-east-1",
        },
      ],
      ignoredResources: [],
      errors: [{ region: "eu-west-1", error: "AccessDenied" }],
      exhaustive: true,
    });

    const result = await enumerateResources(ctx, service);

    expect(ctx.durableContext.logger.warn).toHaveBeenCalled();
    expect(result.remainingResources).toHaveLength(1);
  });
});

describe("enumerateResources (after cleanup)", () => {
  it("should enumerate resources and return full ListResourcesResult", async () => {
    const ctx = createMockContext();
    const service = createMockResourceExplorerService({
      remainingResources: [],
      ignoredResources: [
        {
          Arn: "arn:aws:iam::123:role/aws-service-role/foo",
          ResourceType: "iam:role",
          Region: "global",
        },
      ],
      errors: [],
      exhaustive: true,
    });

    const result = await enumerateResources(ctx, service);

    expect(service.listResources).toHaveBeenCalledWith("123456789012");
    expect(result.remainingResources).toHaveLength(0);
    expect(result.ignoredResources).toHaveLength(1);
  });
});
