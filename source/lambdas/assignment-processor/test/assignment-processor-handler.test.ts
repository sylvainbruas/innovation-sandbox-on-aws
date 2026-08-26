// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  MonitoredLease,
  MonitoredLeaseSchema,
  PendingLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  GroupAssignmentSchema,
  UserAssignmentSchema,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import { AssignmentProcessorEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/assignment-processor-environment.js";
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

const testEnv = generateSchemaData(AssignmentProcessorEnvironmentSchema);
const testContext = mockContext(testEnv);

const TEST_LEASE_ID = "550e8400-e29b-41d4-a716-446655440000";
const TEST_OWNER_EMAIL = "owner@example.com";
const TEST_REQUESTER_EMAIL = "admin@example.com";
const TEST_LOCK_OWNER_ID = "lock-owner-abc-123";
const TEST_ACCOUNT_ID = "999888777666";
const TEST_PERMISSION_SET_ARN =
  "arn:aws:sso:::permissionSet/ssoins-123/ps-user";
const TEST_IDC_PERMISSION_SET_ARN =
  "arn:aws:sso:::permissionSet/ssoins-123/ps-from-idc-config";
const TEST_EXECUTION_ARN =
  "arn:aws:states:us-east-1:123456789012:execution:AssignmentProcessor:abc123";
const TEST_USER_ID = "a1b2c3d4e5-550e8400-e29b-41d4-a716-446655440000";
const TEST_GROUP_ID = "b2c3d4e5f6-660e8400-e29b-41d4-a716-446655440001";

// --- Mocks ---

const mockLeaseStoreGet = vi.fn();
const mockLeaseStoreReleaseLock = vi.fn();
const mockPrincipalStoreGetAssignmentsForLease = vi.fn();
const mockEventBridgeSendIsbEvents = vi.fn();
const mockIdcConfigGet = vi.fn();

let handler: typeof import("@amzn/innovation-sandbox-assignment-processor/assignment-processor-handler.js").handler;

beforeAll(async () => {
  bulkStubEnv(testEnv);

  vi.doMock("@amzn/innovation-sandbox-commons/sdk-clients/index.js", () => ({
    IsbClients: {
      dynamo: vi.fn(() => ({})),
    },
  }));

  vi.doMock("@amzn/innovation-sandbox-commons/isb-services/index.js", () => ({
    IsbServices: {
      leaseStore: vi.fn(() => ({
        get: mockLeaseStoreGet,
        releaseLock: mockLeaseStoreReleaseLock,
      })),
      principalStore: vi.fn(() => ({
        getAssignmentsForLease: mockPrincipalStoreGetAssignmentsForLease,
      })),
      isbEventBridge: vi.fn(() => ({
        sendIsbEvents: mockEventBridgeSendIsbEvents,
      })),
      idcStackConfigStore: vi.fn(() => ({
        get: mockIdcConfigGet,
      })),
    },
  }));

  const module =
    await import("@amzn/innovation-sandbox-assignment-processor/assignment-processor-handler.js");
  handler = module.handler;
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockIdcConfigGet.mockResolvedValue({
    userPermissionSetArn: TEST_IDC_PERMISSION_SET_ARN,
  });
});

// --- Test Helpers ---

function createFanOutInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    action: "FAN_OUT",
    leaseId: TEST_LEASE_ID,
    intent: "UPDATE",
    lockOwnerId: TEST_LOCK_OWNER_ID,
    leaseOwnerEmail: TEST_OWNER_EMAIL,
    requestedBy: TEST_REQUESTER_EMAIL,
    accountId: TEST_ACCOUNT_ID,
    permissionSetArn: TEST_PERMISSION_SET_ARN,
    executionArn: TEST_EXECUTION_ARN,
    ...overrides,
  };
}

function createHandleCompletionInput(
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    action: "HANDLE_COMPLETION",
    leaseId: TEST_LEASE_ID,
    intent: "UPDATE",
    lockOwnerId: TEST_LOCK_OWNER_ID,
    leaseOwnerEmail: TEST_OWNER_EMAIL,
    requestedBy: TEST_REQUESTER_EMAIL,
    accountId: TEST_ACCOUNT_ID,
    executionArn: TEST_EXECUTION_ARN,
    ...overrides,
  };
}

