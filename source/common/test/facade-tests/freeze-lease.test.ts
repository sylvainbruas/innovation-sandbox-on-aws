// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ResourceLockConflictError } from "@amzn/innovation-sandbox-commons/data/errors.js";
import {
  ExpiredLeaseSchema,
  MonitoredLease,
  MonitoredLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { SandboxAccountSchema } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { LeaseFrozenEvent } from "@amzn/innovation-sandbox-commons/events/lease-frozen-event.js";
import {
  AccountNotInActiveError,
  CouldNotFindAccountError,
  InnovationSandbox,
} from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  mockedAccountStore,
  mockedIdcService,
  mockedIsbEventBridge,
  mockedLeaseStore,
  mockedOrganizationsTaggingService,
  mockedOrgsService,
} from "@amzn/innovation-sandbox-commons/test/mocking/common-mocks.js";
import { createMockOf } from "@amzn/innovation-sandbox-commons/test/mocking/mock-utils.js";
import {
  type IdcIdentity,
  IdcIdentitySchema,
} from "@amzn/innovation-sandbox-commons/utils/auth-utils.js";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

function createMockContext() {
  return {
    leaseStore: mockedLeaseStore(),
    sandboxAccountStore: mockedAccountStore(),
    idcService: mockedIdcService(),
    orgsService: mockedOrgsService(),
    organizationsTaggingService: mockedOrganizationsTaggingService(),
    eventBridgeClient: mockedIsbEventBridge(),
    logger: createMockOf(Logger),
    tracer: new Tracer(),
  };
}

const currentDateTime = DateTime.fromISO("2024-12-20T08:45:00.000Z", {
  zone: "utc",
}) as DateTime<true>;

