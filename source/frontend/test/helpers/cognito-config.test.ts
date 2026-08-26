// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { sessionStorage } from "aws-amplify/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { configureAmplifyAuth } from "@amzn/innovation-sandbox-frontend/helpers/cognito-config";

const configure = vi.fn();
const setKeyValueStorage = vi.fn();

vi.mock("aws-amplify", () => ({
  Amplify: {
    configure: (...args: unknown[]) => configure(...args),
  },
}));

vi.mock("aws-amplify/auth/cognito", () => ({
  cognitoUserPoolsTokenProvider: {
    setKeyValueStorage: (...args: unknown[]) => setKeyValueStorage(...args),
  },
}));

vi.mock("aws-amplify/utils", () => ({
  sessionStorage: { type: "session" },
}));

const baseConfig = {
  userPoolId: "us-east-1_abc123",
  appClientId: "client-abc",
  identityPoolId: "us-east-1:pool-abc",
  domain: "isb-test",
  region: "us-east-1",
  awsAccessPortalUrl: "https://d-1234567890.awsapps.com/start",
};

describe("configureAmplifyAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets redirectSignOut to the AWS access portal URL", () => {
    configureAmplifyAuth(baseConfig);

    const oauth = configure.mock.calls[0]![0].Auth.Cognito.loginWith.oauth;
    expect(oauth.redirectSignOut).toEqual([baseConfig.awsAccessPortalUrl]);
    expect(oauth.redirectSignOut[0]).not.toContain("/signed-out");
  });

  it("sets redirectSignIn to the current origin callback path", () => {
    configureAmplifyAuth(baseConfig);

    const oauth = configure.mock.calls[0]![0].Auth.Cognito.loginWith.oauth;
    expect(oauth.redirectSignIn).toEqual([
      `${globalThis.location.origin}/callback`,
    ]);
  });

  it("configures the Cognito pools with the provided identifiers", () => {
    configureAmplifyAuth(baseConfig);

    const cognito = configure.mock.calls[0]![0].Auth.Cognito;
    expect(cognito.userPoolId).toBe(baseConfig.userPoolId);
    expect(cognito.userPoolClientId).toBe(baseConfig.appClientId);
    expect(cognito.identityPoolId).toBe(baseConfig.identityPoolId);
  });

  it("uses sessionStorage for token persistence", () => {
    configureAmplifyAuth(baseConfig);

    expect(setKeyValueStorage).toHaveBeenCalledWith(sessionStorage);
  });
});
