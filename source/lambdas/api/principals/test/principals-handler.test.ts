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

import { GlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { PrincipalsLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/principals-lambda-environment.js";
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

const testEnv = generateSchemaData(PrincipalsLambdaEnvironmentSchema);
let mockedGlobalConfig: GlobalConfig;

const mockPrincipalStore = {
  getCacheItems: vi.fn(),
  batchPutCacheItems: vi.fn(),
};

const mockIdcService = {
  getCachedPrincipalByAttr: vi.fn(),
};

vi.mock("@amzn/innovation-sandbox-commons/isb-services/index.js", async () => {
  const { DynamoConfigStore } = await vi.importActual<
    typeof import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js")
  >("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
  return {
    IsbServices: {
      principalStore: vi.fn().mockReturnValue(mockPrincipalStore),
      idcService: vi.fn().mockReturnValue(mockIdcService),
      configStore: vi.fn().mockReturnValue(new DynamoConfigStore({} as any)),
    },
  };
});

vi.mock(
  "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js",
  () => ({
    fromTemporaryIsbIdcCredentials: vi.fn().mockReturnValue({}),
  }),
);

let handler: typeof import("@amzn/innovation-sandbox-principals-handler/principals-handler.js").handler;

beforeAll(async () => {
  bulkStubEnv(testEnv);
  handler = (
    await import("@amzn/innovation-sandbox-principals-handler/principals-handler.js")
  ).handler;
});

beforeEach(() => {
  bulkStubEnv(testEnv);
  mockedGlobalConfig = mockGlobalConfig();
  mockedGlobalConfig.maintenance.enabled = false;
  mockedGlobalConfig.leases.leaseSharingEnabled = false;
  mockedGlobalConfig.leases.enablePrincipalSearch = true;
  mockAppConfigMiddleware(mockedGlobalConfig);
  mockPrincipalStore.getCacheItems.mockResolvedValue([]);
  mockPrincipalStore.batchPutCacheItems.mockResolvedValue(undefined);
  mockIdcService.getCachedPrincipalByAttr.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("GET /principals/search", () => {
  function cachedUser(displayName: string, email: string) {
    const id = crypto.randomUUID();
    return {
      pk: "principalCache" as const,
      sk: `user#${id}`,
      principalId: id,
      principalType: "USER" as const,
      displayName,
      email,
      syncedAt: "2024-01-01T00:00:00.000Z",
    };
  }

  function cachedGroup(displayName: string) {
    const id = crypto.randomUUID();
    return {
      pk: "principalCache" as const,
      sk: `group#${id}`,
      principalId: id,
      principalType: "GROUP" as const,
      displayName,
      syncedAt: "2024-01-01T00:00:00.000Z",
    };
  }

  it("should return 403 when enablePrincipalSearch is disabled", async () => {
    mockedGlobalConfig.leases.enablePrincipalSearch = false;
    mockAppConfigMiddleware(mockedGlobalConfig);

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/principals/search",
      isbUser: isbAuthorizedUser.user,
    });

    const result = await handler(
      event,
      mockAuthorizedContext(testEnv, mockedGlobalConfig),
    );

    expect(result.statusCode).toBe(403);
    const body = JSON.parse(result.body);
    expect(body.status).toBe("fail");
    expect(body.data.errors[0].message).toContain("not enabled");
  });

  it("should return 200 with all principals when no query", async () => {
    const items = [
      cachedUser("Alice Smith", "alice@example.com"),
      cachedUser("Bob Jones", "bob@example.com"),
      cachedGroup("ISB-Admins"),
      cachedGroup("Developers"),
    ];
    mockPrincipalStore.getCacheItems.mockResolvedValue(items);

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/principals/search",
      isbUser: isbAuthorizedUser.user,
    });

    const result = await handler(
      event,
      mockAuthorizedContext(testEnv, mockedGlobalConfig),
    );

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.status).toBe("success");
    expect(body.data.principals).toHaveLength(4);
    expect(body.data.totalMatches).toBe(4);
    expect(result.headers?.["Content-Type"]).toBe("application/json");
  });

  it("should filter principals by search query (case-insensitive)", async () => {
    mockPrincipalStore.getCacheItems.mockResolvedValue([
      cachedUser("Alice Smith", "alice@example.com"),
      cachedUser("Bob Jones", "bob@example.com"),
      cachedGroup("ISB-Admins"),
    ]);

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/principals/search",
      queryStringParameters: { q: "alice" },
      isbUser: isbAuthorizedUser.user,
    });

    const result = await handler(
      event,
      mockAuthorizedContext(testEnv, mockedGlobalConfig),
    );

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data.principals).toHaveLength(1);
    expect(body.data.principals[0].displayName).toBe("Alice Smith");
    expect(body.data.totalMatches).toBe(1);
  });

  it("should filter by email match", async () => {
    const bob = cachedUser("Bob Jones", "bob@example.com");
    mockPrincipalStore.getCacheItems.mockResolvedValue([
      cachedUser("Alice Smith", "alice@example.com"),
      bob,
    ]);

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/principals/search",
      queryStringParameters: { q: "bob@" },
      isbUser: isbAuthorizedUser.user,
    });

    const result = await handler(
      event,
      mockAuthorizedContext(testEnv, mockedGlobalConfig),
    );

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data.principals).toHaveLength(1);
    expect(body.data.principals[0].principalId).toBe(bob.principalId);
  });

  it("should filter by type=users", async () => {
    mockPrincipalStore.getCacheItems.mockResolvedValue([
      cachedUser("Alice", "alice@example.com"),
    ]);

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/principals/search",
      queryStringParameters: { type: "users" },
      isbUser: isbAuthorizedUser.user,
    });

    const result = await handler(
      event,
      mockAuthorizedContext(testEnv, mockedGlobalConfig),
    );

    expect(result.statusCode).toBe(200);
    expect(mockPrincipalStore.getCacheItems).toHaveBeenCalledWith({
      type: "USER",
    });
  });

  it("should filter by type=groups", async () => {
    mockPrincipalStore.getCacheItems.mockResolvedValue([
      cachedGroup("Engineering"),
    ]);

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/principals/search",
      queryStringParameters: { type: "groups" },
      isbUser: isbAuthorizedUser.user,
    });

    const result = await handler(
      event,
      mockAuthorizedContext(testEnv, mockedGlobalConfig),
    );

    expect(result.statusCode).toBe(200);
    expect(mockPrincipalStore.getCacheItems).toHaveBeenCalledWith({
      type: "GROUP",
    });
  });

  it("should return 400 for invalid type parameter", async () => {
    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/principals/search",
      queryStringParameters: { type: "invalid" },
      isbUser: isbAuthorizedUser.user,
    });

    const result = await handler(
      event,
      mockAuthorizedContext(testEnv, mockedGlobalConfig),
    );

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.status).toBe("fail");
  });

  it("should respect limit parameter", async () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      cachedUser(`User ${i}`, `user${i}@example.com`),
    );
    mockPrincipalStore.getCacheItems.mockResolvedValue(items);

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/principals/search",
      queryStringParameters: { limit: "2" },
      isbUser: isbAuthorizedUser.user,
    });

    const result = await handler(
      event,
      mockAuthorizedContext(testEnv, mockedGlobalConfig),
    );

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data.principals).toHaveLength(2);
    expect(body.data.totalMatches).toBe(5);
  });

  it("should return 200 with empty array when no principals in cache", async () => {
    mockPrincipalStore.getCacheItems.mockResolvedValue([]);

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/principals/search",
      isbUser: isbAuthorizedUser.user,
    });

    const result = await handler(
      event,
      mockAuthorizedContext(testEnv, mockedGlobalConfig),
    );

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.status).toBe("success");
    expect(body.data.principals).toEqual([]);
    expect(body.data.totalMatches).toBe(0);
  });

  it("should return 500 when principal store throws", async () => {
    mockPrincipalStore.getCacheItems.mockRejectedValue(
      new Error("DynamoDB throttling"),
    );

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/principals/search",
      isbUser: isbAuthorizedUser.user,
    });

    const result = await handler(
      event,
      mockAuthorizedContext(testEnv, mockedGlobalConfig),
    );

    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body);
    expect(body.status).toBe("error");
  });

  it("should not include email in response when not present", async () => {
    mockPrincipalStore.getCacheItems.mockResolvedValue([
      cachedGroup("No Email Group"),
    ]);

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/principals/search",
      isbUser: isbAuthorizedUser.user,
    });

    const result = await handler(
      event,
      mockAuthorizedContext(testEnv, mockedGlobalConfig),
    );

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data.principals[0]).not.toHaveProperty("email");
  });

  it("should handle queryStringParameters being null", async () => {
    mockPrincipalStore.getCacheItems.mockResolvedValue([
      cachedUser("Alice", "alice@example.com"),
    ]);

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/principals/search",
      isbUser: isbAuthorizedUser.user,
    });
    // API Gateway can send null at runtime despite TypeScript types
    (event as unknown as Record<string, unknown>).queryStringParameters = null;

    const result = await handler(
      event,
      mockAuthorizedContext(testEnv, mockedGlobalConfig),
    );

    expect(result.statusCode).toBe(200);
  });

  it.each([
    ["limit below minimum", "0", { limit: "0" }],
    ["limit above maximum", "101", { limit: "101" }],
    ["limit non-numeric", "abc", { limit: "abc" }],
    ["q exceeds max length", "a".repeat(201), { q: "a".repeat(201) }],
  ])(
    "should return 400 when %s (%s)",
    async (_label, _value, queryStringParameters) => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/principals/search",
        queryStringParameters,
        isbUser: isbAuthorizedUser.user,
      });

      const result = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(result.statusCode).toBe(400);
    },
  );

  describe("exact lookup (exact=true)", () => {
    it("should return resolved principal for user (exact=true)", async () => {
      const resolvedUser = {
        principalId: crypto.randomUUID(),
        principalType: "USER" as const,
        displayName: "Alice Smith",
        email: "alice@example.com",
      };
      mockIdcService.getCachedPrincipalByAttr.mockResolvedValue(resolvedUser);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/principals/search",
        queryStringParameters: {
          q: "alice@example.com",
          type: "users",
          exact: "true",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const result = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.data.principals).toHaveLength(1);
      expect(body.data.principals[0].principalId).toBe(
        resolvedUser.principalId,
      );
      expect(body.data.principals[0].email).toBe("alice@example.com");
      expect(body.data.totalMatches).toBe(1);
    });

    it("should return resolved principal for group (exact=true)", async () => {
      const resolvedGroup = {
        principalId: crypto.randomUUID(),
        principalType: "GROUP" as const,
        displayName: "ISB-Admins",
      };
      mockIdcService.getCachedPrincipalByAttr.mockResolvedValue(resolvedGroup);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/principals/search",
        queryStringParameters: {
          q: "ISB-Admins",
          type: "groups",
          exact: "true",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const result = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.data.principals).toHaveLength(1);
      expect(body.data.principals[0].principalId).toBe(
        resolvedGroup.principalId,
      );
      expect(body.data.principals[0].principalType).toBe("GROUP");
      expect(body.data.totalMatches).toBe(1);
    });

    it("should call getCachedPrincipalByAttr with principalStore (exact=true)", async () => {
      const resolvedUser = {
        principalId: crypto.randomUUID(),
        principalType: "USER" as const,
        displayName: "Bob Jones",
        email: "bob@example.com",
      };
      mockIdcService.getCachedPrincipalByAttr.mockResolvedValue(resolvedUser);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/principals/search",
        queryStringParameters: {
          q: "bob@example.com",
          type: "users",
          exact: "true",
        },
        isbUser: isbAuthorizedUser.user,
      });

      await handler(event, mockAuthorizedContext(testEnv, mockedGlobalConfig));

      expect(mockIdcService.getCachedPrincipalByAttr).toHaveBeenCalledWith(
        "USER",
        "bob@example.com",
        mockPrincipalStore,
        expect.anything(),
      );
    });

    it("should return 500 on JIT failure (exact=true)", async () => {
      mockIdcService.getCachedPrincipalByAttr.mockRejectedValue(
        new Error("Credential chain failed"),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/principals/search",
        queryStringParameters: {
          q: "unknown@example.com",
          type: "users",
          exact: "true",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const result = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.status).toBe("error");
    });

    it("should return 404 when principal not found in IDC (exact=true)", async () => {
      mockIdcService.getCachedPrincipalByAttr.mockResolvedValue(undefined);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/principals/search",
        queryStringParameters: {
          q: "nobody@example.com",
          type: "users",
          exact: "true",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const result = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.status).toBe("fail");
      expect(body.data.errors[0].message).toContain("not found");
    });

    it("should return 400 when exact=true with type=all", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/principals/search",
        queryStringParameters: {
          q: "alice@example.com",
          type: "all",
          exact: "true",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const result = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.data.errors[0].message).toContain(
        "must be 'users' or 'groups'",
      );
    });

    it("should return 400 when exact=true with empty q", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/principals/search",
        queryStringParameters: {
          q: "",
          type: "users",
          exact: "true",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const result = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.data.errors[0].message).toContain("'q' is required");
    });

    it("should work when enablePrincipalSearch=false (bypass gate)", async () => {
      mockedGlobalConfig.leases.enablePrincipalSearch = false;
      mockAppConfigMiddleware(mockedGlobalConfig);

      const resolvedUser = {
        principalId: crypto.randomUUID(),
        principalType: "USER" as const,
        displayName: "Alice Smith",
        email: "alice@example.com",
      };
      mockIdcService.getCachedPrincipalByAttr.mockResolvedValue(resolvedUser);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/principals/search",
        queryStringParameters: {
          q: "alice@example.com",
          type: "users",
          exact: "true",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const result = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.data.principals).toHaveLength(1);
      expect(body.data.principals[0].principalId).toBe(
        resolvedUser.principalId,
      );
    });
  });
});
