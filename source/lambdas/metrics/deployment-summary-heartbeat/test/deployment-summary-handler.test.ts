// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DeploymentSummaryLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/deployment-summary-lambda-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  createEventBridgeEvent,
  mockContext,
  mockGlobalConfig,
} from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  bulkStubEnv,
  mockAppConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { Logger } from "@aws-lambda-powertools/logger";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const testEnv = generateSchemaData(DeploymentSummaryLambdaEnvironmentSchema);
const mockedGlobalConfig = mockGlobalConfig();
const mockedReportingConfig = {
  costReportGroups: ["test-group"],
  requireCostReportGroup: false,
};

let handler: any;

// The individual collectors are unit-tested in metrics-collectors.test.ts; here
// they are mocked so the test exercises only the handler's orchestration:
// wiring each collector, degrading on failure, and assembling the log payload.
const mockSummarizeAccountPool = vi.fn();
const mockGetScpMetrics = vi.fn();
const mockSummarizeBlueprints = vi.fn();
const mockSummarizeMultiUserLeases = vi.fn();
const mockCountM2mClients = vi.fn();
const mockCollectApiCallsByAuthType = vi.fn();

const mockLeaseTemplateStore = { findAll: vi.fn() };

vi.spyOn(Logger.prototype, "info").mockImplementation(() => {});
vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});

beforeAll(async () => {
  bulkStubEnv(testEnv);

  const { DynamoConfigStore } = await import(
    "@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js"
  );
  vi.doMock("@amzn/innovation-sandbox-commons/isb-services/index.js", () => ({
    IsbServices: {
      leaseTemplateStore: vi.fn().mockReturnValue(mockLeaseTemplateStore),
      blueprintStore: vi.fn().mockReturnValue({}),
      orgsService: vi.fn().mockReturnValue({}),
      configStore: vi.fn(
        () => new DynamoConfigStore({ client: {} as any, tableName: "test" }),
      ),
      accountPoolStackConfigStore: vi
        .fn()
        .mockReturnValue({ get: vi.fn().mockResolvedValue({}) }),
      principalStore: vi.fn().mockReturnValue({}),
    },
  }));

  vi.doMock("@amzn/innovation-sandbox-commons/sdk-clients/index.js", () => ({
    IsbClients: {
      cloudFormation: vi.fn().mockReturnValue({}),
      accessAnalyzer: vi.fn().mockReturnValue({}),
      iam: vi.fn().mockReturnValue({}),
      cloudWatch: vi.fn().mockReturnValue({}),
    },
  }));

  vi.doMock(
    "@amzn/innovation-sandbox-deployment-summary-heartbeat/m2m-client-discovery.js",
    () => ({
      countM2mClients: mockCountM2mClients,
    }),
  );

  vi.doMock(
    "@amzn/innovation-sandbox-deployment-summary-heartbeat/api-call-mix.js",
    () => ({
      collectApiCallsByAuthType: mockCollectApiCallsByAuthType,
    }),
  );

  vi.doMock(
    "@amzn/innovation-sandbox-deployment-summary-heartbeat/metrics-collectors.js",
    () => ({
      summarizeAccountPool: mockSummarizeAccountPool,
      getScpMetrics: mockGetScpMetrics,
      summarizeBlueprints: mockSummarizeBlueprints,
      summarizeMultiUserLeases: mockSummarizeMultiUserLeases,
    }),
  );

  const module =
    await import("@amzn/innovation-sandbox-deployment-summary-heartbeat/deployment-summary-handler.js");
  handler = module.handler;
});

