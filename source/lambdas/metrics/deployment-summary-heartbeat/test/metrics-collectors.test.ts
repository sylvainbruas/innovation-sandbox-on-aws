// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import {
  AccessAnalyzerClient,
  ValidatePolicyCommand,
} from "@aws-sdk/client-accessanalyzer";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getScpMetrics,
  summarizeAccountPool,
  summarizeBlueprints,
  summarizeMultiUserLeases,
} from "@amzn/innovation-sandbox-deployment-summary-heartbeat/metrics-collectors.js";

function fakeLogger() {
  return { warn: vi.fn() } as unknown as Logger;
}

const accountPoolConfig = {
  additionalAllowedServices: undefined,
  bedrockInferenceProfilePatterns: undefined,
} as any;

describe("summarizeAccountPool", () => {
  it("counts accounts in each OU status", async () => {
    const listAllAccountsInOU = vi
      .fn()
      .mockResolvedValueOnce([{ id: "1" }]) // Available
      .mockResolvedValueOnce([{ id: "2" }, { id: "3" }]) // Active
      .mockResolvedValueOnce([]) // Frozen
      .mockResolvedValueOnce([{ id: "4" }]) // CleanUp
      .mockResolvedValueOnce([]); // Quarantine

    await expect(
      summarizeAccountPool({ listAllAccountsInOU } as any),
    ).resolves.toEqual({
      available: 1,
      active: 2,
      frozen: 0,
      cleanup: 1,
      quarantine: 0,
    });
  });
});

