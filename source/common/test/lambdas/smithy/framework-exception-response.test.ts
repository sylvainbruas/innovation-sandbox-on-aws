// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Smithy framework exceptions serialize to `"{}"`, which is not the pre-Smithy
 * JSend shape. The piloted composition makes all six unreachable, so these are
 * the only tests that exercise the rewrite — they are what keeps it correct if a
 * future generator or model change makes one reachable.
 */
import { shapeFrameworkExceptionResponse } from "@amzn/innovation-sandbox-commons/lambda/smithy/framework-exception-response.js";
import { HttpResponse } from "@smithy/core/protocols";
import { describe, expect, it } from "vitest";

function frameworkResponse(errorType: string, statusCode = 500) {
  return new HttpResponse({
    statusCode,
    headers: {
      "content-type": "application/json",
      "x-amzn-errortype": errorType,
    },
    body: "{}",
  });
}

describe("shapeFrameworkExceptionResponse", () => {
  it.each([
    [
      "InternalFailure",
      500,
      { status: "error", message: "An unexpected error occurred." },
      "InternalServerError",
    ],
    [
      "UnknownOperationException",
      404,
      { status: "fail", data: { errors: [{ message: "Not Found." }] } },
      undefined,
    ],
    [
      "SerializationException",
      400,
      {
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
      "ValidationError",
    ],
    [
      "UnsupportedMediaTypeException",
      415,
      {
        status: "fail",
        data: { errors: [{ message: "Unsupported Media Type." }] },
      },
      "UnsupportedMediaTypeError",
    ],
    [
      "NotAcceptableException",
      406,
      { status: "fail", data: { errors: [{ message: "Not Acceptable." }] } },
      undefined,
    ],
    [
      "UnauthenticatedException",
      401,
      { status: "fail", data: { errors: [{ message: "Unauthorized." }] } },
      "UnauthenticatedError",
    ],
  ])(
    "rewrites %s as a JSend %i",
    (errorType, statusCode, body, modeledErrorType) => {
      const shaped = shapeFrameworkExceptionResponse(
        frameworkResponse(errorType as string),
      );

      expect(shaped).toBeDefined();
      expect(shaped!.statusCode).toBe(statusCode);
      expect(shaped!.body).toBe(JSON.stringify(body));
      expect(shaped!.headers["content-type"]).toBe("application/json");
      expect(shaped!.headers["x-amzn-errortype"]).toBe(modeledErrorType);
    },
  );

  it("matches the header case-insensitively", () => {
    const shaped = shapeFrameworkExceptionResponse(
      new HttpResponse({
        statusCode: 500,
        headers: { "X-Amzn-Errortype": "InternalFailure" },
        body: "{}",
      }),
    );

    expect(shaped?.statusCode).toBe(500);
  });

  it("leaves a modeled error response alone", () => {
    // Modeled names never collide with framework names, so the generated error
    // serializer's output passes through untouched.
    for (const modeled of [
      "ValidationError",
      "UnauthenticatedError",
      "AccessDeniedError",
      "ConflictError",
      "UnsupportedMediaTypeError",
      "InternalServerError",
    ]) {
      expect(
        shapeFrameworkExceptionResponse(frameworkResponse(modeled, 400)),
      ).toBeUndefined();
    }
  });

  it("leaves a response without the discriminator alone", () => {
    expect(
      shapeFrameworkExceptionResponse(
        new HttpResponse({ statusCode: 200, headers: {}, body: "{}" }),
      ),
    ).toBeUndefined();
  });
});
