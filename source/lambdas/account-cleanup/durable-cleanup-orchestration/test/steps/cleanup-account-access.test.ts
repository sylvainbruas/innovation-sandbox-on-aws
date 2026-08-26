// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupAccountAccess } from "@amzn/innovation-sandbox-durable-cleanup-orchestration/steps/cleanup-account-access.js";
import type { CleanupContext } from "@amzn/innovation-sandbox-durable-cleanup-orchestration/steps/types.js";

// Mock external dependencies
const mockSsoAdminSend = vi.fn();
const mockGetIdcConfig = vi.fn();
const mockGetAssignmentsForLease = vi.fn();
const mockDeleteUserAssignment = vi.fn().mockResolvedValue(undefined);
const mockDeleteGroupAssignment = vi.fn().mockResolvedValue(undefined);

vi.mock("@amzn/innovation-sandbox-commons/isb-services/index.js", () => ({
  IsbServices: {
    idcStackConfigStore: () => ({ get: mockGetIdcConfig }),
    principalStore: () => ({
      getAssignmentsForLease: mockGetAssignmentsForLease,
      deleteUserAssignment: mockDeleteUserAssignment,
      deleteGroupAssignment: mockDeleteGroupAssignment,
    }),
  },
}));

vi.mock("@amzn/innovation-sandbox-commons/sdk-clients/index.js", () => ({
  IsbClients: {
    ssoAdmin: () => ({ send: mockSsoAdminSend }),
  },
}));

vi.mock(
  "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js",
  () => ({
    fromTemporaryIsbIdcCredentials: vi.fn().mockReturnValue({}),
  }),
);

// Mock the paginator
vi.mock("@aws-sdk/client-sso-admin", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    paginateListAccountAssignments: vi.fn(),
  };
});

// Mock p-throttle to pass through without delay (module-scoped throttle would
// otherwise serialize calls across tests and add real 1s delays)
vi.mock("p-throttle", () => ({
  default: () => (fn: any) => fn,
}));

// Mock exponential-backoff to execute immediately without delays
vi.mock("exponential-backoff", () => ({
  backOff: async (fn: () => Promise<any>, options?: any) => {
    const maxAttempts = options?.numOfAttempts ?? 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        const shouldRetry = options?.retry?.(error) ?? true;
        if (!shouldRetry || attempt === maxAttempts) throw error;
      }
    }
  },
}));

import { paginateListAccountAssignments } from "@aws-sdk/client-sso-admin";

const TEST_ACCOUNT_ID = "123456789012";
const TEST_INSTANCE_ARN = "arn:aws:sso:::instance/ssoins-1234567890abcdef0";
const TEST_PERMISSION_SET_ARN =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef0/ps-0123456789abcdef0";
const TEST_LEASE_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function createMockContext(
  overrides?: Partial<CleanupContext>,
): CleanupContext {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    durableContext: { logger } as unknown as CleanupContext["durableContext"],
    env: {
      PRINCIPAL_TABLE_NAME: "test-principal-table",
      IDC_CONFIG_PARAM_ARN:
        "arn:aws:ssm:us-east-1:111111111111:parameter/isb_test_idc_config",
      IDC_ROLE_ARN: "arn:aws:iam::222222222222:role/ISB-IdcRole",
      INTERMEDIATE_ROLE_ARN:
        "arn:aws:iam::111111111111:role/ISB-IntermediateRole",
      USER_AGENT_EXTRA: "ISB-Test/1.0",
    } as unknown as CleanupContext["env"],
    accountId: TEST_ACCOUNT_ID,
    executionArn:
      "arn:aws:states:us-east-1:111111111111:execution:DurableCleanup:exec-abc",
    cleanupReason: "LEASE_TERMINATION",
    executionStartTime: "2024-06-01T12:00:00.000Z",
    accountStore: {
      get: vi
        .fn()
        .mockResolvedValue({ result: { awsAccountId: TEST_ACCOUNT_ID } }),
    } as unknown as CleanupContext["accountStore"],
    eventBridge: {} as CleanupContext["eventBridge"],
    organizationsTaggingService:
      {} as CleanupContext["organizationsTaggingService"],
    reportWriter: {
      updateReport: vi.fn().mockResolvedValue(undefined),
    } as unknown as CleanupContext["reportWriter"],
    reportKey: {} as CleanupContext["reportKey"],
    ...overrides,
  };
}

function setupPaginator(pages: { AccountAssignments: any[] }[]) {
  vi.mocked(paginateListAccountAssignments).mockImplementation(
    async function* () {
      for (const page of pages) {
        yield page;
      }
    } as any,
  );
}

