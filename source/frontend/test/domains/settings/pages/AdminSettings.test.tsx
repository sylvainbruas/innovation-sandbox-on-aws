// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DateTime } from "luxon";
import { delay, http, HttpResponse } from "msw";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import {
  AdminSettings,
  TAB_HELP,
} from "@amzn/innovation-sandbox-frontend/domains/settings/pages/AdminSettings";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import {
  adminConfigGetHandler,
  configurationSectionConflictHandler,
  configurationSectionPutHandler,
  configurationSectionValidationHandler,
  createAdminConfig,
} from "@amzn/innovation-sandbox-frontend/mocks/handlers/configurationHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const apiUrl = getConfig().ApiUrl;

// The page renders six sections, each its own Cloudscape Container with its own
// Save button. Locate one section's container by matching its header text,
// robust against section order and hashed class names (vs. picking by index).
const findSectionContainer = (headingText: string) =>
  createWrapper()
    .findAllContainers()
    .find((c) =>
      c.findHeader()?.getElement().textContent?.includes(headingText),
    ) ?? null;

const findSaveButtonForSection = (headingText: string) =>
  // Save lives in the Container footer (with the last-edited provenance), not
  // the content body.
  findSectionContainer(headingText)?.findFooter()?.findButton()?.getElement() ??
  null;

const clickSaveForSection = async (headingText: string) => {
  // The Save button only renders once SectionForm resolves the user role to
  // Admin (it shows a loader first), so wait for it before clicking.
  await waitFor(() =>
    expect(findSaveButtonForSection(headingText)).not.toBeNull(),
  );
  await userEvent.click(findSaveButtonForSection(headingText)!);
};

// The page groups sections into tabs; the read-only deploy-time block lives on
// its own "Read-only" tab whose content only mounts once the tab is activated
// (it is not eager-rendered). Activate it before asserting on that content.
const openReadOnlyTab = async () => {
  const tab = await screen.findByRole("tab", { name: /read-only/i });
  await userEvent.click(tab);
};