describe("InnovationSandbox.freezeLease()", async () => {
  let mockContext: ReturnType<typeof createMockContext>;
  let mockLease: MonitoredLease;
  let mockUser: IdcIdentity;

  const mockLeaseAccount = generateSchemaData(SandboxAccountSchema, {
    status: "Active",
  });

  beforeEach(() => {
    mockContext = createMockContext();
    mockUser = generateSchemaData(IdcIdentitySchema);
    mockLease = generateSchemaData(MonitoredLeaseSchema, {
      status: "Active",
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
      resourceLock: undefined,
    });

    mockContext.sandboxAccountStore.get.mockImplementation(
      async (accountId) => {
        return {
          result:
            accountId === mockLeaseAccount.awsAccountId
              ? mockLeaseAccount
              : undefined,
        };
      },
    );

    mockContext.idcService.getUserFromEmail.mockImplementation(
      async (email) => {
        if (email === mockUser.email) {
          return mockUser;
        } else {
          throw new Error("Invalid ISB User.");
        }
      },
    );

    vi.useFakeTimers();
    vi.setSystemTime(currentDateTime.toJSDate());
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("leaves the lease untouched when the assignment lock cannot be acquired", async () => {
    // Regression: the lock used to be acquired AFTER the status/OU transaction,
    // so a conflict reported failure to the caller while the lease had already
    // flipped to Frozen.
    mockContext.leaseStore.acquireLock.mockRejectedValue(
      new ResourceLockConflictError("Lock held by another operation"),
    );

    await expect(
      InnovationSandbox.freezeLease(
        {
          lease: mockLease,
          reason: { type: "ManuallyFrozen", comment: "test" },
        },
        mockContext,
      ),
    ).rejects.toThrow(ResourceLockConflictError);

    expect(mockContext.leaseStore.update).not.toHaveBeenCalled();
    expect(mockContext.leaseStore.transactionalUpdate).not.toHaveBeenCalled();
    expect(mockContext.orgsService.moveAccount).not.toHaveBeenCalled();
    expect(
      mockContext.organizationsTaggingService.updateStatusTag,
    ).not.toHaveBeenCalled();
    expect(mockContext.eventBridgeClient.sendIsbEvent).not.toHaveBeenCalled();
  });

  test("carries the acquired lock onto the status write so the put cannot erase it", async () => {
    // Regression: update()/transactionalUpdate() are a full-item PutCommand
    // built from the lease read BEFORE the lock was taken. Without carrying the
    // lock through, the status write wiped resourceLock and the lease became
    // immediately unfreezable while the freeze was still processing.
    const acquiredLock = {
      ownerId: "freeze-abc",
      acquiredAt: "2024-12-20T08:45:00.000Z",
      expiresAt: "2024-12-20T09:00:00.000Z",
      meta: { intent: "FREEZE" as const },
    };
    mockContext.leaseStore.acquireLock.mockResolvedValue(acquiredLock);

    await InnovationSandbox.freezeLease(
      {
        lease: mockLease,
        reason: { type: "ManuallyFrozen", comment: "test" },
      },
      mockContext,
    );

    expect(mockContext.leaseStore.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "Frozen",
        resourceLock: acquiredLock,
      }),
    );
  });

  test("releases the lock when the status transition fails", async () => {
    mockContext.orgsService.moveAccount.mockRejectedValue(
      new Error("OU move failed"),
    );
    mockContext.leaseStore.releaseLock.mockResolvedValue(undefined);

    await expect(
      InnovationSandbox.freezeLease(
        {
          lease: mockLease,
          reason: { type: "ManuallyFrozen", comment: "test" },
        },
        mockContext,
      ),
    ).rejects.toThrow("OU move failed");

    expect(mockContext.leaseStore.releaseLock).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseId: mockLease.uuid,
        userEmail: mockLease.userEmail,
      }),
    );
    expect(mockContext.eventBridgeClient.sendIsbEvent).not.toHaveBeenCalled();
  });

  test("Happy Path - Lease Frozen", async () => {
    await InnovationSandbox.freezeLease(
      {
        lease: mockLease,
        reason: {
          type: "ManuallyFrozen",
          comment: "test suite freeze action",
        },
      },
      mockContext,
    );

    expect(mockContext.leaseStore.acquireLock).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseId: mockLease.uuid,
        meta: { intent: "FREEZE" },
      }),
    );

    // AssignmentRequested event emitted with FREEZE intent
    expect(mockContext.eventBridgeClient.sendIsbEvent).toHaveBeenCalledWith(
      mockContext.tracer,
      expect.objectContaining({
        DetailType: "AssignmentRequested",
        Detail: expect.objectContaining({
          intent: "FREEZE",
          leaseId: mockLease.uuid,
          leaseOwnerEmail: mockLease.userEmail,
        }),
      }),
    );

    expect(mockContext.orgsService.moveAccount).toHaveBeenCalledWith(
      mockLeaseAccount,
      "Active",
      "Frozen",
    );

    expect(mockContext.leaseStore.update).toHaveBeenCalledWith({
      ...mockLease,
      status: "Frozen",
    });

    expect(mockContext.eventBridgeClient.sendIsbEvent).toHaveBeenCalledWith(
      mockContext.tracer,
      new LeaseFrozenEvent({
        leaseId: {
          userEmail: mockLease.userEmail,
          uuid: mockLease.uuid,
        },
        accountId: mockLeaseAccount.awsAccountId,
        reason: {
          type: "ManuallyFrozen",
          comment: "test suite freeze action",
        },
      }),
    );
  });

  test("keeps the lock and propagates when the AssignmentRequested publish fails after the freeze commits", async () => {
    // FREEZE is critical, so releaseLockOnEventFailure is false — the lock is
    // deliberately retained so a timeout-based recovery can detect the orphan.
    // This test proves we don't accidentally release it.
    const acquiredLock = {
      ownerId: "freeze-publish-fail",
      acquiredAt: "2024-12-20T08:45:00.000Z",
      expiresAt: "2024-12-20T09:00:00.000Z",
      meta: { intent: "FREEZE" as const },
    };
    mockContext.leaseStore.acquireLock.mockResolvedValue(acquiredLock);

    // The first sendIsbEvent call is the AssignmentRequested publish (inside
    // publishAssignmentProcessingRequest); make it fail.
    mockContext.eventBridgeClient.sendIsbEvent.mockRejectedValue(
      new Error("EventBridge PutEvents throttled"),
    );

    await expect(
      InnovationSandbox.freezeLease(
        {
          lease: mockLease,
          reason: { type: "ManuallyFrozen", comment: "test" },
        },
        mockContext,
      ),
    ).rejects.toThrow("EventBridge PutEvents throttled");

    // Critical intent: lock must NOT be released — it stays so the
    // timeout-based recovery (or manual operator intervention) can detect
    // the orphan and retry.
    expect(mockContext.leaseStore.releaseLock).not.toHaveBeenCalled();

    // The transaction DID commit (status write + OU move happened before publish)
    expect(mockContext.leaseStore.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "Frozen",
        resourceLock: acquiredLock,
      }),
    );
  });

  test("Fails when attempting to freeze a lease that is not active", async () => {
    const alreadyExpiredLease = generateSchemaData(ExpiredLeaseSchema);

    await expect(
      InnovationSandbox.freezeLease(
        {
          lease: alreadyExpiredLease,
          reason: {
            type: "ManuallyFrozen",
            comment: "test suite freeze action",
          },
        },
        mockContext,
      ),
    ).rejects.toThrow(AccountNotInActiveError);
  });

  test("Fails when account information cannot be recovered", async () => {
    mockContext.sandboxAccountStore.get.mockResolvedValueOnce({
      result: undefined,
    });

    await expect(
      InnovationSandbox.freezeLease(
        {
          lease: mockLease,
          reason: {
            type: "ManuallyFrozen",
            comment: "test suite freeze action",
          },
        },
        mockContext,
      ),
    ).rejects.toThrow(CouldNotFindAccountError);
  });

  test("writes the Status tag as Frozen after the OU move", async () => {
    await InnovationSandbox.freezeLease(
      {
        lease: mockLease,
        reason: { type: "ManuallyFrozen", comment: "test" },
      },
      mockContext,
    );

    expect(
      mockContext.organizationsTaggingService.updateStatusTag,
    ).toHaveBeenCalledWith(mockLeaseAccount.awsAccountId, "Frozen");
  });

  test("status-tag failure does not block the lifecycle", async () => {
    mockContext.organizationsTaggingService.updateStatusTag.mockRejectedValue(
      new Error("AccessDenied"),
    );

    await InnovationSandbox.freezeLease(
      {
        lease: mockLease,
        reason: { type: "ManuallyFrozen", comment: "test" },
      },
      mockContext,
    );

    // Lifecycle continues — event still emitted.
    expect(mockContext.eventBridgeClient.sendIsbEvent).toHaveBeenCalled();
  });
});
