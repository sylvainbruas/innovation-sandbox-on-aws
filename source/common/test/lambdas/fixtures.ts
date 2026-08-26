// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Event as NormalizedEvent } from "@middy/http-event-normalizer";
import { Event as NormalizedHeaderEvent } from "@middy/http-header-normalizer";

import {
  ConfigSchemas,
  ConfigSection,
} from "@amzn/innovation-sandbox-commons/data/config/config.js";
import { GlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { BaseApiLambdaEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/base-api-lambda-environment.js";
import { IsbApiContext } from "@amzn/innovation-sandbox-commons/lambda/middleware/api-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { ContextWithConfig } from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";
import { JSendErrorObject } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { encodeTestToken } from "@amzn/innovation-sandbox-commons/test/lambdas/api-test-setup.js";
import {
  type IsbUser,
  COGNITO_IDC_USER_ID_CLAIM,
  COGNITO_ISB_ROLES_CLAIM,
  COGNITO_USERNAME_CLAIM,
  IDENTITY_HEADER,
  isIdcUser,
  isM2MUser,
} from "@amzn/innovation-sandbox-commons/utils/auth-utils.js";
import { buildM2mAssumedRoleArn } from "@amzn/innovation-sandbox-commons/utils/m2m-role-arn.js";

/**
 * Builds the value API Gateway puts in
 * `event.requestContext.identity.cognitoAuthenticationProvider` for a
 * Cognito-authenticated request. Format documented at:
 * https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-mapping-template-reference.html#context-variable-reference
 */
export function buildCognitoAuthProvider(
  poolId: string,
  sub: string,
  region: string,
): string {
  const issuer = `cognito-idp.${region}.amazonaws.com/${poolId}`;
  return `${issuer},${issuer}:CognitoSignIn:${sub}`;
}
import { nowAsIsoDatetimeString } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import {
  APIGatewayEventIdentity,
  APIGatewayRequestAuthorizerEvent,
  CognitoIdentity,
} from "aws-lambda";
import { randomUUID } from "crypto";

interface CreateAPIGatewayProxyEventProps {
  httpMethod: string;
  path: string;
  body?: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  headers?: { [key: string]: string };
  identity?: Partial<APIGatewayEventIdentity>;
  /**
   * Convenience: when set, populates the SigV4 fields the new
   * `captureIsbUser` middleware reads — `x-isb-identity` header +
   * `cognitoAuthenticationProvider` for IDC users, `userArn` for M2M
   * — and registers matching mock claims with the shared
   * `aws-jwt-verify` mock from `api-test-setup.ts`.
   */
  isbUser?: IsbUser;
}

const FIXTURE_COGNITO_SUB = "abc12345-6789-4abc-9def-0123456789ab";

function userPropsToEventOverrides(user: IsbUser): {
  headers?: Record<string, string>;
  identity?: Partial<APIGatewayEventIdentity>;
} {
  if (isM2MUser(user)) {
    const namespace = process.env.ISB_NAMESPACE ?? "myisb";
    return {
      identity: {
        userArn: buildM2mAssumedRoleArn({
          namespace,
          roleTier: user.roles[0] ?? "User",
          clientName: user.clientId,
          accountId: "123456789012",
        }),
      },
    };
  }
  const claims = { sub: FIXTURE_COGNITO_SUB, ...buildCognitoClaims(user) };
  return {
    headers: { [IDENTITY_HEADER]: encodeTestToken(claims) },
    identity: {
      cognitoAuthenticationProvider: buildCognitoAuthProvider(
        "us-east-1_TEST",
        FIXTURE_COGNITO_SUB,
        "us-east-1",
      ),
    },
  };
}

export function buildCognitoClaims(user: IsbUser): Record<string, string> {
  if (isIdcUser(user)) {
    return {
      email: user.email,
      [COGNITO_ISB_ROLES_CLAIM]: JSON.stringify(user.roles),
      [COGNITO_USERNAME_CLAIM]: user.userName ?? user.email,
      [COGNITO_IDC_USER_ID_CLAIM]: user.userId,
    };
  }
  return {
    client_id: user.clientId,
    [COGNITO_ISB_ROLES_CLAIM]: JSON.stringify(user.roles),
  };
}

export const createAPIGatewayProxyEvent = (
  props: CreateAPIGatewayProxyEventProps,
): NormalizedEvent & NormalizedHeaderEvent => {
  const { identity, isbUser, headers, ...eventProps } = props;

  const userOverrides = isbUser ? userPropsToEventOverrides(isbUser) : {};
  const mergedHeaders = { ...headers, ...userOverrides.headers };
  const mergedIdentity = { ...identity, ...userOverrides.identity };

  return {
    body: null,
    rawHeaders: {},
    multiValueHeaders: {},
    pathParameters: {},
    stageVariables: null,
    isBase64Encoded: false,
    queryStringParameters: {},
    multiValueQueryStringParameters: {},
    resource: "resource",
    headers: mergedHeaders,
    requestContext: {
      accountId: "000000000000",
      apiId: "apiId",
      authorizer: null,
      httpMethod: props.httpMethod,
      identity: {
        accessKey: null,
        accountId: null,
        caller: null,
        cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null,
        cognitoIdentityId: null,
        cognitoIdentityPoolId: null,
        principalOrgId: null,
        sourceIp: "0.0.0.0",
        user: null,
        userAgent: null,
        userArn: null,
        clientCert: null,
        apiKey: null,
        apiKeyId: null,
        ...mergedIdentity,
      },
      protocol: "protocol",
      path: "path",
      stage: "stage",
      requestId: "requestId",
      requestTime: "requestTime",
      requestTimeEpoch: 1,
      resourceId: "resourceId",
      resourcePath: "resourcePath",
    },
    ...eventProps,
  };
};

export const responseHeaders = {
  "Origin-Agent-Cluster": "?1",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=15552000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-DNS-Prefetch-Control": "off",
  "X-Download-Options": "noopen",
  "X-Permitted-Cross-Domain-Policies": "none",
  "Content-Type": "application/json",
};

const isbUser: IsbUser = {
  type: "user",
  email: "test@example.com",
  userId: "testUserId",
  roles: ["Admin", "Manager", "User"],
};

export const isbAuthorizedUser = {
  user: isbUser,
  claims: buildCognitoClaims(isbUser),
};

const isbUserUserRoleOnly: IsbUser = {
  type: "user",
  email: "test@example.com",
  userId: "testUserId",
  roles: ["User"],
};

export const isbAuthorizedUserUserRoleOnly = {
  user: isbUserUserRoleOnly,
  claims: buildCognitoClaims(isbUserUserRoleOnly),
};

export function mockGlobalConfig(): GlobalConfig {
  const config = {} as GlobalConfig;
  for (const section of Object.keys(ConfigSchemas) as ConfigSection[]) {
    (config as Record<ConfigSection, unknown>)[section] = ConfigSchemas[
      section
    ].parse({});
  }
  // Baseline represents a normally-operating, configured system. The schema
  // default for `maintenance.enabled` is fresh-install behavior; tests that
  // need maintenance mode opt into it explicitly.
  config.maintenance.enabled = false;
  return config;
}

// M2M callers authenticate via an assumed IAM role (no Cognito claims), so these
// are bare IsbUser objects — pass directly as `createAPIGatewayProxyEvent`'s
// `isbUser`, which renders them as a `userArn`.
export const m2mAdminUser: IsbUser = {
  type: "m2m",
  clientId: "automation-client",
  roles: ["Admin"],
};

export const m2mUserRoleOnlyUser: IsbUser = {
  type: "m2m",
  clientId: "some-client",
  roles: ["User"],
};

export function mockContext<T>(
  env: T,
  globalConfig?: GlobalConfig,
): ContextWithConfig & ValidatedEnvironment<T> {
  return {
    env,
    globalConfig: globalConfig ?? mockGlobalConfig(),
    functionName: "testFunc",
    awsRequestId: "",
    callbackWaitsForEmptyEventLoop: false,
    functionVersion: "test",
    invokedFunctionArn: "myFuncArn",
    logGroupName: "myLogGroup",
    logStreamName: "myLogStream",
    memoryLimitInMB: "200",
    done(_error?: Error, _result?: any): void {},
    fail(_error: Error | string): void {},
    getRemainingTimeInMillis(): number {
      return 100;
    },
    succeed(_message: any, _object?: any): void {},
  };
}

export function mockAuthorizedContext<T extends BaseApiLambdaEnvironment>(
  env: T,
  globalConfig?: GlobalConfig,
): IsbApiContext<T> & ContextWithConfig {
  return {
    ...mockContext(env, globalConfig),
    ...isbAuthorizedUser,
    accountId: "000000000000",
    apiId: "test-api-id",
    protocol: "HTTP/1.1",
    httpMethod: "GET",
    path: "/test-path",
    stage: "test-stage",
    requestId: "test-request-id",
    requestTimeEpoch: 0,
    resourceId: "test-resource-id",
    resourcePath: "/test-resource-path",
    authorizer: {} as APIGatewayRequestAuthorizerEvent,
    identity: {} as CognitoIdentity & APIGatewayEventIdentity,
  };
}

export function createFailureResponseBody(...errors: JSendErrorObject[]) {
  return JSON.stringify({
    status: "fail",
    data: {
      errors,
    },
  });
}

export function createErrorResponseBody(message: string) {
  return JSON.stringify({
    status: "error",
    message,
  });
}

export function createEventBridgeEvent(detailType: string, detail: object) {
  return {
    version: "0",
    id: randomUUID(),
    "detail-type": detailType,
    source: "InnovationSandbox-myisb",
    account: "123456789012",
    time: nowAsIsoDatetimeString(),
    region: "us-east-1",
    resources: [],
    detail: {
      ...detail,
    },
  };
}
