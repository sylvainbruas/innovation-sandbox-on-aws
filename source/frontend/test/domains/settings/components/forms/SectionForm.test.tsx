// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import InputField from "@amzn/innovation-sandbox-frontend/components/FormFields/InputField";
import ToggleField from "@amzn/innovation-sandbox-frontend/components/FormFields/ToggleField";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { SectionForm } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/SectionForm";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import {
  configurationSectionConflictHandler,
  configurationSectionPutHandler,
  configurationSectionValidationHandler,
} from "@amzn/innovation-sandbox-frontend/mocks/handlers/configurationHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { createQueryClientWrapper } from "@amzn/innovation-sandbox-frontend/setupTests";

const apiUrl = getConfig().ApiUrl;

vi.mock("@amzn/innovation-sandbox-frontend/components/Toast", () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
}));

const adminUser = {
  status: "authenticated",
  user: {
    type: "user",
    email: "admin@example.com",
    userId: "a1",
    roles: ["Admin"],
  },
};
const managerUser = {
  status: "authenticated",
  user: {
    type: "user",
    email: "mgr@example.com",
    userId: "m1",
    roles: ["Manager"],
  },
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

function renderShell() {
  return render(
    <SectionForm
      section="maintenance"
      title="Maintenance Mode"
      data={{ enabled: false, lastSavedBy: "admin@example.com" }}
      renderFields={() => (
        <ToggleField
          controllerProps={{ name: "enabled" }}
          formFieldProps={{ label: "Maintenance mode" }}
        />
      )}
      renderReadOnly={(d) => (
        <div>maintenance enabled: {String(d.enabled)}</div>
      )}
    />,
    { wrapper: createQueryClientWrapper() },
  );
}

// The notification section's `emailFrom` validates as a valid email OR an empty
// string, giving a field that can be made invalid by typing a non-email — used
// to exercise the Save-disabled-when-invalid behavior.
function renderNotificationShell(
  data: {
    emailFrom: string;
    lastSavedBy: string | null;
  } = { emailFrom: "", lastSavedBy: "admin@example.com" },
) {
  return render(
    <SectionForm
      section="notification"
      title="Notification"
      data={data}
      renderFields={() => (
        <InputField
          controllerProps={{ name: "emailFrom" }}
          formFieldProps={{ label: "Email from address" }}
          inputProps={{ placeholder: "Enter email" }}
        />
      )}
      renderReadOnly={(d) => <div>email: {d.emailFrom}</div>}
    />,
    { wrapper: createQueryClientWrapper() },
  );
}

// Save is disabled on a pristine SAVED section (nothing to save), so tests that
// exercise a save must first dirty the form — mirroring a real edit-then-save.
// renderShell's SectionForm has no confirmBeforeSave, so toggling saves directly
// (no confirmation modal).
const dirtyMaintenanceToggle = async () => {
  await userEvent.click(screen.getByRole("checkbox"));
};

describe("SectionForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentUser.mockResolvedValue(adminUser);
  });

  it("saves the section and shows no conflict on success", async () => {
    getCurrentUser.mockResolvedValue(adminUser);
    server.use(configurationSectionPutHandler());

    renderShell();

    const save = await screen.findByRole("button", { name: /save/i });
    await dirtyMaintenanceToggle();
    await userEvent.click(save);

    await waitFor(() =>
      expect(showSuccessToast).toHaveBeenCalledWith("Settings saved."),
    );
    expect(
      screen.queryByText(/modified by another administrator/i),
    ).not.toBeInTheDocument();
    // After a successful save the form resets to pristine, so Save disables
    // again (nothing to save). With a disabledReason set, Cloudscape marks it
    // aria-disabled (kept focusable) rather than natively disabled.
    await waitFor(() => expect(save).toHaveAttribute("aria-disabled", "true"));
  });

  it("shows a conflict alert on 409 and does not toast success", async () => {
    getCurrentUser.mockResolvedValue(adminUser);
    server.use(configurationSectionConflictHandler());

    renderShell();

    const save = await screen.findByRole("button", { name: /save/i });
    await dirtyMaintenanceToggle();
    await userEvent.click(save);

    expect(
      await screen.findByText(/modified by another administrator/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
    expect(showSuccessToast).not.toHaveBeenCalled();
  });

  it("toasts an error and shows no conflict when a non-409 save fails", async () => {
    getCurrentUser.mockResolvedValue(adminUser);
    // PUT fails with a bodyless 500, which ApiProxy surfaces as
    // ApiError("HTTP error 500"). This exercises the save-error branch
    // (distinct from the 409 conflict path) and pins the toast format.
    server.use(
      http.put(
        `${apiUrl}/configurations/:section`,
        () => new HttpResponse(null, { status: 500 }),
      ),
    );

    renderShell();

    const save = await screen.findByRole("button", { name: /save/i });
    await dirtyMaintenanceToggle();
    await userEvent.click(save);

    await waitFor(() =>
      expect(showErrorToast).toHaveBeenCalledWith(
        "Failed to save settings: HTTP error 500",
        "Save Failed",
      ),
    );
    expect(showSuccessToast).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/modified by another administrator/i),
    ).not.toBeInTheDocument();
  });

  it("surfaces a 400 field error on the matching field without toasting", async () => {
    getCurrentUser.mockResolvedValue(adminUser);
    server.use(
      configurationSectionValidationHandler([
        { field: "enabled", message: "Maintenance mode must be a boolean." },
      ]),
    );

    renderShell();

    const save = await screen.findByRole("button", { name: /save/i });
    await dirtyMaintenanceToggle();
    await userEvent.click(save);

    // The server message renders on the field (via React Hook Form setError →
    // the FormField's errorText), not as a toast.
    expect(
      await screen.findByText(/maintenance mode must be a boolean/i),
    ).toBeInTheDocument();
    expect(showSuccessToast).not.toHaveBeenCalled();
    expect(showErrorToast).not.toHaveBeenCalled();
    // It is the validation path, not the 409 conflict path.
    expect(
      screen.queryByText(/modified by another administrator/i),
    ).not.toBeInTheDocument();
  });

  it("surfaces a 400 non-field error as a form-level alert", async () => {
    getCurrentUser.mockResolvedValue(adminUser);
    // No `field` (and the "input" sentinel) means the error is not tied to a
    // registered field, so it must surface in a form-level alert.
    server.use(
      configurationSectionValidationHandler([
        { message: "These settings are inconsistent." },
      ]),
    );

    renderShell();

    const save = await screen.findByRole("button", { name: /save/i });
    await dirtyMaintenanceToggle();
    await userEvent.click(save);

    expect(
      await screen.findByText(/these settings are inconsistent/i),
    ).toBeInTheDocument();
    expect(showSuccessToast).not.toHaveBeenCalled();
  });

  it("clears a stranded form-level 400 alert when the form is reverted to pristine", async () => {
    getCurrentUser.mockResolvedValue(adminUser);
    // A whole-object 400 surfaces as a form-level (root) alert. If the user then
    // reverts their edit back to the saved baseline, the form is pristine and
    // Save is disabled ("nothing to save") — so a resubmit (which is what
    // normally clears the root error) is no longer possible. The stale alert
    // must clear on its own when the form returns to pristine, or it strands
    // with no way to dismiss it.
    server.use(
      configurationSectionValidationHandler([
        { message: "These settings are inconsistent." },
      ]),
    );

    renderShell();

    const save = await screen.findByRole("button", { name: /save/i });
    await dirtyMaintenanceToggle();
    await userEvent.click(save);
    expect(
      await screen.findByText(/these settings are inconsistent/i),
    ).toBeInTheDocument();

    // Revert the toggle back to its saved value -> form pristine -> Save
    // disabled. The stranded form-level alert must clear.
    await dirtyMaintenanceToggle();

    await waitFor(() => expect(save).toHaveAttribute("aria-disabled", "true"));
    expect(
      screen.queryByText(/these settings are inconsistent/i),
    ).not.toBeInTheDocument();
  });

  it("surfaces every 400 non-field error, not just the last one", async () => {
    getCurrentUser.mockResolvedValue(adminUser);
    // Multiple non-field errors must all appear in the form-level alert —
    // setting them one-by-one would overwrite all but the last.
    server.use(
      configurationSectionValidationHandler([
        { message: "First problem with the settings." },
        { message: "Second problem with the settings." },
      ]),
    );

    renderShell();

    const save = await screen.findByRole("button", { name: /save/i });
    await dirtyMaintenanceToggle();
    await userEvent.click(save);

    expect(
      await screen.findByText(/first problem with the settings/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/second problem with the settings/i),
    ).toBeInTheDocument();
    expect(showSuccessToast).not.toHaveBeenCalled();
  });

  it("clears a prior 400 form-level alert on a subsequent successful save", async () => {
    getCurrentUser.mockResolvedValue(adminUser);
    // First save returns a non-field 400 -> form-level alert.
    server.use(
      configurationSectionValidationHandler([
        { message: "These settings are inconsistent." },
      ]),
    );

    renderShell();

    const save = await screen.findByRole("button", { name: /save/i });
    await dirtyMaintenanceToggle();
    await userEvent.click(save);
    expect(
      await screen.findByText(/these settings are inconsistent/i),
    ).toBeInTheDocument();

    // Next save succeeds; the stale form-level alert must clear. The form is
    // still dirty (a 400 does not reset it), so Save remains enabled.
    server.use(configurationSectionPutHandler());
    await userEvent.click(save);

    await waitFor(() =>
      expect(showSuccessToast).toHaveBeenCalledWith("Settings saved."),
    );
    expect(
      screen.queryByText(/these settings are inconsistent/i),
    ).not.toBeInTheDocument();
  });

  it("toasts a fallback error when a 400 carries no usable field errors", async () => {
    getCurrentUser.mockResolvedValue(adminUser);
    // A 400 with an empty errors array must not fail silently.
    server.use(configurationSectionValidationHandler([]));

    renderShell();

    const save = await screen.findByRole("button", { name: /save/i });
    await dirtyMaintenanceToggle();
    await userEvent.click(save);

    await waitFor(() =>
      expect(showErrorToast).toHaveBeenCalledWith(
        "Failed to save settings: validation error",
        "Save Failed",
      ),
    );
    expect(showSuccessToast).not.toHaveBeenCalled();
  });

  it("renders read-only content for a Manager (no Save button)", async () => {
    getCurrentUser.mockResolvedValue(managerUser);

    renderShell();

    expect(
      await screen.findByText(/maintenance enabled: false/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /save/i }),
    ).not.toBeInTheDocument();
  });

  it("submits the reloaded concurrency token, not the stale one, after a conflict", async () => {
    getCurrentUser.mockResolvedValue(adminUser);
    // First PUT conflicts (409).
    server.use(configurationSectionConflictHandler());

    render(
      <SectionForm
        section="maintenance"
        title="Maintenance Mode"
        data={{
          enabled: false,
          lastSavedBy: "admin@example.com",
          meta: {
            schemaVersion: 1,
            createdTime: "2026-01-01T00:00:00.000Z",
            lastEditTime: "T1-stale",
          },
        }}
        renderFields={() => (
          <ToggleField
            controllerProps={{ name: "enabled" }}
            formFieldProps={{ label: "Maintenance mode" }}
          />
        )}
        renderReadOnly={(d) => (
          <div>maintenance enabled: {String(d.enabled)}</div>
        )}
      />,
      { wrapper: createQueryClientWrapper() },
    );

    const save = await screen.findByRole("button", { name: /save/i });
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(save);

    // Conflict surfaces and success is not toasted.
    expect(
      await screen.findByText(/modified by another administrator/i),
    ).toBeInTheDocument();
    expect(showSuccessToast).not.toHaveBeenCalled();

    // Register inline handlers AFTER the conflict handler so they win (later
    // `server.use` wins in MSW): a GET that returns a DIFFERENT, known
    // lastEditTime ("T2-fresh") for Reload to pick up, and a PUT that captures
    // the submitted token. This is what makes the test load-bearing: it asserts
    // WHICH token the second save carried, not merely that the save succeeded.
    let submittedLastEditTime: string | undefined;
    server.use(
      http.get(`${apiUrl}/configurations/:section`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            enabled: false,
            lastSavedBy: "admin@example.com",
            meta: {
              schemaVersion: 1,
              createdTime: "2026-01-01T00:00:00.000Z",
              lastEditTime: "T2-fresh",
            },
          },
        }),
      ),
      http.put(`${apiUrl}/configurations/:section`, async ({ request }) => {
        const body = (await request.json()) as {
          meta?: { lastEditTime?: string };
        };
        submittedLastEditTime = body.meta?.lastEditTime;
        return HttpResponse.json({
          status: "success",
          data: {
            enabled: false,
            lastSavedBy: "admin@example.com",
            meta: {
              schemaVersion: 1,
              createdTime: "2026-01-01T00:00:00.000Z",
              lastEditTime: "T3-saved",
            },
          },
        });
      }),
    );

    await userEvent.click(screen.getByRole("button", { name: /reload/i }));

    // Conflict alert clears after a successful reload.
    await waitFor(() =>
      expect(
        screen.queryByText(/modified by another administrator/i),
      ).not.toBeInTheDocument(),
    );

    // Reload resets the form to the reloaded values (pristine), so dirty it
    // again before the second save.
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    // The second save must carry the RELOADED token ("T2-fresh"), not the stale
    // one ("T1-stale"). Reading data.meta?.lastEditTime in onSubmit (the bug)
    // would send "T1-stale" and fail this assertion.
    await waitFor(() => expect(submittedLastEditTime).toBe("T2-fresh"));
    await waitFor(() =>
      expect(showSuccessToast).toHaveBeenCalledWith("Settings saved."),
    );
  });

  it("keeps the mount-time concurrency token on a DIRTY form when the parent passes fresh data, so a stale save conflicts instead of overwriting", async () => {
    getCurrentUser.mockResolvedValue(adminUser);

    let submittedLastEditTime: string | undefined;
    server.use(
      http.put(`${apiUrl}/configurations/:section`, async ({ request }) => {
        const body = (await request.json()) as {
          meta?: { lastEditTime?: string };
        };
        submittedLastEditTime = body.meta?.lastEditTime;
        return HttpResponse.json({
          status: "success",
          data: {
            enabled: false,
            lastSavedBy: "admin@example.com",
            meta: {
              schemaVersion: 1,
              createdTime: "2026-01-01T00:00:00.000Z",
              lastEditTime: "T-after-save",
            },
          },
        });
      }),
    );

    const fields = () => (
      <ToggleField
        controllerProps={{ name: "enabled" }}
        formFieldProps={{ label: "Maintenance mode" }}
      />
    );
    const readOnly = (d: { enabled: boolean }) => (
      <div>maintenance enabled: {String(d.enabled)}</div>
    );

    const { rerender } = render(
      <SectionForm
        section="maintenance"
        title="Maintenance Mode"
        data={{
          enabled: false,
          lastSavedBy: "admin@example.com",
          meta: {
            schemaVersion: 1,
            createdTime: "2026-01-01T00:00:00.000Z",
            lastEditTime: "T-initial",
          },
        }}
        renderFields={fields}
        renderReadOnly={readOnly}
      />,
      { wrapper: createQueryClientWrapper() },
    );

    // Dirty the form FIRST, so it has unsaved edits when fresh data arrives.
    await userEvent.click(await screen.findByRole("checkbox"));

    // A background refetch (e.g. the admin-config query invalidated by another
    // section's save, or a window-refocus refetch) re-renders SectionForm with a
    // fresh `data` prop carrying a newer token, while the user's unsaved field
    // values are still on screen. A DIRTY section must NOT re-seed from it — the
    // user's edits and the mount-time token are both preserved.
    rerender(
      <SectionForm
        section="maintenance"
        title="Maintenance Mode"
        data={{
          enabled: false,
          lastSavedBy: "admin@example.com",
          meta: {
            schemaVersion: 1,
            createdTime: "2026-01-01T00:00:00.000Z",
            lastEditTime: "T-refreshed",
          },
        }}
        renderFields={fields}
        renderReadOnly={readOnly}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    // The save must carry the MOUNT-TIME token ("T-initial"), not the token from
    // the background refetch ("T-refreshed"). Re-seeding a dirty form from props
    // (the bug) would submit the user's stale field values under the newer token
    // and silently overwrite the concurrent edit; keeping the mount-time token
    // makes such a save hit a 409 and surface the Reload flow instead.
    await waitFor(() => expect(submittedLastEditTime).toBe("T-initial"));
  });

  it("re-seeds a PRISTINE form when the parent passes fresh data (page refresh)", async () => {
    getCurrentUser.mockResolvedValue(adminUser);

    const fields = () => (
      <ToggleField
        controllerProps={{ name: "enabled" }}
        formFieldProps={{ label: "Maintenance mode" }}
      />
    );
    const readOnly = (d: { enabled: boolean }) => (
      <div>maintenance enabled: {String(d.enabled)}</div>
    );

    const { rerender } = render(
      <SectionForm
        section="maintenance"
        title="Maintenance Mode"
        data={{
          enabled: false,
          lastSavedBy: "admin@example.com",
          meta: {
            schemaVersion: 1,
            createdTime: "2026-01-01T00:00:00.000Z",
            lastEditTime: "T-initial",
          },
        }}
        renderFields={fields}
        renderReadOnly={readOnly}
      />,
      { wrapper: createQueryClientWrapper() },
    );

    const checkbox = await screen.findByRole("checkbox");
    expect(checkbox).not.toBeChecked();

    // A refresh delivers fresh server data (enabled flipped to true) via a new
    // `data` prop. The form is pristine, so it re-seeds to the new value.
    rerender(
      <SectionForm
        section="maintenance"
        title="Maintenance Mode"
        data={{
          enabled: true,
          lastSavedBy: "admin@example.com",
          meta: {
            schemaVersion: 1,
            createdTime: "2026-01-01T00:00:00.000Z",
            lastEditTime: "T-refreshed",
          },
        }}
        renderFields={fields}
        renderReadOnly={readOnly}
      />,
    );

    await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
  });

  it("re-seeds deferred fresh data once a dirty form is reverted to pristine", async () => {
    getCurrentUser.mockResolvedValue(adminUser);

    const fields = () => (
      <ToggleField
        controllerProps={{ name: "enabled" }}
        formFieldProps={{ label: "Maintenance mode" }}
      />
    );
    const readOnly = (d: { enabled: boolean }) => (
      <div>maintenance enabled: {String(d.enabled)}</div>
    );

    const { rerender } = render(
      <SectionForm
        section="maintenance"
        title="Maintenance Mode"
        data={{
          enabled: false,
          lastSavedBy: "admin@example.com",
          meta: {
            schemaVersion: 1,
            createdTime: "2026-01-01T00:00:00.000Z",
            lastEditTime: "T-initial",
          },
        }}
        renderFields={fields}
        renderReadOnly={readOnly}
      />,
      { wrapper: createQueryClientWrapper() },
    );

    // Dirty the form (false -> true).
    const checkbox = await screen.findByRole("checkbox");
    await userEvent.click(checkbox);
    expect(checkbox).toBeChecked();

    // Fresh server data (enabled=true) arrives while dirty — must NOT clobber
    // the edit, and must NOT be forgotten.
    rerender(
      <SectionForm
        section="maintenance"
        title="Maintenance Mode"
        data={{
          enabled: true,
          lastSavedBy: "admin@example.com",
          meta: {
            schemaVersion: 1,
            createdTime: "2026-01-01T00:00:00.000Z",
            lastEditTime: "T-refreshed",
          },
        }}
        renderFields={fields}
        renderReadOnly={readOnly}
      />,
    );

    // User reverts their edit (true -> false): form returns to pristine.
    // The deferred re-seed must now apply the fresh data (enabled=true).
    await userEvent.click(screen.getByRole("checkbox"));

    await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
  });

  it("disables Save when a field is invalid", async () => {
    getCurrentUser.mockResolvedValue(adminUser);

    // Never-saved section so Save starts enabled on a pristine form (the
    // finish-setup carve-out) — this isolates the invalid-field gate from the
    // nothing-to-save gate. Cloudscape renders a disabledReason-disabled button
    // with aria-disabled (keeping it focusable), not the native `disabled`
    // attribute, so assert on aria-disabled.
    renderNotificationShell({ emailFrom: "", lastSavedBy: null });

    const save = await screen.findByRole("button", { name: /save/i });
    expect(save).not.toHaveAttribute("aria-disabled", "true");

    // Typing a non-email makes the field invalid -> Save disables.
    await userEvent.type(
      screen.getByPlaceholderText("Enter email"),
      "not-an-email",
    );

    await waitFor(() => expect(save).toHaveAttribute("aria-disabled", "true"));
  });

  it("re-enables Save once the field becomes valid again", async () => {
    getCurrentUser.mockResolvedValue(adminUser);

    renderNotificationShell();

    const save = await screen.findByRole("button", { name: /save/i });
    const input = screen.getByPlaceholderText("Enter email");

    await userEvent.type(input, "bad");
    await waitFor(() => expect(save).toHaveAttribute("aria-disabled", "true"));

    await userEvent.clear(input);
    await userEvent.type(input, "ok@example.com");

    await waitFor(() =>
      expect(save).not.toHaveAttribute("aria-disabled", "true"),
    );
  });

  it("keeps Save enabled for a never-saved section showing valid defaults (not gated on dirty)", async () => {
    getCurrentUser.mockResolvedValue(adminUser);

    // A never-saved section (lastSavedBy === null) renders its valid code
    // defaults with a pristine (non-dirty) form. Save MUST stay enabled so the
    // admin can persist the defaults via the finish-setup flow — gating on
    // isDirty would break that.
    renderNotificationShell({ emailFrom: "", lastSavedBy: null });

    const save = await screen.findByRole("button", { name: /save/i });
    expect(save).not.toHaveAttribute("aria-disabled", "true");
  });

  it("keeps Save enabled after a server 400 so the user can retry", async () => {
    getCurrentUser.mockResolvedValue(adminUser);
    // A server-side validation error maps onto the form (field error with
    // type "server"). It must NOT disable Save, or the user could never resubmit
    // after a server rejection. Gating on client (resolver) errors only avoids
    // this deadlock.
    server.use(
      configurationSectionValidationHandler([
        { field: "emailFrom", message: "Email rejected by the server." },
      ]),
    );

    renderNotificationShell();

    const save = await screen.findByRole("button", { name: /save/i });
    // Dirty with a VALID email so the client resolver passes and the save
    // reaches the server (which then rejects it with a 400).
    await userEvent.type(
      screen.getByPlaceholderText("Enter email"),
      "ok@example.com",
    );
    await userEvent.click(save);

    expect(
      await screen.findByText(/email rejected by the server/i),
    ).toBeInTheDocument();
    // Save stays enabled despite the server-injected field error (the form is
    // still dirty and the server error carries type "server", which does not
    // gate Save).
    expect(save).not.toHaveAttribute("aria-disabled", "true");
  });

  it("shows a loader until the user role resolves, not the read-only view", async () => {
    // Hold the user query pending so the loading state is observable. Without
    // the loading gate, isAdmin is false during loading (roles === []), so the
    // read-only view would flash in before the role resolves — making this the
    // same render a real Manager sees and rendering the role tests vacuous.
    let resolveUser: (value: typeof adminUser) => void = () => {};
    getCurrentUser.mockReturnValue(
      new Promise((resolve) => {
        resolveUser = resolve;
      }),
    );

    renderShell();

    // While the role is pending: a loader, NOT the read-only summary or the
    // editable Save button.
    expect(await screen.findByText(/loading/i)).toBeInTheDocument();
    expect(screen.queryByText(/maintenance enabled:/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /save/i }),
    ).not.toBeInTheDocument();

    resolveUser(adminUser);

    // Once resolved as an Admin, the editable form replaces the loader.
    expect(
      await screen.findByRole("button", { name: /save/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  });

  it("keeps the conflict and toasts an error when a reload fails after a prior successful reload", async () => {
    getCurrentUser.mockResolvedValue(adminUser);
    // PUT always conflicts (409) so each save re-opens the conflict alert.
    server.use(configurationSectionConflictHandler());

    render(
      <SectionForm
        section="maintenance"
        title="Maintenance Mode"
        data={{
          enabled: false,
          lastSavedBy: "admin@example.com",
          meta: {
            schemaVersion: 1,
            createdTime: "2026-01-01T00:00:00.000Z",
            lastEditTime: "T1-stale",
          },
        }}
        renderFields={() => (
          <ToggleField
            controllerProps={{ name: "enabled" }}
            formFieldProps={{ label: "Maintenance mode" }}
          />
        )}
        renderReadOnly={(d) => (
          <div>maintenance enabled: {String(d.enabled)}</div>
        )}
      />,
      { wrapper: createQueryClientWrapper() },
    );

    // Save #1 conflicts.
    await screen.findByRole("button", { name: /save/i });
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(
      await screen.findByText(/modified by another administrator/i),
    ).toBeInTheDocument();

    // Reload #1 SUCCEEDS — this populates the per-section reload query's cache,
    // which is what makes the later failure return stale-but-present `data`.
    server.use(
      http.get(`${apiUrl}/configurations/:section`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            enabled: false,
            lastSavedBy: "admin@example.com",
            meta: {
              schemaVersion: 1,
              createdTime: "2026-01-01T00:00:00.000Z",
              lastEditTime: "T2-fresh",
            },
          },
        }),
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /reload/i }));
    await waitFor(() =>
      expect(
        screen.queryByText(/modified by another administrator/i),
      ).not.toBeInTheDocument(),
    );

    // Save #2 conflicts again (PUT 409 handler still active). Reload reset the
    // form to pristine, so dirty it again to enable Save.
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(
      await screen.findByText(/modified by another administrator/i),
    ).toBeInTheDocument();

    // Reload #2 FAILS. refetch() resolves with `data` still set to the cached
    // T2-fresh value plus an `error`; branching on `data` alone (the bug) would
    // silently reset the form and clear the conflict. Branching on `error` keeps
    // the conflict and surfaces the failure.
    server.use(
      http.get(
        `${apiUrl}/configurations/:section`,
        () => new HttpResponse(null, { status: 500 }),
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /reload/i }));

    await waitFor(() =>
      expect(showErrorToast).toHaveBeenCalledWith(
        "Failed to reload the latest settings.",
        "Reload Failed",
      ),
    );
    // The conflict must NOT be cleared by a failed reload.
    expect(
      screen.getByText(/modified by another administrator/i),
    ).toBeInTheDocument();
  });
});
