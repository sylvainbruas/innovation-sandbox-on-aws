// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";

import {
  getLeaseTemplatesApiServiceHandler,
  JSendStatus,
  LeaseTemplatesApiServiceOperations,
  ValidationError,
} from "@amzn/innovation-sandbox-api-server/lease-templates";
import { LeaseTemplateLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-template-lambda-environment.js";
import apiMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/api-middleware-bundle.js";
import { isbConfigMiddleware } from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";
import { toLambdaHandler } from "@amzn/innovation-sandbox-commons/lambda/smithy/api-gateway-handler.js";
import { jsendValidationCustomizer } from "@amzn/innovation-sandbox-commons/lambda/smithy/jsend-validation-customizer.js";

import { leaseTemplateService } from "@amzn/innovation-sandbox-lease-templates/smithy/lease-template-operations.js";

const tracer = new Tracer();
const logger = new Logger();

// The whole `leaseTemplates` domain is served by the generated per-domain
// `LeaseTemplatesApi` service handler: the mux routes all five methods, the model
// validates, and the generated `restJson1` serializer writes each response body.
// The service is scoped to this domain's operations, so `leaseTemplateService`
// implements exactly these five rather than the whole aggregate API.
const serviceHandler = getLeaseTemplatesApiServiceHandler(
  leaseTemplateService(logger),
  // The concrete `ValidationError` is this domain's generated class; the shared
  // customizer supplies the field formatting and blank-message rule.
  jsendValidationCustomizer<LeaseTemplatesApiServiceOperations>(
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
  environmentSchema: LeaseTemplateLambdaEnvironmentSchema,
})
  .use(isbConfigMiddleware())
  .handler(toLambdaHandler(serviceHandler));
