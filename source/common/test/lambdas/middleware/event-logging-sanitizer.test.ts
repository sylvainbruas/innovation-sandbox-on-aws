// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { injectSanitizedLambdaContext } from "@amzn/innovation-sandbox-commons/lambda/middleware/inject-sanitized-lambda-context.js";
import { createAPIGatewayProxyEvent } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { IDENTITY_HEADER } from "@amzn/innovation-sandbox-commons/utils/auth-utils.js";
import { Logger } from "@aws-lambda-powertools/logger";
import { APIGatewayProxyEvent } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("injectSanitizedLambdaContext", () => {
  /**
   * Creates a mock API Gateway event for testing
   */
  const mockBearerToken = "Bearer a.b.c";

  const createMockEvent = (authHeader?: string): APIGatewayProxyEvent =>
    createAPIGatewayProxyEvent({
      headers: authHeader ? { authorization: authHeader } : {},
      multiValueHeaders: authHeader ? { authorization: [authHeader] } : {},
    } as any);

  let logger: Logger;
  let mockRequest: any;

  beforeEach(() => {
    logger = new Logger({ serviceName: "test" });
    mockRequest = {
      event: createMockEvent(mockBearerToken),
      context: {},
      response: {},
    };
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("should sanitize authorization headers before logging", async () => {
    const loggerInfoSpy = vi.spyOn(logger, "info");
    const middleware = injectSanitizedLambdaContext(logger);

    await middleware.before!(mockRequest);

    const loggedEvent = (loggerInfoSpy.mock.calls[0]![1] as any).event;

    // Verify that the logged event has sanitized authorization headers
    expect(loggedEvent.headers.authorization).toBe("[REDACTED]");
    if (loggedEvent.multiValueHeaders?.authorization) {
      expect(loggedEvent.multiValueHeaders.authorization).toEqual([
        "[REDACTED]",
      ]);
    }

    // Verify that the original token is NOT present in the logged event
    expect(JSON.stringify(loggedEvent)).not.toContain(mockBearerToken);

    // Verify that the current event has sanitized headers
    expect(mockRequest.event.headers.authorization).toBe("[REDACTED]");
    if (mockRequest.event.multiValueHeaders?.authorization) {
      expect(mockRequest.event.multiValueHeaders.authorization).toEqual([
        "[REDACTED]",
      ]);
    }
  });

  it.each([
    { auth: "Basic dXNlcjpwYXNzd29yZA==", description: "Basic auth" },
    { auth: "Bearer simple-token", description: "Simple Bearer token" },
  ])(
    "should handle different authorization header types: $description",
    async ({ auth }) => {
      const request = {
        event: createMockEvent(auth),
        context: {},
        response: {},
      } as any;

      const middleware = injectSanitizedLambdaContext(logger);
      await middleware.before!(request);

      // All authorization headers should be redacted
      expect(request.event.headers.authorization).toBe("[REDACTED]");
      expect(request.event.multiValueHeaders.authorization).toEqual([
        "[REDACTED]",
      ]);
    },
  );

  it("should handle case-insensitive authorization headers and rawHeaders", async () => {
    const event = createMockEvent() as APIGatewayProxyEvent & {
      rawHeaders: Record<string, string>;
      rawMultiValueHeaders: Record<string, string[]>;
    };
    event.headers = { Authorization: mockBearerToken };
    event.multiValueHeaders = { Authorization: [mockBearerToken] };
    // Test rawHeaders and rawMultiValueHeaders as well
    event.rawHeaders = { Authorization: mockBearerToken };
    event.rawMultiValueHeaders = { Authorization: [mockBearerToken] };

    const request = { event, context: {}, response: {} } as any;
    const middleware = injectSanitizedLambdaContext(logger);

    await middleware.before!(request);

    expect(request.event.headers.Authorization).toBe("[REDACTED]");
    expect(request.event.multiValueHeaders.Authorization).toEqual([
      "[REDACTED]",
    ]);
    // Verify rawHeaders are also sanitized
    expect((request.event as any).rawHeaders.Authorization).toBe("[REDACTED]");
    expect((request.event as any).rawMultiValueHeaders.Authorization).toEqual([
      "[REDACTED]",
    ]);
  });

  it("should handle events without authorization headers", async () => {
    const request = {
      event: createMockEvent(), // No auth header
      context: {},
      response: {},
    } as any;

    const middleware = injectSanitizedLambdaContext(logger);
    await middleware.before!(request);

    expect(request.event.headers).toEqual({});
    expect(request.event.multiValueHeaders).toEqual({});
  });

  it("should handle multiple authorization values", async () => {
    const event = createMockEvent();
    event.multiValueHeaders = {
      authorization: [
        mockBearerToken,
        "Basic dXNlcjpwYXNzd29yZA==",
        "Bearer simple-token",
      ],
    };

    const request = { event, context: {}, response: {} } as any;
    const middleware = injectSanitizedLambdaContext(logger);

    await middleware.before!(request);

    expect(request.event.multiValueHeaders.authorization).toEqual([
      "[REDACTED]",
      "[REDACTED]",
      "[REDACTED]",
    ]);
  });

  it("should sanitize x-isb-identity headers (Cognito ID token)", async () => {
    const idToken = "eyJ.fake.idtoken";
    const event = createAPIGatewayProxyEvent({
      headers: { [IDENTITY_HEADER]: idToken, Authorization: "Bearer x" },
    } as any);
    (event as any).multiValueHeaders = {
      "X-ISB-Identity": [idToken],
    };
    const request = { event, context: {}, response: {} } as any;
    const middleware = injectSanitizedLambdaContext(logger);

    await middleware.before!(request);

    expect(request.event.headers[IDENTITY_HEADER]).toBe("[REDACTED]");
    expect(request.event.multiValueHeaders["X-ISB-Identity"]).toEqual([
      "[REDACTED]",
    ]);
    expect(JSON.stringify(request.event)).not.toContain(idToken);
  });

  it("should sanitize x-amz-security-token headers (SigV4 session token)", async () => {
    const sessionToken = "IQoJb3JpZ2luX2VjEXAMPLEsessiontoken";
    const signedAt = "20260727T000000Z";
    const loggerInfoSpy = vi.spyOn(logger, "info");
    const event = createAPIGatewayProxyEvent({
      headers: {
        authorization: "AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260727",
        "x-amz-security-token": sessionToken,
        "x-amz-date": signedAt,
      },
    } as any);
    (event as any).multiValueHeaders = {
      "X-Amz-Security-Token": [sessionToken],
    };
    (event as any).rawHeaders = { "X-Amz-Security-Token": sessionToken };
    (event as any).rawMultiValueHeaders = {
      "X-Amz-Security-Token": [sessionToken],
    };
    const request = { event, context: {}, response: {} } as any;
    const middleware = injectSanitizedLambdaContext(logger);

    await middleware.before!(request);

    const loggedEvent = (loggerInfoSpy.mock.calls[0]![1] as any).event;

    expect(loggedEvent.headers["x-amz-security-token"]).toBe("[REDACTED]");
    expect(loggedEvent.multiValueHeaders["X-Amz-Security-Token"]).toEqual([
      "[REDACTED]",
    ]);
    expect(loggedEvent.rawHeaders["X-Amz-Security-Token"]).toBe("[REDACTED]");
    expect(loggedEvent.rawMultiValueHeaders["X-Amz-Security-Token"]).toEqual([
      "[REDACTED]",
    ]);
    expect(JSON.stringify(loggedEvent)).not.toContain(sessionToken);

    // Non-credential SigV4 headers stay readable for log debugging.
    expect(loggedEvent.headers["x-amz-date"]).toBe(signedAt);
  });

  it("should preserve original event data integrity", async () => {
    const originalAuth = mockRequest.event.headers.authorization;
    const middleware = injectSanitizedLambdaContext(logger);

    await middleware.before!(mockRequest);

    // Original event should be preserved in _originalEvent
    expect((mockRequest as any)._originalEvent.headers.authorization).toBe(
      originalAuth,
    );
    expect((mockRequest as any)._originalEvent.headers.authorization).toContain(
      mockBearerToken,
    );

    // Current event should be sanitized
    expect(mockRequest.event.headers.authorization).toBe("[REDACTED]");
  });
});
