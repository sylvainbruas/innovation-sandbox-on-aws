// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NotificationForm } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/NotificationForm";
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

describe("NotificationForm", () => {
  it("renders the editable field and a Save button for an admin", async () => {
    render(<NotificationForm data={mockAdminConfig.notification} />, {
      wrapper: createQueryClientWrapper(),
    });

    // The placeholder is unique to the admin input; awaiting it confirms the
    // user query has resolved and the admin form has swapped in.
    expect(
      await screen.findByPlaceholderText(/no-reply@example\.com/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/email from address/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
  });

  it("renders a read-only summary for a manager (no Save button)", async () => {
    getCurrentUser.mockResolvedValue(managerUser);

    render(<NotificationForm data={mockAdminConfig.notification} />, {
      wrapper: createQueryClientWrapper(),
    });

    // Read-only KeyValuePairs label.
    expect(await screen.findByText("Email from address")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /save/i }),
    ).not.toBeInTheDocument();
  });
});
