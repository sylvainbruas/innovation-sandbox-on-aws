// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@aws-sdk/protocol-http";
import { SignatureV4 } from "@aws-sdk/signature-v4";

import { IDENTITY_HEADER } from "@amzn/innovation-sandbox-commons/utils/auth-utils.js";
import { CognitoAuthService } from "@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { ApiResponse } from "@amzn/innovation-sandbox-frontend/types";

type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const NO_ACTIVE_SESSION_MESSAGE = "No active session";

/**
 * Error thrown for non-OK HTTP responses. Carries the HTTP status code and the
 * JSend `data` payload so callers can branch on specific statuses (e.g. 429)
 * and read structured fields (e.g. data.retryAt) that the message alone omits.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly data?: Record<string, any>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface IApiProxy {
  get<T>(url: string): Promise<T>;
  post<T>(url: string, data?: unknown): Promise<T>;
  put<T>(url: string, data?: unknown): Promise<T>;
  patch<T>(url: string, data?: unknown): Promise<T>;
  delete<T>(url: string, data?: unknown): Promise<T>;
}

/**
 * SigV4-signing API client.
 *
 * Two URLs are involved:
 *  - **sign URL**: `https://${ApiGatewayHost}/${ApiGatewayStage}${path}` —
 *    what the signature is computed against. Matches what API Gateway sees
 *    on the receiving end after CloudFront's path rewrite + RestApiOrigin
 *    prepends the deployed stage (typically `prod`).
 *  - **fetch URL**: `${baseUrl}${path}` (typically `${origin}/api${path}`) —
 *    the same-origin URL the browser actually requests. CloudFront forwards
 *    it to API Gateway with signed headers preserved by
 *    `OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER`, which also
 *    rewrites `Host` to the API Gateway hostname (matching what was signed).
 *
 * The `x-isb-identity` header carries the Cognito ID token so the
 * `captureIsbUser` middleware can read RBAC claims. It is added to the
 * `HttpRequest` headers **before** signing — `@aws-sdk/signature-v4` only
 * covers headers present at signing time, so this is what gets the header
 * listed in `SignedHeaders=` in the resulting `Authorization` value. Adding
 * it to the `fetch()` call after signing would leave it tamper-mutable in
 * transit.
 */
export class ApiProxy implements IApiProxy {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? getConfig().ApiUrl;
  }

  /**
   * Hand-rolled SigV4 signing. When the API moves to a Smithy-generated
   * client, the signer construction here goes away (Smithy owns SigV4 via
   * the `aws.auth#sigv4` trait); `x-isb-identity` injection has to migrate
   * to a Smithy `before-signing` interceptor so the header is still present
   * at signing time and covered by `SignedHeaders=`.
   */
  private async signedHeaders(
    method: ApiMethod,
    path: string,
    body: string | undefined,
    idToken: string,
  ): Promise<Record<string, string>> {
    const credentials = await CognitoAuthService.getCredentials();
    if (!credentials) {
      throw new Error(NO_ACTIVE_SESSION_MESSAGE);
    }

    const { ApiGatewayHost, ApiGatewayStage, Region } = getConfig();

    const [pathname, qs] = path.split("?");
    const query: Record<string, string> = qs
      ? Object.fromEntries(new URLSearchParams(qs))
      : {};

    const signRequest = new HttpRequest({
      method,
      protocol: "https:",
      hostname: ApiGatewayHost,
      path: `/${ApiGatewayStage}${pathname}`,
      query,
      headers: {
        host: ApiGatewayHost,
        "content-type": "application/json",
        [IDENTITY_HEADER]: idToken,
      },
      body,
    });

    const signer = new SignatureV4({
      service: "execute-api",
      region: Region,
      credentials,
      sha256: Sha256,
    });

    const signed = await signer.sign(signRequest);
    return signed.headers as Record<string, string>;
  }

  private async callApi<T>(
    method: ApiMethod,
    url: string,
    body?: Record<string, any>,
  ): Promise<T> {
    const idToken = await CognitoAuthService.getIdToken();
    if (!idToken) {
      throw new Error(NO_ACTIVE_SESSION_MESSAGE);
    }

    const serializedBody = body ? JSON.stringify(body) : undefined;
    const headers = await this.signedHeaders(
      method,
      url,
      serializedBody,
      idToken,
    );

    const response = await fetch(`${this.baseUrl}${url}`, {
      method,
      headers,
      body: serializedBody,
    });

    if (!response.ok) {
      let data;

      try {
        data = await response.json();
      } catch (err) {
        console.error("API Response was not valid JSON", err);
      }

      if (data?.data?.errors?.length) {
        const errorDetails = data.data.errors[0];

        if (errorDetails.field && errorDetails.message) {
          throw new ApiError(
            `${errorDetails.field}: ${errorDetails.message}`,
            response.status,
            data.data,
          );
        }

        if (errorDetails.message) {
          throw new ApiError(errorDetails.message, response.status, data.data);
        }
      }
      throw new ApiError(
        `HTTP error ${response.status}`,
        response.status,
        data?.data,
      );
    }

    const { status, data, ...rest }: ApiResponse<T> =
      (await response.json()) as ApiResponse<T>;

    if (status !== "success") {
      console.error("API error", {
        request: { method, url, body },
        response: { status, data, ...rest },
      });
      throw new Error(`API error: ${method} ${url}`);
    }

    return data;
  }

  public async get<T>(url: string): Promise<T> {
    return this.callApi("GET", url);
  }

  public async post<T>(url: string, data?: Record<string, any>): Promise<T> {
    return this.callApi("POST", url, data);
  }

  public async put<T>(url: string, data?: Record<string, any>): Promise<T> {
    return this.callApi("PUT", url, data);
  }

  public async patch<T>(url: string, data?: Record<string, any>): Promise<T> {
    return this.callApi("PATCH", url, data);
  }

  public async delete<T>(url: string, data?: Record<string, any>): Promise<T> {
    return this.callApi("DELETE", url, data);
  }
}
