// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the query-string URL-decode middleware. Both query maps are
 * decoded: Middy routes read `queryStringParameters`, while Smithy-served routes
 * read `multiValueQueryStringParameters` (via `convertEvent`).
 */

import { httpUrlencodeQueryParser } from "@amzn/innovation-sandbox-commons/lambda/middleware/http-urlencode-query-parser.js";
import { createAPIGatewayProxyEvent } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { describe, expect, it } from "vitest";

describe("httpUrlencodeQueryParser", () => {
  const middleware = httpUrlencodeQueryParser();

  it("decodes a percent-encoded value in the single-value map (Middy path)", async () => {
    const request = {
      event: createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/principals/search",
        queryStringParameters: { q: "alice%40example.com" },
      }),
    };

    await middleware.before!(request as any);
    expect(request.event.queryStringParameters!.q).toBe("alice@example.com");
  });

  it("decodes percent-encoded values in the multi-value map (Smithy path)", async () => {
    const request = {
      event: createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/principals/search",
        // A repeated key: every value must be decoded, not just the first.
        multiValueQueryStringParameters: { id: ["a%40b.com", "c%40d.com"] },
      }),
    };

    await middleware.before!(request as any);
    expect(request.event.multiValueQueryStringParameters!.id).toEqual([
      "a@b.com",
      "c@d.com",
    ]);
  });

  it("reports a single 400 for an undecodable value present in both maps", async () => {
    // Set the failing value in BOTH maps explicitly so the de-dup path is
    // exercised regardless of fixture behavior: the parser must collapse the
    // per-map failures to one error per key. (Asserted as a precondition below so
    // the test can never pass trivially if only one map were populated.)
    const request = {
      event: createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/principals/search",
        queryStringParameters: { q: "%ZZ" },
        multiValueQueryStringParameters: { q: ["%ZZ"] },
      }),
    };
    expect(request.event.queryStringParameters!.q).toBe("%ZZ");
    expect(request.event.multiValueQueryStringParameters!.q).toEqual(["%ZZ"]);

    let error: any;
    try {
      await middleware.before!(request as any);
    } catch (e) {
      error = e;
    }

    expect(error).toMatchObject({
      statusCode: 400,
      headers: { "x-amzn-errortype": "ValidationError" },
    });
    expect(JSON.parse(error.message).data.errors).toEqual([
      {
        field: "q",
        message: "The query string parameter could not be url decoded.",
      },
    ]);
  });

  it("is a no-op when there are no query parameters", async () => {
    const request = {
      event: createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/principals/search",
      }),
    };

    await expect(middleware.before!(request as any)).resolves.toBeUndefined();
  });
});
