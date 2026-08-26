// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CostReportingForm } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/CostReportingForm";
import { CONFIG_CONSTRAINTS } from "@amzn/innovation-sandbox-frontend/domains/settings/validation";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
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

const baseData = {
  costReportGroups: ["team-a"],
  requireCostReportGroup: false,
  lastSavedBy: "a@b.com",
};

describe("CostReportingForm", () => {
  it("renders existing groups as tokens and adds a new one", async () => {
    render(<CostReportingForm data={baseData} />, {
      wrapper: createQueryClientWrapper(),
    });

    // Wait for the admin (editable) form to render; its input placeholder is
    // unique to the admin view, so this also confirms the existing token shows.
    const input = await screen.findByPlaceholderText(
      /enter a cost report group/i,
    );
    expect(screen.getByText("team-a")).toBeInTheDocument();
    // The field shows a live "N / max groups" count (not a static "Up to N").
    expect(
      screen.getByText(
        `1 / ${CONFIG_CONSTRAINTS.MAX_COST_REPORT_GROUPS} groups`,
      ),
    ).toBeInTheDocument();

    await userEvent.type(input, "team-b{enter}");

    expect(await screen.findByText("team-b")).toBeInTheDocument();
    expect(
      screen.getByText(
        `2 / ${CONFIG_CONSTRAINTS.MAX_COST_REPORT_GROUPS} groups`,
      ),
    ).toBeInTheDocument();
  });

  it("adds a group on Enter without submitting the form (only Save saves)", async () => {
    // Count PUTs so we can prove Enter does NOT save. Without preventDefault in
    // the draft Input's onKeyDown, pressing Enter implicitly submits the parent
    // SectionForm <form>, firing a spurious PUT mid-edit; this asserts it does
    // not, then that the explicit Save button still does.
    let putCount = 0;
    server.use(
      http.put(`${getConfig().ApiUrl}/configurations/:section`, async () => {
        putCount += 1;
        return HttpResponse.json({
          status: "success",
          data: {
            costReportGroups: ["team-a"],
            requireCostReportGroup: false,
            lastSavedBy: "a@b.com",
            meta: {
              schemaVersion: 1,
              createdTime: "2026-01-01T00:00:00.000Z",
              lastEditTime: "T1",
            },
          },
        });
      }),
    );

    render(<CostReportingForm data={baseData} />, {
      wrapper: createQueryClientWrapper(),
    });

    const input = await screen.findByPlaceholderText(
      /enter a cost report group/i,
    );
    await userEvent.type(input, "team-b{enter}");

    // The token is added locally (the Enter handler ran)...
    expect(await screen.findByText("team-b")).toBeInTheDocument();
    // ...but Enter must NOT have triggered a save. Give any erroneous implicit
    // submit time to fire, then assert no PUT was made.
    await new Promise((r) => setTimeout(r, 50));
    expect(putCount).toBe(0);

    // The explicit Save button DOES save — via the change-confirmation modal
    // (adding a group changes the list), so confirm through it.
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: /save changes/i }),
    );
    await waitFor(() => expect(putCount).toBe(1));
  });

  it("removes a group when its token is dismissed", async () => {
    render(
      <CostReportingForm
        data={{ ...baseData, costReportGroups: ["team-a", "team-b"] }}
      />,
      {
        wrapper: createQueryClientWrapper(),
      },
    );

    // Wait for the admin (editable) form before locating the dismiss buttons.
    await screen.findByPlaceholderText(/enter a cost report group/i);
    expect(screen.getByText("team-a")).toBeInTheDocument();
    // Dismiss the first token.
    const dismissButtons = screen.getAllByRole("button", { name: /remove/i });
    await userEvent.click(dismissButtons[0]);

    expect(screen.queryByText("team-a")).not.toBeInTheDocument();
  });

  it("keeps the typed draft when the entry is a duplicate (no silent discard)", async () => {
    render(<CostReportingForm data={baseData} />, {
      wrapper: createQueryClientWrapper(),
    });

    // baseData already contains "team-a". Re-entering it must NOT add a second
    // token and, critically, must leave the typed text in the input rather than
    // clearing it with no feedback.
    const input = await screen.findByPlaceholderText(
      /enter a cost report group/i,
    );
    await userEvent.type(input, "team-a{enter}");

    expect(screen.getAllByText("team-a")).toHaveLength(1);
    expect(input).toHaveValue("team-a");
  });

  it("rejects a group longer than the schema's max length at input time", async () => {
    render(<CostReportingForm data={baseData} />, {
      wrapper: createQueryClientWrapper(),
    });

    const input = await screen.findByPlaceholderText(
      /enter a cost report group/i,
    );
    const tooLong = "x".repeat(
      CONFIG_CONSTRAINTS.MAX_COST_REPORT_GROUP_LENGTH + 1,
    );
    await userEvent.type(input, `${tooLong}{enter}`);

    // The over-length group is not added and an inline limit message appears.
    expect(screen.queryByText(tooLong)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        new RegExp(
          `${CONFIG_CONSTRAINTS.MAX_COST_REPORT_GROUP_LENGTH} characters or fewer`,
          "i",
        ),
      ),
    ).toBeInTheDocument();
  });

  it("displays the group tokens sorted alphabetically regardless of entry order", async () => {
    // Saved out of order, then a new group added — the tokens must display a, b,
    // c, d, not the entry/stored order. Scoped to the TokenGroup so the assertion
    // is about the rendered token order.
    const { container } = render(
      <CostReportingForm
        data={{ ...baseData, costReportGroups: ["team-c", "team-a", "team-b"] }}
      />,
      { wrapper: createQueryClientWrapper() },
    );

    const input = await screen.findByPlaceholderText(
      /enter a cost report group/i,
    );
    await userEvent.type(input, "team-d{enter}");

    // The dismiss buttons are labelled "Remove <group>" in token display order.
    await waitFor(() =>
      expect(
        within(container).getAllByRole("button", { name: /remove team-/i }),
      ).toHaveLength(4),
    );
    const tokenOrder = within(container)
      .getAllByRole("button", { name: /remove team-/i })
      .map((btn) => btn.getAttribute("aria-label"));
    expect(tokenOrder).toEqual([
      "Remove team-a",
      "Remove team-b",
      "Remove team-c",
      "Remove team-d",
    ]);
  });

  describe("save confirmation diff modal", () => {
    // Mock the PUT so a confirmed save resolves; capture bodies to assert what
    // was persisted.
    const mockPut = () => {
      const putBodies: Array<Record<string, unknown>> = [];
      server.use(
        http.put(
          `${getConfig().ApiUrl}/configurations/:section`,
          async ({ request }) => {
            const body = (await request.json()) as Record<string, unknown>;
            putBodies.push(body);
            const { lastSavedBy: _l, meta: _m, ...fields } = body;
            void _l;
            void _m;
            return HttpResponse.json({
              status: "success",
              data: {
                ...fields,
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

    const modal = () => screen.queryByRole("dialog");

    it("shows a before/after diff and requires confirmation before saving", async () => {
      const putBodies = mockPut();
      render(
        <CostReportingForm
          data={{ ...baseData, costReportGroups: ["team-a", "team-b"] }}
        />,
        { wrapper: createQueryClientWrapper() },
      );

      const input = await screen.findByPlaceholderText(
        /enter a cost report group/i,
      );
      await userEvent.click(
        screen.getByRole("button", { name: /remove team-a/i }),
      );
      await userEvent.type(input, "team-c{enter}");

      // Clicking Save opens the confirmation modal; nothing is persisted yet.
      await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent(/save cost report group changes\?/i);
      expect(within(dialog).getByText(/adding/i)).toBeInTheDocument();
      expect(within(dialog).getByText("team-c")).toBeInTheDocument();
      expect(within(dialog).getByText(/removing/i)).toBeInTheDocument();
      expect(within(dialog).getByText("team-a")).toBeInTheDocument();
      // One group each side -> singular consequence copy.
      expect(
        within(dialog).getByText(
          "This group will become available for lease templates.",
        ),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByText(
          "This group will no longer be available for new lease templates.",
        ),
      ).toBeInTheDocument();
      expect(putBodies).toHaveLength(0);

      // Confirming saves the edited list.
      await userEvent.click(
        within(dialog).getByRole("button", { name: /save changes/i }),
      );
      await waitFor(() => expect(putBodies).toHaveLength(1));
      expect(putBodies[0].costReportGroups).toEqual(["team-b", "team-c"]);
    });

    it("separates added and removed groups into their own labelled sections", async () => {
      mockPut();
      render(
        <CostReportingForm
          data={{ ...baseData, costReportGroups: ["team-a", "team-b"] }}
        />,
        { wrapper: createQueryClientWrapper() },
      );

      const input = await screen.findByPlaceholderText(
        /enter a cost report group/i,
      );
      await userEvent.click(
        screen.getByRole("button", { name: /remove team-a/i }),
      );
      await userEvent.type(input, "team-c{enter}");
      await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
      const dialog = await screen.findByRole("dialog");

      // The added group appears only in the "adding" section and the removed one
      // only in the "removing" section (each is a separate labelled region; the
      // green/red chip color is a visual reinforcement of these labels). The
      // per-side chips carry color for sighted users, but the labels/sections
      // are the assertable, non-color-only contract.
      const added = createWrapper(dialog).find('[data-testid="diff-added"]')!;
      const removed = createWrapper(dialog).find(
        '[data-testid="diff-removed"]',
      )!;
      expect(added.getElement()).toHaveTextContent("team-c");
      expect(added.getElement()).not.toHaveTextContent("team-a");
      expect(removed.getElement()).toHaveTextContent("team-a");
      expect(removed.getElement()).not.toHaveTextContent("team-c");
    });

    it("uses the plural consequence copy when more than one group changes", async () => {
      // The chip capping / show-more mechanics live in DiffChipList's own test;
      // here we only assert the form supplies the correct plural copy (the
      // singular form is covered by the diff+confirm test above).
      mockPut();
      render(
        <CostReportingForm
          data={{ ...baseData, costReportGroups: ["team-a"] }}
        />,
        { wrapper: createQueryClientWrapper() },
      );

      const input = await screen.findByPlaceholderText(
        /enter a cost report group/i,
      );
      await userEvent.type(input, "team-b{enter}");
      await userEvent.type(input, "team-c{enter}");
      await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
      const dialog = await screen.findByRole("dialog");

      // Two groups added -> plural "Adding" copy.
      expect(
        within(dialog).getByText(
          "These groups will become available for lease templates.",
        ),
      ).toBeInTheDocument();
    });

    it("omits the opposite section entirely for a pure add or pure removal", async () => {
      mockPut();
      // Pure add: the empty "Removing" side must be omitted, not shown as "Removing (0)".
      const { unmount } = render(
        <CostReportingForm
          data={{ ...baseData, costReportGroups: ["team-a"] }}
        />,
        { wrapper: createQueryClientWrapper() },
      );

      const input = await screen.findByPlaceholderText(
        /enter a cost report group/i,
      );
      await userEvent.type(input, "team-b{enter}");
      await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
      const addDialog = await screen.findByRole("dialog");

      expect(within(addDialog).getByText(/adding/i)).toBeInTheDocument();
      expect(
        within(addDialog).queryByText(/removing/i),
      ).not.toBeInTheDocument();

      unmount();

      // Pure removal: the empty "Adding" side must be omitted.
      render(
        <CostReportingForm
          data={{ ...baseData, costReportGroups: ["team-a", "team-b"] }}
        />,
        { wrapper: createQueryClientWrapper() },
      );

      await screen.findByPlaceholderText(/enter a cost report group/i);
      await userEvent.click(
        screen.getByRole("button", { name: /remove team-a/i }),
      );
      await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
      const removeDialog = await screen.findByRole("dialog");

      expect(within(removeDialog).getByText(/removing/i)).toBeInTheDocument();
      expect(
        within(removeDialog).queryByText(/adding/i),
      ).not.toBeInTheDocument();
    });

    it("cancel closes the modal without saving and preserves the edit", async () => {
      const putBodies = mockPut();
      render(
        <CostReportingForm
          data={{ ...baseData, costReportGroups: ["team-a"] }}
        />,
        { wrapper: createQueryClientWrapper() },
      );

      const input = await screen.findByPlaceholderText(
        /enter a cost report group/i,
      );
      await userEvent.type(input, "team-new{enter}");
      await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
      await screen.findByRole("dialog");

      await userEvent.click(screen.getByRole("button", { name: /cancel/i }));

      await waitFor(() => expect(modal()).not.toBeInTheDocument());
      expect(putBodies).toHaveLength(0);
      // The edit survives so the admin can still save after re-confirming.
      expect(screen.getByText("team-new")).toBeInTheDocument();
    });

    it("saves without a modal when only the toggle changed (groups unchanged)", async () => {
      const putBodies = mockPut();
      render(
        <CostReportingForm
          data={{ ...baseData, costReportGroups: ["team-a"] }}
        />,
        { wrapper: createQueryClientWrapper() },
      );

      // Flip the toggle only; the group list is untouched.
      const toggle = await screen.findByRole("checkbox");
      await userEvent.click(toggle);
      await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

      // No confirmation modal; the save goes straight through.
      await waitFor(() => expect(putBodies).toHaveLength(1));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("renders a read-only summary for a manager (no input)", async () => {
    getCurrentUser.mockResolvedValue(managerUser);

    render(<CostReportingForm data={baseData} />, {
      wrapper: createQueryClientWrapper(),
    });

    // Anchor on the read-only KeyValuePairs label "Require cost report group".
    // The manager render shows only the read-only view (no editable toggle or
    // input), so this waits for the resolved manager render. The placeholder
    // assertion below confirms the editable form did not render.
    expect(
      await screen.findByText("Require cost report group"),
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/enter a cost report group/i),
    ).not.toBeInTheDocument();
  });

  it("renders the read-only boolean as human-readable status, not raw true/false", async () => {
    getCurrentUser.mockResolvedValue(managerUser);

    render(<CostReportingForm data={baseData} />, {
      wrapper: createQueryClientWrapper(),
    });

    await screen.findByText("Require cost report group");
    // requireCostReportGroup is false -> shows "Disabled", never the raw "false".
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.queryByText("false")).not.toBeInTheDocument();
  });

  it("renders each read-only cost report group as its own Badge, sorted", async () => {
    getCurrentUser.mockResolvedValue(managerUser);

    const { container } = render(
      <CostReportingForm
        // Stored out of order so this asserts sorting, not merely "not reversed":
        // an identity (no-sort) render would show [team-c, team-a, team-b].
        data={{ ...baseData, costReportGroups: ["team-c", "team-a", "team-b"] }}
      />,
      { wrapper: createQueryClientWrapper() },
    );

    await screen.findByText("Cost report groups");
    // Each group renders in its own Cloudscape Badge (a read-only chip), not as
    // one comma-joined plain-text string, matching the tokenized editable view.
    // Use the Cloudscape test-utils Badge finder rather than matching internal
    // (hashed) CSS class names, which are not a stable contract. Sorted to match
    // the editable field's alphabetical token order. Scope to this render's
    // container (not the whole document) so a stray badge leaked from another
    // test's teardown can't make this assertion flaky.
    const badges = createWrapper(container)
      .findAllBadges()
      .map((badge) => badge.getElement().textContent);
    expect(badges).toEqual(["team-a", "team-b", "team-c"]);
  });

  it("shows a fallback when there are no read-only cost report groups", async () => {
    getCurrentUser.mockResolvedValue(managerUser);

    render(<CostReportingForm data={{ ...baseData, costReportGroups: [] }} />, {
      wrapper: createQueryClientWrapper(),
    });

    await screen.findByText("Cost report groups");
    expect(screen.getByText("(none)")).toBeInTheDocument();
  });
});
