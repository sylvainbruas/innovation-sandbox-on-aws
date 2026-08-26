// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { IsbRole } from "@amzn/innovation-sandbox-commons/utils/auth-utils.js";
import { ProtectedRoute } from "@amzn/innovation-sandbox-frontend/components/ProtectedRoute";

const mockUseUser = vi.fn();
vi.mock("@amzn/innovation-sandbox-frontend/hooks/useUser", () => ({
  useUser: () => mockUseUser(),
}));

const renderWithRouter = (ui: React.ReactNode) => {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
};

describe("ProtectedRoute", () => {
  it.each<{
    description: string;
    userRoles: IsbRole[];
    allowedRoles: IsbRole[];
  }>([
    {
      description: "Admin accessing Admin-only route",
      userRoles: ["Admin"],
      allowedRoles: ["Admin"],
    },
    {
      description: "Manager accessing Manager+Admin route",
      userRoles: ["Manager"],
      allowedRoles: ["Manager", "Admin"],
    },
    {
      description: "Admin accessing Manager+Admin route",
      userRoles: ["Admin"],
      allowedRoles: ["Manager", "Admin"],
    },
    {
      description: "User accessing all-roles route",
      userRoles: ["User"],
      allowedRoles: ["User", "Manager", "Admin"],
    },
  ])(
    "renders children when authorized: $description",
    ({ userRoles, allowedRoles }) => {
      mockUseUser.mockReturnValue({ roles: userRoles, isLoading: false });

      renderWithRouter(
        <ProtectedRoute allowedRoles={allowedRoles}>
          <div>Protected content</div>
        </ProtectedRoute>,
      );

      expect(screen.getByText("Protected content")).toBeInTheDocument();
      expect(screen.queryByText("Access denied")).not.toBeInTheDocument();
    },
  );

  it.each<{
    description: string;
    userRoles: IsbRole[];
    allowedRoles: IsbRole[];
  }>([
    {
      description: "User accessing Admin-only route",
      userRoles: ["User"],
      allowedRoles: ["Admin"],
    },
    {
      description: "User accessing Manager+Admin route",
      userRoles: ["User"],
      allowedRoles: ["Manager", "Admin"],
    },
    {
      description: "Manager accessing Admin-only route",
      userRoles: ["Manager"],
      allowedRoles: ["Admin"],
    },
  ])(
    "renders access denied when unauthorized: $description",
    ({ userRoles, allowedRoles }) => {
      mockUseUser.mockReturnValue({ roles: userRoles, isLoading: false });

      renderWithRouter(
        <ProtectedRoute allowedRoles={allowedRoles}>
          <div>Protected content</div>
        </ProtectedRoute>,
      );

      expect(screen.getByText("Access denied")).toBeInTheDocument();
      expect(
        screen.getByText("You don't have permission to access this page."),
      ).toBeInTheDocument();
      expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
    },
  );

  it("renders loading spinner while user data is loading", () => {
    mockUseUser.mockReturnValue({ roles: [], isLoading: true });

    renderWithRouter(
      <ProtectedRoute allowedRoles={["Admin"]}>
        <div>Protected content</div>
      </ProtectedRoute>,
    );

    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
    expect(screen.queryByText("Access denied")).not.toBeInTheDocument();
  });
});
