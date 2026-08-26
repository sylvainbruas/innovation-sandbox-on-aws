// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import middy from "@middy/core";
import { type Route, default as httpRouterHandler } from "@middy/http-router";
import type { APIGatewayProxyResult } from "aws-lambda";
import { z } from "zod";

import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  PrincipalsLambdaEnvironment,
  PrincipalsLambdaEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/principals-lambda-environment.js";
import apiMiddlewareBundle, {
  IsbApiContext,
  IsbApiEvent,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/api-middleware-bundle.js";
import {
  createHttpJSendError,
  createHttpJSendValidationError,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import { ContextWithConfig } from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";
import { fromTemporaryIsbIdcCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";

const tracer = new Tracer();
const logger = new Logger({ serviceName: "Principals" });

const middyFactory = middy<
  IsbApiEvent,
  APIGatewayProxyResult,
  Error,
  ContextWithConfig & IsbApiContext<PrincipalsLambdaEnvironment>
>;

const routes: Route<IsbApiEvent, APIGatewayProxyResult>[] = [
  {
    path: "/principals/search",
    method: "GET",
    handler: middyFactory().handler(searchPrincipalsHandler),
  },
];

export const handler = apiMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: PrincipalsLambdaEnvironmentSchema,
}).handler(httpRouterHandler(routes));

const TYPE_PARAM_TO_FILTER = {
  users: "USER",
  groups: "GROUP",
  all: undefined,
} as const;

const SearchQueryParametersSchema = z.object({
  q: z.string().max(200).default(""),
  type: z.enum(["users", "groups", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  exact: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

async function searchPrincipalsHandler(
  event: IsbApiEvent,
  context: IsbApiContext<PrincipalsLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const parsedParams = SearchQueryParametersSchema.safeParse(
    event.queryStringParameters ?? {},
  );

  if (!parsedParams.success) {
    throw createHttpJSendValidationError(parsedParams.error);
  }

  const { q: query, type: typeParam, limit, exact } = parsedParams.data;

  // Gate: when principal search is disabled, only allow exact lookups.
  if (!context.globalConfig.leases.enablePrincipalSearch && !exact) {
    throw createHttpJSendError({
      statusCode: 403,
      data: {
        errors: [
          {
            message: "Principal search is not enabled.",
          },
        ],
      },
    });
  }

  // Exact lookup requires a non-empty query and a specific type (users or groups).
  if (exact) {
    return handleExactLookup(query, typeParam, context);
  }

  // --- Standard fuzzy search (enablePrincipalSearch is true) ---
  const principalStore = IsbServices.principalStore(context.env);

  // Read from DynamoDB cache
  const cacheItems = await principalStore.getCacheItems({
    type: TYPE_PARAM_TO_FILTER[typeParam],
  });

  // Filter by search query with early collection at limit
  const lower = query.toLowerCase();

  const matched = cacheItems.filter(
    (item: (typeof cacheItems)[number]) =>
      query.length === 0 ||
      item.displayName?.toLowerCase().includes(lower) ||
      (item.email?.toLowerCase().includes(lower) ?? false),
  );

  const principals = matched.slice(0, limit).map((item) => ({
    principalId: item.principalId,
    principalType: item.principalType,
    displayName: item.displayName,
    ...(item.email && { email: item.email }),
  }));

  const totalMatches = matched.length;

  logger.info("Principals search complete", {
    query,
    type: typeParam,
    limit,
    totalMatches,
    returned: principals.length,
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: {
        principals,
        totalMatches,
      },
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

/**
 * Handles exact principal resolution via the cached read-through method on
 * IdcService. Cache check + IDC fallback + write-through are encapsulated
 * inside getCachedPrincipalByAttr.
 */
async function handleExactLookup(
  query: string,
  typeParam: "users" | "groups" | "all",
  context: IsbApiContext<PrincipalsLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  if (query.length === 0) {
    throw createHttpJSendError({
      statusCode: 400,
      data: {
        errors: [
          { message: "Query parameter 'q' is required for exact lookups." },
        ],
      },
    });
  }
  if (typeParam === "all") {
    throw createHttpJSendError({
      statusCode: 400,
      data: {
        errors: [
          {
            message:
              "Query parameter 'type' must be 'users' or 'groups' for exact lookups.",
          },
        ],
      },
    });
  }

  const idcType = TYPE_PARAM_TO_FILTER[typeParam]!;
  const credentials = fromTemporaryIsbIdcCredentials(context.env);
  const idcService = IsbServices.idcService(context.env, credentials);
  const principalStore = IsbServices.principalStore(context.env);

  const resolved = await idcService.getCachedPrincipalByAttr(
    idcType,
    query,
    principalStore,
    logger,
  );

  if (!resolved) {
    throw createHttpJSendError({
      statusCode: 404,
      data: {
        errors: [
          {
            message: "Principal not found in the identity store.",
          },
        ],
      },
    });
  }

  logger.info("Exact lookup resolved", {
    query,
    type: typeParam,
    principalId: resolved.principalId,
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: {
        principals: [
          {
            principalId: resolved.principalId,
            principalType: resolved.principalType,
            displayName: resolved.displayName,
            ...(resolved.email && { email: resolved.email }),
          },
        ],
        totalMatches: 1,
      },
    }),
    headers: { "Content-Type": "application/json" },
  };
}
