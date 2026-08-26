// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { SQSEvent } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DynamoLeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/dynamo-lease-store.js";
import {
  MonitoredLeaseSchema,
  PendingLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { DynamoSandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/dynamo-sandbox-account-store.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { InnovationSandbox } from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import { OrganizationsTaggingService } from "@amzn/innovation-sandbox-commons/isb-services/organizations-tagging-service.js";
import { SandboxOuService } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-ou-service.js";
import { AccountLifecycleManagementEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/account-lifecycle-management-lambda-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  mockContext,
  mockGlobalConfig,
} from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  bulkStubEnv,
  mockAppConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";

import { handler } from "@amzn/innovation-sandbox-account-lifecycle-management/account-lifecycle-manager.js";

const testEnv = generateSchemaData(AccountLifecycleManagementEnvironmentSchema);

// Stub envs at module-load time so the lambda's baseMiddlewareBundle and
// isbConfigMiddleware see them before any request fires.
bulkStubEnv(testEnv);
mockAppConfigMiddleware(mockGlobalConfig());

function sqsEvent(detailType: string, detail: unknown): SQSEvent {
  return {
    Records: [
      {
        body: JSON.stringify({ "detail-type": detailType, detail }),
      } as SQSEvent["Records"][number],
    ],
  };
}

describe("AccountLifecycleManager handler", () => {
  beforeEach(() => {
    bulkStubEnv(testEnv);
    mockAppConfigMiddleware(mockGlobalConfig());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  describe("event dispatch", () => {
    it("rejects multi-record SQS payloads", async () => {
      const event: SQSEvent = {
        Records: [
          { body: "{}" } as SQSEvent["Records"][number],
          { body: "{}" } as SQSEvent["Records"][number],
        ],
      };
      await expect(handler(event, mockContext(testEnv))).rejects.toThrow(
        /Only one event is supported/,
      );
    });

    it("rejects unsupported detail-type", async () => {
      await expect(
        handler(sqsEvent("NotARealEvent", {}), mockContext(testEnv)),
      ).rejects.toThrow(/Unsupported event detail type: NotARealEvent/);
    });
  });

  describe("LeaseBudgetExceededAlert", () => {
    it("loads the lease and routes to InnovationSandbox.terminateLease with BudgetExceeded status", async () => {
      const lease = generateSchemaData(MonitoredLeaseSchema, {
        status: "Active",
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });
      const terminateSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockResolvedValue();

      await handler(
        sqsEvent(EventDetailTypes.LeaseBudgetExceededAlert, {
          leaseId: { uuid: lease.uuid, userEmail: lease.userEmail },
          accountId: lease.awsAccountId,
          budget: 100,
          totalSpend: 110,
        }),
        mockContext(testEnv),
      );

      expect(terminateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ lease, expiredStatus: "BudgetExceeded" }),
        expect.objectContaining({
          organizationsTaggingService: expect.any(OrganizationsTaggingService),
        }),
      );
    });

    it("throws when the lease cannot be found", async () => {
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: undefined,
      });
      await expect(
        handler(
          sqsEvent(EventDetailTypes.LeaseBudgetExceededAlert, {
            leaseId: {
              uuid: "00000000-0000-0000-0000-000000000000",
              userEmail: "u@example.com",
            },
            accountId: "111111111111",
            budget: 100,
            totalSpend: 110,
          }),
          mockContext(testEnv),
        ),
      ).rejects.toThrow(/Lease not found/);
    });

    it("throws when the lease is not monitored", async () => {
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: generateSchemaData(PendingLeaseSchema, {
          status: "PendingApproval",
        }),
      });
      await expect(
        handler(
          sqsEvent(EventDetailTypes.LeaseBudgetExceededAlert, {
            leaseId: {
              uuid: "11111111-1111-4111-8111-111111111111",
              userEmail: "u@example.com",
            },
            accountId: "111111111111",
            budget: 100,
            totalSpend: 110,
          }),
          mockContext(testEnv),
        ),
      ).rejects.toThrow(/incorrectly raised for an inactive lease/);
    });
  });

  describe("LeaseExpiredAlert", () => {
    it("routes to InnovationSandbox.terminateLease with Expired status", async () => {
      const lease = generateSchemaData(MonitoredLeaseSchema, {
        status: "Active",
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });
      const terminateSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockResolvedValue();

      await handler(
        sqsEvent(EventDetailTypes.LeaseExpiredAlert, {
          leaseId: { uuid: lease.uuid, userEmail: lease.userEmail },
          accountId: lease.awsAccountId,
          leaseExpirationDate: new Date().toISOString(),
        }),
        mockContext(testEnv),
      );

      expect(terminateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ lease, expiredStatus: "Expired" }),
        expect.anything(),
      );
    });
  });

  describe("LeaseFreezingThresholdBreachedAlert", () => {
    it("routes to InnovationSandbox.freezeLease", async () => {
      const lease = generateSchemaData(MonitoredLeaseSchema, {
        status: "Active",
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });
      const freezeSpy = vi
        .spyOn(InnovationSandbox, "freezeLease")
        .mockResolvedValue();

      await handler(
        sqsEvent(EventDetailTypes.LeaseFreezingThresholdBreachedAlert, {
          leaseId: { uuid: lease.uuid, userEmail: lease.userEmail },
          accountId: lease.awsAccountId,
          reason: {
            type: "BudgetExceeded",
            triggeredBudgetThreshold: 90,
            totalSpend: 100,
          },
        }),
        mockContext(testEnv),
      );

      expect(freezeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ lease }),
        expect.anything(),
      );
    });
  });

  describe("AccountCleanupFailure", () => {
    it("routes to InnovationSandbox.quarantineAccount with reasonForQuarantine=CLEANUP_FAILED", async () => {
      const quarantineSpy = vi
        .spyOn(InnovationSandbox, "quarantineAccount")
        .mockResolvedValue();

      await handler(
        sqsEvent(EventDetailTypes.AccountCleanupFailure, {
          accountId: "111111111111",
          cleanupExecutionContext: {
            executionArn: "arn:execution",
            executionStartTime: new Date().toISOString(),
          },
          reason: "LEASE_TERMINATION",
        }),
        mockContext(testEnv),
      );

      expect(quarantineSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "111111111111",
          currentOu: "CleanUp",
          reasonForQuarantine: "CLEANUP_FAILED",
        }),
        expect.anything(),
      );
    });
  });

  describe("AccountCleanupSuccessful", () => {
    function buildEvent(accountId = "111111111111") {
      return sqsEvent(EventDetailTypes.AccountCleanupSuccessful, {
        accountId,
        cleanupExecutionContext: {
          executionArn: "arn:execution",
          executionStartTime: new Date().toISOString(),
        },
        reason: "LEASE_TERMINATION",
      });
    }

    it("moves the account from CleanUp to Available and writes the Status tag as Available", async () => {
      const account = {
        awsAccountId: "111111111111",
        status: "CleanUp" as const,
      };
      vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockResolvedValue({
        result: account,
      });
      const moveSpy = vi
        .spyOn(SandboxOuService.prototype, "transactionalMoveAccount")
        .mockReturnValue({
          complete: vi.fn().mockResolvedValue(undefined),
        } as never);
      const updateStatusTagSpy = vi
        .spyOn(OrganizationsTaggingService.prototype, "updateStatusTag")
        .mockResolvedValue();

      await handler(buildEvent(), mockContext(testEnv));

      expect(moveSpy).toHaveBeenCalledWith(account, "CleanUp", "Available");
      expect(updateStatusTagSpy).toHaveBeenCalledWith(
        account.awsAccountId,
        "Available",
      );
    });

    it("does not block the lifecycle when updateStatusTag rejects", async () => {
      const account = {
        awsAccountId: "111111111111",
        status: "CleanUp" as const,
      };
      vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockResolvedValue({
        result: account,
      });
      vi.spyOn(
        SandboxOuService.prototype,
        "transactionalMoveAccount",
      ).mockReturnValue({
        complete: vi.fn().mockResolvedValue(undefined),
      } as never);
      vi.spyOn(
        OrganizationsTaggingService.prototype,
        "updateStatusTag",
      ).mockRejectedValue(new Error("AccessDenied"));

      // Should resolve without throwing — `.catch` swallows the failure.
      await expect(
        handler(buildEvent(), mockContext(testEnv)),
      ).resolves.toBeUndefined();
    });

    it("throws if the account is not in CleanUp status", async () => {
      vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockResolvedValue({
        result: { awsAccountId: "111111111111", status: "Available" },
      });
      await expect(handler(buildEvent(), mockContext(testEnv))).rejects.toThrow(
        /incorrectly raised for an account whose status is not CleanUp/,
      );
    });

    it("throws if the account record is not found", async () => {
      vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockResolvedValue({
        result: undefined,
      });
      await expect(handler(buildEvent(), mockContext(testEnv))).rejects.toThrow(
        /Sandbox account not found/,
      );
    });
  });
});
