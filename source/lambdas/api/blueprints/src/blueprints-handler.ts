// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";

import {
  BlueprintsApiServiceOperations,
  getBlueprintsApiServiceHandler,
  JSendStatus,
  ValidationError,
} from "@amzn/innovation-sandbox-api-server/blueprints";
import { BlueprintLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/blueprint-lambda-environment.js";
import apiMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/api-middleware-bundle.js";
import { isbConfigMiddleware } from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";
import { toLambdaHandler } from "@amzn/innovation-sandbox-commons/lambda/smithy/api-gateway-handler.js";
import { jsendValidationCustomizer } from "@amzn/innovation-sandbox-commons/lambda/smithy/jsend-validation-customizer.js";
import { preferLiteralRoutes } from "@amzn/innovation-sandbox-commons/lambda/smithy/prefer-literal-routes.js";

import { blueprintsService } from "@amzn/innovation-sandbox-blueprints-handler/smithy/blueprint-operations.js";

const tracer = new Tracer();
const logger = new Logger();

// The `blueprints` domain is served by the generated per-domain `BlueprintsApi`
// service handler: the mux routes all six methods (list stacksets / list blueprints
// / register / get / update / delete), the model validates the request, and the
// generated `restJson1` serializer writes each JSend response body. The persisted
// entities' internal DynamoDB fields (`PK`/`SK`/`itemType`, and deployment
// `ttl`/`meta`) are not modeled, so the serializer projects them away — no consumer
// reads them (see the model's accepted deviations).
//
// `preferLiteralRoutes` restores literal-over-label routing precedence so
// `GET /blueprints/stacksets` reaches `ListStackSets` rather than `GetBlueprint`
// (`/blueprints/{blueprintId}`) — the generated mux ranks by segment count only,
// which would otherwise mis-route the literal to the label (a 400 from the
// `blueprintId` UUID pattern), the same collision `/accounts/unregistered` and
// `/leases/shared` hit.
//
// Register/Update retain a strict Zod re-parse of the raw body inside the
// operations (the omit/pick + StackSet-param coupling and unknown-key rejection
// the model cannot express).
const serviceHandler = preferLiteralRoutes(
  getBlueprintsApiServiceHandler(
    blueprintsService(logger),
    // The concrete `ValidationError` is this domain's generated class; the shared
    // customizer supplies the field formatting and blank-message rule.
    jsendValidationCustomizer<BlueprintsApiServiceOperations>(
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
// `httpErrorHandler`); `isbConfigMiddleware` loads `globalConfig`; `toLambdaHandler`
// converts the event, dispatches through the generated pipeline, and converts the
// response back to the pre-Smithy wire.
export const handler = apiMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: BlueprintLambdaEnvironmentSchema,
})
  .use(isbConfigMiddleware())
  .handler(toLambdaHandler(serviceHandler));
