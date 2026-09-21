// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";

import {
  getLeasesApiServiceHandler,
  JSendStatus,
  LeasesApiServiceOperations,
  ValidationError,
} from "@amzn/innovation-sandbox-api-server/leases";
import { LeaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-lambda-environment.js";
import apiMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/api-middleware-bundle.js";
import { isbConfigMiddleware } from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";
import { toLambdaHandler } from "@amzn/innovation-sandbox-commons/lambda/smithy/api-gateway-handler.js";
import { jsendValidationCustomizer } from "@amzn/innovation-sandbox-commons/lambda/smithy/jsend-validation-customizer.js";
import { preferLiteralRoutes } from "@amzn/innovation-sandbox-commons/lambda/smithy/prefer-literal-routes.js";

import { leasesService } from "@amzn/innovation-sandbox-leases/smithy/lease-operations.js";

const tracer = new Tracer();
const logger = new Logger({ serviceName: "Leases" });

// The `leases` domain is served by the generated per-domain `LeasesApi` service
// handler: the mux routes all eleven methods (list/request/get/update leases,
// shared leases, freeze/review/terminate/unfreeze, and the assignments read/write),
// the model validates the request, and the generated `restJson1` serializer writes
// each JSend response body (all lease timestamps are raw `String`, emitted
// byte-faithfully; `meta.schemaVersion` is projected away).
// `preferLiteralRoutes` restores literal-over-label routing precedence so
// `GET /leases/shared` reaches `ListSharedLeases` rather than `GetLease`
// (`/leases/{leaseId}`) — see the helper for why the generated mux would otherwise
// mis-route it.
//
// Leases-specific behaviors are preserved inside the operations: `RequestLease`
// calls `rejectIfAssigneeIsM2m` before any write, and the strict Zod re-parses for
// `RequestLease`/`UpdateLease`/`UpdateLeaseAssignments` are retained supplements.
const serviceHandler = preferLiteralRoutes(
  getLeasesApiServiceHandler(
    leasesService(logger),
    // The concrete `ValidationError` is this domain's generated class; the shared
    // customizer supplies the field formatting and blank-message rule.
    jsendValidationCustomizer<LeasesApiServiceOperations>(
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
// `httpErrorHandler`); `isbConfigMiddleware` loads `globalConfig` (request/review/
// terminate/assignments all need it); `toLambdaHandler` converts the event,
// dispatches through the generated pipeline, and converts the response back to the
// pre-Smithy wire.
export const handler = apiMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: LeaseLambdaEnvironmentSchema,
})
  .use(isbConfigMiddleware())
  .handler(toLambdaHandler(serviceHandler));
