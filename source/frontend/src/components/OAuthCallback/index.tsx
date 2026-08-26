// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { Hub } from "aws-amplify/utils";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { FullPageLoader } from "@amzn/innovation-sandbox-frontend/components/FullPageLoader";

/**
 * Handles the OAuth /callback route. Listens for Amplify Hub events
 * to complete the Cognito authorization code exchange, then navigates to "/".
 */
export const OAuthCallback = () => {
  const navigate = useNavigate();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const unsubscribe = Hub.listen("auth", ({ payload }) => {
      if (payload.event === "signInWithRedirect") {
        unsubscribe();
        clearTimeout(timeout);
        navigate("/", { replace: true });
      }
      if (payload.event === "signInWithRedirect_failure") {
        unsubscribe();
        clearTimeout(timeout);
        const errorData = payload.data as
          | { error?: Error | string }
          | undefined;
        const errorMessage =
          errorData?.error instanceof Error
            ? errorData.error.message
            : String(errorData?.error ?? "Unknown error");
        console.error("OAuth callback failed", errorMessage, payload.data);
        setError(errorMessage);
        // Clear the code/state params so the Authenticator doesn't
        // immediately redirect back to Cognito in an infinite loop.
        globalThis.history.replaceState({}, document.title, "/callback");
      }
    });

    // Safety timeout: if Amplify doesn't fire a Hub event within 10s
    // (e.g. token exchange silently fails), stop showing the spinner.
    // Unsubscribe the Hub listener so a late event can't navigate away.
    const timeout = setTimeout(() => {
      unsubscribe();
      console.warn("OAuth callback timed out waiting for Amplify Hub event");
      setError("Timed out waiting for sign-in to complete.");
    }, 10_000);

    return () => {
      unsubscribe();
      clearTimeout(timeout);
    };
  }, [navigate]);

  if (error) {
    return (
      <Box padding="xl" textAlign="center">
        <SpaceBetween size="l">
          <Alert type="error" header="Sign-in failed">
            {error}
          </Alert>
          <Box variant="p" color="text-body-secondary">
            This usually means the authorization code expired or browser storage
            was cleared between the redirect and callback. Try clearing your
            browser storage for this site and signing in again.
          </Box>
          <Button
            onClick={() => {
              // Clear Amplify/Cognito storage to reset PKCE state.
              // Amplify v6 stores all auth data under the "CognitoIdentityServiceProvider"
              // prefix (tokens, PKCE, OAuth state) plus a legacy v5 key
              // "amplify-signin-with-hostedUI". We match these two prefixes only
              // to avoid clearing unrelated storage from other apps on the same origin.
              // See: https://github.com/aws-amplify/amplify-js/blob/main/packages/auth/src/providers/cognito/tokenProvider/constants.ts
              // See: https://github.com/aws-amplify/amplify-js/blob/main/packages/auth/src/providers/cognito/utils/signInWithRedirectStore.ts
              try {
                for (const storage of [sessionStorage, localStorage]) {
                  Object.keys(storage).forEach((key) => {
                    if (
                      key.startsWith("CognitoIdentityServiceProvider") ||
                      key.includes("amplify")
                    ) {
                      storage.removeItem(key);
                    }
                  });
                }
              } catch {
                // ignore storage errors
              }
              globalThis.location.href = "/";
            }}
          >
            Clear session and try again
          </Button>
        </SpaceBetween>
      </Box>
    );
  }

  return <FullPageLoader label="Completing sign-in..." />;
};