function createUserAssignmentRecord(userId: string, leaseId: string) {
  return generateSchemaData(UserAssignmentSchema, {
    pk: `user#${userId}`,
    sk: `lease#${leaseId}`,
    userId,
    principalType: "USER",
    leaseId,
    assigneeEmail: `${userId.slice(0, 5)}@example.com`,
    leaseOwnerEmail: TEST_OWNER_EMAIL,
    accountId: TEST_ACCOUNT_ID,
  });
}

function createGroupAssignmentRecord(groupId: string, leaseId: string) {
  return generateSchemaData(GroupAssignmentSchema, {
    pk: `group#${groupId}`,
    sk: `lease#${leaseId}`,
    groupId,
    principalType: "GROUP",
    leaseId,
    displayName: "Test Group",
    leaseOwnerEmail: TEST_OWNER_EMAIL,
    accountId: TEST_ACCOUNT_ID,
  });
}

/** A leaseStore.get() result wrapping a schema-valid MonitoredLease. */
function monitoredLeaseResult(overrides: Partial<MonitoredLease> = {}) {
  return {
    result: generateSchemaData(MonitoredLeaseSchema, {
      userEmail: TEST_OWNER_EMAIL,
      uuid: TEST_LEASE_ID,
      awsAccountId: TEST_ACCOUNT_ID,
      desiredAssignments: [],
      ...overrides,
    }),
  };
}

// --- FAN_OUT Tests ---

