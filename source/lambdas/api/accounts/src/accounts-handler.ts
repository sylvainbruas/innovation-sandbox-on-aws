// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";

import {
  AccountsApiServiceOperations,
  getAccountsApiServiceHandler,
  JSendStatus,
  ValidationError,
} from "@amzn/innovation-sandbox-api-server/accounts";
import { AccountLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/account-lambda-environment.js";
import apiMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/api-middleware-bundle.js";
import { isbConfigMiddleware } from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";
import { toLambdaHandler } from "@amzn/innovation-sandbox-commons/lambda/smithy/api-gateway-handler.js";
import { jsendValidationCustomizer } from "@amzn/innovation-sandbox-commons/lambda/smithy/jsend-validation-customizer.js";
import { preferLiteralRoutes } from "@amzn/innovation-sandbox-commons/lambda/smithy/prefer-literal-routes.js";

import { accountsService } from "@amzn/innovation-sandbox-accounts/smithy/account-operations.js";

const tracer = new Tracer();
const logger = new Logger();

// The `accounts` domain is served by the generated per-domain `AccountsApi`
// service handler: the mux routes all nine methods (list/get/register accounts,
// unregistered accounts, cleanup reports, and the eject/quarantine/retry-cleanup/
// skip-cooldown actions), the model validates the request, and the generated
// `restJson1` serializer writes each JSend response body (projecting away only
// each account's internal `meta.schemaVersion`; `resourceLock` is retained).
// `preferLiteralRoutes` restores literal-over-label routing precedence so
// `GET /accounts/unregistered` reaches `ListUnregisteredAccounts` rather than
// `GetAccount` (`/accounts/{awsAccountId}`) — see the helper for why the generated
// mux would otherwise mis-route it.
const serviceHandler = preferLiteralRoutes(
  getAccountsApiServiceHandler(
    accountsService(logger),
    // The concrete `ValidationError` is this domain's generated class; the shared
    // customizer supplies the field formatting and blank-message rule.
    jsendValidationCustomizer<AccountsApiServiceOperations>(
      (errors) =>
        new ValidationError({
          status: JSendStatus.FAIL,
          message: "",
          data: { errors },
        }),
    ),
  ),
);

// `apiMiddlewareBundle` runs first (env validation, auth/RBAC, security headers,
// `httpErrorHandler`); `isbConfigMiddleware` loads `globalConfig` (eject/quarantine
// need it); `toLambdaHandler` converts the event, dispatches through the generated
// pipeline, and converts the response back to the pre-Smithy wire.
export const handler = apiMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: AccountLambdaEnvironmentSchema,
})
  .use(isbConfigMiddleware())
  .handler(toLambdaHandler(serviceHandler));
