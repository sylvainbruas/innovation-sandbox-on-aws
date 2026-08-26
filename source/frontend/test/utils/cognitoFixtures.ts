// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Test fixtures for Cognito-flavored auth: literal values used as defaults
// across test files, plus typed constructors for the `AuthResult`
// discriminated union returned by `CognitoAuthService.getCurrentUser()`.

import { IdcIdentity } from "@amzn/innovation-sandbox-commons/utils/auth-utils.js";
import { AuthResult } from "@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService";

export const MOCK_ID_TOKEN = "mock-id-token";

export const mockCognitoCredentials = {
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-not-a-real-key",
  sessionToken: "test-session-token",
};

export const mockAuthenticatedUser: IdcIdentity = {
  type: "user",
  email: "test@example.com",
  userId: "test-user-id",
  roles: ["User"],
};

/** Typed `AuthResult` constructors so a typo in `status` or a missing
 *  `user`/`message` field is a TypeScript error here, not at the call site. */
export function authenticated(
  user: IdcIdentity = mockAuthenticatedUser,
): AuthResult {
  return { status: "authenticated", user };
}

export function unauthenticated(): AuthResult {
  return { status: "unauthenticated" };
}

export function incompleteClaims(message: string): AuthResult {
  return { status: "incomplete_claims", message };
}
