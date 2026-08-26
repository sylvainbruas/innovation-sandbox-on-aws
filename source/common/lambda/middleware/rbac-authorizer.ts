// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  HttpMethod,
  authorizationMap,
} from "@amzn/innovation-sandbox-commons/lambda/authorization-map.js";
import { BaseApiLambdaEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/base-api-lambda-environment.js";
import { IsbApiContext } from "@amzn/innovation-sandbox-commons/lambda/middleware/api-middleware-bundle.js";
import { createHttpJSendError } from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import type {
  IsbRole,
  IsbUser,
} from "@amzn/innovation-sandbox-commons/utils/auth-utils.js";
import { MiddlewareFn } from "@aws-lambda-powertools/commons/types";
import { MiddlewareObj } from "@middy/core";
import { APIGatewayProxyEvent } from "aws-lambda";

export function getAllowedRoles(path: string, method: HttpMethod): IsbRole[] {
  const entry = authorizationMap[path];
  if (!entry) {
    return [];
  }
  const roles = entry[method];
  if (roles && roles.length > 0) {
    return roles;
  }
  return entry["ALL"] ?? [];
}

export function resolveAllowedRoles(
  path: string,
  method: HttpMethod,
): IsbRole[] {
  const exactRoles = getAllowedRoles(path, method);
  if (exactRoles.length > 0) {
    return exactRoles;
  }

  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) {
    return [];
  }

  // /resource/{param} — path parameter at end
  const withParamEnd = "/" + [...segments.slice(0, -1), "{param}"].join("/");
  const endRoles = getAllowedRoles(withParamEnd, method);
  if (endRoles.length > 0) {
    return endRoles;
  }

  // /resource/{param}/action — path parameter in middle
  if (segments.length >= 3) {
    const withParamMiddle =
      "/" +
      [...segments.slice(0, -2), "{param}", segments[segments.length - 1]].join(
        "/",
      );
    const middleRoles = getAllowedRoles(withParamMiddle, method);
    if (middleRoles.length > 0) {
      return middleRoles;
    }
  }

  return [];
}

export function isAllowedInMaintenanceMode(
  user: IsbUser,
  path: string,
  method: string,
): boolean {
  const isGetConfig = method === "GET" && path.startsWith("/configurations");
  return (user.roles?.includes("Admin") ?? false) || isGetConfig;
}

export function rbacAuthorizer<
  T extends BaseApiLambdaEnvironment,
>(): MiddlewareObj<APIGatewayProxyEvent, any, Error, IsbApiContext<T>> {
  const rbacAuthorizerBefore: MiddlewareFn<
    APIGatewayProxyEvent,
    any,
    Error,
    IsbApiContext<T>
  > = async (request) => {
    const { user } = request.context;
    const { path, httpMethod } = request.event;
    const method = httpMethod as HttpMethod;

    const allowedRoles = resolveAllowedRoles(path, method);

    if (allowedRoles.length === 0) {
      throw createHttpJSendError({
        statusCode: 403,
        data: {
          errors: [{ message: "Access denied." }],
        },
      });
    }

    const userRoles = user.roles ?? [];
    const hasAllowedRole = userRoles.some((role) =>
      allowedRoles.includes(role),
    );

    if (!hasAllowedRole) {
      throw createHttpJSendError({
        statusCode: 403,
        data: {
          errors: [{ message: "Access denied." }],
        },
      });
    }

    const { globalConfig } = request.context;
    if (globalConfig.maintenance.enabled) {
      if (!isAllowedInMaintenanceMode(user, path, method)) {
        throw createHttpJSendError({
          statusCode: 403,
          data: {
            errors: [
              {
                message:
                  "System is in maintenance mode. Only Admin users may access the system.",
              },
            ],
          },
        });
      }
    }
  };

  return {
    before: rbacAuthorizerBefore,
  };
}
