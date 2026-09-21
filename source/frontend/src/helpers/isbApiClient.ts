// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Shared transport for the generated `IsbClient` (the single aggregate client):
// SigV4 credentials, the human identity-token middleware, the CloudFront
// same-origin request handler, and the JSend-aware error normalization. Each
// domain builds its own typed adapter on top of `createIsbClient()`.
import { HttpRequest } from "@smithy/core/protocols";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import {
  AwsCredentialIdentityProvider,
  HttpHandlerOptions,
} from "@smithy/types";

import { IsbClient, JSendErrorData } from "@amzn/innovation-sandbox-api-client";
import { IDENTITY_HEADER } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

import { ApiError, NO_ACTIVE_SESSION_MESSAGE } from "./apiError";
import { CognitoAuthService } from "./CognitoAuthService";
import { ConfigData, getConfig } from "./config";

const IDENTITY_MIDDLEWARE_NAME = "addIsbIdentity";

export type SmithyServiceError = Error & {
  $metadata?: { httpStatusCode?: number };
  data?: JSendErrorData;
};

/**
 * Sends a request that was signed for API Gateway through the same-origin
 * CloudFront `/api` route. The signed headers and query remain untouched.
 */
export class CloudFrontFetchHttpHandler extends FetchHttpHandler {
  private readonly fetchEndpoint: URL;
  private readonly signingBasePath: string;

  constructor(fetchEndpoint: string, signingBasePath: string) {
    super();
    this.fetchEndpoint = new URL(fetchEndpoint);
    this.signingBasePath = `/${signingBasePath.replace(/^\/|\/$/g, "")}`;
  }

  override handle(request: HttpRequest, options?: HttpHandlerOptions) {
    if (
      request.path !== this.signingBasePath &&
      !request.path.startsWith(`${this.signingBasePath}/`)
    ) {
      throw new Error(
        `Signed request path ${request.path} does not start with ${this.signingBasePath}`,
      );
    }

    const redirected = HttpRequest.clone(request);
    const operationPath = request.path.slice(this.signingBasePath.length);
    redirected.protocol = this.fetchEndpoint.protocol;
    redirected.hostname = this.fetchEndpoint.hostname;
    redirected.port = this.fetchEndpoint.port
      ? Number(this.fetchEndpoint.port)
      : undefined;
    redirected.path = `${this.fetchEndpoint.pathname.replace(/\/$/, "")}${operationPath}`;
    return super.handle(redirected, options);
  }
}

const cognitoCredentialsProvider: AwsCredentialIdentityProvider = async () => {
  const credentials = await CognitoAuthService.getCredentials();
  if (!credentials) {
    throw new Error(NO_ACTIVE_SESSION_MESSAGE);
  }
  return credentials;
};

function addCognitoIdentityMiddleware(client: IsbClient): void {
  client.middlewareStack.add(
    (next) => async (args) => {
      const idToken = await CognitoAuthService.getIdToken();
      if (!idToken) {
        throw new Error(NO_ACTIVE_SESSION_MESSAGE);
      }
      if (!HttpRequest.isInstance(args.request)) {
        throw new Error("Expected an HTTP request before signing");
      }
      args.request.headers[IDENTITY_HEADER] = idToken;
      return next(args);
    },
    {
      name: IDENTITY_MIDDLEWARE_NAME,
      step: "build",
    },
  );
}

/** The generated aggregate client, signed as the current human user. */
export function createIsbClient(config: ConfigData = getConfig()): IsbClient {
  const client = new IsbClient({
    credentials: cognitoCredentialsProvider,
    endpoint: `https://${config.ApiGatewayHost}/${config.ApiGatewayStage}`,
    maxAttempts: 1,
    region: config.Region,
    requestHandler: new CloudFrontFetchHttpHandler(
      config.ApiUrl,
      config.ApiGatewayStage,
    ),
  });
  addCognitoIdentityMiddleware(client);
  return client;
}

/**
 * Adapts an error thrown by the generated `IsbClient` into the `ApiError` the rest
 * of the frontend is built around, so swapping the hand-written `ApiProxy` for the
 * generated client keeps the error contract unchanged.
 *
 * On a 4xx/5xx the client throws a Smithy service error (a modeled error when the
 * response carries `x-amzn-errortype`, otherwise the protocol's default error), not
 * an `ApiError`. Two reasons a plain rethrow is not enough:
 *  - callers depend on `ApiError` and its `statusCode` (e.g. a 404 → `undefined`, a
 *    409 → conflict handling), and on a readable `message` for toasts/error UI;
 *  - the readable message lives in the JSend `data.errors[0]` (`field` + `message`),
 *    not in the modeled top-level `message` — which the server deliberately leaves
 *    blank — so it must be lifted out of `data`.
 *
 * So for a 4xx/5xx this returns an `ApiError` with `field: message` (or `message`,
 * or an `HTTP error <status>` fallback), preserving `statusCode` and `data`.
 * Anything that is not an `Error`, or is below 400, is returned untouched.
 */
export function normalizeSmithyError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  const serviceError = error as SmithyServiceError;
  const statusCode = serviceError.$metadata?.httpStatusCode;
  if (statusCode === undefined || statusCode < 400) {
    return error;
  }

  const data = serviceError.data as Record<string, unknown> | undefined;
  const firstError = serviceError.data?.errors?.[0];
  if (firstError?.field && firstError.message) {
    return new ApiError(
      `${firstError.field}: ${firstError.message}`,
      statusCode,
      data,
    );
  }
  if (firstError?.message) {
    return new ApiError(firstError.message, statusCode, data);
  }
  return new ApiError(`HTTP error ${statusCode}`, statusCode, data);
}