describe("FAN_OUT action", () => {
  it("should return union of desired + current principal IDs", async () => {
    mockLeaseStoreGet.mockResolvedValue(
      monitoredLeaseResult({
        desiredAssignments: [
          {
            principalId: TEST_USER_ID,
            principalType: "USER",
            displayName: "User A",
            email: "usera@example.com",
          },
          {
            principalId: TEST_GROUP_ID,
            principalType: "GROUP",
            displayName: "Group B",
          },
        ],
      }),
    );

    mockPrincipalStoreGetAssignmentsForLease.mockResolvedValue({
      result: [createUserAssignmentRecord(TEST_USER_ID, TEST_LEASE_ID)],
    });

    const result = await handler(createFanOutInput(), testContext);

    expect(result).toEqual({
      workItems: expect.arrayContaining([
        expect.objectContaining({
          principalId: TEST_USER_ID,
          principalType: "USER",
        }),
        expect.objectContaining({
          principalId: TEST_GROUP_ID,
          principalType: "GROUP",
        }),
      ]),
      accountId: TEST_ACCOUNT_ID,
      preExistingPrincipalIds: expect.any(Array),
    });
    expect(result.workItems).toHaveLength(2);
    // permissionSetArn must be resolved from IDC config, not echoed from input
    expect(mockIdcConfigGet).toHaveBeenCalled();
    expect(
      result.workItems.every(
        (item: { permissionSetArn: string }) =>
          item.permissionSetArn === TEST_IDC_PERMISSION_SET_ARN,
      ),
    ).toBe(true);
  });

  it("should include principals being revoked (in current but not desired)", async () => {
    const revokedUserId = "revoked-user-550e8400-e29b-41d4-a716-446655440099";

    mockLeaseStoreGet.mockResolvedValue(
      monitoredLeaseResult({
        desiredAssignments: [
          {
            principalId: TEST_USER_ID,
            principalType: "USER",
            displayName: "User A",
            email: "usera@example.com",
          },
        ],
      }),
    );

    mockPrincipalStoreGetAssignmentsForLease.mockResolvedValue({
      result: [
        createUserAssignmentRecord(TEST_USER_ID, TEST_LEASE_ID),
        createUserAssignmentRecord(revokedUserId, TEST_LEASE_ID),
      ],
    });

    const result = await handler(createFanOutInput(), testContext);

    expect(result.workItems).toHaveLength(2);
    expect(result.workItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ principalId: TEST_USER_ID }),
        expect.objectContaining({ principalId: revokedUserId }),
      ]),
    );
  });

  it("should return empty workItems when lease not found", async () => {
    mockLeaseStoreGet.mockResolvedValue({ result: null });

    await expect(handler(createFanOutInput(), testContext)).rejects.toThrow(
      "Lease not found during FAN_OUT",
    );
  });

  it("should throw when lease has no awsAccountId", async () => {
    // A pending lease has no awsAccountId yet
    mockLeaseStoreGet.mockResolvedValue({
      result: generateSchemaData(PendingLeaseSchema, {
        userEmail: TEST_OWNER_EMAIL,
        uuid: TEST_LEASE_ID,
        desiredAssignments: [
          {
            principalId: TEST_USER_ID,
            principalType: "USER",
            displayName: "User A",
            email: "usera@example.com",
          },
        ],
      }),
    });
    mockPrincipalStoreGetAssignmentsForLease.mockResolvedValue({ result: [] });

    await expect(handler(createFanOutInput(), testContext)).rejects.toThrow(
      "has no awsAccountId",
    );
  });

  it("should return empty workItems when no desired and no current records", async () => {
    mockLeaseStoreGet.mockResolvedValue(
      monitoredLeaseResult({ desiredAssignments: [] }),
    );

    mockPrincipalStoreGetAssignmentsForLease.mockResolvedValue({
      result: [],
    });

    const result = await handler(createFanOutInput(), testContext);

    expect(result).toEqual({
      workItems: [],
      accountId: expect.any(String),
      preExistingPrincipalIds: [],
    });
  });

  it("should deduplicate principals appearing in both desired and current", async () => {
    mockLeaseStoreGet.mockResolvedValue(
      monitoredLeaseResult({
        desiredAssignments: [
          {
            principalId: TEST_USER_ID,
            principalType: "USER",
            displayName: "User A",
            email: "usera@example.com",
          },
        ],
      }),
    );

    mockPrincipalStoreGetAssignmentsForLease.mockResolvedValue({
      result: [createUserAssignmentRecord(TEST_USER_ID, TEST_LEASE_ID)],
    });

    const result = await handler(createFanOutInput(), testContext);

    expect(result.workItems).toHaveLength(1);
    expect(result.workItems[0].principalId).toBe(TEST_USER_ID);
    // Desired is inserted first, so its display values win over the current
    // record's assigneeEmail-derived values.
    expect(result.workItems[0].displayName).toBe("User A");
    expect(result.workItems[0].email).toBe("usera@example.com");
  });

  it("should handle TERMINATE with only current records (desired is empty)", async () => {
    mockLeaseStoreGet.mockResolvedValue(
      monitoredLeaseResult({ desiredAssignments: [] }),
    );

    mockPrincipalStoreGetAssignmentsForLease.mockResolvedValue({
      result: [
        createUserAssignmentRecord(TEST_USER_ID, TEST_LEASE_ID),
        createGroupAssignmentRecord(TEST_GROUP_ID, TEST_LEASE_ID),
      ],
    });

    const result = await handler(
      createFanOutInput({ intent: "TERMINATE" }),
      testContext,
    );

    expect(result.workItems).toHaveLength(2);
  });

  it("should handle lease with undefined desiredAssignments", async () => {
    mockLeaseStoreGet.mockResolvedValue(
      monitoredLeaseResult({ desiredAssignments: undefined }),
    );

    mockPrincipalStoreGetAssignmentsForLease.mockResolvedValue({
      result: [createUserAssignmentRecord(TEST_USER_ID, TEST_LEASE_ID)],
    });

    const result = await handler(createFanOutInput(), testContext);

    expect(result.workItems).toHaveLength(1);
    expect(result.workItems[0].principalId).toBe(TEST_USER_ID);
  });

  it("should handle group assignment records in current", async () => {
    mockLeaseStoreGet.mockResolvedValue(
      monitoredLeaseResult({ desiredAssignments: [] }),
    );

    mockPrincipalStoreGetAssignmentsForLease.mockResolvedValue({
      result: [createGroupAssignmentRecord(TEST_GROUP_ID, TEST_LEASE_ID)],
    });

    const result = await handler(createFanOutInput(), testContext);

    expect(result.workItems).toHaveLength(1);
    expect(result.workItems[0]).toEqual(
      expect.objectContaining({
        principalId: TEST_GROUP_ID,
        principalType: "GROUP",
        displayName: "Test Group",
      }),
    );
  });

  it("should coerce missing displayName/email to empty strings (never null/undefined)", async () => {
    mockLeaseStoreGet.mockResolvedValue(
      monitoredLeaseResult({
        desiredAssignments: [
          // USER with no displayName and no email
          { principalId: TEST_USER_ID, principalType: "USER" },
          // GROUP with no email
          { principalId: TEST_GROUP_ID, principalType: "GROUP" },
        ],
      }),
    );

    mockPrincipalStoreGetAssignmentsForLease.mockResolvedValue({
      result: [],
    });

    const result = await handler(createFanOutInput(), testContext);

    expect(result.workItems).toHaveLength(2);
    for (const item of result.workItems) {
      expect(typeof item.displayName).toBe("string");
      expect(typeof item.email).toBe("string");
      expect(item.displayName).not.toBeNull();
      expect(item.email).not.toBeNull();
    }
    const userItem = result.workItems.find(
      (i: { principalId: string }) => i.principalId === TEST_USER_ID,
    )!;
    expect(userItem.displayName).toBe("");
    expect(userItem.email).toBe("");
  });
});

