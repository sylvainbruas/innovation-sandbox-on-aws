// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";

import {
  getPrincipalsApiServiceHandler,
  JSendStatus,
  PrincipalsApiServiceOperations,
  ValidationError,
} from "@amzn/innovation-sandbox-api-server/principals";
import { PrincipalsLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/principals-lambda-environment.js";
import apiMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/api-middleware-bundle.js";
import { toLambdaHandler } from "@amzn/innovation-sandbox-commons/lambda/smithy/api-gateway-handler.js";
import { jsendValidationCustomizer } from "@amzn/innovation-sandbox-commons/lambda/smithy/jsend-validation-customizer.js";

import { principalsService } from "@amzn/innovation-sandbox-principals-handler/smithy/principal-operations.js";

const tracer = new Tracer();
const logger = new Logger({ serviceName: "Principals" });

// The `principals` domain is served by the generated per-domain `PrincipalsApi`
// service handler: the mux routes `GET /principals/search`, the model validates
// the query parameters, and the generated `restJson1` serializer writes the JSend
// response body.
const serviceHandler = getPrincipalsApiServiceHandler(
  principalsService(logger),
  // The concrete `ValidationError` is this domain's generated class; the shared
  // customizer supplies the field formatting and blank-message rule.
  jsendValidationCustomizer<PrincipalsApiServiceOperations>(
    (errors) =>
      new ValidationError({
        status: JSendStatus.FAIL,
        message: "",
        data: { errors },
      }),
  ),
);

// `apiMiddlewareBundle` runs first (env validation, auth/RBAC, config load —
// which populates `globalConfig` — security headers, `httpErrorHandler`);
// `toLambdaHandler` converts the event, dispatches through the generated pipeline,
// and converts the response back to the pre-Smithy wire. No write-blocking
// middleware is needed: the only operation is a read.
export const handler = apiMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: PrincipalsLambdaEnvironmentSchema,
}).handler(toLambdaHandler(serviceHandler));
