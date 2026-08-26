// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsBadge } from "@amzn/innovation-sandbox-frontend/domains/settings/components/SettingsBadge";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import {
  adminConfigGetHandler,
  createAdminConfig,
} from "@amzn/innovation-sandbox-frontend/mocks/handlers/configurationHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { createQueryClientWrapper } from "@amzn/innovation-sandbox-frontend/setupTests";

/**
 * Renders a marker once the shared admin-config query has resolved. The badge
 * renders nothing in TWO states — while the query is still loading and when
 * every section is saved — so a plain "assert empty" check passes against the
 * loading render and never observes the post-load state. Gating the assertion
 * on this probe forces the query to settle first, so the empty assertion
 * actually exercises the all-saved branch.
 */
const ConfigSettledProbe = () => {
  const { isSuccess } = useGetConfigurations();
  return isSuccess ? <div data-testid="config-settled" /> : null;
};

vi.mock("@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService", () => ({
  CognitoAuthService: {
    getIdToken: vi.fn().mockResolvedValue("mock-id-token"),
    getCredentials: vi.fn().mockResolvedValue({
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-not-a-real-key",
      sessionToken: "test-session-token",
    }),
    login: vi.fn(),
    logout: vi.fn(),
  },
}));

const renderBadge = () =>
  render(<SettingsBadge />, { wrapper: createQueryClientWrapper() });

const renderBadgeWithProbe = () =>
  render(
    <>
      <SettingsBadge />
      <ConfigSettledProbe />
    </>,
    { wrapper: createQueryClientWrapper() },
  );

describe("SettingsBadge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the count of never-saved sections", async () => {
    server.use(
      adminConfigGetHandler(
        createAdminConfig({ unsaved: ["leases", "cleanup"] }),
      ),
    );

    renderBadge();

    expect(await screen.findByText("2")).toBeInTheDocument();
  });

  it("renders nothing when every section has been saved", async () => {
    server.use(adminConfigGetHandler(createAdminConfig()));

    renderBadgeWithProbe();

    // Wait for the query to actually resolve before asserting emptiness —
    // otherwise the assertion would pass against the badge's loading render
    // (also null) and never exercise the all-saved branch.
    await screen.findByTestId("config-settled");

    // The badge renders no element once every section is saved. (A regression
    // that dropped the all-saved guard would render "0" here.)
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+/)).not.toBeInTheDocument();
  });
});
