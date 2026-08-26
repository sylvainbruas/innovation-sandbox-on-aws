// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ResourceCount } from "@amzn/innovation-sandbox-commons/data/cleanup-report/cleanup-report.js";
import { GlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { ListResourcesResult } from "@amzn/innovation-sandbox-commons/isb-services/resource-explorer-service.js";

import { CleanupValidationMode } from "@amzn/innovation-sandbox-commons/data/config/config.js";
import type { CleanupContext } from "@amzn/innovation-sandbox-durable-cleanup-orchestration/steps/types.js";
import { validateCleanup } from "@amzn/innovation-sandbox-durable-cleanup-orchestration/steps/validate-cleanup.js";

function createMockContext(): CleanupContext {
  return {
    durableContext: {
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    },
    accountId: "123456789012",
  } as unknown as CleanupContext;
}

function createCleanupConfig(
  failureAction: CleanupValidationMode = "Quarantine",
): GlobalConfig["cleanup"] {
  return {
    validation: {
      failureAction,
    },
  } as unknown as GlobalConfig["cleanup"];
}

describe("validateCleanup", () => {
  describe("clean validation (no remaining resources)", () => {
    it("should pass when no resources remain after cleanup", () => {
      const ctx = createMockContext();
      const beforeCleanup: ResourceCount = {
        totalCount: 5,
        ignoredCount: 2,
        byType: { "ec2:instance": 3, "s3:bucket": 2 },
      };
      const afterResult: ListResourcesResult = {
        remainingResources: [],
        ignoredResources: [
          {
            Arn: "arn:aws:iam::123:role/service-role",
            ResourceType: "iam:role",
            Region: "global",
          },
        ],
        errors: [],
        exhaustive: true,
      };

      const result = validateCleanup(
        ctx,
        createCleanupConfig("Quarantine"),
        beforeCleanup,
        { totalCount: 0, ignoredCount: 0, byType: {} },
        afterResult,
      );

      expect(result.passed).toBe(true);
      expect(result.enforced).toBe(true);
      expect(result.resourceSummary.remainingTypes).toEqual([]);
      expect(result.remainingResources).toHaveLength(0);
      expect(result.remainingResourcesTotalCount).toBe(0);
    });
  });

  describe("failed validation with Quarantine enforcement", () => {
    it("should fail and enforce when resources remain and failureAction is Quarantine", () => {
      const ctx = createMockContext();
      const beforeCleanup: ResourceCount = {
        totalCount: 5,
        ignoredCount: 0,
        byType: { "ec2:instance": 3, "s3:bucket": 2 },
      };
      const afterResult: ListResourcesResult = {
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
      };

      const result = validateCleanup(
        ctx,
        createCleanupConfig("Quarantine"),
        beforeCleanup,
        { totalCount: 0, ignoredCount: 0, byType: {} },
        afterResult,
      );

      expect(result.passed).toBe(false);
      expect(result.enforced).toBe(true);
      expect(result.resourceSummary.remainingTypes).toEqual(["ec2:instance"]);
      expect(result.remainingResources).toHaveLength(1);
      expect(result.remainingResources[0]).toEqual({
        arn: "arn:aws:ec2:us-east-1:123:instance/i-1",
        resourceType: "ec2:instance",
        region: "us-east-1",
      });
      expect(ctx.durableContext.logger.error).toHaveBeenCalled();
    });
  });

  describe("failed validation with Warn enforcement", () => {
    it("should fail but not enforce when failureAction is Warn", () => {
      const ctx = createMockContext();
      const beforeCleanup: ResourceCount = {
        totalCount: 3,
        ignoredCount: 0,
        byType: { "ec2:instance": 3 },
      };
      const afterResult: ListResourcesResult = {
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
      };

      const result = validateCleanup(
        ctx,
        createCleanupConfig("Warn"),
        beforeCleanup,
        { totalCount: 0, ignoredCount: 0, byType: {} },
        afterResult,
      );

      expect(result.passed).toBe(false);
      expect(result.enforced).toBe(false);
      expect(ctx.durableContext.logger.warn).toHaveBeenCalled();
    });
  });

  describe("remaining resources capping", () => {
    it("should cap remaining resources at 100 entries", () => {
      const ctx = createMockContext();
      const beforeCleanup: ResourceCount = {
        totalCount: 200,
        ignoredCount: 0,
        byType: { "ec2:instance": 200 },
      };

      // Create 120 remaining resources
      const remainingResources = Array.from({ length: 120 }, (_, i) => ({
        Arn: `arn:aws:ec2:us-east-1:123:instance/i-${i}`,
        ResourceType: "ec2:instance",
        Region: "us-east-1",
      }));

      const afterResult: ListResourcesResult = {
        remainingResources,
        ignoredResources: [],
        errors: [],
        exhaustive: true,
      };

      const result = validateCleanup(
        ctx,
        createCleanupConfig("Quarantine"),
        beforeCleanup,
        { totalCount: 0, ignoredCount: 0, byType: {} },
        afterResult,
      );

      expect(result.remainingResources).toHaveLength(100);
      expect(result.remainingResourcesTotalCount).toBe(120);
    });
  });

  describe("resource summary structure", () => {
    it("should produce correct resourceSummary with before/after data", () => {
      const ctx = createMockContext();
      const beforeCleanup: ResourceCount = {
        totalCount: 10,
        ignoredCount: 3,
        byType: { "ec2:instance": 5, "s3:bucket": 3, "logs:log-group": 2 },
      };
      const afterResult: ListResourcesResult = {
        remainingResources: [
          {
            Arn: "arn:aws:logs:us-east-1:123:log-group:test",
            ResourceType: "logs:log-group",
            Region: "us-east-1",
          },
        ],
        ignoredResources: [
          {
            Arn: "arn:aws:iam::123:role/service-role",
            ResourceType: "iam:role",
            Region: "global",
          },
        ],
        errors: [],
        exhaustive: true,
      };

      const result = validateCleanup(
        ctx,
        createCleanupConfig("Quarantine"),
        beforeCleanup,
        { totalCount: 0, ignoredCount: 0, byType: {} },
        afterResult,
      );

      expect(result.resourceSummary.beforeCleanup).toEqual(beforeCleanup);
      expect(result.resourceSummary.afterCooldown).toEqual({
        totalCount: 1,
        ignoredCount: 1,
        byType: { "logs:log-group": 1 },
      });
      expect(result.resourceSummary.remainingTypes).toEqual(["logs:log-group"]);
    });
  });

  describe("staleness signal on the resource summary", () => {
    it("captures validation mode and RE enumeration data-quality flags for the AccountCleanupCompleted metric", () => {
      const ctx = createMockContext();
      const beforeCleanup: ResourceCount = {
        totalCount: 5,
        ignoredCount: 0,
        byType: { "ec2:instance": 3, "s3:bucket": 2 },
      };
      const afterResult: ListResourcesResult = {
        remainingResources: [
          {
            Arn: "arn:aws:ec2:us-east-1:123:instance/i-1",
            ResourceType: "ec2:instance",
            Region: "us-east-1",
          },
        ],
        ignoredResources: [],
        errors: [{ region: "eu-west-1", error: "throttled" }],
        exhaustive: false,
      };

      const result = validateCleanup(
        ctx,
        createCleanupConfig("Silent"),
        beforeCleanup,
        { totalCount: 0, ignoredCount: 0, byType: {} },
        afterResult,
      );

      expect(result.resourceSummary).toMatchObject({
        validationMode: "Silent",
        afterCooldown: { byType: { "ec2:instance": 1 } },
      });
    });
  });
});

describe("validateCleanupStep", () => {
  // We test the throw behavior by importing the function and mocking its
  // internal dependencies. Since validateCleanupStep calls enumerateResources
  // and validateCleanup internally, we mock at the boundary level.

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  let validateCleanupStep: (typeof import("@amzn/innovation-sandbox-durable-cleanup-orchestration/steps/validate-cleanup.js"))["validateCleanupStep"];

  beforeAll(async () => {
    // Dynamic import to allow vi.mock to take effect
    const mod =
      await import("@amzn/innovation-sandbox-durable-cleanup-orchestration/steps/validate-cleanup.js");
    validateCleanupStep = mod.validateCleanupStep;
  });

  function createStepContext(
    overrides?: Partial<CleanupContext>,
  ): CleanupContext {
    return {
      accountId: "123456789012",
      executionArn: "arn:aws:lambda:us-east-1:123:function:cleanup:exec-1",
      cleanupReason: "LEASE_TERMINATION",
      env: { USER_AGENT_EXTRA: "test" } as any,
      accountStore: {
        acquireLock: vi.fn().mockResolvedValue(undefined),
      },
      reportWriter: {
        updateReport: vi.fn().mockResolvedValue(undefined),
      },
      durableContext: {
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      },
      ...overrides,
    } as unknown as CleanupContext;
  }

  it("should throw when validation fails and enforcement is Quarantine", async () => {
    const ctx = createStepContext();
    const globalConfig = createCleanupConfig("Quarantine");
    const beforeCleanup: ResourceCount = {
      totalCount: 5,
      ignoredCount: 0,
      byType: { "ec2:instance": 5 },
    };

    // Mock IsbServices.resourceExplorer to return remaining resources
    const { IsbServices } =
      await import("@amzn/innovation-sandbox-commons/isb-services/index.js");
    vi.spyOn(IsbServices, "resourceExplorer").mockReturnValue({
      listResources: vi.fn().mockResolvedValue([
        {
          Arn: "arn:aws:ec2:us-east-1:123:instance/i-1",
          ResourceType: "ec2:instance",
          Region: "us-east-1",
        },
      ]),
    } as any);

    // Mock enumerateResources at module level
    const enumerateModule =
      await import("@amzn/innovation-sandbox-durable-cleanup-orchestration/steps/enumerate-resources.js");
    vi.spyOn(enumerateModule, "enumerateResources").mockResolvedValue({
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

    await expect(
      validateCleanupStep(
        ctx,
        globalConfig,
        beforeCleanup,
        { totalCount: 0, ignoredCount: 0, byType: {} },
        {
          managedRegions: ["us-east-1"],
          exclusionConfig: {
            excludedArnPatterns: [],
            excludedResourceTypes: [],
          },
        },
      ),
    ).rejects.toThrow("Post-cleanup validation failed");

    // Verify the report was still updated before throwing
    expect(ctx.reportWriter.updateReport).toHaveBeenCalledWith(
      undefined, // reportKey is undefined in our mock context
      expect.objectContaining({
        resourceSummary: expect.objectContaining({
          validationMode: "Quarantine",
        }),
      }),
    );
  });

  it("should NOT throw when validation fails but enforcement is Warn", async () => {
    const ctx = createStepContext();
    const globalConfig = createCleanupConfig("Warn");
    const beforeCleanup: ResourceCount = {
      totalCount: 5,
      ignoredCount: 0,
      byType: { "ec2:instance": 5 },
    };

    const { IsbServices } =
      await import("@amzn/innovation-sandbox-commons/isb-services/index.js");
    vi.spyOn(IsbServices, "resourceExplorer").mockReturnValue({
      listResources: vi.fn().mockResolvedValue([
        {
          Arn: "arn:aws:ec2:us-east-1:123:instance/i-1",
          ResourceType: "ec2:instance",
          Region: "us-east-1",
        },
      ]),
    } as any);

    const enumerateModule =
      await import("@amzn/innovation-sandbox-durable-cleanup-orchestration/steps/enumerate-resources.js");
    vi.spyOn(enumerateModule, "enumerateResources").mockResolvedValue({
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

    const result = await validateCleanupStep(
      ctx,
      globalConfig,
      beforeCleanup,
      { totalCount: 0, ignoredCount: 0, byType: {} },
      {
        managedRegions: ["us-east-1"],
        exclusionConfig: { excludedArnPatterns: [], excludedResourceTypes: [] },
      },
    );

    expect(result.passed).toBe(false);
    expect(result.enforced).toBe(false);
  });

  it("should NOT throw and NOT enforce when validation fails but mode is Silent", async () => {
    const ctx = createStepContext();
    const globalConfig = createCleanupConfig("Silent");
    const beforeCleanup: ResourceCount = {
      totalCount: 5,
      ignoredCount: 0,
      byType: { "ec2:instance": 5 },
    };

    const enumerateModule =
      await import("@amzn/innovation-sandbox-durable-cleanup-orchestration/steps/enumerate-resources.js");
    vi.spyOn(enumerateModule, "enumerateResources").mockResolvedValue({
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

    const result = await validateCleanupStep(
      ctx,
      globalConfig,
      beforeCleanup,
      { totalCount: 0, ignoredCount: 0, byType: {} },
      {
        managedRegions: ["us-east-1"],
        exclusionConfig: { excludedArnPatterns: [], excludedResourceTypes: [] },
      },
    );

    expect(result.passed).toBe(false);
    expect(result.enforced).toBe(false);
  });
});
