// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CleanupForm } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/CleanupForm";
import { CONFIG_CONSTRAINTS } from "@amzn/innovation-sandbox-frontend/domains/settings/validation";
import { mockAdminConfig } from "@amzn/innovation-sandbox-frontend/mocks/handlers/configurationHandlers";
import { createQueryClientWrapper } from "@amzn/innovation-sandbox-frontend/setupTests";

const adminUser = {
  status: "authenticated",
  user: { type: "user", email: "a@b.com", userId: "a1", roles: ["Admin"] },
};
const managerUser = {
  status: "authenticated",
  user: { type: "user", email: "m@b.com", userId: "m1", roles: ["Manager"] },
};
const getCurrentUser = vi.fn().mockResolvedValue(adminUser);

vi.mock("@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService", () => ({
  CognitoAuthService: {
    getCurrentUser: () => getCurrentUser(),
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

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentUser.mockResolvedValue(adminUser);
});

describe("CleanupForm", () => {
  it("renders editable fields and a Save button for an admin", async () => {
    render(<CleanupForm data={mockAdminConfig.cleanup} />, {
      wrapper: createQueryClientWrapper(),
    });

    // Save button is unique to the admin view; await it so the user query has
    // resolved before asserting the admin-only field label.
    expect(
      await screen.findByRole("button", { name: /save/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/account cooldown \(hours\)/i)).toBeInTheDocument();
  });

  it("bounds the cooldown input with the schema min and max", async () => {
    render(<CleanupForm data={mockAdminConfig.cleanup} />, {
      wrapper: createQueryClientWrapper(),
    });

    await screen.findByRole("button", { name: /save/i });

    const input = screen.getByLabelText(/account cooldown \(hours\)/i);
    expect(input).toHaveAttribute(
      "min",
      String(CONFIG_CONSTRAINTS.MIN_COOLDOWN_PERIOD_HOURS),
    );
    expect(input).toHaveAttribute(
      "max",
      String(CONFIG_CONSTRAINTS.MAX_COOLDOWN_PERIOD_HOURS),
    );
  });

  it("bounds a cleanup retry field with the schema minimum", async () => {
    render(<CleanupForm data={mockAdminConfig.cleanup} />, {
      wrapper: createQueryClientWrapper(),
    });

    await screen.findByRole("button", { name: /save/i });

    const input = screen.getByLabelText(/failed attempts before quarantine/i);
    expect(input).toHaveAttribute(
      "min",
      String(CONFIG_CONSTRAINTS.MIN_CLEANUP_VALUE),
    );
  });

  it("renders the validation and report-retention fields for an admin", async () => {
    render(<CleanupForm data={mockAdminConfig.cleanup} />, {
      wrapper: createQueryClientWrapper(),
    });

    await screen.findByRole("button", { name: /save/i });

    expect(
      screen.getByText(/cleanup report retention \(days\)/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/on validation failure/i)).toBeInTheDocument();
    // The failure-action radio offers both schema enum values.
    expect(
      screen.getByRole("radio", { name: /quarantine/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /warn/i })).toBeInTheDocument();
  });

  it("bounds the report-retention input with the schema min and max", async () => {
    render(<CleanupForm data={mockAdminConfig.cleanup} />, {
      wrapper: createQueryClientWrapper(),
    });

    await screen.findByRole("button", { name: /save/i });

    const input = screen.getByLabelText(/cleanup report retention \(days\)/i);
    expect(input).toHaveAttribute(
      "min",
      String(CONFIG_CONSTRAINTS.MIN_REPORT_RETENTION_DAYS),
    );
    expect(input).toHaveAttribute(
      "max",
      String(CONFIG_CONSTRAINTS.MAX_REPORT_RETENTION_DAYS),
    );
  });

  it("renders a read-only summary for a manager (no Save button)", async () => {
    getCurrentUser.mockResolvedValue(managerUser);

    render(<CleanupForm data={mockAdminConfig.cleanup} />, {
      wrapper: createQueryClientWrapper(),
    });

    // Read-only KeyValuePairs labels — including the newly surfaced fields.
    expect(
      await screen.findByText(/account cooldown \(hours\)/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/cleanup report retention \(days\)/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/on validation failure/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /save/i }),
    ).not.toBeInTheDocument();
  });
});
