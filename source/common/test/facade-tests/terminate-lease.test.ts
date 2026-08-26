// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { MonitoredLeaseSchema } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  SandboxAccount,
  SandboxAccountSchema,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { CleanAccountRequest } from "@amzn/innovation-sandbox-commons/events/clean-account-request.js";
import {
  getLeaseTerminatedReason,
  LeaseTerminatedEvent,
} from "@amzn/innovation-sandbox-commons/events/lease-terminated-event.js";
import { InnovationSandbox } from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import {
  searchableAccountProperties,
  searchableLeaseProperties,
} from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { mockGlobalConfig } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  mockedAccountStore,
  mockedBlueprintDeploymentService,
  mockedBlueprintStore,
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
import { datetimeAsString } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
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
    blueprintStore: mockedBlueprintStore(),
    blueprintDeploymentService: mockedBlueprintDeploymentService(),
    logger: createMockOf(Logger),
    tracer: new Tracer(),
    globalConfig: mockGlobalConfig(),
  };
}

const currentDateTime = DateTime.fromISO("2024-12-20T08:45:00.000Z", {
  zone: "utc",
}) as DateTime<true>;

describe("InnovationSandbox.terminateLease()", () => {
  let mockContext: ReturnType<typeof createMockContext>;
  let mockUser: IdcIdentity;
  let mockLeaseAccount: SandboxAccount;

  beforeEach(() => {
    mockContext = createMockContext();
    mockUser = generateSchemaData(IdcIdentitySchema);
    mockLeaseAccount = generateSchemaData(SandboxAccountSchema, {
      awsAccountId: "000000000000",
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

  test("HappyPath - terminate active lease acquires lock and triggers Step Function", async () => {
    const lease = generateSchemaData(MonitoredLeaseSchema, {
      status: "Active",
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
    });

    await InnovationSandbox.terminateLease(
      {
        lease,
        expiredStatus: "ManuallyTerminated",
      },
      mockContext,
    );

    expect(mockContext.orgsService.moveAccount).toHaveBeenCalledWith(
      mockLeaseAccount,
      mockLeaseAccount.status,
      "CleanUp",
    );

    expect(mockContext.leaseStore.update).toHaveBeenCalledWith({
      ...lease,
      ttl: Math.floor(currentDateTime.plus({ days: 30 }).valueOf() / 1000),
      status: "ManuallyTerminated",
      endDate: currentDateTime.toISO(),
    });

    // Acquires lock with TERMINATE intent (no desiredAssignments — processor handles clearing)
    expect(mockContext.leaseStore.acquireLock).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseId: lease.uuid,
        userEmail: lease.userEmail,
        timeoutSeconds: 900,
        meta: { intent: "TERMINATE" },
      }),
    );

    // AssignmentRequested event emitted with TERMINATE intent
    expect(mockContext.eventBridgeClient.sendIsbEvent).toHaveBeenCalledWith(
      mockContext.tracer,
      expect.objectContaining({
        DetailType: "AssignmentRequested",
        Detail: expect.objectContaining({
          intent: "TERMINATE",
          leaseId: lease.uuid,
          requestedBy: lease.userEmail,
          leaseOwnerEmail: lease.userEmail,
        }),
      }),
    );

    // No synchronous revokeAllUserAccess — handled async by Step Function

    expect(mockContext.eventBridgeClient.sendIsbEvents).toHaveBeenCalledWith(
      mockContext.tracer,
      new CleanAccountRequest({
        accountId: lease.awsAccountId,
        reason: "LEASE_TERMINATION",
      }),
      new LeaseTerminatedEvent({
        leaseId: {
          userEmail: lease.userEmail,
          uuid: lease.uuid,
        },
        accountId: lease.awsAccountId,
        reason: getLeaseTerminatedReason("ManuallyTerminated", lease),
      }),
    );
  });

  test("HappyPath - terminate frozen lease", async () => {
    const lease = generateSchemaData(MonitoredLeaseSchema, {
      status: "Frozen",
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
      leaseDurationInHours: 48,
    });

    await InnovationSandbox.terminateLease(
      {
        lease,
        expiredStatus: "Expired",
      },
      mockContext,
    );

    expect(
      mockContext.orgsService.transactionalMoveAccount,
    ).toHaveBeenCalledWith(
      mockLeaseAccount,
      mockLeaseAccount.status,
      "CleanUp",
    );

    expect(mockContext.leaseStore.update).toHaveBeenCalledWith({
      ...lease,
      ttl: Math.floor(currentDateTime.plus({ days: 30 }).valueOf() / 1000),
      status: "Expired",
      endDate: currentDateTime.toISO(),
    });

    // No assignment records → backward compat path

    expect(mockContext.eventBridgeClient.sendIsbEvents).toHaveBeenCalledWith(
      mockContext.tracer,
      new CleanAccountRequest({
        accountId: lease.awsAccountId,
        reason: "LEASE_TERMINATION",
      }),
      new LeaseTerminatedEvent({
        leaseId: {
          userEmail: lease.userEmail,
          uuid: lease.uuid,
        },
        accountId: lease.awsAccountId,
        reason: getLeaseTerminatedReason("Expired", lease),
      }),
    );
  });

  test("reports LeaseTermination metric correctly", async () => {
    const lease = generateSchemaData(MonitoredLeaseSchema, {
      status: "Active",
      startDate: currentDateTime.minus({ days: 2 }).toISO(),
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
    });

    await InnovationSandbox.terminateLease(
      {
        lease,
        expiredStatus: "ManuallyTerminated",
      },
      mockContext,
    );

    expect(mockContext.logger.info).toHaveBeenCalledWith(
      `Lease ${lease.uuid} owned by ${lease.userEmail} terminated: ManuallyTerminated`,
      {
        ...searchableAccountProperties(mockLeaseAccount),
        ...searchableLeaseProperties(lease),
        logDetailType: "LeaseTerminated",
        startDate: lease.startDate,
        terminationDate: datetimeAsString(currentDateTime),
        maxBudget: lease.maxSpend,
        actualSpend: lease.totalCostAccrued,
        maxDurationHours: lease.leaseDurationInHours,
        actualDurationHours: 48,
        reasonForTermination: "ManuallyTerminated",
      },
    );
  });

  test("writes the Status tag as CleanUp after the OU move when autoCleanup is true", async () => {
    const lease = generateSchemaData(MonitoredLeaseSchema, {
      status: "Active",
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
    });

    await InnovationSandbox.terminateLease(
      {
        lease,
        expiredStatus: "ManuallyTerminated",
      },
      mockContext,
    );

    expect(
      mockContext.organizationsTaggingService.updateStatusTag,
    ).toHaveBeenCalledWith(mockLeaseAccount.awsAccountId, "CleanUp");
  });

  test("does NOT write the Status tag when autoCleanup is false", async () => {
    const lease = generateSchemaData(MonitoredLeaseSchema, {
      status: "Active",
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
    });

    await InnovationSandbox.terminateLease(
      {
        lease,
        expiredStatus: "ManuallyTerminated",
        autoCleanup: false,
      },
      mockContext,
    );

    expect(
      mockContext.organizationsTaggingService.updateStatusTag,
    ).not.toHaveBeenCalled();
  });

  test("status-tag failure does not block the lifecycle", async () => {
    const lease = generateSchemaData(MonitoredLeaseSchema, {
      status: "Active",
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
    });
    mockContext.organizationsTaggingService.updateStatusTag.mockRejectedValue(
      new Error("AccessDenied"),
    );

    await InnovationSandbox.terminateLease(
      { lease, expiredStatus: "ManuallyTerminated" },
      mockContext,
    );

    // Lifecycle continues — events still emitted.
    expect(mockContext.eventBridgeClient.sendIsbEvents).toHaveBeenCalled();
  });

  test("propagates error when acquireLock fails with ResourceLockConflictError", async () => {
    const { ResourceLockConflictError } = await import(
      "@amzn/innovation-sandbox-commons/data/errors.js"
    );
    const lease = generateSchemaData(MonitoredLeaseSchema, {
      status: "Active",
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
    });

    mockContext.leaseStore.acquireLock.mockRejectedValue(
      new ResourceLockConflictError("Lock held by another operation"),
    );

    await expect(
      InnovationSandbox.terminateLease(
        { lease, expiredStatus: "ManuallyTerminated" },
        mockContext,
      ),
    ).rejects.toThrow("Lock held by another operation");

    // Lease status was updated before lock acquisition attempt
    expect(mockContext.leaseStore.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ManuallyTerminated" }),
    );

    // CleanAccountRequest and LeaseTerminatedEvent NOT sent (error thrown before sendIsbEvents)
    expect(mockContext.eventBridgeClient.sendIsbEvents).not.toHaveBeenCalled();
  });

  test("holds lock when sendIsbEvent fails for TERMINATE (critical intent)", async () => {
    const lease = generateSchemaData(MonitoredLeaseSchema, {
      status: "Active",
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
    });

    mockContext.eventBridgeClient.sendIsbEvent.mockRejectedValue(
      new Error("EventBridge throttled"),
    );

    await expect(
      InnovationSandbox.terminateLease(
        { lease, expiredStatus: "ManuallyTerminated" },
        mockContext,
      ),
    ).rejects.toThrow("EventBridge throttled");

    // Lock was acquired but NOT released (critical intent holds lock)
    expect(mockContext.leaseStore.acquireLock).toHaveBeenCalled();
    expect(mockContext.leaseStore.releaseLock).not.toHaveBeenCalled();
  });
});
