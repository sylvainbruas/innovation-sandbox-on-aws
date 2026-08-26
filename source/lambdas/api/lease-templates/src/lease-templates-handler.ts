// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import middy from "@middy/core";
import { type Route, default as httpRouterHandler } from "@middy/http-router";
import type { APIGatewayProxyResult } from "aws-lambda";

import { UnknownItem } from "@amzn/innovation-sandbox-commons/data/errors.js";
import {
  validateLeaseTemplateCompliesWithGlobalConfig,
  ValidationException,
} from "@amzn/innovation-sandbox-commons/data/global-config/global-config-utils.js";
import { LeaseTemplateSchema } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { validateCostReportGroup } from "@amzn/innovation-sandbox-commons/data/reporting-config/reporting-config-utils.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  LeaseTemplateLambdaEnvironment,
  LeaseTemplateLambdaEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/lease-template-lambda-environment.js";
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
import { createPaginationQueryStringParametersSchema } from "@amzn/innovation-sandbox-commons/lambda/schemas.js";
import {
  addCorrelationContext,
  LogPatterns,
  searchableLeaseTemplateProperties,
  summarizeUpdate,
} from "@amzn/innovation-sandbox-commons/observability/logging.js";
import {
  type IsbRole,
  type IsbUser,
  getUserEmail,
} from "@amzn/innovation-sandbox-commons/utils/auth-utils.js";
import { randomUUID } from "crypto";

const tracer = new Tracer();
const logger = new Logger();

const middyFactory = middy<
  IsbApiEvent,
  any,
  Error,
  ContextWithConfig & IsbApiContext<LeaseTemplateLambdaEnvironment>
>;

const routes: Route<IsbApiEvent, APIGatewayProxyResult>[] = [
  {
    path: "/leaseTemplates",
    method: "GET",
    handler: middyFactory().handler(getLeaseTemplatesHandler),
  },
  {
    path: "/leaseTemplates",
    method: "POST",
    handler: middyFactory()
      .use(httpJsonBodyParser())
      .handler(postLeaseTemplatesHandler),
  },
  {
    path: "/leaseTemplates/{leaseTemplateId}",
    method: "GET",
    handler: middyFactory().handler(getLeaseTemplateByIdHandler),
  },
  {
    path: "/leaseTemplates/{leaseTemplateId}",
    method: "PUT",
    handler: middyFactory()
      .use(httpJsonBodyParser())
      .handler(putLeaseTemplateByIdHandler),
  },
  {
    path: "/leaseTemplates/{leaseTemplateId}",
    method: "DELETE",
    handler: middyFactory().handler(deleteLeaseTemplateByIdHandler),
  },
];

export const handler = apiMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: LeaseTemplateLambdaEnvironmentSchema,
})
  .use(isbConfigMiddleware())
  .handler(httpRouterHandler(routes));

