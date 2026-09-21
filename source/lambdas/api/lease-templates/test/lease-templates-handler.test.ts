// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { DynamoBlueprintStore } from "@amzn/innovation-sandbox-commons/data/blueprint/dynamo-blueprint-store.js";
import { UnknownItem } from "@amzn/innovation-sandbox-commons/data/errors.js";
import { DynamoLeaseTemplateStore } from "@amzn/innovation-sandbox-commons/data/lease-template/dynamo-lease-template-store.js";
import {
  PersistedLeaseTemplate,
  PersistedLeaseTemplateSchema,
} from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { LeaseTemplateLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-template-lambda-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  createAPIGatewayProxyEvent,
  createErrorResponseBody,
  createFailureResponseBody,
  isbAuthorizedUser,
  isbAuthorizedUserUserRoleOnly,
  jsendFailBodyLike,
  mockAuthorizedContext,
  mockGlobalConfig,
  responseHeaders,
  responseHeadersWithErrorType,
  serializedBodyLike,
} from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  bulkStubEnv,
  mockAppConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { randomUUID } from "crypto";

const mockUuid = "00000000-0000-0000-0000-000000000000";
vi.mock("uuid", () => ({
  v4: vi.fn().mockReturnValue(mockUuid),
}));

const testEnv = generateSchemaData(LeaseTemplateLambdaEnvironmentSchema);
const mockedGlobalConfig = mockGlobalConfig();
mockedGlobalConfig.leases.maxBudget = 100;
mockedGlobalConfig.leases.maxDurationHours = 100;
mockedGlobalConfig.leases.leaseSharingEnabled = true;
const mockedReportingConfig = {
  costReportGroups: [],
  requireCostReportGroup: false,
};
const testReportingConfig = {
  costReportGroups: ["valid-group-1", "valid-group-2"],
  requireCostReportGroup: false,
};
const testReportingConfigRequired = {
  costReportGroups: ["valid-group-1", "valid-group-2"],
  requireCostReportGroup: true,
};

let handler: typeof import("@amzn/innovation-sandbox-lease-templates/lease-templates-handler.js").handler;

beforeAll(async () => {
  bulkStubEnv(testEnv);

  handler = (
    await import("@amzn/innovation-sandbox-lease-templates/lease-templates-handler.js")
  ).handler;
});

beforeEach(() => {
  bulkStubEnv(testEnv);
  mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

function createLeaseTemplateBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "template",
    description: "a template",
    requiresApproval: false,
    visibility: "PUBLIC" as const,
    costReportGroup: undefined,
    blueprintId: undefined,
    allowOwnerToShareLease: false,
    maxSpend: 50,
    budgetThresholds: [{ dollarsSpent: 10, action: "ALERT" as const }],
    leaseDurationInHours: 24,
    durationThresholds: [{ hoursRemaining: 2, action: "ALERT" as const }],
    ...overrides,
  };
}

