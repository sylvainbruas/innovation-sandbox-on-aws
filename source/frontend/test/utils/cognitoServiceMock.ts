// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

import {
  MOCK_ID_TOKEN,
  mockCognitoCredentials,
} from "@amzn/innovation-sandbox-frontend-test/utils/cognitoFixtures";

export type CognitoAuthServiceMock = {
  getCurrentUser: ReturnType<typeof vi.fn>;
  getIdToken: ReturnType<typeof vi.fn>;
  getCredentials: ReturnType<typeof vi.fn>;
  login: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
};

/** Fully-stubbed `CognitoAuthService` for `vi.mock` factories. Defaults
 *  exercise the SigV4 signing path; pass `overrides` for test-specific
 *  behavior. Invoke from inside the factory body via dynamic `import()` —
 *  `vi.mock` is hoisted above top-level imports. */
export function buildCognitoAuthServiceMock(
  overrides: Partial<CognitoAuthServiceMock> = {},
): CognitoAuthServiceMock {
  return {
    getCurrentUser: vi.fn(),
    getIdToken: vi.fn().mockResolvedValue(MOCK_ID_TOKEN),
    getCredentials: vi.fn().mockResolvedValue(mockCognitoCredentials),
    login: vi.fn(),
    logout: vi.fn(),
    ...overrides,
  };
}
