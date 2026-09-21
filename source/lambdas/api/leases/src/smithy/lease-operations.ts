// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { DateTime } from "luxon";
import { z } from "zod";

import {
  base64DecodeCompositeKey,
  base64EncodeCompositeKey,
} from "@amzn/innovation-sandbox-commons/data/encoding.js";
import {
  ResourceLockConflictError,
  UnknownItem,
} from "@amzn/innovation-sandbox-commons/data/errors.js";
import {
  validateLeaseCompliesWithGlobalConfig,
  ValidationException,
} from "@amzn/innovation-sandbox-commons/data/global-config/global-config-utils.js";
import { type GlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { LeaseTemplateStore } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template-store.js";
import {
  PersistedLease,
  PersistedMonitoredLeaseSchema,
  PersistedPendingLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { validateCostReportGroup } from "@amzn/innovation-sandbox-commons/data/reporting-config/reporting-config-utils.js";
import {
  collect,
  stream,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import {
  AccountNotInActiveError,
  AccountNotInFrozenError,
  CouldNotFindAccountError,
  CouldNotRetrieveUserError,
  InnovationSandbox,
  IsbContext,
  LeaseRequestRateLimitExceededError,
  MaxNumberOfLeasesExceededError,
  NoAccountsAvailableError,
} from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import { IdcService } from "@amzn/innovation-sandbox-commons/isb-services/idc-service.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  deriveAssignmentView,
  getLeasesForUserDirect,
  getLeasesForUserViaGroups,
  MaxAssignmentsExceededError,
  triggerAssignmentProcessing,
} from "@amzn/innovation-sandbox-commons/isb-services/lease-assignment/index.js";
import { LeaseLambdaEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-lambda-environment.js";
import {
  createHttpJSendError,
  createHttpJSendValidationError,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import { rejectIfAssigneeIsM2m } from "@amzn/innovation-sandbox-commons/lambda/middleware/m2m-guard.js";
import { withDelegatedErrors } from "@amzn/innovation-sandbox-commons/lambda/smithy/api-gateway-handler.js";
import { IsbSmithyContext } from "@amzn/innovation-sandbox-commons/lambda/smithy/isb-smithy-context.js";
import { parseRawJsonBody } from "@amzn/innovation-sandbox-commons/lambda/smithy/parse-raw-json-body.js";
import {
  LogPatterns,
  logTaggingFailure,
  summarizeUpdate,
} from "@amzn/innovation-sandbox-commons/observability/logging.js";
import {
  fromTemporaryIsbIdcCredentials,
  fromTemporaryIsbOrgManagementCredentials,
} from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import { NO_COST_REPORT_GROUP_TAG_VALUE } from "@amzn/innovation-sandbox-commons/utils/isb-account-tags.js";
import { enumErrorMap } from "@amzn/innovation-sandbox-commons/utils/zod.js";
import {
  type DesiredAssignment,
  DesiredAssignmentSchema,
  isActiveLease,
  isFrozenLease,
  isMonitoredLease,
  isPendingLease,
  LEASE_NOT_PENDING_REVIEW_ERROR,
  LeaseKeySchema,
  MAX_USER_MANAGED_ASSIGNMENTS,
  MonitoredLeaseStatusSchema,
} from "@amzn/innovation-sandbox-shared/types/lease.js";
import {
  IdcPrincipalIdSchema,
  PrincipalTypeSchema,
} from "@amzn/innovation-sandbox-shared/types/principal.js";
import {
  type IsbUser,
  getUserEmail,
  isIdcUser,
  isM2MUser,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";
import { findDisallowedGroupAssignments } from "@amzn/innovation-sandbox-shared/utils/group-assignment-policy.js";

import type {
  FreezeLeaseServerInput,
  FreezeLeaseServerOutput,
  GetLeaseAssignmentsServerInput,
  GetLeaseAssignmentsServerOutput,
  GetLeaseServerInput,
  GetLeaseServerOutput,
  LeasesApiService,
  ListLeasesServerInput,
  ListLeasesServerOutput,
  ListSharedLeasesServerInput,
  ListSharedLeasesServerOutput,
  RequestLeaseServerInput,
  RequestLeaseServerOutput,
  ReviewLeaseServerInput,
  ReviewLeaseServerOutput,
  TerminateLeaseServerInput,
  TerminateLeaseServerOutput,
  UnfreezeLeaseServerInput,
  UnfreezeLeaseServerOutput,
  UpdateLeaseAssignmentsServerInput,
  UpdateLeaseAssignmentsServerOutput,
  UpdateLeaseServerInput,
  UpdateLeaseServerOutput,
} from "@amzn/innovation-sandbox-api-server/leases";
import { JSendStatus } from "@amzn/innovation-sandbox-api-server/leases";

export type LeasesSmithyContext = IsbSmithyContext<LeaseLambdaEnvironment>;

type LeaseLambdaContext = LeasesSmithyContext["lambdaContext"];

const tracer = new Tracer();

// Pre-Smithy pagination defaults (the pre-Smithy query schemas applied `maxResults`
// defaults). The model validates the range (`@range(min:1,max:2000)` /
// `@range(min:1,max:100)`); the operation applies the default when `maxResults` is
// absent — defaults are operation behavior, not model traits, so they stay here
// (mirroring the Accounts operations' `LIST_*_DEFAULT_MAX` consts).
const LIST_LEASES_DEFAULT_MAX = 2000;
const LIST_SHARED_LEASES_DEFAULT_MAX = 100;

// Module-scoped so the "lease request window capped" warning is logged at most
// once per Lambda container, exactly as the pre-Smithy handler did.
let leaseRequestWindowCappedLogged = false;

// ---------------------------------------------------------------------------
// Shared response / context / fetch helpers
// ---------------------------------------------------------------------------

/**
 * Build a JSend HTTP error carrying a single `errors[].message` — the shape every
 * lease operation returns. `extraData` merges extra top-level `data` members (the
 * 429's `retryAt`). Returns the error; callers `throw` it (a couple capture it
 * first, e.g. the terminate 403).
 */
function jsendError(
  statusCode: number,
  message: string,
  extraData?: Record<string, unknown>,
) {
  return createHttpJSendError({
    statusCode,
    data: { errors: [{ message }], ...extraData },
  });
}

/**
 * The IsbServices + cross-account-credentials bundle shared by the write and
 * lifecycle operations. Each caller spreads it and adds its own extras — the
 * event-bridge member name differs (`eventBridgeClient` vs `isbEventBridgeClient`)
 * and some add blueprint / global-config / template members.
 */
function baseLeaseIsbContext(env: LeaseLambdaContext["env"], logger: Logger) {
  return {
    logger,
    tracer,
    leaseStore: IsbServices.leaseStore(env),
    sandboxAccountStore: IsbServices.sandboxAccountStore(env),
    idcService: IsbServices.idcService(
      env,
      fromTemporaryIsbIdcCredentials(env),
    ),
    orgsService: IsbServices.orgsService(
      env,
      fromTemporaryIsbOrgManagementCredentials(env),
    ),
    organizationsTaggingService: IsbServices.organizationsTaggingService(
      env,
      fromTemporaryIsbOrgManagementCredentials(env),
    ),
  };
}

/**
 * Fetch a lease by its base64 composite-key `{leaseId}` label, logging a store
 * read error exactly as the pre-Smithy handler did. Does NOT throw on a missing
 * lease — callers decide 404 vs 403-before-404 (`terminateLease` authorizes first).
 */
async function fetchLease(
  leaseStore: ReturnType<typeof IsbServices.leaseStore>,
  leaseId: string,
  logger: Logger,
) {
  const leaseCompositeKey = parseLeaseCompositeKey(leaseId);
  const leaseResponse = await leaseStore.get(leaseCompositeKey);
  if (leaseResponse.error) {
    logger.warn(
      `Error retrieving lease ${JSON.stringify(leaseCompositeKey)}: ${leaseResponse.error}`,
    );
  }
  return { leaseCompositeKey, lease: leaseResponse.result };
}

/** `fetchLease` plus the shared 404 when the lease is absent. */
async function fetchLeaseOrThrow404(
  leaseStore: ReturnType<typeof IsbServices.leaseStore>,
  leaseId: string,
  logger: Logger,
) {
  const { lease } = await fetchLease(leaseStore, leaseId, logger);
  if (!lease) {
    throw jsendError(404, "Lease not found.");
  }
  return lease;
}

// ---------------------------------------------------------------------------
// Shared helpers (ported verbatim from the pre-Smithy handler)
// ---------------------------------------------------------------------------

/**
 * Decode the base64url `{leaseId}` label and re-parse it with `LeaseKeySchema`.
 * The model's `@pattern("^[A-Za-z0-9_-]+$")` on `LeaseId` already rejects a
 * label that is not URL-safe base64 (as the pre-Smithy `PathParametersSchema`
 * regex did), so this retained Zod supplement owns only the two remaining
 * checks: a base64 decode failure → the pre-Smithy 400, and the decoded
 * composite key failing `LeaseKeySchema` → the pre-Smithy validation 400.
 */
function parseLeaseCompositeKey(leaseId: string) {
  // leaseId is a base64url-encoded composite key (URL-safe alphabet, no padding).
  let decodedCompositeKey: Record<string, any> | undefined;
  try {
    decodedCompositeKey = base64DecodeCompositeKey(leaseId);
  } catch {
    throw createHttpJSendError({
      statusCode: 400,
      data: {
        errors: [{ message: "LeaseId path parameter provided is invalid." }],
      },
    });
  }

  const leaseKeySchemaParseResponse =
    LeaseKeySchema.safeParse(decodedCompositeKey);

  if (!leaseKeySchemaParseResponse.success)
    throw createHttpJSendValidationError(leaseKeySchemaParseResponse.error);

  return leaseKeySchemaParseResponse.data;
}

/**
 * Returns true if the user has Admin or Manager role.
 */
function isAdminOrManager(user: IsbUser) {
  return user.roles.includes("Admin") || user.roles.includes("Manager");
}

/**
 * Returns true if the user has read access to a lease.
 * Access is granted if the user is Admin/Manager, the lease owner,
 * or has shared access via desiredAssignments (direct user or group membership).
 */
async function hasReadAccessForLease(
  user: IsbUser,
  lease: PersistedLease,
  getPrincipalStore: () => ReturnType<typeof IsbServices.principalStore>,
): Promise<boolean> {
  // Admin/Manager can view any lease
  if (isAdminOrManager(user)) {
    return true;
  }

  // Owner can view their own lease
  if (getUserEmail(user) === lease.userEmail) {
    return true;
  }

  // Check shared access via desiredAssignments
  if (!isIdcUser(user) || !lease.desiredAssignments?.length) {
    return false;
  }

  const userId = user.userId;

  // Direct user assignment
  if (
    lease.desiredAssignments.some(
      (a) => a.principalType === "USER" && a.principalId === userId,
    )
  ) {
    return true;
  }

  // Group-based assignment via cached group memberships
  const groupAssignments = lease.desiredAssignments.filter(
    (a) => a.principalType === "GROUP",
  );
  if (groupAssignments.length === 0) {
    return false;
  }

  const principalStore = getPrincipalStore();
  const membershipCache = await principalStore.getGroupMembershipCache(userId);
  const userGroupIds = membershipCache.result?.groupIds ?? [];
  if (userGroupIds.length === 0) {
    return false;
  }

  return groupAssignments.some((a) => userGroupIds.includes(a.principalId));
}

/**
 * Asserts the caller has permission to manage assignments for a lease.
 * Admin/Manager can always manage. Owner can manage only if lease sharing is
 * enabled globally and allowOwnerToShareLease is set on the lease.
 *
 * Callers must already have confirmed the caller is elevated or the lease
 * owner (see updateLeaseAssignments); this only enforces the sharing flags.
 */
function assertCallerCanManageAssignments(
  user: IsbUser,
  globalConfig: GlobalConfig,
  lease: PersistedLease,
): void {
  // Admin/Manager always have access regardless of global flag
  if (isAdminOrManager(user)) return;

  // For non-elevated owners, check the global flag
  if (!globalConfig.leases.leaseSharingEnabled) {
    throw createHttpJSendError({
      statusCode: 403,
      data: {
        errors: [{ message: "Lease sharing is not enabled." }],
      },
    });
  }

  if (!lease.allowOwnerToShareLease) {
    throw createHttpJSendError({
      statusCode: 403,
      data: {
        errors: [{ message: "Owner sharing is not enabled for this lease." }],
      },
    });
  }
}

function assertGroupAssignmentsAllowed(
  globalConfig: GlobalConfig,
  desiredAssignments: readonly DesiredAssignment[],
  options: {
    existingAssignments?: readonly DesiredAssignment[];
    message?: string;
  } = {},
): void {
  const {
    existingAssignments = [],
    message = "New group assignments are not enabled.",
  } = options;
  const disallowed = findDisallowedGroupAssignments(
    globalConfig.leases.groupAssignmentMode,
    desiredAssignments,
    existingAssignments,
  );
  if (disallowed.length === 0) return;

  throw createHttpJSendError({
    statusCode: 400,
    data: { errors: [{ message }] },
  });
}

/**
 * Throws 403 if a user-only caller is not permitted to terminate this lease.
 * Run before the 404 check so existence isn't leaked to unauthorized callers.
 */
function authorizeTermination(
  user: IsbUser,
  lease: PersistedLease | undefined,
  globalConfig: GlobalConfig,
): { isUserOnly: boolean } {
  if (isAdminOrManager(user)) return { isUserOnly: false };

  const forbidden = createHttpJSendError({
    statusCode: 403,
    data: {
      errors: [{ message: "User is not authorized to terminate this lease." }],
    },
  });

  if (globalConfig.leases.allowUserLeaseTermination !== true) throw forbidden;
  if (lease?.userEmail !== getUserEmail(user)) throw forbidden;
  if (lease.status === "Frozen" || lease.status === "Provisioning")
    throw forbidden;

  return { isUserOnly: true };
}

/**
 * Shared freeze / unfreeze error mapping: a held resource lock → 409, a missing
 * account or user → 404, anything else rethrows. The caller-specific
 * `AccountNotIn{Active,Frozen}Error` status guard is handled before this.
 */
function mapLeaseLockError(error: unknown): never {
  if (error instanceof ResourceLockConflictError) {
    throw jsendError(
      409,
      "Another operation is currently being processed for this lease. Try again once it completes.",
    );
  }
  if (
    error instanceof CouldNotFindAccountError ||
    error instanceof CouldNotRetrieveUserError
  ) {
    throw jsendError(404, error.message);
  }
  throw error;
}

/** Maps known terminateLease errors to HTTP responses; rethrows the rest. */
function mapTerminateError(error: unknown): never {
  if (error instanceof ResourceLockConflictError) {
    throw createHttpJSendError({
      statusCode: 409,
      data: {
        errors: [
          {
            message: "A termination is already being processed for this lease.",
          },
        ],
      },
    });
  }
  if (
    error instanceof CouldNotFindAccountError ||
    error instanceof CouldNotRetrieveUserError
  ) {
    throw createHttpJSendError({
      statusCode: 404,
      data: { errors: [{ message: error.message }] },
    });
  }
  throw error;
}

async function enforceLeaseRequestRateLimit(props: {
  logger: Logger;
  lambdaContext: LeaseLambdaContext;
  targetUserEmail: string;
  leaseStore: ReturnType<typeof IsbServices.leaseStore>;
}) {
  const { logger, lambdaContext, targetUserEmail, leaseStore } = props;

  // Admin/Manager callers are exempt from the rate limit.
  if (isAdminOrManager(lambdaContext.user)) {
    return;
  }

  const { leaseRequestWindowHours, maxLeaseRequestsPerWindow, ttl } =
    lambdaContext.globalConfig.leases;
  const ttlWindowHours = ttl * 24;
  const effectiveWindowHours = Math.min(
    leaseRequestWindowHours,
    ttlWindowHours,
  );
  if (
    leaseRequestWindowHours > ttlWindowHours &&
    !leaseRequestWindowCappedLogged
  ) {
    leaseRequestWindowCappedLogged = true;
    logger.warn("LeaseRequestWindowCapped", {
      logDetailType: "LeaseRequestWindowCapped",
      configuredWindowHours: leaseRequestWindowHours,
      ttlWindowHours,
      effectiveWindowHours,
    });
  }

  const windowStart = DateTime.utc().minus({ hours: effectiveWindowHours });
  const userLeases = await collect(
    stream(leaseStore, leaseStore.findByUserEmail, {
      userEmail: targetUserEmail,
    }),
  );

  const leasesInWindow = userLeases.filter((lease) => {
    if (
      lease.status === "PendingApproval" ||
      lease.status === "ApprovalDenied"
    ) {
      return false;
    }
    const createdTime = lease.meta?.createdTime;
    if (!createdTime) {
      return false;
    }
    return DateTime.fromISO(createdTime, { zone: "utc" }) >= windowStart;
  });

  if (leasesInWindow.length < maxLeaseRequestsPerWindow) {
    return;
  }

  // When count > limit (e.g. admin assignments pushed the user above the
  // limit), aging out only the earliest lease isn't enough to unblock.
  // Pick the Nth-oldest such that enough leases age out to drop the count
  // below the limit.
  const sortedTimes = leasesInWindow
    .map((lease) => lease.meta!.createdTime!)
    .sort((a, b) => a.localeCompare(b));
  const pivotIndex = leasesInWindow.length - maxLeaseRequestsPerWindow;
  const pivotTime = sortedTimes[pivotIndex];
  if (pivotTime === undefined) {
    throw new Error("Unable to determine the lease request retry time.");
  }
  const retryAt = DateTime.fromISO(pivotTime, { zone: "utc" })
    .plus({ hours: effectiveWindowHours })
    .toISO()!;

  logger.warn("LeaseRequestRateLimited", {
    logDetailType: "LeaseRequestRateLimited",
    targetUserEmail,
    callerEmail: getUserEmail(lambdaContext.user),
    currentCount: leasesInWindow.length,
    limit: maxLeaseRequestsPerWindow,
    retryAt,
    effectiveWindowHours,
  });

  throw new LeaseRequestRateLimitExceededError(
    `You have reached the maximum number of lease requests allowed within the rolling window (${maxLeaseRequestsPerWindow}). Try again at ${retryAt}.`,
    retryAt,
  );
}

async function validateAndGetLeaseTemplate(
  leaseTemplateUuid: string,
  requestingUser: IsbUser,
  isbContext: { leaseTemplateStore: LeaseTemplateStore },
) {
  const leaseTemplateResponse =
    await isbContext.leaseTemplateStore.get(leaseTemplateUuid);
  const leaseTemplate = leaseTemplateResponse.result;

  if (
    !leaseTemplate ||
    (leaseTemplate.visibility === "PRIVATE" &&
      !isAdminOrManager(requestingUser))
  ) {
    throw createHttpJSendError({
      statusCode: 404,
      data: {
        errors: [
          {
            message: "Lease template not found.",
          },
        ],
      },
    });
  }

  return leaseTemplate;
}

async function resolveTargetUser(
  userEmail: string | undefined,
  requestingUser: IsbUser,
  isbContext: IsbContext<{ idcService: IdcService }>,
): Promise<IsbUser> {
  // If no userEmail provided, use the requesting user
  if (!userEmail || userEmail === getUserEmail(requestingUser)) {
    return requestingUser;
  }

  // Cross-user lease creation - validate permissions
  if (!isAdminOrManager(requestingUser)) {
    throw createHttpJSendError({
      statusCode: 403,
      data: {
        errors: [
          {
            message:
              "Access denied. You do not have permission to create leases for other users.",
          },
        ],
      },
    });
  }

  // Validate that the target user exists in IDC
  const userResponse = await isbContext.idcService.getUserFromEmail(userEmail);
  if (!userResponse) {
    throw createHttpJSendError({
      statusCode: 404,
      data: {
        errors: [
          {
            message: "User not found in Identity Center",
          },
        ],
      },
    });
  }

  return userResponse;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
function listLeases(logger: Logger) {
  return async (
    input: ListLeasesServerInput,
    context: LeasesSmithyContext,
  ): Promise<ListLeasesServerOutput> => {
    const { env, user } = context.lambdaContext;
    const leaseStore = IsbServices.leaseStore(env);

    // The model validates `maxResults` (`@range(min:1,max:2000)`); the deserializer
    // has already rejected an out-of-range or malformed integer. `userEmail` is
    // modeled as an open `@sensitive String` (`OwnerEmail`, no `@pattern`), so its
    // email format is a retained Zod supplement re-validated below. Unlike
    // `ListSharedLeases` (whose pre-Smithy `GetSharedLeasesQueryParametersSchema`
    // was `.strict()`), the pre-Smithy `GetLeasesQueryParametersSchema` was NOT
    // `.strict()` — it silently discarded unknown query params — so ignoring unknown
    // query params here MATCHES pre-Smithy and is not a deviation.
    const { pageIdentifier, maxResults, userEmail } = input;

    // Re-validate an explicit `userEmail` against the email format the pre-Smithy
    // query schema enforced (`z.email().optional()`), returning 400 BEFORE any
    // authorization or store access.
    if (userEmail !== undefined) {
      const userEmailParseResult = z.email().safeParse(userEmail);
      if (!userEmailParseResult.success) {
        throw createHttpJSendValidationError(userEmailParseResult.error);
      }
    }

    let findLeasesResponse;
    if (userEmail === undefined) {
      if (!isAdminOrManager(user)) {
        throw createHttpJSendError({
          statusCode: 403,
          data: {
            errors: [
              {
                message: `User is not authorized to get all leases.`,
              },
            ],
          },
        });
      }
      findLeasesResponse = await leaseStore.findAll({
        pageIdentifier,
        pageSize: maxResults ?? LIST_LEASES_DEFAULT_MAX,
      });
    } else {
      if (!isAdminOrManager(user) && getUserEmail(user) !== userEmail) {
        logger.warn(
          `User ${getUserEmail(user)} not allowed to get leases of ${userEmail}`,
        );
        throw createHttpJSendError({
          statusCode: 403,
          data: {
            errors: [
              {
                message: `User is not authorized to get the requested leases.`,
              },
            ],
          },
        });
      }
      findLeasesResponse = await leaseStore.findByUserEmail({
        userEmail,
        pageIdentifier,
        pageSize: maxResults ?? LIST_LEASES_DEFAULT_MAX,
      });
    }

    if (findLeasesResponse.error) {
      logger.warn(
        `${LogPatterns.DataValidationWarning.pattern}: Error finding leases - ${findLeasesResponse.error}`,
      );
    }

    const data = {
      ...findLeasesResponse,
      result: findLeasesResponse.result.map((lease: PersistedLease) => ({
        ...lease,
        leaseId: base64EncodeCompositeKey({
          userEmail: lease.userEmail,
          uuid: lease.uuid,
        }),
      })),
    };

    // Return the raw store result (with injected `leaseId`s); the serializer
    // projects it to the modeled shape and forwards the optional `error`
    // diagnostic. The cast bridges the store types to the modeled output.
    return {
      status: JSendStatus.SUCCESS,
      data: data as unknown as ListLeasesServerOutput["data"],
    };
  };
}

function getLease(logger: Logger) {
  return async (
    input: GetLeaseServerInput,
    context: LeasesSmithyContext,
  ): Promise<GetLeaseServerOutput> => {
    const { env, user } = context.lambdaContext;
    const leaseStore = IsbServices.leaseStore(env);

    const leaseCompositeKey = parseLeaseCompositeKey(input.leaseId);

    const leaseResponse = await leaseStore.get(leaseCompositeKey);
    const lease = leaseResponse.result;
    if (leaseResponse.error) {
      logger.warn(
        `${LogPatterns.DataValidationWarning.pattern}: Error retrieving lease ${JSON.stringify(leaseCompositeKey)}: ${leaseResponse.error}`,
      );
    }

    const canRead =
      !!lease &&
      (await hasReadAccessForLease(user, lease, () =>
        IsbServices.principalStore(env),
      ));
    if (!canRead) {
      if (!isAdminOrManager(user)) {
        throw createHttpJSendError({
          statusCode: 403,
          data: {
            errors: [
              {
                message: `Active user is not authorized to view leases of requested user.`,
              },
            ],
          },
        });
      }
      throw createHttpJSendError({
        statusCode: 404,
        data: {
          errors: [
            {
              message: `Lease not found.`,
            },
          ],
        },
      });
    }

    return {
      status: JSendStatus.SUCCESS,
      data: {
        ...lease,
        leaseId: base64EncodeCompositeKey({
          userEmail: lease.userEmail,
          uuid: lease.uuid,
        }),
      } as unknown as GetLeaseServerOutput["data"],
    };
  };
}

function listSharedLeases(logger: Logger) {
  return async (
    input: ListSharedLeasesServerInput,
    context: LeasesSmithyContext,
  ): Promise<ListSharedLeasesServerOutput> => {
    const { env, user } = context.lambdaContext;

    // The model validates `userId` (required), `accessType` (required enum), and
    // `maxResults` (`@range(min:1,max:100)`); the deserializer rejected anything
    // invalid before this runs. `userId` is modeled as an open `String`, so its
    // `IdcPrincipalIdSchema` format is a retained Zod supplement (the pre-Smithy
    // query schema validated it and returned 400 on a non-conforming id). The
    // `.strict()` unknown-query rejection is not reproduced (accepted deviation).
    const { userId, accessType, pageIdentifier, maxResults } = input;

    const userIdParseResult = IdcPrincipalIdSchema.safeParse(userId);
    if (!userIdParseResult.success) {
      throw createHttpJSendValidationError(userIdParseResult.error);
    }

    // Admin/Manager can query shared leases for any user. Other callers must
    // be an IDC user querying their own userId — no cross-user observation.
    // M2M callers without elevated roles cannot use this endpoint.
    if (!isAdminOrManager(user)) {
      if (isM2MUser(user)) {
        throw createHttpJSendError({
          statusCode: 403,
          data: {
            errors: [
              {
                message:
                  "Machine-to-machine clients without Admin/Manager role cannot query shared leases.",
              },
            ],
          },
        });
      }
      if (!isIdcUser(user) || user.userId !== userId) {
        throw createHttpJSendError({
          statusCode: 403,
          data: {
            errors: [
              {
                message:
                  "Caller is not authorized to query shared leases for this user.",
              },
            ],
          },
        });
      }
    }

    const leaseStore = IsbServices.leaseStore(env);
    const principalStore = IsbServices.principalStore(env);

    const result =
      accessType === "direct"
        ? await getLeasesForUserDirect(
            {
              userId,
              pageIdentifier,
              pageSize: maxResults ?? LIST_SHARED_LEASES_DEFAULT_MAX,
            },
            { leaseStore, principalStore, logger },
          )
        : await getLeasesForUserViaGroups(
            {
              userId,
              pageIdentifier,
              pageSize: maxResults ?? LIST_SHARED_LEASES_DEFAULT_MAX,
            },
            {
              leaseStore,
              principalStore,
              idcService: IsbServices.idcService(
                env,
                fromTemporaryIsbIdcCredentials(env),
              ),
              logger,
            },
          );

    return {
      status: JSendStatus.SUCCESS,
      data: {
        result: result.result.map((lease) => ({
          ...lease,
          leaseId: base64EncodeCompositeKey({
            userEmail: lease.userEmail,
            uuid: lease.uuid,
          }),
        })),
        nextPageIdentifier: result.nextPageIdentifier,
        ...(result.error === undefined ? {} : { error: result.error }),
      } as unknown as ListSharedLeasesServerOutput["data"],
    };
  };
}

function getLeaseAssignments(_logger: Logger) {
  return async (
    input: GetLeaseAssignmentsServerInput,
    context: LeasesSmithyContext,
  ): Promise<GetLeaseAssignmentsServerOutput> => {
    const { env, user } = context.lambdaContext;
    const leaseStore = IsbServices.leaseStore(env);
    const principalStore = IsbServices.principalStore(env);

    const leaseCompositeKey = parseLeaseCompositeKey(input.leaseId);

    // Fetch lease to validate existence and check ownership for authorization
    const { result: lease } = await leaseStore.get(leaseCompositeKey);

    // Admin/Manager can view any lease's assignments.
    // Other users can only view their own — and get 403 even if lease doesn't exist.
    if (!isAdminOrManager(user) && getUserEmail(user) !== lease?.userEmail) {
      throw createHttpJSendError({
        statusCode: 403,
        data: {
          errors: [
            {
              message:
                "Active user is not authorized to view assignments for this lease.",
            },
          ],
        },
      });
    } else if (!lease) {
      throw createHttpJSendError({
        statusCode: 404,
        data: {
          errors: [{ message: "Lease not found." }],
        },
      });
    }

    const assignments = await principalStore.getAssignmentsForLease({
      leaseId: lease.uuid,
    });

    return {
      status: JSendStatus.SUCCESS,
      data: deriveAssignmentView(
        lease,
        assignments.result,
      ) as unknown as GetLeaseAssignmentsServerOutput["data"],
    };
  };
}

// ---------------------------------------------------------------------------
// Lease request & update (body-bearing writes; keep a strict Zod re-parse)
// ---------------------------------------------------------------------------
function requestLease(logger: Logger) {
  return async (
    _input: RequestLeaseServerInput,
    context: LeasesSmithyContext,
  ): Promise<RequestLeaseServerOutput> => {
    const { env, user, globalConfig } = context.lambdaContext;
    const isbContext = {
      ...baseLeaseIsbContext(env, logger),
      leaseTemplateStore: IsbServices.leaseTemplateStore(env),
      principalStore: IsbServices.principalStore(env),
      isbEventBridgeClient: IsbServices.isbEventBridge(env),
      globalConfig,
      blueprintStore: IsbServices.blueprintStore(env),
      blueprintDeploymentService: IsbServices.blueprintDeploymentService(env),
    };

    // Retain the strict Zod re-parse (deviation #6): unknown-key rejection, the
    // per-principal uniqueness rule, and `DesiredAssignmentSchema.strict()`, which
    // the model cannot express. Re-parse the raw body (the deserializer would
    // silently drop unknown members).
    const InputLeaseSchema = PersistedPendingLeaseSchema.pick({
      comments: true,
    })
      .extend({
        leaseTemplateUuid:
          PersistedPendingLeaseSchema.shape.originalLeaseTemplateUuid,
        userEmail: PersistedPendingLeaseSchema.shape.userEmail.optional(),
        assignments: z
          .array(DesiredAssignmentSchema.strict())
          .max(MAX_USER_MANAGED_ASSIGNMENTS)
          .refine(
            (items) => {
              const keys = items.map((i) => i.principalId);
              return new Set(keys).size === keys.length;
            },
            {
              message:
                "Each principal can only appear once in the assignments list.",
            },
          )
          .optional(),
      })
      .strict();

    const leaseParseResponse = InputLeaseSchema.safeParse(
      parseRawJsonBody(context.event),
    );
    if (!leaseParseResponse.success) {
      throw createHttpJSendValidationError(leaseParseResponse.error);
    }

    const { leaseTemplateUuid, userEmail, comments, assignments } =
      leaseParseResponse.data;

    assertGroupAssignmentsAllowed(globalConfig, assignments ?? []);

    // Resolve the assignee: an explicit userEmail (on-behalf) or the caller
    // (self-request). A lease grants IDC console access to its assignee, and M2M
    // identities have no IDC user, so refuse before any lookup or write.
    const assigneeEmail = userEmail ?? getUserEmail(user);
    rejectIfAssigneeIsM2m(assigneeEmail);

    const [leaseTemplate, targetUser] = await Promise.all([
      validateAndGetLeaseTemplate(leaseTemplateUuid, user, isbContext),
      resolveTargetUser(userEmail, user, isbContext),
    ]);

    // A request is a cross-user assignment only when userEmail identifies a
    // DIFFERENT user than the requester. A self-referential userEmail must be
    // treated the same as an omitted one, otherwise a regular user could set
    // createdBy (and thereby trigger auto-approval) on their own lease request.
    const createdBy =
      userEmail && userEmail !== getUserEmail(user)
        ? getUserEmail(user)
        : undefined;

    const hasAssignments = assignments && assignments.length > 0;
    if (
      !globalConfig.leases.leaseSharingEnabled &&
      hasAssignments &&
      !isAdminOrManager(user)
    ) {
      throw createHttpJSendError({
        statusCode: 400,
        data: {
          errors: [
            {
              message: "Lease sharing is not enabled.",
            },
          ],
        },
      });
    }

    if (
      !leaseTemplate.allowOwnerToShareLease &&
      hasAssignments &&
      !isAdminOrManager(user)
    ) {
      throw createHttpJSendError({
        statusCode: 403,
        data: {
          errors: [
            {
              message: "Owner sharing is not enabled for this lease template.",
            },
          ],
        },
      });
    }

    try {
      await enforceLeaseRequestRateLimit({
        logger,
        lambdaContext: context.lambdaContext,
        targetUserEmail: getUserEmail(targetUser),
        leaseStore: isbContext.leaseStore,
      });

      const newLease: PersistedLease = await InnovationSandbox.requestLease(
        {
          leaseTemplate,
          targetUser: targetUser,
          createdBy,
          comments,
          assignments,
        },
        isbContext,
      );

      return {
        status: JSendStatus.SUCCESS,
        data: newLease as unknown as RequestLeaseServerOutput["data"],
      };
    } catch (error) {
      if (error instanceof MaxNumberOfLeasesExceededError) {
        throw createHttpJSendError({
          statusCode: 409,
          data: {
            errors: [
              {
                message: `You have reached the maximum number of active/pending leases allowed (${globalConfig.leases.maxLeasesPerUser}).`,
              },
            ],
          },
        });
      } else if (error instanceof NoAccountsAvailableError) {
        throw createHttpJSendError({
          statusCode: 409,
          data: {
            errors: [
              {
                message: `No accounts are available to lease.`,
              },
            ],
          },
        });
      } else if (error instanceof LeaseRequestRateLimitExceededError) {
        throw createHttpJSendError({
          statusCode: 429,
          data: {
            errors: [{ message: error.message }],
            retryAt: error.retryAt,
          },
        });
      } else {
        throw error;
      }
    }
  };
}

function updateLease(logger: Logger) {
  return async (
    input: UpdateLeaseServerInput,
    context: LeasesSmithyContext,
  ): Promise<UpdateLeaseServerOutput> => {
    const { env, globalConfig } = context.lambdaContext;
    const leaseStore = IsbServices.leaseStore(env);

    // Retain the strict PATCH schema (deviation #6): unknown-key rejection,
    // null-to-clear on the nullable members, and cross-field budget/duration
    // rules the model cannot express. Re-parse the raw body.
    const PatchLeaseSchema = PersistedMonitoredLeaseSchema.pick({
      maxSpend: true,
      budgetThresholds: true,
      expirationDate: true,
      durationThresholds: true,
      costReportGroup: true,
      allowOwnerToShareLease: true,
    })
      .extend({
        maxSpend: PersistedMonitoredLeaseSchema.shape.maxSpend.nullable(),
        expirationDate:
          PersistedMonitoredLeaseSchema.shape.expirationDate.nullable(),
        costReportGroup:
          PersistedMonitoredLeaseSchema.shape.costReportGroup.nullable(),
      })
      .partial()
      .strict();

    const patchLeaseParseResponse = PatchLeaseSchema.safeParse(
      parseRawJsonBody(context.event),
    );
    if (!patchLeaseParseResponse.success) {
      throw createHttpJSendValidationError(patchLeaseParseResponse.error);
    }

    // Map explicit `null` (clear) to `undefined` so the spread below unsets the
    // field. `value` is only ever a present value or explicit `null` here (Zod
    // `.partial()` drops absent keys), so `?? undefined` is equivalent to the
    // `=== null ? undefined : value` normalization.
    const leaseUpdates = Object.fromEntries(
      Object.entries(patchLeaseParseResponse.data).map(([key, value]) => [
        key,
        value ?? undefined,
      ]),
    );

    const existingLease = await fetchLeaseOrThrow404(
      leaseStore,
      input.leaseId,
      logger,
    );

    if (!isMonitoredLease(existingLease)) {
      throw createHttpJSendError({
        statusCode: 400,
        data: {
          errors: [
            {
              message: `Can only update an active lease`,
            },
          ],
        },
      });
    }

    const updatedLease: PersistedLease = {
      ...existingLease,
      ...leaseUpdates,
    };

    try {
      validateLeaseCompliesWithGlobalConfig(updatedLease, globalConfig, {
        previous: existingLease,
      });
      validateCostReportGroup(
        updatedLease.costReportGroup,
        globalConfig.costReporting,
        { previousCostReportGroup: existingLease.costReportGroup },
      );
    } catch (error) {
      if (error instanceof ValidationException) {
        throw createHttpJSendError({
          statusCode: 400,
          data: {
            errors: [
              {
                message: error.message,
              },
            ],
          },
        });
      } else {
        throw error;
      }
    }

    try {
      const putResult = await leaseStore.update(updatedLease);

      logger.info(
        `Updated Lease ${existingLease.uuid}`,
        summarizeUpdate(putResult),
      );

      // Re-apply the CostReportGroup tag if it changed.
      if (existingLease.costReportGroup !== updatedLease.costReportGroup) {
        try {
          const taggingService = IsbServices.organizationsTaggingService(
            env,
            fromTemporaryIsbOrgManagementCredentials(env),
          );
          await taggingService.tagAccount(updatedLease.awsAccountId, {
            CostReportGroup:
              updatedLease.costReportGroup ?? NO_COST_REPORT_GROUP_TAG_VALUE,
          });
        } catch (tagError) {
          logTaggingFailure(
            logger,
            updatedLease.awsAccountId,
            ["CostReportGroup"],
            tagError,
          );
        }
      }

      return {
        status: JSendStatus.SUCCESS,
        data: putResult.newItem as unknown as UpdateLeaseServerOutput["data"],
      };
    } catch (error) {
      if (error instanceof UnknownItem) {
        throw createHttpJSendError({
          statusCode: 404,
          data: {
            errors: [
              {
                message: `Lease not found.`,
              },
            ],
          },
        });
      } else {
        throw error;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Lifecycle actions
// ---------------------------------------------------------------------------
function reviewLease(logger: Logger) {
  return async (
    input: ReviewLeaseServerInput,
    context: LeasesSmithyContext,
  ): Promise<ReviewLeaseServerOutput> => {
    const { env, user, globalConfig } = context.lambdaContext;
    const isbContext = {
      ...baseLeaseIsbContext(env, logger),
      principalStore: IsbServices.principalStore(env),
      isbEventBridgeClient: IsbServices.isbEventBridge(env),
      globalConfig,
      blueprintStore: IsbServices.blueprintStore(env),
      blueprintDeploymentService: IsbServices.blueprintDeploymentService(env),
      leaseTemplateStore: IsbServices.leaseTemplateStore(env),
    };

    // Retain the strict review-body Zod re-parse: the model validates `action`
    // (`Approve`/`Deny`, required enum), but the pre-Smithy handler ALSO rejected
    // unknown keys with an "Unrecognized key" 400, which `restJson1` would silently
    // drop. Re-parsing the raw body preserves that exact 400 (byte-faithful,
    // matching the pre-Smithy handler's `ReviewLeaseBodySchema.strict()`).
    const ReviewLeaseBodySchema = z
      .object({
        action: z.enum(["Approve", "Deny"], {
          error: enumErrorMap,
        }),
      })
      .strict();
    const parsedReviewLeaseBody = ReviewLeaseBodySchema.safeParse(
      parseRawJsonBody(context.event),
    );
    if (!parsedReviewLeaseBody.success) {
      throw createHttpJSendValidationError(parsedReviewLeaseBody.error);
    }
    const action = parsedReviewLeaseBody.data.action;

    const lease = await fetchLeaseOrThrow404(
      isbContext.leaseStore,
      input.leaseId,
      logger,
    );

    if (!isPendingLease(lease)) {
      throw createHttpJSendError({
        statusCode: 409,
        data: {
          errors: [
            {
              message: LEASE_NOT_PENDING_REVIEW_ERROR,
            },
          ],
        },
      });
    }

    if (action == "Approve") {
      try {
        await InnovationSandbox.approveLease(
          { lease, approver: getUserEmail(user) },
          isbContext,
        );
      } catch (error) {
        if (error instanceof NoAccountsAvailableError) {
          throw createHttpJSendError({
            statusCode: 409,
            data: {
              errors: [
                {
                  message: `There are no more sandbox accounts available. Please contact your administrator.`,
                },
              ],
            },
          });
        } else {
          throw error;
        }
      }
    } else {
      await InnovationSandbox.denyLease({ lease, denier: user }, isbContext);
    }

    // Pre-Smithy body was `{"status":"success","data":null}`. The model omits
    // `data` (Smithy cannot model a null-only member), so the serialized body is
    // `{"status":"success"}` — an accepted deviation (matches `DeleteLeaseTemplate`).
    return { status: JSendStatus.SUCCESS };
  };
}

function freezeLease(logger: Logger) {
  return async (
    input: FreezeLeaseServerInput,
    context: LeasesSmithyContext,
  ): Promise<FreezeLeaseServerOutput> => {
    const { env, user } = context.lambdaContext;
    const isbContext = {
      ...baseLeaseIsbContext(env, logger),
      eventBridgeClient: IsbServices.isbEventBridge(env),
    };

    const lease = await fetchLeaseOrThrow404(
      isbContext.leaseStore,
      input.leaseId,
      logger,
    );

    if (!isMonitoredLease(lease)) {
      throw createHttpJSendError({
        statusCode: 409,
        data: {
          errors: [
            {
              message: `Only active leases can be frozen.`,
            },
          ],
        },
      });
    }

    try {
      await InnovationSandbox.freezeLease(
        {
          lease,
          reason: {
            type: "ManuallyFrozen",
            comment: `Manually frozen by ${getUserEmail(user)}`,
          },
        },
        isbContext,
      );
    } catch (error) {
      if (error instanceof AccountNotInActiveError) {
        throw jsendError(409, error.message);
      }
      mapLeaseLockError(error);
    }

    // `data: null` pre-Smithy; `data` omitted from the model (accepted deviation).
    return { status: JSendStatus.SUCCESS };
  };
}

function terminateLease(logger: Logger) {
  return async (
    input: TerminateLeaseServerInput,
    context: LeasesSmithyContext,
  ): Promise<TerminateLeaseServerOutput> => {
    const { env, user, globalConfig } = context.lambdaContext;
    const isbContext = {
      ...baseLeaseIsbContext(env, logger),
      eventBridgeClient: IsbServices.isbEventBridge(env),
      globalConfig,
      blueprintStore: IsbServices.blueprintStore(env),
      blueprintDeploymentService: IsbServices.blueprintDeploymentService(env),
    };

    const { lease } = await fetchLease(
      isbContext.leaseStore,
      input.leaseId,
      logger,
    );

    // 403 (authorization) is evaluated BEFORE the 404 so a lease's existence is
    // never leaked to an unauthorized caller.
    const { isUserOnly } = authorizeTermination(user, lease, globalConfig);

    if (!lease) {
      throw jsendError(404, "Lease not found.");
    }

    if (!isMonitoredLease(lease)) {
      throw createHttpJSendError({
        statusCode: 409,
        data: {
          errors: [
            {
              message: `Only [${MonitoredLeaseStatusSchema.options.join(", ")}] leases can be terminated.`,
            },
          ],
        },
      });
    }

    try {
      await InnovationSandbox.terminateLease(
        {
          lease,
          expiredStatus: isUserOnly ? "UserTerminated" : "ManuallyTerminated",
        },
        isbContext,
      );
    } catch (error) {
      mapTerminateError(error);
    }

    // `data: null` pre-Smithy; `data` omitted from the model (accepted deviation).
    return { status: JSendStatus.SUCCESS };
  };
}

function unfreezeLease(logger: Logger) {
  return async (
    input: UnfreezeLeaseServerInput,
    context: LeasesSmithyContext,
  ): Promise<UnfreezeLeaseServerOutput> => {
    const { env } = context.lambdaContext;
    const isbContext = {
      ...baseLeaseIsbContext(env, logger),
      eventBridgeClient: IsbServices.isbEventBridge(env),
    };

    const leaseCompositeKey = parseLeaseCompositeKey(input.leaseId);
    const leaseResponse = await isbContext.leaseStore.get(leaseCompositeKey);
    const lease = leaseResponse.result;

    if (!lease || leaseResponse.error) {
      logger.warn(
        `Error retrieving lease ${JSON.stringify(leaseCompositeKey)}: ${leaseResponse.error}`,
      );
      throw createHttpJSendError({
        statusCode: 404,
        data: {
          errors: [
            {
              message: `Lease not found.`,
            },
          ],
        },
      });
    }

    if (!isFrozenLease(lease)) {
      throw createHttpJSendError({
        statusCode: 409,
        data: {
          errors: [
            {
              message: `Only frozen leases can be unfrozen.`,
            },
          ],
        },
      });
    }

    try {
      const result = await InnovationSandbox.unfreezeLease(
        { lease },
        isbContext,
      );
      return {
        status: JSendStatus.SUCCESS,
        data: {
          ...result.newItem,
          leaseId: base64EncodeCompositeKey({
            userEmail: result.newItem.userEmail,
            uuid: result.newItem.uuid,
          }),
        } as unknown as UnfreezeLeaseServerOutput["data"],
      };
    } catch (error) {
      if (error instanceof AccountNotInFrozenError) {
        throw jsendError(409, error.message);
      }
      mapLeaseLockError(error);
    }
  };
}

function updateLeaseAssignments(logger: Logger) {
  return async (
    input: UpdateLeaseAssignmentsServerInput,
    context: LeasesSmithyContext,
  ): Promise<UpdateLeaseAssignmentsServerOutput> => {
    const { env, user, globalConfig } = context.lambdaContext;
    const leaseStore = IsbServices.leaseStore(env);

    // Retain the strict PUT body schema (deviation #6): unknown-key rejection and
    // per-principal uniqueness the model cannot express. Re-parse the raw body.
    const PutLeaseAssignmentsBodySchema = z
      .object({
        assignments: z
          .array(
            z
              .object({
                principalId: IdcPrincipalIdSchema,
                principalType: PrincipalTypeSchema,
              })
              .strict(),
          )
          .max(MAX_USER_MANAGED_ASSIGNMENTS)
          .refine(
            (items) => {
              const keys = items.map((i) => i.principalId);
              return new Set(keys).size === keys.length;
            },
            { message: "Duplicate assignments are not allowed." },
          ),
      })
      .strict();

    const bodyParseResult = PutLeaseAssignmentsBodySchema.safeParse(
      parseRawJsonBody(context.event),
    );
    if (!bodyParseResult.success) {
      throw createHttpJSendValidationError(bodyParseResult.error);
    }

    const { assignments: desiredAssignments } = bodyParseResult.data;

    // Get the lease
    const leaseCompositeKey = parseLeaseCompositeKey(input.leaseId);
    const { result: lease } = await leaseStore.get(leaseCompositeKey);

    // Admin/Manager can manage any lease's assignments.
    // Other users can only manage their own — and get 403 even if the lease
    // doesn't exist, so existence cannot be inferred from the status code.
    if (!isAdminOrManager(user) && getUserEmail(user) !== lease?.userEmail) {
      throw createHttpJSendError({
        statusCode: 403,
        data: {
          errors: [
            {
              message:
                "Active user is not authorized to manage assignments for this lease.",
            },
          ],
        },
      });
    } else if (!lease) {
      throw createHttpJSendError({
        statusCode: 404,
        data: {
          errors: [{ message: "Lease not found." }],
        },
      });
    }

    // Authorization check (global flag + owner sharing) for owner/elevated callers
    assertCallerCanManageAssignments(user, globalConfig, lease);

    assertGroupAssignmentsAllowed(globalConfig, desiredAssignments, {
      existingAssignments: lease.desiredAssignments ?? [],
    });

    // Lease must be Active
    if (!isActiveLease(lease)) {
      throw createHttpJSendError({
        statusCode: 409,
        data: {
          errors: [{ message: "Lease is not in an active status." }],
        },
      });
    }

    // Delegate to service
    const callerEmail = getUserEmail(user);
    const principalStore = IsbServices.principalStore(env);

    logger.info("Processing PUT assignments request", {
      leaseId: lease.uuid,
      callerEmail,
      desiredCount: desiredAssignments.length,
    });

    try {
      const { desiredCount } = await triggerAssignmentProcessing(
        {
          leaseId: lease.uuid,
          userEmail: lease.userEmail,
          intent: "UPDATE",
          requestedBy: callerEmail,
          desiredAssignments,
        },
        {
          leaseStore: IsbServices.leaseStore(env),
          eventBridgeClient: IsbServices.isbEventBridge(env),
          principalStore,
          idcService: IsbServices.idcService(
            env,
            fromTemporaryIsbIdcCredentials(env),
          ),
          tracer,
          logger,
        },
      );

      logger.info("Assignment update accepted", {
        leaseId: lease.uuid,
        desiredCount,
        intent: "UPDATE",
      });

      return {
        status: JSendStatus.SUCCESS,
        data: { desiredCount },
      };
    } catch (error: unknown) {
      if (error instanceof MaxAssignmentsExceededError) {
        throw createHttpJSendError({
          statusCode: 400,
          data: { errors: [{ message: error.message }] },
        });
      }
      if (error instanceof ResourceLockConflictError) {
        throw createHttpJSendError({
          statusCode: 409,
          data: {
            errors: [
              {
                message:
                  "Another operation is in progress on this lease. Please try again later.",
              },
            ],
          },
        });
      }
      throw error;
    }
  };
}

/**
 * The `LeasesApi` service. Every operation is wrapped in `withDelegatedErrors`
 * so the 400/403/404/409/429 business errors render through the shared Middy
 * `httpErrorHandler` exactly as the pre-Smithy handler produced them.
 */
export function leasesService(
  logger: Logger,
): LeasesApiService<LeasesSmithyContext> {
  return {
    ListLeases: withDelegatedErrors(listLeases(logger)),
    RequestLease: withDelegatedErrors(requestLease(logger)),
    ListSharedLeases: withDelegatedErrors(listSharedLeases(logger)),
    GetLease: withDelegatedErrors(getLease(logger)),
    UpdateLease: withDelegatedErrors(updateLease(logger)),
    FreezeLease: withDelegatedErrors(freezeLease(logger)),
    ReviewLease: withDelegatedErrors(reviewLease(logger)),
    TerminateLease: withDelegatedErrors(terminateLease(logger)),
    UnfreezeLease: withDelegatedErrors(unfreezeLease(logger)),
    GetLeaseAssignments: withDelegatedErrors(getLeaseAssignments(logger)),
    UpdateLeaseAssignments: withDelegatedErrors(updateLeaseAssignments(logger)),
    // Whole-object cast: `withDelegatedErrors` wraps each operation in a generic
    // that erases the per-operation `...ServerOutput` return type, so the object
    // literal no longer structurally matches `LeasesApiService`. Each inner
    // operation is still individually typed against its own `...ServerInput`/
    // `...ServerOutput` above, which is where the real signature checking happens.
  } as unknown as LeasesApiService<LeasesSmithyContext>;
}
