// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaintenanceForm } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/MaintenanceForm";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { mockAdminConfig } from "@amzn/innovation-sandbox-frontend/mocks/handlers/configurationHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
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

describe("MaintenanceForm", () => {
  it("renders the editable toggle and a Save button for an admin", async () => {
    render(<MaintenanceForm data={mockAdminConfig.maintenance} />, {
      wrapper: createQueryClientWrapper(),
    });

    // The "Maintenance mode" label appears in both views, so disambiguate the
    // admin view by the Save button (await it) and the Toggle control, which the
    // read-only KeyValuePairs view does not render.
    expect(
      await screen.findByRole("button", { name: /save/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
  });

  it("warns that fresh installs are in maintenance mode when the section is unsaved", async () => {
    // lastSavedBy === null => never saved (fresh install). The schema default is
    // enabled: true, so the app is fail-closed until an admin saves it OFF.
    render(<MaintenanceForm data={{ enabled: true, lastSavedBy: null }} />, {
      wrapper: createQueryClientWrapper(),
    });

    await screen.findByRole("button", { name: /save/i });
    expect(
      screen.getByText(/new deployments start with maintenance mode on/i),
    ).toBeInTheDocument();
  });

  it("suppresses the generic defaults alert on a fresh install (shows only its own warning)", async () => {
    // A never-saved section would otherwise show SectionForm's generic "Using
    // default values" alert AND this section's maintenance warning. Maintenance
    // suppresses the generic one so the two do not stack — only the richer,
    // maintenance-specific warning (which conveys the lockout) is shown.
    render(<MaintenanceForm data={{ enabled: true, lastSavedBy: null }} />, {
      wrapper: createQueryClientWrapper(),
    });

    await screen.findByRole("button", { name: /save/i });
    expect(
      screen.getByText(/new deployments start with maintenance mode on/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("Using default values")).not.toBeInTheDocument();
  });

  it("does not show the fresh-install maintenance warning once the section is saved", async () => {
    render(
      <MaintenanceForm data={{ enabled: true, lastSavedBy: "a@b.com" }} />,
      { wrapper: createQueryClientWrapper() },
    );

    await screen.findByRole("button", { name: /save/i });
    expect(
      screen.queryByText(/new deployments start with maintenance mode on/i),
    ).not.toBeInTheDocument();
  });

  it("shows an inline Enabled state label when maintenance is on", async () => {
    render(
      <MaintenanceForm data={{ enabled: true, lastSavedBy: "a@b.com" }} />,
      { wrapper: createQueryClientWrapper() },
    );

    await screen.findByRole("button", { name: /save/i });
    expect(screen.getByText("Enabled")).toBeInTheDocument();
  });

  it("shows an inline Disabled state label when maintenance is off", async () => {
    render(
      <MaintenanceForm data={{ enabled: false, lastSavedBy: "a@b.com" }} />,
      { wrapper: createQueryClientWrapper() },
    );

    await screen.findByRole("button", { name: /save/i });
    expect(screen.getByText("Disabled")).toBeInTheDocument();
  });

  it("renders a read-only summary for a manager (no Save button)", async () => {
    getCurrentUser.mockResolvedValue(managerUser);

    render(<MaintenanceForm data={mockAdminConfig.maintenance} />, {
      wrapper: createQueryClientWrapper(),
    });

    // Read-only KeyValuePairs label, no Save button and no Toggle control.
    expect(await screen.findByText(/maintenance mode/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /save/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("renders the read-only boolean as human-readable status, not raw true/false", async () => {
    getCurrentUser.mockResolvedValue(managerUser);

    render(
      <MaintenanceForm data={{ enabled: true, lastSavedBy: "a@b.com" }} />,
      {
        wrapper: createQueryClientWrapper(),
      },
    );

    // Wait for the read-only view itself (the "Enabled" status), not the
    // section header "Maintenance Mode" which also renders during the loading
    // state before the Manager role resolves.
    expect(await screen.findByText("Enabled")).toBeInTheDocument();
    expect(screen.queryByText("true")).not.toBeInTheDocument();
  });

  describe("save confirmation", () => {
    const mockPut = () => {
      const putBodies: Array<Record<string, unknown>> = [];
      server.use(
        http.put(
          `${getConfig().ApiUrl}/configurations/:section`,
          async ({ request }) => {
            putBodies.push((await request.json()) as Record<string, unknown>);
            return HttpResponse.json({
              status: "success",
              data: {
                enabled: true,
                lastSavedBy: "a@b.com",
                meta: {
                  schemaVersion: 1,
                  createdTime: "2026-01-01T00:00:00.000Z",
                  lastEditTime: "T1",
                },
              },
            });
          },
        ),
      );
      return putBodies;
    };

    it("asks for confirmation when the toggle changed, and Confirm saves", async () => {
      const user = userEvent.setup();
      const putBodies = mockPut();

      render(
        <MaintenanceForm data={{ enabled: false, lastSavedBy: "a@b.com" }} />,
        { wrapper: createQueryClientWrapper() },
      );

      await user.click(await screen.findByRole("checkbox"));
      await user.click(screen.getByRole("button", { name: /save/i }));

      // Modal appears instead of saving; nothing persisted yet.
      expect(
        await screen.findByText("Turn on maintenance mode?"),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/managers and sandbox users will lose access/i),
      ).toBeInTheDocument();
      expect(putBodies).toHaveLength(0);

      // The confirm button restates the action (not a generic "Confirm").
      await user.click(
        screen.getByRole("button", { name: "Turn on maintenance mode" }),
      );

      // The save carries the toggled value, not a stale snapshot.
      await waitFor(() => expect(putBodies).toHaveLength(1));
      expect(putBodies[0]).toMatchObject({ enabled: true });
      await waitFor(() =>
        expect(
          screen.queryByText("Turn on maintenance mode?"),
        ).not.toBeInTheDocument(),
      );
    });

    it("Cancel closes the modal without saving", async () => {
      const user = userEvent.setup();
      const putBodies = mockPut();

      render(
        <MaintenanceForm data={{ enabled: false, lastSavedBy: "a@b.com" }} />,
        { wrapper: createQueryClientWrapper() },
      );

      await user.click(await screen.findByRole("checkbox"));
      await user.click(screen.getByRole("button", { name: /save/i }));
      await screen.findByText("Turn on maintenance mode?");

      await user.click(screen.getByRole("button", { name: "Cancel" }));

      await waitFor(() =>
        expect(
          screen.queryByText("Turn on maintenance mode?"),
        ).not.toBeInTheDocument(),
      );
      expect(putBodies).toHaveLength(0);
      // The edit is preserved so the admin can still save it after re-confirming.
      expect(screen.getByRole("checkbox")).toBeChecked();
    });

    it("shows the turn-off wording when disabling maintenance mode", async () => {
      const user = userEvent.setup();
      mockPut();

      render(
        <MaintenanceForm data={{ enabled: true, lastSavedBy: "a@b.com" }} />,
        { wrapper: createQueryClientWrapper() },
      );

      await user.click(await screen.findByRole("checkbox"));
      await user.click(screen.getByRole("button", { name: /save/i }));

      expect(
        await screen.findByText("Turn off maintenance mode?"),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/managers and sandbox users will regain access/i),
      ).toBeInTheDocument();
    });

    it("re-disables Save after a confirmed save, so no unchanged re-save is possible", async () => {
      const user = userEvent.setup();
      const putBodies = mockPut();

      render(
        <MaintenanceForm data={{ enabled: false, lastSavedBy: "a@b.com" }} />,
        { wrapper: createQueryClientWrapper() },
      );

      // Toggle on and confirm through the modal.
      await user.click(await screen.findByRole("checkbox"));
      await user.click(screen.getByRole("button", { name: /save/i }));
      await user.click(
        await screen.findByRole("button", { name: "Turn on maintenance mode" }),
      );
      await waitFor(() => expect(putBodies).toHaveLength(1));

      // The successful save resets the form to pristine (baseline now enabled:
      // true), so Save disables again — there is nothing left to save and no
      // second prompt can occur. With a disabledReason set, Cloudscape marks it
      // aria-disabled (kept focusable) rather than natively disabled.
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /save/i })).toHaveAttribute(
          "aria-disabled",
          "true",
        ),
      );
    });

    it("surfaces a conflict when the confirmed save hits a 409", async () => {
      const user = userEvent.setup();
      server.use(
        http.put(`${getConfig().ApiUrl}/configurations/:section`, () =>
          HttpResponse.json(
            { status: "error", message: "conflict" },
            { status: 409 },
          ),
        ),
      );

      render(
        <MaintenanceForm data={{ enabled: false, lastSavedBy: "a@b.com" }} />,
        { wrapper: createQueryClientWrapper() },
      );

      // Toggle → confirm through the modal → the save fails with a 409. This
      // reaches performSave's error handling via the modal-confirm path (not
      // the direct submit), so the conflict alert must surface and the modal
      // must close.
      await user.click(await screen.findByRole("checkbox"));
      await user.click(screen.getByRole("button", { name: /save/i }));
      await user.click(
        await screen.findByRole("button", { name: "Turn on maintenance mode" }),
      );

      expect(
        await screen.findByText(/modified by another/i),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("Turn on maintenance mode?"),
      ).not.toBeInTheDocument();
    });
  });
});
