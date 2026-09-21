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
      // Accepted deviation: the model's `@pattern` on the `blueprintId` httpLabel
      // replaces the pre-Smithy Zod "Invalid UUID" message; still a 400 on
      // `blueprintId`.
      expect(body.data.errors[0]).toMatchObject({
        field: "blueprintId",
        message:
          "Value at '/blueprintId' failed to satisfy constraint: Member must satisfy regular expression pattern: ^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      });
    });
  });

  describe("Malformed JSON in request body", () => {
    it("should return 400 with clear error message", async () => {
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

      expect(response.statusCode).toBe(400);
      expect(response.headers).toMatchObject({
        "x-amzn-errortype": "ValidationError",
      });
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
      // Accepted deviation: a type-mismatched body member is now rejected at the
      // restJson1 deserialization layer as a generic 400 (no per-field detail),
      // where the pre-Smithy Zod re-parse produced a `deploymentTimeoutMinutes`
      // field error. Still a 400 ValidationError.
      expect(body.data.errors[0]).toMatchObject({
        message: "Invalid JSON in request body. Please check your JSON syntax.",
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
      // Accepted deviation: the model enum-validation message ("Member must satisfy
      // enum value set: [...]") replaces the pre-Smithy Zod "Expected one of ...".
      // Still safe — it does not reflect the caller's invalid input.
      expect(body.data.errors[0].message).toContain(
        "Member must satisfy enum value set",
      );
    });
  });
});
