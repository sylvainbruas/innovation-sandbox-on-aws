// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
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

import { BlueprintLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/blueprint-lambda-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  createAPIGatewayProxyEvent,
  isbAuthorizedUser,
  mockAuthorizedContext,
  mockGlobalConfig,
} from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  bulkStubEnv,
  mockAppConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
const mockDynamoDBClient = mockClient(DynamoDBClient);
const testEnv = generateSchemaData(BlueprintLambdaEnvironmentSchema, {
  BLUEPRINT_TABLE_NAME: "test-blueprint-table",
  LEASE_TEMPLATE_TABLE_NAME: "test-lease-template-table",
});

const mockedGlobalConfig = mockGlobalConfig();

let handler: typeof import("../src/blueprints-handler.js").handler;

beforeAll(async () => {
  bulkStubEnv(testEnv);
  handler = (await import("../src/blueprints-handler.js")).handler;
});

describe("Error Handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamoDBClient.reset();
    bulkStubEnv(testEnv);
    mockAppConfigMiddleware(mockedGlobalConfig);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("Invalid UUID in path parameter", () => {
    it("should return 400 with field-specific error", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/blueprints/not-a-uuid",
        pathParameters: { blueprintId: "not-a-uuid" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("fail");
      expect(body.data.errors[0]).toMatchObject({
        field: "blueprintId",
        message: "Invalid UUID",
      });
    });
  });

  describe("Malformed JSON in request body", () => {
    it("should return 415 with clear error message", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/blueprints",
        headers: {
          "content-type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: '{"name": "test"',
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));

      expect(response.statusCode).toBe(415);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("fail");
      expect(body.data.errors[0].message).toContain("Invalid JSON");
    });
  });

  describe("Type mismatch in request body", () => {
    it("should return 400 with type information", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/blueprints",
        headers: {
          "content-type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify({
          name: "Test-Blueprint",
          stackSetId: "test-stackset:12345",
          regions: ["us-east-1"],
          deploymentTimeoutMinutes: "not-a-number",
        }),
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.data.errors[0]).toMatchObject({
        field: "deploymentTimeoutMinutes",
        message: "Invalid input: expected number, received string",
      });
    });
  });

  describe("Invalid enum value", () => {
    it("should return 400 without reflecting user input", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/blueprints",
        headers: {
          "content-type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify({
          name: "Test-Blueprint",
          stackSetId: "test-stackset:12345",
          regions: ["us-east-1"],
          regionConcurrencyType: "INVALID_TYPE",
        }),
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.data.errors[0].message).not.toContain("INVALID_TYPE");
      expect(body.data.errors[0].message).toContain("Expected one of");
    });
  });
});
