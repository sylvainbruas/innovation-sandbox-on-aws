// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { PrincipalCacheSyncEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/principal-cache-sync-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { mockContext } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const testEnv = generateSchemaData(PrincipalCacheSyncEnvironmentSchema);
const testContext = mockContext(testEnv);

let handler: typeof import("@amzn/innovation-sandbox-principal-cache-sync/principal-cache-sync-handler.js").handler;

const mockIdcService = {
  listAllIsbMemberIds: vi.fn(),
  listAllUsers: vi.fn(),
  listAllGroups: vi.fn(),
};

const mockPrincipalStore = {
  getCacheItems: vi.fn(),
  batchPutCacheItems: vi.fn(),
  batchDeleteCacheItemsBySk: vi.fn(),
};

beforeAll(async () => {
  bulkStubEnv(testEnv);

  // Mock IsbServices before importing handler
  vi.doMock("@amzn/innovation-sandbox-commons/isb-services/index.js", () => ({
    IsbServices: {
      idcService: vi.fn().mockReturnValue(mockIdcService),
      principalStore: vi.fn().mockReturnValue(mockPrincipalStore),
    },
  }));

  // Mock cross-account credentials
  vi.doMock(
    "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js",
    () => ({
      fromTemporaryIsbIdcCredentials: vi.fn().mockReturnValue({}),
    }),
  );

  // Import handler after mocking dependencies
  const module =
    await import("@amzn/innovation-sandbox-principal-cache-sync/principal-cache-sync-handler.js");
  handler = module.handler;
});

