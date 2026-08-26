// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import middy from "@middy/core";
import httpRouterHandler, { Route } from "@middy/http-router";
import {
  APIGatewayProxyEventPathParameters,
  APIGatewayProxyResult,
} from "aws-lambda";
import { DateTime } from "luxon";
import { z } from "zod";

import { PaginatedQueryResult } from "@amzn/innovation-sandbox-commons/data/common-types.js";
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
  DesiredAssignmentSchema,
  isActiveLease,
  isFrozenLease,
  isMonitoredLease,
  isPendingLease,
  Lease,
  LEASE_NOT_PENDING_REVIEW_ERROR,
  LeaseKeySchema,
  MAX_USER_MANAGED_ASSIGNMENTS,
  MonitoredLeaseSchema,
  MonitoredLeaseStatusSchema,
  PendingLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  IdcPrincipalIdSchema,
  PrincipalTypeSchema,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
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
import {
  LeaseLambdaEnvironment,
  LeaseLambdaEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/lease-lambda-environment.js";
import apiMiddlewareBundle, {
  IsbApiContext,
  IsbApiEvent,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/api-middleware-bundle.js";
import {
  createHttpJSendError,
  createHttpJSendValidationError,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import { httpJsonBodyParser } from "@amzn/innovation-sandbox-commons/lambda/middleware/http-json-body-parser.js";
import {
  ContextWithConfig,
  isbConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";
import { rejectIfAssigneeIsM2m } from "@amzn/innovation-sandbox-commons/lambda/middleware/m2m-guard.js";
import { createPaginationQueryStringParametersSchema } from "@amzn/innovation-sandbox-commons/lambda/schemas.js";
import {
  LogPatterns,
  logTaggingFailure,
  summarizeUpdate,
} from "@amzn/innovation-sandbox-commons/observability/logging.js";
import {
  type IsbUser,
  getUserEmail,
  isIdcUser,
  isM2MUser,
} from "@amzn/innovation-sandbox-commons/utils/auth-utils.js";
import {
  fromTemporaryIsbIdcCredentials,
  fromTemporaryIsbOrgManagementCredentials,
} from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import { NO_COST_REPORT_GROUP_TAG_VALUE } from "@amzn/innovation-sandbox-commons/utils/isb-account-tags.js";
import { enumErrorMap } from "@amzn/innovation-sandbox-commons/utils/zod.js";

const tracer = new Tracer();
const logger = new Logger({ serviceName: "Leases" });

let leaseRequestWindowCappedLogged = false;

const middyFactory = middy<
  IsbApiEvent,
  any,
  Error,
  ContextWithConfig & IsbApiContext<LeaseLambdaEnvironment>
>;

const routes: Route<IsbApiEvent, APIGatewayProxyResult>[] = [
  {
    path: "/leases",
    method: "GET",
    handler: middyFactory().handler(getLeasesHandler),
  },
  {
    path: "/leases",
    method: "POST",
    handler: middyFactory().use(httpJsonBodyParser()).handler(postLeaseHandler),
  },
  {
    path: "/leases/shared",
    method: "GET",
    handler: middyFactory().handler(getSharedLeasesHandler),
  },
  {
    path: "/leases/{leaseId}",
    method: "GET",
    handler: middyFactory().handler(getLeaseByIdHandler),
  },
  {
    path: "/leases/{leaseId}",
    method: "PATCH",
    handler: middyFactory()
      .use(httpJsonBodyParser())
      .handler(patchLeaseByIdHandler),
  },
  {
    path: "/leases/{leaseId}/freeze",
    method: "POST",
    handler: middyFactory().handler(freezeLeaseHandler),
  },
  {
    path: "/leases/{leaseId}/review",
    method: "POST",
    handler: middyFactory()
      .use(httpJsonBodyParser())
      .handler(reviewLeaseHandler),
  },
  {
    path: "/leases/{leaseId}/terminate",
    method: "POST",
    handler: middyFactory().handler(terminateLeaseHandler),
  },
  {
    path: "/leases/{leaseId}/unfreeze",
    method: "POST",
    handler: middyFactory().handler(unfreezeLeaseHandler),
  },
  {
    path: "/leases/{leaseId}/assignments",
    method: "GET",
    handler: middyFactory().handler(getLeaseAssignmentsHandler),
  },
  {
    path: "/leases/{leaseId}/assignments",
    method: "PUT",
    handler: middyFactory()
      .use(httpJsonBodyParser())
      .handler(putLeaseAssignmentsHandler),
  },
];

export const handler = apiMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: LeaseLambdaEnvironmentSchema,
})
  .use(isbConfigMiddleware())
  .handler(httpRouterHandler(routes));

async function getLeasesHandler(
  event: IsbApiEvent,
  context: ContextWithConfig & IsbApiContext<LeaseLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const leaseStore = IsbServices.leaseStore(context.env);

  const GetLeasesQueryParametersSchema =
    createPaginationQueryStringParametersSchema({ maxPageSize: 2000 }).extend({
      userEmail: z.email().optional(),
    });
  const parsedGetLeasesQueryParametersResult =
    GetLeasesQueryParametersSchema.safeParse(event.queryStringParameters);

  if (!parsedGetLeasesQueryParametersResult.success) {
    throw createHttpJSendValidationError(
      parsedGetLeasesQueryParametersResult.error,
    );
  }

  const { pageIdentifier, maxResults, userEmail } =
    parsedGetLeasesQueryParametersResult.data;

  let findLeasesResponse: PaginatedQueryResult<Lease>;
  if (userEmail !== undefined) {
    if (
      !isAdminOrManager(context.user) &&
      getUserEmail(context.user) !== userEmail
    ) {
      logger.warn(
        `User ${getUserEmail(context.user)} not allowed to get leases of ${userEmail}`,
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
      pageSize: maxResults,
    });
  } else {
    if (!isAdminOrManager(context.user)) {
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
      pageSize: maxResults,
    });
  }

  if (findLeasesResponse.error) {
    logger.warn(
      `${LogPatterns.DataValidationWarning.pattern}: Error finding leases - ${findLeasesResponse.error}`,
    );
  }

  const data = {
    ...findLeasesResponse,
    result: findLeasesResponse.result.map((lease: Lease) => ({
      ...lease,
      leaseId: base64EncodeCompositeKey({
        userEmail: lease.userEmail,
        uuid: lease.uuid,
      }),
    })),
  };

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: data,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

async function postLeaseHandler(
  event: IsbApiEvent,
  context: ContextWithConfig & IsbApiContext<LeaseLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const isbContext = {
    logger,
    tracer,
    leaseStore: IsbServices.leaseStore(context.env),
    leaseTemplateStore: IsbServices.leaseTemplateStore(context.env),
    sandboxAccountStore: IsbServices.sandboxAccountStore(context.env),
    principalStore: IsbServices.principalStore(context.env),
    idcService: IsbServices.idcService(
      context.env,
      fromTemporaryIsbIdcCredentials(context.env),
    ),
    orgsService: IsbServices.orgsService(
      context.env,
      fromTemporaryIsbOrgManagementCredentials(context.env),
    ),
    organizationsTaggingService: IsbServices.organizationsTaggingService(
      context.env,
      fromTemporaryIsbOrgManagementCredentials(context.env),
    ),
    isbEventBridgeClient: IsbServices.isbEventBridge(context.env),
    globalConfig: context.globalConfig,
    blueprintStore: IsbServices.blueprintStore(context.env),
    blueprintDeploymentService: IsbServices.blueprintDeploymentService(
      context.env,
    ),
  };
  const InputLeaseSchema = PendingLeaseSchema.pick({
    comments: true,
  })
    .extend({
      leaseTemplateUuid: PendingLeaseSchema.shape.originalLeaseTemplateUuid,
      userEmail: PendingLeaseSchema.shape.userEmail.optional(),
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

  const leaseParseResponse = InputLeaseSchema.safeParse(event.body);
  if (!leaseParseResponse.success) {
    throw createHttpJSendValidationError(leaseParseResponse.error);
  }

  const { leaseTemplateUuid, userEmail, comments, assignments } =
    leaseParseResponse.data;

  // Resolve the assignee: an explicit userEmail (on-behalf) or the caller
  // (self-request). A lease grants IDC console access to its assignee, and M2M
  // identities have no IDC user, so refuse before any lookup or write.
  const assigneeEmail = userEmail ?? getUserEmail(context.user);
  rejectIfAssigneeIsM2m(assigneeEmail);

  const [leaseTemplate, targetUser] = await Promise.all([
    validateAndGetLeaseTemplate(leaseTemplateUuid, context.user, isbContext),
    resolveTargetUser(userEmail, context.user, isbContext),
  ]);

  // A request is a cross-user assignment only when userEmail identifies a
  // DIFFERENT user than the requester. A self-referential userEmail must be
  // treated the same as an omitted one, otherwise a regular user could set
  // createdBy (and thereby trigger auto-approval) on their own lease request.
  const createdBy =
    userEmail && userEmail !== getUserEmail(context.user)
      ? getUserEmail(context.user)
      : undefined;

  const hasAssignments = assignments && assignments.length > 0;
  if (
    !context.globalConfig.leases.leaseSharingEnabled &&
    hasAssignments &&
    !isAdminOrManager(context.user)
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
    !isAdminOrManager(context.user)
  ) {
    throw createHttpJSendError({
      statusCode: 403,
      data: {
        errors: [
          { message: "Owner sharing is not enabled for this lease template." },
        ],
      },
    });
  }

  try {
    await enforceLeaseRequestRateLimit({
      context,
      targetUserEmail: getUserEmail(targetUser),
      leaseStore: isbContext.leaseStore,
    });

    const newLease: Lease = await InnovationSandbox.requestLease(
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
      statusCode: 201,
      body: JSON.stringify({
        status: "success",
        data: newLease,
      }),
      headers: {
        "Content-Type": "application/json",
      },
    };
  } catch (error) {
    if (error instanceof MaxNumberOfLeasesExceededError) {
      throw createHttpJSendError({
        statusCode: 409,
        data: {
          errors: [
            {
              message: `You have reached the maximum number of active/pending leases allowed (${context.globalConfig.leases.maxLeasesPerUser}).`,
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
}

async function enforceLeaseRequestRateLimit(props: {
  context: ContextWithConfig & IsbApiContext<LeaseLambdaEnvironment>;
  targetUserEmail: string;
  leaseStore: ReturnType<typeof IsbServices.leaseStore>;
}) {
  const { context, targetUserEmail, leaseStore } = props;

  // Admin/Manager callers are exempt from the rate limit.
  if (isAdminOrManager(context.user)) {
    return;
  }

  const { leaseRequestWindowHours, maxLeaseRequestsPerWindow, ttl } =
    context.globalConfig.leases;
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
  const retryAt = DateTime.fromISO(sortedTimes[pivotIndex]!, { zone: "utc" })
    .plus({ hours: effectiveWindowHours })
    .toISO()!;

  logger.warn("LeaseRequestRateLimited", {
    logDetailType: "LeaseRequestRateLimited",
    targetUserEmail,
    callerEmail: getUserEmail(context.user),
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

async function getLeaseByIdHandler(
  event: IsbApiEvent,
  context: ContextWithConfig & IsbApiContext<LeaseLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const leaseStore = IsbServices.leaseStore(context.env);

  const leaseCompositeKey = parseLeaseCompositeKeyFromPathParameters(
    event.pathParameters,
  );

  const leaseResponse = await leaseStore.get(leaseCompositeKey);
  const lease = leaseResponse.result;
  if (leaseResponse.error) {
    logger.warn(
      `${LogPatterns.DataValidationWarning.pattern}: Error retrieving lease ${leaseCompositeKey}: ${leaseResponse.error}`,
    );
  }

  const canRead =
    !!lease &&
    (await hasReadAccessForLease(context.user, lease, () =>
      IsbServices.principalStore(context.env),
    ));
  if (!canRead) {
    if (!isAdminOrManager(context.user)) {
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
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: {
        ...lease,
        leaseId: base64EncodeCompositeKey({
          userEmail: lease.userEmail,
          uuid: lease.uuid,
        }),
      },
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

async function patchLeaseByIdHandler(
  event: IsbApiEvent,
  context: ContextWithConfig & IsbApiContext<LeaseLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const leaseStore = IsbServices.leaseStore(context.env);

  const PatchLeaseSchema = MonitoredLeaseSchema.pick({
    maxSpend: true,
    budgetThresholds: true,
    expirationDate: true,
    durationThresholds: true,
    costReportGroup: true,
    allowOwnerToShareLease: true,
  })
    .extend({
      maxSpend: MonitoredLeaseSchema.shape.maxSpend.nullable(),
      expirationDate: MonitoredLeaseSchema.shape.expirationDate.nullable(),
      costReportGroup: MonitoredLeaseSchema.shape.costReportGroup.nullable(),
    })
    .partial()
    .strict();

  const patchLeaseParseResponse = PatchLeaseSchema.safeParse(event.body);
  if (!patchLeaseParseResponse.success) {
    throw createHttpJSendValidationError(patchLeaseParseResponse.error);
  }

  const leaseUpdates = Object.fromEntries(
    Object.entries(patchLeaseParseResponse.data).map(([key, value]) => [
      key,
      value === null ? undefined : value,
    ]),
  );

  const leaseCompositeKey = parseLeaseCompositeKeyFromPathParameters(
    event.pathParameters,
  );
  const existingLeaseResponse = await leaseStore.get(leaseCompositeKey);
  const existingLease = existingLeaseResponse.result;
  if (existingLeaseResponse.error) {
    logger.warn(
      `Error retrieving lease ${leaseCompositeKey}: ${existingLeaseResponse.error}`,
    );
  }

  if (!existingLease) {
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

  const updatedLease: Lease = {
    ...existingLease,
    ...leaseUpdates,
  };

  try {
    validateLeaseCompliesWithGlobalConfig(updatedLease, context.globalConfig, {
      previous: existingLease,
    });
    validateCostReportGroup(
      updatedLease.costReportGroup,
      context.globalConfig.costReporting,
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
          context.env,
          fromTemporaryIsbOrgManagementCredentials(context.env),
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
      statusCode: 200,
      body: JSON.stringify({
        status: "success",
        data: putResult.newItem,
      }),
      headers: {
        "Content-Type": "application/json",
      },
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
}

async function reviewLeaseHandler(
  event: IsbApiEvent,
  context: ContextWithConfig & IsbApiContext<LeaseLambdaEnvironment>,
) {
  const isbContext = {
    logger,
    tracer,
    leaseStore: IsbServices.leaseStore(context.env),
    sandboxAccountStore: IsbServices.sandboxAccountStore(context.env),
    principalStore: IsbServices.principalStore(context.env),
    idcService: IsbServices.idcService(
      context.env,
      fromTemporaryIsbIdcCredentials(context.env),
    ),
    orgsService: IsbServices.orgsService(
      context.env,
      fromTemporaryIsbOrgManagementCredentials(context.env),
    ),
    organizationsTaggingService: IsbServices.organizationsTaggingService(
      context.env,
      fromTemporaryIsbOrgManagementCredentials(context.env),
    ),
    isbEventBridgeClient: IsbServices.isbEventBridge(context.env),
    globalConfig: context.globalConfig,
    blueprintStore: IsbServices.blueprintStore(context.env),
    blueprintDeploymentService: IsbServices.blueprintDeploymentService(
      context.env,
    ),
    leaseTemplateStore: IsbServices.leaseTemplateStore(context.env),
  };

  const ReviewLeaseBodySchema = z
    .object({
      action: z.enum(["Approve", "Deny"], {
        error: enumErrorMap,
      }),
    })
    .strict();
  const parsedReviewLeaseBody = ReviewLeaseBodySchema.safeParse(event.body);
  if (!parsedReviewLeaseBody.success) {
    throw createHttpJSendValidationError(parsedReviewLeaseBody.error);
  }

  const leaseCompositeKey = parseLeaseCompositeKeyFromPathParameters(
    event.pathParameters,
  );
  const leaseResponse = await isbContext.leaseStore.get(leaseCompositeKey);
  const lease = leaseResponse.result;
  if (leaseResponse.error) {
    logger.warn(
      `Error retrieving lease ${leaseCompositeKey}: ${leaseResponse.error}`,
    );
  }

  if (!lease) {
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

  if (parsedReviewLeaseBody.data.action == "Approve") {
    try {
      await InnovationSandbox.approveLease(
        { lease, approver: getUserEmail(context.user) },
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
    await InnovationSandbox.denyLease(
      { lease, denier: context.user },
      isbContext,
    );
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: null,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

async function freezeLeaseHandler(
  event: IsbApiEvent,
  context: ContextWithConfig & IsbApiContext<LeaseLambdaEnvironment>,
) {
  const isbContext = {
    logger,
    tracer,
    leaseStore: IsbServices.leaseStore(context.env),
    sandboxAccountStore: IsbServices.sandboxAccountStore(context.env),
    idcService: IsbServices.idcService(
      context.env,
      fromTemporaryIsbIdcCredentials(context.env),
    ),
    orgsService: IsbServices.orgsService(
      context.env,
      fromTemporaryIsbOrgManagementCredentials(context.env),
    ),
    organizationsTaggingService: IsbServices.organizationsTaggingService(
      context.env,
      fromTemporaryIsbOrgManagementCredentials(context.env),
    ),
    eventBridgeClient: IsbServices.isbEventBridge(context.env),
  };

  const leaseCompositeKey = parseLeaseCompositeKeyFromPathParameters(
    event.pathParameters,
  );
  const leaseResponse = await isbContext.leaseStore.get(leaseCompositeKey);
  const lease = leaseResponse.result;
  if (leaseResponse.error) {
    logger.warn(
      `Error retrieving lease ${leaseCompositeKey}: ${leaseResponse.error}`,
    );
  }

  if (!lease) {
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
          comment: `Manually frozen by ${getUserEmail(context.user)}`,
        },
      },
      isbContext,
    );
  } catch (error) {
    if (error instanceof AccountNotInActiveError) {
      throw createHttpJSendError({
        statusCode: 409,
        data: { errors: [{ message: error.message }] },
      });
    } else if (error instanceof ResourceLockConflictError) {
      // A competing critical operation holds the lock.
      throw createHttpJSendError({
        statusCode: 409,
        data: {
          errors: [
            {
              message:
                "Another operation is currently being processed for this lease. Try again once it completes.",
            },
          ],
        },
      });
    } else if (
      error instanceof CouldNotFindAccountError ||
      error instanceof CouldNotRetrieveUserError
    ) {
      throw createHttpJSendError({
        statusCode: 404,
        data: { errors: [{ message: error.message }] },
      });
    } else {
      throw error;
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: null,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}
/**
 * Throws 403 if a user-only caller is not permitted to terminate this lease.
 * Run before the 404 check so existence isn't leaked to unauthorized callers.
 */
function authorizeTermination(
  user: IsbUser,
  lease: Lease | undefined,
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

async function terminateLeaseHandler(
  event: IsbApiEvent,
  context: ContextWithConfig & IsbApiContext<LeaseLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const isbContext = {
    logger,
    tracer,
    leaseStore: IsbServices.leaseStore(context.env),
    sandboxAccountStore: IsbServices.sandboxAccountStore(context.env),
    idcService: IsbServices.idcService(
      context.env,
      fromTemporaryIsbIdcCredentials(context.env),
    ),
    orgsService: IsbServices.orgsService(
      context.env,
      fromTemporaryIsbOrgManagementCredentials(context.env),
    ),
    organizationsTaggingService: IsbServices.organizationsTaggingService(
      context.env,
      fromTemporaryIsbOrgManagementCredentials(context.env),
    ),
    eventBridgeClient: IsbServices.isbEventBridge(context.env),
    globalConfig: context.globalConfig,
    blueprintStore: IsbServices.blueprintStore(context.env),
    blueprintDeploymentService: IsbServices.blueprintDeploymentService(
      context.env,
    ),
  };

  const leaseCompositeKey = parseLeaseCompositeKeyFromPathParameters(
    event.pathParameters,
  );
  const leaseResponse = await isbContext.leaseStore.get(leaseCompositeKey);
  const lease = leaseResponse.result;
  if (leaseResponse.error) {
    logger.warn(
      `Error retrieving lease ${leaseCompositeKey}: ${leaseResponse.error}`,
    );
  }

  const { isUserOnly } = authorizeTermination(
    context.user,
    lease,
    context.globalConfig,
  );

  if (!lease) {
    throw createHttpJSendError({
      statusCode: 404,
      data: { errors: [{ message: "Lease not found." }] },
    });
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

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: null,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

async function unfreezeLeaseHandler(
  event: IsbApiEvent,
  context: ContextWithConfig & IsbApiContext<LeaseLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const isbContext = {
    logger,
    tracer,
    leaseStore: IsbServices.leaseStore(context.env),
    sandboxAccountStore: IsbServices.sandboxAccountStore(context.env),
    idcService: IsbServices.idcService(
      context.env,
      fromTemporaryIsbIdcCredentials(context.env),
    ),
    orgsService: IsbServices.orgsService(
      context.env,
      fromTemporaryIsbOrgManagementCredentials(context.env),
    ),
    organizationsTaggingService: IsbServices.organizationsTaggingService(
      context.env,
      fromTemporaryIsbOrgManagementCredentials(context.env),
    ),
    eventBridgeClient: IsbServices.isbEventBridge(context.env),
  };

  const leaseCompositeKey = parseLeaseCompositeKeyFromPathParameters(
    event.pathParameters,
  );
  const leaseResponse = await isbContext.leaseStore.get(leaseCompositeKey);
  const lease = leaseResponse.result;

  if (!lease || leaseResponse.error) {
    logger.warn(
      `Error retrieving lease ${leaseCompositeKey}: ${leaseResponse.error}`,
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
    const result = await InnovationSandbox.unfreezeLease({ lease }, isbContext);
    return {
      statusCode: 200,
      body: JSON.stringify({
        status: "success",
        data: {
          ...result.newItem,
          leaseId: base64EncodeCompositeKey({
            userEmail: result.newItem.userEmail,
            uuid: result.newItem.uuid,
          }),
        },
      }),
      headers: {
        "Content-Type": "application/json",
      },
    };
  } catch (error) {
    if (error instanceof AccountNotInFrozenError) {
      throw createHttpJSendError({
        statusCode: 409,
        data: { errors: [{ message: error.message }] },
      });
    } else if (error instanceof ResourceLockConflictError) {
      // Unfreeze is non-critical, so any live lock rejects it.
      throw createHttpJSendError({
        statusCode: 409,
        data: {
          errors: [
            {
              message:
                "Another operation is currently being processed for this lease. Try again once it completes.",
            },
          ],
        },
      });
    } else if (
      error instanceof CouldNotFindAccountError ||
      error instanceof CouldNotRetrieveUserError
    ) {
      throw createHttpJSendError({
        statusCode: 404,
        data: { errors: [{ message: error.message }] },
      });
    } else {
      throw error;
    }
  }
}

async function getLeaseAssignmentsHandler(
  event: IsbApiEvent,
  context: ContextWithConfig & IsbApiContext<LeaseLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const leaseStore = IsbServices.leaseStore(context.env);
  const principalStore = IsbServices.principalStore(context.env);

  const leaseCompositeKey = parseLeaseCompositeKeyFromPathParameters(
    event.pathParameters,
  );

  // Fetch lease to validate existence and check ownership for authorization
  const { result: lease } = await leaseStore.get(leaseCompositeKey);

  // Admin/Manager can view any lease's assignments.
  // Other users can only view their own — and get 403 even if lease doesn't exist.
  if (
    !isAdminOrManager(context.user) &&
    (!lease || getUserEmail(context.user) !== lease.userEmail)
  ) {
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
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: deriveAssignmentView(lease, assignments.result),
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

/**
 * GET /leases/shared query parameters.
 *
 * Public `maxResults` is capped at 100 and maps to internal `pageSize`.
 * Cursors are opaque strings consumed by the service layer; the handler does not introspect them.
 * `.strict()` rejects unknown query params so typos surface as 400 rather
 * than silently falling through to defaults.
 */
const GetSharedLeasesQueryParametersSchema =
  createPaginationQueryStringParametersSchema({ maxPageSize: 100 })
    .extend({
      userId: IdcPrincipalIdSchema,
      accessType: z.enum(["direct", "group"]),
    })
    .strict();

async function getSharedLeasesHandler(
  event: IsbApiEvent,
  context: ContextWithConfig & IsbApiContext<LeaseLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const parsed = GetSharedLeasesQueryParametersSchema.safeParse(
    event.queryStringParameters,
  );
  if (!parsed.success) {
    throw createHttpJSendValidationError(parsed.error);
  }
  const { userId, accessType, pageIdentifier, maxResults } = parsed.data;

  // Admin/Manager can query shared leases for any user. Other callers must
  // be an IDC user querying their own userId — no cross-user observation.
  // M2M callers without elevated roles cannot use this endpoint.
  if (!isAdminOrManager(context.user)) {
    if (isM2MUser(context.user)) {
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
    if (!isIdcUser(context.user) || context.user.userId !== userId) {
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

  const leaseStore = IsbServices.leaseStore(context.env);
  const principalStore = IsbServices.principalStore(context.env);

  const result =
    accessType === "direct"
      ? await getLeasesForUserDirect(
          { userId, pageIdentifier, pageSize: maxResults },
          { leaseStore, principalStore, logger },
        )
      : await getLeasesForUserViaGroups(
          { userId, pageIdentifier, pageSize: maxResults },
          {
            leaseStore,
            principalStore,
            idcService: IsbServices.idcService(
              context.env,
              fromTemporaryIsbIdcCredentials(context.env),
            ),
            logger,
          },
        );

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: {
        result: result.result.map((lease) => ({
          ...lease,
          leaseId: base64EncodeCompositeKey({
            userEmail: lease.userEmail,
            uuid: lease.uuid,
          }),
        })),
        nextPageIdentifier: result.nextPageIdentifier,
        ...(result.error !== undefined ? { error: result.error } : {}),
      },
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

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

async function putLeaseAssignmentsHandler(
  event: IsbApiEvent,
  context: ContextWithConfig & IsbApiContext<LeaseLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const leaseStore = IsbServices.leaseStore(context.env);

  // Parse and validate the request body
  const bodyParseResult = PutLeaseAssignmentsBodySchema.safeParse(event.body);
  if (!bodyParseResult.success) {
    throw createHttpJSendValidationError(bodyParseResult.error);
  }

  const { assignments: desiredAssignments } = bodyParseResult.data;

  // Get the lease
  const leaseCompositeKey = parseLeaseCompositeKeyFromPathParameters(
    event.pathParameters,
  );
  const { result: lease } = await leaseStore.get(leaseCompositeKey);

  // Admin/Manager can manage any lease's assignments.
  // Other users can only manage their own — and get 403 even if the lease
  // doesn't exist, so existence cannot be inferred from the status code.
  if (
    !isAdminOrManager(context.user) &&
    getUserEmail(context.user) !== lease?.userEmail
  ) {
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
  assertCallerCanManageAssignments(context, lease);

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
  const callerEmail = getUserEmail(context.user);
  const principalStore = IsbServices.principalStore(context.env);

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
        leaseStore: IsbServices.leaseStore(context.env),
        eventBridgeClient: IsbServices.isbEventBridge(context.env),
        principalStore,
        idcService: IsbServices.idcService(
          context.env,
          fromTemporaryIsbIdcCredentials(context.env),
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
      statusCode: 202,
      body: JSON.stringify({
        status: "success",
        data: { desiredCount },
      }),
      headers: {
        "Content-Type": "application/json",
      },
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
  lease: Lease,
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
 * owner (see putLeaseAssignmentsHandler); this only enforces the sharing flags.
 */
function assertCallerCanManageAssignments(
  context: ContextWithConfig & IsbApiContext<LeaseLambdaEnvironment>,
  lease: Lease,
): void {
  // Admin/Manager always have access regardless of global flag
  if (isAdminOrManager(context.user)) return;

  // For non-elevated owners, check the global flag
  if (!context.globalConfig.leases.leaseSharingEnabled) {
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

function parseLeaseCompositeKeyFromPathParameters(
  pathParameters: APIGatewayProxyEventPathParameters,
) {
  // leaseId is a base64url-encoded composite key (URL-safe alphabet, no padding).
  const PathParametersSchema = z.object({
    leaseId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  });
  const parsedPathParametersResponse =
    PathParametersSchema.safeParse(pathParameters);
  if (!parsedPathParametersResponse.success) {
    throw createHttpJSendValidationError(parsedPathParametersResponse.error);
  }

  let decodedCompositeKey: Record<string, any> | undefined;
  try {
    decodedCompositeKey = base64DecodeCompositeKey(pathParameters.leaseId);
  } catch (e) {
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
