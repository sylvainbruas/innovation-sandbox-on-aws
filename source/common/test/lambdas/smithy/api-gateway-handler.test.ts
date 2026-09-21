// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type {
  ServerInterceptor,
  ServiceHandler,
} from "@aws-smithy/server-common";
import { HttpRequest, HttpResponse } from "@smithy/core/protocols";
import { describe, expect, it } from "vitest";

import { BaseApiLambdaEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/base-api-lambda-environment.js";
import { toLambdaHandler } from "@amzn/innovation-sandbox-commons/lambda/smithy/api-gateway-handler.js";
import { IsbSmithyContext } from "@amzn/innovation-sandbox-commons/lambda/smithy/isb-smithy-context.js";
import { createAPIGatewayProxyEvent } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";

type TestContext = IsbSmithyContext<BaseApiLambdaEnvironment>;
type TestServiceHandler = ServiceHandler<
  TestContext,
  HttpRequest,
  HttpResponse
>;

describe("toLambdaHandler", () => {
  it("rethrows the original error captured from a pipeline failure", async () => {
    const originalError = new Error("response serialization failed");
    let interceptor: ServerInterceptor<TestContext> | undefined;

    const serviceHandler = {
      addInterceptor(value: ServerInterceptor<TestContext>) {
        interceptor = value;
        return this;
      },
      async handle(request: HttpRequest, context: TestContext) {
        interceptor?.readAfterExecution?.({
          request,
          context,
          error: originalError,
        });
        return new HttpResponse({
          statusCode: 500,
          headers: { "x-amzn-errortype": "InternalFailure" },
          body: "{}",
        });
      },
    } as unknown as TestServiceHandler;

    const handler = toLambdaHandler(serviceHandler);

    await expect(
      handler(
        createAPIGatewayProxyEvent({
          httpMethod: "GET",
          path: "/test",
        }),
        {} as TestContext["lambdaContext"],
      ),
    ).rejects.toBe(originalError);
  });
});
