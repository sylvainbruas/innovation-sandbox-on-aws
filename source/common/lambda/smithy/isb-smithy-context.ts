// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { BaseApiLambdaEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/base-api-lambda-environment.js";
import {
  IsbApiContext,
  IsbApiEvent,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/api-middleware-bundle.js";
import { ContextWithConfig } from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";

/**
 * The context handed to the generated `IsbApi` service handler.
 *
 * Smithy passes this object through untouched, so it is where the ISB runtime
 * lives: the raw API Gateway event (an operation validates the request body
 * against the pre-Smithy Zod schema straight off `event.body`, which is the one
 * thing model-driven deserialization cannot reproduce — see the handler) and the
 * Middy Lambda context with `env`, `user` and `globalConfig`.
 *
 * Two request-scoped slots let an operation talk to the Lambda handler:
 * `delegatedError` carries an error whose rendering is delegated to the existing
 * Middy `httpErrorHandler` rather than to the Smithy model, and `pipelineError`
 * carries the error the generated pipeline caught internally.
 */
export interface IsbSmithyContext<TEnv extends BaseApiLambdaEnvironment> {
  readonly event: IsbApiEvent;
  readonly lambdaContext: ContextWithConfig & IsbApiContext<TEnv>;

  /**
   * A business error whose rendering is delegated to the existing Middy
   * `httpErrorHandler` in `apiMiddlewareBundle` — the 404, the
   * blueprint/global-config 400s, conflict, unsupported-media, throttling, and
   * unexpected 5xx. Rather than re-implementing JSend error rendering in the
   * generated Smithy pipeline, the operation records the error here and rethrows;
   * the Lambda handler rethrows it past the pipeline so the *same*
   * `createHttpJSendError` → `httpErrorHandler` flow that serves every other route
   * produces the response byte for byte — including the cases the model would
   * render differently (a 404 gains no `x-amzn-errortype`; a 5xx keeps its
   * `logger.error`). Set by `withDelegatedErrors`.
   */
  delegatedError?: unknown;

  /**
   * The error the generated pipeline caught internally — a deserialize,
   * validate, or serialize failure it answers with an `InternalFailure` response
   * rather than by throwing. A `readAfterExecution` interceptor records it here so
   * the handler can rethrow the original error (with its message and stack) to
   * `httpErrorHandler` instead of a generic replacement, preserving the diagnostic
   * for exactly the failures introduced inside the generated pipeline.
   */
  pipelineError?: unknown;
}
