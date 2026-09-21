// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { HttpResponse } from "@smithy/core/protocols";
import { convertVersion2Response } from "@smithy/server-apigateway";
import type {
  APIGatewayProxyResult,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";

import { shapeFrameworkExceptionResponse } from "@amzn/innovation-sandbox-commons/lambda/smithy/framework-exception-response.js";

/**
 * Converts the generated pipeline's `HttpResponse` into the API Gateway result the
 * pre-Smithy handwritten routes returned.
 *
 * The conversion itself is done by the library `convertVersion2Response` — the same
 * `@smithy/server-apigateway` converter ~960 internal callers use. ISB is a REST
 * API (payload format 1.0), but the *v2* response converter is used deliberately:
 * it emits a single `headers` map, matching the pre-Smithy responses, whereas the v1
 * converter (`convertVersion1Response`) emits `multiValueHeaders`, which is a
 * different wire shape and would also mis-feed the Middy `httpSecurityHeaders`
 * after-hook. Everything ISB-specific is then a thin shim around that call:
 *
 *  - `titleCaseContentType` title-cases `Content-Type` and drops the converter's
 *    `isBase64Encoded` so the result is exactly `{ statusCode, headers, body }`;
 *  - a Smithy framework exception (invalid JSON, unsupported media type, not
 *    acceptable) is first reshaped into the pre-Smithy JSend body.
 *
 * The serializer's body passes through as-is. It differs from the pre-Smithy body
 * only in ways no consumer observes — members alphabetized rather than in stored
 * order, explicit `null`s dropped, and timestamps normalized (`.000Z` → `Z`). The
 * frontend adapter parses into typed objects and canonicalizes null/absent to
 * `undefined` (see `domains/leaseTemplates/generated-client.ts`), so none of those
 * matter; they are accepted deviations rather than repaired.
 *
 * A business error never reaches here — the operation delegates those to
 * `httpErrorHandler`. This module and `framework-exception-response.ts` are the
 * single response-side seam: when the contract is intentionally rev'd, the handler
 * calls `convertVersion2Response` directly and they go away.
 */
export function convertToIsbResponse(
  response: HttpResponse,
): APIGatewayProxyResult {
  // If the response is a serialized Smithy framework exception (e.g. malformed JSON,
  // unsupported media type), replace it with the pre-Smithy JSend body; otherwise
  // pass it through unchanged.
  const shaped = shapeFrameworkExceptionResponse(response) ?? response;

  // Turn the `HttpResponse` into an API Gateway result (`{ statusCode, headers,
  // body }`). It always returns the structured form (never a bare string), so the
  // narrowing cast is safe.
  const converted = convertVersion2Response(
    shaped,
  ) as APIGatewayProxyStructuredResultV2;

  return {
    statusCode: converted.statusCode ?? shaped.statusCode,
    headers: titleCaseContentType(converted.headers),
    body: converted.body ?? "",
  };
}

/**
 * Title-cases `Content-Type` and passes every other header through (only dropping
 * the converter's `isBase64Encoded`, which is elided by not copying it).
 *
 * Why title-case at all, when HTTP headers are case-insensitive and no client cares:
 * a Smithy-served response has *two* renderers. Success, framework exceptions, and
 * modeled `ValidationError`s come through here from the generated serializer, which
 * emits lower-case `content-type`; but **delegated errors** (business 400/404/409,
 * the operation's Zod-validation 400s, and 5xx) are rendered by the shared Middy
 * `httpErrorHandler`, which emits title-case `Content-Type` — the same as every
 * still-handwritten domain. Title-casing here keeps both renderers uniform, so all
 * responses match the one shared `Content-Type` and no per-path test fixture is
 * needed. Once every domain is on the generated bindings, this can be unified the
 * other way — change `httpErrorHandler` to emit lower-case `content-type` to match
 * what Smithy produces, then delete this title-casing.
 *
 * `content-length` (a body-length header the pre-Smithy responses did not carry, so
 * an accepted deviation — API Gateway sets its own) passes through; tests assert the
 * headers by containment. (`String(value)` is a type coercion — the header value type
 * is `boolean | number | string` — not a runtime transform; the values are strings.)
 */
function titleCaseContentType(
  headers: APIGatewayProxyStructuredResultV2["headers"],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key.toLowerCase() === "content-type" ? "Content-Type" : key] =
      String(value);
  }
  return out;
}
