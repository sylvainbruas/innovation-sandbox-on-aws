// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CloudFormationClient,
  ListStackSetsCommand,
} from "@aws-sdk/client-cloudformation";
import { mockClient } from "aws-sdk-client-mock";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  PersistedBlueprintItem,
  PersistedBlueprintWithStackSets,
} from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint.js";
import { DynamoBlueprintStore } from "@amzn/innovation-sandbox-commons/data/blueprint/dynamo-blueprint-store.js";
import { DynamoLeaseTemplateStore } from "@amzn/innovation-sandbox-commons/data/lease-template/dynamo-lease-template-store.js";
import {
  BlueprintDeploymentService,
  StackSetNotFoundError,
  UnsupportedPermissionModelError,
} from "@amzn/innovation-sandbox-commons/isb-services/blueprint-deployment-service.js";
import { BlueprintLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/blueprint-lambda-environment.js";
import {
  createTestBlueprintItem,
  createTestDeploymentHistoryItem,
  createTestStackSetItem,
} from "@amzn/innovation-sandbox-commons/test/fixtures/blueprint-fixtures.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  createAPIGatewayProxyEvent,
  createErrorResponseBody,
  createFailureResponseBody,
  isbAuthorizedUser,
  jsendFailBodyLike,
  mockAuthorizedContext,
  mockGlobalConfig,
  rawBodyLike,
  responseHeaders,
  responseHeadersWithErrorType,
} from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  bulkStubEnv,
  mockAppConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
const mockCloudFormationClient = mockClient(CloudFormationClient);
const testEnv = generateSchemaData(BlueprintLambdaEnvironmentSchema, {
  BLUEPRINT_TABLE_NAME: "test-blueprint-table",
  LEASE_TEMPLATE_TABLE_NAME: "test-lease-template-table",
  INTERMEDIATE_ROLE_ARN: "arn:aws:iam::123456789012:role/IntermediateRole",
  SANDBOX_ACCOUNT_ROLE_NAME: "SandboxAccountRole",
  ORG_MGT_ACCOUNT_ID: "111111111111",
  HUB_ACCOUNT_ID: "222222222222",
});

const mockedGlobalConfig = mockGlobalConfig();

// The generated `restJson1` serializer emits only modeled members, so the internal
// DynamoDB fields the store returns (`PK`/`SK`/`itemType`) are projected off the
// wire (accepted deviation — no consumer reads them). `rawBodyLike` is
// order-insensitive and drops null/undefined but keeps these, so strip them from
// the expected fixtures. `meta` (incl. `schemaVersion`) IS kept — the frontend
// reads it.
function projectBlueprint<T extends Record<string, unknown>>(blueprint: T) {
  const { PK: _pk, SK: _sk, itemType: _itemType, ...rest } = blueprint;
  return rest;
}

// DeploymentHistory additionally drops the storage-only `ttl` + `meta`.
function projectDeployment<T extends Record<string, unknown>>(deployment: T) {
  const {
    PK: _pk,
    SK: _sk,
    itemType: _itemType,
    ttl: _ttl,
    meta: _meta,
    ...rest
  } = deployment;
  return rest;
}

function projectComposite(composite: {
  blueprint: Record<string, unknown>;
  stackSets: Record<string, unknown>[];
  recentDeployments?: Record<string, unknown>[];
}) {
  return {
    ...composite,
    blueprint: projectBlueprint(composite.blueprint),
    stackSets: composite.stackSets.map(projectBlueprint),
    ...(composite.recentDeployments
      ? {
          recentDeployments: composite.recentDeployments.map(projectDeployment),
        }
      : {}),
  };
}

let handler: typeof import("../src/blueprints-handler.js").handler;

beforeAll(async () => {
  bulkStubEnv(testEnv);
  handler = (await import("../src/blueprints-handler.js")).handler;
});