async function getLeaseTemplatesHandler(
  event: IsbApiEvent,
  context: ContextWithConfig & IsbApiContext<LeaseTemplateLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const leaseTemplateStore = IsbServices.leaseTemplateStore(context.env);

  const parsedPaginationParametersResult =
    createPaginationQueryStringParametersSchema({
      maxPageSize: 2000,
    }).safeParse(event.queryStringParameters);

  if (!parsedPaginationParametersResult.success) {
    throw createHttpJSendValidationError(
      parsedPaginationParametersResult.error,
    );
  }

  const { pageIdentifier, maxResults } = parsedPaginationParametersResult.data;

  // Filter PRIVATE templates out at the query layer for non-elevated users so
  // that neither the result set nor the pagination token can disclose a PRIVATE
  // template's UUID.
  const { result, nextPageIdentifier, error } =
    await leaseTemplateStore.findAllVisible({
      pageIdentifier,
      pageSize: maxResults,
      includePrivate: authorizedToGetPrivateLeaseTemplates(context.user),
    });

  if (error) {
    logger.warn(
      `${LogPatterns.DataValidationWarning.pattern}: Error while fetching lease templates - ${error}`,
    );
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: { result, nextPageIdentifier },
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

async function postLeaseTemplatesHandler(
  event: IsbApiEvent,
  context: ContextWithConfig & IsbApiContext<LeaseTemplateLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const leaseTemplateStore = IsbServices.leaseTemplateStore(context.env);

  const parsedBodyResult = LeaseTemplateSchema.omit({
    uuid: true,
    createdBy: true,
    blueprintName: true,
    meta: true,
  }).safeParse(event.body);

  if (!parsedBodyResult.success) {
    throw createHttpJSendValidationError(parsedBodyResult.error);
  }

  try {
    validateLeaseTemplateCompliesWithGlobalConfig(
      parsedBodyResult.data,
      context.globalConfig,
    );
    validateCostReportGroup(
      parsedBodyResult.data.costReportGroup,
      context.globalConfig.costReporting,
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

  const blueprintName = await resolveBlueprintName(
    parsedBodyResult.data.blueprintId,
    context.env,
  );

  const newLeaseTemplate = await leaseTemplateStore.create({
    uuid: randomUUID(),
    createdBy: getUserEmail(context.user),
    ...parsedBodyResult.data,
    blueprintName,
  });

  addCorrelationContext(
    logger,
    searchableLeaseTemplateProperties(newLeaseTemplate),
  );

  logger.info(
    `Created new LeaseTemplate (${newLeaseTemplate.name}) (${newLeaseTemplate.uuid})`,
    summarizeUpdate({
      oldItem: undefined,
      newItem: newLeaseTemplate,
    }),
  );

  return {
    statusCode: 201,
    body: JSON.stringify({
      status: "success",
      data: newLeaseTemplate,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

async function getLeaseTemplateByIdHandler(
  event: IsbApiEvent,
  context: ContextWithConfig & IsbApiContext<LeaseTemplateLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const leaseTemplateStore = IsbServices.leaseTemplateStore(context.env);

  if (event.pathParameters.leaseTemplateId === undefined) {
    throw createHttpJSendError({
      statusCode: 400,
      data: {
        errors: [{ message: "{leaseTemplateId} path parameter is required." }],
      },
    });
  }

  const leaseTemplateResponse = await leaseTemplateStore.get(
    event.pathParameters.leaseTemplateId,
  );
  const leaseTemplate = leaseTemplateResponse.result;
  if (leaseTemplateResponse.error) {
    logger.warn(
      `${LogPatterns.DataValidationWarning.pattern}: Error retrieving lease template ${event.pathParameters.leaseTemplateId}: ${leaseTemplateResponse.error}`,
    );
  }

  if (
    !leaseTemplate ||
    (leaseTemplate.visibility === "PRIVATE" &&
      !authorizedToGetPrivateLeaseTemplates(context.user))
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

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: leaseTemplate,
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

async function putLeaseTemplateByIdHandler(
  event: IsbApiEvent,
  context: ContextWithConfig & IsbApiContext<LeaseTemplateLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const leaseTemplateStore = IsbServices.leaseTemplateStore(context.env);

  if (event.pathParameters.leaseTemplateId == null) {
    throw createHttpJSendError({
      statusCode: 400,
      data: {
        errors: [{ message: "{leaseTemplateId} path parameter is required." }],
      },
    });
  }

  const parsedBodyResult = LeaseTemplateSchema.omit({
    uuid: true,
    createdBy: true,
    blueprintName: true,
  }).safeParse(event.body);

  if (!parsedBodyResult.success) {
    throw createHttpJSendValidationError(parsedBodyResult.error);
  }

  // Fetch the existing template so config-compliance validation is
  // change-aware: a required-but-missing field (cost report group, max budget,
  // duration) shouldn't block edits to unrelated fields on a template that
  // predates the requirement.
  const existingTemplateResponse = await leaseTemplateStore.get(
    event.pathParameters.leaseTemplateId,
  );
  const existingTemplate = existingTemplateResponse.result;

  if (!existingTemplate) {
    throw createHttpJSendError({
      statusCode: 404,
      data: {
        errors: [
          {
            message: `Lease Template not found.`,
          },
        ],
      },
    });
  }

  try {
    validateLeaseTemplateCompliesWithGlobalConfig(
      parsedBodyResult.data,
      context.globalConfig,
      { previous: existingTemplate },
    );
    validateCostReportGroup(
      parsedBodyResult.data.costReportGroup,
      context.globalConfig.costReporting,
      { previousCostReportGroup: existingTemplate.costReportGroup },
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

  const resolvedBlueprintName = await resolveBlueprintName(
    parsedBodyResult.data.blueprintId,
    context.env,
  );

  // createdBy is server-owned: stripped from the request body above and
  // restored here from the persisted record.
  const leaseTemplate = {
    uuid: event.pathParameters.leaseTemplateId,
    ...parsedBodyResult.data,
    createdBy: existingTemplate.createdBy,
    blueprintName: resolvedBlueprintName,
  };

  try {
    const result = await leaseTemplateStore.update(leaseTemplate);

    logger.info(
      `Updated LeaseTemplate (${leaseTemplate.name})(${leaseTemplate.uuid})`,
      summarizeUpdate(result),
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        status: "success",
        data: result.newItem,
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
              message: `Lease Template not found.`,
            },
          ],
        },
      });
    } else {
      throw error;
    }
  }
}

async function deleteLeaseTemplateByIdHandler(
  event: IsbApiEvent,
  context: ContextWithConfig & IsbApiContext<LeaseTemplateLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const leaseTemplateStore = IsbServices.leaseTemplateStore(context.env);

  if (event.pathParameters.leaseTemplateId === undefined) {
    throw createHttpJSendError({
      statusCode: 400,
      data: {
        errors: [{ message: "{leaseTemplateId} path parameter is required." }],
      },
    });
  }

  const itemId = event.pathParameters.leaseTemplateId;
  const deletedItem = await leaseTemplateStore.delete(itemId);
  if (deletedItem) {
    logger.info(
      `deleted lease template (${itemId})`,
      summarizeUpdate({ oldItem: deletedItem }),
    );
  } else {
    logger.info(
      `attempted to delete lease template (${itemId}), but it did not exist`,
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

function authorizedToGetPrivateLeaseTemplates(user: IsbUser) {
  return user.roles.some(
    (role: IsbRole) => role === "Admin" || role === "Manager",
  );
}

async function resolveBlueprintName(
  blueprintId: string | null | undefined,
  env: LeaseTemplateLambdaEnvironment,
): Promise<string | null> {
  if (!blueprintId) return null;
  const blueprintStore = IsbServices.blueprintStore(env);
  const blueprintResult = await blueprintStore.get(blueprintId);
  if (!blueprintResult.result) {
    throw createHttpJSendError({
      statusCode: 400,
      data: {
        errors: [
          {
            message: "Referenced blueprint not found.",
          },
        ],
      },
    });
  }
  return blueprintResult.result.blueprint.name;
}