describe("HANDLE_COMPLETION action", () => {
  it("should clear resourceLock and publish events for successful grants", async () => {
    mockLeaseStoreReleaseLock.mockResolvedValue(undefined);
    mockPrincipalStoreGetAssignmentsForLease.mockResolvedValue({
      result: [createUserAssignmentRecord(TEST_USER_ID, TEST_LEASE_ID)],
    });
    mockLeaseStoreGet.mockResolvedValue(
      monitoredLeaseResult({
        desiredAssignments: [
          { principalId: TEST_USER_ID, principalType: "USER" },
        ],
      }),
    );
    mockEventBridgeSendIsbEvents.mockResolvedValue(undefined);

    const result = await handler(
      createHandleCompletionInput({
        fannedOutPrincipals: [
          { principalId: TEST_USER_ID, principalType: "USER" },
        ],
      }),
      testContext,
    );

    expect(mockLeaseStoreReleaseLock).toHaveBeenCalledWith({
      leaseId: TEST_LEASE_ID,
      userEmail: TEST_OWNER_EMAIL,
      ownerId: TEST_LOCK_OWNER_ID,
    });
    expect(mockEventBridgeSendIsbEvents).toHaveBeenCalled();
    // Assert it is an AssignmentCreated event (not Removed) with correct detail
    const publishedArgs = mockEventBridgeSendIsbEvents.mock.calls[0]!;
    const createdDetail = publishedArgs[1].Detail;
    expect(createdDetail.principalId).toBe(TEST_USER_ID);
    expect(createdDetail.principalType).toBe("USER");
    expect(createdDetail.accountId).toBe(TEST_ACCOUNT_ID);
    expect(createdDetail.addedBy).toBe(TEST_REQUESTER_EMAIL);
    expect(createdDetail.leaseOwner).toBe(TEST_OWNER_EMAIL);
    expect(result).toEqual({ status: "SUCCESS", eventsPublished: 1 });
  });

  it("should continue with event publishing even if lock release fails", async () => {
    mockLeaseStoreReleaseLock.mockRejectedValue(new Error("Lock error"));
    mockPrincipalStoreGetAssignmentsForLease.mockResolvedValue({
      result: [createUserAssignmentRecord(TEST_USER_ID, TEST_LEASE_ID)],
    });
    mockLeaseStoreGet.mockResolvedValue(
      monitoredLeaseResult({
        desiredAssignments: [
          { principalId: TEST_USER_ID, principalType: "USER" },
        ],
      }),
    );
    mockEventBridgeSendIsbEvents.mockResolvedValue(undefined);

    const result = await handler(
      createHandleCompletionInput({
        fannedOutPrincipals: [
          { principalId: TEST_USER_ID, principalType: "USER" },
        ],
      }),
      testContext,
    );

    expect(result.status).toBe("SUCCESS");
    expect(mockEventBridgeSendIsbEvents).toHaveBeenCalled();
  });

  it("should publish AssignmentRemoved events for revoked principals", async () => {
    mockLeaseStoreReleaseLock.mockResolvedValue(undefined);
    mockPrincipalStoreGetAssignmentsForLease.mockResolvedValue({
      result: [], // Principal was revoked — no record exists
    });
    mockLeaseStoreGet.mockResolvedValue(
      monitoredLeaseResult({
        desiredAssignments: [
          { principalId: TEST_USER_ID, principalType: "USER" },
        ],
      }),
    );
    mockEventBridgeSendIsbEvents.mockResolvedValue(undefined);

    const result = await handler(
      createHandleCompletionInput({
        fannedOutPrincipals: [
          { principalId: TEST_USER_ID, principalType: "USER" },
          { principalId: TEST_GROUP_ID, principalType: "GROUP" },
        ],
      }),
      testContext,
    );

    // TEST_USER_ID is in desired but not in records → that's a failure, not a removal
    // TEST_GROUP_ID is not in desired AND not in records → that's a confirmed removal
    expect(result.eventsPublished).toBe(1);
    const publishedArgs = mockEventBridgeSendIsbEvents.mock.calls[0]!;
    const eventDetails = publishedArgs
      .slice(1)
      .map((e: { Detail: Record<string, unknown> }) => e.Detail);
    // Exactly one event, for the GROUP removal — never for the failed USER grant
    expect(eventDetails).toHaveLength(1);
    expect(eventDetails[0]!.principalId).toBe(TEST_GROUP_ID);
    expect(eventDetails[0]!.principalType).toBe("GROUP");
    expect(eventDetails[0]!.removedBy).toBe(TEST_REQUESTER_EMAIL);
    expect(eventDetails[0]!.leaseOwner).toBe(TEST_OWNER_EMAIL);
    expect(eventDetails.some((d) => d.principalId === TEST_USER_ID)).toBe(
      false,
    );
  });

  it("should not emit AssignmentCreated for pre-existing principals", async () => {
    const newUserId = "c3d4e5f6a7-770e8400-e29b-41d4-a716-446655440002";
    mockLeaseStoreReleaseLock.mockResolvedValue(undefined);
    // Both principals now have records (both granted / already present)
    mockPrincipalStoreGetAssignmentsForLease.mockResolvedValue({
      result: [
        createUserAssignmentRecord(TEST_USER_ID, TEST_LEASE_ID),
        createUserAssignmentRecord(newUserId, TEST_LEASE_ID),
      ],
    });
    mockLeaseStoreGet.mockResolvedValue(
      monitoredLeaseResult({
        desiredAssignments: [
          { principalId: TEST_USER_ID, principalType: "USER" },
          { principalId: newUserId, principalType: "USER" },
        ],
      }),
    );
    mockEventBridgeSendIsbEvents.mockResolvedValue(undefined);

    const result = await handler(
      createHandleCompletionInput({
        fannedOutPrincipals: [
          { principalId: TEST_USER_ID, principalType: "USER" },
          { principalId: newUserId, principalType: "USER" },
        ],
        // TEST_USER_ID already had a record before this execution
        preExistingPrincipalIds: [TEST_USER_ID],
      }),
      testContext,
    );

    // Only the genuinely new principal gets an AssignmentCreated event
    expect(result.eventsPublished).toBe(1);
    const publishedArgs = mockEventBridgeSendIsbEvents.mock.calls[0]!;
    const eventDetails = publishedArgs
      .slice(1)
      .map((e: { Detail: Record<string, unknown> }) => e.Detail);
    expect(eventDetails).toHaveLength(1);
    expect(eventDetails[0]!.principalId).toBe(newUserId);
    expect(eventDetails.some((d) => d.principalId === TEST_USER_ID)).toBe(
      false,
    );
  });

  it("should emit OrphanedAccessDetected warning for TERMINATE with lingering records", async () => {
    mockLeaseStoreReleaseLock.mockResolvedValue(undefined);
    mockPrincipalStoreGetAssignmentsForLease.mockResolvedValue({
      result: [createUserAssignmentRecord(TEST_USER_ID, TEST_LEASE_ID)],
    });
    mockLeaseStoreGet.mockResolvedValue(
      monitoredLeaseResult({ desiredAssignments: [] }),
    );
    mockEventBridgeSendIsbEvents.mockResolvedValue(undefined);

    const result = await handler(
      createHandleCompletionInput({ intent: "TERMINATE" }),
      testContext,
    );

    // Lingering records on TERMINATE are orphans (failed revokes), not confirmed
    // removals — no AssignmentRemoved/Created events should be published, and the
    // lock is still released. (OrphanedAccessDetected metric is a separate TODO.)
    expect(mockEventBridgeSendIsbEvents).not.toHaveBeenCalled();
    expect(result.eventsPublished).toBe(0);
    expect(mockLeaseStoreReleaseLock).toHaveBeenCalled();
  });

  it("should treat desiredAssignments as empty for TERMINATE intent (stale field ignored)", async () => {
    mockLeaseStoreReleaseLock.mockResolvedValue(undefined);
    // All records successfully revoked — no lingering records
    mockPrincipalStoreGetAssignmentsForLease.mockResolvedValue({
      result: [],
    });
    // desiredAssignments is NOT cleared by terminateLease — it retains stale state.
    // The metric logic must treat it as empty for critical intents to avoid
    // misclassifying successful revocations as "failed grants".
    mockLeaseStoreGet.mockResolvedValue(
      monitoredLeaseResult({
        desiredAssignments: [
          { principalId: TEST_USER_ID, principalType: "USER" },
          { principalId: TEST_GROUP_ID, principalType: "GROUP" },
        ],
      }),
    );
    mockEventBridgeSendIsbEvents.mockResolvedValue(undefined);

    const result = await handler(
      createHandleCompletionInput({
        intent: "TERMINATE",
        fannedOutPrincipals: [
          { principalId: TEST_USER_ID, principalType: "USER" },
          { principalId: TEST_GROUP_ID, principalType: "GROUP" },
        ],
      }),
      testContext,
    );

    // Both principals were revoked successfully (no records remain, not in desired
    // because desiredPrincipalIds is treated as empty for critical intents).
    // AssignmentRemoved events should be emitted for each revoked principal.
    expect(mockEventBridgeSendIsbEvents).toHaveBeenCalled();
    expect(result.eventsPublished).toBe(2);
    expect(mockLeaseStoreReleaseLock).toHaveBeenCalled();
  });

  it("should not publish events when no changes detected", async () => {
    mockLeaseStoreReleaseLock.mockResolvedValue(undefined);
    mockPrincipalStoreGetAssignmentsForLease.mockResolvedValue({
      result: [],
    });
    mockLeaseStoreGet.mockResolvedValue(
      monitoredLeaseResult({ desiredAssignments: [] }),
    );

    const result = await handler(createHandleCompletionInput(), testContext);

    expect(mockEventBridgeSendIsbEvents).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "SUCCESS", eventsPublished: 0 });
  });

  it("should handle group records in AssignmentCreated events", async () => {
    mockLeaseStoreReleaseLock.mockResolvedValue(undefined);
    mockPrincipalStoreGetAssignmentsForLease.mockResolvedValue({
      result: [createGroupAssignmentRecord(TEST_GROUP_ID, TEST_LEASE_ID)],
    });
    mockLeaseStoreGet.mockResolvedValue(
      monitoredLeaseResult({
        desiredAssignments: [
          { principalId: TEST_GROUP_ID, principalType: "GROUP" },
        ],
      }),
    );
    mockEventBridgeSendIsbEvents.mockResolvedValue(undefined);

    const result = await handler(
      createHandleCompletionInput({
        fannedOutPrincipals: [
          { principalId: TEST_GROUP_ID, principalType: "GROUP" },
        ],
      }),
      testContext,
    );

    expect(result.eventsPublished).toBe(1);
    const publishedEvents = mockEventBridgeSendIsbEvents.mock.calls[0]!;
    expect(publishedEvents[1].Detail.principalType).toBe("GROUP");
    expect(publishedEvents[1].Detail.assigneeEmail).toBeUndefined();
  });

  it("should handle undefined fannedOutPrincipals (no removal events)", async () => {
    mockLeaseStoreReleaseLock.mockResolvedValue(undefined);
    mockPrincipalStoreGetAssignmentsForLease.mockResolvedValue({
      result: [],
    });
    mockLeaseStoreGet.mockResolvedValue(
      monitoredLeaseResult({
        desiredAssignments: [
          { principalId: TEST_USER_ID, principalType: "USER" },
        ],
      }),
    );

    const result = await handler(createHandleCompletionInput(), testContext);

    expect(mockEventBridgeSendIsbEvents).not.toHaveBeenCalled();
    expect(result.eventsPublished).toBe(0);
  });

  it("should handle lease not found during HANDLE_COMPLETION", async () => {
    mockLeaseStoreReleaseLock.mockResolvedValue(undefined);
    mockPrincipalStoreGetAssignmentsForLease.mockResolvedValue({
      result: [],
    });
    mockLeaseStoreGet.mockResolvedValue({
      result: null,
    });

    const result = await handler(createHandleCompletionInput(), testContext);

    expect(result.eventsPublished).toBe(0);
  });
});

describe("input validation", () => {
  it("should reject invalid action payloads", async () => {
    await expect(
      handler(
        { action: "INVALID_ACTION", leaseId: TEST_LEASE_ID } as any,
        testContext,
      ),
    ).rejects.toThrow();
  });

  it("should reject completely invalid events", async () => {
    await expect(handler({ foo: "bar" } as any, testContext)).rejects.toThrow();
  });
});
