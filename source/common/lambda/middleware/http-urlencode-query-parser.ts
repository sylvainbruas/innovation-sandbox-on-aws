// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { createHttpJSendError } from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import { JSendErrorObject } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { MiddlewareFn } from "@aws-lambda-powertools/commons/types";
import { MiddlewareObj } from "@middy/core";
import { APIGatewayProxyEvent, Context } from "aws-lambda";

export function httpUrlencodeQueryParser(): MiddlewareObj<
  APIGatewayProxyEvent,
  any,
  Error,
  Context
> {
  const httpUrlencodeQueryParserBefore: MiddlewareFn<
    APIGatewayProxyEvent
  > = async (request) => {
    const { queryStringParameters, multiValueQueryStringParameters } =
      request.event;
    const errors: JSendErrorObject[] = [];
    // A key appears in both query maps, so record a decode failure once per key
    // to avoid duplicate entries in the 400 payload.
    const failedKeys = new Set<string>();

    const decode = (key: string, value: string): string => {
      try {
        return decodeURIComponent(value);
      } catch {
        if (!failedKeys.has(key)) {
          failedKeys.add(key);
          errors.push({
            field: key,
            message: "The query string parameter could not be url decoded.",
          });
        }
        return value;
      }
    };

    // Decode both query maps. Middy routes read the single-value map, but the
    // Smithy-served routes read `multiValueQueryStringParameters` (that is what
    // `@smithy/server-apigateway`'s `convertEvent` uses for REST v1 events), so
    // decoding only the former would hand generated handlers percent-encoded
    // values — e.g. an exact `alice%40example.com` lookup would 404.
    //
    // TRANSITIONAL: once every domain is cut over to Smithy, nothing reads the
    // single-value map and decoding query strings in a Middy middleware is the
    // wrong layer — it should move into the Smithy transport adapter (the shim
    // around `convertEvent`), which owns request decoding. At that point drop
    // the single-value branch below (and the cross-map de-dup it necessitates).
    if (queryStringParameters) {
      for (const [key, value] of Object.entries(queryStringParameters)) {
        if (!value) continue;
        queryStringParameters[key] = decode(key, value);
      }
    }
    if (multiValueQueryStringParameters) {
      for (const [key, values] of Object.entries(
        multiValueQueryStringParameters,
      )) {
        if (!values) continue;
        multiValueQueryStringParameters[key] = values.map((v) =>
          decode(key, v),
        );
      }
    }

    if (errors.length > 0) {
      throw createHttpJSendError({
        statusCode: 400,
        errorType: "ValidationError",
        data: { errors },
      });
    }
  };

  return {
    before: httpUrlencodeQueryParserBefore,
  };
}
