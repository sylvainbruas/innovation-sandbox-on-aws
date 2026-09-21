// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { modeledErrorTypeHeader } from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import { HttpResponse } from "@smithy/core/protocols";

/**
 * Smithy framework exceptions serialize to an empty JSON object (`"{}"`), which
 * is not the pre-Smithy JSend shape. This rewrites such a response so a client
 * never sees a non-JSend body.
 *
 * The 4xx shapes are the reachable ones: `SerializationException` (malformed
 * JSON body), `UnsupportedMediaTypeException`, `NotAcceptableException` and
 * `UnauthenticatedException` can all be produced by the generated pipeline and
 * are reshaped here into the pre-Smithy JSend body. `UnknownOperationException`
 * can occur when a direct invocation or future proxy route reaches the Lambda
 * without matching a modeled operation, so it is still reshaped to JSend 404.
 * The deployed configuration routes are literal and reject unknown sections at
 * API Gateway before this code runs.
 *
 * `InternalFailure` is handled differently by the Lambda handler: it detects a
 * pipeline `InternalFailure` and rethrows the original error (captured by a
 * `readAfterExecution` interceptor) to `httpErrorHandler`, which logs it and
 * emits the pre-Smithy 500 from its `fallbackMessage`. The `InternalFailure` shape
 * below is the fallback for any path that reshapes rather than rethrows, and is
 * covered by direct unit tests.
 */
const frameworkExceptionResponses: Record<
  string,
  { statusCode: number; body: unknown; errorType?: string }
> = {
  InternalFailure: {
    statusCode: 500,
    body: { status: "error", message: "An unexpected error occurred." },
    errorType: "InternalServerError",
  },
  UnknownOperationException: {
    statusCode: 404,
    body: { status: "fail", data: { errors: [{ message: "Not Found." }] } },
  },
  SerializationException: {
    statusCode: 400,
    body: {
      status: "fail",
      data: {
        errors: [
          {
            message:
              "Invalid JSON in request body. Please check your JSON syntax.",
          },
        ],
      },
    },
    errorType: "ValidationError",
  },
  UnsupportedMediaTypeException: {
    statusCode: 415,
    body: {
      status: "fail",
      data: { errors: [{ message: "Unsupported Media Type." }] },
    },
    errorType: "UnsupportedMediaTypeError",
  },
  NotAcceptableException: {
    statusCode: 406,
    body: {
      status: "fail",
      data: { errors: [{ message: "Not Acceptable." }] },
    },
  },
  UnauthenticatedException: {
    statusCode: 401,
    body: { status: "fail", data: { errors: [{ message: "Unauthorized." }] } },
    errorType: "UnauthenticatedError",
  },
};

function readErrorType(headers: Record<string, string | undefined>) {
  const key = Object.keys(headers).find(
    (header) => header.toLowerCase() === modeledErrorTypeHeader,
  );
  return key === undefined ? undefined : headers[key];
}

/**
 * The framework exception `response` carries, or `undefined` when it is not one.
 *
 * Modeled error names never collide with the six framework names, so this is a
 * precise discriminator — in particular it separates the framework's
 * `InternalFailure` (an unexpected failure inside the generated pipeline) from a
 * modeled `InternalServerError`, which the shaped response and a modeled 500
 * would otherwise both spell as `x-amzn-errortype: InternalServerError`.
 */
export function frameworkExceptionType(
  response: HttpResponse | undefined,
): string | undefined {
  const errorType = readErrorType(response?.headers ?? {});
  if (errorType === undefined) {
    return undefined;
  }
  return errorType in frameworkExceptionResponses ? errorType : undefined;
}

/**
 * Returns a JSend-shaped replacement when `response` is a serialized framework
 * exception, otherwise `undefined`.
 */
export function shapeFrameworkExceptionResponse(
  response: HttpResponse,
): HttpResponse | undefined {
  const errorType = frameworkExceptionType(response);
  if (errorType === undefined) {
    return undefined;
  }

  const shape = frameworkExceptionResponses[errorType];
  if (shape === undefined) {
    return undefined;
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (shape.errorType !== undefined) {
    headers[modeledErrorTypeHeader] = shape.errorType;
  }

  return new HttpResponse({
    statusCode: shape.statusCode,
    headers,
    body: JSON.stringify(shape.body),
  });
}