beforeEach(() => {
  bulkStubEnv(testEnv);
  mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);
  vi.clearAllMocks();

  mockLeaseTemplateStore.findAll.mockResolvedValue({
    result: [
      { leaseTemplateId: "t1", blueprintId: "bp-1" },
      { leaseTemplateId: "t2", blueprintId: undefined },
    ],
    nextPageIdentifier: null,
  });
  mockCountM2mClients.mockResolvedValue(0);
  mockSummarizeAccountPool.mockResolvedValue({
    available: 0,
    active: 0,
    frozen: 0,
    cleanup: 0,
    quarantine: 0,
  });
  mockGetScpMetrics.mockResolvedValue({
    additionalAllowedServicesList: [],
    bedrockInferenceProfilePatternsList: [],
  });
  mockSummarizeBlueprints.mockResolvedValue({
    numBlueprints: 0,
    blueprintServiceCounts: {},
  });
  mockSummarizeMultiUserLeases.mockResolvedValue({
    numTemplatesWithSharing: 0,
    numLeasesWithAssignments: 0,
    totalUserAssignments: 0,
    totalGroupAssignments: 0,
    avgAssignmentsPerLease: 0,
    maxAssignmentsPerLease: 0,
  });
  mockCollectApiCallsByAuthType.mockResolvedValue({ m2m: 0, user: 0 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("deployment-summary-handler", () => {
  const mockedContext = mockContext(testEnv);
  const scheduleEvent = createEventBridgeEvent("Scheduled Event", {});

  it("assembles the deployment summary from every collector", async () => {
    mockCountM2mClients.mockResolvedValue(7);
    mockSummarizeBlueprints.mockResolvedValue({
      numBlueprints: 1,
      blueprintServiceCounts: { S3: 2 },
    });
    mockSummarizeAccountPool.mockResolvedValue({
      available: 5,
      active: 3,
      frozen: 1,
      cleanup: 0,
      quarantine: 2,
    });
    mockGetScpMetrics.mockResolvedValue({
      additionalAllowedServicesList: ["sts:*"],
      bedrockInferenceProfilePatternsList: ["us.*"],
    });
    mockSummarizeMultiUserLeases.mockResolvedValue({
      numTemplatesWithSharing: 1,
      numLeasesWithAssignments: 2,
      totalUserAssignments: 3,
      totalGroupAssignments: 1,
      avgAssignmentsPerLease: 2,
      maxAssignmentsPerLease: 3,
    });
    mockCollectApiCallsByAuthType.mockResolvedValue({ m2m: 4, user: 12 });

    await handler(scheduleEvent, mockedContext);

    expect(mockCountM2mClients).toHaveBeenCalledWith(
      expect.anything(),
      testEnv.ISB_NAMESPACE,
    );
    expect(Logger.prototype.info).toHaveBeenCalledWith(
      "ISB Deployment Summary",
      expect.objectContaining({
        logDetailType: "DeploymentSummary",
        numM2mClients: 7,
        numLeaseTemplates: 2,
        numLeaseTemplatesWithBlueprint: 1,
        numBlueprints: 1,
        blueprintServiceCounts: { S3: 2 },
        // Full config-block assertion: assembling this from globalConfig /
        // reportingConfig is real handler logic (the collectors are mocked), so
        // every field is pinned to its source value.
        config: {
          numCostReportGroups: mockedReportingConfig.costReportGroups.length,
          requireMaxBudget: mockedGlobalConfig.leases.requireMaxBudget,
          maxBudget: mockedGlobalConfig.leases.maxBudget,
          requireMaxDuration: mockedGlobalConfig.leases.requireMaxDuration,
          maxDurationHours: mockedGlobalConfig.leases.maxDurationHours,
          maxLeasesPerUser: mockedGlobalConfig.leases.maxLeasesPerUser,
          requireCostReportGroup: mockedReportingConfig.requireCostReportGroup,
          numberOfFailedAttemptsToCancelCleanup:
            mockedGlobalConfig.cleanup.numberOfFailedAttemptsToCancelCleanup,
          waitBeforeRetryFailedAttemptSeconds:
            mockedGlobalConfig.cleanup.waitBeforeRetryFailedAttemptSeconds,
          numberOfSuccessfulAttemptsToFinishCleanup:
            mockedGlobalConfig.cleanup
              .numberOfSuccessfulAttemptsToFinishCleanup,
          waitBeforeRerunSuccessfulAttemptSeconds:
            mockedGlobalConfig.cleanup.waitBeforeRerunSuccessfulAttemptSeconds,
          isStableTaggingEnabled: testEnv.IS_STABLE_TAGGING_ENABLED === "Yes",
          isMultiAccountDeployment:
            testEnv.ORG_MGT_ACCOUNT_ID !== testEnv.HUB_ACCOUNT_ID,
          allowUserLeaseTermination:
            mockedGlobalConfig.leases.allowUserLeaseTermination,
          leaseRequestWindowHours:
            mockedGlobalConfig.leases.leaseRequestWindowHours,
          maxLeaseRequestsPerWindow:
            mockedGlobalConfig.leases.maxLeaseRequestsPerWindow,
          leaseSharingEnabled: mockedGlobalConfig.leases.leaseSharingEnabled,
          enablePrincipalSearch:
            mockedGlobalConfig.leases.enablePrincipalSearch,
        },
        accountPool: {
          available: 5,
          active: 3,
          frozen: 1,
          cleanup: 0,
          quarantine: 2,
        },
        additionalAllowedServicesList: ["sts:*"],
        bedrockInferenceProfilePatternsList: ["us.*"],
        numTemplatesWithSharing: 1,
        numLeasesWithAssignments: 2,
        totalUserAssignments: 3,
        totalGroupAssignments: 1,
        avgAssignmentsPerLease: 2,
        maxAssignmentsPerLease: 3,
        dailyApiCallsByAuthType: { m2m: 4, user: 12 },
      }),
    );
  });

  it("degrades the api call-mix collector to zero counts without sinking the heartbeat", async () => {
    mockCollectApiCallsByAuthType.mockRejectedValue(
      new Error("GetMetricData blew up"),
    );

    await handler(scheduleEvent, mockedContext);

    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("dailyApiCallsByAuthType"),
      expect.objectContaining({ error: expect.any(String) }),
    );
    expect(Logger.prototype.info).toHaveBeenCalledWith(
      "ISB Deployment Summary",
      expect.objectContaining({
        logDetailType: "DeploymentSummary",
        dailyApiCallsByAuthType: { m2m: 0, user: 0 },
      }),
    );
  });

  it("passes the fetched lease templates into the dependent collector", async () => {
    await handler(scheduleEvent, mockedContext);

    // leaseTemplates is fetched once in the handler and fanned out; the
    // multi-user-lease collector consumes that shared array.
    expect(mockSummarizeMultiUserLeases).toHaveBeenCalledWith(
      [
        { leaseTemplateId: "t1", blueprintId: "bp-1" },
        { leaseTemplateId: "t2", blueprintId: undefined },
      ],
      expect.anything(),
    );
  });

  it("degrades a failing collector to its fallback without sinking the heartbeat", async () => {
    mockSummarizeMultiUserLeases.mockRejectedValue(
      new Error("principals scan blew up"),
    );
    mockCountM2mClients.mockResolvedValue(3);

    await handler(scheduleEvent, mockedContext);

    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("multiUserLeases"),
      expect.objectContaining({ error: expect.any(String) }),
    );
    expect(Logger.prototype.info).toHaveBeenCalledWith(
      "ISB Deployment Summary",
      expect.objectContaining({
        logDetailType: "DeploymentSummary",
        numM2mClients: 3,
        numLeasesWithAssignments: 0,
        totalUserAssignments: 0,
        maxAssignmentsPerLease: 0,
      }),
    );
  });

  it("degrades leaseTemplates and blueprints to zero counts and still emits when they fail", async () => {
    mockLeaseTemplateStore.findAll.mockRejectedValue(
      new Error("lease template table unavailable"),
    );
    mockSummarizeBlueprints.mockRejectedValue(
      new Error("blueprint table unavailable"),
    );

    await handler(scheduleEvent, mockedContext);

    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("leaseTemplates"),
      expect.objectContaining({ error: expect.any(String) }),
    );
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("blueprints"),
      expect.objectContaining({ error: expect.any(String) }),
    );
    expect(Logger.prototype.info).toHaveBeenCalledWith(
      "ISB Deployment Summary",
      expect.objectContaining({
        logDetailType: "DeploymentSummary",
        numLeaseTemplates: 0,
        numLeaseTemplatesWithBlueprint: 0,
        numBlueprints: 0,
      }),
    );
  });
});