describe("getScpMetrics", () => {
  const accessAnalyzerMock = mockClient(AccessAnalyzerClient);

  beforeEach(() => {
    accessAnalyzerMock.reset();
    accessAnalyzerMock.on(ValidatePolicyCommand).resolves({ findings: [] });
  });

  it("returns validated services and parsed bedrock patterns", async () => {
    const result = await getScpMetrics(
      fakeLogger(),
      {
        additionalAllowedServices: "sts:*,support:*,tag:*",
        bedrockInferenceProfilePatterns:
          "arn:aws:bedrock:*:*:inference-profile/*,arn:aws:bedrock:*:*:inference-profile/us.*",
      } as any,
      accessAnalyzerMock as unknown as AccessAnalyzerClient,
    );

    expect(result).toEqual({
      additionalAllowedServicesList: ["sts:*", "support:*", "tag:*"],
      bedrockInferenceProfilePatternsList: ["*", "us.*"],
    });
  });

  it("returns empty lists when config fields are absent", async () => {
    await expect(
      getScpMetrics(
        fakeLogger(),
        accountPoolConfig,
        accessAnalyzerMock as unknown as AccessAnalyzerClient,
      ),
    ).resolves.toEqual({
      additionalAllowedServicesList: [],
      bedrockInferenceProfilePatternsList: [],
    });
  });

  it("filters out actions AccessAnalyzer reports as invalid", async () => {
    accessAnalyzerMock.on(ValidatePolicyCommand).resolves({
      findings: [
        {
          issueCode: "INVALID_SERVICE_IN_ACTION",
          findingType: "ERROR" as const,
          findingDetails:
            "The service fakesvc:fakeAction specified in the action does not exist.",
          learnMoreLink: undefined,
          locations: [
            {
              path: [
                { value: "Statement" },
                { index: 0 },
                { value: "Action" },
                { index: 1 },
              ],
              span: {
                start: { line: 0, column: 0, offset: 0 },
                end: { line: 0, column: 0, offset: 0 },
              },
            },
          ],
        },
      ],
    });

    const result = await getScpMetrics(
      fakeLogger(),
      { additionalAllowedServices: "sts:*,fakesvc:fakeAction" } as any,
      accessAnalyzerMock as unknown as AccessAnalyzerClient,
    );

    expect(result.additionalAllowedServicesList).toEqual(["sts:*"]);
  });

  it("filters out actions reported as INVALID_ACTION", async () => {
    accessAnalyzerMock.on(ValidatePolicyCommand).resolves({
      findings: [
        {
          issueCode: "INVALID_ACTION",
          findingType: "ERROR" as const,
          findingDetails: "The action s3:DoSomething does not exist.",
          learnMoreLink: undefined,
          locations: [
            {
              path: [
                { value: "Statement" },
                { index: 0 },
                { value: "Action" },
                { index: 1 },
              ],
              span: {
                start: { line: 0, column: 0, offset: 0 },
                end: { line: 0, column: 0, offset: 0 },
              },
            },
          ],
        },
      ],
    });

    const result = await getScpMetrics(
      fakeLogger(),
      { additionalAllowedServices: "sts:*,s3:DoSomething" } as any,
      accessAnalyzerMock as unknown as AccessAnalyzerClient,
    );

    expect(result.additionalAllowedServicesList).toEqual(["sts:*"]);
  });

  it("returns empty lists when config fields are empty strings", async () => {
    await expect(
      getScpMetrics(
        fakeLogger(),
        {
          additionalAllowedServices: "",
          bedrockInferenceProfilePatterns: "",
        } as any,
        accessAnalyzerMock as unknown as AccessAnalyzerClient,
      ),
    ).resolves.toEqual({
      additionalAllowedServicesList: [],
      bedrockInferenceProfilePatternsList: [],
    });
  });

  it("handles a mix of populated and empty config fields", async () => {
    const result = await getScpMetrics(
      fakeLogger(),
      {
        additionalAllowedServices: "bedrock:*",
        bedrockInferenceProfilePatterns: "",
      } as any,
      accessAnalyzerMock as unknown as AccessAnalyzerClient,
    );

    expect(result).toEqual({
      additionalAllowedServicesList: ["bedrock:*"],
      bedrockInferenceProfilePatternsList: [],
    });
  });

  it("falls back to an empty allowed-services list and warns when AccessAnalyzer fails", async () => {
    accessAnalyzerMock
      .on(ValidatePolicyCommand)
      .rejects(new Error("AccessDenied: User is not authorized"));
    const logger = fakeLogger();

    const result = await getScpMetrics(
      logger,
      {
        additionalAllowedServices: "sts:*,support:*",
        bedrockInferenceProfilePatterns:
          "arn:aws:bedrock:*:*:inference-profile/us.*",
      } as any,
      accessAnalyzerMock as unknown as AccessAnalyzerClient,
    );

    // additionalAllowedServicesList drops to [], but the bedrock patterns
    // (which make no API call) survive — the failure is isolated.
    expect(result).toEqual({
      additionalAllowedServicesList: [],
      bedrockInferenceProfilePatternsList: ["us.*"],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to validate IAM actions, skipping additionalAllowedServicesList metric",
      expect.objectContaining({
        error: "AccessDenied: User is not authorized",
      }),
    );
  });
});

describe("summarizeBlueprints", () => {
  // blueprintStore.listBlueprints is consumed via collect(stream(...)); it
  // returns one page of blueprints and no next page.
  function listBlueprintsOnce(blueprints: unknown[]) {
    return vi
      .fn()
      .mockResolvedValue({ result: blueprints, nextPageIdentifier: null });
  }

  it("counts blueprints and aggregates resource-type counts across stack sets", async () => {
    const blueprintStore = {
      listBlueprints: listBlueprintsOnce([
        { blueprint: { blueprintId: "bp-1" } },
      ]),
      get: vi.fn().mockResolvedValue({
        result: { stackSets: [{ stackSetId: "ss-1" }] },
      }),
    } as any;
    const cfnClient = {
      send: vi.fn().mockResolvedValue({
        ResourceTypes: [
          "AWS::S3::Bucket",
          "AWS::S3::Bucket",
          "AWS::Lambda::Function",
        ],
      }),
    } as any;

    await expect(
      summarizeBlueprints(fakeLogger(), blueprintStore, cfnClient),
    ).resolves.toEqual({
      numBlueprints: 1,
      blueprintServiceCounts: { S3: 2, Lambda: 1 },
    });
  });

  it("returns zero counts when there are no blueprints", async () => {
    const blueprintStore = {
      listBlueprints: listBlueprintsOnce([]),
      get: vi.fn(),
    } as any;

    await expect(
      summarizeBlueprints(fakeLogger(), blueprintStore, {
        send: vi.fn(),
      } as any),
    ).resolves.toEqual({ numBlueprints: 0, blueprintServiceCounts: {} });
  });

  it("skips a StackSet that fails to describe and warns, keeping the rest", async () => {
    const blueprintStore = {
      listBlueprints: listBlueprintsOnce([
        { blueprint: { blueprintId: "bp-1" } },
      ]),
      get: vi.fn().mockResolvedValue({
        result: {
          stackSets: [{ stackSetId: "ss-ok" }, { stackSetId: "ss-bad" }],
        },
      }),
    } as any;
    const cfnClient = {
      send: vi
        .fn()
        .mockResolvedValueOnce({ ResourceTypes: ["AWS::S3::Bucket"] })
        .mockRejectedValueOnce(new Error("AccessDenied")),
    } as any;
    const logger = fakeLogger();

    await expect(
      summarizeBlueprints(logger, blueprintStore, cfnClient),
    ).resolves.toEqual({
      numBlueprints: 1,
      blueprintServiceCounts: { S3: 1 },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to analyze StackSet",
      expect.objectContaining({ stackSetId: "ss-bad" }),
    );
  });
});

describe("summarizeMultiUserLeases", () => {
  it("computes sharing-template, assignment, and per-lease metrics", async () => {
    const leaseTemplates = [
      { allowOwnerToShareLease: true },
      { allowOwnerToShareLease: true },
      { allowOwnerToShareLease: false },
    ] as any;
    // lease-10 has 3 user assignments, lease-20 has 1 group assignment.
    const principalStore = {
      listAllAssignments: vi.fn().mockResolvedValue({
        result: [
          { principalType: "USER", leaseId: "lease-10" },
          { principalType: "USER", leaseId: "lease-10" },
          { principalType: "USER", leaseId: "lease-10" },
          { principalType: "GROUP", leaseId: "lease-20" },
        ],
        nextPageIdentifier: null,
      }),
    } as any;

    await expect(
      summarizeMultiUserLeases(leaseTemplates, principalStore),
    ).resolves.toEqual({
      numTemplatesWithSharing: 2,
      numLeasesWithAssignments: 2,
      totalUserAssignments: 3,
      totalGroupAssignments: 1,
      avgAssignmentsPerLease: 2,
      maxAssignmentsPerLease: 3,
    });
  });

  it("returns zeros when there are no assignments", async () => {
    const principalStore = {
      listAllAssignments: vi
        .fn()
        .mockResolvedValue({ result: [], nextPageIdentifier: null }),
    } as any;

    await expect(summarizeMultiUserLeases([], principalStore)).resolves.toEqual(
      {
        numTemplatesWithSharing: 0,
        numLeasesWithAssignments: 0,
        totalUserAssignments: 0,
        totalGroupAssignments: 0,
        avgAssignmentsPerLease: 0,
        maxAssignmentsPerLease: 0,
      },
    );
  });
});