beforeEach(() => {
  bulkStubEnv(testEnv);
  vi.clearAllMocks();

  // Default mock responses
  mockIdcService.listAllIsbMemberIds.mockResolvedValue(new Set());
  mockIdcService.listAllUsers.mockResolvedValue([]);
  mockIdcService.listAllGroups.mockResolvedValue([]);
  mockPrincipalStore.getCacheItems.mockResolvedValue([]);
  mockPrincipalStore.batchPutCacheItems.mockResolvedValue(undefined);
  mockPrincipalStore.batchDeleteCacheItemsBySk.mockResolvedValue(undefined);
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("PrincipalCacheSyncHandler", () => {
  it("should sync ISB users and groups to cache", async () => {
    mockIdcService.listAllIsbMemberIds.mockResolvedValue(
      new Set(["user-1", "user-2"]),
    );
    mockIdcService.listAllUsers.mockResolvedValue([
      {
        principalId: "user-1",
        principalType: "USER",
        displayName: "User One",
        email: "user1@example.com",
      },
      {
        principalId: "user-2",
        principalType: "USER",
        displayName: "User Two",
        email: "user2@example.com",
      },
      {
        principalId: "user-3",
        principalType: "USER",
        displayName: "Non-ISB User",
        email: "user3@example.com",
      },
    ]);
    mockIdcService.listAllGroups.mockResolvedValue([
      {
        principalId: "group-1",
        principalType: "GROUP",
        displayName: "Engineering",
      },
    ]);

    await handler({ source: "scheduled" }, testContext);

    // Should write only ISB members (user-1, user-2) + all groups (group-1)
    expect(mockPrincipalStore.batchPutCacheItems).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          pk: "principalCache",
          sk: "user#user-1",
          principalId: "user-1",
          displayName: "User One",
        }),
        expect.objectContaining({
          pk: "principalCache",
          sk: "user#user-2",
          principalId: "user-2",
          displayName: "User Two",
        }),
        expect.objectContaining({
          pk: "principalCache",
          sk: "group#group-1",
          principalId: "group-1",
          displayName: "Engineering",
        }),
      ]),
    );

    // Should NOT include non-ISB user (user-3)
    const writtenItems =
      mockPrincipalStore.batchPutCacheItems.mock.calls[0]![0];
    expect(writtenItems).toHaveLength(3);
    expect(
      writtenItems.find((i: any) => i.principalId === "user-3"),
    ).toBeUndefined();
  });

  it("should filter out non-ISB users", async () => {
    mockIdcService.listAllIsbMemberIds.mockResolvedValue(new Set(["isb-user"]));
    mockIdcService.listAllUsers.mockResolvedValue([
      {
        principalId: "isb-user",
        principalType: "USER",
        displayName: "ISB User",
        email: "isb@example.com",
      },
      {
        principalId: "external-user",
        principalType: "USER",
        displayName: "External",
        email: "ext@example.com",
      },
    ]);
    mockIdcService.listAllGroups.mockResolvedValue([]);

    await handler({ source: "scheduled" }, testContext);

    const writtenItems =
      mockPrincipalStore.batchPutCacheItems.mock.calls[0]![0];
    expect(writtenItems).toHaveLength(1);
    expect(writtenItems[0].principalId).toBe("isb-user");
  });

  it("should delete stale cache records", async () => {
    mockIdcService.listAllIsbMemberIds.mockResolvedValue(new Set(["user-1"]));
    mockIdcService.listAllUsers.mockResolvedValue([
      {
        principalId: "user-1",
        principalType: "USER",
        displayName: "User One",
        email: "user1@example.com",
      },
    ]);
    mockIdcService.listAllGroups.mockResolvedValue([]);

    // Existing cache has user-1 and user-removed (stale)
    mockPrincipalStore.getCacheItems.mockResolvedValue([
      {
        pk: "principalCache",
        sk: "user#user-1",
        principalId: "user-1",
        principalType: "USER",
        displayName: "User One",
        syncedAt: "2024-01-01T00:00:00.000Z",
      },
      {
        pk: "principalCache",
        sk: "user#user-removed",
        principalId: "user-removed",
        principalType: "USER",
        displayName: "Removed User",
        syncedAt: "2024-01-01T00:00:00.000Z",
      },
    ]);

    await handler({ source: "scheduled" }, testContext);

    // Should delete the stale record
    expect(mockPrincipalStore.batchDeleteCacheItemsBySk).toHaveBeenCalledWith([
      "user#user-removed",
    ]);
  });

  it("should not call batchDeleteCacheItemsBySk when no stale records", async () => {
    mockIdcService.listAllIsbMemberIds.mockResolvedValue(new Set(["user-1"]));
    mockIdcService.listAllUsers.mockResolvedValue([
      {
        principalId: "user-1",
        principalType: "USER",
        displayName: "User One",
        email: "user1@example.com",
      },
    ]);
    mockIdcService.listAllGroups.mockResolvedValue([]);
    mockPrincipalStore.getCacheItems.mockResolvedValue([
      {
        pk: "principalCache",
        sk: "user#user-1",
        principalId: "user-1",
        principalType: "USER",
        displayName: "User One",
        syncedAt: "2024-01-01T00:00:00.000Z",
      },
    ]);

    await handler({ source: "scheduled" }, testContext);

    expect(mockPrincipalStore.batchDeleteCacheItemsBySk).not.toHaveBeenCalled();
  });

  it("should handle empty identity store gracefully", async () => {
    mockIdcService.listAllIsbMemberIds.mockResolvedValue(new Set());
    mockIdcService.listAllUsers.mockResolvedValue([]);
    mockIdcService.listAllGroups.mockResolvedValue([]);

    await handler({ source: "scheduled" }, testContext);

    expect(mockPrincipalStore.batchPutCacheItems).toHaveBeenCalledWith([]);
  });

  it("should include email for users that have it", async () => {
    mockIdcService.listAllIsbMemberIds.mockResolvedValue(
      new Set(["user-with-email", "user-without-email"]),
    );
    mockIdcService.listAllUsers.mockResolvedValue([
      {
        principalId: "user-with-email",
        principalType: "USER",
        displayName: "Has Email",
        email: "has@example.com",
      },
      {
        principalId: "user-without-email",
        principalType: "USER",
        displayName: "No Email",
      },
    ]);
    mockIdcService.listAllGroups.mockResolvedValue([]);

    await handler({ source: "scheduled" }, testContext);

    const writtenItems =
      mockPrincipalStore.batchPutCacheItems.mock.calls[0]![0];
    const withEmail = writtenItems.find(
      (i: any) => i.principalId === "user-with-email",
    );
    const withoutEmail = writtenItems.find(
      (i: any) => i.principalId === "user-without-email",
    );

    expect(withEmail.email).toBe("has@example.com");
    expect(withoutEmail.email).toBeUndefined();
  });
});