vi.mock("@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb", () => ({
  useBreadcrumb: () => vi.fn(),
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

// The page mounts UnsavedChangesProvider, whose useBlocker requires a data
// router — so tests render via createMemoryRouter, not a plain Router.
// Returns the router so tests can navigate (as a help-panel link would).
const renderPage = (initialEntries: string[] = ["/settings"]) => {
  const router = createMemoryRouter(
    [{ path: "*", element: <AdminSettings /> }],
    { initialEntries },
  );
  renderWithQueryClient(<RouterProvider router={router} />);
  return router;
};

const SECTION_HEADINGS = [
  "Lease Policies",
  "Cleanup",
  "Maintenance Mode",
  "Terms of Service",
  "Notification",
  "Cost Reporting",
];

describe("AdminSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentUser.mockResolvedValue(adminUser);
  });

  it("renders a container for every section plus the read-only container (admin)", async () => {
    server.use(adminConfigGetHandler(createAdminConfig()));

    renderPage();

    // Wait for the sections to resolve to the Admin (editable) view first: each
    // SectionForm shows a loader until the user role resolves, and the finish
    // -setup/header content settles with it. Admin gets one Save button per
    // section (6).
    const saveButtons = await screen.findAllByRole("button", { name: /save/i });
    expect(saveButtons).toHaveLength(SECTION_HEADINGS.length);

    // The six editable sections live on eager-rendered tabs, so all of their
    // headings are in the DOM regardless of which tab is active.
    for (const heading of SECTION_HEADINGS) {
      expect(
        screen.getByRole("heading", { name: heading }),
      ).toBeInTheDocument();
    }

    // The read-only deploy-time block is on its own tab (not eager); it mounts
    // once that tab is opened.
    await openReadOnlyTab();
    expect(
      await screen.findByRole("heading", { name: "Read-Only Settings" }),
    ).toBeInTheDocument();
  });

  it("shows the finish-setup alert only for never-saved sections", async () => {
    server.use(
      adminConfigGetHandler(createAdminConfig({ unsaved: ["leases"] })),
    );

    renderPage();

    // Exactly one finish-setup alert (for the one unsaved section).
    const alerts = await screen.findAllByText("Using default values");
    expect(alerts).toHaveLength(1);

    // The unsaved section's header reports it is not yet saved.
    expect(screen.getByText("Not yet saved")).toBeInTheDocument();
    // The other five saved sections each show their last-saved provenance.
    expect(
      screen.getAllByText(/Last edited by admin@example.com/),
    ).toHaveLength(SECTION_HEADINGS.length - 1);
  });

  it("renders the read-only deploy-time fields", async () => {
    server.use(
      adminConfigGetHandler({
        ...createAdminConfig(),
        isbManagedRegions: ["us-east-1", "eu-west-1"],
        awsAccessPortalUrl: "https://d-1234567890.awsapps.com/start",
      }),
    );

    renderPage();

    await openReadOnlyTab();
    expect(
      await screen.findByRole("heading", { name: "Read-Only Settings" }),
    ).toBeInTheDocument();
    // Each managed region renders as its own Badge chip (not a comma-joined
    // string), consistent with the cost-report-groups read-only view. Scope to
    // the Read-Only Settings container and use the Cloudscape test-utils Badge
    // finder rather than matching internal (hashed) CSS class names.
    const readOnlyContainer = findSectionContainer("Read-Only Settings");
    // findAllBadges lives on the root wrapper, so re-wrap the container element
    // to scope the Badge search to the Read-Only Settings section.
    const regionBadges = createWrapper(readOnlyContainer!.getElement())
      .findAllBadges()
      .map((badge) => badge.getElement().textContent);
    expect(regionBadges).toEqual(["us-east-1", "eu-west-1"]);
    expect(screen.queryByText("us-east-1, eu-west-1")).not.toBeInTheDocument();
    // The access portal URL renders as an external link to itself, pointing at
    // the configured URL (a swapped href must fail this).
    expect(
      screen.getByRole("link", {
        name: "https://d-1234567890.awsapps.com/start",
      }),
    ).toHaveAttribute("href", "https://d-1234567890.awsapps.com/start");
  });

  it("renders empty-state fallbacks for unset deploy-time fields", async () => {
    server.use(
      adminConfigGetHandler({
        ...createAdminConfig(),
        isbManagedRegions: [],
        awsAccessPortalUrl: "",
      }),
    );

    renderPage();

    await openReadOnlyTab();
    expect(
      await screen.findByRole("heading", { name: "Read-Only Settings" }),
    ).toBeInTheDocument();
    // No managed regions -> "(none)"; no portal URL -> "(not set)" (and no link).
    expect(screen.getByText("(none)")).toBeInTheDocument();
    expect(screen.getByText("(not set)")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("shows a loader while the config is loading", async () => {
    server.use(
      http.get(`${apiUrl}/configurations`, async () => {
        await delay(100);
        return HttpResponse.json({
          status: "success",
          data: createAdminConfig(),
        });
      }),
    );

    renderPage();

    expect(screen.getByText("Loading...")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("Loading...")).not.toBeInTheDocument(),
    );
  });

  it("shows an error panel with retry when the config fails to load", async () => {
    server.use(
      http.get(`${apiUrl}/configurations`, () =>
        HttpResponse.json(
          { status: "error", message: "boom" },
          { status: 500 },
        ),
      ),
    );

    renderPage();

    expect(
      await screen.findByText("There was a problem loading settings."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /try again/i }),
    ).toBeInTheDocument();
  });

  it("renders sections read-only for a manager (no Save buttons)", async () => {
    getCurrentUser.mockResolvedValue(managerUser);
    server.use(adminConfigGetHandler(createAdminConfig()));

    renderPage();

    // Sections still render...
    expect(
      await screen.findByRole("heading", { name: "Lease Policies" }),
    ).toBeInTheDocument();
    // ...with the read-only KeyValuePairs view (a label only the read-only
    // branch of LeasesForm renders), proving the role resolved to read-only
    // rather than the form being stuck on its loading state...
    expect(await screen.findByText("Max budget")).toBeInTheDocument();
    // ...and no editable Save buttons.
    expect(
      screen.queryByRole("button", { name: /save/i }),
    ).not.toBeInTheDocument();
  });

  describe("tabbed layout", () => {
    it("badges a tab with the count of its unsaved sections", async () => {
      // leases (Leases & Cost tab) + maintenance (General tab) unsaved.
      server.use(
        adminConfigGetHandler(
          createAdminConfig({ unsaved: ["leases", "maintenance"] }),
        ),
      );

      renderPage();

      // Each affected tab shows a "1" badge alongside its label; the Cleanup
      // tab (its section is saved) shows none.
      const leasesTab = await screen.findByRole("tab", {
        name: /leases & cost/i,
      });
      const generalTab = screen.getByRole("tab", { name: /general/i });
      const cleanupTab = screen.getByRole("tab", { name: /cleanup/i });

      expect(within(leasesTab).getByText("1")).toBeInTheDocument();
      expect(within(generalTab).getByText("1")).toBeInTheDocument();
      expect(within(cleanupTab).queryByText("1")).not.toBeInTheDocument();
    });

    it("labels the never-saved count badge for screen readers, matching the app's 'defaults' copy", async () => {
      // Leases & Cost holds two sections; both unsaved -> badge "2" (plural).
      server.use(
        adminConfigGetHandler(
          createAdminConfig({ unsaved: ["leases", "costReporting"] }),
        ),
      );

      renderPage();

      const leasesTab = await screen.findByRole("tab", {
        name: /leases & cost/i,
      });
      // The bare count is not self-explanatory; the badge carries an accessible
      // label phrased in the app's established vocabulary ("using default
      // values" — matching the section alerts and setup banner).
      expect(
        within(leasesTab).getByLabelText("2 sections using default values"),
      ).toBeInTheDocument();
      // The visible badge shows the SAME count the label speaks — the two
      // representations must never diverge (e.g. sighted "1" vs announced "2").
      expect(within(leasesTab).getByText("2")).toBeInTheDocument();
      // And the label genuinely reaches the tab's computed accessible NAME
      // (role="img" aria-label survives name-from-contents), so a tablist
      // screen-reader user hears it with the tab — not just an element buried
      // inside it.
      expect(leasesTab).toHaveAccessibleName(
        "Leases & Cost 2 sections using default values",
      );
    });

    it("uses the singular label when one section is unsaved", async () => {
      server.use(
        adminConfigGetHandler(createAdminConfig({ unsaved: ["cleanup"] })),
      );

      renderPage();

      const cleanupTab = await screen.findByRole("tab", { name: /cleanup/i });
      expect(
        within(cleanupTab).getByLabelText("1 section using default values"),
      ).toBeInTheDocument();
    });

    it("reveals a tooltip on hover explaining the never-saved count badge", async () => {
      server.use(
        adminConfigGetHandler(
          createAdminConfig({ unsaved: ["leases", "costReporting"] }),
        ),
      );

      renderPage();

      const leasesTab = await screen.findByRole("tab", {
        name: /leases & cost/i,
      });
      const badge = within(leasesTab).getByLabelText(
        "2 sections using default values",
      );

      // The explanatory text is not duplicated visibly until hover.
      expect(
        screen.queryByText("2 sections using default values"),
      ).not.toBeInTheDocument();

      await userEvent.hover(badge);

      expect(
        await screen.findByText("2 sections using default values"),
      ).toBeInTheDocument();

      // And it dismisses when the pointer leaves.
      await userEvent.unhover(badge);
      await waitFor(() =>
        expect(
          screen.queryByText("2 sections using default values"),
        ).not.toBeInTheDocument(),
      );
    });

    it("dismisses the badge tooltip on Escape", async () => {
      server.use(
        adminConfigGetHandler(
          createAdminConfig({ unsaved: ["leases", "costReporting"] }),
        ),
      );

      renderPage();

      const leasesTab = await screen.findByRole("tab", {
        name: /leases & cost/i,
      });
      const badge = within(leasesTab).getByLabelText(
        "2 sections using default values",
      );
      await userEvent.hover(badge);
      await screen.findByText("2 sections using default values");

      // Escape closes the tooltip without needing to move the pointer — the
      // shared IndicatorTooltip shell wires Cloudscape's onEscape, so this
      // covers the amber unsaved-edits indicator too.
      await userEvent.keyboard("{Escape}");

      await waitFor(() =>
        expect(
          screen.queryByText("2 sections using default values"),
        ).not.toBeInTheDocument(),
      );
    });

    it("preserves an in-progress edit when switching tabs and back", async () => {
      server.use(adminConfigGetHandler(createAdminConfig()));

      renderPage();

      // Edit the cost-report-groups input on the Leases & Cost tab.
      const input = await screen.findByPlaceholderText(
        /enter a cost report group/i,
      );
      await userEvent.type(input, "draft-not-yet-added");

      // Switch to another tab and back. Eager render keeps the form mounted, so
      // the typed draft must survive (a default-unmount tab would lose it).
      await userEvent.click(screen.getByRole("tab", { name: /cleanup/i }));
      await userEvent.click(
        screen.getByRole("tab", { name: /leases & cost/i }),
      );

      expect(
        screen.getByPlaceholderText(/enter a cost report group/i),
      ).toHaveValue("draft-not-yet-added");
    });

    it("opens the General tab when deep-linked to #maintenance", async () => {
      server.use(adminConfigGetHandler(createAdminConfig()));

      renderPage(["/settings#maintenance"]);

      // The maintenance banner links to /settings#maintenance; the page maps
      // that hash to the General tab and selects it (default would be the first
      // tab, Leases & Cost). The Maintenance Mode section lives on General.
      const generalTab = await screen.findByRole("tab", { name: /general/i });
      await waitFor(() =>
        expect(generalTab).toHaveAttribute("aria-selected", "true"),
      );
      expect(
        await screen.findByRole("heading", { name: "Maintenance Mode" }),
      ).toBeInTheDocument();
    });

    it("re-honors a section link whose hash already matches the URL", async () => {
      server.use(adminConfigGetHandler(createAdminConfig()));

      // Deep-link leaves #maintenance in the URL...
      const router = renderPage(["/settings#maintenance"]);
      const generalTab = await screen.findByRole("tab", { name: /general/i });
      await waitFor(() =>
        expect(generalTab).toHaveAttribute("aria-selected", "true"),
      );

      // ...the user moves to another tab...
      await userEvent.click(screen.getByRole("tab", { name: /cleanup/i }));

      // ...then follows a help-panel link to the SAME hash. The URL string is
      // unchanged, but the navigation must still switch tabs — consuming the
      // hash by string value would leave this click dead.
      await act(async () => {
        await router.navigate("/settings#maintenance");
      });

      await waitFor(() =>
        expect(generalTab).toHaveAttribute("aria-selected", "true"),
      );
    });
  });

  describe("unsaved-changes tab indicator", () => {
    // Both tab indicators carry aria-labels; the dirty dot's ("Unsaved changes
    // on this tab") is disjoint from the red badge's ("N sections using default
    // values"), so /unsaved changes/i uniquely matches the dot.
    const dirtyDotIn = (tab: HTMLElement) =>
      within(tab).queryByLabelText(/unsaved changes/i);

    // The Cost Reporting section (on the Leases & Cost tab) has a plain toggle
    // that dirties the form on click, no confirmation modal.
    const costReportingToggle = () =>
      within(findSectionContainer("Cost Reporting")!.getElement()).getByRole(
        "checkbox",
      );

    it("marks a tab with a dot once one of its sections is edited", async () => {
      server.use(adminConfigGetHandler(createAdminConfig()));

      renderPage();

      const leasesTab = await screen.findByRole("tab", {
        name: /leases & cost/i,
      });
      // Wait for the Admin (editable) view, then confirm no dirty dot yet.
      await waitFor(() =>
        expect(findSaveButtonForSection("Cost Reporting")).not.toBeNull(),
      );
      expect(dirtyDotIn(leasesTab)).not.toBeInTheDocument();

      // Toggle the Cost Reporting switch to dirty the section.
      await userEvent.click(costReportingToggle());

      await waitFor(() => expect(dirtyDotIn(leasesTab)).toBeInTheDocument());
      // Other tabs stay unmarked.
      expect(
        dirtyDotIn(screen.getByRole("tab", { name: /cleanup/i })),
      ).not.toBeInTheDocument();
    });

    it("clears the dot after the edited section is saved", async () => {
      server.use(
        adminConfigGetHandler(createAdminConfig()),
        configurationSectionPutHandler(),
      );

      renderPage();

      const leasesTab = await screen.findByRole("tab", {
        name: /leases & cost/i,
      });
      // Toggle the Cost Reporting switch to dirty the section, then save it.
      await waitFor(() =>
        expect(findSaveButtonForSection("Cost Reporting")).not.toBeNull(),
      );
      await userEvent.click(costReportingToggle());
      await waitFor(() => expect(dirtyDotIn(leasesTab)).toBeInTheDocument());

      await clickSaveForSection("Cost Reporting");

      await waitFor(() =>
        expect(dirtyDotIn(leasesTab)).not.toBeInTheDocument(),
      );
    });

    it("shows the never-saved count badge without a dirty dot when nothing is edited", async () => {
      server.use(
        adminConfigGetHandler(createAdminConfig({ unsaved: ["leases"] })),
      );

      renderPage();

      const leasesTab = await screen.findByRole("tab", {
        name: /leases & cost/i,
      });
      // Never-saved section -> red count badge, but no edit -> no dirty dot.
      expect(within(leasesTab).getByText("1")).toBeInTheDocument();
      expect(dirtyDotIn(leasesTab)).not.toBeInTheDocument();
    });

    it("shows both the red count badge and the dirty dot when a tab has one of each", async () => {
      // Leases & Cost holds leases (never-saved) + costReporting (saved). Edit
      // costReporting so the tab has a never-saved section AND a saved-dirty
      // section at once — both indicators must appear together.
      server.use(
        adminConfigGetHandler(createAdminConfig({ unsaved: ["leases"] })),
      );

      renderPage();

      const leasesTab = await screen.findByRole("tab", {
        name: /leases & cost/i,
      });
      await waitFor(() =>
        expect(findSaveButtonForSection("Cost Reporting")).not.toBeNull(),
      );
      await userEvent.click(costReportingToggle());

      await waitFor(() => expect(dirtyDotIn(leasesTab)).toBeInTheDocument());
      // The red never-saved count (for leases) coexists with the dirty dot.
      expect(within(leasesTab).getByText("1")).toBeInTheDocument();
      // With BOTH indicators rendered, both labels must reach the tab's
      // computed accessible name (pinning the disjoint labels and their order),
      // so a tablist screen-reader user hears the full state in one pass.
      expect(leasesTab).toHaveAccessibleName(
        "Leases & Cost 1 section using default values Unsaved changes on this tab",
      );
    });

    it("does not add a dirty dot to a never-saved section that is edited (red badge only)", async () => {
      // The dirty dot counts only SAVED-but-dirty sections; a never-saved
      // section is already flagged red, so editing it must not add a second
      // (amber) marker. costReporting is the only section on Leases & Cost when
      // leases is saved, so this isolates the never-saved+dirty case.
      server.use(
        adminConfigGetHandler(
          createAdminConfig({ unsaved: ["costReporting"] }),
        ),
      );

      renderPage();

      const leasesTab = await screen.findByRole("tab", {
        name: /leases & cost/i,
      });
      await waitFor(() =>
        expect(findSaveButtonForSection("Cost Reporting")).not.toBeNull(),
      );
      // Editing the never-saved costReporting section makes it dirty...
      await userEvent.click(costReportingToggle());

      // ...but it stays red-only: the never-saved count remains and NO dirty
      // dot appears (the section is not saved, so hasDirtyEdit excludes it).
      expect(within(leasesTab).getByText("1")).toBeInTheDocument();
      // Give any dot a chance to (wrongly) render before asserting absence.
      await waitFor(() =>
        expect(findSaveButtonForSection("Cost Reporting")).not.toBeNull(),
      );
      expect(dirtyDotIn(leasesTab)).not.toBeInTheDocument();
    });

    it("reveals a tooltip on hover explaining the indicator", async () => {
      server.use(adminConfigGetHandler(createAdminConfig()));

      renderPage();

      const leasesTab = await screen.findByRole("tab", {
        name: /leases & cost/i,
      });
      await waitFor(() =>
        expect(findSaveButtonForSection("Cost Reporting")).not.toBeNull(),
      );
      await userEvent.click(costReportingToggle());
      await waitFor(() => expect(dirtyDotIn(leasesTab)).toBeInTheDocument());

      // The tooltip text is not shown until the indicator is hovered.
      expect(
        screen.queryByText(/unsaved changes on this tab/i),
      ).not.toBeInTheDocument();

      await userEvent.hover(dirtyDotIn(leasesTab)!);

      expect(
        await screen.findByText(/unsaved changes on this tab/i),
      ).toBeInTheDocument();
    });
  });

  describe("per-tab help panel", () => {
    // The page pushes its help content into the AppLayout tools slot via
    // setTools(<Markdown file=... />). The global setupTests mock returns fresh
    // fns per call, so install a stable spy and read the markdown file name off
    // the last element it received.
    const lastHelpFile = (setTools: ReturnType<typeof vi.fn>) =>
      (
        setTools.mock.calls[setTools.mock.calls.length - 1]?.[0] as
          | { props: { file: string } }
          | undefined
      )?.props.file;

    const mockSetTools = () => {
      const setTools = vi.fn();
      const setToolsOpen = vi.fn();
      vi.mocked(useAppLayoutContext).mockReturnValue({
        toolsOpen: false,
        setTools,
        setToolsOpen,
      });
      return { setTools, setToolsOpen };
    };

    // vi.clearAllMocks() in the outer beforeEach clears calls but NOT the
    // mockReturnValue installed above, which would otherwise leak the stable
    // stub into every later test in this file. Reset to fresh-fns-per-call
    // (equivalent to the setupTests default, which omits toolsOpen).
    afterEach(() => {
      vi.mocked(useAppLayoutContext).mockReset();
      vi.mocked(useAppLayoutContext).mockImplementation(() => ({
        toolsOpen: false,
        setTools: vi.fn(),
        setToolsOpen: vi.fn(),
      }));
    });

    it("shows the active tab's help and follows tab switches", async () => {
      const { setTools, setToolsOpen } = mockSetTools();
      server.use(adminConfigGetHandler(createAdminConfig()));

      renderPage();

      // Default tab (Leases & Cost) gets its own help file, not the whole doc.
      await waitFor(() =>
        expect(lastHelpFile(setTools)).toBe("settings-leases-cost"),
      );

      await userEvent.click(
        await screen.findByRole("tab", { name: /cleanup/i }),
      );
      await waitFor(() =>
        expect(lastHelpFile(setTools)).toBe("settings-cleanup"),
      );

      await userEvent.click(screen.getByRole("tab", { name: /read-only/i }));
      await waitFor(() =>
        expect(lastHelpFile(setTools)).toBe("settings-read-only"),
      );

      // Syncing the content must never force the panel open — only the info
      // link opens it.
      expect(setToolsOpen).not.toHaveBeenCalled();
    });

    it("shows the target tab's help when deep-linked to a section", async () => {
      const { setTools } = mockSetTools();
      server.use(adminConfigGetHandler(createAdminConfig()));

      // #maintenance maps to the General tab, so the help must be General's.
      renderPage(["/settings#maintenance"]);

      await waitFor(() =>
        expect(lastHelpFile(setTools)).toBe("settings-general"),
      );
    });

    it("header info link opens the active tab's help", async () => {
      const { setTools, setToolsOpen } = mockSetTools();
      server.use(adminConfigGetHandler(createAdminConfig()));

      renderPage();

      await userEvent.click(
        await screen.findByRole("tab", { name: /cleanup/i }),
      );
      // The header info icon (an InfoLink) must push the ACTIVE tab's file and
      // open the panel — a stale hardcoded file here would 404 in production.
      // The icon-only link has no accessible name, so find it via the page
      // Header's info slot (the first Header is the page's h1).
      const infoLink = createWrapper()
        .findHeader()!
        .findInfo()!
        .findLink()!
        .getElement();
      await userEvent.click(infoLink);

      expect(lastHelpFile(setTools)).toBe("settings-cleanup");
      expect(setToolsOpen).toHaveBeenCalledWith(true);
    });

    it("every tab's help file exists in public/markdown", () => {
      // The page tests assert file NAMES only; this pins every TAB_HELP value
      // to a real file so a rename/deletion (or a new tab whose file was never
      // created) cannot silently 404. Iterating the exported map keeps the
      // test self-updating.
      for (const file of Object.values(TAB_HELP)) {
        expect(
          existsSync(
            join(__dirname, "../../../../public/markdown", `${file}.md`),
          ),
          `public/markdown/${file}.md should exist`,
        ).toBe(true);
      }
    });
  });

  describe("initial-setup banner", () => {
    it("shows the aggregate banner only when every section is unsaved", async () => {
      // Fresh install: all six sections unsaved.
      server.use(
        adminConfigGetHandler(
          createAdminConfig({
            unsaved: [
              "leases",
              "cleanup",
              "maintenance",
              "termsOfService",
              "notification",
              "costReporting",
            ],
          }),
        ),
      );

      renderPage();

      expect(
        await screen.findByText(/initial setup required/i),
      ).toBeInTheDocument();
    });

    it("does not show the aggregate banner when at least one section is saved", async () => {
      // Only some sections unsaved -> per-section alerts cover it; no page banner.
      server.use(
        adminConfigGetHandler(createAdminConfig({ unsaved: ["leases"] })),
      );

      renderPage();

      await screen.findByRole("heading", { name: "Lease Policies" });
      expect(
        screen.queryByText(/initial setup required/i),
      ).not.toBeInTheDocument();
    });
  });

  describe("section footer", () => {
    it("renders the Save button and last-edited provenance together in the Container footer", async () => {
      server.use(adminConfigGetHandler(createAdminConfig()));

      renderPage();

      // Wait for the admin form to resolve.
      await screen.findAllByRole("button", { name: /save/i });

      const footer = findSectionContainer("Lease Policies")?.findFooter();
      expect(footer).not.toBeNull();
      // Save lives in the footer (giving it the divider above), alongside the
      // "Last edited by" provenance — not in the header or the body.
      expect(footer!.findButton()?.getElement()).toHaveTextContent(/save/i);
      expect(footer!.getElement()).toHaveTextContent(
        /Last edited by admin@example.com/i,
      );
    });
  });

  describe("Save enablement", () => {
    // The Cost Reporting section has a plain toggle and no save-confirmation
    // modal, so it exercises the pristine/dirty transitions directly.
    const costReportingToggle = () =>
      within(findSectionContainer("Cost Reporting")!.getElement()).getByRole(
        "checkbox",
      );

    // Cloudscape renders a disabledReason-disabled button with
    // aria-disabled="true" (kept focusable for the tooltip), not the native
    // `disabled` attribute — so assert on aria-disabled.
    const saveDisabled = (heading: string) =>
      findSaveButtonForSection(heading)?.getAttribute("aria-disabled") ===
      "true";

    it("disables Save for a saved section with no changes", async () => {
      server.use(adminConfigGetHandler(createAdminConfig()));

      renderPage();

      await waitFor(() =>
        expect(findSaveButtonForSection("Cost Reporting")).not.toBeNull(),
      );
      // Saved (lastSavedBy set) + pristine form => nothing to save.
      expect(saveDisabled("Cost Reporting")).toBe(true);
    });

    it("gives the disabled Save a 'No changes to save' reason", async () => {
      server.use(adminConfigGetHandler(createAdminConfig()));

      renderPage();

      // Cloudscape renders disabledReason as a tooltip that is only visible on
      // hover/focus, but the reason text is present in the section's footer DOM
      // (jsdom does not flush the hover visibility transition, so assert the
      // wiring rather than the revealed tooltip). Scope to the Cost Reporting
      // footer since every pristine section carries the same reason.
      await waitFor(() =>
        expect(findSaveButtonForSection("Cost Reporting")).not.toBeNull(),
      );
      const footer = findSectionContainer("Cost Reporting")!
        .findFooter()!
        .getElement();
      expect(footer.textContent).toMatch(/no changes to save/i);
    });

    it("enables Save once the section is edited", async () => {
      server.use(adminConfigGetHandler(createAdminConfig()));

      renderPage();

      await waitFor(() =>
        expect(findSaveButtonForSection("Cost Reporting")).not.toBeNull(),
      );
      await userEvent.click(costReportingToggle());

      expect(saveDisabled("Cost Reporting")).toBe(false);
    });

    it("keeps Save enabled for a never-saved section on a pristine form", async () => {
      // Finish-setup carve-out: a never-saved section must let the admin
      // persist the defaults without first editing anything.
      server.use(
        adminConfigGetHandler(
          createAdminConfig({ unsaved: ["costReporting"] }),
        ),
      );

      renderPage();

      await waitFor(() =>
        expect(findSaveButtonForSection("Cost Reporting")).not.toBeNull(),
      );
      expect(saveDisabled("Cost Reporting")).toBe(false);
    });

    it("re-disables Save after a successful save clears the dirty state", async () => {
      server.use(
        adminConfigGetHandler(createAdminConfig()),
        configurationSectionPutHandler(),
      );

      renderPage();

      await waitFor(() =>
        expect(findSaveButtonForSection("Cost Reporting")).not.toBeNull(),
      );
      await userEvent.click(costReportingToggle());
      expect(saveDisabled("Cost Reporting")).toBe(false);

      await clickSaveForSection("Cost Reporting");

      // methods.reset(values) on save success clears isDirty, so the now-saved
      // pristine form disables Save again.
      await waitFor(() => expect(saveDisabled("Cost Reporting")).toBe(true));
    });
  });

  describe("last-edited provenance", () => {
    it("shows the last-edited time as relative text via a popover trigger (absolute time on hover)", async () => {
      server.use(adminConfigGetHandler(createAdminConfig()));

      renderPage();

      // Names the editor (one per saved section).
      expect(
        (await screen.findAllByText(/Last edited by admin@example.com/i))
          .length,
      ).toBeGreaterThan(0);
      // Relative time is shown (e.g. "3 months ago") rather than the raw
      // absolute DATETIME_MED string. Build the absolute string from luxon (same
      // formatting the component uses) so this is locale-agnostic; it must NOT
      // be visible until the popover is opened.
      const absolute = DateTime.fromISO(
        "2026-04-04T12:30:00.000Z",
      ).toLocaleString(DateTime.DATETIME_MED);
      const relativeText = screen.getAllByText(/ago$/i);
      expect(relativeText.length).toBeGreaterThan(0);
      expect(screen.queryByText(absolute)).not.toBeInTheDocument();

      // The relative time is the trigger of a Cloudscape Popover: a <button>
      // with aria-haspopup="dialog" that reveals the exact timestamp on
      // hover/click. (The popover's revealed content renders into a portal that
      // jsdom does not flush on click, so assert the trigger wiring rather than
      // the opened panel — the reveal itself is covered by manual QA.)
      const trigger = relativeText[0].closest("button");
      expect(trigger).not.toBeNull();
      expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    });
  });

  // Per-section save/conflict/validation flows driven end-to-end through the
  // assembled page (not just the SectionForm shell), so the page's wiring of
  // each section's form + the post-save query invalidation are exercised too.
  describe("per-section flows (through the page)", () => {
    // A saved Maintenance section is pristine, so Save is disabled until the
    // toggle is changed. Toggling `enabled` (default true -> false) is a
    // sensitive change, so it also opens the confirmation modal; confirm through
    // it to reach the actual PUT. Use for the 409/400 flows below.
    const editAndConfirmMaintenanceSave = async () => {
      const maintenance = within(
        findSectionContainer("Maintenance Mode")!.getElement(),
      );
      await userEvent.click(maintenance.getByRole("checkbox"));
      await userEvent.click(maintenance.getByRole("button", { name: /save/i }));
      // Default enabled: true -> toggled to false -> "Turn off" confirmation.
      await userEvent.click(
        await screen.findByRole("button", {
          name: "Turn off maintenance mode",
        }),
      );
    };

    it("save success: persists the section and clears its finish-setup alert", async () => {
      // Maintenance starts unsaved, so its finish-setup alert is shown. A
      // stateful GET flips it to saved once the PUT lands, so the refetch
      // triggered by the save's cache invalidation drops the alert. (A static
      // GET would keep returning "unsaved" and the alert would never clear.)
      let maintenanceSaved = false;
      server.use(
        http.get(`${apiUrl}/configurations`, () =>
          HttpResponse.json({
            status: "success",
            data: createAdminConfig({
              unsaved: maintenanceSaved ? [] : ["maintenance"],
            }),
          }),
        ),
        http.put(`${apiUrl}/configurations/:section`, async ({ request }) => {
          maintenanceSaved = true;
          const body = (await request.json()) as Record<string, unknown>;
          const { lastSavedBy: _l, meta: _m, ...fields } = body;
          void _l;
          void _m;
          return HttpResponse.json({
            status: "success",
            data: {
              ...fields,
              lastSavedBy: "admin@example.com",
              meta: {
                schemaVersion: 1,
                createdTime: "2026-04-04T10:00:00.000Z",
                lastEditTime: "2026-04-04T12:30:00.000Z",
              },
            },
          });
        }),
      );

      renderPage();

      // Wait for the section's role to resolve to Admin (its Save button only
      // renders once SectionForm swaps the loader for the editable form) — the
      // finish-setup alert lives in that editable branch.
      await waitFor(() =>
        expect(findSaveButtonForSection("Maintenance Mode")).not.toBeNull(),
      );
      // The unsaved maintenance section shows its finish-setup alert. Maintenance
      // renders its own fail-closed lockout warning (and suppresses SectionForm's
      // generic "Using default values" alert), so assert on that warning. Scope to
      // the Maintenance container so this asserts the alert is on THAT section
      // (and so the helper's section targeting is actually exercised).
      const maintenance = within(
        findSectionContainer("Maintenance Mode")!.getElement(),
      );
      expect(
        await maintenance.findByText(
          /new deployments start with maintenance mode on/i,
        ),
      ).toBeInTheDocument();

      await clickSaveForSection("Maintenance Mode");

      // After the save, the invalidated query refetches the now-saved config
      // and the Maintenance section's finish-setup alert is gone.
      await waitFor(() =>
        expect(
          within(
            findSectionContainer("Maintenance Mode")!.getElement(),
          ).queryByText(/new deployments start with maintenance mode on/i),
        ).not.toBeInTheDocument(),
      );
    });

    it("conflict (409): a stale save surfaces the section's conflict alert", async () => {
      server.use(
        adminConfigGetHandler(createAdminConfig()),
        configurationSectionConflictHandler(),
      );

      renderPage();

      await waitFor(() =>
        expect(findSaveButtonForSection("Maintenance Mode")).not.toBeNull(),
      );
      await editAndConfirmMaintenanceSave();

      // The conflict alert must surface on the Maintenance section itself.
      const maintenance = within(
        findSectionContainer("Maintenance Mode")!.getElement(),
      );
      expect(
        await maintenance.findByText(/modified by another administrator/i),
      ).toBeInTheDocument();
    });

    it("validation (400): server field errors render inline on the section", async () => {
      server.use(
        adminConfigGetHandler(createAdminConfig()),
        configurationSectionValidationHandler([
          { field: "enabled", message: "Maintenance mode must be a boolean." },
        ]),
      );

      renderPage();

      await waitFor(() =>
        expect(findSaveButtonForSection("Maintenance Mode")).not.toBeNull(),
      );
      await editAndConfirmMaintenanceSave();

      // "enabled" is a registered field, so the error must render INLINE in the
      // field's FormField error slot — not in the form-level root alert. Assert
      // on the FormField's findError() specifically so this distinction is
      // actually verified (a plain text match would also pass for the root
      // alert, which carries the identical message).
      await waitFor(() => {
        const formField = findSectionContainer("Maintenance Mode")!
          .findContent()
          .findFormField();
        expect(formField?.findError()?.getElement()).toHaveTextContent(
          /maintenance mode must be a boolean/i,
        );
      });
    });
  });
});
