// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { ConflictError } from "@amzn/innovation-sandbox-commons/data/config/config-store.js";
import {
  ConfigSchemas,
  ConfigSection,
} from "@amzn/innovation-sandbox-commons/data/config/config.js";
import { ConfigurationLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/config-lambda-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  createAPIGatewayProxyEvent,
  createErrorResponseBody,
  isbAuthorizedUser,
  mockAuthorizedContext,
  mockGlobalConfig,
  responseHeaders,
} from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  bulkStubEnv,
  mockAppConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { IsbUser } from "@amzn/innovation-sandbox-commons/utils/auth-utils.js";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Mock the account pool stack config store
vi.mock(
  "@amzn/innovation-sandbox-commons/data/account-pool-stack-config/account-pool-stack-config-store.js",
  () => ({
    getAccountPoolStackConfig: vi.fn(),
  }),
);

// Mock the SES client for email-from identity verification
const mockSesSend = vi.fn();
vi.mock("@aws-sdk/client-ses", () => ({
  SESClient: class {
    send = mockSesSend;
  },
  GetIdentityVerificationAttributesCommand: class {
    constructor(public input: { Identities: string[] }) {}
  },
}));

const testEnv = generateSchemaData(ConfigurationLambdaEnvironmentSchema, {
  CONFIG_TABLE_NAME: "test-config-table",
  AWS_ACCESS_PORTAL_URL: "https://example.awsapps.com/start",
});
const mockedGlobalConfig = mockGlobalConfig();
let handler: typeof import("@amzn/innovation-sandbox-configurations/configurations-handler.js").handler;

beforeAll(async () => {
  bulkStubEnv(testEnv);

  handler = (
    await import("@amzn/innovation-sandbox-configurations/configurations-handler.js")
  ).handler;
});

