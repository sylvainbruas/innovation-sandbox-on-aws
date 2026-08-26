// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { BlueprintWithStackSets } from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint.js";
import { PaginatedQueryResult } from "@amzn/innovation-sandbox-commons/data/common-types.js";
import { LeaseTemplateSchema } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import {
  MonitoredLease,
  MonitoredLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { PrincipalStore } from "@amzn/innovation-sandbox-commons/data/principal/principal-store.js";
import { PrincipalCacheItemSchema } from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import {
  SandboxAccount,
  SandboxAccountSchema,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { LeaseApprovedEvent } from "@amzn/innovation-sandbox-commons/events/lease-approved-event.js";
import { LeaseRequestedEvent } from "@amzn/innovation-sandbox-commons/events/lease-requested-event.js";
import { InnovationSandbox } from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import { IsbEventBridgeClient } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { mockGlobalConfig } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  mockedAccountStore,
  mockedBlueprintDeploymentService,
  mockedBlueprintStore,
  mockedIdcService,
  mockedLeaseStore,
  mockedLeaseTemplateStore,
  mockedOrganizationsTaggingService,
  mockedOrgsService,
} from "@amzn/innovation-sandbox-commons/test/mocking/common-mocks.js";
import { createMockOf } from "@amzn/innovation-sandbox-commons/test/mocking/mock-utils.js";
import {
  type IdcIdentity,
  IdcIdentitySchema,
  M2MIdentitySchema,
} from "@amzn/innovation-sandbox-commons/utils/auth-utils.js";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

function createMockContext() {
  const context = {
    isbEventBridgeClient: createMockOf(IsbEventBridgeClient),
    orgsService: mockedOrgsService(),
    organizationsTaggingService: mockedOrganizationsTaggingService(),
    idcService: mockedIdcService(),
    leaseStore: mockedLeaseStore(),
    principalStore: createMockOf(PrincipalStore),
    sandboxAccountStore: mockedAccountStore(),
    blueprintStore: mockedBlueprintStore(),
    blueprintDeploymentService: mockedBlueprintDeploymentService(),
    leaseTemplateStore: mockedLeaseTemplateStore(),
    globalConfig: mockGlobalConfig(),
    logger: new Logger(),
    tracer: new Tracer(),
  };

  context.globalConfig.leases.maxLeasesPerUser = 1;

  return context;
}

describe("InnovationSandbox.requestLease()", () => {
  let mockContext: ReturnType<typeof createMockContext>;
  let mockUser: IdcIdentity;

  beforeEach(() => {
    mockContext = createMockContext();
    mockUser = generateSchemaData(IdcIdentitySchema);

    mockContext.idcService.getUserFromEmail.mockImplementation(
      async (email) => {
        if (email === mockUser.email) {
          return mockUser;
        } else {
          throw new Error("Invalid ISB User.");
        }
      },
    );

    // Mock owner resolution used by triggerAssignmentProcessing
    mockContext.idcService.getCachedPrincipalByAttr.mockImplementation(
      async (_type, email) => {
        if (email === mockUser.email) {
          return {
            principalId: mockUser.userId,
            principalType: "USER" as const,
            displayName: mockUser.displayName,
            email: mockUser.email,
          };
        }
        return undefined;
      },
    );

    // Default: return a matching cache entry for every requested principal so
    // publishLease's enrichment doesn't hard-fail on zocker-generated random
    // desiredAssignments. Tests that care about specific cache behavior override.
    mockContext.principalStore.batchGetCacheItems.mockImplementation(
      async (keys) =>
        keys.map((k) =>
          generateSchemaData(PrincipalCacheItemSchema, {
            sk: `${k.principalType.toLowerCase()}#${k.principalId}`,
            principalId: k.principalId,
            principalType: k.principalType,
            displayName:
              k.principalId === mockUser.userId
                ? mockUser.displayName
                : `${k.principalType} ${k.principalId.slice(0, 8)}`,
            ...(k.principalType === "USER"
              ? {
                  email:
                    k.principalId === mockUser.userId
                      ? mockUser.email
                      : `${k.principalId.slice(0, 8)}@example.com`,
                }
              : {}),
          }),
        ),
    );

    mockContext.blueprintDeploymentService.validateBlueprintForDeployment.mockResolvedValue(
      {
        blueprint: {
          PK: "bp#b1c2d3e4-5678-90ab-cdef-blueprintabc",
          SK: "blueprint",
          itemType: "BLUEPRINT",
          blueprintId: "b1c2d3e4-5678-90ab-cdef-blueprintabc",
          name: "TestBlueprint",
          regionConcurrencyType: "SEQUENTIAL",
          deploymentTimeoutMinutes: 60,
          tags: {},
          createdBy: "test@example.com",
          totalHealthMetrics: {
            totalDeploymentCount: 0,
            totalSuccessfulCount: 0,
          },
          meta: {
            schemaVersion: 1,
            createdTime: "2024-01-01T00:00:00Z",
            lastEditTime: "2024-01-01T00:00:00Z",
          },
        },
        stackSets: [
          {
            PK: "bp#b1c2d3e4-5678-90ab-cdef-blueprintabc",
            SK: "stackset#a1b2c3d4-5678-90ab-cdef-123456789abc",
            itemType: "STACKSET",
            blueprintId: "b1c2d3e4-5678-90ab-cdef-blueprintabc",
            stackSetId: "a1b2c3d4-5678-90ab-cdef-123456789abc",
            administrationRoleArn: "arn:aws:iam::123456789012:role/admin",
            executionRoleName: "execution-role",
            regions: ["us-east-1"],
            deploymentOrder: 1,
            healthMetrics: {
              deploymentCount: 0,
              successfulDeploymentCount: 0,
              consecutiveFailures: 0,
            },
            meta: {
              schemaVersion: 1,
              createdTime: "2024-01-01T00:00:00Z",
              lastEditTime: "2024-01-01T00:00:00Z",
            },
          },
        ],
      } as BlueprintWithStackSets,
    );

    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ------------ Begin Tests ----------//
  test("HappyPath - Request lease requiring approval ", async () => {
    const result = await InnovationSandbox.requestLease(
      {
        leaseTemplate: generateSchemaData(LeaseTemplateSchema, {
          requiresApproval: true,
        }),
        targetUser: mockUser,
      },
      mockContext,
    );

    //test is ordering sensitive on event content
    expect(mockContext.isbEventBridgeClient.sendIsbEvent).toHaveBeenCalledWith(
      mockContext.tracer,
      new LeaseRequestedEvent({
        leaseId: {
          userEmail: mockUser.email,
          uuid: result.uuid,
        },
        requiresManualApproval: true,
        userEmail: mockUser.email,
      }),
    );
  });

  test("HappyPath - Request lease auto-approved", async () => {
    const mockAvailableAccount = generateSchemaData(SandboxAccountSchema, {
      status: "Available",
    });

    mockContext.sandboxAccountStore.findByStatus.mockResolvedValueOnce({
      result: [mockAvailableAccount],
    } as PaginatedQueryResult<SandboxAccount>);

    const result = await InnovationSandbox.requestLease(
      {
        leaseTemplate: generateSchemaData(LeaseTemplateSchema, {
          requiresApproval: false,
          blueprintId: null,
        }),
        targetUser: mockUser,
      },
      mockContext,
    );

    //approval event
    expect(mockContext.isbEventBridgeClient.sendIsbEvent).toHaveBeenCalledWith(
      mockContext.tracer,
      new LeaseApprovedEvent({
        leaseId: result.uuid,
        userEmail: mockUser.email,
        approvedBy: "AUTO_APPROVED",
      }),
    );
  });

  test("should reject lease request when user has a lease in Provisioning status", async () => {
    const provisioningLease = generateSchemaData(MonitoredLeaseSchema, {
      userEmail: mockUser.email,
      status: "Provisioning",
    });

    mockContext.leaseStore.findByUserEmail.mockResolvedValueOnce({
      result: [provisioningLease],
      nextPageIdentifier: null,
    });

    await expect(
      InnovationSandbox.requestLease(
        {
          leaseTemplate: generateSchemaData(LeaseTemplateSchema, {
            requiresApproval: true,
          }),
          targetUser: mockUser,
        },
        mockContext,
      ),
    ).rejects.toThrow("maximum number of active/pending leases");
  });

  // Lease Assignment Tests
  describe("Lease Assignment Flow", () => {
    const managerEmail = "manager@example.com";

    test("Lease assignment auto-approves regardless of template settings", async () => {
      const mockAvailableAccount = generateSchemaData(SandboxAccountSchema, {
        status: "Available",
      });

      mockContext.sandboxAccountStore.findByStatus.mockResolvedValueOnce({
        result: [mockAvailableAccount],
      } as PaginatedQueryResult<SandboxAccount>);

      const result = (await InnovationSandbox.requestLease(
        {
          leaseTemplate: generateSchemaData(LeaseTemplateSchema, {
            requiresApproval: true, // Should be auto-approved for assignments
            blueprintId: null,
          }),
          targetUser: mockUser,
          createdBy: managerEmail,
        },
        mockContext,
      )) as MonitoredLease;

      // Should be auto-approved
      expect(
        mockContext.isbEventBridgeClient.sendIsbEvent,
      ).toHaveBeenCalledWith(
        mockContext.tracer,
        new LeaseApprovedEvent({
          leaseId: result.uuid,
          userEmail: mockUser.email,
          approvedBy: "AUTO_APPROVED",
        }),
      );

      expect(result.status).toBe("Active");
      expect(result.createdBy).toBe(managerEmail);
      expect(result.userEmail).toBe(mockUser.email);
      expect(result.approvedBy).toBe("AUTO_APPROVED");
    });

    test("Lease assignment without createdBy defaults to targetUser", async () => {
      const result = await InnovationSandbox.requestLease(
        {
          leaseTemplate: generateSchemaData(LeaseTemplateSchema, {
            requiresApproval: true,
          }),
          targetUser: mockUser,
          // No createdBy provided
        },
        mockContext,
      );

      expect(result.createdBy).toBe(mockUser.email);
      expect(result.userEmail).toBe(mockUser.email);
      expect(result.status).toBe("PendingApproval");
    });
  });

  test("should reject lease request when targetUser is an M2M identity", async () => {
    const m2mUser = generateSchemaData(M2MIdentitySchema);

    await expect(
      InnovationSandbox.requestLease(
        {
          leaseTemplate: generateSchemaData(LeaseTemplateSchema, {
            requiresApproval: true,
          }),
          targetUser: m2mUser,
        },
        mockContext,
      ),
    ).rejects.toThrow("Target user must be an IDC user.");
  });

  describe("Pre-Approval Assignments", () => {
    test("should store desiredAssignments on lease enriched with displayName/email when assignments provided and template allows sharing", async () => {
      const assignments = [
        {
          principalId: "a1b2c3d4e5-550e8400-e29b-41d4-a716-446655440001",
          principalType: "USER" as const,
        },
        {
          principalId: "b2c3d4e5f6-660e8400-e29b-41d4-a716-446655440002",
          principalType: "GROUP" as const,
        },
      ];

      const result = await InnovationSandbox.requestLease(
        {
          leaseTemplate: generateSchemaData(LeaseTemplateSchema, {
            requiresApproval: true,
            allowOwnerToShareLease: true,
          }),
          targetUser: mockUser,
          assignments,
        },
        mockContext,
      );

      // Pre-approval assignments are enriched against the principal cache
      // before being stored, so the lease record carries displayName (and
      // email for USERs) rather than bare principal refs. The owner is always
      // included in desiredAssignments from creation time.
      expect(result.desiredAssignments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            principalId: assignments[0]!.principalId,
            principalType: "USER",
            displayName: expect.any(String),
            email: expect.any(String),
          }),
          expect.objectContaining({
            principalId: assignments[1]!.principalId,
            principalType: "GROUP",
            displayName: expect.any(String),
          }),
          expect.objectContaining({
            principalId: mockUser.userId,
            principalType: "USER",
            email: mockUser.email,
          }),
        ]),
      );
    });

    test("should always include owner in desiredAssignments even when no other assignments provided", async () => {
      const result = await InnovationSandbox.requestLease(
        {
          leaseTemplate: generateSchemaData(LeaseTemplateSchema, {
            requiresApproval: true,
            allowOwnerToShareLease: true,
          }),
          targetUser: mockUser,
        },
        mockContext,
      );

      expect(result.desiredAssignments).toEqual([
        expect.objectContaining({
          principalId: mockUser.userId,
          principalType: "USER",
          email: mockUser.email,
        }),
      ]);
    });

    test("should include owner even with empty assignments array", async () => {
      const result = await InnovationSandbox.requestLease(
        {
          leaseTemplate: generateSchemaData(LeaseTemplateSchema, {
            requiresApproval: true,
            allowOwnerToShareLease: true,
          }),
          targetUser: mockUser,
          assignments: [],
        },
        mockContext,
      );

      expect(result.desiredAssignments).toEqual([
        expect.objectContaining({
          principalId: mockUser.userId,
          principalType: "USER",
          email: mockUser.email,
        }),
      ]);
    });

    test("should denormalize allowOwnerToShareLease from template to lease", async () => {
      const result = await InnovationSandbox.requestLease(
        {
          leaseTemplate: generateSchemaData(LeaseTemplateSchema, {
            requiresApproval: true,
            allowOwnerToShareLease: true,
          }),
          targetUser: mockUser,
        },
        mockContext,
      );

      expect(result.allowOwnerToShareLease).toBe(true);
    });
  });
});
