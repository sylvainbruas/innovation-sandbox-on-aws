// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen } from "@testing-library/react";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { IdcIdentity } from "@amzn/innovation-sandbox-commons/utils/auth-utils";
import { BaseLayout } from "@amzn/innovation-sandbox-frontend/components/AppLayout/BaseLayout";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { AdminConfig } from "@amzn/innovation-sandbox-frontend/domains/settings/service";
import { CognitoAuthService } from "@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService";
import {
  adminConfigGetHandler,
  createAdminConfig,
} from "@amzn/innovation-sandbox-frontend/mocks/handlers/configurationHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";
import { authenticated } from "@amzn/innovation-sandbox-frontend-test/utils/cognitoFixtures";

// Builds an AdminConfig with the maintenance section toggled on or off.
const configWithMaintenance = (enabled: boolean): AdminConfig => {
  const config = createAdminConfig();
  return {
    ...config,
    maintenance: { ...config.maintenance, enabled },
  };
};

// Renders a marker once the shared admin-config query resolves. The maintenance
// banner renders nothing both while the query is loading and when maintenance
// is off, so a synchronous absence check would pass against the loading render
// without ever exercising the disabled branch. Gating the assertion on this
// probe forces the query to settle first.
const ConfigSettledProbe = () => {
  const { isSuccess } = useGetConfigurations();
  return isSuccess ? <div data-testid="config-settled" /> : null;
};

const userWithRoles = (roles: IdcIdentity["roles"]): IdcIdentity => ({
  type: "user",
  email: "test@example.com",
  userId: "test-user-id",
  roles,
});

// vi.mock is hoisted above every import, so the factory body cannot close over
// top-level variables; it pulls the shared mock in via dynamic import() once
// Vitest first resolves the mocked module. The helper supplies
// getCredentials/getIdToken for the SigV4 signing path in ApiProxy; per-test
// role switching is done below via vi.mocked(CognitoAuthService.getCurrentUser).
vi.mock(
  "@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService",
  async () => {
    const { buildCognitoAuthServiceMock } = await import(
      "@amzn/innovation-sandbox-frontend-test/utils/cognitoServiceMock"
    );
    return { CognitoAuthService: buildCognitoAuthServiceMock() };
  },
);

describe("BaseLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(CognitoAuthService.getCurrentUser).mockResolvedValue(
      authenticated(userWithRoles(["User"])),
    );
  });

  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <BaseLayout>
          <div data-testid="child-content">Child Content</div>
          <ConfigSettledProbe />
        </BaseLayout>
      </Router>,
    );

  test("does not render maintenance banner when maintenance mode is disabled", async () => {
    server.use(adminConfigGetHandler(configWithMaintenance(false)));

    renderComponent();

    // Wait for the config query to resolve before asserting absence, otherwise
    // the banner would be absent merely because the config is still loading,
    // and the test would pass without exercising the disabled branch.
    await screen.findByTestId("config-settled");
    expect(screen.queryByText("Maintenance Mode")).not.toBeInTheDocument();
  });

  test("renders maintenance banner when maintenance mode is enabled", async () => {
    server.use(adminConfigGetHandler(configWithMaintenance(true)));

    renderComponent();

    expect(await screen.findByText("Maintenance Mode")).toBeInTheDocument();
    // The banner deep-links to the Maintenance section of the in-app Settings
    // page (#maintenance selects the General tab and scrolls to the section).
    // The Settings nav item is gated off for this User role, so the only
    // Settings link present is the banner's.
    expect(
      await screen.findByRole("link", { name: /settings/i }),
    ).toHaveAttribute("href", "/settings#maintenance");
  });

  test("shows the Settings nav item with an attention badge for an admin", async () => {
    vi.mocked(CognitoAuthService.getCurrentUser).mockResolvedValue(
      authenticated(userWithRoles(["Admin"])),
    );
    // Two sections never saved -> the badge shows a count of 2. Maintenance is
    // disabled so the banner's own "/settings" link is absent and the side-nav
    // item is the only Settings link (the maintenance banner is covered by its
    // own test above).
    server.use(
      adminConfigGetHandler({
        ...createAdminConfig({ unsaved: ["leases", "cleanup"] }),
        maintenance: { enabled: false, lastSavedBy: "admin@example.com" },
      }),
    );

    renderComponent();

    const settingsLink = await screen.findByRole("link", { name: /settings/i });
    expect(settingsLink).toHaveAttribute("href", "/settings");
    expect(await screen.findByText("2")).toBeInTheDocument();
  });
});
