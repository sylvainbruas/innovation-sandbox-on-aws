// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import Alert from "@cloudscape-design/components/alert";
import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import SpaceBetween from "@cloudscape-design/components/space-between";
import React, { useEffect, useState } from "react";

import Animate from "@amzn/innovation-sandbox-frontend/components/Animate";
import { FullPageLoader } from "@amzn/innovation-sandbox-frontend/components/FullPageLoader";
import { CognitoAuthService } from "@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";

interface AuthenticatorProps {
  children: React.ReactNode;
}

export const Authenticator = ({ children }: AuthenticatorProps) => {
  const { user: currentUser, authError, isLoading, error } = useUser();
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    if (currentUser) {
      globalThis.history.replaceState(
        {},
        document.title,
        globalThis.location.pathname,
      );
    }
  }, [currentUser]);

  // Redirect to login when there's no session — wrapped in useEffect to avoid
  // firing signInWithRedirect as a side effect in the render path.
  useEffect(() => {
    if (!isLoading && !currentUser && !authError && !error && !redirecting) {
      setRedirecting(true);
      CognitoAuthService.login();
    }
  }, [isLoading, currentUser, authError, error, redirecting]);

  if (isLoading) {
    return <FullPageLoader label="Authenticating..." />;
  }

  if (currentUser) {
    return <Animate>{children}</Animate>;
  }

  if (authError) {
    return (
      <Box padding="xl" textAlign="center">
        <SpaceBetween size="l">
          <Alert type="error" header="Authentication error">
            {authError}
          </Alert>
          <Button
            onClick={() =>
              CognitoAuthService.logout().catch((err) => {
                console.error("Logout failed", err);
                globalThis.location.href = getConfig().AwsAccessPortalUrl;
              })
            }
          >
            Sign out
          </Button>
        </SpaceBetween>
      </Box>
    );
  }

  // Transient failure (network error, Cognito outage) — show error instead
  // of redirecting, which would cause an infinite loop.
  if (error) {
    return (
      <Box padding="xl" textAlign="center">
        <SpaceBetween size="l">
          <Alert type="error" header="Unable to verify session">
            Something went wrong while checking your authentication. Please try
            again or contact your administrator.
          </Alert>
          <Button onClick={() => globalThis.location.reload()}>
            Try again
          </Button>
        </SpaceBetween>
      </Box>
    );
  }

  return <FullPageLoader label="Redirecting..." />;
};
