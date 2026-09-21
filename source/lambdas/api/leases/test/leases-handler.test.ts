// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import {
  AccountNotFoundException,
  ConcurrentModificationException,
  TooManyRequestsException,
} from "@aws-sdk/client-organizations";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import { base64EncodeCompositeKey } from "@amzn/innovation-sandbox-commons/data/encoding.js";
import { ResourceLockConflictError } from "@amzn/innovation-sandbox-commons/data/errors.js";
import { GlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { DynamoLeaseTemplateStore } from "@amzn/innovation-sandbox-commons/data/lease-template/dynamo-lease-template-store.js";
import { PersistedLeaseTemplateSchema } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { DynamoLeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/dynamo-lease-store.js";
import {
  PersistedApprovalDeniedLeaseSchema,
  PersistedExpiredLeaseSchema,
  PersistedLease,
  PersistedLeaseSchema,
  PersistedMonitoredLeaseSchema,
  PersistedPendingLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { DynamoPrincipalStore } from "@amzn/innovation-sandbox-commons/data/principal/dynamo-principal-store.js";
import {
  PersistedGroupAssignmentSchema,
  PersistedPrincipalCacheItemSchema,
  PersistedUserAssignmentSchema,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import { ReportingConfig } from "@amzn/innovation-sandbox-commons/data/reporting-config/reporting-config.js";
import { DynamoSandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/dynamo-sandbox-account-store.js";
import { PersistedSandboxAccountSchema } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { LeaseTerminatedEvent } from "@amzn/innovation-sandbox-commons/events/lease-terminated-event.js";
import {
  AccountNotInActiveError,
  AccountNotInFrozenError,
  CouldNotFindAccountError,
  CouldNotRetrieveUserError,
  InnovationSandbox,
  NoAccountsAvailableError,
} from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import { IdcService } from "@amzn/innovation-sandbox-commons/isb-services/idc-service.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import * as leaseAssignment from "@amzn/innovation-sandbox-commons/isb-services/lease-assignment/index.js";
import { MaxAssignmentsExceededError } from "@amzn/innovation-sandbox-commons/isb-services/lease-assignment/index.js";
import { OrganizationsTaggingService } from "@amzn/innovation-sandbox-commons/isb-services/organizations-tagging-service.js";
import { SandboxOuService } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-ou-service.js";
import { LeaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-lambda-environment.js";
import { IsbEventBridgeClient } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  buildCognitoClaims,
  createAPIGatewayProxyEvent,
  createErrorResponseBody,
  createFailureResponseBody,
  isbAuthorizedUser,
  isbAuthorizedUserUserRoleOnly,
  jsendFailBodyLike,
  m2mAdminUser,
  m2mUserRoleOnlyUser,
  mockAuthorizedContext,
  mockGlobalConfig,
  rawBodyLike,
  responseHeaders,
  responseHeadersWithErrorType,
} from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  bulkStubEnv,
  mockAppConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import {
  datetimeAsString,
  now,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import {
  BudgetConfigSchema,
  DurationConfigSchema,
} from "@amzn/innovation-sandbox-shared/types/lease-template.js";
import {
  DesiredAssignmentSchema,
  LEASE_NOT_PENDING_REVIEW_ERROR,
  LeaseKeySchema,
} from "@amzn/innovation-sandbox-shared/types/lease.js";
import {
  buildM2mSyntheticEmail,
  IdcIdentitySchema,
  IsbUser,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";
import { randomUUID } from "crypto";
import { DateTime } from "luxon";

// acquireLock returns the persisted lock so callers can carry it onto a
// full-item put; mocks must resolve a lock rather than undefined.

// The generated restJson1 serializer projects each lease to its modeled shape:
// `meta.schemaVersion` is dropped (deviation #2), and members that are `null`
// (deviation #7 — e.g. blueprintId/blueprintName/approvedBy/awsAccountId) or
// `undefined` (unset optionals) are omitted from the body. All lease timestamps
// are raw `String` (deviation #3), emitted byte-faithfully. Expected success
// bodies are matched with `rawBodyLike` (order-insensitive, null/undefined
// dropped, timestamps NOT canonicalized) against this projection — note the
// matcher also drops null/undefined from the EXPECTED side, so it *tolerates*
// (does not pin) the deviation-#7 omission; the dedicated test below asserts it.
function projectLease(lease: Record<string, any>): Record<string, any> {
  // Drop `leaseTemplateUuid`: it is a request-only input field (the persisted
  // Lease exposes `originalLeaseTemplateUuid`), but the request-lease tests build
  // their stored-lease fixture from `PendingLeaseSchema.extend({ leaseTemplateUuid })`,
  // so it must be stripped here — the serializer only emits modeled members.
  const { meta, leaseTemplateUuid: _leaseTemplateUuid, ...rest } = lease;
  return {
    ...rest,
    ...(meta
      ? {
          meta: {
            createdTime: meta.createdTime,
            lastEditTime: meta.lastEditTime,
          },
        }
      : {}),
  };
}

const MOCK_ACQUIRED_LOCK = {
  ownerId: "mock-lock-owner",
  acquiredAt: "2024-06-01T12:00:00.000Z",
  expiresAt: "2024-06-01T12:15:00.000Z",
};

let mockedGlobalConfig: GlobalConfig;
let mockedReportingConfig: ReportingConfig;
const testEnv = generateSchemaData(LeaseLambdaEnvironmentSchema);
const testReportingConfig = {
  costReportGroups: ["valid-group-1", "valid-group-2"],
  requireCostReportGroup: false,
};
const testReportingConfigRequired = {
  costReportGroups: ["valid-group-1", "valid-group-2"],
  requireCostReportGroup: true,
};
let handler: typeof import("@amzn/innovation-sandbox-leases/leases-handler.js").handler;

beforeAll(async () => {
  bulkStubEnv(testEnv);
  handler = (await import("@amzn/innovation-sandbox-leases/leases-handler.js"))
    .handler;
});

beforeEach(() => {
  mockedGlobalConfig = mockGlobalConfig();
  mockedGlobalConfig.leases.maxLeasesPerUser = 3;
  mockedGlobalConfig.leases.maxBudget = 50;
  mockedGlobalConfig.leases.maxDurationHours = 999;
  mockedGlobalConfig.leases.requireMaxBudget = true;
  mockedGlobalConfig.leases.requireMaxDuration = false;
  mockedGlobalConfig.leases.leaseSharingEnabled = true;
  mockedGlobalConfig.leases.groupAssignmentMode = "ALL";
  mockedGlobalConfig.leases.allowUserLeaseTermination = true;
  mockedGlobalConfig.leases.leaseRequestWindowHours = 168;
  mockedGlobalConfig.leases.maxLeaseRequestsPerWindow = 10;
  mockedGlobalConfig.leases.ttl = 30;
  mockedGlobalConfig.maintenance.enabled = false;

  mockedReportingConfig = {
    costReportGroups: [],
    requireCostReportGroup: false,
  };

  bulkStubEnv(testEnv);
  mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

  // Default mock for principalStore.batchGetCacheItems — needed because
  // requestLease always enriches the owner's assignment at creation time.
  vi.spyOn(
    DynamoPrincipalStore.prototype,
    "batchGetCacheItems",
  ).mockImplementation(async (principalIds) =>
    principalIds.map((p) =>
      generateSchemaData(PersistedPrincipalCacheItemSchema, {
        principalId: p.principalId,
        principalType: p.principalType,
        email:
          p.principalType === "USER"
            ? `${p.principalId.slice(0, 8)}@example.com`
            : undefined,
      }),
    ),
  );
});

afterEach(() => {
  mockedGlobalConfig.leases.groupAssignmentMode = "ALL";
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("Leases Handler", async () => {
  it("should return 500 response when environment variables are misconfigured", async () => {
    vi.unstubAllEnvs();

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/leases",
    });
    expect(
      await handler(event, mockAuthorizedContext(testEnv, mockedGlobalConfig)),
    ).toEqual({
      statusCode: 500,
      body: createErrorResponseBody("An unexpected error occurred."),
      headers: responseHeadersWithErrorType("InternalServerError"),
    });
  });

  describe("GET /leases", () => {
    const allLeases: PersistedLease[] = [
      generateSchemaData(PersistedLeaseSchema),
      generateSchemaData(PersistedLeaseSchema),
    ];
    const allLeasesWithRefId = allLeases.map((lease) => {
      return {
        ...projectLease(lease),
        leaseId: base64EncodeCompositeKey({
          userEmail: lease.userEmail,
          uuid: lease.uuid,
        }),
      };
    });

    it("should return 200 with all leases", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        isbUser: isbAuthorizedUser.user,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "findAll").mockReturnValue(
        Promise.resolve({
          result: allLeases,
          nextPageIdentifier: null,
        }),
      );
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: {
            result: allLeasesWithRefId,
            nextPageIdentifier: null,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("drops null read-path members from the wire (deviation #7)", async () => {
      // `rawBodyLike` drops null/undefined on both sides, so it cannot pin the
      // deviation-#7 omission. Assert the raw body directly: a lease persisted with
      // null `blueprintId`/`blueprintName`/`approvedBy`/`awsAccountId` comes back
      // with those members ABSENT, not emitted as `null`.
      const leaseWithNulls = {
        ...generateSchemaData(PersistedLeaseSchema),
        blueprintId: null,
        blueprintName: null,
        approvedBy: null,
        awsAccountId: null,
      };
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        isbUser: isbAuthorizedUser.user,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "findAll").mockReturnValue(
        Promise.resolve({
          result: [leaseWithNulls as any],
          nextPageIdentifier: null,
        }),
      );

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );
      expect(response.statusCode).toBe(200);
      const wireLease = JSON.parse(response.body).data.result[0];
      for (const dropped of [
        "blueprintId",
        "blueprintName",
        "approvedBy",
        "awsAccountId",
      ]) {
        expect(wireLease).not.toHaveProperty(dropped);
      }
    });

    it("should return 200 with all leases even when error is set", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        isbUser: isbAuthorizedUser.user,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "findAll").mockReturnValue(
        Promise.resolve({
          result: allLeases,
          nextPageIdentifier: null,
          error: "Zod Validation Error",
        }),
      );
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: {
            result: allLeasesWithRefId,
            nextPageIdentifier: null,
            error: "Zod Validation Error",
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 200 with first page of leases when pagination query parameters are passed in", async () => {
      const pageIdentifier = "eyAidGVzdCI6ICJ0ZXN0IiB9";
      const maxResults = "2";

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        queryStringParameters: {
          pageIdentifier,
          maxResults,
        },
        isbUser: isbAuthorizedUser.user,
      });

      const findAllMethod = vi
        .spyOn(DynamoLeaseStore.prototype, "findAll")
        .mockReturnValue(
          Promise.resolve({
            result: allLeases,
            nextPageIdentifier: "BBB",
          }),
        );
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: {
            result: allLeasesWithRefId,
            nextPageIdentifier: "BBB",
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(findAllMethod.mock.calls).toHaveLength(1);
      expect(findAllMethod.mock.calls[0]).toEqual([
        {
          pageIdentifier,
          pageSize: Number(maxResults),
        },
      ]);
    });

    it.each([
      { userEmail: "test@example.com" },
      { userEmail: "test+subaddress@example.com" },
    ])(
      "should return 200 with leases belonging to the user provided",
      async ({ userEmail }) => {
        const urlencodedUserEmail = encodeURIComponent(userEmail);

        const leases = [
          generateSchemaData(PersistedLeaseSchema, { userEmail }),
          generateSchemaData(PersistedLeaseSchema, { userEmail }),
        ].map((lease) => ({
          ...lease,
          leaseId: base64EncodeCompositeKey({
            userEmail: lease.userEmail,
            uuid: lease.uuid,
          }),
        }));

        const event = createAPIGatewayProxyEvent({
          httpMethod: "GET",
          path: `/leases`,
          queryStringParameters: {
            userEmail: urlencodedUserEmail,
            pageIdentifier: "next-page",
            maxResults: "7",
          },
          isbUser: isbAuthorizedUser.user,
        });

        const findByUserEmailSpy = vi
          .spyOn(DynamoLeaseStore.prototype, "findByUserEmail")
          .mockReturnValue(
            Promise.resolve({
              result: leases,
              nextPageIdentifier: null,
            }),
          );

        expect(
          await handler(
            event,
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          ),
        ).toEqual({
          statusCode: 200,
          body: rawBodyLike({
            status: "success",
            data: {
              result: leases.map(projectLease),
              nextPageIdentifier: null,
            },
          }),
          headers: expect.objectContaining(responseHeaders),
        });
        expect(findByUserEmailSpy).toHaveBeenCalledWith({
          userEmail,
          pageIdentifier: "next-page",
          pageSize: 7,
        });
      },
    );

    it("should return 400 with first page when invalid query parameters are passed in", async () => {
      const pageIdentifier = "eyAidGVzdCI6ICJ0ZXN0IiB9";
      const maxResults = "NaN";

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        queryStringParameters: {
          pageIdentifier,
          maxResults,
        },
        isbUser: isbAuthorizedUser.user,
      });

      const findAllMethod = vi
        .spyOn(DynamoLeaseStore.prototype, "findAll")
        .mockReturnValue(
          Promise.resolve({
            result: allLeases,
            nextPageIdentifier: "BBB",
          }),
        );
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        // Accepted deviation (deviation #4): a malformed integer query param now
        // surfaces as the framework's SerializationException→400 (a generic
        // message) instead of the pre-Smithy Zod field error. Still a 400.
        body: createFailureResponseBody({
          message:
            "Invalid JSON in request body. Please check your JSON syntax.",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
      expect(findAllMethod.mock.calls).toHaveLength(0);
    });

    it("should return 500 when data store calls fails", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        isbUser: isbAuthorizedUser.user,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "findAll").mockImplementation(() => {
        throw new Error();
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeadersWithErrorType("InternalServerError"),
      });
    });

    it("should return 403 for findAllLeases when the user has only 'User' role", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 403,
        body: createFailureResponseBody({
          message: `User is not authorized to get all leases.`,
        }),
        headers: responseHeadersWithErrorType("AccessDeniedError"),
      });
    });

    it("should return 403 for findLeaseByEmail when the user has only 'User' role and emails don't match", async () => {
      const anotherEmail = `ANOTHER_${isbAuthorizedUserUserRoleOnly.user.email}`;
      const urlencodedUserEmail = encodeURIComponent(anotherEmail);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        queryStringParameters: {
          userEmail: urlencodedUserEmail,
        },
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 403,
        body: createFailureResponseBody({
          message: `User is not authorized to get the requested leases.`,
        }),
        headers: responseHeadersWithErrorType("AccessDeniedError"),
      });
    });

    it("should return 400 and not touch the store when userEmail is malformed", async () => {
      // `userEmail` is modeled as an open `OwnerEmail` String (no `@pattern`), so a
      // malformed address passes model validation and reaches the operation, which
      // re-validates it with `z.email()` and 400s BEFORE any authorization or store
      // access — restoring the pre-Smithy `GetLeasesQueryParametersSchema`'s
      // `z.email().optional()` behavior.
      const findByUserEmailSpy = vi.spyOn(
        DynamoLeaseStore.prototype,
        "findByUserEmail",
      );
      const findAllSpy = vi.spyOn(DynamoLeaseStore.prototype, "findAll");

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        queryStringParameters: { userEmail: "not-an-email" },
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: jsendFailBodyLike({
          field: "input",
          message: "Invalid email address",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
      expect(findByUserEmailSpy).not.toHaveBeenCalled();
      expect(findAllSpy).not.toHaveBeenCalled();
    });

    it("should default pageSize to 2000 (findAll) when maxResults is omitted", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        isbUser: isbAuthorizedUser.user,
      });
      const findAllSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "findAll")
        .mockResolvedValue({ result: allLeases, nextPageIdentifier: null });

      await handler(event, mockAuthorizedContext(testEnv, mockedGlobalConfig));

      expect(findAllSpy).toHaveBeenCalledWith({
        pageIdentifier: undefined,
        pageSize: 2000,
      });
    });

    it("should default pageSize to 2000 (findByUserEmail) when maxResults is omitted", async () => {
      const userEmail = "test@example.com";
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases",
        queryStringParameters: { userEmail: encodeURIComponent(userEmail) },
        isbUser: isbAuthorizedUser.user,
      });
      const findByUserEmailSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "findByUserEmail")
        .mockResolvedValue({ result: [], nextPageIdentifier: null });

      await handler(event, mockAuthorizedContext(testEnv, mockedGlobalConfig));

      expect(findByUserEmailSpy).toHaveBeenCalledWith({
        userEmail,
        pageIdentifier: undefined,
        pageSize: 2000,
      });
    });
  });

  describe("POST /leases", () => {
    it("should return 400 when no body in the request", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        // Accepted deviation: with no body the model rejects the required
        // leaseTemplateUuid (generated ValidationError, alphabetized envelope)
        // rather than the pre-Smithy "Body not provided." message.
        body: jsendFailBodyLike({
          field: "leaseTemplateUuid",
          message:
            "Value at '/leaseTemplateUuid' failed to satisfy constraint: Member must not be null",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it("should return 400 when the body is malformed json string", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: "just string",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message:
            "Invalid JSON in request body. Please check your JSON syntax.",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it("should return 400 when the body is not a valid lease object", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify({
          abc: "ABC",
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        // Accepted deviation: model validation runs before the operation's strict
        // Zod re-parse, so the required-field violation (leaseTemplateUuid) is
        // reported by the generated ValidationError and short-circuits before the
        // unknown-key ("abc") check runs — a single error now, alphabetized envelope.
        body: jsendFailBodyLike({
          field: "leaseTemplateUuid",
          message:
            "Value at '/leaseTemplateUuid' failed to satisfy constraint: Member must not be null",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it("should return 400 when the body carries an unknown key (guards InputLeaseSchema.strict())", async () => {
      // A well-formed request (valid `leaseTemplateUuid`) PLUS an unknown key. The
      // model passes (required field present; the restJson1 deserializer silently
      // drops the unknown member), so the 400 can only come from the operation's
      // `.strict()` Zod re-parse of the raw body. The "not a valid lease object"
      // test above short-circuits on the missing-required-field MODEL error and
      // never reaches this check — this is the dedicated unknown-key guard.
      const findByUserEmailSpy = vi.spyOn(
        DynamoLeaseStore.prototype,
        "findByUserEmail",
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify({
          leaseTemplateUuid: "123e4567-e89b-42d3-a456-556642440000",
          unknownKey: "x",
        }),
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: jsendFailBodyLike({
          field: "input",
          message: 'Unrecognized key: "unknownKey"',
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
      expect(findByUserEmailSpy).not.toHaveBeenCalled();
    });

    it("should return 409 when user has exceeded the max number of active leases allowed", async () => {
      const leaseRequest = generateSchemaData(
        PersistedPendingLeaseSchema.pick({
          comments: true,
        })
          .extend({ leaseTemplateUuid: z.uuid() })
          .strict(),
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify(leaseRequest),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      const storedLease = generateSchemaData(PersistedPendingLeaseSchema, {
        ...leaseRequest,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "update").mockReturnValue(
        Promise.resolve({
          newItem: storedLease,
          oldItem: undefined,
        }),
      );
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: generateSchemaData(PersistedLeaseTemplateSchema, {
            requiresApproval: true,
          }),
        }),
      );
      // mockedGlobalConfig defines max active leases as 3
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockReturnValue(
        Promise.resolve({
          result: [
            generateSchemaData(PersistedMonitoredLeaseSchema, {
              userEmail: isbAuthorizedUser.user.email,
              status: "Active",
              approvedBy: "AUTO_APPROVED",
            }),
            generateSchemaData(PersistedPendingLeaseSchema, {
              userEmail: isbAuthorizedUser.user.email,
              status: "PendingApproval",
            }),
            generateSchemaData(PersistedMonitoredLeaseSchema, {
              userEmail: isbAuthorizedUser.user.email,
              status: "Frozen",
              approvedBy: "AUTO_APPROVED",
            }),
          ],
          nextPageIdentifier: null,
        }),
      );
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message:
            "You have reached the maximum number of active/pending leases allowed (3).",
        }),
        headers: responseHeadersWithErrorType("ConflictError"),
      });
    });

    it("should return 404 when the lease template reference doesn't exist", async () => {
      const leaseRequest = generateSchemaData(
        PersistedPendingLeaseSchema.pick({
          comments: true,
        })
          .extend({ leaseTemplateUuid: z.uuid() })
          .strict(),
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify(leaseRequest),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: undefined,
        }),
      );
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: "Lease template not found.",
        }),
        headers: responseHeaders,
      });
    });

    it("should return 409 for when no accounts are available to lease", async () => {
      const leaseRequest = generateSchemaData(
        PersistedPendingLeaseSchema.pick({
          comments: true,
        })
          .extend({ leaseTemplateUuid: z.uuid() })
          .strict(),
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify(leaseRequest),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      const storedLease = generateSchemaData(PersistedPendingLeaseSchema, {
        ...leaseRequest,
      });
      // mockedGlobalConfig defines max active leases as 3
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockReturnValue(
        Promise.resolve({
          result: [
            generateSchemaData(PersistedMonitoredLeaseSchema, {
              userEmail: isbAuthorizedUser.user.email,
              status: "Active",
              approvedBy: "AUTO_APPROVED",
            }),
          ],
          nextPageIdentifier: null,
        }),
      );
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: generateSchemaData(PersistedLeaseTemplateSchema, {
            requiresApproval: false,
          }),
        }),
      );
      vi.spyOn(DynamoLeaseStore.prototype, "create").mockReturnValue(
        Promise.resolve(storedLease),
      );
      vi.spyOn(DynamoLeaseStore.prototype, "delete").mockResolvedValue({});
      vi.spyOn(InnovationSandbox, "approveLease").mockImplementation(() => {
        throw new NoAccountsAvailableError();
      });
      vi.spyOn(
        IsbEventBridgeClient.prototype,
        "sendIsbEvents",
      ).mockResolvedValue({} as any);

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message: "No accounts are available to lease.",
        }),
        headers: responseHeadersWithErrorType("ConflictError"),
      });
    });

    it("should return 201 for manual approval lease request with valid inputs", async () => {
      const leaseRequest = generateSchemaData(
        PersistedPendingLeaseSchema.pick({
          comments: true,
        })
          .extend({ leaseTemplateUuid: z.uuid() })
          .strict(),
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify(leaseRequest),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      const storedLease = generateSchemaData(PersistedPendingLeaseSchema, {
        ...leaseRequest,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "create").mockResolvedValue(
        storedLease,
      );
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: generateSchemaData(PersistedLeaseTemplateSchema, {
            requiresApproval: true,
          }),
        }),
      );
      vi.spyOn(
        IsbEventBridgeClient.prototype,
        "sendIsbEvent",
      ).mockResolvedValue({} as any);
      // mockedGlobalConfig defines max active leases as 3
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockReturnValue(
        Promise.resolve({
          result: [
            generateSchemaData(PersistedMonitoredLeaseSchema, {
              userEmail: isbAuthorizedUser.user.email,
              status: "Active",
              approvedBy: "AUTO_APPROVED",
            }),
          ],
          nextPageIdentifier: null,
        }),
      );
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 201,
        body: rawBodyLike({
          status: "success",
          data: projectLease(storedLease),
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 409 when org api throws AccountNotFoundException", async () => {
      const leaseRequest = generateSchemaData(
        PersistedPendingLeaseSchema.pick({
          comments: true,
        })
          .extend({ leaseTemplateUuid: z.uuid() })
          .strict(),
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify(leaseRequest),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      const storedLease = generateSchemaData(PersistedPendingLeaseSchema, {
        ...leaseRequest,
      });
      // mockedGlobalConfig defines max active leases as 3
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockReturnValue(
        Promise.resolve({
          result: [
            generateSchemaData(PersistedMonitoredLeaseSchema, {
              userEmail: isbAuthorizedUser.user.email,
              status: "Active",
              approvedBy: "AUTO_APPROVED",
            }),
          ],
          nextPageIdentifier: null,
        }),
      );
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: generateSchemaData(PersistedLeaseTemplateSchema, {
            requiresApproval: false,
          }),
        }),
      );
      vi.spyOn(DynamoLeaseStore.prototype, "update").mockReturnValue(
        Promise.resolve({
          newItem: storedLease,
          oldItem: undefined,
        }),
      );

      vi.spyOn(InnovationSandbox, "approveLease").mockRejectedValue(
        new AccountNotFoundException({
          message: "mock exception",
          $metadata: {},
        }),
      );
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message:
            "The account could not be found where it was expected to be located. Someone else may have recently moved it.",
        }),
        headers: responseHeadersWithErrorType("ConflictError"),
      });
    });

    it("should return 409 when org api throws ConcurrentModificationException", async () => {
      const leaseRequest = generateSchemaData(
        PersistedPendingLeaseSchema.pick({
          comments: true,
        })
          .extend({ leaseTemplateUuid: z.uuid() })
          .strict(),
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify(leaseRequest),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      const storedLease = generateSchemaData(PersistedPendingLeaseSchema, {
        ...leaseRequest,
      });
      // mockedGlobalConfig defines max active leases as 3
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockReturnValue(
        Promise.resolve({
          result: [
            generateSchemaData(PersistedMonitoredLeaseSchema, {
              userEmail: isbAuthorizedUser.user.email,
              status: "Active",
              approvedBy: "AUTO_APPROVED",
            }),
          ],
          nextPageIdentifier: null,
        }),
      );
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: generateSchemaData(PersistedLeaseTemplateSchema, {
            requiresApproval: false,
          }),
        }),
      );
      vi.spyOn(DynamoLeaseStore.prototype, "update").mockReturnValue(
        Promise.resolve({
          newItem: storedLease,
          oldItem: undefined,
        }),
      );

      vi.spyOn(InnovationSandbox, "approveLease").mockRejectedValue(
        new ConcurrentModificationException({
          message: "mock exception",
          $metadata: {},
        }),
      );
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message:
            "Could not move account due to concurrent modification of the organization. Please try again.",
        }),
        headers: responseHeadersWithErrorType("ConflictError"),
      });
    });

    it("should return 429 when org api throws TooManyRequestsException", async () => {
      const leaseRequest = generateSchemaData(
        PersistedPendingLeaseSchema.pick({
          comments: true,
        })
          .extend({ leaseTemplateUuid: z.uuid() })
          .strict(),
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify(leaseRequest),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      const storedLease = generateSchemaData(PersistedPendingLeaseSchema, {
        ...leaseRequest,
      });
      // mockedGlobalConfig defines max active leases as 3
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockReturnValue(
        Promise.resolve({
          result: [
            generateSchemaData(PersistedMonitoredLeaseSchema, {
              userEmail: isbAuthorizedUser.user.email,
              status: "Active",
              approvedBy: "AUTO_APPROVED",
            }),
          ],
          nextPageIdentifier: null,
        }),
      );
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: generateSchemaData(PersistedLeaseTemplateSchema, {
            requiresApproval: false,
          }),
        }),
      );
      vi.spyOn(DynamoLeaseStore.prototype, "update").mockReturnValue(
        Promise.resolve({
          newItem: storedLease,
          oldItem: undefined,
        }),
      );

      vi.spyOn(InnovationSandbox, "approveLease").mockRejectedValue(
        new TooManyRequestsException({
          message: "mock exception",
          $metadata: {},
        }),
      );
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 429,
        body: createFailureResponseBody({
          message:
            "Could not move account due to too many requests. Please try again momentarily.",
        }),
        headers: responseHeaders,
      });
    });

    it("should return 201 for auto approval lease request with valid inputs", async () => {
      const leaseRequest = generateSchemaData(
        PersistedPendingLeaseSchema.pick({
          comments: true,
        })
          .extend({ leaseTemplateUuid: z.uuid() })
          .strict(),
      );
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify(leaseRequest),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      const storedLease = generateSchemaData(PersistedPendingLeaseSchema, {
        ...leaseRequest,
      });
      // mockedGlobalConfig defines max active leases as 3
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockReturnValue(
        Promise.resolve({
          result: [
            generateSchemaData(PersistedMonitoredLeaseSchema, {
              userEmail: isbAuthorizedUser.user.email,
              status: "Active",
              approvedBy: "AUTO_APPROVED",
            }),
          ],
          nextPageIdentifier: null,
        }),
      );
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: generateSchemaData(PersistedLeaseTemplateSchema, {
            requiresApproval: false,
          }),
        }),
      );
      vi.spyOn(DynamoLeaseStore.prototype, "create").mockReturnValue(
        Promise.resolve(storedLease),
      );
      const approvedLease: PersistedLease = {
        ...storedLease,
        approvedBy: "AUTO_APPROVED",
        status: "Active",
        awsAccountId: "000000000000",
        startDate: now().toISO(),
        expirationDate: now().plus({ hour: 24 }).toISO(),
        lastCheckedDate: now().toISO(),
        totalCostAccrued: 0,
      };
      vi.spyOn(InnovationSandbox, "approveLease").mockReturnValue(
        Promise.resolve({
          newItem: approvedLease,
          oldItem: storedLease,
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 201,
        body: rawBodyLike({
          status: "success",
          data: projectLease(approvedLease),
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    describe("Lease Assignment Flow", () => {
      const targetUserEmail = "target.user@example.com";
      const targetUser = generateSchemaData(IdcIdentitySchema, {
        email: targetUserEmail,
      });

      it("should return 201 when admin creates lease for another user", async () => {
        const leaseRequest = {
          leaseTemplateUuid: randomUUID(),
          userEmail: targetUserEmail,
          comments: "Lease assigned for training",
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify(leaseRequest),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        const leaseTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
          uuid: leaseRequest.leaseTemplateUuid,
          requiresApproval: true,
          visibility: "PRIVATE",
        });

        const resultLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
          userEmail: targetUserEmail,
          createdBy: isbAuthorizedUser.user.email,
          comments: leaseRequest.comments,
          status: "Active",
          approvedBy: isbAuthorizedUser.user.email,
        });

        // Mock template retrieval
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
          Promise.resolve({
            result: leaseTemplate,
          }),
        );

        // Mock user lookup in IDC
        vi.spyOn(IsbServices, "idcService").mockReturnValue({
          getUserFromEmail: vi.fn().mockResolvedValue(targetUser),
        } as any);

        // Mock the requestLease call
        const requestLeaseSpy = vi
          .spyOn(InnovationSandbox, "requestLease")
          .mockResolvedValue(resultLease);

        const response = await handler(event, mockAuthorizedContext(testEnv));

        expect(response).toEqual({
          statusCode: 201,
          body: rawBodyLike({
            status: "success",
            data: projectLease(resultLease),
          }),
          headers: expect.objectContaining(responseHeaders),
        });

        expect(requestLeaseSpy).toHaveBeenCalledWith(
          {
            leaseTemplate,
            targetUser,
            createdBy: isbAuthorizedUser.user.email,
            comments: leaseRequest.comments,
          },
          expect.any(Object),
        );
      });

      it("should return 403 when user role tries to create lease for another user", async () => {
        const leaseRequest = {
          leaseTemplateUuid: randomUUID(),
          userEmail: targetUserEmail,
          comments: "Should be denied",
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify(leaseRequest),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUserUserRoleOnly.user, // Not authorized
        });

        // Mock template retrieval
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
          Promise.resolve({
            result: generateSchemaData(PersistedLeaseTemplateSchema, {
              visibility: "PUBLIC",
            }),
          }),
        );

        // Spy on requestLease
        const requestLeaseSpy = vi.spyOn(InnovationSandbox, "requestLease");

        const response = await handler(event, mockAuthorizedContext(testEnv));

        expect(response).toEqual({
          statusCode: 403,
          body: createFailureResponseBody({
            message:
              "Access denied. You do not have permission to create leases for other users.",
          }),
          headers: responseHeadersWithErrorType("AccessDeniedError"),
        });

        expect(requestLeaseSpy).not.toHaveBeenCalled();
      });

      it("should return 404 when target user does not exist in Identity Center", async () => {
        const leaseRequest = {
          leaseTemplateUuid: randomUUID(),
          userEmail: "nonexistent@example.com",
          comments: "User does not exist",
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify(leaseRequest),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        // Mock template retrieval
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
          Promise.resolve({
            result: generateSchemaData(PersistedLeaseTemplateSchema, {
              visibility: "PUBLIC",
            }),
          }),
        );

        // Mock user lookup failure in IDC
        vi.spyOn(IsbServices, "idcService").mockReturnValue({
          getUserFromEmail: vi.fn().mockResolvedValue(null),
        } as any);

        // Spy on requestLease call
        const requestLeaseSpy = vi.spyOn(InnovationSandbox, "requestLease");

        const response = await handler(event, mockAuthorizedContext(testEnv));

        expect(response).toEqual({
          statusCode: 404,
          body: createFailureResponseBody({
            message: `User not found in Identity Center`,
          }),
          headers: responseHeaders,
        });

        expect(requestLeaseSpy).not.toHaveBeenCalled();
      });

      it("should return 404 when user role tries to access private lease template", async () => {
        const leaseRequest = {
          leaseTemplateUuid: randomUUID(),
          comments: "Should be denied - private template",
        };

        const userOnlyContext = {
          ...mockAuthorizedContext(testEnv),
          user: isbAuthorizedUserUserRoleOnly.user,
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify(leaseRequest),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUserUserRoleOnly.user,
        });

        // Mock private template retrieval
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
          Promise.resolve({
            result: generateSchemaData(PersistedLeaseTemplateSchema, {
              visibility: "PRIVATE",
            }),
          }),
        );

        const requestLeaseSpy = vi.spyOn(InnovationSandbox, "requestLease");

        const response = await handler(event, userOnlyContext);

        expect(response).toEqual({
          statusCode: 404,
          body: createFailureResponseBody({
            message: "Lease template not found.",
          }),
          headers: responseHeaders,
        });

        // Spy on requestLease call
        expect(requestLeaseSpy).not.toHaveBeenCalled();
      });

      it("should return 201 and allow manager to access private lease template for self", async () => {
        const leaseRequest = {
          leaseTemplateUuid: randomUUID(),
          comments: "Manager accessing private template",
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify(leaseRequest),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        const leaseTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
          visibility: "PRIVATE",
          requiresApproval: true,
        });

        const resultLease = generateSchemaData(PersistedPendingLeaseSchema, {
          userEmail: isbAuthorizedUser.user.email,
          createdBy: isbAuthorizedUser.user.email,
          comments: leaseRequest.comments,
        });

        // Mock private template retrieval
        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
          Promise.resolve({
            result: leaseTemplate,
          }),
        );

        // Mock the requestLease call
        const requestLeaseSpy = vi
          .spyOn(InnovationSandbox, "requestLease")
          .mockResolvedValue(resultLease);

        const response = await handler(event, mockAuthorizedContext(testEnv));

        expect(response.statusCode).toBe(201);
        expect(JSON.parse(response.body).status).toBe("success");

        expect(requestLeaseSpy).toHaveBeenCalledWith(
          {
            leaseTemplate,
            targetUser: expect.objectContaining({
              email: isbAuthorizedUser.user.email,
              type: "user",
            }),
            comments: leaseRequest.comments,
          },
          expect.any(Object),
        );
      });

      it("should not set createdBy when a user requests a lease with their own email (no auto-approval bypass)", async () => {
        const selfEmail = isbAuthorizedUserUserRoleOnly.user.email;
        const leaseRequest = {
          leaseTemplateUuid: randomUUID(),
          userEmail: selfEmail,
          comments: "Self request with own email",
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify(leaseRequest),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUserUserRoleOnly.user,
        });

        const leaseTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
          uuid: leaseRequest.leaseTemplateUuid,
          requiresApproval: true,
          visibility: "PUBLIC",
        });

        const resultLease = generateSchemaData(PersistedPendingLeaseSchema, {
          userEmail: selfEmail,
          comments: leaseRequest.comments,
        });

        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
          Promise.resolve({
            result: leaseTemplate,
          }),
        );

        // A plain User is subject to the rate limiter, which reads existing
        // leases; return none so the request proceeds to requestLease.
        vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockReturnValue(
          Promise.resolve({
            result: [],
            nextPageIdentifier: null,
          }),
        );

        const requestLeaseSpy = vi
          .spyOn(InnovationSandbox, "requestLease")
          .mockResolvedValue(resultLease);

        const response = await handler(event, mockAuthorizedContext(testEnv));

        expect(response.statusCode).toBe(201);
        // A self-referential userEmail must NOT be treated as a cross-user
        // assignment: createdBy stays undefined so requestLease honors the
        // template's requiresApproval flag instead of auto-approving.
        expect(requestLeaseSpy).toHaveBeenCalledTimes(1);
        const requestLeaseArg = requestLeaseSpy.mock.calls[0]![0];
        expect(requestLeaseArg.createdBy).toBeUndefined();
      });
    });

    describe("Pre-Approval Assignments", () => {
      it("should return 201 and pass assignments to requestLease", async () => {
        const assignments = [
          {
            principalId: generateSchemaData(DesiredAssignmentSchema)
              .principalId,
            principalType: "USER" as const,
          },
          {
            principalId: generateSchemaData(DesiredAssignmentSchema)
              .principalId,
            principalType: "GROUP" as const,
          },
        ];
        const leaseRequest = {
          leaseTemplateUuid: randomUUID(),
          comments: "Lease with pre-approval assignments",
          assignments,
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify(leaseRequest),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        const leaseTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
          uuid: leaseRequest.leaseTemplateUuid,
          requiresApproval: true,
          allowOwnerToShareLease: true,
        });

        const resultLease = generateSchemaData(PersistedPendingLeaseSchema, {
          userEmail: isbAuthorizedUser.user.email,
          comments: leaseRequest.comments,
        });

        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: leaseTemplate,
        });

        const requestLeaseSpy = vi
          .spyOn(InnovationSandbox, "requestLease")
          .mockResolvedValue(resultLease);

        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(201);
        const body = JSON.parse(response.body);
        expect(body.status).toBe("success");

        expect(requestLeaseSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            leaseTemplate,
            assignments,
            comments: leaseRequest.comments,
          }),
          expect.any(Object),
        );
      });

      it("should return 201 without assignments when none provided", async () => {
        const leaseRequest = {
          leaseTemplateUuid: randomUUID(),
          comments: "Regular lease without assignments",
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify(leaseRequest),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        const leaseTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
          uuid: leaseRequest.leaseTemplateUuid,
          requiresApproval: true,
        });

        const resultLease = generateSchemaData(PersistedPendingLeaseSchema, {
          userEmail: isbAuthorizedUser.user.email,
          comments: leaseRequest.comments,
        });

        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: leaseTemplate,
        });

        const requestLeaseSpy = vi
          .spyOn(InnovationSandbox, "requestLease")
          .mockResolvedValue(resultLease);

        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(201);
        const body = JSON.parse(response.body);
        expect(body.status).toBe("success");
        expect(body.data).toBeDefined();

        expect(requestLeaseSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            leaseTemplate,
            assignments: undefined,
            comments: leaseRequest.comments,
          }),
          expect.any(Object),
        );
      });

      it("should return 400 when assignments exceed the sharing limit", async () => {
        const assignments = Array.from({ length: 20 }, (_, i) => ({
          principalId: `a1b2c3d4e5-${String(i).padStart(8, "0")}-e29b-41d4-a716-446655440000`,
          principalType: "USER" as const,
        }));
        const leaseRequest = {
          leaseTemplateUuid: randomUUID(),
          assignments,
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify(leaseRequest),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].message).toContain("19");
      });

      it("should return 201 when assignments array has exactly 19 items", async () => {
        const assignments = Array.from({ length: 19 }, () => ({
          principalId: generateSchemaData(DesiredAssignmentSchema).principalId,
          principalType: "USER" as const,
        }));
        const leaseRequest = {
          leaseTemplateUuid: randomUUID(),
          assignments,
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify(leaseRequest),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        });

        const leaseTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
          uuid: leaseRequest.leaseTemplateUuid,
          allowOwnerToShareLease: true,
        });

        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: leaseTemplate,
        });

        vi.spyOn(InnovationSandbox, "requestLease").mockResolvedValue(
          generateSchemaData(PersistedPendingLeaseSchema),
        );

        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(201);
      });

      it("should return 400 when assignments contain duplicates", async () => {
        const duplicateId = "a1b2c3d4e5-550e8400-e29b-41d4-a716-446655440001";
        const assignments = [
          { principalId: duplicateId, principalType: "USER" as const },
          { principalId: duplicateId, principalType: "USER" as const },
        ];
        const leaseRequest = {
          leaseTemplateUuid: randomUUID(),
          assignments,
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify(leaseRequest),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].message).toContain("principal");
      });

      it("should reject group assignments for every role when groups are disabled", async () => {
        mockedGlobalConfig.leases.groupAssignmentMode = "NONE";
        mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

        const groupAssignment = generateSchemaData(DesiredAssignmentSchema, {
          principalType: "GROUP",
        });
        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify({
            leaseTemplateUuid: randomUUID(),
            assignments: [groupAssignment],
          }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        });

        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].message).toContain(
          "New group assignments are not enabled",
        );
      });

      it("should return 400 when user provides assignments but leaseSharingEnabled is false", async () => {
        const disabledConfig = {
          ...mockedGlobalConfig,
          leases: { ...mockedGlobalConfig.leases, leaseSharingEnabled: false },
        };
        mockAppConfigMiddleware(disabledConfig, mockedReportingConfig);

        const leaseTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
          uuid: randomUUID(),
          allowOwnerToShareLease: true,
          visibility: "PUBLIC",
        });

        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: leaseTemplate,
        });

        const assignments = [
          {
            principalId: generateSchemaData(DesiredAssignmentSchema)
              .principalId,
            principalType: "USER" as const,
          },
        ];

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify({
            leaseTemplateUuid: leaseTemplate.uuid,
            assignments,
          }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUserUserRoleOnly.user,
        });

        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, disabledConfig),
        );

        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].message).toContain("sharing is not enabled");
      });

      it("should return 201 when leaseSharingEnabled is false and no assignments provided", async () => {
        const disabledConfig = {
          ...mockedGlobalConfig,
          leases: { ...mockedGlobalConfig.leases, leaseSharingEnabled: false },
        };
        mockAppConfigMiddleware(disabledConfig, mockedReportingConfig);

        const leaseTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
          uuid: randomUUID(),
          requiresApproval: true,
        });

        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: leaseTemplate,
        });

        vi.spyOn(InnovationSandbox, "requestLease").mockResolvedValue(
          generateSchemaData(PersistedPendingLeaseSchema),
        );

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify({ leaseTemplateUuid: leaseTemplate.uuid }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        });

        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, disabledConfig),
        );

        expect(response.statusCode).toBe(201);
      });

      it("should return 403 when a regular user provides assignments for a template with allowOwnerToShareLease false", async () => {
        const userOnlyContext = {
          ...mockAuthorizedContext(testEnv),
          user: isbAuthorizedUserUserRoleOnly.user,
        };

        const assignments = [
          {
            principalId: generateSchemaData(DesiredAssignmentSchema)
              .principalId,
            principalType: "USER" as const,
          },
        ];

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify({
            leaseTemplateUuid: randomUUID(),
            assignments,
          }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUserUserRoleOnly.user,
        });

        const leaseTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
          visibility: "PUBLIC",
          allowOwnerToShareLease: false,
        });

        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: leaseTemplate,
        });

        // A plain User is subject to the rate limiter, which reads existing
        // leases; return none so the request reaches the sharing gate.
        vi.spyOn(
          DynamoLeaseStore.prototype,
          "findByUserEmail",
        ).mockResolvedValue({
          result: [],
          nextPageIdentifier: null,
        });

        const requestLeaseSpy = vi.spyOn(InnovationSandbox, "requestLease");

        const response = await handler(event, userOnlyContext);

        expect(response.statusCode).toBe(403);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].message).toContain(
          "Owner sharing is not enabled",
        );
        expect(requestLeaseSpy).not.toHaveBeenCalled();
      });

      it("should return 201 when an Admin/Manager provides assignments even if allowOwnerToShareLease is false", async () => {
        const assignments = [
          {
            principalId: generateSchemaData(DesiredAssignmentSchema)
              .principalId,
            principalType: "USER" as const,
          },
        ];

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify({
            leaseTemplateUuid: randomUUID(),
            assignments,
          }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        });

        const leaseTemplate = generateSchemaData(PersistedLeaseTemplateSchema, {
          allowOwnerToShareLease: false,
        });

        vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockResolvedValue({
          result: leaseTemplate,
        });

        const requestLeaseSpy = vi
          .spyOn(InnovationSandbox, "requestLease")
          .mockResolvedValue(generateSchemaData(PersistedPendingLeaseSchema));

        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(201);
        expect(requestLeaseSpy).toHaveBeenCalledWith(
          expect.objectContaining({ assignments }),
          expect.any(Object),
        );
      });
    });
  });

  describe("GET /leases/{leaseId}", () => {
    it("should return 400 when leaseId contains characters outside the base64url alphabet", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases/not*a*valid*id",
        isbUser: isbAuthorizedUser.user,
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        // Accepted deviation: the leaseId `@pattern` violation is now rendered by
        // the generated ValidationError (framework message, alphabetized envelope)
        // rather than the pre-Smithy Zod regex message.
        body: jsendFailBodyLike({
          field: "leaseId",
          message:
            "Value at '/leaseId' failed to satisfy constraint: Member must satisfy regular expression pattern: ^[A-Za-z0-9_-]+$",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it("should return 400 when leaseId is alphabet-valid but not a decodable composite key", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases/INVALID_LEASE_ID",
        isbUser: isbAuthorizedUser.user,
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message: "LeaseId path parameter provided is invalid.",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it("should return 404 when lease does not exist", async () => {
      const leaseKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        isbUser: isbAuthorizedUser.user,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: undefined,
        }), // record does not exist
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: `Lease not found.`,
        }),
        headers: responseHeaders,
      });
    });

    it("should return 403 (not 404) for a non-existent lease when caller is a 'User'", async () => {
      // Existence oracle guard: a non-admin/manager caller must not be able to
      // distinguish a missing lease (404) from an existing-but-inaccessible one
      // (403) via the status code. Both collapse to 403 for non-elevated users.
      const leaseKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: undefined,
        }), // record does not exist
      );

      const userOnlyContext = {
        ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
        user: isbAuthorizedUserUserRoleOnly.user,
      };

      const response = await handler(event, userOnlyContext);

      expect(response.statusCode).toBe(403);
    });

    it("should return 200 with lease", async () => {
      const leaseKey = generateSchemaData(LeaseKeySchema);
      const lease = generateSchemaData(PersistedLeaseSchema, { ...leaseKey });
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: lease,
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: { ...projectLease(lease), leaseId: leaseId },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("round-trips a ttl above the signed 32-bit ceiling on the read path", async () => {
      // `ttl` is modeled as `Long`, not `Integer` (deviation): a Unix-epoch-second
      // value crosses 2,147,483,647 (Jan 2038). Prove a value above the 32-bit
      // ceiling survives the read serialization intact — no overflow/truncation.
      const largeTtl = 2_200_000_000; // > 2_147_483_647
      const leaseKey = generateSchemaData(LeaseKeySchema);
      const lease = generateSchemaData(PersistedExpiredLeaseSchema, {
        ...leaseKey,
        ttl: largeTtl,
      });
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: { ...projectLease(lease), leaseId: leaseId },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      // Belt-and-braces: the exact numeric value survives on the wire.
      expect(JSON.parse(response.body).data.ttl).toBe(largeTtl);
    });

    it("should return 200 when requesting somebody else's lease as 'Admin' or 'Manager'", async () => {
      const anotherEmail = `ANOTHER_${isbAuthorizedUser.user.email}`;
      const leaseKey = generateSchemaData(LeaseKeySchema, {
        userEmail: anotherEmail,
      });
      const lease = generateSchemaData(PersistedLeaseSchema, { ...leaseKey });
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: lease,
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: { ...projectLease(lease), leaseId: leaseId },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 403 when requesting somebody else's lease as 'User'", async () => {
      const anotherEmail = `ANOTHER_${isbAuthorizedUserUserRoleOnly.user.email}`;
      const leaseKey = generateSchemaData(LeaseKeySchema, {
        userEmail: anotherEmail,
      });
      const lease = generateSchemaData(PersistedLeaseSchema, {
        ...leaseKey,
        desiredAssignments: undefined,
      });
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: lease,
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 403,
        body: createFailureResponseBody({
          message: `Active user is not authorized to view leases of requested user.`,
        }),
        headers: responseHeadersWithErrorType("AccessDeniedError"),
      });
    });

    it("should return 200 when requesting somebody else's lease as 'User' with shared access via desiredAssignments", async () => {
      const anotherEmail = `ANOTHER_${isbAuthorizedUserUserRoleOnly.user.email}`;
      const leaseKey = generateSchemaData(LeaseKeySchema, {
        userEmail: anotherEmail,
      });
      const lease = generateSchemaData(PersistedLeaseSchema, {
        ...leaseKey,
        desiredAssignments: [
          {
            principalId: isbAuthorizedUserUserRoleOnly.user.userId,
            principalType: "USER",
            displayName: "Test User",
            email: isbAuthorizedUserUserRoleOnly.user.email,
          },
        ],
      });
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: lease,
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: { ...projectLease(lease), leaseId: leaseId },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 403 when requesting somebody else's lease as 'User' without shared access", async () => {
      const anotherEmail = `ANOTHER_${isbAuthorizedUserUserRoleOnly.user.email}`;
      const leaseKey = generateSchemaData(LeaseKeySchema, {
        userEmail: anotherEmail,
      });
      const lease = generateSchemaData(PersistedLeaseSchema, {
        ...leaseKey,
        desiredAssignments: [
          {
            principalId: "some-other-user-id",
            principalType: "USER",
            displayName: "Other User",
            email: "other@example.com",
          },
        ],
      });
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: lease,
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 403,
        body: createFailureResponseBody({
          message: `Active user is not authorized to view leases of requested user.`,
        }),
        headers: responseHeadersWithErrorType("AccessDeniedError"),
      });
    });

    it("should return 200 when requesting somebody else's lease as 'User' with group-based shared access", async () => {
      const anotherEmail = `ANOTHER_${isbAuthorizedUserUserRoleOnly.user.email}`;
      const groupId = "group-shared-123";
      const leaseKey = generateSchemaData(LeaseKeySchema, {
        userEmail: anotherEmail,
      });
      const lease = generateSchemaData(PersistedLeaseSchema, {
        ...leaseKey,
        desiredAssignments: [
          {
            principalId: groupId,
            principalType: "GROUP",
            displayName: "Engineering Team",
          },
        ],
      });
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({ result: lease }),
      );
      vi.spyOn(
        DynamoPrincipalStore.prototype,
        "getGroupMembershipCache",
      ).mockResolvedValue({
        result: {
          pk: `user#${isbAuthorizedUserUserRoleOnly.user.userId}`,
          sk: "groupMembership",
          groupIds: [groupId, "other-group"],
          ttl: 9999999999,
        },
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: { ...projectLease(lease), leaseId: leaseId },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 403 when user is not a member of the group in desiredAssignments", async () => {
      const anotherEmail = `ANOTHER_${isbAuthorizedUserUserRoleOnly.user.email}`;
      const leaseKey = generateSchemaData(LeaseKeySchema, {
        userEmail: anotherEmail,
      });
      const lease = generateSchemaData(PersistedLeaseSchema, {
        ...leaseKey,
        desiredAssignments: [
          {
            principalId: "group-not-mine",
            principalType: "GROUP",
            displayName: "Other Team",
          },
        ],
      });
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({ result: lease }),
      );
      vi.spyOn(
        DynamoPrincipalStore.prototype,
        "getGroupMembershipCache",
      ).mockResolvedValue({
        result: {
          pk: `user#${isbAuthorizedUserUserRoleOnly.user.userId}`,
          sk: "groupMembership",
          groupIds: ["my-group-1", "my-group-2"],
          ttl: 9999999999,
        },
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 403,
        body: createFailureResponseBody({
          message: `Active user is not authorized to view leases of requested user.`,
        }),
        headers: responseHeadersWithErrorType("AccessDeniedError"),
      });
    });

    it("should return 500 when data store call fails", async () => {
      const leaseKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseKey);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${leaseId}`,
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockImplementation(() => {
        throw new Error();
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeadersWithErrorType("InternalServerError"),
      });
    });
  });

  describe("PATCH /leases/{leaseId}", () => {
    it("should return 400 when no body in the request", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "PATCH",
        path: "/leases/LEASE101",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        // Accepted deviation: PATCH has no required model members, so an absent
        // body passes model validation and is caught by the operation's strict Zod
        // re-parse (delegated 400) as "expected object, received undefined" rather
        // than the pre-Smithy "Body not provided." message.
        body: createFailureResponseBody({
          field: "input",
          message: "Invalid input: expected object, received undefined",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it("should return 400 when the body doesn't contain any valid keys to update", async () => {
      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const oldLease = generateSchemaData(
        PersistedMonitoredLeaseSchema,
        leaseCompositeKey,
      );

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: oldLease,
        }),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PATCH",
        path: `/leases/${leaseId}`,
        body: JSON.stringify({
          abc: "ABC",
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "input",
          message: 'Unrecognized key: "abc"',
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it("should return 404 when the lease to patch doesn't exist", async () => {
      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PATCH",
        path: `/leases/${leaseId}`,
        body: JSON.stringify({
          expirationDate: new Date().toISOString(),
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: undefined,
        }),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: `Lease not found.`,
        }),
        headers: responseHeaders,
      });
    });

    it("should return 400 when the body contains fields that cannot be patched", async () => {
      const requestJsonBody = {
        expirationDate: new Date().toISOString(),
        userEmail: "new.user@example.com", // cannot update this field
        leaseTerms: {
          budgetThresholds: [
            {
              dollarAmount: 100,
              action: "RECLAIM_ACCOUNT",
            },
          ],
          durationThresholds: [
            {
              afterDurationHours: 100,
              action: "RECLAIM_ACCOUNT",
            },
          ],
        },
      };
      const event = createAPIGatewayProxyEvent({
        httpMethod: "PATCH",
        path: "/leases/LEASE101",
        body: JSON.stringify(requestJsonBody),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "input",
          message: 'Unrecognized keys: "userEmail", "leaseTerms"',
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it("should return 400 when patching a pending lease", async () => {
      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const oldLease = generateSchemaData(PersistedPendingLeaseSchema, {
        meta: undefined,
        ...leaseCompositeKey,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: oldLease,
        }),
      );

      const requestJsonBody = {
        ...generateSchemaData(BudgetConfigSchema, {
          maxSpend: 20,
        }),
        ...generateSchemaData(
          DurationConfigSchema.omit({ leaseDurationInHours: true }),
        ),
      };

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PATCH",
        path: `/leases/${leaseId}`,
        body: JSON.stringify(requestJsonBody),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message: "Can only update an active lease",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it.each([
      { name: "expired", leaseType: PersistedExpiredLeaseSchema },
      { name: "pending", leaseType: PersistedPendingLeaseSchema },
      { name: "denied", leaseType: PersistedApprovalDeniedLeaseSchema },
    ])(
      "should return 400 when patching a(n) $name lease",
      async ({ leaseType }) => {
        const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
        const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
        const oldLease = generateSchemaData(leaseType, {
          meta: undefined,
          ...leaseCompositeKey,
        });

        vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
          Promise.resolve({
            result: oldLease,
          }),
        );

        const requestJsonBody = {
          ...generateSchemaData(BudgetConfigSchema, {
            maxSpend: 20,
          }),
          ...generateSchemaData(
            DurationConfigSchema.omit({ leaseDurationInHours: true }),
          ),
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify(requestJsonBody),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });
        expect(
          await handler(
            event,
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          ),
        ).toEqual({
          statusCode: 400,
          body: createFailureResponseBody({
            message: "Can only update an active lease",
          }),
          headers: responseHeadersWithErrorType("ValidationError"),
        });
      },
    );

    it.each([
      {
        budget: 100,
        duration: 24,
        expectedError:
          "Max budget cannot be greater than the global max budget (50).",
      },
      {
        budget: 20,
        duration: 100,
        expectedError:
          "Duration cannot be greater than the global max duration (48).",
      },
      {
        budget: undefined,
        duration: 24,
        expectedError:
          "A max budget must be provided as required by administrator settings. Please contact your administrator if you need to create a lease without specifying a max budget.",
      },
      {
        budget: 20,
        duration: undefined,
        expectedError:
          "A duration must be provided as required by administrator settings. Please contact your administrator if you need to create a lease without specifying a duration.",
      },
    ])(
      "should return 400 when the patch would violate global config constraints",
      async ({ budget, duration, expectedError }) => {
        mockedGlobalConfig.leases.maxDurationHours = 48;
        mockedGlobalConfig.leases.requireMaxDuration = true;
        mockedGlobalConfig.leases.maxBudget = 50;
        mockedGlobalConfig.leases.requireMaxDuration = true;
        mockAppConfigMiddleware(mockedGlobalConfig);

        const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
        const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
        const startDate = <DateTime<true>>DateTime.fromObject(
          {
            year: 2025,
            month: 5,
            day: 2,
            hour: 12,
          },
          { zone: "utc" },
        );
        const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
          meta: undefined,
          ...leaseCompositeKey,
          maxSpend: 25,
          leaseDurationInHours: 24,
          startDate: datetimeAsString(startDate),
          expirationDate: datetimeAsString(startDate.plus({ hours: 24 })),
        });

        vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
          Promise.resolve({
            result: oldLease,
          }),
        );

        const requestJsonBody = {
          expirationDate: duration
            ? datetimeAsString(startDate.plus({ hours: duration }))
            : null,
          maxSpend: budget ?? null,
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify(requestJsonBody),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });
        expect(
          await handler(
            event,
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          ),
        ).toEqual({
          statusCode: 400,
          body: createFailureResponseBody({
            message: expectedError,
          }),
          headers: responseHeadersWithErrorType("ValidationError"),
        });
      },
    );

    it.each([
      {
        // Setting an invalid group is blocked regardless of the previous value.
        patchCostReportGroup: "invalid-group",
        previousCostReportGroup: undefined,
        reportingConfig: testReportingConfig,
        expectedError: "Invalid cost report group",
      },
      {
        // Clearing a previously-set group (null) when one is required is blocked.
        patchCostReportGroup: null,
        previousCostReportGroup: "valid-group-1",
        reportingConfig: testReportingConfigRequired,
        expectedError:
          "A cost report group must be provided as required by administrator settings. Please contact your administrator if you need to create a lease without specifying a cost report group.",
      },
    ])(
      "should return 400 when the patch would violate cost reporting constraints",
      async ({
        patchCostReportGroup,
        previousCostReportGroup,
        reportingConfig,
        expectedError,
      }) => {
        mockAppConfigMiddleware(mockedGlobalConfig, reportingConfig);

        const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
        const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
        const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
          ...leaseCompositeKey,
          costReportGroup: previousCostReportGroup,
          startDate: new Date().toISOString(),
          expirationDate: undefined,
        });

        vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
          Promise.resolve({
            result: oldLease,
          }),
        );

        const requestJsonBody = {
          maxSpend: 20,
          costReportGroup: patchCostReportGroup,
        };

        const event = createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify(requestJsonBody),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });
        expect(
          await handler(
            event,
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          ),
        ).toEqual({
          statusCode: 400,
          body: createFailureResponseBody({
            message: expectedError,
          }),
          headers: responseHeadersWithErrorType("ValidationError"),
        });
      },
    );

    it.each([{ status: "Active" }, { status: "Frozen" }])(
      "should return 200 for a valid patch request on a(n) $status lease",
      async ({ status }) => {
        const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
        const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
        const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
          ...leaseCompositeKey,
          status: <"Active" | "Frozen">status,
          leaseDurationInHours: 48,
          costReportGroup: undefined,
          startDate: new Date().toISOString(),
          budgetThresholds: undefined,
          durationThresholds: undefined,
        });

        vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
          Promise.resolve({
            result: oldLease,
          }),
        );

        const requestJsonBody = {
          expirationDate: new Date().toISOString(),
          ...generateSchemaData(BudgetConfigSchema, {
            maxSpend: 20, //mockGlobalConfig.maxSpend is 50
            budgetThresholds: undefined,
          }),
          ...generateSchemaData(
            DurationConfigSchema.omit({ leaseDurationInHours: true }),
            { durationThresholds: undefined },
          ),
          costReportGroup: undefined,
        };

        const updatedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
          ...oldLease,
          ...requestJsonBody,
        });

        const event = createAPIGatewayProxyEvent({
          httpMethod: "PATCH",
          path: `/leases/${leaseId}`,
          body: JSON.stringify(requestJsonBody),
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        const spyPut = vi
          .spyOn(DynamoLeaseStore.prototype, "update")
          .mockReturnValue(
            Promise.resolve({
              newItem: updatedLease,
              oldItem: oldLease,
            }),
          );

        expect(
          await handler(
            event,
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          ),
        ).toEqual({
          statusCode: 200,
          body: rawBodyLike({
            status: "success",
            data: projectLease(updatedLease),
          }),
          headers: expect.objectContaining(responseHeaders),
        });
        expect(spyPut).toHaveBeenCalledOnce();
        expect(spyPut).toHaveBeenCalledWith({
          ...updatedLease,
          ...requestJsonBody,
        });
      },
    );

    it("allows patching other fields when a required cost report group is already missing", async () => {
      // Lease predates the requirement and has no cost report group; a group is
      // now required. Patching an unrelated field (maxSpend) must still succeed.
      mockAppConfigMiddleware(mockedGlobalConfig, testReportingConfigRequired);

      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        ...leaseCompositeKey,
        status: "Active",
        costReportGroup: undefined,
        startDate: new Date().toISOString(),
        expirationDate: undefined,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({ result: oldLease }),
      );

      // Patch only maxSpend — costReportGroup is not included in the body.
      const requestJsonBody = { maxSpend: 20 };
      const updatedLease = { ...oldLease, maxSpend: 20 };

      vi.spyOn(DynamoLeaseStore.prototype, "update").mockReturnValue(
        Promise.resolve({ newItem: updatedLease, oldItem: oldLease }),
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PATCH",
        path: `/leases/${leaseId}`,
        body: JSON.stringify(requestJsonBody),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toEqual(200);
    });

    it("should return 200 when nullable values are used to clear data", async () => {
      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        ...leaseCompositeKey,
        costReportGroup: undefined,
        startDate: new Date().toISOString(),
        budgetThresholds: undefined,
        durationThresholds: undefined,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: oldLease,
        }),
      );

      const requestJsonBody = {
        ...generateSchemaData(BudgetConfigSchema, {
          budgetThresholds: undefined,
        }),
        ...generateSchemaData(
          DurationConfigSchema.omit({ leaseDurationInHours: true }),
          { durationThresholds: undefined },
        ),
        expirationDate: null,
        maxSpend: 20, //no max budget is disallowed in mock global config
      };

      const updatedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        ...oldLease,
        ...requestJsonBody,
        expirationDate: undefined,
        maxSpend: 20,
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PATCH",
        path: `/leases/${leaseId}`,
        body: JSON.stringify(requestJsonBody),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const spyPut = vi
        .spyOn(DynamoLeaseStore.prototype, "update")
        .mockReturnValue(
          Promise.resolve({
            newItem: updatedLease,
            oldItem: oldLease,
          }),
        );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: projectLease(updatedLease),
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(spyPut).toHaveBeenCalledOnce();
      expect(spyPut).toHaveBeenCalledWith({
        ...updatedLease,
      });
    });

    it("re-tags the CostReportGroup tag on the account when costReportGroup changes", async () => {
      const reportingConfig = {
        costReportGroups: ["valid-group-1", "valid-group-2"],
        requireCostReportGroup: false,
      };
      mockAppConfigMiddleware(mockedGlobalConfig, reportingConfig);

      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        ...leaseCompositeKey,
        status: "Active",
        costReportGroup: "valid-group-1",
        maxSpend: 20,
        startDate: new Date().toISOString(),
        budgetThresholds: undefined,
        durationThresholds: undefined,
        allowOwnerToShareLease: false,
      });
      const updatedLease = { ...oldLease, costReportGroup: "valid-group-2" };

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: oldLease,
      } as any);
      vi.spyOn(DynamoLeaseStore.prototype, "update").mockResolvedValue({
        newItem: updatedLease,
        oldItem: oldLease,
      } as any);
      const tagSpy = vi
        .spyOn(OrganizationsTaggingService.prototype, "tagAccount")
        .mockResolvedValue(undefined);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PATCH",
        path: `/leases/${leaseId}`,
        body: JSON.stringify({ costReportGroup: "valid-group-2" }),
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      expect(tagSpy).toHaveBeenCalledOnce();
      expect(tagSpy).toHaveBeenCalledWith(oldLease.awsAccountId, {
        CostReportGroup: "valid-group-2",
      });
    });

    it("returns 200 even when the re-tag call fails (fire-and-forget)", async () => {
      const reportingConfig = {
        costReportGroups: ["valid-group-1", "valid-group-2"],
        requireCostReportGroup: false,
      };
      mockAppConfigMiddleware(mockedGlobalConfig, reportingConfig);

      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);
      const oldLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        ...leaseCompositeKey,
        status: "Active",
        costReportGroup: "valid-group-1",
        maxSpend: 20,
        startDate: new Date().toISOString(),
        budgetThresholds: undefined,
        durationThresholds: undefined,
        allowOwnerToShareLease: false,
      });
      const updatedLease = { ...oldLease, costReportGroup: "valid-group-2" };

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: oldLease,
      } as any);
      vi.spyOn(DynamoLeaseStore.prototype, "update").mockResolvedValue({
        newItem: updatedLease,
        oldItem: oldLease,
      } as any);
      vi.spyOn(
        OrganizationsTaggingService.prototype,
        "tagAccount",
      ).mockRejectedValue(new Error("simulated CE failure"));

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PATCH",
        path: `/leases/${leaseId}`,
        body: JSON.stringify({ costReportGroup: "valid-group-2" }),
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
    });

    it("should return 400 when setting allowOwnerToShareLease to true while leaseSharingEnabled is false", async () => {
      const disabledSharingConfig = {
        ...mockedGlobalConfig,
        leases: {
          ...mockedGlobalConfig.leases,
          leaseSharingEnabled: false,
        },
      };
      mockAppConfigMiddleware(disabledSharingConfig, mockedReportingConfig);

      const leaseCompositeKey = generateSchemaData(LeaseKeySchema);
      const leaseId = base64EncodeCompositeKey(leaseCompositeKey);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PATCH",
        path: `/leases/${leaseId}`,
        body: JSON.stringify({
          allowOwnerToShareLease: true,
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, disabledSharingConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message:
            "Cannot enable allowOwnerToShareLease because lease sharing is not available.",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    describe("M2M-assignee guard", () => {
      it("returns 400 and writes nothing when an M2M caller requests a lease for self", async () => {
        const createSpy = vi.spyOn(DynamoLeaseStore.prototype, "create");
        const eventSpy = vi.spyOn(
          IsbEventBridgeClient.prototype,
          "sendIsbEvent",
        );

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify({ leaseTemplateUuid: randomUUID() }),
          headers: { "Content-Type": "application/json" },
          isbUser: m2mAdminUser,
        });

        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
        expect(createSpy).not.toHaveBeenCalled();
        expect(eventSpy).not.toHaveBeenCalled();
      });

      it("returns 400 and writes nothing when a Manager assigns a lease to a synthetic email", async () => {
        const createSpy = vi.spyOn(DynamoLeaseStore.prototype, "create");
        const syntheticEmail = buildM2mSyntheticEmail("some-client", "User");

        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/leases",
          body: JSON.stringify({
            leaseTemplateUuid: randomUUID(),
            userEmail: syntheticEmail,
          }),
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUser.user,
        });

        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
        expect(createSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe("POST /leases - rate limit", () => {
    function buildLeaseAt(opts: {
      userEmail: string;
      createdAtIso: string;
    }): PersistedLease {
      const base = generateSchemaData(PersistedMonitoredLeaseSchema, {
        userEmail: opts.userEmail,
        status: "Active",
      });
      return {
        ...base,
        meta: {
          schemaVersion: 4,
          createdTime: opts.createdAtIso,
          lastEditTime: opts.createdAtIso,
        },
      };
    }

    function makeUserOnlyEvent() {
      return createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify({
          leaseTemplateUuid: randomUUID(),
          comments: "rate limit test",
        }),
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });
    }

    function makeUserOnlyContext(globalConfig?: GlobalConfig) {
      return {
        ...mockAuthorizedContext(testEnv, globalConfig ?? mockedGlobalConfig),
        user: isbAuthorizedUserUserRoleOnly.user,
      };
    }

    function mockPublicTemplate() {
      vi.spyOn(DynamoLeaseTemplateStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: generateSchemaData(PersistedLeaseTemplateSchema, {
            visibility: "PUBLIC",
          }),
        }),
      );
    }

    it("returns 429 with retryAt when User has reached the lease request limit", async () => {
      mockPublicTemplate();
      const userEmail = isbAuthorizedUserUserRoleOnly.user.email;
      const earliest = DateTime.utc().minus({ hours: 24 }).toISO()!;
      const seededLeases: PersistedLease[] = Array.from(
        { length: 10 },
        (_, i) =>
          buildLeaseAt({
            userEmail,
            createdAtIso: DateTime.utc()
              .minus({ hours: 24 - i })
              .toISO()!,
          }),
      );
      // ensure earliest is at index 0
      seededLeases[0] = buildLeaseAt({ userEmail, createdAtIso: earliest });

      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockResolvedValue(
        { result: seededLeases, nextPageIdentifier: null },
      );
      const requestLeaseSpy = vi.spyOn(InnovationSandbox, "requestLease");

      const response = await handler(
        makeUserOnlyEvent(),
        makeUserOnlyContext(),
      );
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(429);
      expect(body.data.retryAt).toBe(
        DateTime.fromISO(earliest, { zone: "utc" })
          .plus({ hours: 168 })
          .toISO(),
      );
      expect(requestLeaseSpy).not.toHaveBeenCalled();
    });

    // The 429 path emits a LeaseRequestRateLimited warn log carrying every
    // documented field. The tests above assert the response shape but never
    // the structured log payload.
    it("emits a LeaseRequestRateLimited log with all documented fields on 429", async () => {
      mockPublicTemplate();
      const userEmail = isbAuthorizedUserUserRoleOnly.user.email;
      const earliest = DateTime.utc().minus({ hours: 24 }).toISO()!;
      const seededLeases: PersistedLease[] = Array.from(
        { length: 10 },
        (_, i) =>
          buildLeaseAt({
            userEmail,
            createdAtIso: DateTime.utc()
              .minus({ hours: 24 - i })
              .toISO()!,
          }),
      );
      seededLeases[0] = buildLeaseAt({ userEmail, createdAtIso: earliest });

      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockResolvedValue(
        { result: seededLeases, nextPageIdentifier: null },
      );
      const warnSpy = vi.spyOn(Logger.prototype, "warn");

      const response = await handler(
        makeUserOnlyEvent(),
        makeUserOnlyContext(),
      );

      expect(response.statusCode).toBe(429);
      const rateLimitedLog = warnSpy.mock.calls.find(
        (call) => call[0] === "LeaseRequestRateLimited",
      );
      expect(rateLimitedLog).toBeDefined();
      expect(rateLimitedLog![1]).toEqual({
        logDetailType: "LeaseRequestRateLimited",
        targetUserEmail: userEmail,
        callerEmail: userEmail,
        currentCount: 10,
        limit: 10,
        retryAt: DateTime.fromISO(earliest, { zone: "utc" })
          .plus({ hours: 168 })
          .toISO(),
        effectiveWindowHours: 168,
      });
    });

    it("returns retryAt at the Nth-oldest lease when count exceeds the limit", async () => {
      // Simulates admin/manager assignments pushing the user above the limit:
      // user has 12 leases, limit is 10. Aging out only the earliest still
      // leaves 11 in window, so retryAt must be the (count - limit)th oldest
      // i.e. the 2nd-oldest in this case.
      mockPublicTemplate();
      const userEmail = isbAuthorizedUserUserRoleOnly.user.email;
      const seededLeases: PersistedLease[] = Array.from(
        { length: 12 },
        (_, i) =>
          buildLeaseAt({
            userEmail,
            // index 0 is oldest (24h ago), index 11 is newest (13h ago)
            createdAtIso: DateTime.utc()
              .minus({ hours: 24 - i })
              .toISO()!,
          }),
      );
      const expectedPivot = seededLeases[2]!.meta!.createdTime!; // 12 - 10 = 2

      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockResolvedValue(
        { result: seededLeases, nextPageIdentifier: null },
      );
      const requestLeaseSpy = vi.spyOn(InnovationSandbox, "requestLease");

      const response = await handler(
        makeUserOnlyEvent(),
        makeUserOnlyContext(),
      );
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(429);
      expect(body.data.retryAt).toBe(
        DateTime.fromISO(expectedPivot, { zone: "utc" })
          .plus({ hours: 168 })
          .toISO(),
      );
      expect(requestLeaseSpy).not.toHaveBeenCalled();
    });

    it("returns 201 when User is under the limit", async () => {
      mockPublicTemplate();
      const userEmail = isbAuthorizedUserUserRoleOnly.user.email;
      const seededLeases: PersistedLease[] = Array.from({ length: 5 }, (_, i) =>
        buildLeaseAt({
          userEmail,
          createdAtIso: DateTime.utc()
            .minus({ hours: i + 1 })
            .toISO()!,
        }),
      );
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockResolvedValue(
        { result: seededLeases, nextPageIdentifier: null },
      );
      const requestLeaseSpy = vi
        .spyOn(InnovationSandbox, "requestLease")
        .mockResolvedValue(generateSchemaData(PersistedPendingLeaseSchema));

      const response = await handler(
        makeUserOnlyEvent(),
        makeUserOnlyContext(),
      );

      expect(response.statusCode).toBe(201);
      expect(requestLeaseSpy).toHaveBeenCalledOnce();
    });

    it("returns 201 when the earliest lease has aged out of the window", async () => {
      mockPublicTemplate();
      const userEmail = isbAuthorizedUserUserRoleOnly.user.email;
      // 10 leases but the earliest is 200h old (outside 168h window)
      const inWindow: PersistedLease[] = Array.from({ length: 9 }, (_, i) =>
        buildLeaseAt({
          userEmail,
          createdAtIso: DateTime.utc()
            .minus({ hours: i + 1 })
            .toISO()!,
        }),
      );
      const outOfWindow = buildLeaseAt({
        userEmail,
        createdAtIso: DateTime.utc().minus({ hours: 200 }).toISO()!,
      });
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockResolvedValue(
        { result: [outOfWindow, ...inWindow], nextPageIdentifier: null },
      );
      const requestLeaseSpy = vi
        .spyOn(InnovationSandbox, "requestLease")
        .mockResolvedValue(generateSchemaData(PersistedPendingLeaseSchema));

      const response = await handler(
        makeUserOnlyEvent(),
        makeUserOnlyContext(),
      );

      expect(response.statusCode).toBe(201);
      expect(requestLeaseSpy).toHaveBeenCalledOnce();
    });

    it("exempts Admin/Manager assigning on behalf of a user at the limit", async () => {
      mockPublicTemplate();
      const targetEmail = "target-user@example.com";
      vi.spyOn(IsbServices, "idcService").mockReturnValue({
        getUserFromEmail: vi.fn().mockResolvedValue({
          type: "user",
          email: targetEmail,
          userId: "target-id",
          roles: ["User"],
        }),
      } as any);
      const tenLeases: PersistedLease[] = Array.from({ length: 10 }, (_, i) =>
        buildLeaseAt({
          userEmail: targetEmail,
          createdAtIso: DateTime.utc()
            .minus({ hours: i + 1 })
            .toISO()!,
        }),
      );
      const findByUserEmailSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "findByUserEmail")
        .mockResolvedValue({ result: tenLeases, nextPageIdentifier: null });
      const requestLeaseSpy = vi
        .spyOn(InnovationSandbox, "requestLease")
        .mockResolvedValue(generateSchemaData(PersistedPendingLeaseSchema));

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/leases",
        body: JSON.stringify({
          leaseTemplateUuid: randomUUID(),
          userEmail: targetEmail,
          comments: "admin assignment",
        }),
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(201);
      expect(findByUserEmailSpy).not.toHaveBeenCalled();
      expect(requestLeaseSpy).toHaveBeenCalledOnce();
    });

    it.each([
      {
        excludedStatus: "PendingApproval" as const,
        schema: PersistedPendingLeaseSchema,
      },
      {
        excludedStatus: "ApprovalDenied" as const,
        schema: PersistedApprovalDeniedLeaseSchema,
      },
    ])(
      "does not count $excludedStatus leases toward the rate limit",
      async ({ excludedStatus, schema }) => {
        mockPublicTemplate();
        const userEmail = isbAuthorizedUserUserRoleOnly.user.email;
        const seededLeases: PersistedLease[] = Array.from(
          { length: 10 },
          (_, i) => ({
            ...generateSchemaData(schema, {
              userEmail,
              status: excludedStatus,
            }),
            meta: {
              schemaVersion: 4,
              createdTime: DateTime.utc()
                .minus({ hours: i + 1 })
                .toISO()!,
              lastEditTime: DateTime.utc()
                .minus({ hours: i + 1 })
                .toISO()!,
            },
          }),
        );
        vi.spyOn(
          DynamoLeaseStore.prototype,
          "findByUserEmail",
        ).mockResolvedValue({
          result: seededLeases,
          nextPageIdentifier: null,
        });
        const requestLeaseSpy = vi
          .spyOn(InnovationSandbox, "requestLease")
          .mockResolvedValue(generateSchemaData(PersistedPendingLeaseSchema));

        const response = await handler(
          makeUserOnlyEvent(),
          makeUserOnlyContext(),
        );

        expect(response.statusCode).toBe(201);
        expect(requestLeaseSpy).toHaveBeenCalledOnce();
      },
    );

    it("emits LeaseRequestWindowCapped log at most once per cold start", async () => {
      mockPublicTemplate();
      const cappedConfig: GlobalConfig = {
        ...mockedGlobalConfig,
        leases: {
          ...mockedGlobalConfig.leases,
          ttl: 30,
          leaseRequestWindowHours: 1000,
        },
      };
      mockAppConfigMiddleware(cappedConfig, mockedReportingConfig);
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockResolvedValue(
        { result: [], nextPageIdentifier: null },
      );
      vi.spyOn(InnovationSandbox, "requestLease").mockResolvedValue(
        generateSchemaData(PersistedPendingLeaseSchema),
      );
      const warnSpy = vi.spyOn(Logger.prototype, "warn");

      // Two back-to-back invocations within the same module instance (warm Lambda)
      await handler(makeUserOnlyEvent(), makeUserOnlyContext(cappedConfig));
      await handler(makeUserOnlyEvent(), makeUserOnlyContext(cappedConfig));

      const cappedLogCount = warnSpy.mock.calls.filter(
        (call) =>
          typeof call[0] === "string" && call[0] === "LeaseRequestWindowCapped",
      ).length;
      // Either 0 (already emitted earlier in suite) or 1 (this is the first
      // time the cap was hit), but never 2 from these two back-to-back calls.
      expect(cappedLogCount).toBeLessThanOrEqual(1);
    });

    it("caps the effective window at leases.ttl * 24 when leaseRequestWindowHours is larger", async () => {
      mockPublicTemplate();
      const userEmail = isbAuthorizedUserUserRoleOnly.user.email;
      // ttl is 30 days = 720h. Configure window > ttl*24 to trigger the cap.
      const cappedConfig: GlobalConfig = {
        ...mockedGlobalConfig,
        leases: {
          ...mockedGlobalConfig.leases,
          ttl: 30,
          leaseRequestWindowHours: 1000,
        },
      };
      mockAppConfigMiddleware(cappedConfig, mockedReportingConfig);

      // Earliest lease at 800h old: outside 720h cap, but within configured 1000h
      const earliestOutOfCap = buildLeaseAt({
        userEmail,
        createdAtIso: DateTime.utc().minus({ hours: 800 }).toISO()!,
      });
      const inCap: PersistedLease[] = Array.from({ length: 9 }, (_, i) =>
        buildLeaseAt({
          userEmail,
          createdAtIso: DateTime.utc()
            .minus({ hours: i + 1 })
            .toISO()!,
        }),
      );
      vi.spyOn(DynamoLeaseStore.prototype, "findByUserEmail").mockResolvedValue(
        {
          result: [earliestOutOfCap, ...inCap],
          nextPageIdentifier: null,
        },
      );
      const requestLeaseSpy = vi
        .spyOn(InnovationSandbox, "requestLease")
        .mockResolvedValue(generateSchemaData(PersistedPendingLeaseSchema));

      const response = await handler(
        makeUserOnlyEvent(),
        makeUserOnlyContext(cappedConfig),
      );

      // 9 in-cap leases < 10 limit yields 201. If cap weren't applied, 10 leases would yield 429.
      expect(response.statusCode).toBe(201);
      expect(requestLeaseSpy).toHaveBeenCalledOnce();
    });
  });

  describe("POST /leases/{leaseId}/review", () => {
    it("should return 200 and invoke the approveLease action", async () => {
      const mockedLease = generateSchemaData(PersistedPendingLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/review`,
        body: JSON.stringify({
          action: "Approve",
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const approveLeaseSpy = vi
        .spyOn(InnovationSandbox, "approveLease")
        .mockResolvedValue({
          newItem: mockedLease,
          oldItem: mockedLease,
        });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: null,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(approveLeaseSpy).toHaveBeenCalledOnce();
    });

    it("should approve a pending lease with an existing group when new group assignments are disabled", async () => {
      mockedGlobalConfig.leases.groupAssignmentMode = "NONE";
      mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

      const mockedLease = generateSchemaData(PersistedPendingLeaseSchema, {
        desiredAssignments: [
          generateSchemaData(DesiredAssignmentSchema, {
            principalType: "GROUP",
          }),
        ],
      });
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/review`,
        body: JSON.stringify({ action: "Approve" }),
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: mockedLease,
      });
      const approveLeaseSpy = vi
        .spyOn(InnovationSandbox, "approveLease")
        .mockResolvedValue({
          newItem: mockedLease,
          oldItem: mockedLease,
        });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      expect(approveLeaseSpy).toHaveBeenCalledOnce();
    });

    it("should return 200 and invoke the denyLease action", async () => {
      const mockedLease = generateSchemaData(PersistedPendingLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/review`,
        body: JSON.stringify({
          action: "Deny",
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const denyLeaseSpy = vi
        .spyOn(InnovationSandbox, "denyLease")
        .mockResolvedValue();

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: null,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(denyLeaseSpy).toHaveBeenCalledOnce();
    });
    it("should return 400 and when the leaseId path parameter is invalid", async () => {
      const mockedLease = generateSchemaData(PersistedPendingLeaseSchema);
      const mockedLeaseId = "INVALID_ID";
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/review`,
        body: JSON.stringify({
          action: "Approve",
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const approveLeaseSpy = vi
        .spyOn(InnovationSandbox, "approveLease")
        .mockResolvedValue({
          newItem: mockedLease,
          oldItem: mockedLease,
        });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message: "LeaseId path parameter provided is invalid.",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
      expect(getLeaseSpy).not.toHaveBeenCalledOnce();
      expect(approveLeaseSpy).not.toHaveBeenCalledOnce();
    });
    it("should return 400 and when the request body is invalid", async () => {
      const mockedLease = generateSchemaData(PersistedPendingLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/review`,
        body: JSON.stringify({
          action: "Approve",
          invalidField: "invalid",
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const approveLeaseSpy = vi
        .spyOn(InnovationSandbox, "approveLease")
        .mockResolvedValue({
          newItem: mockedLease,
          oldItem: mockedLease,
        });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "input",
          message: 'Unrecognized key: "invalidField"',
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
      expect(getLeaseSpy).not.toHaveBeenCalledOnce();
      expect(approveLeaseSpy).not.toHaveBeenCalledOnce();
    });
    it("should return 404 when the lease to review does not exist", async () => {
      const mockedLease = generateSchemaData(PersistedPendingLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/review`,
        body: JSON.stringify({
          action: "Approve",
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: undefined,
        });

      const approveLeaseSpy = vi
        .spyOn(InnovationSandbox, "approveLease")
        .mockResolvedValue({
          newItem: mockedLease,
          oldItem: mockedLease,
        });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: `Lease not found.`,
        }),
        headers: responseHeaders,
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(approveLeaseSpy).not.toHaveBeenCalledOnce();
    });
    it("should return 409 when the lease is in a non-reviewable state", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/review`,
        body: JSON.stringify({
          action: "Approve",
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const approveLeaseSpy = vi
        .spyOn(InnovationSandbox, "approveLease")
        .mockResolvedValue({
          newItem: mockedLease,
          oldItem: mockedLease,
        });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message: LEASE_NOT_PENDING_REVIEW_ERROR,
        }),
        headers: responseHeadersWithErrorType("ConflictError"),
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(approveLeaseSpy).not.toHaveBeenCalledOnce();
    });
    it("should return 500 when an unexpected error occurs", async () => {
      const mockedLease = generateSchemaData(PersistedPendingLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/review`,
        body: JSON.stringify({
          action: "Approve",
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const approveLeaseSpy = vi
        .spyOn(InnovationSandbox, "approveLease")
        .mockRejectedValue(new Error("Unexpected error"));

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeadersWithErrorType("InternalServerError"),
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(approveLeaseSpy).toHaveBeenCalledOnce();
    });
  });

  describe("POST /leases/{leaseId}/freeze", () => {
    it("should return 200 and invoke the freezeLease action", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/freeze`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const freezeLeaseSpy = vi
        .spyOn(InnovationSandbox, "freezeLease")
        .mockResolvedValue();

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: null,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(freezeLeaseSpy).toHaveBeenCalledOnce();
    });
    it("should return 400 and when the leaseId path parameter is invalid", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema);
      const mockedLeaseId = "INVALID_ID";
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/freeze`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const freezeLeaseSpy = vi
        .spyOn(InnovationSandbox, "freezeLease")
        .mockResolvedValue();

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message: "LeaseId path parameter provided is invalid.",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
      expect(getLeaseSpy).not.toHaveBeenCalledOnce();
      expect(freezeLeaseSpy).not.toHaveBeenCalledOnce();
    });
    it("should return 404 when the lease to review does not exist", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/freeze`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: undefined,
        });

      const freezeLeaseSpy = vi
        .spyOn(InnovationSandbox, "freezeLease")
        .mockResolvedValue();

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: `Lease not found.`,
        }),
        headers: responseHeaders,
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(freezeLeaseSpy).not.toHaveBeenCalledOnce();
    });
    it("should return 409 when the lease is in a non-freezeable state", async () => {
      const mockedLease = generateSchemaData(PersistedPendingLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/freeze`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const freezeLeaseSpy = vi
        .spyOn(InnovationSandbox, "freezeLease")
        .mockResolvedValue();

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message: `Only active leases can be frozen.`,
        }),
        headers: responseHeadersWithErrorType("ConflictError"),
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(freezeLeaseSpy).not.toHaveBeenCalledOnce();
    });
    it.each([
      { statusCode: 409, error: AccountNotInActiveError },
      { statusCode: 404, error: CouldNotFindAccountError },
      { statusCode: 404, error: CouldNotRetrieveUserError },
    ])(
      "should return $statusCode when $error.name is thrown by freeze call",
      async ({ statusCode, error }) => {
        const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema);
        const mockedLeaseId = base64EncodeCompositeKey({
          userEmail: mockedLease.userEmail,
          uuid: mockedLease.uuid,
        });
        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: `/leases/${mockedLeaseId}/freeze`,
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        const getLeaseSpy = vi
          .spyOn(DynamoLeaseStore.prototype, "get")
          .mockResolvedValue({
            result: mockedLease,
          });

        const freezeLeaseSpy = vi
          .spyOn(InnovationSandbox, "freezeLease")
          .mockRejectedValue(new error(error.name));

        expect(
          await handler(
            event,
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          ),
        ).toEqual({
          statusCode: statusCode,
          body: createFailureResponseBody({
            message: error.name,
          }),
          headers:
            statusCode === 409
              ? responseHeadersWithErrorType("ConflictError")
              : responseHeaders,
        });
        expect(getLeaseSpy).toHaveBeenCalledOnce();
        expect(freezeLeaseSpy).toHaveBeenCalledOnce();
      },
    );
    it("should return 409 when a competing lock holder blocks the freeze", async () => {
      // Previously fell through to the generic handler as a 500, which gave the
      // caller no way to tell a retryable conflict from a server fault.
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/freeze`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: mockedLease,
      });
      vi.spyOn(InnovationSandbox, "freezeLease").mockRejectedValue(
        new ResourceLockConflictError("Lock held"),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message:
            "Another operation is currently being processed for this lease. Try again once it completes.",
        }),
        headers: responseHeadersWithErrorType("ConflictError"),
      });
    });
    it("should return 500 when an unexpected error occurs", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/freeze`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const freezeLeaseSpy = vi
        .spyOn(InnovationSandbox, "freezeLease")
        .mockRejectedValue(new Error("Unexpected error"));

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeadersWithErrorType("InternalServerError"),
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(freezeLeaseSpy).toHaveBeenCalledOnce();
    });
  });

  describe("POST /leases/{leaseId}/terminate", () => {
    it("should return 200 and invoke the lease termination process", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const terminateLeaseSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockResolvedValue();

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: null,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(terminateLeaseSpy).toHaveBeenCalledOnce();
    });

    it("should return 409 when a termination is already being processed", async () => {
      // Terminate preempts every other intent, so a conflict here means another
      // termination already holds the lock.
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: mockedLease,
      });
      vi.spyOn(InnovationSandbox, "terminateLease").mockRejectedValue(
        new ResourceLockConflictError("Lock held"),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message: "A termination is already being processed for this lease.",
        }),
        headers: responseHeadersWithErrorType("ConflictError"),
      });
    });

    it("should return 404 when lease is not found", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: undefined,
        });

      const terminateLeaseSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockResolvedValue();

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: `Lease not found.`,
        }),
        headers: responseHeaders,
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(terminateLeaseSpy).not.toHaveBeenCalledOnce();
    });
    it("should return 409 when lease is in non-active state", async () => {
      const mockedLease = generateSchemaData(PersistedExpiredLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const terminateLeaseSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockResolvedValue();

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message: `Only [Active, Frozen, Provisioning] leases can be terminated.`,
        }),
        headers: responseHeadersWithErrorType("ConflictError"),
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(terminateLeaseSpy).not.toHaveBeenCalledOnce();
    });
    it.each([
      { statusCode: 404, error: CouldNotFindAccountError },
      { statusCode: 404, error: CouldNotRetrieveUserError },
    ])(
      "should return $statusCode when $error.name is thrown by terminate call",
      async ({ statusCode, error }) => {
        const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema);
        const mockedLeaseId = base64EncodeCompositeKey({
          userEmail: mockedLease.userEmail,
          uuid: mockedLease.uuid,
        });
        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: `/leases/${mockedLeaseId}/terminate`,
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        const getLeaseSpy = vi
          .spyOn(DynamoLeaseStore.prototype, "get")
          .mockResolvedValue({
            result: mockedLease,
          });

        const terminateLeaseSpy = vi
          .spyOn(InnovationSandbox, "terminateLease")
          .mockRejectedValue(new error(error.name));

        expect(
          await handler(
            event,
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          ),
        ).toEqual({
          statusCode: statusCode,
          body: createFailureResponseBody({ message: error.name }),
          headers: responseHeaders,
        });
        expect(getLeaseSpy).toHaveBeenCalledOnce();
        expect(terminateLeaseSpy).toHaveBeenCalledOnce();
      },
    );
    it("should return 500 when unexpected error occurs", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const terminateLeaseSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockRejectedValue(new Error());

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeadersWithErrorType("InternalServerError"),
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(terminateLeaseSpy).toHaveBeenCalledOnce();
    });

    it("should return 200 and pass UserTerminated when User owns an Active lease", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        status: "Active",
        userEmail: isbAuthorizedUserUserRoleOnly.user.email,
      });
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: mockedLease,
      });
      const terminateLeaseSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockResolvedValue();

      const userOnlyContext = {
        ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
        user: isbAuthorizedUserUserRoleOnly.user,
      };

      const response = await handler(event, userOnlyContext);

      expect(response.statusCode).toBe(200);
      expect(terminateLeaseSpy).toHaveBeenCalledWith(
        expect.objectContaining({ expiredStatus: "UserTerminated" }),
        expect.anything(),
      );
    });

    it("should return 403 when User attempts to terminate another user's lease", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        status: "Active",
        userEmail: `another_${isbAuthorizedUserUserRoleOnly.user.email}`,
      });
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: mockedLease,
      });
      const terminateLeaseSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockResolvedValue();

      const userOnlyContext = {
        ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
        user: isbAuthorizedUserUserRoleOnly.user,
      };

      const response = await handler(event, userOnlyContext);

      expect(response.statusCode).toBe(403);
      expect(terminateLeaseSpy).not.toHaveBeenCalled();
    });

    it.each([{ status: "Frozen" }, { status: "Provisioning" }] as const)(
      "should return 403 when User attempts to terminate own $status lease",
      async ({ status }) => {
        const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
          status,
          userEmail: isbAuthorizedUserUserRoleOnly.user.email,
        });
        const mockedLeaseId = base64EncodeCompositeKey({
          userEmail: mockedLease.userEmail,
          uuid: mockedLease.uuid,
        });
        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: `/leases/${mockedLeaseId}/terminate`,
          headers: { "Content-Type": "application/json" },
          isbUser: isbAuthorizedUserUserRoleOnly.user,
        });

        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: mockedLease,
        });
        const terminateLeaseSpy = vi
          .spyOn(InnovationSandbox, "terminateLease")
          .mockResolvedValue();

        const userOnlyContext = {
          ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
          user: isbAuthorizedUserUserRoleOnly.user,
        };

        const response = await handler(event, userOnlyContext);

        expect(response.statusCode).toBe(403);
        expect(terminateLeaseSpy).not.toHaveBeenCalled();
      },
    );

    it("should return 403 when User attempts to terminate but allowUserLeaseTermination is disabled", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        status: "Active",
        userEmail: isbAuthorizedUserUserRoleOnly.user.email,
      });
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: mockedLease,
      });
      const terminateLeaseSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockResolvedValue();

      const optedOutConfig: GlobalConfig = {
        ...mockedGlobalConfig,
        leases: {
          ...mockedGlobalConfig.leases,
          allowUserLeaseTermination: false,
        },
      };
      mockAppConfigMiddleware(optedOutConfig, mockedReportingConfig);
      const userOnlyContext = {
        ...mockAuthorizedContext(testEnv, optedOutConfig),
        user: isbAuthorizedUserUserRoleOnly.user,
      };

      const response = await handler(event, userOnlyContext);

      expect(response.statusCode).toBe(403);
      expect(terminateLeaseSpy).not.toHaveBeenCalled();
    });

    it("should return 403 (not 409) when a User terminates another user's non-monitored lease", async () => {
      // Regression guard against a status oracle: authorization is checked before
      // the isMonitoredLease status check. Otherwise a non-owner User who knows a
      // leaseId learns the lease's lifecycle state from the response code
      // (409 = expired/quarantined, 403 = active/monitored). The authorization
      // gate fires first so both cases return the same 403.
      const mockedLease = generateSchemaData(PersistedExpiredLeaseSchema, {
        userEmail: `another_${isbAuthorizedUserUserRoleOnly.user.email}`,
      });
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: mockedLease,
      });
      const terminateLeaseSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockResolvedValue();

      const userOnlyContext = {
        ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
        user: isbAuthorizedUserUserRoleOnly.user,
      };

      const response = await handler(event, userOnlyContext);

      expect(response.statusCode).toBe(403);
      expect(terminateLeaseSpy).not.toHaveBeenCalled();
    });

    it("should return 409 when a User terminates their own non-monitored lease", async () => {
      // Mirror of the oracle guard: an authorized caller (the owner) passes the
      // authorization gate and legitimately sees the 409 status response. Confirms
      // the gate does not over-block authorized users.
      const mockedLease = generateSchemaData(PersistedExpiredLeaseSchema, {
        userEmail: isbAuthorizedUserUserRoleOnly.user.email,
      });
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: mockedLease,
      });
      const terminateLeaseSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockResolvedValue();

      const userOnlyContext = {
        ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
        user: isbAuthorizedUserUserRoleOnly.user,
      };

      const response = await handler(event, userOnlyContext);

      expect(response.statusCode).toBe(409);
      expect(terminateLeaseSpy).not.toHaveBeenCalled();
    });

    it("should return 403 (not 404) when a User terminates a non-existent lease", async () => {
      // Existence oracle guard: a non-owner User who knows a leaseId must not be
      // able to tell a missing lease (404) apart from one that exists but is not
      // theirs (403). Authorization wraps the existence branch so both return 403.
      const mockedLeaseId = base64EncodeCompositeKey(
        generateSchemaData(LeaseKeySchema),
      )!;
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: undefined,
      });
      const terminateLeaseSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockResolvedValue();

      const userOnlyContext = {
        ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
        user: isbAuthorizedUserUserRoleOnly.user,
      };

      const response = await handler(event, userOnlyContext);

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.data.errors[0].message).toBe(
        "User is not authorized to terminate this lease.",
      );
      expect(terminateLeaseSpy).not.toHaveBeenCalled();
    });

    it("should return 404 when an Admin/Manager terminates a non-existent lease", async () => {
      // Elevated callers legitimately need an accurate 404 for operational tooling.
      const mockedLeaseId = base64EncodeCompositeKey(
        generateSchemaData(LeaseKeySchema),
      )!;
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: undefined,
      });

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.data.errors[0].message).toBe("Lease not found.");
    });

    it("should preserve ManuallyTerminated when Admin/Manager terminates another user's Frozen lease", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        status: "Frozen",
        userEmail: "someone-else@example.com",
      });
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: mockedLease,
      });
      const terminateLeaseSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockResolvedValue();

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      expect(terminateLeaseSpy).toHaveBeenCalledWith(
        expect.objectContaining({ expiredStatus: "ManuallyTerminated" }),
        expect.anything(),
      );
    });
  });

  // Handler-chain coverage that runs the REAL InnovationSandbox facade
  // (mocking only the store / OU / IDC / event-bridge boundary) and asserts on
  // the published LeaseTerminatedEvent. The tests above stub the facade and
  // only check its call arguments; these verify the event that the downstream
  // email subscriber actually consumes is published with the right reason.type.
  describe("POST /leases/{leaseId}/terminate - published event", () => {
    // Earlier tests stub InnovationSandbox.terminateLease and the
    // IsbServices.idcService factory, and the suite's afterEach uses
    // clearAllMocks (which does not restore implementations), so those stubs
    // would persist here. Restore them so the real facade runs end to end and
    // builds a real IdcService whose prototype methods we spy below.
    beforeEach(() => {
      vi.spyOn(InnovationSandbox, "terminateLease").mockRestore();
      vi.spyOn(IsbServices, "idcService").mockRestore();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    // Stub the collaborators the real terminateLease touches so it runs end to
    // end without hitting AWS. sendIsbEvents is left as the assertion seam.
    function stubTerminationCollaborators(account: { awsAccountId: string }) {
      vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockResolvedValue({
        result: generateSchemaData(PersistedSandboxAccountSchema, {
          awsAccountId: account.awsAccountId,
          status: "Active",
        }),
      });
      vi.spyOn(DynamoLeaseStore.prototype, "update").mockResolvedValue(
        {} as any,
      );
      vi.spyOn(
        SandboxOuService.prototype,
        "transactionalMoveAccount",
      ).mockReturnValue({
        complete: vi.fn().mockResolvedValue(undefined),
      } as any);
      vi.spyOn(
        OrganizationsTaggingService.prototype,
        "updateStatusTag",
      ).mockResolvedValue(undefined);
      vi.spyOn(IdcService.prototype, "getUserFromEmail").mockResolvedValue(
        undefined,
      );
      vi.spyOn(IdcService.prototype, "revokeAllUserAccess").mockResolvedValue(
        undefined as any,
      );
      vi.spyOn(DynamoLeaseStore.prototype, "acquireLock").mockResolvedValue(
        MOCK_ACQUIRED_LOCK,
      );
      vi.spyOn(DynamoLeaseStore.prototype, "releaseLock").mockResolvedValue(
        undefined,
      );
      vi.spyOn(
        IsbEventBridgeClient.prototype,
        "sendIsbEvent",
      ).mockResolvedValue({} as any);
      return vi
        .spyOn(IsbEventBridgeClient.prototype, "sendIsbEvents")
        .mockResolvedValue({} as any);
    }

    function publishedTerminationReason(
      sendIsbEventsSpy: ReturnType<typeof vi.spyOn>,
    ) {
      const terminatedEvent = sendIsbEventsSpy.mock.calls
        .flat()
        .find(
          (arg: unknown): arg is LeaseTerminatedEvent =>
            arg instanceof LeaseTerminatedEvent,
        );
      return terminatedEvent?.Detail.reason.type;
    }

    it("publishes a LeaseTerminatedEvent with reason UserTerminated when a User terminates their own Active lease", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        status: "Active",
        userEmail: isbAuthorizedUserUserRoleOnly.user.email,
        awsAccountId: "000000000000",
        blueprintId: null,
      });
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: mockedLease,
      });
      const sendIsbEventsSpy = stubTerminationCollaborators(mockedLease);

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      expect(publishedTerminationReason(sendIsbEventsSpy)).toBe(
        "UserTerminated",
      );
    });

    it("publishes a LeaseTerminatedEvent with reason ManuallyTerminated when an Admin terminates another user's lease", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        status: "Active",
        userEmail: "someone-else@example.com",
        awsAccountId: "000000000000",
        blueprintId: null,
      });
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/terminate`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: mockedLease,
      });
      const sendIsbEventsSpy = stubTerminationCollaborators(mockedLease);

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      expect(publishedTerminationReason(sendIsbEventsSpy)).toBe(
        "ManuallyTerminated",
      );
    });
  });

  describe("POST /leases/{leaseId}/unfreeze", () => {
    it("should return 200 and invoke the unfreezeLease action", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        status: "Frozen",
      });
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/unfreeze`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const unfreezeLeaseSpy = vi
        .spyOn(InnovationSandbox, "unfreezeLease")
        .mockResolvedValue({
          newItem: mockedLease,
          oldItem: mockedLease,
        });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: {
            ...projectLease(mockedLease),
            leaseId: mockedLeaseId,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(unfreezeLeaseSpy).toHaveBeenCalledOnce();
    });
    it("should return 409 when assignment processing holds the lock", async () => {
      // Unfreeze is non-critical, so ANY live lock rejects it. This previously
      // surfaced as a 500.
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        status: "Frozen",
      });
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/unfreeze`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: mockedLease,
      });
      vi.spyOn(InnovationSandbox, "unfreezeLease").mockRejectedValue(
        new ResourceLockConflictError("Lock held"),
      );

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message:
            "Another operation is currently being processed for this lease. Try again once it completes.",
        }),
        headers: responseHeadersWithErrorType("ConflictError"),
      });
    });
    it("should return 400 when the leaseId path parameter is invalid", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema);
      const mockedLeaseId = "INVALID_ID";
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/unfreeze`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const unfreezeLeaseSpy = vi
        .spyOn(InnovationSandbox, "unfreezeLease")
        .mockResolvedValue({
          newItem: mockedLease,
          oldItem: mockedLease,
        });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message: "LeaseId path parameter provided is invalid.",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
      expect(getLeaseSpy).not.toHaveBeenCalled();
      expect(unfreezeLeaseSpy).not.toHaveBeenCalled();
    });

    it("should return 404 when the lease does not exist", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/unfreeze`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: undefined,
        });

      const unfreezeLeaseSpy = vi
        .spyOn(InnovationSandbox, "unfreezeLease")
        .mockResolvedValue({
          newItem: mockedLease,
          oldItem: mockedLease,
        });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: `Lease not found.`,
        }),
        headers: responseHeaders,
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(unfreezeLeaseSpy).not.toHaveBeenCalled();
    });

    it("should return 409 when the lease is not frozen", async () => {
      const mockedLease = generateSchemaData(PersistedPendingLeaseSchema);
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/unfreeze`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const unfreezeLeaseSpy = vi
        .spyOn(InnovationSandbox, "unfreezeLease")
        .mockResolvedValue({
          newItem: mockedLease,
          oldItem: mockedLease,
        });

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message: `Only frozen leases can be unfrozen.`,
        }),
        headers: responseHeadersWithErrorType("ConflictError"),
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(unfreezeLeaseSpy).not.toHaveBeenCalled();
    });
    it.each([
      { statusCode: 409, error: AccountNotInFrozenError },
      { statusCode: 404, error: CouldNotFindAccountError },
      { statusCode: 404, error: CouldNotRetrieveUserError },
    ])(
      "should return $statusCode when $error.name is thrown by unfreeze call",
      async ({ statusCode, error }) => {
        const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
          status: "Frozen",
        });
        const mockedLeaseId = base64EncodeCompositeKey({
          userEmail: mockedLease.userEmail,
          uuid: mockedLease.uuid,
        });
        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: `/leases/${mockedLeaseId}/unfreeze`,
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });

        const getLeaseSpy = vi
          .spyOn(DynamoLeaseStore.prototype, "get")
          .mockResolvedValue({
            result: mockedLease,
          });

        const unfreezeLeaseSpy = vi
          .spyOn(InnovationSandbox, "unfreezeLease")
          .mockRejectedValue(new error(error.name));

        expect(
          await handler(
            event,
            mockAuthorizedContext(testEnv, mockedGlobalConfig),
          ),
        ).toEqual({
          statusCode: statusCode,
          body: createFailureResponseBody({
            message: error.name,
          }),
          headers:
            statusCode === 409
              ? responseHeadersWithErrorType("ConflictError")
              : responseHeaders,
        });
        expect(getLeaseSpy).toHaveBeenCalledOnce();
        expect(unfreezeLeaseSpy).toHaveBeenCalledOnce();
      },
    );
    it("should return 500 when an unexpected error occurs", async () => {
      const mockedLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        status: "Frozen",
      });
      const mockedLeaseId = base64EncodeCompositeKey({
        userEmail: mockedLease.userEmail,
        uuid: mockedLease.uuid,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/leases/${mockedLeaseId}/unfreeze`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const getLeaseSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({
          result: mockedLease,
        });

      const unfreezeLeaseSpy = vi
        .spyOn(InnovationSandbox, "unfreezeLease")
        .mockRejectedValue(new Error("Unexpected error"));

      expect(
        await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ),
      ).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeadersWithErrorType("InternalServerError"),
      });
      expect(getLeaseSpy).toHaveBeenCalledOnce();
      expect(unfreezeLeaseSpy).toHaveBeenCalledOnce();
    });
  });

  describe("GET /leases/{leaseId}/assignments", () => {
    const leaseOwnerEmail = "owner@example.com";
    const leaseUuid = "550e8400-e29b-41d4-a716-446655440000";

    // The response is now the reconciled view (desired set unioned with the
    // access records), so both inputs must be pinned: zocker would otherwise
    // generate random desiredAssignments and a random resourceLock, changing the
    // row count and the derived statuses from run to run.
    const lease = generateSchemaData(PersistedLeaseSchema, {
      userEmail: leaseOwnerEmail,
      uuid: leaseUuid,
      status: "Active",
      desiredAssignments: [],
      resourceLock: undefined,
    });

    const leaseId = base64EncodeCompositeKey({
      userEmail: lease.userEmail,
      uuid: lease.uuid,
    })!;

    function createGetAssignmentsEvent(encodedLeaseId: string, user: IsbUser) {
      return createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/leases/${encodedLeaseId}/assignments`,
        pathParameters: { leaseId: encodedLeaseId },
        isbUser: user,
      });
    }

    it("should return 200 with assignments for Admin", async () => {
      const userAssignment = generateSchemaData(PersistedUserAssignmentSchema, {
        pk: "user#a0b1c2d3-e4f5-6789-abcd-ef0123456789",
        sk: `lease#${leaseUuid}`,
        userId: "a0b1c2d3-e4f5-6789-abcd-ef0123456789",
        principalType: "USER",
        leaseId: leaseUuid,
        leaseOwnerEmail,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });

      vi.spyOn(
        DynamoPrincipalStore.prototype,
        "getAssignmentsForLease",
      ).mockResolvedValue({
        result: [userAssignment],
        nextPageIdentifier: null,
      });

      const event = createGetAssignmentsEvent(leaseId, isbAuthorizedUser.user);

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("success");
      expect(body.data.assignments).toHaveLength(1);
      expect(body.data.assignments[0].principalId).toBe(
        "a0b1c2d3-e4f5-6789-abcd-ef0123456789",
      );
      expect(body.data.assignments[0].principalType).toBe("USER");
    });

    it("should return 200 with assignments for Manager", async () => {
      const managerUser: IsbUser = {
        type: "user",
        email: "manager@example.com",
        userId: "managerId",
        roles: ["Manager"],
      };

      const groupAssignment = generateSchemaData(
        PersistedGroupAssignmentSchema,
        {
          pk: "group#a0b1c2d3-e4f5-6789-abcd-ef0123456789",
          sk: `lease#${leaseUuid}`,
          groupId: "a0b1c2d3-e4f5-6789-abcd-ef0123456789",
          principalType: "GROUP",
          leaseId: leaseUuid,
          leaseOwnerEmail,
        },
      );

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });

      vi.spyOn(
        DynamoPrincipalStore.prototype,
        "getAssignmentsForLease",
      ).mockResolvedValue({
        result: [groupAssignment],
        nextPageIdentifier: null,
      });

      const event = createGetAssignmentsEvent(leaseId, managerUser);

      const response = await handler(event, {
        ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ...{ user: managerUser, claims: buildCognitoClaims(managerUser) },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("success");
      expect(body.data.assignments).toHaveLength(1);
      expect(body.data.assignments[0].principalId).toBe(
        "a0b1c2d3-e4f5-6789-abcd-ef0123456789",
      );
      expect(body.data.assignments[0].principalType).toBe("GROUP");
    });

    it("should return 200 with assignments for lease Owner", async () => {
      const ownerUser: IsbUser = {
        type: "user",
        email: leaseOwnerEmail,
        userId: "ownerId",
        roles: ["User"],
      };

      const userAssignment = generateSchemaData(PersistedUserAssignmentSchema, {
        pk: "user#a0b1c2d3-e4f5-6789-abcd-ef0123456789",
        sk: `lease#${leaseUuid}`,
        userId: "a0b1c2d3-e4f5-6789-abcd-ef0123456789",
        principalType: "USER",
        leaseId: leaseUuid,
        leaseOwnerEmail,
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });

      vi.spyOn(
        DynamoPrincipalStore.prototype,
        "getAssignmentsForLease",
      ).mockResolvedValue({
        result: [userAssignment],
        nextPageIdentifier: null,
      });

      const event = createGetAssignmentsEvent(leaseId, ownerUser);

      const response = await handler(event, {
        ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ...{ user: ownerUser, claims: buildCognitoClaims(ownerUser) },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("success");
      expect(body.data.assignments).toHaveLength(1);
    });

    it("should return 403 for non-owner User", async () => {
      const otherUser: IsbUser = {
        type: "user",
        email: "other@example.com",
        userId: "otherId",
        roles: ["User"],
      };

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });

      const event = createGetAssignmentsEvent(leaseId, otherUser);

      const response = await handler(event, {
        ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ...{ user: otherUser, claims: buildCognitoClaims(otherUser) },
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("fail");
    });

    it("should return 404 when lease not found", async () => {
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: undefined,
      });

      const event = createGetAssignmentsEvent(leaseId, isbAuthorizedUser.user);

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("fail");
      expect(body.data.errors[0].message).toBe("Lease not found.");
    });

    it("should return 403 when lease not found and user is not Admin/Manager", async () => {
      const otherUser: IsbUser = {
        type: "user",
        email: "other@example.com",
        userId: "otherId",
        roles: ["User"],
      };

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: undefined,
      });

      const event = createGetAssignmentsEvent(leaseId, otherUser);

      const response = await handler(event, {
        ...mockAuthorizedContext(testEnv, mockedGlobalConfig),
        ...{ user: otherUser, claims: buildCognitoClaims(otherUser) },
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("fail");
    });

    it("should return 200 with empty assignments list", async () => {
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });

      vi.spyOn(
        DynamoPrincipalStore.prototype,
        "getAssignmentsForLease",
      ).mockResolvedValue({
        result: [],
        nextPageIdentifier: null,
      });

      const event = createGetAssignmentsEvent(leaseId, isbAuthorizedUser.user);

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("success");
      expect(body.data.assignments).toHaveLength(0);
    });

    it("should return 200 with mixed user and group assignments", async () => {
      const userAssignment = generateSchemaData(PersistedUserAssignmentSchema, {
        pk: "user#a0b1c2d3-e4f5-6789-abcd-ef0123456789",
        sk: `lease#${leaseUuid}`,
        userId: "a0b1c2d3-e4f5-6789-abcd-ef0123456789",
        principalType: "USER",
        leaseId: leaseUuid,
        leaseOwnerEmail,
        assigneeEmail: "user1@example.com",
      });

      const groupAssignment = generateSchemaData(
        PersistedGroupAssignmentSchema,
        {
          pk: "group#b1c2d3e4-f5a6-7890-bcde-f01234567890",
          sk: `lease#${leaseUuid}`,
          groupId: "b1c2d3e4-f5a6-7890-bcde-f01234567890",
          principalType: "GROUP",
          displayName: "Engineering Team",
          leaseId: leaseUuid,
          leaseOwnerEmail,
        },
      );

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });

      vi.spyOn(
        DynamoPrincipalStore.prototype,
        "getAssignmentsForLease",
      ).mockResolvedValue({
        result: [userAssignment, groupAssignment],
        nextPageIdentifier: null,
      });

      const event = createGetAssignmentsEvent(leaseId, isbAuthorizedUser.user);

      const response = await handler(
        event,
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("success");
      expect(body.data.assignments).toHaveLength(2);

      const userResult = body.data.assignments.find(
        (a: { principalType: string }) => a.principalType === "USER",
      );
      expect(userResult.principalId).toBe(
        "a0b1c2d3-e4f5-6789-abcd-ef0123456789",
      );
      expect(userResult.assigneeEmail).toBe("user1@example.com");

      const groupResult = body.data.assignments.find(
        (a: { principalType: string }) => a.principalType === "GROUP",
      );
      expect(groupResult.principalId).toBe(
        "b1c2d3e4-f5a6-7890-bcde-f01234567890",
      );
      expect(groupResult.displayName).toBe("Engineering Team");
    });

    it("should call getAssignmentsForLease with the lease UUID", async () => {
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });

      const getAssignmentsSpy = vi
        .spyOn(DynamoPrincipalStore.prototype, "getAssignmentsForLease")
        .mockResolvedValue({
          result: [],
          nextPageIdentifier: null,
        });

      const event = createGetAssignmentsEvent(leaseId, isbAuthorizedUser.user);

      await handler(event, mockAuthorizedContext(testEnv, mockedGlobalConfig));

      expect(getAssignmentsSpy).toHaveBeenCalledWith({
        leaseId: leaseUuid,
      });
    });
  });

  describe("PUT /leases/{leaseId}/assignments", () => {
    const putLeaseKey = generateSchemaData(LeaseKeySchema);
    const putOwnerEmail = putLeaseKey.userEmail;
    const putLeaseId = putLeaseKey.uuid;
    const putLeaseCompositeKey = base64EncodeCompositeKey(putLeaseKey)!;
    const putOwnerIdcId = "a1b2c3d4e5-550e8400-e29b-41d4-a716-446655440000";

    const putActiveLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      userEmail: putOwnerEmail,
      uuid: putLeaseId,
      status: "Active",
      allowOwnerToShareLease: true,
    });

    function stubServiceToSucceed() {
      vi.spyOn(
        DynamoPrincipalStore.prototype,
        "batchGetCacheItems",
      ).mockResolvedValue([
        generateSchemaData(PersistedPrincipalCacheItemSchema, {
          sk: `user#${putOwnerIdcId}`,
          principalId: putOwnerIdcId,
          principalType: "USER",
          email: putOwnerEmail,
        }),
      ]);
      vi.spyOn(
        IdcService.prototype,
        "getCachedPrincipalByAttr",
      ).mockResolvedValue({
        principalId: putOwnerIdcId,
        principalType: "USER",
        displayName: "Owner User",
        email: putOwnerEmail,
      });
      vi.spyOn(
        DynamoLeaseStore.prototype,
        "acquireLockWithDesiredAssignments",
      ).mockResolvedValue(MOCK_ACQUIRED_LOCK);
      vi.spyOn(DynamoLeaseStore.prototype, "releaseLock").mockResolvedValue(
        undefined,
      );
      vi.spyOn(
        IsbEventBridgeClient.prototype,
        "sendIsbEvent",
      ).mockResolvedValue(undefined as any);
    }

    function createPutEvent(
      body: unknown,
      user: IsbUser = isbAuthorizedUser.user,
    ) {
      return createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: `/leases/${putLeaseCompositeKey}/assignments`,
        pathParameters: { leaseId: putLeaseCompositeKey },
        body: JSON.stringify(body),
        isbUser: user,
      });
    }

    describe("request validation", () => {
      it("should return 400 for missing assignments field", async () => {
        const event = createPutEvent({});
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );
        expect(response.statusCode).toBe(400);
      });

      it("should return 400 when assignments is not an array", async () => {
        const event = createPutEvent({ assignments: "not-an-array" });
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );
        expect(response.statusCode).toBe(400);
      });

      it("should return 400 for invalid principalType", async () => {
        const event = createPutEvent({
          assignments: [{ principalId: "user-1", principalType: "INVALID" }],
        });
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );
        expect(response.statusCode).toBe(400);
      });
    });

    describe("feature flag", () => {
      it("should return 403 when leaseSharingEnabled is false for non-admin user", async () => {
        mockedGlobalConfig.leases.leaseSharingEnabled = false;
        mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: putActiveLease as any,
        });

        const ownerUser: IsbUser = {
          type: "user",
          email: putOwnerEmail,
          roles: ["User"],
          userId: "owner-idc-id",
        };

        const event = createPutEvent(
          {
            assignments: [
              { principalId: putOwnerIdcId, principalType: "USER" },
            ],
          },
          ownerUser,
        );
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(403);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].message).toContain("not enabled");
      });

      it("should allow Admin even when leaseSharingEnabled is false", async () => {
        mockedGlobalConfig.leases.leaseSharingEnabled = false;
        mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: putActiveLease as any,
        });
        stubServiceToSucceed();

        const event = createPutEvent({
          assignments: [{ principalId: putOwnerIdcId, principalType: "USER" }],
        });
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(202);
      });
    });

    describe("group assignment mode", () => {
      it("should reject a new group assignment for an admin", async () => {
        mockedGlobalConfig.leases.groupAssignmentMode = "NONE";
        mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: { ...putActiveLease, desiredAssignments: [] } as any,
        });

        const event = createPutEvent({
          assignments: [
            {
              principalId: crypto.randomUUID(),
              principalType: "GROUP",
            },
          ],
        });
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].message).toContain(
          "New group assignments are not enabled",
        );
      });

      it("should allow an existing group assignment to be removed", async () => {
        mockedGlobalConfig.leases.groupAssignmentMode = "NONE";
        mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: {
            ...putActiveLease,
            desiredAssignments: [
              {
                principalId: crypto.randomUUID(),
                principalType: "GROUP",
              },
            ],
          } as any,
        });
        stubServiceToSucceed();

        const event = createPutEvent({
          assignments: [{ principalId: putOwnerIdcId, principalType: "USER" }],
        });
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(202);
      });
    });

    describe("lease fetch", () => {
      it("should return 404 when lease not found for an admin/manager", async () => {
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: undefined,
        });

        const event = createPutEvent({
          assignments: [{ principalId: putOwnerIdcId, principalType: "USER" }],
        });
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(404);
      });

      it("should return 403 (not 404) for a non-elevated non-owner when the lease does not exist", async () => {
        // Existence oracle guard: a plain User must not be able to tell a
        // missing lease (404) apart from one they simply cannot manage (403).
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: undefined,
        });

        const otherUser: IsbUser = {
          type: "user",
          email: "other@example.com",
          roles: ["User"],
          userId: "other-idc-id",
        };

        const event = createPutEvent(
          {
            assignments: [
              { principalId: putOwnerIdcId, principalType: "USER" },
            ],
          },
          otherUser,
        );
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(403);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].message).toBe(
          "Active user is not authorized to manage assignments for this lease.",
        );
      });
    });

    describe("authorization", () => {
      it("should return 403 for non-owner non-elevated user", async () => {
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: putActiveLease as any,
        });

        const otherUser: IsbUser = {
          type: "user",
          email: "other@example.com",
          roles: ["User"],
          userId: "other-idc-id",
        };

        const event = createPutEvent(
          {
            assignments: [
              { principalId: putOwnerIdcId, principalType: "USER" },
            ],
          },
          otherUser,
        );
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(403);
      });

      it("should return 403 when owner does not have allowOwnerToShareLease", async () => {
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: { ...putActiveLease, allowOwnerToShareLease: false } as any,
        });

        const ownerUser: IsbUser = {
          type: "user",
          email: putOwnerEmail,
          roles: ["User"],
          userId: "owner-idc-id",
        };

        const event = createPutEvent(
          {
            assignments: [
              { principalId: putOwnerIdcId, principalType: "USER" },
            ],
          },
          ownerUser,
        );
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(403);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].message).toContain(
          "Owner sharing is not enabled",
        );
      });

      it("should allow Admin even when allowOwnerToShareLease is false", async () => {
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: { ...putActiveLease, allowOwnerToShareLease: false } as any,
        });
        stubServiceToSucceed();

        const event = createPutEvent({
          assignments: [{ principalId: putOwnerIdcId, principalType: "USER" }],
        });
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(202);
      });

      it("should allow a non-elevated owner when sharing is enabled", async () => {
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: putActiveLease as any,
        });
        stubServiceToSucceed();

        const ownerUser: IsbUser = {
          type: "user",
          email: putOwnerEmail,
          roles: ["User"],
          userId: "owner-idc-id",
        };

        const event = createPutEvent(
          {
            assignments: [
              { principalId: putOwnerIdcId, principalType: "USER" },
            ],
          },
          ownerUser,
        );
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(202);
      });
    });

    describe("lease status", () => {
      it("should return 409 when lease is Frozen", async () => {
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: { ...putActiveLease, status: "Frozen" } as any,
        });

        const event = createPutEvent({
          assignments: [{ principalId: putOwnerIdcId, principalType: "USER" }],
        });
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(409);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].message).toContain(
          "not in an active status",
        );
      });

      it("should return 409 when lease is Expired", async () => {
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: { ...putActiveLease, status: "Expired" } as any,
        });

        const event = createPutEvent({
          assignments: [{ principalId: putOwnerIdcId, principalType: "USER" }],
        });
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(409);
      });
    });

    describe("error mapping", () => {
      it("should return 400 when owner cannot be resolved from existing desiredAssignments", async () => {
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: putActiveLease as any,
        });
        // Owner resolution fails — getCachedPrincipalByAttr returns null
        vi.spyOn(
          IdcService.prototype,
          "getCachedPrincipalByAttr",
        ).mockResolvedValue(undefined);

        const event = createPutEvent({
          assignments: [
            {
              principalId: "b2c3d4e5f6-660e8400-e29b-41d4-a716-446655440099",
              principalType: "USER",
            },
          ],
        });
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(500);
      });

      it("should map ResourceLockConflictError to 409", async () => {
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: putActiveLease as any,
        });
        vi.spyOn(
          IdcService.prototype,
          "getCachedPrincipalByAttr",
        ).mockResolvedValue({
          principalId: putOwnerIdcId,
          principalType: "USER",
          displayName: "Owner User",
          email: putOwnerEmail,
        });
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "batchGetCacheItems",
        ).mockResolvedValue([
          generateSchemaData(PersistedPrincipalCacheItemSchema, {
            sk: `user#${putOwnerIdcId}`,
            principalId: putOwnerIdcId,
            principalType: "USER",
            email: putOwnerEmail,
          }),
        ]);
        vi.spyOn(
          DynamoLeaseStore.prototype,
          "acquireLockWithDesiredAssignments",
        ).mockRejectedValue(new ResourceLockConflictError("Lock held"));

        const event = createPutEvent({
          assignments: [{ principalId: putOwnerIdcId, principalType: "USER" }],
        });
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(409);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].message).toContain("Another operation");
      });

      it("should map MaxAssignmentsExceededError to 400", async () => {
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: putActiveLease as any,
        });
        vi.spyOn(
          IdcService.prototype,
          "getCachedPrincipalByAttr",
        ).mockResolvedValue({
          principalId: putOwnerIdcId,
          principalType: "USER",
          displayName: "Owner User",
          email: putOwnerEmail,
        });
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "batchGetCacheItems",
        ).mockResolvedValue([
          generateSchemaData(PersistedPrincipalCacheItemSchema, {
            sk: `user#${putOwnerIdcId}`,
            principalId: putOwnerIdcId,
            principalType: "USER",
            email: putOwnerEmail,
          }),
        ]);
        vi.spyOn(
          DynamoLeaseStore.prototype,
          "acquireLockWithDesiredAssignments",
        ).mockRejectedValue(
          new MaxAssignmentsExceededError(
            "Maximum of 20 total assignments allowed.",
          ),
        );

        const event = createPutEvent({
          assignments: [{ principalId: putOwnerIdcId, principalType: "USER" }],
        });
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].message).toContain("Maximum of 20");
      });
    });

    describe("happy path", () => {
      it("should return 202 on successful delegation to service", async () => {
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: putActiveLease as any,
        });
        vi.spyOn(
          IdcService.prototype,
          "getCachedPrincipalByAttr",
        ).mockResolvedValue({
          principalId: putOwnerIdcId,
          principalType: "USER",
          displayName: "Owner User",
          email: putOwnerEmail,
        });
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "batchGetCacheItems",
        ).mockResolvedValue([
          generateSchemaData(PersistedPrincipalCacheItemSchema, {
            sk: `user#${putOwnerIdcId}`,
            principalId: putOwnerIdcId,
            principalType: "USER",
            email: putOwnerEmail,
          }),
          generateSchemaData(PersistedPrincipalCacheItemSchema, {
            sk: "user#c3d4e5f6a7-770e8400-e29b-41d4-a716-446655440088",
            principalId: "c3d4e5f6a7-770e8400-e29b-41d4-a716-446655440088",
            principalType: "USER",
            email: "seconduser@example.com",
          }),
        ]);
        vi.spyOn(
          DynamoLeaseStore.prototype,
          "acquireLockWithDesiredAssignments",
        ).mockResolvedValue(MOCK_ACQUIRED_LOCK);
        vi.spyOn(
          IsbEventBridgeClient.prototype,
          "sendIsbEvent",
        ).mockResolvedValue(undefined as any);

        const event = createPutEvent({
          assignments: [
            {
              principalId: "c3d4e5f6a7-770e8400-e29b-41d4-a716-446655440088",
              principalType: "USER",
            },
          ],
        });
        const response = await handler(
          event,
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(202);
        const body = JSON.parse(response.body);
        expect(body.status).toBe("success");
        expect(body.data).toHaveProperty("desiredCount");
      });
    });
  });

  describe("GET /leases/shared", () => {
    const sharedUserId = randomUUID();
    const otherUserId = randomUUID();

    const sharedLease = generateSchemaData(PersistedLeaseSchema, {
      status: "Active",
    });

    function buildSharedEvent(
      queryStringParameters: Record<string, string>,
      user: IsbUser = isbAuthorizedUser.user,
    ) {
      return createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/leases/shared",
        queryStringParameters,
        isbUser: user,
      });
    }

    // Literal-over-label routing precedence: the generated mux binds both
    // `/leases/shared` (ListSharedLeases) and `/leases/{leaseId}` (GetLease).
    // `preferLiteralRoutes` (in the handler) ensures `GET /leases/shared` reaches
    // ListSharedLeases rather than GetLease with `leaseId="shared"` — mirrors the
    // accounts `/accounts/unregistered` literal-routing test. Without it the
    // request would decode "shared" as a composite key and 400/404 via GetLease.
    it("routes GET /leases/shared to ListSharedLeases, not GetLease", async () => {
      const listSharedSpy = vi
        .spyOn(DynamoPrincipalStore.prototype, "getDirectAssignmentsForUser")
        .mockResolvedValue({ result: [], nextPageIdentifier: null });
      const getLeaseSpy = vi.spyOn(DynamoLeaseStore.prototype, "get");

      const response = await handler(
        buildSharedEvent({ userId: sharedUserId, accessType: "direct" }),
        mockAuthorizedContext(testEnv, mockedGlobalConfig),
      );

      // Reached the shared-leases path (200 + the ListSharedLeases store call)...
      expect(response.statusCode).toBe(200);
      expect(listSharedSpy).toHaveBeenCalledOnce();
      // ...and never fell through to GetLease's single-lease fetch (which would
      // have tried to decode "shared" as a leaseId composite key).
      expect(getLeaseSpy).not.toHaveBeenCalled();
    });

    describe("?accessType=direct", () => {
      it("maps public maxResults to internal pageSize", async () => {
        const getDirectAssignmentsSpy = vi
          .spyOn(DynamoPrincipalStore.prototype, "getDirectAssignmentsForUser")
          .mockResolvedValue({ result: [], nextPageIdentifier: null });

        const response = await handler(
          buildSharedEvent({
            userId: sharedUserId,
            accessType: "direct",
            pageIdentifier: "next-page",
            maxResults: "7",
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(200);
        expect(getDirectAssignmentsSpy).toHaveBeenCalledWith({
          userId: sharedUserId,
          pageIdentifier: "next-page",
          pageSize: 7,
        });
      });

      it("returns 200 with direct-tagged leases", async () => {
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "getDirectAssignmentsForUser",
        ).mockResolvedValue({
          result: [
            {
              pk: `user#${sharedUserId}`,
              sk: `lease#${sharedLease.uuid}`,
              userId: sharedUserId,
              principalType: "USER" as const,
              leaseId: sharedLease.uuid,
              assigneeEmail: "me@example.com",
              leaseOwnerEmail: sharedLease.userEmail,
              addedBy: "admin@example.com",
              addedDate: datetimeAsString(now()),
            },
          ],
          nextPageIdentifier: null,
        });
        vi.spyOn(DynamoLeaseStore.prototype, "batchGet").mockResolvedValue([
          sharedLease,
        ]);

        const response = await handler(
          buildSharedEvent({
            userId: sharedUserId,
            accessType: "direct",
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.status).toBe("success");
        expect(body.data.result).toHaveLength(1);
        expect(body.data.result[0].uuid).toBe(sharedLease.uuid);
        expect(body.data.result[0].accessType).toBe("direct");
        // I19: assert exact base64-encoded leaseId, not just truthiness.
        expect(body.data.result[0].leaseId).toBe(
          base64EncodeCompositeKey({
            userEmail: sharedLease.userEmail,
            uuid: sharedLease.uuid,
          }),
        );
        // Accepted deviation: the restJson1 serializer drops null members, so an
        // absent nextPageIdentifier is undefined on the wire, not null.
        expect(body.data.nextPageIdentifier).toBeUndefined();
      });

      it("returns empty result when user has no direct assignments", async () => {
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "getDirectAssignmentsForUser",
        ).mockResolvedValue({ result: [], nextPageIdentifier: null });

        const response = await handler(
          buildSharedEvent({
            userId: sharedUserId,
            accessType: "direct",
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.data.result).toEqual([]);
        // Accepted deviation: the restJson1 serializer drops null members, so an
        // absent nextPageIdentifier is undefined on the wire, not null.
        expect(body.data.nextPageIdentifier).toBeUndefined();
      });
    });

    describe("?accessType=group", () => {
      it("maps public maxResults to group pagination pageSize", async () => {
        const groupId = randomUUID();
        const secondSharedLease = generateSchemaData(PersistedLeaseSchema, {
          status: "Active",
        });
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "getGroupMembershipCache",
        ).mockResolvedValue({
          result: {
            pk: `user#${sharedUserId}`,
            sk: "groupMembership",
            groupIds: [groupId],
            ttl: now().plus({ hours: 23 }).toUnixInteger(),
          },
        });
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "getAllGroupAssignmentKeys",
        ).mockResolvedValue([
          { groupId, leaseId: sharedLease.uuid },
          { groupId, leaseId: secondSharedLease.uuid },
        ]);
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "batchGetGroupAssignments",
        ).mockResolvedValue([
          {
            pk: `group#${groupId}`,
            sk: `lease#${sharedLease.uuid}`,
            leaseId: sharedLease.uuid,
            groupId,
            principalType: "GROUP" as const,
            displayName: "Engineers",
            leaseOwnerEmail: sharedLease.userEmail,
            addedBy: "admin@example.com",
            addedDate: datetimeAsString(now()),
          },
          {
            pk: `group#${groupId}`,
            sk: `lease#${secondSharedLease.uuid}`,
            leaseId: secondSharedLease.uuid,
            groupId,
            principalType: "GROUP" as const,
            displayName: "Engineers",
            leaseOwnerEmail: secondSharedLease.userEmail,
            addedBy: "admin@example.com",
            addedDate: datetimeAsString(now()),
          },
        ]);
        const batchGetSpy = vi
          .spyOn(DynamoLeaseStore.prototype, "batchGet")
          .mockResolvedValue([sharedLease, secondSharedLease]);

        const response = await handler(
          buildSharedEvent({
            userId: sharedUserId,
            accessType: "group",
            maxResults: "1",
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(200);
        expect(batchGetSpy).toHaveBeenCalledOnce();
        expect(batchGetSpy.mock.calls[0]![0]).toHaveLength(1);
        const body = JSON.parse(response.body);
        expect(body.data.result).toHaveLength(1);
        expect(body.data.nextPageIdentifier).toEqual(expect.any(String));
      });

      it("returns 200 with group-tagged leases", async () => {
        const groupId = randomUUID();
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "getGroupMembershipCache",
        ).mockResolvedValue({
          result: {
            pk: `user#${sharedUserId}`,
            sk: "groupMembership",
            groupIds: [groupId],
            ttl: now().plus({ hours: 23 }).toUnixInteger(),
          },
        });
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "getAllGroupAssignmentKeys",
        ).mockResolvedValue([{ groupId, leaseId: sharedLease.uuid }]);
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "batchGetGroupAssignments",
        ).mockResolvedValue([
          {
            pk: `group#${groupId}`,
            sk: `lease#${sharedLease.uuid}`,
            leaseId: sharedLease.uuid,
            groupId,
            principalType: "GROUP" as const,
            displayName: "Engineers",
            leaseOwnerEmail: sharedLease.userEmail,
            addedBy: "admin@example.com",
            addedDate: datetimeAsString(now()),
          },
        ]);
        vi.spyOn(DynamoLeaseStore.prototype, "batchGet").mockResolvedValue([
          sharedLease,
        ]);

        const response = await handler(
          buildSharedEvent({
            userId: sharedUserId,
            accessType: "group",
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.data.result).toHaveLength(1);
        expect(body.data.result[0].uuid).toBe(sharedLease.uuid);
        expect(body.data.result[0].accessType).toBe("group");
        expect(body.data.result[0].sourceGroupName).toBe("Engineers");
      });

      it("returns empty result when user belongs to no groups", async () => {
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "getGroupMembershipCache",
        ).mockResolvedValue({
          result: {
            pk: `user#${sharedUserId}`,
            sk: "groupMembership",
            groupIds: [],
            ttl: now().plus({ hours: 23 }).toUnixInteger(),
          },
        });
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "getAllGroupAssignmentKeys",
        ).mockResolvedValue([]);
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "batchGetGroupAssignments",
        ).mockResolvedValue([]);

        const response = await handler(
          buildSharedEvent({
            userId: sharedUserId,
            accessType: "group",
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.data.result).toEqual([]);
      });
    });

    describe("pagination defaults", () => {
      it("defaults pageSize to 100 for direct access when maxResults is omitted", async () => {
        // The operation passes `maxResults ?? 100`. The service's OWN default is 50,
        // so observing a downstream pageSize of 100 proves the OPERATION applied the
        // 100 default (not the service's 50) — the pre-Smithy `/leases/shared` cap.
        const getDirectAssignmentsSpy = vi
          .spyOn(DynamoPrincipalStore.prototype, "getDirectAssignmentsForUser")
          .mockResolvedValue({ result: [], nextPageIdentifier: null });

        const response = await handler(
          buildSharedEvent({ userId: sharedUserId, accessType: "direct" }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(200);
        expect(getDirectAssignmentsSpy).toHaveBeenCalledWith({
          userId: sharedUserId,
          pageIdentifier: undefined,
          pageSize: 100,
        });
      });

      it("defaults pageSize to 100 for group access when maxResults is omitted", async () => {
        // Group access slices in memory (no store pageSize arg), so assert the
        // service call args directly: the operation must pass pageSize 100.
        const viaGroupsSpy = vi
          .spyOn(leaseAssignment, "getLeasesForUserViaGroups")
          .mockResolvedValue({ result: [], nextPageIdentifier: null });

        const response = await handler(
          buildSharedEvent({ userId: sharedUserId, accessType: "group" }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(200);
        expect(viaGroupsSpy.mock.calls[0]![0]).toEqual(
          expect.objectContaining({ pageSize: 100 }),
        );
      });
    });

    describe("validation and authorization", () => {
      // C6: positive-path test for the only narrow auth branch — User role
      // querying their own userId must be allowed.
      it("allows a User-role IDC user to query their own shared leases", async () => {
        const ownUserId = randomUUID();
        const ownUser: IsbUser = {
          type: "user",
          email: "own.user@example.com",
          userId: ownUserId,
          roles: ["User"],
        };
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "getDirectAssignmentsForUser",
        ).mockResolvedValue({ result: [], nextPageIdentifier: null });

        const response = await handler(
          buildSharedEvent(
            { userId: ownUserId, accessType: "direct" },
            ownUser,
          ),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(200);
      });

      it("returns 403 when a non-elevated user queries another user's shared leases", async () => {
        const response = await handler(
          buildSharedEvent(
            {
              userId: otherUserId,
              accessType: "direct",
            },
            isbAuthorizedUserUserRoleOnly.user,
          ),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(403);
      });

      it("allows Admin/Manager to query shared leases for another user", async () => {
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "getDirectAssignmentsForUser",
        ).mockResolvedValue({
          result: [],
          nextPageIdentifier: null,
        });

        const response = await handler(
          buildSharedEvent({
            userId: otherUserId,
            accessType: "direct",
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(200);
      });

      // C7: M2M without elevated roles must be rejected. M2M users have
      // `clientId` (not `userId`), so the predicate must short-circuit on
      // `isM2MUser` before reading `context.user.userId`.
      it("returns 403 for an M2M caller without Admin/Manager role", async () => {
        const response = await handler(
          buildSharedEvent(
            { userId: sharedUserId, accessType: "direct" },
            m2mUserRoleOnlyUser,
          ),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(403);
      });

      it("allows an M2M caller with Admin role", async () => {
        vi.spyOn(
          DynamoPrincipalStore.prototype,
          "getDirectAssignmentsForUser",
        ).mockResolvedValue({ result: [], nextPageIdentifier: null });

        const response = await handler(
          buildSharedEvent(
            { userId: sharedUserId, accessType: "direct" },
            m2mAdminUser,
          ),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(200);
      });

      it("returns 400 when userId query param is missing", async () => {
        const response = await handler(
          buildSharedEvent({ accessType: "direct" }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
      });

      // I9: userId is now constrained to UUID — non-UUID values are rejected.
      it("returns 400 when userId query param is not a UUID", async () => {
        const response = await handler(
          buildSharedEvent({
            userId: "not-a-uuid",
            accessType: "direct",
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
      });

      it("returns 400 when accessType query param is missing", async () => {
        const response = await handler(
          buildSharedEvent({ userId: sharedUserId }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
      });

      it("returns 400 when accessType is not direct or group", async () => {
        const response = await handler(
          buildSharedEvent({
            userId: sharedUserId,
            accessType: "BOTH",
          }),
          mockAuthorizedContext(testEnv, mockedGlobalConfig),
        );

        expect(response.statusCode).toBe(400);
      });
    });
  });
});
