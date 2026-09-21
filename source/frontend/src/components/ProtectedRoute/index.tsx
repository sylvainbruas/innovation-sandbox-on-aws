// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ReactNode } from "react";

import { FullPageLoader } from "@amzn/innovation-sandbox-frontend/components/FullPageLoader";
import { Unauthorized } from "@amzn/innovation-sandbox-frontend/domains/home/pages/Unauthorized";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";
import type { IsbRole } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

interface ProtectedRouteProps {
  allowedRoles: IsbRole[];
  children: ReactNode;
}

export const ProtectedRoute = ({
  allowedRoles,
  children,
}: ProtectedRouteProps) => {
  const { roles, isLoading } = useUser();

  if (isLoading) {
    return <FullPageLoader />;
  }

  if (!allowedRoles.some((role) => roles.includes(role))) {
    return <Unauthorized />;
  }

  return <>{children}</>;
};