describe("handler", async () => {
  it("should return 500 response when environment variables are misconfigured", async () => {
    vi.unstubAllEnvs();

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/leasesTemplates",
      headers: {
        "Content-Type": "application/json",
      },
      isbUser: isbAuthorizedUser.user,
    });
    expect(
      await handler(event, mockAuthorizedContext(testEnv, mockedGlobalConfig)),
    ).toEqual({
      statusCode: 500,
      body: createErrorResponseBody("An unexpected error occurred."),
      headers: expect.objectContaining(
        responseHeadersWithErrorType("InternalServerError"),
      ),
    });
  });

  describe("GET /leaseTemplates", () => {
    it("should return 200 response with all lease templates", async () => {
      const leaseTemplates: PersistedLeaseTemplate[] = [
        generateSchemaData(PersistedLeaseTemplateSchema),
        generateSchemaData(PersistedLeaseTemplateSchema),
      ];

      vi.spyOn(
        DynamoLeaseTemplateStore.prototype,
        "findAllVisible",
      ).mockResolvedValue({
        result: leaseTemplates,
        nextPageIdentifier: null,
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates",
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: serializedBodyLike({
          status: "success",
          data: {
            result: leaseTemplates,
            nextPageIdentifier: null,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });
    it("should return 200 without leaking the validation error to the caller", async () => {
      const leaseTemplates: PersistedLeaseTemplate[] = [
        generateSchemaData(PersistedLeaseTemplateSchema),
        generateSchemaData(PersistedLeaseTemplateSchema),
      ];

      vi.spyOn(
        DynamoLeaseTemplateStore.prototype,
        "findAllVisible",
      ).mockResolvedValue({
        result: leaseTemplates,
        nextPageIdentifier: null,
        error: "Some validation error",
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates",
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: serializedBodyLike({
          status: "success",
          data: {
            result: leaseTemplates,
            nextPageIdentifier: null,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 200 with first page of lease template when pagination query parameters are passed in", async () => {
      const leaseTemplates: PersistedLeaseTemplate[] = [
        generateSchemaData(PersistedLeaseTemplateSchema),
        generateSchemaData(PersistedLeaseTemplateSchema),
      ];

      const findAllVisibleMethod = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "findAllVisible")
        .mockReturnValue(
          Promise.resolve({
            result: leaseTemplates,
            nextPageIdentifier: null,
          }),
        );

      const pageIdentifier = "eyAidGVzdCI6ICJ0ZXN0IiB9";
      const maxResults = "2";

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates",
        queryStringParameters: {
          pageIdentifier,
          maxResults,
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: serializedBodyLike({
          status: "success",
          data: {
            result: leaseTemplates,
            nextPageIdentifier: null,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(findAllVisibleMethod.mock.calls).toHaveLength(1);
      expect(findAllVisibleMethod.mock.calls[0]).toEqual([
        {
          pageIdentifier: pageIdentifier,
          pageSize: Number(maxResults),
          includePrivate: true,
        },
      ]);
    });
    it("should use the schema default when maxResults is absent", async () => {
      const findAllVisibleMethod = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "findAllVisible")
        .mockResolvedValue({
          result: [],
          nextPageIdentifier: null,
        });

      await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "GET",
          path: "/leaseTemplates",
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(findAllVisibleMethod).toHaveBeenCalledWith({
        pageIdentifier: undefined,
        pageSize: 2000,
        includePrivate: true,
      });
    });
    it("should return 400 when invalid pagination query parameters are passed in", async () => {
      const leaseTemplates: PersistedLeaseTemplate[] = [
        generateSchemaData(PersistedLeaseTemplateSchema),
        generateSchemaData(PersistedLeaseTemplateSchema),
      ];

      const findAllVisibleMethod = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "findAllVisible")
        .mockReturnValue(
          Promise.resolve({
            result: leaseTemplates,
            nextPageIdentifier: null,
          }),
        );

      const pageIdentifier = "eyAidGVzdCI6ICJ0ZXN0IiB9";
      const maxResults = "NaN";

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates",
        queryStringParameters: {
          pageIdentifier,
          maxResults,
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        // `maxResults` is a model-validated Integer, so a non-numeric value is
        // rejected by generated deserialization with the generic restJson1
        // "invalid JSON body" message rather than the pre-Smithy per-field Zod
        // error — an accepted deviation of the Smithy migration.
        body: createFailureResponseBody({
          message:
            "Invalid JSON in request body. Please check your JSON syntax.",
        }),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("ValidationError"),
        ),
      });
      expect(findAllVisibleMethod.mock.calls).toHaveLength(0);
    });
    it("rejects a repeated query key rather than taking the last value", async () => {
      // API Gateway's single-value map holds the last value, but `convertEvent`
      // reads the multi-value map, and a single-valued model query member is
      // rejected as a multi-element array by generated deserialization — a
      // restJson1 400 rather than the pre-Smithy last-wins 200. Accepted deviation.
      const findAllVisibleMethod = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "findAllVisible")
        .mockResolvedValue({ result: [], nextPageIdentifier: null });

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "GET",
          path: "/leaseTemplates",
          // API Gateway: single-value map holds the last value; multi-value map
          // holds every value for a repeated key.
          queryStringParameters: { maxResults: "2" },
          multiValueQueryStringParameters: { maxResults: ["1", "2"] },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(400);
      expect(findAllVisibleMethod.mock.calls).toHaveLength(0);
    });
    it("should return 500 response when db call throws unexpected error", async () => {
      vi.spyOn(
        DynamoLeaseTemplateStore.prototype,
        "findAllVisible",
      ).mockImplementation(() => {
        throw new Error();
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates",
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("InternalServerError"),
        ),
      });
    });

    it("should return 200 with all templates (PUBLIC and PRIVATE) for Admin/Manager users", async () => {
      const publicTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
        visibility: "PUBLIC",
      });
      const privateTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
        visibility: "PRIVATE",
      });
      const leaseTemplates = [publicTemplate, privateTemplate];

      vi.spyOn(
        DynamoLeaseTemplateStore.prototype,
        "findAllVisible",
      ).mockResolvedValue({
        result: leaseTemplates,
        nextPageIdentifier: null,
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates",
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response).toEqual({
        statusCode: 200,
        body: serializedBodyLike({
          status: "success",
          data: {
            result: leaseTemplates,
            nextPageIdentifier: null,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should request only visible templates (includePrivate false) for User-only role", async () => {
      // Visibility filtering now happens in the store (findAllVisible), so the
      // handler must ask for the non-privileged view. The store's own tests
      // verify PRIVATE templates never appear in the result or the token.
      const publicTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
        visibility: "PUBLIC",
      });

      const findAllVisibleMethod = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "findAllVisible")
        .mockResolvedValue({
          result: [publicTemplate],
          nextPageIdentifier: null,
        });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates",
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      // Create context with User-only role
      const userOnlyContext = {
        ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
        user: isbAuthorizedUserUserRoleOnly.user,
      };

      const response = await handler(event, userOnlyContext);

      expect(response).toEqual({
        statusCode: 200,
        body: serializedBodyLike({
          status: "success",
          data: {
            result: [publicTemplate],
            nextPageIdentifier: null,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(findAllVisibleMethod).toHaveBeenCalledWith(
        expect.objectContaining({ includePrivate: false }),
      );
    });

    it("should request all templates (includePrivate true) for Admin/Manager role", async () => {
      const publicTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
        visibility: "PUBLIC",
      });
      const privateTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
        visibility: "PRIVATE",
      });

      const findAllVisibleMethod = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "findAllVisible")
        .mockResolvedValue({
          result: [publicTemplate, privateTemplate],
          nextPageIdentifier: null,
        });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates",
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response).toEqual({
        statusCode: 200,
        body: serializedBodyLike({
          status: "success",
          data: {
            result: [publicTemplate, privateTemplate],
            nextPageIdentifier: null,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(findAllVisibleMethod).toHaveBeenCalledWith(
        expect.objectContaining({ includePrivate: true }),
      );
    });

    it("should return exactly the JSend success envelope keys", async () => {
      vi.spyOn(
        DynamoLeaseTemplateStore.prototype,
        "findAllVisible",
      ).mockResolvedValue({
        result: [generateSchemaData(PersistedLeaseTemplateSchema)],
        // Non-null so the member survives serialization; the null case is the
        // next test.
        nextPageIdentifier: "next-token",
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates",
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      const parsed = JSON.parse(response.body);
      expect(Object.keys(parsed).sort()).toEqual(["data", "status"]);
      // data carries the page wrapper, unlike POST which returns the entity.
      expect(Object.keys(parsed.data).sort()).toEqual([
        "nextPageIdentifier",
        "result",
      ]);
    });

    it("omits nextPageIdentifier on the last page rather than returning null", async () => {
      // The generated serializer drops null members. The pre-Smithy API returned
      // `nextPageIdentifier: null`; the frontend adapter canonicalizes absent and
      // null to the same value, so dropping it is an accepted deviation.
      vi.spyOn(
        DynamoLeaseTemplateStore.prototype,
        "findAllVisible",
      ).mockResolvedValue({
        result: [],
        nextPageIdentifier: null,
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates",
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      const { data } = JSON.parse(response.body);
      expect(data).not.toHaveProperty("nextPageIdentifier");
      expect(data.result).toEqual([]);
    });
  });

  describe("POST /leaseTemplates", () => {
    it("should return 201 response when leaseTemplate is created successfully", async () => {
      const leaseTemplate = generateSchemaData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          meta: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      const uuid = randomUUID();

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "create").mockResolvedValue({
        ...leaseTemplate,
        uuid,
        createdBy: isbAuthorizedUser.user.email,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 201,
        body: serializedBodyLike({
          status: "success",
          data: {
            ...leaseTemplate,
            uuid,
            createdBy: isbAuthorizedUser.user.email,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });
    it("should reject a client-supplied meta field (server-owned)", async () => {
      // meta (createdTime/lastEditTime/schemaVersion) is server-owned. A client
      // must not be able to forge it, so meta is omitted from the accepted
      // schema and a body containing it is rejected outright.
      const body = {
        name: "forged-template",
        requiresApproval: false,
        visibility: "PUBLIC",
        allowOwnerToShareLease: false,
        maxSpend: 50,
        leaseDurationInHours: 24,
        meta: { createdTime: "2019-01-01T00:00:00.000Z", schemaVersion: 4 },
      };
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(body),
      });

      const createSpy = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "create")
        .mockResolvedValue({ ...body, uuid: mockUuid } as never);

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(400);
      expect(createSpy).not.toHaveBeenCalled();
    });
    it("should return 400 response when body is missing", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        // A missing body no longer produces the pre-Smithy "Body not provided."
        // message: required-member-ness is expressible by the model, so Smithy
        // renders the per-field 400 before the operation runs. (Modeled
        // ValidationError → alphabetized envelope, so compare structurally.)
        body: jsendFailBodyLike(
          {
            field: "name",
            message:
              "Value at '/name' failed to satisfy constraint: Member must not be null",
          },
          {
            field: "requiresApproval",
            message:
              "Value at '/requiresApproval' failed to satisfy constraint: Member must not be null",
          },
        ),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("ValidationError"),
        ),
      });
    });
    it("should return 400 response when body fails to parse", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        body: "not-a-json",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message:
            "Invalid JSON in request body. Please check your JSON syntax.",
        }),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("ValidationError"),
        ),
      });
    });
    it("should return 400 response when body is malformed", async () => {
      const leaseTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
        uuid: undefined,
        name: undefined,
        blueprintName: undefined,
        meta: undefined,
        maxSpend: 50,
        leaseDurationInHours: 24,
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        body: JSON.stringify(leaseTemplate),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "create").mockResolvedValue({
        ...leaseTemplate,
        uuid: mockUuid,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        // `name` is a required member the model expresses, so Smithy renders the
        // 400 and short-circuits before the operation's Zod parse runs — so the
        // unknown-key ("createdBy") report Zod would have added does not appear.
        // The unknown-key path is still covered where the body is otherwise
        // valid (see the strict-key PUT cases below). Modeled ValidationError →
        // alphabetized envelope, so compare structurally.
        body: jsendFailBodyLike({
          field: "name",
          message:
            "Value at '/name' failed to satisfy constraint: Member must not be null",
        }),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("ValidationError"),
        ),
      });
    });

    it("should reject an unknown member nested inside a threshold", async () => {
      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leaseTemplates",
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
          body: JSON.stringify(
            createLeaseTemplateBody({
              budgetThresholds: [
                { dollarsSpent: 10, action: "ALERT", surprise: true },
              ],
            }),
          ),
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).data.errors).toEqual([
        {
          field: "budgetThresholds.0",
          message: 'Unrecognized key: "surprise"',
        },
      ]);
    });

    it("should reject a blueprintId that is not a UUID", async () => {
      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leaseTemplates",
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
          body: JSON.stringify(
            createLeaseTemplateBody({ blueprintId: "not-a-uuid" }),
          ),
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).data.errors).toEqual([
        expect.objectContaining({ field: "blueprintId" }),
      ]);
    });

    it("should reject a zero maxSpend", async () => {
      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leaseTemplates",
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
          body: JSON.stringify(createLeaseTemplateBody({ maxSpend: 0 })),
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).data.errors).toEqual([
        expect.objectContaining({ field: "maxSpend" }),
      ]);
    });

    it("should accept positive fractional amounts and durations", async () => {
      const leaseTemplate = createLeaseTemplateBody({
        maxSpend: 0.5,
        leaseDurationInHours: 0.5,
        budgetThresholds: [{ dollarsSpent: 0.25, action: "ALERT" }],
        durationThresholds: [{ hoursRemaining: 0.25, action: "ALERT" }],
      });
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "create").mockResolvedValue({
        ...leaseTemplate,
        uuid: mockUuid,
        createdBy: isbAuthorizedUser.user.email,
        blueprintName: null,
      } as PersistedLeaseTemplate);

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leaseTemplates",
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
          body: JSON.stringify(leaseTemplate),
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(201);
    });

    it.each([
      {
        maxSpend: 200, // exceeded max
        leaseDurationInHours: 50,
        expectedErrorMessage: createFailureResponseBody({
          message: `Max budget cannot be greater than the global max budget (${mockedGlobalConfig.leases.maxBudget}).`,
        }),
      },
      {
        maxSpend: 50,
        leaseDurationInHours: 200, // exceeded max
        expectedErrorMessage: createFailureResponseBody({
          message: `Duration cannot be greater than the global max duration (${mockedGlobalConfig.leases.maxDurationHours}).`,
        }),
      },
    ])(
      `should return 400 when lease template values exceed global configuration: $expectedErrorMessage`,
      async ({ maxSpend, leaseDurationInHours, expectedErrorMessage }) => {
        const leaseTemplate = generateSchemaData(
          PersistedLeaseTemplateSchema.omit({
            uuid: true,
            createdBy: true,
            blueprintName: true,
            meta: true,
          }),
          {
            maxSpend,
            leaseDurationInHours,
          },
        );

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leaseTemplates",
          body: JSON.stringify(leaseTemplate),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        expect(
          await handler(
            event,
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          ),
        ).toEqual({
          statusCode: 400,
          body: expectedErrorMessage,
          headers: expect.objectContaining(
            responseHeadersWithErrorType("ValidationError"),
          ),
        });
      },
    );

    it.each([
      {
        costReportGroup: "invalid-group",
        reportingConfig: testReportingConfig,
        expectedError: "Invalid cost report group",
      },
      {
        costReportGroup: undefined,
        blueprintId: undefined,
        reportingConfig: testReportingConfigRequired,
        expectedError:
          "A cost report group must be provided as required by administrator settings. Please contact your administrator if you need to create a lease without specifying a cost report group.",
      },
    ])(
      "should return 400 when lease template violates cost reporting constraints",
      async ({ costReportGroup, reportingConfig, expectedError }) => {
        mockAppConfigMiddleware(mockedGlobalConfig, reportingConfig);

        const leaseTemplate = generateSchemaData(
          PersistedLeaseTemplateSchema.omit({
            uuid: true,
            createdBy: true,
            blueprintName: true,
            meta: true,
          }),
          {
            maxSpend: 50,
            leaseDurationInHours: 24,
            costReportGroup,
          },
        );

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leaseTemplates",
          body: JSON.stringify(leaseTemplate),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        expect(
          await handler(
            event,
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          ),
        ).toEqual({
          statusCode: 400,
          body: createFailureResponseBody({ message: expectedError }),
          headers: expect.objectContaining(
            responseHeadersWithErrorType("ValidationError"),
          ),
        });
      },
    );

    it.each([
      {
        maxSpend: 200,
        leaseDurationInHours: undefined,
        expectedErrorMessage: createFailureResponseBody({
          message: `A duration must be provided as required by administrator settings. Please contact your administrator if you need to create a lease without specifying a duration.`,
        }),
      },
      {
        maxSpend: undefined,
        leaseDurationInHours: 200, // exceeded max
        expectedErrorMessage: createFailureResponseBody({
          message: `A max budget must be provided as required by administrator settings. Please contact your administrator if you need to create a lease without specifying a max budget.`,
        }),
      },
    ])(
      `should return 400 when unlimited budget/spend is provided when not enabled in AppConfig`,
      async ({ maxSpend, leaseDurationInHours, expectedErrorMessage }) => {
        const mockedGlobalConfig = mockGlobalConfig();
        mockedGlobalConfig.leases.maxBudget = 500;
        mockedGlobalConfig.leases.maxDurationHours = 500;
        mockedGlobalConfig.leases.requireMaxBudget = true;
        mockedGlobalConfig.leases.requireMaxDuration = true;
        mockedGlobalConfig.leases.leaseSharingEnabled = true;

        mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

        const leaseTemplate = generateSchemaData(
          PersistedLeaseTemplateSchema.omit({
            uuid: true,
            createdBy: true,
            blueprintName: true,
            meta: true,
          }),
          {
            maxSpend,
            leaseDurationInHours,
          },
        );

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leaseTemplates",
          body: JSON.stringify(leaseTemplate),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        expect(
          await handler(
            event,
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          ),
        ).toEqual({
          statusCode: 400,
          body: expectedErrorMessage,
          headers: expect.objectContaining(
            responseHeadersWithErrorType("ValidationError"),
          ),
        });
      },
    );

    it("should return 200 and create lease template with PUBLIC visibility", async () => {
      const leaseTemplate = generateSchemaData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          meta: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          visibility: "PUBLIC",
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );

      const createdTemplate = {
        ...leaseTemplate,
        uuid: mockUuid,
        createdBy: isbAuthorizedUser.user.email,
      };

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "create").mockResolvedValue(
        createdTemplate,
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response).toEqual({
        statusCode: 201,
        body: serializedBodyLike({
          status: "success",
          data: createdTemplate,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should create lease template with PRIVATE visibility", async () => {
      const leaseTemplate = generateSchemaData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          meta: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          visibility: "PRIVATE",
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );

      const createdTemplate = {
        ...leaseTemplate,
        uuid: mockUuid,
        createdBy: isbAuthorizedUser.user.email,
      };

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "create").mockResolvedValue(
        createdTemplate,
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response).toEqual({
        statusCode: 201,
        body: serializedBodyLike({
          status: "success",
          data: createdTemplate,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should default to PUBLIC visibility when not specified", async () => {
      const leaseTemplate = generateSchemaData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          visibility: true,
          blueprintName: true,
          meta: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );

      const createdTemplate = {
        ...leaseTemplate,
        uuid: mockUuid,
        createdBy: isbAuthorizedUser.user.email,
        visibility: "PUBLIC" as const, // Should default to PUBLIC
      };

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "create").mockResolvedValue(
        createdTemplate,
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response).toEqual({
        statusCode: 201,
        body: serializedBodyLike({
          status: "success",
          data: createdTemplate,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 500 response when db call throws unexpected error", async () => {
      const leaseTemplate = generateSchemaData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          meta: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        body: JSON.stringify(leaseTemplate),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "update").mockImplementation(
        () => {
          throw new Error();
        },
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("InternalServerError"),
        ),
      });
    });

    it("should resolve blueprintName when blueprintId is provided", async () => {
      const blueprintId = "550e8400-e29b-41d4-a716-446655440000";
      const leaseTemplate = generateSchemaData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          meta: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId,
        },
      );

      vi.spyOn(DynamoBlueprintStore.prototype, "get").mockResolvedValue({
        result: {
          blueprint: { name: "Resolved-Blueprint" },
          stackSets: [],
        },
      } as any);

      const createSpy = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "create")
        .mockResolvedValue({
          ...leaseTemplate,
          uuid: mockUuid,
          createdBy: isbAuthorizedUser.user.email,
          blueprintName: "Resolved-Blueprint",
        });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(201);
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          blueprintId,
          blueprintName: "Resolved-Blueprint",
        }),
      );
    });

    it("should return 400 when blueprintId references non-existent blueprint", async () => {
      const leaseTemplate = generateSchemaData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          meta: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: "550e8400-e29b-41d4-a716-446655440000",
        },
      );

      vi.spyOn(DynamoBlueprintStore.prototype, "get").mockResolvedValue({
        result: undefined,
      } as any);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message: "Referenced blueprint not found.",
        }),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("ValidationError"),
        ),
      });
    });

    it("should set blueprintName to null when no blueprintId is provided", async () => {
      const leaseTemplate = generateSchemaData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          meta: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );

      const createSpy = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "create")
        .mockResolvedValue({
          ...leaseTemplate,
          uuid: mockUuid,
          createdBy: isbAuthorizedUser.user.email,
          blueprintName: null,
        });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(201);
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          blueprintName: null,
        }),
      );
      expect(DynamoBlueprintStore.prototype.get).not.toHaveBeenCalled();
    });

    it("should return 400 when allowOwnerToShareLease is true and leaseSharingEnabled is false", async () => {
      const disabledSharingConfig = {
        ...mockedGlobalConfig,
        leases: {
          ...mockedGlobalConfig.leases,
          leaseSharingEnabled: false,
        },
      };
      mockAppConfigMiddleware(disabledSharingConfig, mockedReportingConfig);

      const leaseTemplate = generateSchemaData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          meta: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
          allowOwnerToShareLease: true,
        },
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, disabledSharingConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message:
            "Cannot enable allowOwnerToShareLease because lease sharing is not available.",
        }),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("ValidationError"),
        ),
      });
    });

    // The body parser returns 415 for three conditions; only a non-JSON
    // Content-Type is genuinely a media-type problem.
    it("should return 415 when Content-Type is not JSON", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "text/plain",
        },
        isbUser: isbAuthorizedUser.user,
        body: "name=test",
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 415,
        body: createFailureResponseBody({
          message: "Unsupported Media Type.",
        }),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("UnsupportedMediaTypeError"),
        ),
      });
    });

    it("rejects a Content-Type carrying parameters (e.g. charset)", async () => {
      const leaseTemplate = generateSchemaData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          meta: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      const uuid = randomUUID();
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "create").mockResolvedValue({
        ...leaseTemplate,
        uuid,
        createdBy: isbAuthorizedUser.user.email,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      // restJson1 requires an exact `application/json` Content-Type; a `charset`
      // parameter is a 415. The pre-Smithy `httpJsonBodyParser` accepted it — an
      // accepted deviation of the Smithy migration.
      expect(response).toEqual({
        statusCode: 415,
        body: createFailureResponseBody({
          message: "Unsupported Media Type.",
        }),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("UnsupportedMediaTypeError"),
        ),
      });
    });

    it("should return exactly the JSend success envelope keys", async () => {
      const leaseTemplate = generateSchemaData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          meta: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "create").mockResolvedValue({
        ...leaseTemplate,
        uuid: randomUUID(),
        createdBy: isbAuthorizedUser.user.email,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      // The exact key set is part of the contract: no top-level "message".
      expect(Object.keys(JSON.parse(response.body)).sort()).toEqual([
        "data",
        "status",
      ]);
    });

    it("should return the bare entity in data, not a result wrapper", async () => {
      const leaseTemplate = generateSchemaData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
          meta: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leaseTemplates",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "create").mockResolvedValue({
        ...leaseTemplate,
        uuid: mockUuid,
        createdBy: isbAuthorizedUser.user.email,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      // POST returns the entity directly; GET returns
      // { result, nextPageIdentifier }. The shapes differ inside data.
      const { data } = JSON.parse(response.body);
      expect(data.uuid).toBe(mockUuid);
      expect(data).not.toHaveProperty("result");
      expect(data).not.toHaveProperty("nextPageIdentifier");
    });
  });

  describe("GET /leaseTemplates/{leaseTemplateId}", () => {
    it("extracts the id from the request path, not from pathParameters", async () => {
      // The generated mux binds the {leaseTemplateId} label from `event.path`.
      // The pre-Smithy CDK resource is `{leaseTemplateName}`, and the removed Middy
      // router used to repopulate `pathParameters.leaseTemplateId` from its route
      // pattern — so this asserts the id now comes from the path segment and that
      // an empty `pathParameters` does not break routing.
      const pathId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const getSpy = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "get")
        .mockResolvedValue({
          result: generateSchemaData(PersistedLeaseTemplateSchema, {
            uuid: pathId,
            visibility: "PUBLIC",
          }),
        });

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "GET",
          path: `/leaseTemplates/${pathId}`,
          pathParameters: {},
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      expect(getSpy).toHaveBeenCalledWith(pathId);
    });

    it("should return 200 response with a single lease template", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: mockUuid,
        },
        isbUser: isbAuthorizedUser.user,
      });

      const leaseTemplate = generateSchemaData(PersistedLeaseTemplateSchema);

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: leaseTemplate,
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: serializedBodyLike({
          status: "success",
          data: leaseTemplate,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 200 and allow Admin/Manager to access PRIVATE templates", async () => {
      const privateTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
        visibility: "PRIVATE",
      });

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: privateTemplate,
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: privateTemplate.uuid,
        },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response).toEqual({
        statusCode: 200,
        body: serializedBodyLike({
          status: "success",
          data: privateTemplate,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 404 and deny User role access to PRIVATE templates", async () => {
      const privateTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
        visibility: "PRIVATE",
      });

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: privateTemplate,
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: privateTemplate.uuid,
        },
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      const userOnlyContext = {
        ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
        user: isbAuthorizedUserUserRoleOnly.user,
      };

      const response = await handler(event, userOnlyContext);

      expect(response).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: "Lease template not found.",
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 200 allow User role to access PUBLIC templates", async () => {
      const publicTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
        visibility: "PUBLIC",
      });

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: publicTemplate,
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: publicTemplate.uuid,
        },
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      const userOnlyContext = {
        ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
        user: isbAuthorizedUserUserRoleOnly.user,
      };

      const response = await handler(event, userOnlyContext);

      expect(response).toEqual({
        statusCode: 200,
        body: serializedBodyLike({
          status: "success",
          data: publicTemplate,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 404 response when lease template is not found", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: mockUuid,
        },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: undefined,
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: `Lease template not found.`,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });
    it("should return 500 response when db call throws unexpected error", async () => {
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockImplementation(
        () => {
          throw new Error();
        },
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leaseTemplates/{leaseTemplateId}",
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("InternalServerError"),
        ),
      });
    });
  });

  describe("PUT /leaseTemplates/{leaseTemplateId}", () => {
    beforeEach(() => {
      // The PUT handler fetches the existing template to make config-compliance
      // validation change-aware (cost report group, max budget, duration).
      // Default to an existing template with no cost report group; individual
      // tests override as needed.
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: generateSchemaData(PersistedLeaseTemplateSchema, {
          uuid: mockUuid,
          costReportGroup: undefined,
        }),
      });
    });

    it("should return 200 response with updated data", async () => {
      const oldLeaseTemplate = generateSchemaData(
        PersistedLeaseTemplateSchema,
        {
          uuid: mockUuid,
        },
      );
      const newLeaseTemplateJsonBody = generateSchemaData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: mockUuid,
        },
        body: JSON.stringify(newLeaseTemplateJsonBody),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const updatedItem = {
        ...newLeaseTemplateJsonBody,
        uuid: oldLeaseTemplate.uuid,
        createdBy: oldLeaseTemplate.createdBy,
      };
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "update").mockReturnValue(
        Promise.resolve({
          newItem: updatedItem,
          oldItem: oldLeaseTemplate,
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: serializedBodyLike({
          status: "success",
          data: updatedItem,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("rejects an invalid date-time in meta with the generic 400 (deviation)", async () => {
      // `meta.createdTime` is modeled `@timestampFormat("date-time")`, so an
      // invalid date-time fails generated deserialization before the operation's
      // Zod parse — the generic restJson1 400, not the pre-Smithy field-specific
      // message. Accepted deviation of the Smithy migration.
      const validBody = generateSchemaData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
          meta: undefined,
        },
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: { leaseTemplateId: mockUuid },
        body: JSON.stringify({
          ...validBody,
          meta: { createdTime: "not-a-date", schemaVersion: 1 },
        }),
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message:
            "Invalid JSON in request body. Please check your JSON syntax.",
        }),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("ValidationError"),
        ),
      });
    });

    it("allows updating other fields when a required cost report group is already missing", async () => {
      // Existing template has no cost report group and one is now required.
      // Editing an unrelated field (maxSpend) must still succeed.
      mockAppConfigMiddleware(mockedGlobalConfig, testReportingConfigRequired);
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: generateSchemaData(PersistedLeaseTemplateSchema, {
          uuid: mockUuid,
          costReportGroup: undefined,
        }),
      });

      const newLeaseTemplateJsonBody = generateSchemaData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
        }),
        {
          maxSpend: 75,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "update").mockResolvedValue({
        newItem: {
          ...newLeaseTemplateJsonBody,
          uuid: mockUuid,
          createdBy: "original.author@example.com",
        },
        oldItem: generateSchemaData(PersistedLeaseTemplateSchema, {
          uuid: mockUuid,
        }),
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: mockUuid,
        },
        body: JSON.stringify(newLeaseTemplateJsonBody),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toEqual(200);
    });

    it("allows updating other fields when a required duration/budget is already missing", async () => {
      // Existing template predates the requirement: no maxSpend / duration.
      // Budget and duration are now required. Editing an unrelated field
      // (costReportGroup) must still succeed, leaving the missing fields as-is.
      const requiredConfig = mockGlobalConfig();
      requiredConfig.leases.maxBudget = 500;
      requiredConfig.leases.maxDurationHours = 500;
      requiredConfig.leases.requireMaxBudget = true;
      requiredConfig.leases.requireMaxDuration = true;
      requiredConfig.leases.leaseSharingEnabled = true;
      mockAppConfigMiddleware(requiredConfig, testReportingConfig);

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: generateSchemaData(PersistedLeaseTemplateSchema, {
          uuid: mockUuid,
          maxSpend: undefined,
          leaseDurationInHours: undefined,
          costReportGroup: undefined,
        }),
      });

      const newLeaseTemplateJsonBody = generateSchemaData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
        }),
        {
          maxSpend: undefined,
          leaseDurationInHours: undefined,
          costReportGroup: "valid-group-1",
          allowOwnerToShareLease: false,
          blueprintId: undefined,
        },
      );

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "update").mockResolvedValue({
        newItem: {
          ...newLeaseTemplateJsonBody,
          uuid: mockUuid,
          createdBy: "original.author@example.com",
        },
        oldItem: generateSchemaData(PersistedLeaseTemplateSchema, {
          uuid: mockUuid,
        }),
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: mockUuid,
        },
        body: JSON.stringify(newLeaseTemplateJsonBody),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, requiredConfig),
      );

      expect(response.statusCode).toEqual(200);
    });

    it("should return 400 response when body is missing", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: mockUuid,
        },
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "update").mockReturnValue(
        Promise.resolve({
          newItem: generateSchemaData(PersistedLeaseTemplateSchema),
          oldItem: generateSchemaData(PersistedLeaseTemplateSchema),
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        // A missing body no longer produces the pre-Smithy "Body not provided."
        // message: required-member-ness is expressible by the model, so Smithy
        // renders the per-field 400 before the operation runs. (Modeled
        // ValidationError → alphabetized envelope, so compare structurally.)
        body: jsendFailBodyLike(
          {
            field: "name",
            message:
              "Value at '/name' failed to satisfy constraint: Member must not be null",
          },
          {
            field: "requiresApproval",
            message:
              "Value at '/requiresApproval' failed to satisfy constraint: Member must not be null",
          },
        ),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("ValidationError"),
        ),
      });
    });
    it("should return 400 response when body fails to parse", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: mockUuid,
        },
        body: "not-a-json",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "update").mockReturnValue(
        Promise.resolve({
          newItem: generateSchemaData(PersistedLeaseTemplateSchema),
          oldItem: generateSchemaData(PersistedLeaseTemplateSchema),
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message:
            "Invalid JSON in request body. Please check your JSON syntax.",
        }),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("ValidationError"),
        ),
      });
    });
    it("should return 400 response when body is malformed", async () => {
      const leaseTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
        blueprintName: undefined,
        maxSpend: 50,
        leaseDurationInHours: 24,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: leaseTemplate.uuid,
        },
        body: JSON.stringify(leaseTemplate),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "update").mockReturnValue(
        Promise.resolve({
          newItem: generateSchemaData(PersistedLeaseTemplateSchema),
          oldItem: generateSchemaData(PersistedLeaseTemplateSchema),
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "input",
          message: 'Unrecognized keys: "uuid", "createdBy"',
        }),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("ValidationError"),
        ),
      });
    });
    it.each([
      {
        maxSpend: 200, // exceeded max
        leaseDurationInHours: 50,
        expectedErrorMessage: createFailureResponseBody({
          message: `Max budget cannot be greater than the global max budget (${mockedGlobalConfig.leases.maxBudget}).`,
        }),
      },
      {
        maxSpend: 50,
        leaseDurationInHours: 200, // exceeded max
        expectedErrorMessage: createFailureResponseBody({
          message: `Duration cannot be greater than the global max duration (${mockedGlobalConfig.leases.maxDurationHours}).`,
        }),
      },
    ])(
      `should return 400 when lease template values exceed global configuration: $expectedErrorMessage`,
      async ({ maxSpend, leaseDurationInHours, expectedErrorMessage }) => {
        const leaseTemplate = generateSchemaData(
          PersistedLeaseTemplateSchema.omit({
            uuid: true,
            createdBy: true,
            blueprintName: true,
          }),
          {
            maxSpend,
            leaseDurationInHours,
          },
        );

        const event = createAPIGatewayProxyEvent({
          httpMethod: "PUT",
          path: "/leaseTemplates/{leaseTemplateId}",
          pathParameters: {
            leaseTemplateId: mockUuid,
          },
          body: JSON.stringify(leaseTemplate),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        expect(
          await handler(
            event,
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          ),
        ).toEqual({
          statusCode: 400,
          body: expectedErrorMessage,
          headers: expect.objectContaining(
            responseHeadersWithErrorType("ValidationError"),
          ),
        });
      },
    );

    it.each([
      {
        costReportGroup: "invalid-group",
        previousCostReportGroup: undefined,
        reportingConfig: testReportingConfig,
        expectedError: "Invalid cost report group",
      },
      {
        // Clearing a previously-set group when one is required is still blocked.
        costReportGroup: undefined,
        previousCostReportGroup: "valid-group-1",
        blueprintId: undefined,
        reportingConfig: testReportingConfigRequired,
        expectedError:
          "A cost report group must be provided as required by administrator settings. Please contact your administrator if you need to create a lease without specifying a cost report group.",
      },
    ])(
      "should return 400 when lease template update violates cost reporting constraints",
      async ({
        costReportGroup,
        previousCostReportGroup,
        reportingConfig,
        expectedError,
      }) => {
        mockAppConfigMiddleware(mockedGlobalConfig, reportingConfig);

        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: generateSchemaData(PersistedLeaseTemplateSchema, {
            uuid: mockUuid,
            costReportGroup: previousCostReportGroup,
          }),
        });

        const leaseTemplate = generateSchemaData(
          PersistedLeaseTemplateSchema.omit({
            uuid: true,
            createdBy: true,
            blueprintName: true,
          }),
          {
            maxSpend: 50,
            leaseDurationInHours: 24,
            costReportGroup,
          },
        );

        const event = createAPIGatewayProxyEvent({
          httpMethod: "PUT",
          path: "/leaseTemplates/{leaseTemplateId}",
          pathParameters: {
            leaseTemplateId: mockUuid,
          },
          body: JSON.stringify(leaseTemplate),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        expect(
          await handler(
            event,
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          ),
        ).toEqual({
          statusCode: 400,
          body: createFailureResponseBody({ message: expectedError }),
          headers: expect.objectContaining(
            responseHeadersWithErrorType("ValidationError"),
          ),
        });
      },
    );

    it.each([
      {
        maxSpend: 200,
        leaseDurationInHours: undefined,
        expectedErrorMessage: createFailureResponseBody({
          message: `A duration must be provided as required by administrator settings. Please contact your administrator if you need to create a lease without specifying a duration.`,
        }),
      },
      {
        maxSpend: undefined,
        leaseDurationInHours: 200, // exceeded max
        expectedErrorMessage: createFailureResponseBody({
          message: `A max budget must be provided as required by administrator settings. Please contact your administrator if you need to create a lease without specifying a max budget.`,
        }),
      },
    ])(
      `should return 400 when unlimited budget/spend is provided when not enabled in AppConfig`,
      async ({ maxSpend, leaseDurationInHours, expectedErrorMessage }) => {
        const mockedGlobalConfig = mockGlobalConfig();
        mockedGlobalConfig.leases.maxBudget = 500;
        mockedGlobalConfig.leases.maxDurationHours = 500;
        mockedGlobalConfig.leases.requireMaxBudget = true;
        mockedGlobalConfig.leases.requireMaxDuration = true;
        mockedGlobalConfig.leases.leaseSharingEnabled = true;

        mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

        // Existing template HAS budget + duration set, so submitting an
        // unlimited (missing) value is a genuine change and must be rejected —
        // not treated as an unchanged pre-existing gap. (Pin both so the
        // change-aware validation is deterministic.)
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: generateSchemaData(PersistedLeaseTemplateSchema, {
            uuid: mockUuid,
            maxSpend: 100,
            leaseDurationInHours: 50,
            costReportGroup: undefined,
          }),
        });

        const leaseTemplate = generateSchemaData(
          PersistedLeaseTemplateSchema.omit({
            uuid: true,
            createdBy: true,
            blueprintName: true,
          }),
          {
            maxSpend,
            leaseDurationInHours,
            // Pin so the (randomly generated) group can't trip the cost-report
            // validation before the budget/duration check under test.
            costReportGroup: undefined,
          },
        );

        const event = createAPIGatewayProxyEvent({
          httpMethod: "PUT",
          path: "/leaseTemplates/{leaseTemplateId}",
          pathParameters: {
            leaseTemplateId: mockUuid,
          },
          body: JSON.stringify(leaseTemplate),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        expect(
          await handler(
            event,
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          ),
        ).toEqual({
          statusCode: 400,
          body: expectedErrorMessage,
          headers: expect.objectContaining(
            responseHeadersWithErrorType("ValidationError"),
          ),
        });
      },
    );

    it("should return 500 response when db call throws unexpected error", async () => {
      const leaseTemplate = generateSchemaData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: mockUuid,
        },
        body: JSON.stringify(leaseTemplate),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "update").mockImplementation(
        () => {
          throw new Error();
        },
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("InternalServerError"),
        ),
      });
    });

    it("should return 200 and update lease template visibility from PUBLIC to PRIVATE", async () => {
      const oldTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
        visibility: "PUBLIC",
      });

      const updatedTemplate = generateSchemaData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          visibility: "PRIVATE",
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );

      const resultTemplate = {
        ...updatedTemplate,
        uuid: oldTemplate.uuid,
        createdBy: oldTemplate.createdBy,
      };

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "update").mockResolvedValue({
        newItem: resultTemplate,
        oldItem: oldTemplate,
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: oldTemplate.uuid,
        },
        body: JSON.stringify(updatedTemplate),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response).toEqual({
        statusCode: 200,
        body: serializedBodyLike({
          status: "success",
          data: resultTemplate,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("rejects a request body that tries to set createdBy", async () => {
      // createdBy is server-owned and immutable after create, so the strict
      // schema rejects it outright rather than silently ignoring it.
      const body = {
        ...generateSchemaData(
          PersistedLeaseTemplateSchema.omit({
            uuid: true,
            createdBy: true,
            blueprintName: true,
          }),
          {
            maxSpend: 50,
            leaseDurationInHours: 24,
            costReportGroup: undefined,
            blueprintId: undefined,
          },
        ),
        createdBy: "attacker@example.com",
      };

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: { leaseTemplateId: mockUuid },
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "input",
          message: 'Unrecognized key: "createdBy"',
        }),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("ValidationError"),
        ),
      });
    });

    it("persists the original createdBy from the existing record", async () => {
      // Even though the body can no longer carry createdBy, the handler must
      // still put the ORIGINAL creator on the updated record (not drop it, and
      // not substitute the caller's identity).
      const originalCreatedBy = "original.author@example.com";
      const persisted = generateSchemaData(PersistedLeaseTemplateSchema, {
        uuid: mockUuid,
        createdBy: originalCreatedBy,
        costReportGroup: undefined,
      });
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: persisted,
      });

      const body = generateSchemaData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );

      // Echo back exactly what the handler handed the store, so the assertion
      // reflects the handler's own output rather than the DAO's safety net.
      const updateSpy = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "update")
        .mockImplementation(async (template) => ({
          newItem: template,
          oldItem: persisted,
        }));

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: { leaseTemplateId: mockUuid },
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(updateSpy.mock.calls[0]![0].createdBy).toBe(originalCreatedBy);
      expect(JSON.parse(response.body).data.createdBy).toBe(originalCreatedBy);
    });

    it("returns 404 for a missing template even when the body would also fail validation", async () => {
      // The existence check must run before blueprint resolution and config
      // validation, otherwise a bad blueprintId masks the real 404 with a
      // "Referenced blueprint not found." 400.
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: undefined,
      });
      const blueprintGet = vi
        .spyOn(DynamoBlueprintStore.prototype, "get")
        .mockResolvedValue({ result: undefined } as any);

      const body = generateSchemaData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: "550e8400-e29b-41d4-a716-446655440000",
        },
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: { leaseTemplateId: mockUuid },
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: "Lease Template not found.",
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      // Bailing early also avoids the needless blueprint lookup.
      expect(blueprintGet).not.toHaveBeenCalled();
    });

    it("returns 404 when updating a template that does not exist", async () => {
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
        result: undefined,
      });

      const body = generateSchemaData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: { leaseTemplateId: mockUuid },
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: "Lease Template not found.",
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 200 and update lease template visibility from PRIVATE to PUBLIC", async () => {
      const oldTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
        visibility: "PRIVATE",
      });

      const updatedTemplate = generateSchemaData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          visibility: "PUBLIC",
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );

      const resultTemplate = {
        ...updatedTemplate,
        uuid: oldTemplate.uuid,
        createdBy: oldTemplate.createdBy,
      };

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "update").mockResolvedValue({
        newItem: resultTemplate,
        oldItem: oldTemplate,
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: oldTemplate.uuid,
        },
        body: JSON.stringify(updatedTemplate),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response).toEqual({
        statusCode: 200,
        body: serializedBodyLike({
          status: "success",
          data: resultTemplate,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 404 response when the item is deleted between read and write", async () => {
      const leaseTemplate = generateSchemaData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
        },
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: mockUuid,
        },
        body: JSON.stringify(leaseTemplate),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      // Existence is already checked before this point, so this covers the
      // residual race: the row is deleted between that read and the write, and
      // update() surfaces UnknownItem, which maps to a 404.
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "update").mockImplementation(
        () => {
          throw new UnknownItem("Lease template not found.");
        },
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: "Lease Template not found.",
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should resolve blueprintName when blueprintId is provided on update", async () => {
      const blueprintId = "550e8400-e29b-41d4-a716-446655440000";
      const leaseTemplate = generateSchemaData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId,
        },
      );

      vi.spyOn(DynamoBlueprintStore.prototype, "get").mockResolvedValue({
        result: {
          blueprint: { name: "Resolved-Blueprint" },
          stackSets: [],
        },
      } as any);

      const updateSpy = vi
        .spyOn(DynamoLeaseTemplateStore.prototype, "update")
        .mockResolvedValue({
          oldItem: generateSchemaData(PersistedLeaseTemplateSchema),
          newItem: {
            ...leaseTemplate,
            uuid: mockUuid,
            createdBy: "original.author@example.com",
            blueprintName: "Resolved-Blueprint",
          },
        });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: { leaseTemplateId: mockUuid },
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          blueprintId,
          blueprintName: "Resolved-Blueprint",
        }),
      );
    });

    it("should return 400 when blueprintId references non-existent blueprint on update", async () => {
      const leaseTemplate = generateSchemaData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: "550e8400-e29b-41d4-a716-446655440000",
        },
      );

      vi.spyOn(DynamoBlueprintStore.prototype, "get").mockResolvedValue({
        result: undefined,
      } as any);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: { leaseTemplateId: mockUuid },
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message: "Referenced blueprint not found.",
        }),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("ValidationError"),
        ),
      });
    });

    it("should return 400 when allowOwnerToShareLease is true and leaseSharingEnabled is false", async () => {
      const disabledSharingConfig = {
        ...mockedGlobalConfig,
        leases: {
          ...mockedGlobalConfig.leases,
          leaseSharingEnabled: false,
        },
      };
      mockAppConfigMiddleware(disabledSharingConfig, mockedReportingConfig);

      const leaseTemplate = generateSchemaData(
        PersistedLeaseTemplateSchema.omit({
          uuid: true,
          createdBy: true,
          blueprintName: true,
        }),
        {
          maxSpend: 50,
          leaseDurationInHours: 24,
          costReportGroup: undefined,
          blueprintId: undefined,
          allowOwnerToShareLease: true,
        },
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: { leaseTemplateId: mockUuid },
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
        body: JSON.stringify(leaseTemplate),
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, disabledSharingConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message:
            "Cannot enable allowOwnerToShareLease because lease sharing is not available.",
        }),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("ValidationError"),
        ),
      });
    });
  });

  describe("DELETE /leaseTemplates/{leaseTemplateId}", () => {
    it("should return 200 response with no data", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "DELETE",
        path: "/leaseTemplates/{leaseTemplateId}",
        pathParameters: {
          leaseTemplateId: mockUuid,
        },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseTemplateStore.prototype, "delete").mockReturnValue(
        Promise.resolve(
          Promise.resolve(generateSchemaData(PersistedLeaseTemplateSchema)),
        ),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: serializedBodyLike({
          status: "success",
          data: null,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });
    it("should return 500 response when db call throws unexpected error", async () => {
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "delete").mockImplementation(
        () => {
          throw new Error();
        },
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "DELETE",
        path: "/leaseTemplates/{leaseTemplateId}",
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: expect.objectContaining(
          responseHeadersWithErrorType("InternalServerError"),
        ),
      });
    });
  });
});
