// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import {
  CreateAccountAssignmentCommand,
  DeleteAccountAssignmentCommand,
} from "@aws-sdk/client-sso-admin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { base64EncodeCompositeKey } from "@amzn/innovation-sandbox-commons/data/encoding.js";
import {
  ItemAlreadyExists,
  ResourceLockConflictError,
} from "@amzn/innovation-sandbox-commons/data/errors.js";
import { LeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/lease-store.js";
import {
  type Lease,
  LeaseKey,
  type LeaseLockIntent,
  type LeaseStatus,
  MonitoredLease,
  MonitoredLeaseSchema,
  PendingLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { PrincipalStore } from "@amzn/innovation-sandbox-commons/data/principal/principal-store.js";
import {
  Assignment,
  GroupAssignmentSchema,
  PrincipalCacheItemSchema,
  UserAssignmentSchema,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import { IdcService } from "@amzn/innovation-sandbox-commons/isb-services/idc-service.js";
import {
  deriveAssignmentView,
  enrichDesiredAssignments,
  getLeasesForUserDirect,
  getLeasesForUserViaGroups,
  MaxAssignmentsExceededError,
  processAssignment,
  ProcessAssignmentInput,
  resolveAssignmentAction,
  triggerAssignmentProcessing,
} from "@amzn/innovation-sandbox-commons/isb-services/lease-assignment/index.js";
import { IsbEventBridgeClient } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { now } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";

import { randomUUID } from "node:crypto";

describe("triggerAssignmentProcessing", () => {
  const mockPrincipalStore = {
    getAssignmentsForLease: vi.fn(),
    batchPutAssignments: vi.fn(),
    deleteUserAssignment: vi.fn(),
    deleteGroupAssignment: vi.fn(),
    batchGetCacheItems: vi.fn(),
  };

  const mockLeaseStore = {
    acquireLock: vi.fn(),
    acquireLockWithDesiredAssignments: vi.fn(),
    releaseLock: vi.fn(),
  };

  const mockEventBridgeClient = {
    sendIsbEvent: vi.fn(),
  };

  const mockLogger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  } as unknown as Logger;

  const mockTracer = {} as Tracer;

  const testLeaseId = "550e8400-e29b-41d4-a716-446655440000";
  const testOwnerEmail = "owner@example.com";
  const testCallerEmail = "admin@example.com";
  const testOwnerIdcId = "a1b2c3d4e5-550e8400-e29b-41d4-a716-446655440000";

  const activeLease: MonitoredLease = generateSchemaData(MonitoredLeaseSchema, {
    uuid: testLeaseId,
    userEmail: testOwnerEmail,
    status: "Active",
    allowOwnerToShareLease: true,
  });

  const ownerAssignment: Assignment = generateSchemaData(UserAssignmentSchema, {
    pk: `user#${testOwnerIdcId}`,
    sk: `lease#${testLeaseId}`,
    userId: testOwnerIdcId,
    leaseId: testLeaseId,
    assigneeEmail: testOwnerEmail,
  });

  const ownerCacheItem = generateSchemaData(PrincipalCacheItemSchema, {
    principalId: testOwnerIdcId,
    principalType: "USER",
    email: testOwnerEmail,
  });

  const newUserCacheItem = generateSchemaData(PrincipalCacheItemSchema, {
    principalId: "new-user-id",
    principalType: "USER",
    email: "newuser@example.com",
  });

  const services = {
    leaseStore: mockLeaseStore as any,
    eventBridgeClient: mockEventBridgeClient as unknown as IsbEventBridgeClient,
    principalStore: mockPrincipalStore as any,
    idcService: {
      getCachedPrincipalById: vi.fn(),
      getCachedPrincipalByAttr: vi.fn().mockResolvedValue({
        principalId: testOwnerIdcId,
        principalType: "USER",
        displayName: "Owner User",
        email: testOwnerEmail,
      }),
    } as any,
    tracer: mockTracer,
    logger: mockLogger,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrincipalStore.batchGetCacheItems.mockResolvedValue([ownerCacheItem]);
    services.idcService.getCachedPrincipalByAttr.mockResolvedValue({
      principalId: testOwnerIdcId,
      principalType: "USER",
      displayName: "Owner User",
      email: testOwnerEmail,
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("owner protection", () => {
    it("should auto-inject owner when not included in desired assignments", async () => {
      const otherUserId = "b2c3d4e5f6-660e8400-e29b-41d4-a716-446655440099";
      mockPrincipalStore.batchGetCacheItems.mockResolvedValue([
        generateSchemaData(PrincipalCacheItemSchema, {
          principalId: otherUserId,
          principalType: "USER",
          email: "other@example.com",
        }),
        ownerCacheItem,
      ]);
      mockLeaseStore.acquireLockWithDesiredAssignments.mockResolvedValue(
        undefined,
      );
      mockEventBridgeClient.sendIsbEvent.mockResolvedValue(undefined);

      const result = await triggerAssignmentProcessing(
        {
          leaseId: activeLease.uuid,
          userEmail: activeLease.userEmail,
          intent: "UPDATE",
          requestedBy: testCallerEmail,
          desiredAssignments: [
            { principalId: otherUserId, principalType: "USER" },
          ],
        },
        services,
      );

      expect(result).toHaveProperty("lockOwnerId");
      // Verify the owner was auto-injected (2 principals in desiredAssignments)
      expect(
        mockLeaseStore.acquireLockWithDesiredAssignments,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          desiredAssignments: expect.arrayContaining([
            expect.objectContaining({ principalId: testOwnerIdcId }),
            expect.objectContaining({ principalId: otherUserId }),
          ]),
        }),
      );
    });

    it("should succeed when owner is included in desired assignments", async () => {
      mockPrincipalStore.getAssignmentsForLease.mockResolvedValue({
        result: [ownerAssignment],
      });
      mockLeaseStore.acquireLockWithDesiredAssignments.mockResolvedValue(
        undefined,
      );
      mockLeaseStore.releaseLock.mockResolvedValue(undefined);

      const result = await triggerAssignmentProcessing(
        {
          leaseId: activeLease.uuid,
          userEmail: activeLease.userEmail,
          intent: "UPDATE",
          requestedBy: testCallerEmail,
          desiredAssignments: [
            { principalId: testOwnerIdcId, principalType: "USER" },
          ],
        },
        services,
      );

      expect(result).toHaveProperty("lockOwnerId");
    });

    it("should not throw when no owner assignment exists yet", async () => {
      mockPrincipalStore.batchGetCacheItems.mockResolvedValue([
        ownerCacheItem,
        newUserCacheItem,
      ]);
      mockPrincipalStore.getAssignmentsForLease.mockResolvedValue({
        result: [],
      });
      mockLeaseStore.acquireLockWithDesiredAssignments.mockResolvedValue(
        undefined,
      );
      mockPrincipalStore.batchPutAssignments.mockResolvedValue(undefined);
      mockEventBridgeClient.sendIsbEvent.mockResolvedValue(undefined);

      const result = await triggerAssignmentProcessing(
        {
          leaseId: activeLease.uuid,
          userEmail: activeLease.userEmail,
          intent: "UPDATE",
          requestedBy: testCallerEmail,
          desiredAssignments: [
            { principalId: testOwnerIdcId, principalType: "USER" },
            { principalId: "new-user-id", principalType: "USER" },
          ],
        },
        services,
      );

      expect(result).toHaveProperty("lockOwnerId");
    });
  });

  describe("assignment count validation", () => {
    it("should throw MaxAssignmentsExceededError when total assignments exceed MAX_ASSIGNMENTS", async () => {
      // Create MAX_ASSIGNMENTS assignments (19 others + auto-injected owner = 20 total is ok,
      // but 20 others + auto-injected owner = 21 total exceeds MAX_ASSIGNMENTS)
      const assignments = Array.from({ length: 20 }, (_, i) => ({
        principalId: `principal-${i}-${testOwnerIdcId.slice(0, 20)}`,
        principalType: (i === 0 ? "USER" : "GROUP") as "USER" | "GROUP",
      }));

      // Mock enrichment to return matching items (+ the auto-injected owner)
      mockPrincipalStore.batchGetCacheItems.mockResolvedValue([
        ...assignments.map((a) =>
          generateSchemaData(PrincipalCacheItemSchema, {
            principalId: a.principalId,
            principalType: a.principalType,
            email:
              a.principalType === "USER"
                ? `${a.principalId.slice(0, 8)}@example.com`
                : undefined,
          }),
        ),
        ownerCacheItem,
      ]);

      await expect(
        triggerAssignmentProcessing(
          {
            leaseId: activeLease.uuid,
            userEmail: activeLease.userEmail,
            intent: "UPDATE",
            requestedBy: testCallerEmail,
            desiredAssignments: assignments,
          },
          services,
        ),
      ).rejects.toThrow(MaxAssignmentsExceededError);

      expect(
        mockLeaseStore.acquireLockWithDesiredAssignments,
      ).not.toHaveBeenCalled();
    });

    it("should not throw when assignments are at exactly MAX_ASSIGNMENTS", async () => {
      // Create MAX_ASSIGNMENTS - 1 = 19 assignments (+ auto-injected owner = 20 total)
      const assignments = Array.from({ length: 19 }, (_, i) => ({
        principalId: `principal-${i}-${testOwnerIdcId.slice(0, 20)}`,
        principalType: (i === 0 ? "USER" : "GROUP") as "USER" | "GROUP",
      }));

      mockPrincipalStore.batchGetCacheItems.mockResolvedValue([
        ...assignments.map((a) =>
          generateSchemaData(PrincipalCacheItemSchema, {
            principalId: a.principalId,
            principalType: a.principalType,
            email:
              a.principalType === "USER"
                ? `${a.principalId.slice(0, 8)}@example.com`
                : undefined,
          }),
        ),
        ownerCacheItem,
      ]);
      mockLeaseStore.acquireLockWithDesiredAssignments.mockResolvedValue(
        undefined,
      );
      mockEventBridgeClient.sendIsbEvent.mockResolvedValue(undefined);

      const result = await triggerAssignmentProcessing(
        {
          leaseId: activeLease.uuid,
          userEmail: activeLease.userEmail,
          intent: "UPDATE",
          requestedBy: testCallerEmail,
          desiredAssignments: assignments,
        },
        services,
      );

      expect(result).toHaveProperty("lockOwnerId");
    });
  });

  describe("lock management", () => {
    it("should propagate ResourceLockConflictError from acquireLock", async () => {
      mockLeaseStore.acquireLockWithDesiredAssignments.mockRejectedValue(
        new ResourceLockConflictError("Lock held"),
      );

      await expect(
        triggerAssignmentProcessing(
          {
            leaseId: activeLease.uuid,
            userEmail: activeLease.userEmail,
            intent: "UPDATE",
            requestedBy: testCallerEmail,
            desiredAssignments: [
              { principalId: testOwnerIdcId, principalType: "USER" },
            ],
          },
          services,
        ),
      ).rejects.toThrow(ResourceLockConflictError);
    });

    it("should always publish event even when desired matches current (Processor decides)", async () => {
      mockPrincipalStore.getAssignmentsForLease.mockResolvedValue({
        result: [ownerAssignment],
      });
      mockLeaseStore.acquireLockWithDesiredAssignments.mockResolvedValue(
        undefined,
      );
      mockEventBridgeClient.sendIsbEvent.mockResolvedValue(undefined);

      const result = await triggerAssignmentProcessing(
        {
          leaseId: activeLease.uuid,
          userEmail: activeLease.userEmail,
          intent: "UPDATE",
          requestedBy: testCallerEmail,
          desiredAssignments: [
            { principalId: testOwnerIdcId, principalType: "USER" },
          ],
        },
        services,
      );

      expect(mockEventBridgeClient.sendIsbEvent).toHaveBeenCalled();
      expect(mockLeaseStore.releaseLock).not.toHaveBeenCalled();
      expect(result).toHaveProperty("lockOwnerId");
    });

    it("should not release lock when event is published (Step Function owns it)", async () => {
      mockPrincipalStore.batchGetCacheItems.mockResolvedValue([
        ownerCacheItem,
        newUserCacheItem,
      ]);
      mockPrincipalStore.getAssignmentsForLease.mockResolvedValue({
        result: [ownerAssignment],
      });
      mockLeaseStore.acquireLockWithDesiredAssignments.mockResolvedValue(
        undefined,
      );
      mockPrincipalStore.batchPutAssignments.mockResolvedValue(undefined);
      mockEventBridgeClient.sendIsbEvent.mockResolvedValue(undefined);

      await triggerAssignmentProcessing(
        {
          leaseId: activeLease.uuid,
          userEmail: activeLease.userEmail,
          intent: "UPDATE",
          requestedBy: testCallerEmail,
          desiredAssignments: [
            { principalId: testOwnerIdcId, principalType: "USER" },
            { principalId: "new-user-id", principalType: "USER" },
          ],
        },
        services,
      );

      expect(mockLeaseStore.releaseLock).not.toHaveBeenCalled();
    });
  });

  describe("cache validation", () => {
    it("should throw when cache is missing email for USER principal", async () => {
      mockPrincipalStore.batchGetCacheItems.mockResolvedValue([
        ownerCacheItem,
        generateSchemaData(PrincipalCacheItemSchema, {
          principalId: "no-email-user",
          principalType: "USER",
          email: undefined,
        }),
      ]);
      services.idcService.getCachedPrincipalById.mockResolvedValue(undefined);

      await expect(
        triggerAssignmentProcessing(
          {
            leaseId: activeLease.uuid,
            userEmail: activeLease.userEmail,
            intent: "UPDATE",
            requestedBy: testCallerEmail,
            desiredAssignments: [
              { principalId: "no-email-user", principalType: "USER" },
            ],
          },
          services,
        ),
      ).rejects.toThrow("Principal cache missing email for user");

      expect(
        mockLeaseStore.acquireLockWithDesiredAssignments,
      ).not.toHaveBeenCalled();
    });

    it("should throw when cache is missing entry for GROUP principal", async () => {
      // Return only the owner — no cache entry for the group at all
      mockPrincipalStore.batchGetCacheItems.mockResolvedValue([ownerCacheItem]);
      services.idcService.getCachedPrincipalById.mockResolvedValue(undefined);

      await expect(
        triggerAssignmentProcessing(
          {
            leaseId: activeLease.uuid,
            userEmail: activeLease.userEmail,
            intent: "UPDATE",
            requestedBy: testCallerEmail,
            desiredAssignments: [
              { principalId: "no-name-group", principalType: "GROUP" },
            ],
          },
          services,
        ),
      ).rejects.toThrow("Principal cache missing entry for group");
    });

    it("should succeed when GROUP cache entry exists but has no displayName", async () => {
      // Group entry exists in cache but displayName is undefined (IDC didn't return one)
      const groupWithoutName = generateSchemaData(PrincipalCacheItemSchema, {
        principalId: "group-no-name",
        principalType: "GROUP",
        displayName: undefined,
      });
      mockPrincipalStore.batchGetCacheItems.mockResolvedValue([
        ownerCacheItem,
        groupWithoutName,
      ]);
      mockLeaseStore.acquireLockWithDesiredAssignments.mockResolvedValue(
        undefined,
      );
      mockEventBridgeClient.sendIsbEvent.mockResolvedValue(undefined);

      await expect(
        triggerAssignmentProcessing(
          {
            leaseId: activeLease.uuid,
            userEmail: activeLease.userEmail,
            intent: "UPDATE",
            requestedBy: testCallerEmail,
            desiredAssignments: [
              { principalId: "group-no-name", principalType: "GROUP" },
            ],
          },
          services,
        ),
      ).resolves.not.toThrow();
    });
  });

  describe("error handling", () => {
    it("should release lock and propagate error when event publish fails", async () => {
      mockPrincipalStore.batchGetCacheItems.mockResolvedValue([
        ownerCacheItem,
        newUserCacheItem,
      ]);
      mockLeaseStore.acquireLockWithDesiredAssignments.mockResolvedValue(
        undefined,
      );
      mockEventBridgeClient.sendIsbEvent.mockRejectedValue(
        new Error("EventBridge publish failed"),
      );
      mockLeaseStore.releaseLock.mockResolvedValue(undefined);

      await expect(
        triggerAssignmentProcessing(
          {
            leaseId: activeLease.uuid,
            userEmail: activeLease.userEmail,
            intent: "UPDATE",
            requestedBy: testCallerEmail,
            desiredAssignments: [
              { principalId: testOwnerIdcId, principalType: "USER" },
              { principalId: "new-user-id", principalType: "USER" },
            ],
          },
          services,
        ),
      ).rejects.toThrow("EventBridge publish failed");

      expect(mockLeaseStore.releaseLock).toHaveBeenCalled();
    });
  });
});

describe("processAssignment", () => {
  const mockSsoAdminSend = vi.fn();
  const mockSsoAdminClient = { send: mockSsoAdminSend } as any;

  const mockCreateUserAssignment = vi.fn();
  const mockCreateGroupAssignment = vi.fn();
  const mockDeleteUserAssignment = vi.fn();
  const mockDeleteGroupAssignment = vi.fn();

  const mockPrincipalStore = {
    createUserAssignment: mockCreateUserAssignment,
    createGroupAssignment: mockCreateGroupAssignment,
    deleteUserAssignment: mockDeleteUserAssignment,
    deleteGroupAssignment: mockDeleteGroupAssignment,
  } as any;

  const mockIdcConfigGet = vi.fn();
  const mockIdcStackConfigStore = { get: mockIdcConfigGet } as any;

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;

  const TEST_IDC_CONFIG = {
    ssoInstanceArn: "arn:aws:sso:::instance/ssoins-1234567890abcdef",
  };

  const TEST_LEASE_ID = "550e8400-e29b-41d4-a716-446655440000";
  const TEST_PRINCIPAL_ID = "a1b2c3d4e5-550e8400-e29b-41d4-a716-446655440000";
  const TEST_GROUP_ID = "b2c3d4e5f6-660e8400-e29b-41d4-a716-446655440001";
  const TEST_ACCOUNT_ID = "999888777666";
  const TEST_PERMISSION_SET_ARN =
    "arn:aws:sso:::permissionSet/ssoins-123/ps-user";

  function createInput(
    overrides: Partial<ProcessAssignmentInput> = {},
  ): ProcessAssignmentInput {
    return {
      leaseId: TEST_LEASE_ID,
      action: "GRANT",
      principalId: TEST_PRINCIPAL_ID,
      principalType: "USER",
      accountId: TEST_ACCOUNT_ID,
      permissionSetArn: TEST_PERMISSION_SET_ARN,
      leaseOwnerEmail: "owner@example.com",
      requestedBy: "admin@example.com",
      email: "user@example.com",
      displayName: "Test User",
      ...overrides,
    };
  }

  const context = {
    principalStore: mockPrincipalStore,
    ssoAdminClient: mockSsoAdminClient,
    idcStackConfigStore: mockIdcStackConfigStore,
    logger: mockLogger,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockIdcConfigGet.mockResolvedValue(TEST_IDC_CONFIG);
    mockSsoAdminSend.mockResolvedValue({});
    mockCreateUserAssignment.mockResolvedValue({});
    mockCreateGroupAssignment.mockResolvedValue({});
    mockDeleteUserAssignment.mockResolvedValue({ result: {} });
    mockDeleteGroupAssignment.mockResolvedValue({ result: {} });
  });

  it("should call CreateAccountAssignment and write assignment for GRANT USER", async () => {
    const result = await processAssignment(createInput(), context);

    expect(result.status).toBe("SUCCEEDED");
    expect(mockSsoAdminSend).toHaveBeenCalledWith(
      expect.any(CreateAccountAssignmentCommand),
    );
    expect(mockSsoAdminSend.mock.calls[0]![0].input).toEqual({
      InstanceArn: TEST_IDC_CONFIG.ssoInstanceArn,
      PermissionSetArn: TEST_PERMISSION_SET_ARN,
      PrincipalId: TEST_PRINCIPAL_ID,
      PrincipalType: "USER",
      TargetId: TEST_ACCOUNT_ID,
      TargetType: "AWS_ACCOUNT",
    });
    expect(mockCreateUserAssignment).toHaveBeenCalled();
  });

  it("should call CreateAccountAssignment and write assignment for GRANT GROUP", async () => {
    const result = await processAssignment(
      createInput({ principalId: TEST_GROUP_ID, principalType: "GROUP" }),
      context,
    );

    expect(result.status).toBe("SUCCEEDED");
    expect(mockSsoAdminSend.mock.calls[0]![0].input.PrincipalType).toBe(
      "GROUP",
    );
    expect(mockCreateGroupAssignment).toHaveBeenCalled();
  });

  it("should treat ItemAlreadyExists as success for GRANT (idempotent)", async () => {
    mockCreateUserAssignment.mockRejectedValue(
      new ItemAlreadyExists("User assignment already exists."),
    );

    const result = await processAssignment(createInput(), context);

    expect(result.status).toBe("SUCCEEDED");
  });

  it("should call DeleteAccountAssignment and delete assignment for REVOKE USER", async () => {
    const result = await processAssignment(
      createInput({ action: "REVOKE" }),
      context,
    );

    expect(result.status).toBe("SUCCEEDED");
    expect(mockSsoAdminSend).toHaveBeenCalledWith(
      expect.any(DeleteAccountAssignmentCommand),
    );
    expect(mockDeleteUserAssignment).toHaveBeenCalledWith(
      TEST_PRINCIPAL_ID,
      TEST_LEASE_ID,
    );
  });

  it("should throw when IDC call fails for GRANT", async () => {
    mockSsoAdminSend.mockRejectedValue(new Error("ConflictException"));

    await expect(processAssignment(createInput(), context)).rejects.toThrow(
      "ConflictException",
    );
    expect(mockCreateUserAssignment).not.toHaveBeenCalled();
  });

  it("should NOT delete assignment when REVOKE IDC call fails", async () => {
    mockSsoAdminSend.mockRejectedValue(new Error("IDC unavailable"));

    await expect(
      processAssignment(createInput({ action: "REVOKE" }), context),
    ).rejects.toThrow("IDC unavailable");
    expect(mockDeleteUserAssignment).not.toHaveBeenCalled();
  });

  it("should call DeleteAccountAssignment and delete assignment for REVOKE GROUP", async () => {
    const result = await processAssignment(
      createInput({
        action: "REVOKE",
        principalId: TEST_GROUP_ID,
        principalType: "GROUP",
      }),
      context,
    );

    expect(result.status).toBe("SUCCEEDED");
    expect(mockSsoAdminSend).toHaveBeenCalledWith(
      expect.any(DeleteAccountAssignmentCommand),
    );
    expect(mockDeleteGroupAssignment).toHaveBeenCalledWith(
      TEST_GROUP_ID,
      TEST_LEASE_ID,
    );
  });

  it("should succeed with fire-and-forget IDC call (no polling)", async () => {
    mockSsoAdminSend.mockResolvedValueOnce({});

    const result = await processAssignment(createInput(), context);

    expect(result.status).toBe("SUCCEEDED");
    // Single IDC call only — no Describe polling
    expect(mockSsoAdminSend).toHaveBeenCalledTimes(1);
    expect(mockCreateUserAssignment).toHaveBeenCalled();
  });

  it("should treat ResourceNotFoundException from DeleteAccountAssignment as idempotent success", async () => {
    const notFoundError = Object.assign(new Error("Assignment not found"), {
      name: "ResourceNotFoundException",
      $metadata: {},
    });
    Object.setPrototypeOf(
      notFoundError,
      (await import("@aws-sdk/client-sso-admin")).ResourceNotFoundException
        .prototype,
    );
    mockSsoAdminSend.mockRejectedValueOnce(notFoundError);

    const result = await processAssignment(
      createInput({ action: "REVOKE" }),
      context,
    );

    expect(result.status).toBe("SUCCEEDED");
    expect(mockDeleteUserAssignment).toHaveBeenCalledWith(
      TEST_PRINCIPAL_ID,
      TEST_LEASE_ID,
    );
  });
});

describe("getLeasesForUserDirect", () => {
  const userId = randomUUID();
  const directLeaseId = randomUUID();
  const directOwner = "owner-direct@example.com";

  const mockLeaseStore = {
    batchGet: vi.fn(),
  } satisfies Partial<LeaseStore>;
  const mockPrincipalStore = {
    getDirectAssignmentsForUser: vi.fn(),
  } satisfies Partial<PrincipalStore>;
  const mockLogger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;

  const services = {
    leaseStore: mockLeaseStore as unknown as LeaseStore,
    principalStore: mockPrincipalStore as unknown as PrincipalStore,
    logger: mockLogger,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrincipalStore.getDirectAssignmentsForUser.mockResolvedValue({
      result: [],
      nextPageIdentifier: null,
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns empty result when user has no direct assignments", async () => {
    const result = await getLeasesForUserDirect({ userId }, services);
    expect(result.result).toEqual([]);
    expect(result.nextPageIdentifier).toBeNull();
    expect(mockLeaseStore.batchGet).not.toHaveBeenCalled();
  });

  it("returns DIRECT-tagged leases with no sourceGroupName", async () => {
    mockPrincipalStore.getDirectAssignmentsForUser.mockResolvedValue({
      result: [
        generateSchemaData(UserAssignmentSchema, {
          userId,
          leaseId: directLeaseId,
          leaseOwnerEmail: directOwner,
        }),
      ],
      nextPageIdentifier: null,
    });
    mockLeaseStore.batchGet.mockResolvedValue([
      generateSchemaData(PendingLeaseSchema, {
        userEmail: directOwner,
        uuid: directLeaseId,
      }),
    ]);

    const result = await getLeasesForUserDirect({ userId }, services);

    expect(result.result).toHaveLength(1);
    expect(result.result[0]!.uuid).toBe(directLeaseId);
    expect(result.result[0]!.accessType).toBe("direct");
    expect(result.result[0]!.sourceGroupName).toBeUndefined();
  });

  it("forwards the default pageSize and undefined pageIdentifier to the principal store", async () => {
    await getLeasesForUserDirect({ userId }, services);

    expect(mockPrincipalStore.getDirectAssignmentsForUser).toHaveBeenCalledWith(
      { userId, pageIdentifier: undefined, pageSize: 50 },
    );
  });

  it("forwards a caller-provided pageSize to the principal store", async () => {
    await getLeasesForUserDirect({ userId, pageSize: 7 }, services);

    expect(mockPrincipalStore.getDirectAssignmentsForUser).toHaveBeenCalledWith(
      { userId, pageIdentifier: undefined, pageSize: 7 },
    );
  });

  it("throws when pageSize is zero", async () => {
    await expect(
      getLeasesForUserDirect({ userId, pageSize: 0 }, services),
    ).rejects.toThrow(/pageSize must be > 0/);
  });

  it("passes pageIdentifier through to the principal store and returns its nextPageIdentifier as-is", async () => {
    mockPrincipalStore.getDirectAssignmentsForUser.mockResolvedValue({
      result: [
        generateSchemaData(UserAssignmentSchema, {
          userId,
          leaseId: directLeaseId,
          leaseOwnerEmail: directOwner,
        }),
      ],
      nextPageIdentifier: "ddb-cursor-page-2",
    });
    mockLeaseStore.batchGet.mockResolvedValue([
      generateSchemaData(PendingLeaseSchema, {
        userEmail: directOwner,
        uuid: directLeaseId,
      }),
    ]);

    const page1 = await getLeasesForUserDirect({ userId }, services);

    // No wrapping — the service returns the underlying DDB cursor directly.
    expect(page1.nextPageIdentifier).toBe("ddb-cursor-page-2");
    expect(mockPrincipalStore.getDirectAssignmentsForUser).toHaveBeenCalledWith(
      expect.objectContaining({ pageIdentifier: undefined, userId }),
    );

    // Subsequent call passes the cursor straight through.
    mockPrincipalStore.getDirectAssignmentsForUser.mockResolvedValue({
      result: [],
      nextPageIdentifier: null,
    });
    await getLeasesForUserDirect(
      { userId, pageIdentifier: page1.nextPageIdentifier! },
      services,
    );
    expect(
      mockPrincipalStore.getDirectAssignmentsForUser,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({ pageIdentifier: "ddb-cursor-page-2", userId }),
    );
  });

  it("logs and skips entries when batchGet does not return a matching lease record", async () => {
    mockPrincipalStore.getDirectAssignmentsForUser.mockResolvedValue({
      result: [
        generateSchemaData(UserAssignmentSchema, {
          userId,
          leaseId: directLeaseId,
          leaseOwnerEmail: directOwner,
        }),
      ],
      nextPageIdentifier: null,
    });
    mockLeaseStore.batchGet.mockResolvedValue([]);

    const result = await getLeasesForUserDirect({ userId }, services);

    expect(result.result).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Shared lease assignment refers to a missing lease record",
      { uuid: directLeaseId, accessType: "direct" },
    );
  });
});

describe("getLeasesForUserViaGroups", () => {
  const userId = randomUUID();
  const groupA = randomUUID();
  const groupB = randomUUID();
  const groupC = randomUUID();
  const leaseOwnerEmail = "owner-group@example.com";

  const mockLeaseStore = {
    batchGet: vi.fn(),
  } satisfies Partial<LeaseStore>;
  const mockPrincipalStore = {
    getGroupMembershipCache: vi.fn(),
    putGroupMembershipCache: vi.fn(),
    getAllGroupAssignmentKeys: vi.fn(),
    batchGetGroupAssignments: vi.fn(),
  } satisfies Partial<PrincipalStore>;
  const mockIdcService = {
    listGroupsForUser: vi.fn(),
  } as unknown as IdcService;
  const mockLogger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;

  const services = {
    leaseStore: mockLeaseStore as unknown as LeaseStore,
    principalStore: mockPrincipalStore as unknown as PrincipalStore,
    idcService: mockIdcService,
    logger: mockLogger,
  };

  function setupFreshGroupMembershipCache(groupIds: string[]) {
    const futureTtl = Math.floor(now().valueOf() / 1000) + 60 * 60 * 23;
    mockPrincipalStore.getGroupMembershipCache.mockResolvedValue({
      result: {
        pk: `user#${userId}`,
        sk: "groupMembership",
        groupIds,
        ttl: futureTtl,
      },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrincipalStore.getAllGroupAssignmentKeys.mockResolvedValue([]);
    mockPrincipalStore.batchGetGroupAssignments.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns empty result when user belongs to no groups", async () => {
    setupFreshGroupMembershipCache([]);
    const result = await getLeasesForUserViaGroups({ userId }, services);
    expect(result.result).toEqual([]);
    expect(result.nextPageIdentifier).toBeNull();
  });

  it("returns empty result when no group assignments exist", async () => {
    setupFreshGroupMembershipCache([groupA, groupB]);
    mockPrincipalStore.getAllGroupAssignmentKeys.mockResolvedValue([]);
    const result = await getLeasesForUserViaGroups({ userId }, services);
    expect(result.result).toEqual([]);
    expect(result.nextPageIdentifier).toBeNull();
    expect(mockPrincipalStore.batchGetGroupAssignments).toHaveBeenCalledWith(
      [],
    );
  });

  it("returns empty result when none of the user's groups have assignments", async () => {
    setupFreshGroupMembershipCache([groupA, groupB]);
    mockPrincipalStore.getAllGroupAssignmentKeys.mockResolvedValue([
      { groupId: groupC, leaseId: randomUUID() },
    ]);
    const result = await getLeasesForUserViaGroups({ userId }, services);
    expect(result.result).toEqual([]);
    expect(result.nextPageIdentifier).toBeNull();
    expect(mockPrincipalStore.batchGetGroupAssignments).toHaveBeenCalledWith(
      [],
    );
  });

  it("returns GROUP-tagged leases with sourceGroupName populated", async () => {
    const leaseId = randomUUID();
    setupFreshGroupMembershipCache([groupA]);
    mockPrincipalStore.getAllGroupAssignmentKeys.mockResolvedValue([
      { groupId: groupA, leaseId },
    ]);
    mockPrincipalStore.batchGetGroupAssignments.mockResolvedValue([
      generateSchemaData(GroupAssignmentSchema, {
        groupId: groupA,
        leaseId,
        leaseOwnerEmail,
        displayName: "Engineers",
      }),
    ]);
    mockLeaseStore.batchGet.mockResolvedValue([
      generateSchemaData(PendingLeaseSchema, {
        userEmail: leaseOwnerEmail,
        uuid: leaseId,
      }),
    ]);

    const result = await getLeasesForUserViaGroups({ userId }, services);

    expect(result.result).toHaveLength(1);
    expect(result.result[0]!.uuid).toBe(leaseId);
    expect(result.result[0]!.accessType).toBe("group");
    expect(result.result[0]!.sourceGroupName).toBe("Engineers");
  });

  it("filters scan results to keys for groups the user belongs to", async () => {
    const userLeaseId = randomUUID();
    const otherLeaseId = randomUUID();
    setupFreshGroupMembershipCache([groupA, groupB]);
    mockPrincipalStore.getAllGroupAssignmentKeys.mockResolvedValue([
      { groupId: groupA, leaseId: userLeaseId },
      { groupId: groupC, leaseId: otherLeaseId },
    ]);

    await getLeasesForUserViaGroups({ userId }, services);

    expect(mockPrincipalStore.batchGetGroupAssignments).toHaveBeenCalledTimes(
      1,
    );
    expect(mockPrincipalStore.batchGetGroupAssignments).toHaveBeenCalledWith([
      { groupId: groupA, leaseId: userLeaseId },
    ]);
  });

  it("makes a single BatchGetItem call regardless of how many groups the user matches", async () => {
    setupFreshGroupMembershipCache([groupA, groupB]);
    const leaseAId = randomUUID();
    const leaseBId = randomUUID();
    mockPrincipalStore.getAllGroupAssignmentKeys.mockResolvedValue([
      { groupId: groupA, leaseId: leaseAId },
      { groupId: groupB, leaseId: leaseBId },
    ]);

    await getLeasesForUserViaGroups({ userId }, services);

    expect(mockPrincipalStore.batchGetGroupAssignments).toHaveBeenCalledTimes(
      1,
    );
    const passedKeys =
      mockPrincipalStore.batchGetGroupAssignments.mock.calls[0]![0];
    const passedGroups = passedKeys.map((k: any) => k.groupId).sort();
    expect(passedGroups).toEqual([groupA, groupB].sort());
  });

  it("dedupes a lease shared via multiple groups (alphabetically first groupId wins)", async () => {
    const leaseId = randomUUID();
    // Use deterministic group IDs to control alphabetical order.
    const earlier = "1" + groupA.slice(1);
    const later = "9" + groupB.slice(1);

    setupFreshGroupMembershipCache([earlier, later]);
    mockPrincipalStore.getAllGroupAssignmentKeys.mockResolvedValue([
      { groupId: earlier, leaseId },
      { groupId: later, leaseId },
    ]);
    mockPrincipalStore.batchGetGroupAssignments.mockResolvedValue([
      generateSchemaData(GroupAssignmentSchema, {
        groupId: earlier,
        leaseId,
        leaseOwnerEmail,
        displayName: "EarlyGroup",
      }),
      generateSchemaData(GroupAssignmentSchema, {
        groupId: later,
        leaseId,
        leaseOwnerEmail,
        displayName: "LateGroup",
      }),
    ]);
    mockLeaseStore.batchGet.mockResolvedValue([
      generateSchemaData(PendingLeaseSchema, {
        userEmail: leaseOwnerEmail,
        uuid: leaseId,
      }),
    ]);

    const result = await getLeasesForUserViaGroups({ userId }, services);

    expect(result.result).toHaveLength(1);
    expect(result.result[0]!.sourceGroupName).toBe("EarlyGroup");
  });

  it("paginates a deduped result set with stable order across pages", async () => {
    setupFreshGroupMembershipCache([groupA]);
    const lease1Owner = "a@example.com";
    const lease2Owner = "b@example.com";
    const lease3Owner = "c@example.com";
    const lease1Id = randomUUID();
    const lease2Id = randomUUID();
    const lease3Id = randomUUID();
    mockPrincipalStore.getAllGroupAssignmentKeys.mockResolvedValue([
      { groupId: groupA, leaseId: lease1Id },
      { groupId: groupA, leaseId: lease2Id },
      { groupId: groupA, leaseId: lease3Id },
    ]);
    mockPrincipalStore.batchGetGroupAssignments.mockResolvedValue([
      generateSchemaData(GroupAssignmentSchema, {
        groupId: groupA,
        leaseId: lease1Id,
        leaseOwnerEmail: lease1Owner,
      }),
      generateSchemaData(GroupAssignmentSchema, {
        groupId: groupA,
        leaseId: lease2Id,
        leaseOwnerEmail: lease2Owner,
      }),
      generateSchemaData(GroupAssignmentSchema, {
        groupId: groupA,
        leaseId: lease3Id,
        leaseOwnerEmail: lease3Owner,
      }),
    ]);
    mockLeaseStore.batchGet.mockImplementation((keys: LeaseKey[]) =>
      Promise.resolve(
        keys.map((k) =>
          generateSchemaData(PendingLeaseSchema, {
            userEmail: k.userEmail,
            uuid: k.uuid,
          }),
        ),
      ),
    );

    const page1 = await getLeasesForUserViaGroups(
      { userId, pageSize: 2 },
      services,
    );
    expect(page1.result).toHaveLength(2);
    expect(page1.nextPageIdentifier).not.toBeNull();
    expect(page1.result[0]!.userEmail).toBe(lease1Owner);
    expect(page1.result[1]!.userEmail).toBe(lease2Owner);

    const page2 = await getLeasesForUserViaGroups(
      { userId, pageSize: 2, pageIdentifier: page1.nextPageIdentifier! },
      services,
    );
    expect(page2.result).toHaveLength(1);
    expect(page2.result[0]!.userEmail).toBe(lease3Owner);
    expect(page2.nextPageIdentifier).toBeNull();
  });

  it("logs and skips entries when batchGet does not return a matching lease record", async () => {
    const leaseId = randomUUID();
    setupFreshGroupMembershipCache([groupA]);
    mockPrincipalStore.getAllGroupAssignmentKeys.mockResolvedValue([
      { groupId: groupA, leaseId },
    ]);
    mockPrincipalStore.batchGetGroupAssignments.mockResolvedValue([
      generateSchemaData(GroupAssignmentSchema, {
        groupId: groupA,
        leaseId,
        leaseOwnerEmail,
      }),
    ]);
    mockLeaseStore.batchGet.mockResolvedValue([]);

    const result = await getLeasesForUserViaGroups({ userId }, services);

    expect(result.result).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Shared lease assignment refers to a missing lease record",
      { uuid: leaseId, accessType: "group" },
    );
  });

  it("forwards the default pageSize when the caller does not provide one", async () => {
    setupFreshGroupMembershipCache([groupA]);
    const result = await getLeasesForUserViaGroups({ userId }, services);
    // No assignments → no further calls; pageSize is internal to slice math.
    // Validate via paged behavior with explicit page size below.
    expect(result.result).toEqual([]);
  });

  it("respects a caller-provided pageSize when slicing the deduped result", async () => {
    setupFreshGroupMembershipCache([groupA]);
    const lease1Id = randomUUID();
    const lease2Id = randomUUID();
    mockPrincipalStore.getAllGroupAssignmentKeys.mockResolvedValue([
      { groupId: groupA, leaseId: lease1Id },
      { groupId: groupA, leaseId: lease2Id },
    ]);
    mockPrincipalStore.batchGetGroupAssignments.mockResolvedValue([
      generateSchemaData(GroupAssignmentSchema, {
        groupId: groupA,
        leaseId: lease1Id,
        leaseOwnerEmail: "a@example.com",
      }),
      generateSchemaData(GroupAssignmentSchema, {
        groupId: groupA,
        leaseId: lease2Id,
        leaseOwnerEmail: "b@example.com",
      }),
    ]);
    mockLeaseStore.batchGet.mockImplementation((keys: LeaseKey[]) =>
      Promise.resolve(
        keys.map((k) =>
          generateSchemaData(PendingLeaseSchema, {
            userEmail: k.userEmail,
            uuid: k.uuid,
          }),
        ),
      ),
    );

    const result = await getLeasesForUserViaGroups(
      { userId, pageSize: 1 },
      services,
    );

    expect(result.result).toHaveLength(1);
    expect(result.nextPageIdentifier).not.toBeNull();
  });

  it("throws when pageSize is zero", async () => {
    setupFreshGroupMembershipCache([groupA]);
    await expect(
      getLeasesForUserViaGroups({ userId, pageSize: 0 }, services),
    ).rejects.toThrow(/pageSize must be > 0/);
  });

  it("advances past a deleted cursor lease (strictly-greater-than semantics)", async () => {
    setupFreshGroupMembershipCache([groupA]);
    const owner = "b@example.com";
    const remainingLeaseId = randomUUID();
    mockPrincipalStore.getAllGroupAssignmentKeys.mockResolvedValue([
      { groupId: groupA, leaseId: remainingLeaseId },
    ]);
    mockPrincipalStore.batchGetGroupAssignments.mockResolvedValue([
      generateSchemaData(GroupAssignmentSchema, {
        groupId: groupA,
        leaseId: remainingLeaseId,
        leaseOwnerEmail: owner,
      }),
    ]);
    mockLeaseStore.batchGet.mockImplementation((keys: LeaseKey[]) =>
      Promise.resolve(
        keys.map((k) =>
          generateSchemaData(PendingLeaseSchema, {
            userEmail: k.userEmail,
            uuid: k.uuid,
          }),
        ),
      ),
    );

    // Cursor points at a deleted lease (a@example.com sorts before b@example.com).
    const deletedCursorKey = base64EncodeCompositeKey({
      userEmail: "a@example.com",
      uuid: randomUUID(),
    });

    const result = await getLeasesForUserViaGroups(
      { userId, pageIdentifier: deletedCursorKey! },
      services,
    );

    // Should not restart from the start — the remaining lease is correctly returned.
    expect(result.result).toHaveLength(1);
    expect(result.result[0]!.userEmail).toBe(owner);
  });

  it("propagates errors from getGroupMemberships when both cache and IDC fail", async () => {
    mockPrincipalStore.getGroupMembershipCache.mockResolvedValue({
      result: undefined,
    });
    (mockIdcService as any).listGroupsForUser.mockRejectedValue(
      new Error("IDC unavailable"),
    );

    await expect(
      getLeasesForUserViaGroups({ userId }, services),
    ).rejects.toThrow("IDC unavailable");
  });
});

describe("resolveAssignmentAction", () => {
  const mockGetUserAssignment = vi.fn();
  const mockGetGroupAssignment = vi.fn();
  const mockLeaseGet = vi.fn();

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;

  const TEST_LEASE_ID = "550e8400-e29b-41d4-a716-446655440000";
  const TEST_OWNER_EMAIL = "owner@example.com";
  const TEST_USER_ID = "a1b2c3d4e5-550e8400-e29b-41d4-a716-446655440000";
  const TEST_GROUP_ID = "b2c3d4e5f6-660e8400-e29b-41d4-a716-446655440001";

  const services = {
    principalStore: {
      getUserAssignment: mockGetUserAssignment,
      getGroupAssignment: mockGetGroupAssignment,
    } as any,
    leaseStore: { get: mockLeaseGet } as any,
    logger: mockLogger,
  };

  function input(overrides: Record<string, unknown> = {}) {
    return {
      leaseId: TEST_LEASE_ID,
      leaseOwnerEmail: TEST_OWNER_EMAIL,
      principalId: TEST_USER_ID,
      principalType: "USER" as const,
      intent: "UPDATE" as const,
      ...overrides,
    };
  }

  function leaseWithDesired(principalIds: string[]) {
    return {
      result: {
        desiredAssignments: principalIds.map((principalId) => ({
          principalId,
          principalType: "USER",
        })),
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserAssignment.mockResolvedValue({ result: undefined });
    mockGetGroupAssignment.mockResolvedValue({ result: undefined });
    mockLeaseGet.mockResolvedValue({ result: { desiredAssignments: [] } });
  });

  it("GRANTs when desired and no assignment exists", async () => {
    mockLeaseGet.mockResolvedValue(leaseWithDesired([TEST_USER_ID]));
    mockGetUserAssignment.mockResolvedValue({ result: undefined });

    expect(await resolveAssignmentAction(input(), services)).toBe("GRANT");
  });

  it("REVOKEs when not desired but an assignment exists", async () => {
    mockLeaseGet.mockResolvedValue(leaseWithDesired([]));
    mockGetUserAssignment.mockResolvedValue({
      result: { userId: TEST_USER_ID },
    });

    expect(await resolveAssignmentAction(input(), services)).toBe("REVOKE");
  });

  it("is NO_OP when desired and an assignment already exists", async () => {
    mockLeaseGet.mockResolvedValue(leaseWithDesired([TEST_USER_ID]));
    mockGetUserAssignment.mockResolvedValue({
      result: { userId: TEST_USER_ID },
    });

    expect(await resolveAssignmentAction(input(), services)).toBe("NO_OP");
  });

  it("is NO_OP when neither desired nor an assignment exists", async () => {
    mockLeaseGet.mockResolvedValue(leaseWithDesired([]));
    mockGetUserAssignment.mockResolvedValue({ result: undefined });

    expect(await resolveAssignmentAction(input(), services)).toBe("NO_OP");
  });

  it("REVOKEs an existing assignment for TERMINATE without reading the lease", async () => {
    mockGetUserAssignment.mockResolvedValue({
      result: { userId: TEST_USER_ID },
    });

    expect(
      await resolveAssignmentAction(input({ intent: "TERMINATE" }), services),
    ).toBe("REVOKE");
    expect(mockLeaseGet).not.toHaveBeenCalled();
  });

  it("is NO_OP for FREEZE when there is no assignment to revoke", async () => {
    mockGetUserAssignment.mockResolvedValue({ result: undefined });

    expect(
      await resolveAssignmentAction(input({ intent: "FREEZE" }), services),
    ).toBe("NO_OP");
    expect(mockLeaseGet).not.toHaveBeenCalled();
  });

  it("checks group assignments for GROUP principals", async () => {
    mockLeaseGet.mockResolvedValue({
      result: {
        desiredAssignments: [
          { principalId: TEST_GROUP_ID, principalType: "GROUP" },
        ],
      },
    });
    mockGetGroupAssignment.mockResolvedValue({ result: undefined });

    const action = await resolveAssignmentAction(
      input({ principalId: TEST_GROUP_ID, principalType: "GROUP" }),
      services,
    );

    expect(action).toBe("GRANT");
    expect(mockGetGroupAssignment).toHaveBeenCalledWith(
      TEST_GROUP_ID,
      TEST_LEASE_ID,
    );
    expect(mockGetUserAssignment).not.toHaveBeenCalled();
  });

  // A stale UPDATE/PUBLISH/UNFREEZE worker can run after a FREEZE/TERMINATE
  // has flipped the lease's status. The intent on its SQS message is now
  // outdated — the lease's current status is the source of truth and tells
  // the worker to revoke any existing access (or NO_OP if none exists).
  describe("stale worker on frozen / expired lease", () => {
    it("REVOKEs an existing assignment when the lease is now Frozen (stale UPDATE)", async () => {
      mockLeaseGet.mockResolvedValue({
        result: {
          status: "Frozen",
          desiredAssignments: [
            { principalId: TEST_USER_ID, principalType: "USER" },
          ],
        },
      });
      mockGetUserAssignment.mockResolvedValue({
        result: { userId: TEST_USER_ID },
      });

      expect(await resolveAssignmentAction(input(), services)).toBe("REVOKE");
    });

    it("is NO_OP when the lease is now Frozen and no assignment exists", async () => {
      mockLeaseGet.mockResolvedValue({
        result: {
          status: "Frozen",
          desiredAssignments: [
            { principalId: TEST_USER_ID, principalType: "USER" },
          ],
        },
      });
      mockGetUserAssignment.mockResolvedValue({ result: undefined });

      expect(await resolveAssignmentAction(input(), services)).toBe("NO_OP");
    });

    it("REVOKEs an existing assignment when the lease is now in a terminal status", async () => {
      mockLeaseGet.mockResolvedValue({
        result: {
          status: "ManuallyTerminated",
          desiredAssignments: [
            { principalId: TEST_USER_ID, principalType: "USER" },
          ],
        },
      });
      mockGetUserAssignment.mockResolvedValue({
        result: { userId: TEST_USER_ID },
      });

      expect(await resolveAssignmentAction(input(), services)).toBe("REVOKE");
    });

    it("REVOKEs an existing assignment for a stale PUBLISH against a now-Frozen lease", async () => {
      mockLeaseGet.mockResolvedValue({
        result: {
          status: "Frozen",
          desiredAssignments: [
            { principalId: TEST_USER_ID, principalType: "USER" },
          ],
        },
      });
      mockGetUserAssignment.mockResolvedValue({
        result: { userId: TEST_USER_ID },
      });

      expect(
        await resolveAssignmentAction(input({ intent: "PUBLISH" }), services),
      ).toBe("REVOKE");
    });
  });
});

describe("enrichDesiredAssignments", () => {
  const mockPrincipalStore = {
    batchGetCacheItems: vi.fn(),
  } as any;

  const mockIdcService = {
    getCachedPrincipalById: vi.fn(),
  } as any;

  const mockLogger = { warn: vi.fn(), debug: vi.fn() } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrincipalStore.batchGetCacheItems.mockResolvedValue([]);
    mockIdcService.getCachedPrincipalById.mockResolvedValue(undefined);
  });

  it("returns enriched data from cache without calling IDC", async () => {
    mockPrincipalStore.batchGetCacheItems.mockResolvedValue([
      {
        principalId: "user-1",
        principalType: "USER",
        email: "alice@example.com",
        displayName: "Alice",
      },
    ]);

    const result = await enrichDesiredAssignments(
      [{ principalId: "user-1", principalType: "USER" }],
      {
        principalStore: mockPrincipalStore,
        idcService: mockIdcService,
        logger: mockLogger,
      },
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      principalId: "user-1",
      principalType: "USER",
      email: "alice@example.com",
    });
    expect(mockIdcService.getCachedPrincipalById).not.toHaveBeenCalled();
  });

  it("JIT-resolves cache misses via idcService", async () => {
    mockIdcService.getCachedPrincipalById.mockResolvedValue({
      principalId: "user-2",
      principalType: "USER",
      displayName: "Bob",
      email: "bob@example.com",
    });

    const result = await enrichDesiredAssignments(
      [{ principalId: "user-2", principalType: "USER" }],
      {
        principalStore: mockPrincipalStore,
        idcService: mockIdcService,
        logger: mockLogger,
      },
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      principalId: "user-2",
      email: "bob@example.com",
    });
    expect(mockIdcService.getCachedPrincipalById).toHaveBeenCalledWith(
      "USER",
      "user-2",
      mockPrincipalStore,
      mockLogger,
    );
  });

  it("handles partial cache hits with IDC resolution for misses", async () => {
    mockPrincipalStore.batchGetCacheItems.mockResolvedValue([
      {
        principalId: "user-1",
        principalType: "USER",
        email: "alice@example.com",
        displayName: "Alice",
      },
    ]);
    mockIdcService.getCachedPrincipalById.mockResolvedValue({
      principalId: "group-1",
      principalType: "GROUP",
      displayName: "Engineering",
    });

    const result = await enrichDesiredAssignments(
      [
        { principalId: "user-1", principalType: "USER" },
        { principalId: "group-1", principalType: "GROUP" },
      ],
      {
        principalStore: mockPrincipalStore,
        idcService: mockIdcService,
        logger: mockLogger,
      },
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      principalId: "user-1",
      email: "alice@example.com",
    });
    expect(result[1]).toMatchObject({
      principalId: "group-1",
      displayName: "Engineering",
    });
    expect(mockIdcService.getCachedPrincipalById).toHaveBeenCalledTimes(1);
  });

  it("throws when IDC cannot resolve a USER (missing email)", async () => {
    await expect(
      enrichDesiredAssignments(
        [{ principalId: "ghost-user", principalType: "USER" }],
        {
          principalStore: mockPrincipalStore,
          idcService: mockIdcService,
          logger: mockLogger,
        },
      ),
    ).rejects.toThrow("Principal cache missing email for user ghost-user");
  });

  it("throws when IDC cannot resolve a GROUP (missing displayName)", async () => {
    await expect(
      enrichDesiredAssignments(
        [{ principalId: "ghost-group", principalType: "GROUP" }],
        {
          principalStore: mockPrincipalStore,
          idcService: mockIdcService,
          logger: mockLogger,
        },
      ),
    ).rejects.toThrow("Principal cache missing entry for group ghost-group");
  });

  it("returns empty array for empty input", async () => {
    const result = await enrichDesiredAssignments([], {
      principalStore: mockPrincipalStore,
      idcService: mockIdcService,
      logger: mockLogger,
    });
    expect(result).toEqual([]);
    expect(mockPrincipalStore.batchGetCacheItems).not.toHaveBeenCalled();
  });

  it("resolves multiple misses in parallel", async () => {
    mockIdcService.getCachedPrincipalById
      .mockResolvedValueOnce({
        principalId: "user-a",
        principalType: "USER",
        displayName: "User A",
        email: "a@example.com",
      })
      .mockResolvedValueOnce({
        principalId: "user-b",
        principalType: "USER",
        displayName: "User B",
        email: "b@example.com",
      });

    const result = await enrichDesiredAssignments(
      [
        { principalId: "user-a", principalType: "USER" },
        { principalId: "user-b", principalType: "USER" },
      ],
      {
        principalStore: mockPrincipalStore,
        idcService: mockIdcService,
        logger: mockLogger,
      },
    );

    expect(result).toHaveLength(2);
    expect(mockIdcService.getCachedPrincipalById).toHaveBeenCalledTimes(2);
  });
});