describe("Blueprint API Handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCloudFormationClient.reset();
    bulkStubEnv(testEnv);
    mockAppConfigMiddleware(mockedGlobalConfig);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("should return 500 response when environment variables are misconfigured", async () => {
    vi.unstubAllEnvs();
    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/blueprints",
      headers: {
        "Content-Type": "application/json",
      },
      isbUser: isbAuthorizedUser.user,
    });
    expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
      statusCode: 500,
      body: createErrorResponseBody("An unexpected error occurred."),
      headers: responseHeadersWithErrorType("InternalServerError"),
    });
  });

  describe("GET /blueprints/stacksets", () => {
    it("should list SELF_MANAGED StackSets only", async () => {
      mockCloudFormationClient.on(ListStackSetsCommand).resolves({
        Summaries: [
          {
            StackSetName: "self-managed-stackset",
            StackSetId: "self-managed-stackset:ss-123",
            PermissionModel: "SELF_MANAGED",
            Status: "ACTIVE",
            Description: "Test StackSet",
          },
          {
            StackSetName: "service-managed-stackset",
            StackSetId: "service-managed-stackset:ss-456",
            PermissionModel: "SERVICE_MANAGED",
            Status: "ACTIVE",
          },
        ],
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints/stacksets",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: {
            result: [
              {
                stackSetName: "self-managed-stackset",
                stackSetId: "self-managed-stackset:ss-123",
                description: "Test StackSet",
                status: "ACTIVE",
                permissionModel: "SELF_MANAGED",
              },
              {
                stackSetName: "service-managed-stackset",
                stackSetId: "service-managed-stackset:ss-456",
                status: "ACTIVE",
                permissionModel: "SERVICE_MANAGED",
              },
            ],
            nextPageIdentifier: undefined,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should handle empty StackSets list", async () => {
      mockCloudFormationClient.on(ListStackSetsCommand).resolves({
        Summaries: [],
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints/stacksets",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: {
            result: [],
            nextPageIdentifier: undefined,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return nextPageIdentifier when more results available", async () => {
      mockCloudFormationClient.on(ListStackSetsCommand).resolves({
        Summaries: [
          {
            StackSetName: "self-managed-stackset",
            StackSetId: "self-managed-stackset:ss-123",
            PermissionModel: "SELF_MANAGED",
            Status: "ACTIVE",
            Description: "Test StackSet",
          },
        ],
        NextToken: "next-page-token",
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints/stacksets",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: {
            result: [
              {
                stackSetName: "self-managed-stackset",
                stackSetId: "self-managed-stackset:ss-123",
                description: "Test StackSet",
                status: "ACTIVE",
                permissionModel: "SELF_MANAGED",
              },
            ],
            nextPageIdentifier: "next-page-token",
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should map maxResults to CloudFormation MaxResults", async () => {
      mockCloudFormationClient.on(ListStackSetsCommand).resolves({
        Summaries: [],
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints/stacksets",
        queryStringParameters: { maxResults: "7" },
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      await handler(event, mockAuthorizedContext(testEnv));

      const calls = mockCloudFormationClient.commandCalls(ListStackSetsCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0].input.MaxResults).toBe(7);
    });

    it("should return 400 for invalid pagination parameters", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints/stacksets",
        queryStringParameters: { maxResults: "999" },
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 400,
        // Accepted deviation: the model's `@range` (via jsendValidationCustomizer)
        // replaces the pre-Smithy Zod message; still a 400 ValidationError.
        body: jsendFailBodyLike({
          field: "maxResults",
          message:
            "Value at '/maxResults' failed to satisfy constraint: Member must be between 1 and 100, inclusive",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it("should filter AWSControlTower StackSets in org management account", async () => {
      // Test with ORG_MGT_ACCOUNT_ID === HUB_ACCOUNT_ID (org mgmt account)
      const orgMgmtEnv = {
        ...testEnv,
        ORG_MGT_ACCOUNT_ID: "111111111111",
        HUB_ACCOUNT_ID: "111111111111", // Same as org mgmt
      };

      // Stub the environment for this test
      bulkStubEnv(orgMgmtEnv);

      mockCloudFormationClient.reset();
      mockCloudFormationClient.on(ListStackSetsCommand).resolves({
        Summaries: [
          {
            StackSetName: "AWSControlTowerBP-BASELINE-CLOUDWATCH",
            StackSetId: "AWSControlTowerBP-BASELINE-CLOUDWATCH:ss-ct-123",
            Status: "ACTIVE",
          },
          {
            StackSetName: "AWSControlTowerGuardrailAWS-GR-AUDIT",
            StackSetId: "AWSControlTowerGuardrailAWS-GR-AUDIT:ss-ct-456",
            Status: "ACTIVE",
          },
          {
            StackSetName: "my-custom-stackset",
            StackSetId: "my-custom-stackset:ss-789",
            PermissionModel: "SELF_MANAGED",
            Status: "ACTIVE",
          },
        ],
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints/stacksets",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const result = await handler(event, mockAuthorizedContext(orgMgmtEnv));
      const body = JSON.parse(result.body);

      // Should only return the custom StackSet, not Control Tower ones
      expect(body.data.result).toHaveLength(1);
      expect(body.data.result[0].stackSetName).toBe("my-custom-stackset");
      expect(result.statusCode).toBe(200);
    });

    it("should NOT filter AWSControlTower StackSets in member account", async () => {
      // Test with ORG_MGT_ACCOUNT_ID !== HUB_ACCOUNT_ID (member account)
      const memberAccountEnv = {
        ...testEnv,
        ORG_MGT_ACCOUNT_ID: "111111111111",
        HUB_ACCOUNT_ID: "222222222222", // Different from org mgmt
      };

      // Stub the environment for this test
      bulkStubEnv(memberAccountEnv);

      mockCloudFormationClient.reset();
      mockCloudFormationClient.on(ListStackSetsCommand).resolves({
        Summaries: [
          {
            StackSetName: "AWSControlTowerBP-CUSTOM-USER-CREATED",
            StackSetId: "AWSControlTowerBP-CUSTOM-USER-CREATED:ss-user-123",
            PermissionModel: "SELF_MANAGED",
            Status: "ACTIVE",
          },
          {
            StackSetName: "my-custom-stackset",
            StackSetId: "my-custom-stackset:ss-789",
            PermissionModel: "SELF_MANAGED",
            Status: "ACTIVE",
          },
        ],
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints/stacksets",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const result = await handler(
        event,
        mockAuthorizedContext(memberAccountEnv),
      );
      const body = JSON.parse(result.body);

      // Should return both StackSets (no filtering in member account)
      expect(body.data.result).toHaveLength(2);
      expect(body.data.result[0].stackSetName).toBe(
        "AWSControlTowerBP-CUSTOM-USER-CREATED",
      );
      expect(body.data.result[1].stackSetName).toBe("my-custom-stackset");
      expect(result.statusCode).toBe(200);
    });
  });

  describe("GET /blueprints", () => {
    it("should list all blueprints", async () => {
      const mockBlueprints: PersistedBlueprintWithStackSets[] = [
        {
          blueprint: createTestBlueprintItem({
            blueprintId: "650e8400-e29b-41d4-a716-446655440001",
            name: "TestBlueprint",
            tags: {},
            createdBy: "admin@example.com",
          }),
          stackSets: [],
          recentDeployments: [],
        },
      ];

      vi.spyOn(
        DynamoBlueprintStore.prototype,
        "listBlueprints",
      ).mockReturnValue(
        Promise.resolve({
          result: mockBlueprints,
          nextPageIdentifier: null,
        }),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: {
            blueprints: mockBlueprints.map(projectComposite),
            nextPageIdentifier: null,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should handle empty blueprints list", async () => {
      vi.spyOn(
        DynamoBlueprintStore.prototype,
        "listBlueprints",
      ).mockReturnValue(
        Promise.resolve({
          result: [],
          nextPageIdentifier: null,
        }),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: {
            blueprints: [],
            nextPageIdentifier: null,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return nextPageIdentifier when pagination needed", async () => {
      const mockBlueprints: PersistedBlueprintWithStackSets[] = [
        {
          blueprint: createTestBlueprintItem({
            blueprintId: "650e8400-e29b-41d4-a716-446655440001",
            name: "TestBlueprint",
            tags: {},
            createdBy: "admin@example.com",
          }),
          stackSets: [],
          recentDeployments: [],
        },
      ];

      vi.spyOn(
        DynamoBlueprintStore.prototype,
        "listBlueprints",
      ).mockReturnValue(
        Promise.resolve({
          result: mockBlueprints,
          nextPageIdentifier: "next-token",
        }),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: {
            blueprints: mockBlueprints.map(projectComposite),
            nextPageIdentifier: "next-token",
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should map pageIdentifier and maxResults to the store", async () => {
      const mockBlueprints: PersistedBlueprintWithStackSets[] = [
        {
          blueprint: createTestBlueprintItem({
            blueprintId: "650e8400-e29b-41d4-a716-446655440001",
            name: "TestBlueprint",
            tags: {},
            createdBy: "admin@example.com",
          }),
          stackSets: [],
          recentDeployments: [],
        },
      ];

      const listBlueprintsSpy = vi
        .spyOn(DynamoBlueprintStore.prototype, "listBlueprints")
        .mockReturnValue(
          Promise.resolve({
            result: mockBlueprints,
            nextPageIdentifier: "next-token",
          }),
        );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints",
        queryStringParameters: {
          pageIdentifier: "previous-token",
          maxResults: "50",
        },
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      await handler(event, mockAuthorizedContext(testEnv));

      expect(listBlueprintsSpy).toHaveBeenCalledWith({
        pageIdentifier: "previous-token",
        pageSize: 50,
      });
    });

    it("should return 400 for invalid pagination parameters", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints",
        queryStringParameters: {
          maxResults: "999",
        },
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 400,
        // Accepted deviation: the model's `@range` (via jsendValidationCustomizer)
        // replaces the pre-Smithy Zod message; still a 400 ValidationError.
        body: jsendFailBodyLike({
          field: "maxResults",
          message:
            "Value at '/maxResults' failed to satisfy constraint: Member must be between 1 and 100, inclusive",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it("should return 500 when data store call fails", async () => {
      vi.spyOn(
        DynamoBlueprintStore.prototype,
        "listBlueprints",
      ).mockImplementation(() => {
        throw new Error();
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeadersWithErrorType("InternalServerError"),
      });
    });
  });

  describe("POST /blueprints", () => {
    it("should register blueprint successfully", async () => {
      const mockBlueprint: PersistedBlueprintItem = {
        PK: "bp#123",
        SK: "blueprint",
        itemType: "BLUEPRINT",
        blueprintId: "650e8400-e29b-41d4-a716-446655440001",
        name: "TestBlueprint",
        tags: {},
        createdBy: "admin@example.com",
        deploymentTimeoutMinutes: 60,
        regionConcurrencyType: "SEQUENTIAL",
        totalHealthMetrics: {
          totalDeploymentCount: 0,
          totalSuccessfulCount: 0,
        },
        meta: {
          schemaVersion: 1,
          createdTime: "2024-01-01T00:00:00.000Z",
          lastEditTime: "2024-01-01T00:00:00.000Z",
        },
      };

      vi.spyOn(
        BlueprintDeploymentService.prototype,
        "registerBlueprint",
      ).mockResolvedValue(mockBlueprint);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/blueprints",
        body: JSON.stringify({
          name: "TestBlueprint",
          stackSetId: "test-stackset:ss-123",
          regions: ["us-east-1"],
          tags: {},
          deploymentTimeoutMinutes: 60,
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 201,
        body: rawBodyLike({
          status: "success",
          data: projectBlueprint(mockBlueprint),
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(
        BlueprintDeploymentService.prototype.registerBlueprint,
      ).toHaveBeenCalled();
    });

    it("should return 400 for missing required fields", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/blueprints",
        body: JSON.stringify({
          name: "TestBlueprint",
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      // Multi-line assertion to verify all 2 missing fields are reported by Zod
      const response = await handler(event, mockAuthorizedContext(testEnv));
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("fail");
      expect(body.data.errors).toHaveLength(2);
      expect(body.data.errors[0].field).toBe("stackSetId");
    });

    it("should return 400 for invalid request body", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/blueprints",
        body: JSON.stringify({
          name: "TestBlueprint",
          stackSetId: "test-stackset:ss-123",
          regions: [],
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 400,
        // Accepted deviation (C4): `regions` min-length is now model-owned, so the
        // generated validation message replaces the pre-Smithy Zod "Too small…"
        // (and the envelope is alphabetized). Still a 400 ValidationError.
        body: jsendFailBodyLike({
          field: "regions",
          message:
            "Value with length 0 at '/regions' failed to satisfy constraint: Member must have length greater than or equal to 1",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it("should return 404 when StackSet not found", async () => {
      vi.spyOn(
        BlueprintDeploymentService.prototype,
        "registerBlueprint",
      ).mockRejectedValue(
        new StackSetNotFoundError("StackSet 'test-stackset:ss-123' not found"),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/blueprints",
        body: JSON.stringify({
          name: "TestBlueprint",
          stackSetId: "test-stackset:ss-123",
          regions: ["us-east-1"],
          tags: {},
          deploymentTimeoutMinutes: 60,
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: "StackSet not found.",
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 400 when StackSet is SERVICE_MANAGED", async () => {
      vi.spyOn(
        BlueprintDeploymentService.prototype,
        "registerBlueprint",
      ).mockRejectedValue(
        new UnsupportedPermissionModelError(
          "StackSet ID 'test-stackset:ss-123' uses SERVICE_MANAGED permission model. Only SELF_MANAGED StackSets are supported.",
        ),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/blueprints",
        body: JSON.stringify({
          name: "TestBlueprint",
          stackSetId: "test-stackset:ss-123",
          regions: ["us-east-1"],
          tags: {},
          deploymentTimeoutMinutes: 60,
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message: "StackSet uses unsupported permission model.",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });
  });

  describe("GET /blueprints/{blueprintId}", () => {
    it("should get blueprint details", async () => {
      const mockBlueprintWithStackSets = {
        blueprint: createTestBlueprintItem({
          blueprintId: "650e8400-e29b-41d4-a716-446655440001",
          name: "TestBlueprint",
        }),
        stackSets: [],
      };

      vi.spyOn(DynamoBlueprintStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: mockBlueprintWithStackSets,
        }),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints/650e8400-e29b-41d4-a716-446655440001",
        pathParameters: { blueprintId: "650e8400-e29b-41d4-a716-446655440001" },
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: projectComposite(mockBlueprintWithStackSets),
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 404 when blueprint not found", async () => {
      vi.spyOn(DynamoBlueprintStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: undefined,
        }),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints/650e8400-e29b-41d4-a716-446655440001",
        pathParameters: { blueprintId: "650e8400-e29b-41d4-a716-446655440001" },
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({ message: "Blueprint not found" }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("rejects a hex-shaped but RFC-invalid blueprintId with 400, never hitting the store", async () => {
      // C2: the model `@pattern` matches z.uuid()'s RFC layout, so a UUID with an
      // invalid version nibble (0) is rejected at the edge — a 400, not a store-miss
      // 404. Path values are caller-controlled, so this is a real, reachable case.
      const getSpy = vi.spyOn(DynamoBlueprintStore.prototype, "get");

      const invalidId = "12345678-1234-0234-1234-123456789abc"; // version nibble = 0
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/blueprints/${invalidId}`,
        pathParameters: { blueprintId: invalidId },
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));
      expect(response.statusCode).toBe(400);
      expect(response.headers).toMatchObject({
        "x-amzn-errortype": "ValidationError",
      });
      expect(JSON.parse(response.body).data.errors[0].field).toBe(
        "blueprintId",
      );
      expect(getSpy).not.toHaveBeenCalled();
    });

    it("drops storage-only fields from a populated recentDeployments on the wire", async () => {
      // C6: prove end-to-end that a stored deployment can't leak PK/SK/itemType/ttl/meta.
      const deployment = createTestDeploymentHistoryItem();
      const composite = {
        blueprint: createTestBlueprintItem({
          blueprintId: "650e8400-e29b-41d4-a716-446655440001",
          name: "TestBlueprint",
        }),
        stackSets: [createTestStackSetItem()],
        recentDeployments: [deployment],
      };

      vi.spyOn(DynamoBlueprintStore.prototype, "get").mockReturnValue(
        Promise.resolve({ result: composite }),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints/650e8400-e29b-41d4-a716-446655440001",
        pathParameters: { blueprintId: "650e8400-e29b-41d4-a716-446655440001" },
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));
      expect(response.statusCode).toBe(200);
      // Exact projection: public deployment/stackset fields kept, internals dropped.
      expect(response).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: projectComposite(composite),
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      // Explicit info-disclosure guard on the deployment.
      const wireDeployment = JSON.parse(response.body).data
        .recentDeployments[0];
      for (const internal of ["PK", "SK", "itemType", "ttl", "meta"]) {
        expect(wireDeployment).not.toHaveProperty(internal);
      }
      expect(wireDeployment.status).toBe("SUCCEEDED");
    });
  });

  describe("PUT /blueprints/{blueprintId}", () => {
    it("should update mutable fields successfully", async () => {
      const oldBlueprint = createTestBlueprintItem({
        blueprintId: "650e8400-e29b-41d4-a716-446655440001",
        name: "OldName",
        tags: {},
      });

      const updatedBlueprint = createTestBlueprintItem({
        blueprintId: "650e8400-e29b-41d4-a716-446655440001",
        name: "NewName",
        tags: { updated: "true" },
      });

      vi.spyOn(DynamoBlueprintStore.prototype, "get")
        .mockReturnValueOnce(
          Promise.resolve({
            result: {
              blueprint: oldBlueprint,
              stackSets: [],
            },
          }),
        )
        .mockReturnValueOnce(
          Promise.resolve({
            result: {
              blueprint: updatedBlueprint,
              stackSets: [],
            },
          }),
        );

      vi.spyOn(DynamoBlueprintStore.prototype, "update").mockReturnValue(
        Promise.resolve({
          oldItem: oldBlueprint,
          newItem: updatedBlueprint,
        }),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/blueprints/650e8400-e29b-41d4-a716-446655440001",
        pathParameters: { blueprintId: "650e8400-e29b-41d4-a716-446655440001" },
        body: JSON.stringify({
          name: "NewName",
          tags: { updated: "true" },
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));

      expect(response.statusCode).toBe(200);
      expect(response.headers).toEqual(
        expect.objectContaining(responseHeaders),
      );
      const body = JSON.parse(response.body);
      expect(body.status).toBe("success");
      expect(body.data.blueprint.name).toBe("NewName");
      expect(body.data.blueprint.tags).toEqual({ updated: "true" });
    });

    it("returns 404 (not an opaque 500) if the blueprint is deleted between the update and the re-fetch", async () => {
      // The plain (non-StackSet) update re-fetches the composite to build the
      // response. If the row vanishes in that window, `data` (a @required member)
      // would otherwise serialize as an opaque 500; `getBlueprintOr404` turns it into
      // a clean 404. Accepted deviation from the pre-Smithy 200-with-missing-data —
      // see internal/docs/design-docs/smithy/accepted-deviations.md.
      const blueprint = createTestBlueprintItem({
        blueprintId: "650e8400-e29b-41d4-a716-446655440001",
        name: "TestBlueprint",
      });

      vi.spyOn(DynamoBlueprintStore.prototype, "get")
        .mockReturnValueOnce(
          Promise.resolve({ result: { blueprint, stackSets: [] } }),
        )
        .mockReturnValueOnce(Promise.resolve({ result: undefined }));
      vi.spyOn(DynamoBlueprintStore.prototype, "update").mockResolvedValue({
        oldItem: blueprint,
        newItem: blueprint,
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/blueprints/650e8400-e29b-41d4-a716-446655440001",
        pathParameters: { blueprintId: "650e8400-e29b-41d4-a716-446655440001" },
        body: JSON.stringify({ name: "NewName" }),
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("fail");
    });

    it("applies a mixed Blueprint + all StackSet fields via the atomic update, preserving unchanged StackSet data", async () => {
      // C1: a PUT carrying StackSet params takes the two-item atomic write path
      // (`updateBlueprintWithStackSet`), which no prior test exercised. Send a
      // Blueprint field (`name`) alongside all three StackSet params, and assert the
      // merged StackSet applies every param while preserving the fields the body did
      // not touch (regions, deploymentOrder, the roles, healthMetrics).
      const blueprint = createTestBlueprintItem({
        blueprintId: "650e8400-e29b-41d4-a716-446655440001",
        name: "TestBlueprint",
        tags: { Team: "sandbox" },
      });
      const stackSet = createTestStackSetItem({
        blueprintId: "650e8400-e29b-41d4-a716-446655440001",
        regions: ["us-east-1", "eu-west-1"],
        deploymentOrder: 3,
        maxConcurrentPercentage: 100,
        failureTolerancePercentage: 0,
        concurrencyMode: "STRICT_FAILURE_TOLERANCE",
      });
      // What the store returns is independent of the merge; the assertions below on
      // the arguments passed to the atomic write are what verify the merge itself.
      const updatedComposite = {
        blueprint: { ...blueprint, name: "RenamedBlueprint" },
        stackSets: [
          {
            ...stackSet,
            maxConcurrentPercentage: 50,
            failureTolerancePercentage: 20,
            concurrencyMode: "SOFT_FAILURE_TOLERANCE" as const,
          },
        ],
      };

      vi.spyOn(DynamoBlueprintStore.prototype, "get").mockReturnValue(
        Promise.resolve({ result: { blueprint, stackSets: [stackSet] } }),
      );
      const atomicSpy = vi
        .spyOn(DynamoBlueprintStore.prototype, "updateBlueprintWithStackSet")
        .mockResolvedValue(updatedComposite);
      const plainUpdateSpy = vi.spyOn(DynamoBlueprintStore.prototype, "update");

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/blueprints/650e8400-e29b-41d4-a716-446655440001",
        pathParameters: { blueprintId: "650e8400-e29b-41d4-a716-446655440001" },
        body: JSON.stringify({
          name: "RenamedBlueprint",
          maxConcurrentPercentage: 50,
          failureTolerancePercentage: 20,
          concurrencyMode: "SOFT_FAILURE_TOLERANCE",
        }),
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: projectComposite(updatedComposite),
        }),
        headers: expect.objectContaining(responseHeaders),
      });

      // Exactly one atomic write, no plain update.
      expect(atomicSpy).toHaveBeenCalledTimes(1);
      expect(plainUpdateSpy).not.toHaveBeenCalled();

      const [passedBlueprint, passedStackSet] = atomicSpy.mock.calls[0]!;

      // Blueprint: the `name` field is applied; identity and untouched tags survive.
      expect(passedBlueprint.name).toBe("RenamedBlueprint");
      expect(passedBlueprint.blueprintId).toBe(blueprint.blueprintId);
      expect(passedBlueprint.tags).toEqual(blueprint.tags);

      // StackSet: all three params applied, every unchanged field preserved. A single
      // deep-equal covers both the updates and the preservation.
      expect(passedStackSet).toEqual({
        ...stackSet,
        maxConcurrentPercentage: 50,
        failureTolerancePercentage: 20,
        concurrencyMode: "SOFT_FAILURE_TOLERANCE",
      });
    });

    it("should remove all tags when tags is undefined", async () => {
      const blueprintWithoutTags = createTestBlueprintItem({
        blueprintId: "650e8400-e29b-41d4-a716-446655440001",
        name: "TestBlueprint",
        tags: {},
      });

      vi.spyOn(DynamoBlueprintStore.prototype, "get")
        .mockReturnValueOnce(
          Promise.resolve({
            result: {
              blueprint: createTestBlueprintItem({
                blueprintId: "650e8400-e29b-41d4-a716-446655440001",
                name: "TestBlueprint",
                tags: { Cost: "$2", Description: "testing-123" },
              }),
              stackSets: [],
            },
          }),
        )
        .mockReturnValueOnce(
          Promise.resolve({
            result: {
              blueprint: blueprintWithoutTags,
              stackSets: [],
            },
          }),
        );

      vi.spyOn(DynamoBlueprintStore.prototype, "update").mockReturnValue(
        Promise.resolve({
          newItem: blueprintWithoutTags,
        }),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/blueprints/650e8400-e29b-41d4-a716-446655440001",
        pathParameters: { blueprintId: "650e8400-e29b-41d4-a716-446655440001" },
        body: JSON.stringify({
          tags: {},
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("success");
      expect(body.data.blueprint.tags).toEqual({});

      // Verify update was called with empty tags object
      expect(DynamoBlueprintStore.prototype.update).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: {},
        }),
      );
    });

    it("should reject updates to immutable fields", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/blueprints/650e8400-e29b-41d4-a716-446655440001",
        pathParameters: { blueprintId: "650e8400-e29b-41d4-a716-446655440001" },
        body: JSON.stringify({
          name: "NewName",
          regions: ["us-west-2"],
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "input",
          message: 'Unrecognized key: "regions"',
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it("should return 404 when blueprint not found", async () => {
      vi.spyOn(DynamoBlueprintStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: undefined,
        }),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/blueprints/650e8400-e29b-41d4-a716-446655440001",
        pathParameters: { blueprintId: "650e8400-e29b-41d4-a716-446655440001" },
        body: JSON.stringify({
          name: "NewName",
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({ message: "Blueprint not found" }),
        headers: expect.objectContaining(responseHeaders),
      });
    });
  });

  describe("DELETE /blueprints/{blueprintId}", () => {
    it("should delete blueprint when not in use", async () => {
      vi.spyOn(DynamoBlueprintStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: {
            blueprint: createTestBlueprintItem({
              blueprintId: "650e8400-e29b-41d4-a716-446655440001",
              name: "TestBlueprint",
            }),
            stackSets: [],
          },
        }),
      );

      vi.spyOn(
        DynamoLeaseTemplateStore.prototype,
        "findByBlueprintId",
      ).mockReturnValue(Promise.resolve([]));

      vi.spyOn(
        BlueprintDeploymentService.prototype,
        "unregisterBlueprint",
      ).mockResolvedValue(undefined);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "DELETE",
        path: "/blueprints/650e8400-e29b-41d4-a716-446655440001",
        pathParameters: { blueprintId: "650e8400-e29b-41d4-a716-446655440001" },
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: {
            message: "Blueprint unregistered successfully",
            blueprintId: "650e8400-e29b-41d4-a716-446655440001",
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(
        BlueprintDeploymentService.prototype.unregisterBlueprint,
      ).toHaveBeenCalled();
    });

    it("should return 409 when blueprint is in use", async () => {
      vi.spyOn(DynamoBlueprintStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: {
            blueprint: createTestBlueprintItem({
              blueprintId: "650e8400-e29b-41d4-a716-446655440001",
              name: "TestBlueprint",
            }),
            stackSets: [],
          },
        }),
      );

      vi.spyOn(
        DynamoLeaseTemplateStore.prototype,
        "findByBlueprintId",
      ).mockReturnValue(
        Promise.resolve([
          {
            uuid: "template-1",
            blueprintId: "650e8400-e29b-41d4-a716-446655440001",
          },
        ]),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "DELETE",
        path: "/blueprints/650e8400-e29b-41d4-a716-446655440001",
        pathParameters: { blueprintId: "650e8400-e29b-41d4-a716-446655440001" },
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message:
            "Cannot delete blueprint - currently in use by lease templates.",
        }),
        headers: responseHeadersWithErrorType("ConflictError"),
      });
    });

    it("should return 404 when blueprint not found", async () => {
      vi.spyOn(DynamoBlueprintStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: undefined,
        }),
      );

      vi.spyOn(
        DynamoLeaseTemplateStore.prototype,
        "findByBlueprintId",
      ).mockReturnValue(Promise.resolve([]));

      const event = createAPIGatewayProxyEvent({
        httpMethod: "DELETE",
        path: "/blueprints/650e8400-e29b-41d4-a716-446655440001",
        pathParameters: { blueprintId: "650e8400-e29b-41d4-a716-446655440001" },
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({ message: "Blueprint not found" }),
        headers: expect.objectContaining(responseHeaders),
      });
    });
  });
});
