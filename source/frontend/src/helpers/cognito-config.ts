// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Amplify } from "aws-amplify";
import { cognitoUserPoolsTokenProvider } from "aws-amplify/auth/cognito";
import { sessionStorage } from "aws-amplify/utils";

export interface CognitoConfig {
  userPoolId: string;
  appClientId: string;
  identityPoolId: string;
  domain: string;
  region: string;
  awsAccessPortalUrl: string;
}

/**
 * Configures Amplify Auth with Cognito User Pool and OAuth settings.
 * Uses sessionStorage so tokens are cleared when the browser tab is closed.
 */
export function configureAmplifyAuth(cognitoConfig: CognitoConfig): void {
  const currentOrigin = globalThis.location.origin;

  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: cognitoConfig.userPoolId,
        userPoolClientId: cognitoConfig.appClientId,
        identityPoolId: cognitoConfig.identityPoolId,
        loginWith: {
          oauth: {
            domain: `${cognitoConfig.domain}.auth.${cognitoConfig.region}.amazoncognito.com`,
            scopes: ["openid", "email", "profile"],
            redirectSignIn: [`${currentOrigin}/callback`],
            // Sign-out lands on the IDC access portal, not an in-app page —
            // clearing the Cognito session alone can't end the IDC SAML session,
            // so we hand off to the portal where the user can finish signing out.
            redirectSignOut: [cognitoConfig.awsAccessPortalUrl],
            responseType: "code",
            providers: [{ custom: "IAMIdentityCenter" }],
          },
        },
      },
    },
  });

  cognitoUserPoolsTokenProvider.setKeyValueStorage(sessionStorage);
}