describe("cleanupAccountAccess()", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetIdcConfig.mockResolvedValue({
      ssoInstanceArn: TEST_INSTANCE_ARN,
      userPermissionSetArn: TEST_PERMISSION_SET_ARN,
      identityStoreId: "d-1234567890",
    });

    mockGetAssignmentsForLease.mockResolvedValue({
      result: [],
      nextPageIdentifier: null,
    });
  });

  it("returns zero counts when no IDC assignments exist and no leaseId on account", async () => {
    const ctx = createMockContext();
    setupPaginator([{ AccountAssignments: [] }]);

    const result = await cleanupAccountAccess(ctx);

    expect(result).toEqual({
      assignmentsFound: 0,
      assignmentsDeleted: 0,
      principalRecordsFound: 0,
      principalRecordsDeleted: 0,
    });
  });

  it("deletes lingering IDC assignments and polls for completion", async () => {
    const ctx = createMockContext();
    setupPaginator([
      {
        AccountAssignments: [
          {
            AccountId: TEST_ACCOUNT_ID,
            PermissionSetArn: TEST_PERMISSION_SET_ARN,
            PrincipalId: "user-id-1",
            PrincipalType: "USER",
          },
          {
            AccountId: TEST_ACCOUNT_ID,
            PermissionSetArn: TEST_PERMISSION_SET_ARN,
            PrincipalId: "user-id-2",
            PrincipalType: "USER",
          },
        ],
      },
    ]);

    // Each assignment: DeleteAccountAssignment → Describe (SUCCEEDED)
    mockSsoAdminSend
      .mockResolvedValueOnce({
        AccountAssignmentDeletionStatus: { RequestId: "req-1" },
      })
      .mockResolvedValueOnce({
        AccountAssignmentDeletionStatus: { Status: "SUCCEEDED" },
      })
      .mockResolvedValueOnce({
        AccountAssignmentDeletionStatus: { RequestId: "req-2" },
      })
      .mockResolvedValueOnce({
        AccountAssignmentDeletionStatus: { Status: "SUCCEEDED" },
      });

    const result = await cleanupAccountAccess(ctx);

    expect(result.assignmentsFound).toBe(2);
    // 2 deletes + 2 describe polls
    expect(mockSsoAdminSend).toHaveBeenCalledTimes(4);
    expect(mockSsoAdminSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          InstanceArn: TEST_INSTANCE_ARN,
          PermissionSetArn: TEST_PERMISSION_SET_ARN,
          PrincipalId: "user-id-1",
          PrincipalType: "USER",
          TargetId: TEST_ACCOUNT_ID,
          TargetType: "AWS_ACCOUNT",
        }),
      }),
    );
    expect(mockSsoAdminSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          PrincipalId: "user-id-2",
          PrincipalType: "USER",
        }),
      }),
    );
  });

  it("throws after attempting all deletions when some fail", async () => {
    const ctx = createMockContext();
    setupPaginator([
      {
        AccountAssignments: [
          {
            AccountId: TEST_ACCOUNT_ID,
            PermissionSetArn: TEST_PERMISSION_SET_ARN,
            PrincipalId: "user-id-1",
            PrincipalType: "USER",
          },
          {
            AccountId: TEST_ACCOUNT_ID,
            PermissionSetArn: TEST_PERMISSION_SET_ARN,
            PrincipalId: "user-id-2",
            PrincipalType: "USER",
          },
        ],
      },
    ]);

    mockSsoAdminSend
      .mockRejectedValueOnce(new Error("ConflictException"))
      // Second assignment: delete succeeds + poll succeeds
      .mockResolvedValueOnce({
        AccountAssignmentDeletionStatus: { RequestId: "req-2" },
      })
      .mockResolvedValueOnce({
        AccountAssignmentDeletionStatus: { Status: "SUCCEEDED" },
      });

    await expect(cleanupAccountAccess(ctx)).rejects.toThrow(
      "1/2 IDC assignment deletions failed",
    );
    // First delete (fail) + second delete + second poll = 3 calls
    expect(mockSsoAdminSend).toHaveBeenCalledTimes(3);
  });

  it("handles multiple pages of assignments", async () => {
    const ctx = createMockContext();
    setupPaginator([
      {
        AccountAssignments: [
          {
            AccountId: TEST_ACCOUNT_ID,
            PermissionSetArn: TEST_PERMISSION_SET_ARN,
            PrincipalId: "user-id-1",
            PrincipalType: "USER",
          },
        ],
      },
      {
        AccountAssignments: [
          {
            AccountId: TEST_ACCOUNT_ID,
            PermissionSetArn: TEST_PERMISSION_SET_ARN,
            PrincipalId: "user-id-2",
            PrincipalType: "USER",
          },
        ],
      },
    ]);

    mockSsoAdminSend.mockResolvedValue({});

    const result = await cleanupAccountAccess(ctx);

    expect(result.assignmentsFound).toBe(2);
  });

  it("handles zero pages from paginator gracefully", async () => {
    const ctx = createMockContext();
    setupPaginator([]);

    const result = await cleanupAccountAccess(ctx);

    expect(result.assignmentsFound).toBe(0);
    expect(mockSsoAdminSend).not.toHaveBeenCalled();
  });

  it("handles pages with undefined AccountAssignments", async () => {
    const ctx = createMockContext();
    setupPaginator([{ AccountAssignments: undefined as any }]);

    const result = await cleanupAccountAccess(ctx);

    expect(result.assignmentsFound).toBe(0);
    expect(mockSsoAdminSend).not.toHaveBeenCalled();
  });

  it("deletes GROUP type assignments from IDC", async () => {
    const ctx = createMockContext();
    setupPaginator([
      {
        AccountAssignments: [
          {
            AccountId: TEST_ACCOUNT_ID,
            PermissionSetArn: TEST_PERMISSION_SET_ARN,
            PrincipalId: "group-id-1",
            PrincipalType: "GROUP",
          },
        ],
      },
    ]);

    mockSsoAdminSend
      .mockResolvedValueOnce({
        AccountAssignmentDeletionStatus: { RequestId: "req-group" },
      })
      .mockResolvedValueOnce({
        AccountAssignmentDeletionStatus: { Status: "SUCCEEDED" },
      });

    const result = await cleanupAccountAccess(ctx);

    expect(result.assignmentsFound).toBe(1);
    expect(mockSsoAdminSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          PrincipalId: "group-id-1",
          PrincipalType: "GROUP",
        }),
      }),
    );
  });

  describe("deletion status polling", () => {
    it("polls until SUCCEEDED after IN_PROGRESS", async () => {
      const ctx = createMockContext();
      setupPaginator([
        {
          AccountAssignments: [
            {
              AccountId: TEST_ACCOUNT_ID,
              PermissionSetArn: TEST_PERMISSION_SET_ARN,
              PrincipalId: "user-id-1",
              PrincipalType: "USER",
            },
          ],
        },
      ]);

      mockSsoAdminSend
        // Delete call
        .mockResolvedValueOnce({
          AccountAssignmentDeletionStatus: { RequestId: "req-1" },
        })
        // First poll: IN_PROGRESS
        .mockResolvedValueOnce({
          AccountAssignmentDeletionStatus: { Status: "IN_PROGRESS" },
        })
        // Second poll: SUCCEEDED
        .mockResolvedValueOnce({
          AccountAssignmentDeletionStatus: { Status: "SUCCEEDED" },
        });

      const result = await cleanupAccountAccess(ctx);

      expect(result.assignmentsFound).toBe(1);
      expect(mockSsoAdminSend).toHaveBeenCalledTimes(3);
    });

    it("throws when polling returns FAILED status", async () => {
      const ctx = createMockContext();
      setupPaginator([
        {
          AccountAssignments: [
            {
              AccountId: TEST_ACCOUNT_ID,
              PermissionSetArn: TEST_PERMISSION_SET_ARN,
              PrincipalId: "user-id-1",
              PrincipalType: "USER",
            },
          ],
        },
      ]);

      mockSsoAdminSend
        .mockResolvedValueOnce({
          AccountAssignmentDeletionStatus: { RequestId: "req-fail" },
        })
        .mockResolvedValueOnce({
          AccountAssignmentDeletionStatus: {
            Status: "FAILED",
            FailureReason: "Permission denied",
          },
        });

      await expect(cleanupAccountAccess(ctx)).rejects.toThrow(
        "1/1 IDC assignment deletions failed",
      );
    });

    it("skips polling when no RequestId is returned", async () => {
      const ctx = createMockContext();
      setupPaginator([
        {
          AccountAssignments: [
            {
              AccountId: TEST_ACCOUNT_ID,
              PermissionSetArn: TEST_PERMISSION_SET_ARN,
              PrincipalId: "user-id-1",
              PrincipalType: "USER",
            },
          ],
        },
      ]);

      // Delete returns without RequestId — no polling needed
      mockSsoAdminSend.mockResolvedValueOnce({});

      const result = await cleanupAccountAccess(ctx);

      expect(result.assignmentsFound).toBe(1);
      // Only the delete call, no describe call
      expect(mockSsoAdminSend).toHaveBeenCalledTimes(1);
    });
  });

  describe("Principal Table cleanup", () => {
    it("deletes user assignment records when leaseId is on account record", async () => {
      const ctx = createMockContext({
        accountStore: {
          get: vi.fn().mockResolvedValue({
            result: {
              awsAccountId: TEST_ACCOUNT_ID,
              currentLease: {
                leaseId: TEST_LEASE_ID,
                ownerEmail: "owner@example.com",
              },
            },
          }),
        } as unknown as CleanupContext["accountStore"],
      });
      setupPaginator([{ AccountAssignments: [] }]);

      mockGetAssignmentsForLease.mockResolvedValue({
        result: [
          {
            userId: "user-id-1",
            principalType: "USER",
            leaseId: TEST_LEASE_ID,
          },
        ],
        nextPageIdentifier: null,
      });

      const result = await cleanupAccountAccess(ctx);

      expect(result.principalRecordsDeleted).toBe(1);
      expect(mockDeleteUserAssignment).toHaveBeenCalledWith(
        "user-id-1",
        TEST_LEASE_ID,
      );
    });

    it("deletes group assignment records when leaseId is on account record", async () => {
      const ctx = createMockContext({
        accountStore: {
          get: vi.fn().mockResolvedValue({
            result: {
              awsAccountId: TEST_ACCOUNT_ID,
              currentLease: {
                leaseId: TEST_LEASE_ID,
                ownerEmail: "owner@example.com",
              },
            },
          }),
        } as unknown as CleanupContext["accountStore"],
      });
      setupPaginator([{ AccountAssignments: [] }]);

      mockGetAssignmentsForLease.mockResolvedValue({
        result: [
          {
            groupId: "group-id-1",
            principalType: "GROUP",
            leaseId: TEST_LEASE_ID,
          },
        ],
        nextPageIdentifier: null,
      });

      const result = await cleanupAccountAccess(ctx);

      expect(result.principalRecordsDeleted).toBe(1);
      expect(mockDeleteGroupAssignment).toHaveBeenCalledWith(
        "group-id-1",
        TEST_LEASE_ID,
      );
    });

    it("skips Principal Table cleanup when no leaseId on account", async () => {
      const ctx = createMockContext();
      setupPaginator([{ AccountAssignments: [] }]);

      const result = await cleanupAccountAccess(ctx);

      expect(result.principalRecordsDeleted).toBe(0);
      expect(mockGetAssignmentsForLease).not.toHaveBeenCalled();
    });

    it("throws when individual record deletion fails", async () => {
      const ctx = createMockContext({
        accountStore: {
          get: vi.fn().mockResolvedValue({
            result: {
              awsAccountId: TEST_ACCOUNT_ID,
              currentLease: {
                leaseId: TEST_LEASE_ID,
                ownerEmail: "owner@example.com",
              },
            },
          }),
        } as unknown as CleanupContext["accountStore"],
      });
      setupPaginator([{ AccountAssignments: [] }]);

      mockGetAssignmentsForLease.mockResolvedValue({
        result: [
          {
            userId: "user-id-1",
            principalType: "USER",
            leaseId: TEST_LEASE_ID,
          },
        ],
        nextPageIdentifier: null,
      });

      mockDeleteUserAssignment.mockRejectedValueOnce(
        new Error("ConditionalCheckFailed"),
      );

      await expect(cleanupAccountAccess(ctx)).rejects.toThrow(
        "Principal Table record deletions failed",
      );
    });

    it("throws when accountStore.get fails", async () => {
      const ctx = createMockContext({
        accountStore: {
          get: vi.fn().mockRejectedValue(new Error("DynamoDB error")),
        } as unknown as CleanupContext["accountStore"],
      });
      setupPaginator([{ AccountAssignments: [] }]);

      await expect(cleanupAccountAccess(ctx)).rejects.toThrow("DynamoDB error");
    });
  });

  describe("report writing", () => {
    it("does not throw when reportWriter.updateReport fails", async () => {
      const ctx = createMockContext({
        reportWriter: {
          updateReport: vi
            .fn()
            .mockRejectedValue(new Error("Report write failed")),
        } as unknown as CleanupContext["reportWriter"],
      });
      setupPaginator([{ AccountAssignments: [] }]);

      const result = await cleanupAccountAccess(ctx);

      expect(result.assignmentsFound).toBe(0);
      expect(result.assignmentsDeleted).toBe(0);
    });
  });
});