beforeEach(() => {
  bulkStubEnv(testEnv);
  mockAppConfigMiddleware(mockedGlobalConfig);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("Configurations Handler", async () => {
  it("should return 500 response when environment variables are misconfigured", async () => {
    vi.unstubAllEnvs();

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/configurations",
      isbUser: isbAuthorizedUser.user,
    });
    expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
      statusCode: 500,
      body: createErrorResponseBody("An unexpected error occurred."),
      headers: responseHeaders,
    });
  });

  it("should return 500 when CONFIG_TABLE_NAME is not set", async () => {
    vi.stubEnv("CONFIG_TABLE_NAME", "");

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/configurations",
      isbUser: isbAuthorizedUser.user,
    });
    expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
      statusCode: 500,
      body: createErrorResponseBody("An unexpected error occurred."),
      headers: responseHeaders,
    });
  });

  it("should return 500 when AWS_ACCESS_PORTAL_URL is not set", async () => {
    vi.stubEnv("AWS_ACCESS_PORTAL_URL", "");

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/configurations",
      isbUser: isbAuthorizedUser.user,
    });
    expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
      statusCode: 500,
      body: createErrorResponseBody("An unexpected error occurred."),
      headers: responseHeaders,
    });
  });

  describe("GET /configurations", () => {
    it("should return 200 with all configurations", async () => {
      const mockIsbManagedRegions = ["us-east-1", "us-west-2"];
      const mockAccountPoolConfig = {
        sandboxOuId: "ou-123",
        availableOuId: "ou-456",
        activeOuId: "ou-789",
        frozenOuId: "ou-012",
        cleanupOuId: "ou-345",
        quarantineOuId: "ou-678",
        entryOuId: "ou-901",
        exitOuId: "ou-234",
        solutionVersion: "1.0.0",
        supportedSchemas: '["1"]',
        isbManagedRegions: mockIsbManagedRegions,
      };

      // Mock the SsmAccountPoolStackConfigStore to return the account pool config
      const { SsmAccountPoolStackConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/account-pool-stack-config/ssm-account-pool-stack-config-store.js");
      vi.spyOn(
        SsmAccountPoolStackConfigStore.prototype,
        "get",
      ).mockResolvedValue(mockAccountPoolConfig);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/configurations",
        isbUser: isbAuthorizedUser.user,
      });
      const context = mockAuthorizedContext(testEnv);

      const response = await handler(event, context);

      expect(response.statusCode).toBe(200);
      expect(response.headers).toEqual(responseHeaders);

      const body = JSON.parse(response.body);
      expect(body.status).toBe("success");
      for (const section of Object.keys(ConfigSchemas) as ConfigSection[]) {
        expect(body.data[section]).toEqual({
          ...mockedGlobalConfig[section],
          lastSavedBy: null,
          meta: {
            createdTime: expect.any(String),
            lastEditTime: expect.any(String),
            schemaVersion: 1,
          },
        });
      }
      expect(body.data.isbManagedRegions).toEqual(mockIsbManagedRegions);
      expect(body.data.awsAccessPortalUrl).toEqual(
        testEnv.AWS_ACCESS_PORTAL_URL,
      );
    });

    it("returns code defaults with lastSavedBy null for sections absent from DynamoDB", async () => {
      const { DynamoConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
      vi.spyOn(DynamoConfigStore.prototype, "getAllSections").mockResolvedValue(
        {},
      );

      const { SsmAccountPoolStackConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/account-pool-stack-config/ssm-account-pool-stack-config-store.js");
      vi.spyOn(
        SsmAccountPoolStackConfigStore.prototype,
        "get",
      ).mockResolvedValue({ isbManagedRegions: ["us-east-1"] } as any);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/configurations",
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      for (const section of Object.keys(ConfigSchemas) as ConfigSection[]) {
        expect(body.data[section]).toEqual({
          ...ConfigSchemas[section].parse({}),
          lastSavedBy: null,
        });
      }
    });
  });

  describe("GET /configurations/{section}", () => {
    it("returns 200 with the stored section when present in DynamoDB", async () => {
      const storedSection = {
        ...mockedGlobalConfig.leases,
        lastSavedBy: "admin@example.com",
        meta: {
          createdTime: "2024-01-01T00:00:00.000Z",
          lastEditTime: "2024-01-02T00:00:00.000Z",
          schemaVersion: 1,
        },
      };
      const { DynamoConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
      vi.spyOn(DynamoConfigStore.prototype, "getSection").mockResolvedValue(
        storedSection as any,
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/configurations/leases",
        pathParameters: { section: "leases" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("success");
      expect(body.data).toEqual(storedSection);
    });

    it("returns 200 with code defaults and lastSavedBy null when section absent", async () => {
      const { DynamoConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
      vi.spyOn(DynamoConfigStore.prototype, "getSection").mockResolvedValue(
        null,
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/configurations/maintenance",
        pathParameters: { section: "maintenance" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toEqual({
        ...ConfigSchemas.maintenance.parse({}),
        lastSavedBy: null,
      });
    });

    it("returns 404 for an unknown section", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/configurations/bogus",
        pathParameters: { section: "bogus" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));

      expect(response.statusCode).toBe(404);
    });

    it("returns 404 for a prototype-chain key", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/configurations/constructor",
        pathParameters: { section: "constructor" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));

      expect(response.statusCode).toBe(404);
    });
  });

  describe("PUT /configurations/{section}", () => {
    function createPutEvent(
      section: string,
      body: Record<string, unknown>,
      isbUser: IsbUser = isbAuthorizedUser.user,
    ) {
      return createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: `/configurations/${section}`,
        pathParameters: { section },
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        isbUser,
      });
    }

    it("returns 200 on first save (no expectedLastEditTime)", async () => {
      const savedSection = {
        ...mockedGlobalConfig.maintenance,
        lastSavedBy: "test@example.com",
        meta: {
          createdTime: "2024-01-01T00:00:00.000Z",
          lastEditTime: "2024-01-01T00:00:00.000Z",
          schemaVersion: 1,
        },
      };
      const { DynamoConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
      const putSpy = vi
        .spyOn(DynamoConfigStore.prototype, "putSection")
        .mockResolvedValue(savedSection as any);

      const response = await handler(
        createPutEvent("maintenance", { enabled: false }),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toEqual(savedSection);
      expect(putSpy).toHaveBeenCalledWith(
        "maintenance",
        { enabled: false },
        "test@example.com",
        undefined,
      );
    });

    it("returns 200 on subsequent save and passes expectedLastEditTime", async () => {
      const { DynamoConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
      const putSpy = vi
        .spyOn(DynamoConfigStore.prototype, "putSection")
        .mockResolvedValue({
          ...mockedGlobalConfig.maintenance,
          lastSavedBy: "test@example.com",
          meta: {
            createdTime: "2024-01-01T00:00:00.000Z",
            lastEditTime: "2024-01-03T00:00:00.000Z",
            schemaVersion: 1,
          },
        } as any);

      const response = await handler(
        createPutEvent("maintenance", {
          enabled: true,
          meta: { lastEditTime: "2024-01-02T00:00:00.000Z" },
        }),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(200);
      expect(putSpy).toHaveBeenCalledWith(
        "maintenance",
        { enabled: true },
        "test@example.com",
        "2024-01-02T00:00:00.000Z",
      );
    });

    it("strips client-supplied lastSavedBy from the request body", async () => {
      const { DynamoConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
      const putSpy = vi
        .spyOn(DynamoConfigStore.prototype, "putSection")
        .mockResolvedValue({
          ...mockedGlobalConfig.maintenance,
          lastSavedBy: "test@example.com",
          meta: {
            createdTime: "2024-01-01T00:00:00.000Z",
            lastEditTime: "2024-01-01T00:00:00.000Z",
            schemaVersion: 1,
          },
        } as any);

      await handler(
        createPutEvent("maintenance", {
          enabled: false,
          lastSavedBy: "attacker@example.com",
        }),
        mockAuthorizedContext(testEnv),
      );

      expect(putSpy).toHaveBeenCalledWith(
        "maintenance",
        { enabled: false },
        "test@example.com",
        undefined,
      );
    });

    it("returns 409 when the store reports a conflict", async () => {
      const { DynamoConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
      vi.spyOn(DynamoConfigStore.prototype, "putSection").mockRejectedValue(
        new ConflictError("conflict"),
      );

      const response = await handler(
        createPutEvent("maintenance", {
          enabled: false,
          meta: { lastEditTime: "2024-01-02T00:00:00.000Z" },
        }),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(409);
    });

    it("returns 500 when putSection throws an unexpected error", async () => {
      const { DynamoConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
      vi.spyOn(DynamoConfigStore.prototype, "putSection").mockRejectedValue(
        new Error("DynamoDB timeout"),
      );

      const response = await handler(
        createPutEvent("maintenance", { enabled: false }),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain("DynamoDB timeout");
    });

    it("returns 400 when the body fails schema validation", async () => {
      const response = await handler(
        createPutEvent("maintenance", { enabled: "yes" }),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(400);
    });

    it("returns 400 rejecting unknown fields without echoing the submitted value", async () => {
      const response = await handler(
        createPutEvent("maintenance", {
          enabled: false,
          unknownField: "secret-value",
        }),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain("secret-value");
    });

    it("returns 200 for a valid leases section and strips the envelope before putSection", async () => {
      const savedSection = {
        ...mockedGlobalConfig.leases,
        lastSavedBy: "test@example.com",
        meta: {
          createdTime: "2024-01-01T00:00:00.000Z",
          lastEditTime: "2024-01-01T00:00:00.000Z",
          schemaVersion: 1,
        },
      };
      const { DynamoConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
      const putSpy = vi
        .spyOn(DynamoConfigStore.prototype, "putSection")
        .mockResolvedValue(savedSection as any);

      const response = await handler(
        createPutEvent("leases", { ...mockedGlobalConfig.leases }),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toEqual(savedSection);
      expect(putSpy).toHaveBeenCalledWith(
        "leases",
        { ...mockedGlobalConfig.leases },
        "test@example.com",
        undefined,
      );
    });

    it("returns 400 when the leases cross-field refinement is violated", async () => {
      const response = await handler(
        createPutEvent("leases", {
          ...mockedGlobalConfig.leases,
          ttl: 1,
          leaseRequestWindowHours: 168,
        }),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain("days =");
    });

    it("returns 400 rejecting unknown fields in the leases section", async () => {
      const response = await handler(
        createPutEvent("leases", {
          ...mockedGlobalConfig.leases,
          unknownField: "secret-value",
        }),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(400);
    });

    it("returns 404 for an unknown section", async () => {
      const response = await handler(
        createPutEvent("bogus", { enabled: false }),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(404);
    });

    it("returns 403 for an M2M caller", async () => {
      const m2mUser: IsbUser = {
        type: "m2m",
        clientId: "automation-client",
        roles: ["Admin"],
      };

      const response = await handler(
        createPutEvent("maintenance", { enabled: false }, m2mUser),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(403);
    });

    describe("SES email-from validation", () => {
      it("rejects an unverified email address with a field error", async () => {
        mockSesSend.mockResolvedValue({
          VerificationAttributes: {
            "nobody@example.com": { VerificationStatus: "Pending" },
            "example.com": { VerificationStatus: "NotStarted" },
          },
        });

        const response = await handler(
          createPutEvent("notification", { emailFrom: "nobody@example.com" }),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].field).toBe("emailFrom");
        expect(body.data.errors[0].message).toContain(
          "not a verified SES identity",
        );
        // The message must NOT echo the user-supplied address (reflected input
        // is a pentest finding); the copy is static regardless of the input.
        expect(body.data.errors[0].message).not.toContain("nobody@example.com");
      });

      it("allows an email whose exact address is verified", async () => {
        const { DynamoConfigStore } =
          await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
        vi.spyOn(DynamoConfigStore.prototype, "putSection").mockResolvedValue({
          emailFrom: "verified@example.com",
          lastSavedBy: "test@example.com",
          meta: { createdTime: "t", lastEditTime: "t", schemaVersion: 1 },
        } as any);

        mockSesSend.mockResolvedValue({
          VerificationAttributes: {
            "verified@example.com": { VerificationStatus: "Success" },
            "example.com": {},
          },
        });

        const response = await handler(
          createPutEvent("notification", { emailFrom: "verified@example.com" }),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(200);
      });

      it("allows an email whose domain is verified", async () => {
        const { DynamoConfigStore } =
          await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
        vi.spyOn(DynamoConfigStore.prototype, "putSection").mockResolvedValue({
          emailFrom: "anyone@verified-domain.com",
          lastSavedBy: "test@example.com",
          meta: { createdTime: "t", lastEditTime: "t", schemaVersion: 1 },
        } as any);

        mockSesSend.mockResolvedValue({
          VerificationAttributes: {
            "anyone@verified-domain.com": {},
            "verified-domain.com": { VerificationStatus: "Success" },
          },
        });

        const response = await handler(
          createPutEvent("notification", {
            emailFrom: "anyone@verified-domain.com",
          }),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(200);
      });

      it("allows an email whose parent domain is verified (subdomain)", async () => {
        const { DynamoConfigStore } =
          await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
        vi.spyOn(DynamoConfigStore.prototype, "putSection").mockResolvedValue({
          emailFrom: "user@mail.corp.example.com",
          lastSavedBy: "test@example.com",
          meta: { createdTime: "t", lastEditTime: "t", schemaVersion: 1 },
        } as any);

        mockSesSend.mockResolvedValue({
          VerificationAttributes: {
            "user@mail.corp.example.com": {},
            "mail.corp.example.com": {},
            "corp.example.com": {},
            "example.com": { VerificationStatus: "Success" },
          },
        });

        const response = await handler(
          createPutEvent("notification", {
            emailFrom: "user@mail.corp.example.com",
          }),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(200);
        expect(mockSesSend).toHaveBeenCalledWith(
          expect.objectContaining({
            input: {
              Identities: [
                "user@mail.corp.example.com",
                "mail.corp.example.com",
                "corp.example.com",
                "example.com",
              ],
            },
          }),
        );
      });

      it("rejects the save when SES returns an error (fail-closed)", async () => {
        mockSesSend.mockRejectedValue(new Error("SES throttled"));

        const response = await handler(
          createPutEvent("notification", { emailFrom: "user@example.com" }),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].field).toBe("emailFrom");
        expect(body.data.errors[0].message).toContain(
          "Unable to verify this email against SES",
        );
      });

      it("skips validation when emailFrom is empty (notifications disabled)", async () => {
        const { DynamoConfigStore } =
          await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
        vi.spyOn(DynamoConfigStore.prototype, "putSection").mockResolvedValue({
          emailFrom: "",
          lastSavedBy: "test@example.com",
          meta: { createdTime: "t", lastEditTime: "t", schemaVersion: 1 },
        } as any);

        const response = await handler(
          createPutEvent("notification", { emailFrom: "" }),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(200);
        expect(mockSesSend).not.toHaveBeenCalled();
      });
    });
  });
});