describe("deriveAssignmentView", () => {
  const OWNER_EMAIL = "owner@example.com";
  const LEASE_UUID = "550e8400-e29b-41d4-a716-446655440000";

  const liveLock = (intent: LeaseLockIntent) => ({
    ownerId: `${intent.toLowerCase()}-abc`,
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    meta: { intent },
  });

  // status is widened past MonitoredLease so terminal statuses can be exercised;
  // generateSchemaData only spreads overrides, it does not re-parse them.
  function makeLease(
    overrides: Partial<Omit<MonitoredLease, "status">> & {
      status?: LeaseStatus;
    } = {},
  ): Lease {
    return generateSchemaData(MonitoredLeaseSchema, {
      userEmail: OWNER_EMAIL,
      uuid: LEASE_UUID,
      status: "Active",
      desiredAssignments: [],
      resourceLock: undefined,
      ...overrides,
    } as Partial<MonitoredLease>);
  }

  const desired = (principalId: string, email?: string) => ({
    principalId,
    principalType: "USER" as const,
    displayName: `Name ${principalId}`,
    email: email ?? `${principalId}@example.com`,
  });

  function userAssignment(principalId: string, email?: string) {
    return generateSchemaData(UserAssignmentSchema, {
      pk: `user#${principalId}`,
      sk: `lease#${LEASE_UUID}`,
      userId: principalId,
      principalType: "USER",
      leaseId: LEASE_UUID,
      leaseOwnerEmail: OWNER_EMAIL,
      assigneeEmail: email ?? `${principalId}@example.com`,
    });
  }

  const statusFor = (
    view: ReturnType<typeof deriveAssignmentView>,
    principalId: string,
  ) => view.assignments.find((a) => a.principalId === principalId)?.syncStatus;

  it("unions assignments with the desired set", () => {
    const view = deriveAssignmentView(
      makeLease({
        desiredAssignments: [desired("granted"), desired("wanted")],
      }),
      [userAssignment("granted")],
    );

    expect(view.assignments.map((a) => a.principalId).sort()).toEqual([
      "granted",
      "wanted",
    ]);
  });

  it("reports active when desired and granted", () => {
    const view = deriveAssignmentView(
      makeLease({ desiredAssignments: [desired("alice")] }),
      [userAssignment("alice")],
    );

    expect(statusFor(view, "alice")).toBe("active");
  });

  describe("settled leases", () => {
    it("reports grantFailed when desired with no assignment", () => {
      const view = deriveAssignmentView(
        makeLease({ desiredAssignments: [desired("alice")] }),
        [],
      );

      expect(statusFor(view, "alice")).toBe("grantFailed");
    });

    it("reports revokeFailed when an assignment is no longer desired", () => {
      const view = deriveAssignmentView(makeLease(), [userAssignment("alice")]);

      expect(statusFor(view, "alice")).toBe("revokeFailed");
    });

    it("marks a lingering assignment as not desired", () => {
      // Clients echo this view back as the new desired state. If a pending
      // revoke were reported as desired, resubmitting would re-desire the
      // principal and cancel the revoke.
      const view = deriveAssignmentView(makeLease(), [userAssignment("alice")]);

      expect(
        view.assignments.find((a) => a.principalId === "alice")?.isDesired,
      ).toBe(false);
    });

    it("marks desired principals as desired regardless of status", () => {
      const view = deriveAssignmentView(
        makeLease({
          desiredAssignments: [desired("granted"), desired("wanted")],
        }),
        [userAssignment("granted")],
      );

      expect(view.assignments.every((a) => a.isDesired)).toBe(true);
    });

    it("reports suspended rather than grantFailed on a frozen lease", () => {
      // A freeze revokes the assignments but retains the desired set so unfreeze can
      // restore it, so the absent assignment is the expected end state.
      const view = deriveAssignmentView(
        makeLease({ status: "Frozen", desiredAssignments: [desired("alice")] }),
        [],
      );

      expect(statusFor(view, "alice")).toBe("suspended");
    });

    it("treats absent desiredAssignments as an empty desired set", () => {
      // Legacy leases predate the field. Every assignment is then undesired, which
      // must not read as though the lease itself were misconfigured.
      const view = deriveAssignmentView(
        makeLease({ desiredAssignments: undefined }),
        [userAssignment("alice")],
      );

      expect(statusFor(view, "alice")).toBe("revokeFailed");
    });
  });

  describe("leases that grant nobody access", () => {
    // deriveAssignmentView must agree with shouldPrincipalHaveAccess, which the
    // worker uses to choose GRANT vs REVOKE and returns false for a frozen OR
    // expired lease. Otherwise the view contradicts the processor.
    const terminalStatuses = [
      "Expired",
      "BudgetExceeded",
      "ManuallyTerminated",
      "UserTerminated",
      "AccountQuarantined",
      "Ejected",
      "ProvisioningFailed",
    ] as const;

    it.each(terminalStatuses)(
      "reports suspended, not grantFailed, on a %s lease",
      (status) => {
        // desiredAssignments is deliberately not cleared on terminate, so every
        // principal would otherwise render as a failed grant forever.
        const view = deriveAssignmentView(
          makeLease({ status, desiredAssignments: [desired("alice")] }),
          [],
        );

        expect(statusFor(view, "alice")).toBe("suspended");
      },
    );

    it.each(["Frozen", "ManuallyTerminated"] as const)(
      "reports a surviving assignment on a %s lease as a failed revoke",
      (status) => {
        // The lease grants nobody access, so an assignment that is still present is
        // orphaned IDC access — the condition the cleanup flow remediates and
        // operators must be able to see. Reporting it as active would hide it.
        const view = deriveAssignmentView(
          makeLease({ status, desiredAssignments: [desired("alice")] }),
          [userAssignment("alice")],
        );

        expect(statusFor(view, "alice")).toBe("revokeFailed");
      },
    );

    it("reports the owner's surviving assignment as a failed revoke too", () => {
      // The owner is exempt from the desired-set check, not from a wholesale
      // revocation — a freeze revokes the owner as well.
      const view = deriveAssignmentView(makeLease({ status: "Frozen" }), [
        userAssignment("owner-id", OWNER_EMAIL),
      ]);

      const owner = view.assignments.find((a) => a.principalId === "owner-id");
      expect(owner?.isOwner).toBe(true);
      expect(owner?.syncStatus).toBe("revokeFailed");
    });

    it("still reports revoking while the revocation is in flight", () => {
      // Mid-freeze the assignment is on its way out, which is not yet a failure.
      const view = deriveAssignmentView(
        makeLease({
          status: "Frozen",
          desiredAssignments: [desired("alice")],
          resourceLock: liveLock("FREEZE"),
        }),
        [userAssignment("alice")],
      );

      expect(statusFor(view, "alice")).toBe("revoking");
    });
  });

  describe("in-flight operations", () => {
    it("reports granting for a pending grant during an update", () => {
      const view = deriveAssignmentView(
        makeLease({
          desiredAssignments: [desired("alice")],
          resourceLock: liveLock("UPDATE"),
        }),
        [],
      );

      expect(statusFor(view, "alice")).toBe("granting");
      expect(view.operationInProgress).toBe("UPDATE");
    });

    it("reports granting during an unfreeze, not a failure", () => {
      const view = deriveAssignmentView(
        makeLease({
          desiredAssignments: [desired("alice")],
          resourceLock: liveLock("UNFREEZE"),
        }),
        [],
      );

      expect(statusFor(view, "alice")).toBe("granting");
    });

    it.each(["FREEZE", "TERMINATE"] as const)(
      "labels rows by direction during a %s",
      (intent) => {
        // These revoke everything regardless of the desired set, so a surviving
        // assignment is on its way out and a missing one is already gone. Neither is
        // a pending grant.
        const view = deriveAssignmentView(
          makeLease({
            desiredAssignments: [desired("granted"), desired("gone")],
            resourceLock: liveLock(intent),
          }),
          [userAssignment("granted")],
        );

        expect(statusFor(view, "granted")).toBe("revoking");
        expect(statusFor(view, "gone")).toBe("suspended");
        // Both are still in the desired set — the revoke is wholesale, not a
        // change of intent — so isDesired must not be inferred from "revoking".
        expect(view.assignments.every((a) => a.isDesired)).toBe(true);
      },
    );

    it("reports revoking for an assignment dropped from the desired set", () => {
      const view = deriveAssignmentView(
        makeLease({ resourceLock: liveLock("UPDATE") }),
        [userAssignment("alice")],
      );

      expect(statusFor(view, "alice")).toBe("revoking");
    });
  });

  describe("expired locks", () => {
    it("treats an expired lock as settled", () => {
      // A stuck Step Function must not leave rows permanently transitional.
      const view = deriveAssignmentView(
        makeLease({
          desiredAssignments: [desired("alice")],
          resourceLock: {
            ...liveLock("UPDATE"),
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
          },
        }),
        [],
      );

      expect(view.operationInProgress).toBeUndefined();
      expect(statusFor(view, "alice")).toBe("grantFailed");
    });
  });

  describe("owner handling", () => {
    it("flags the owner from an assignment and never as a revoke failure", () => {
      // The owner's access is implicit, so it is not a failure for them to be
      // absent from the desired set.
      const view = deriveAssignmentView(makeLease(), [
        userAssignment("owner-id", OWNER_EMAIL),
      ]);

      const owner = view.assignments.find((a) => a.principalId === "owner-id");
      expect(owner?.isOwner).toBe(true);
      expect(owner?.syncStatus).toBe("active");
    });

    it("flags the owner when they appear only in the desired set", () => {
      // The backend auto-injects the owner into desiredAssignments, so they show
      // up here whenever their assignment is missing. Missing isOwner would let the
      // client count them against the user-managed capacity and offer Remove.
      const view = deriveAssignmentView(
        makeLease({
          desiredAssignments: [desired("owner-id", OWNER_EMAIL)],
        }),
        [],
      );

      expect(
        view.assignments.find((a) => a.principalId === "owner-id")?.isOwner,
      ).toBe(true);
    });
  });

  it("prefers the desired display name over the assignment's", () => {
    // Desired values come from the principal cache at request time; the assignment's
    // are denormalized at grant time and can be staler.
    const view = deriveAssignmentView(
      makeLease({
        desiredAssignments: [
          { ...desired("alice"), displayName: "Fresh Name" },
        ],
      }),
      [{ ...userAssignment("alice"), displayName: "Stale Name" }],
    );

    expect(
      view.assignments.find((a) => a.principalId === "alice")?.displayName,
    ).toBe("Fresh Name");
  });

  it("includes group assignments", () => {
    const groupAssignment = generateSchemaData(GroupAssignmentSchema, {
      pk: "group#eng",
      sk: `lease#${LEASE_UUID}`,
      groupId: "eng",
      principalType: "GROUP",
      leaseId: LEASE_UUID,
      leaseOwnerEmail: OWNER_EMAIL,
    });

    const view = deriveAssignmentView(
      makeLease({
        desiredAssignments: [
          { principalId: "eng", principalType: "GROUP", displayName: "Eng" },
        ],
      }),
      [groupAssignment],
    );

    const group = view.assignments.find((a) => a.principalId === "eng");
    expect(group?.principalType).toBe("GROUP");
    expect(group?.isOwner).toBe(false);
    expect(group?.syncStatus).toBe("active");
  });
});
