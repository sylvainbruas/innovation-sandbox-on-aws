// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { MiddlewareObj } from "@middy/core";

import {
  ConfigurationsApiServiceOperations,
  getConfigurationsApiServiceHandler,
  JSendStatus,
  ValidationError,
} from "@amzn/innovation-sandbox-api-server/configurations";
import { ConfigurationLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/config-lambda-environment.js";
import apiMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/api-middleware-bundle.js";
import { createHttpJSendError } from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import { isbConfigMiddleware } from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";
import { toLambdaHandler } from "@amzn/innovation-sandbox-commons/lambda/smithy/api-gateway-handler.js";
import { jsendValidationCustomizer } from "@amzn/innovation-sandbox-commons/lambda/smithy/jsend-validation-customizer.js";
import { isM2MUser } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

import { configurationService } from "@amzn/innovation-sandbox-configurations/smithy/configuration-operations.js";

const tracer = new Tracer();
const logger = new Logger();

/**
 * Rejects M2M callers from any non-GET (write) request BEFORE the generated
 * pipeline runs, so an unauthorized M2M write gets a 403 ahead of model
 * validation — restoring authorization-before-validation. (The generic RBAC map
 * already restricts config writes to Admin; this additionally blocks M2M-Admin
 * principals, matching the pre-Smithy handler.) `updateSection` keeps an inline
 * check as a defense-in-depth backstop.
 */
export function rejectM2mConfigWrites(): MiddlewareObj {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    before: (request: any) => {
      if (
        request.event?.httpMethod !== "GET" &&
        isM2MUser(request.context?.user)
      ) {
        throw createHttpJSendError({
          statusCode: 403,
          data: {
            errors: [
              { message: "User is not authorized to update configuration." },
            ],
          },
        });
      }
    },
  };
}

// The whole `configurations` domain is served by the generated per-domain
// `ConfigurationsApi` service handler: the mux routes all thirteen methods (the
// aggregate read plus a read and a write per section), the model validates, and
// the generated `restJson1` serializer writes each response body. The service is
// scoped to this domain's operations, so `configurationService` implements
// exactly these rather than the whole aggregate API.
const serviceHandler = getConfigurationsApiServiceHandler(
  configurationService(logger),
  // The concrete `ValidationError` is this domain's generated class; the shared
  // customizer supplies the field formatting and blank-message rule.
  jsendValidationCustomizer<ConfigurationsApiServiceOperations>(
    (errors) =>
      new ValidationError({
        status: JSendStatus.FAIL,
        message: "",
        data: { errors },
      }),
  ),
);

// The middleware bundle runs first (env validation, auth/RBAC, config, security
// headers, `httpErrorHandler`); `toLambdaHandler` is the shared Lambda handler
// that converts the event, dispatches through the generated pipeline, and converts
// the response back to the pre-Smithy wire.
export const handler = apiMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: ConfigurationLambdaEnvironmentSchema,
})
  .use(isbConfigMiddleware())
  .use(rejectM2mConfigWrites())
  .handler(toLambdaHandler(serviceHandler));
