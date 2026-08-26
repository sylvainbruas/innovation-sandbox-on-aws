// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Lease } from "@amzn/innovation-sandbox-commons/data/lease/lease";
import { AssignmentsTab } from "@amzn/innovation-sandbox-frontend/domains/leases/components/AssignmentsTab";
import { LeaseAssignment } from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { createActiveLease } from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { createQueryClientWrapper } from "@amzn/innovation-sandbox-frontend/setupTests";

vi.mock("@amzn/innovation-sandbox-frontend/components/Toast", () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
}));

const TYPEAHEAD_FIXTURE = [
  {
    principalId: "carol-id",
    principalType: "USER" as const,
    displayName: "Carol Davis",
    email: "carol@example.com",
  },
  {
    principalId: "platform-id",
    principalType: "GROUP" as const,
    displayName: "Platform",
  },
  // Same id as `userAssignment` — supports the re-add-cancels-removal test.
  {
    principalId: "user-1",
    principalType: "USER" as const,
    displayName: "Alice Smith",
    email: "alice@example.com",
  },
];
vi.mock(
  "@amzn/innovation-sandbox-frontend/domains/leases/components/PrincipalTypeahead",
  () => ({
    PrincipalTypeahead: ({
      onSelect,
      shouldExclude = () => false,
    }: {
      onSelect: (p: (typeof TYPEAHEAD_FIXTURE)[number]) => void;
      shouldExclude?: (p: (typeof TYPEAHEAD_FIXTURE)[number]) => boolean;
    }) => (
      <div data-testid="typeahead-stub">
        {TYPEAHEAD_FIXTURE.filter((p) => !shouldExclude(p)).map((p) => (
          <button key={p.principalId} type="button" onClick={() => onSelect(p)}>
            Add {p.principalId}
          </button>
        ))}
      </div>
    ),
  }),
);

vi.mock(
  "@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService",
  async () => {
    const [{ authenticated }, { buildCognitoAuthServiceMock }] =
      await Promise.all([
        import("@amzn/innovation-sandbox-frontend-test/utils/cognitoFixtures"),
        import("@amzn/innovation-sandbox-frontend-test/utils/cognitoServiceMock"),
      ]);
    return {
      CognitoAuthService: buildCognitoAuthServiceMock({
        getCurrentUser: vi.fn().mockResolvedValue(authenticated()),
      }),
    };
  },
);

const lease: Lease = createActiveLease({
  uuid: "lease-uuid-1",
  userEmail: "owner@example.com",
  allowOwnerToShareLease: true,
});

// The API returns the reconciled view: each row already carries its
// syncStatus and isOwner, so tests set the status they want directly instead of
// arranging a desired-vs-records divergence on two endpoints.
const userAssignment: LeaseAssignment = {
  principalId: "user-1",
  principalType: "USER",
  displayName: "Alice Smith",
  assigneeEmail: "alice@example.com",
  addedBy: "owner-test@example.com",
  addedDate: "2026-01-01T00:00:00.000Z",
  isOwner: false,
  isDesired: true,
  syncStatus: "active",
};

const groupAssignment: LeaseAssignment = {
  principalId: "group-1",
  principalType: "GROUP",
  displayName: "Engineering",
  addedBy: "owner@example.com",
  addedDate: "2026-01-02T00:00:00.000Z",
  isOwner: false,
  isDesired: true,
  syncStatus: "active",
};

const ownerAssignment: LeaseAssignment = {
  principalId: "owner-principal-id",
  principalType: "USER",
  displayName: "Owner",
  assigneeEmail: "owner@example.com",
  addedBy: "system",
  addedDate: "2026-01-01T00:00:00.000Z",
  isOwner: true,
  isDesired: true,
  syncStatus: "active",
};

/** A row for a principal that is desired but has no access record yet. */
const desiredOnly = (
  overrides: Partial<LeaseAssignment> & { principalId: string },
): LeaseAssignment => ({
  principalType: "USER",
  displayName: "Carol Davis",
  assigneeEmail: "carol@example.com",
  isOwner: false,
  isDesired: true,
  syncStatus: "grantFailed",
  ...overrides,
});

/** A record that lingers after a failed revoke: present, but no longer desired. */
const lingeringRecord = (
  overrides: Partial<LeaseAssignment> & { principalId: string },
): LeaseAssignment => ({
  principalType: "USER",
  displayName: "Dave Lingering",
  assigneeEmail: "dave@example.com",
  addedBy: "admin@example.com",
  addedDate: "2026-01-01T00:00:00.000Z",
  isOwner: false,
  isDesired: false,
  syncStatus: "revokeFailed",
  ...overrides,
});

const LEASE_ROUTE_ID = "lease-route-id-base64";

function stubGetAssignments(
  items: LeaseAssignment[],
  operationInProgress?: "FREEZE" | "UNFREEZE" | "TERMINATE" | "UPDATE",
) {
  server.use(
    http.get(`${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`, () =>
      HttpResponse.json({
        status: "success",
        data: { assignments: items, operationInProgress },
      }),
    ),
  );
}

function stubGetLeaseById(
  overrides: Partial<{
    desiredAssignments:
      | {
          principalId: string;
          principalType: "USER" | "GROUP";
          displayName?: string;
          email?: string;
        }[]
      | undefined;
    resourceLock: {
      ownerId: string;
      acquiredAt: string;
      expiresAt: string;
      // The intent drives the direction rows are labelled with (a missing
      // record is a pending grant during UPDATE/UNFREEZE but already revoked
      // during FREEZE/TERMINATE).
      meta?: {
        intent: "FREEZE" | "UNFREEZE" | "TERMINATE" | "UPDATE" | "PUBLISH";
      };
    } | null;
  }> = {},
) {
  const desiredAssignments =
    "desiredAssignments" in overrides
      ? overrides.desiredAssignments
      : [
          {
            principalId: "owner-principal-id",
            principalType: "USER" as const,
            displayName: "Owner",
            email: "owner@example.com",
          },
          {
            principalId: "user-1",
            principalType: "USER" as const,
            displayName: "Alice Smith",
            email: "alice@example.com",
          },
          {
            principalId: "group-1",
            principalType: "GROUP" as const,
            displayName: "Engineering",
          },
        ];
  server.use(
    http.get(`${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}`, () =>
      HttpResponse.json({
        status: "success",
        data: {
          ...lease,
          desiredAssignments,
          resourceLock: overrides.resourceLock ?? null,
        },
      }),
    ),
  );
}

function renderTab(
  props: Partial<React.ComponentProps<typeof AssignmentsTab>> = {},
) {
  const Wrapper = createQueryClientWrapper();
  return render(
    <Wrapper>
      <AssignmentsTab
        lease={lease}
        leaseRouteId={LEASE_ROUTE_ID}
        leaseSharingEnabled={true}
        enablePrincipalSearch={true}
        isElevated={false}
        isOwner={true}
        {...props}
      />
    </Wrapper>,
  );
}

describe("AssignmentsTab", () => {
  beforeEach(() => {
    stubGetLeaseById();
  });

  it("renders existing assignments from the API", async () => {
    stubGetAssignments([userAssignment, groupAssignment]);
    renderTab();

    expect(
      (await screen.findAllByText("alice@example.com")).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Engineering")).toBeInTheDocument();
  });

  it("always shows the owner row even when no other assignments exist", async () => {
    stubGetAssignments([ownerAssignment]);
    renderTab();

    // The owner row is always present from the assignment record.
    const ownerCells = await screen.findAllByText("owner@example.com");
    expect(ownerCells.length).toBeGreaterThan(0);
  });

  it("hides add controls and Save button when the viewer cannot manage", async () => {
    stubGetAssignments([userAssignment]);
    // A non-owner, non-elevated viewer (e.g., another shared user) sees
    // read-only.
    renderTab({ isOwner: false, isElevated: false });

    expect(
      (await screen.findAllByText("alice@example.com")).length,
    ).toBeGreaterThan(0);
    // The "Share access" Container holds the always-visible typeahead and
    // is rendered only when the viewer can manage assignments.
    expect(screen.queryByText("Share access")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save changes" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove" }),
    ).not.toBeInTheDocument();
  });

  it("hides add controls for owner when allowOwnerToShareLease is false", async () => {
    stubGetAssignments([userAssignment]);
    const restrictedLease: Lease = { ...lease, allowOwnerToShareLease: false };
    renderTab({ lease: restrictedLease, isOwner: true });

    expect(
      (await screen.findAllByText("alice@example.com")).length,
    ).toBeGreaterThan(0);
    // The "Share access" Container holds the always-visible typeahead and
    // is rendered only when the viewer can manage assignments.
    expect(screen.queryByText("Share access")).not.toBeInTheDocument();
  });

  it("shows the global-flag-off banner only for elevated viewers", async () => {
    stubGetAssignments([userAssignment]);
    renderTab({ leaseSharingEnabled: false, isElevated: true });

    expect(
      await screen.findByText(/Lease sharing is disabled globally/i),
    ).toBeInTheDocument();
  });

  it("stages a removal and submits the diff on Save", async () => {
    stubGetAssignments([ownerAssignment, userAssignment, groupAssignment]);

    let putBody: unknown;
    server.use(
      http.put(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        async ({ request }) => {
          putBody = await request.json();
          return HttpResponse.json(
            { status: "success", data: { desiredCount: 1 } },
            { status: 202 },
          );
        },
      ),
    );

    renderTab();
    const user = userEvent.setup();

    // Wait for the rows to render.
    expect(
      (await screen.findAllByText("alice@example.com")).length,
    ).toBeGreaterThan(0);

    // Click Remove on alice's row.
    // Scope to alice's row via the unique addedBy cell to avoid the
    // duplicate-email match in the Name + Email columns.
    const aliceRow = screen.getByText("owner-test@example.com").closest("tr")!;
    await user.click(within(aliceRow).getByRole("button", { name: "Remove" }));

    // The "Pending remove" badge should appear and Save should be enabled.
    expect(screen.getByText("Pending remove")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).not.toBeDisabled();

    await user.click(save);

    await waitFor(() => expect(putBody).toBeDefined());
    // Only the group should remain in the desired list — alice was removed.
    // Owner is implicit (auto-injected server-side) and excluded from the PUT body.
    expect(putBody).toEqual({
      assignments: [{ principalId: "group-1", principalType: "GROUP" }],
    });
  });

  it("disables Save when there are no staged changes", async () => {
    stubGetAssignments([userAssignment]);
    renderTab();

    expect(
      (await screen.findAllByText("alice@example.com")).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("discards staged changes when the user clicks Discard", async () => {
    stubGetAssignments([userAssignment, groupAssignment]);
    renderTab();
    const user = userEvent.setup();

    expect(
      (await screen.findAllByText("alice@example.com")).length,
    ).toBeGreaterThan(0);

    // Scope to alice's row via the unique addedBy cell to avoid the
    // duplicate-email match in the Name + Email columns.
    const aliceRow = screen.getByText("owner-test@example.com").closest("tr")!;
    await user.click(within(aliceRow).getByRole("button", { name: "Remove" }));
    expect(screen.getByText("Pending remove")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByText("Pending remove")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("hides Remove and shows the Owner badge on the lease owner's row", async () => {
    const ownerAssignment: LeaseAssignment = {
      principalId: "owner-id",
      principalType: "USER",
      displayName: "Lease Owner",
      assigneeEmail: lease.userEmail,
      // addedBy is distinct so the row can be located unambiguously. Ownership
      // is now reported by the API rather than inferred from the email.
      addedBy: "admin@example.com",
      addedDate: "2026-01-01T00:00:00.000Z",
      isOwner: true,
      isDesired: true,
      syncStatus: "active",
    };
    stubGetAssignments([ownerAssignment, userAssignment]);
    renderTab();

    // Wait for both rows to load.
    expect(
      (await screen.findAllByText("alice@example.com")).length,
    ).toBeGreaterThan(0);

    // Owner row located via the unique addedBy cell.
    const ownerRow = screen.getByText("admin@example.com").closest("tr")!;
    expect(within(ownerRow).getByText("Owner")).toBeInTheDocument();
    expect(
      within(ownerRow).queryByRole("button", { name: "Remove" }),
    ).not.toBeInTheDocument();

    // Non-owner row still has Remove (sanity check that the suppression is
    // owner-specific, not blanket).
    const aliceRow = screen.getByText("owner-test@example.com").closest("tr")!;
    expect(
      within(aliceRow).getByRole("button", { name: "Remove" }),
    ).toBeInTheDocument();
  });

  it("stages a typeahead pick and submits it in the PUT body", async () => {
    stubGetAssignments([ownerAssignment, userAssignment]);
    stubGetLeaseById({
      desiredAssignments: [
        {
          principalId: "owner-principal-id",
          principalType: "USER",
          displayName: "Owner",
          email: "owner@example.com",
        },
        {
          principalId: "user-1",
          principalType: "USER",
          displayName: "Alice Smith",
          email: "alice@example.com",
        },
      ],
    });

    let putBody: unknown;
    server.use(
      http.put(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        async ({ request }) => {
          putBody = await request.json();
          return HttpResponse.json(
            { status: "success", data: { desiredCount: 2 } },
            { status: 202 },
          );
        },
      ),
    );

    renderTab();
    const user = userEvent.setup();

    // Wait for the existing row before driving the typeahead stub.
    expect(
      (await screen.findAllByText("alice@example.com")).length,
    ).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Add carol-id" }));
    expect(screen.getByText("Pending add")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(putBody).toBeDefined());
    // Owner is implicit (auto-injected server-side) and excluded from the PUT body.
    expect(putBody).toEqual({
      assignments: [
        { principalId: "user-1", principalType: "USER" },
        { principalId: "carol-id", principalType: "USER" },
      ],
    });
  });

  it("cancels a staged removal when the same principal is re-added", async () => {
    stubGetAssignments([userAssignment]);
    renderTab();
    const user = userEvent.setup();

    expect(
      (await screen.findAllByText("alice@example.com")).length,
    ).toBeGreaterThan(0);

    // Stage alice for removal — `excludePrincipalIds` drops her from the
    // typeahead while in "current" state but lets her back in once she's
    // staged for removal, so the typeahead button reappears.
    const aliceRow = screen.getByText("owner-test@example.com").closest("tr")!;
    await user.click(within(aliceRow).getByRole("button", { name: "Remove" }));
    expect(screen.getByText("Pending remove")).toBeInTheDocument();

    // Re-add alice through the typeahead — should clear the staged removal,
    // not create a duplicate row.
    await user.click(screen.getByRole("button", { name: "Add user-1" }));
    expect(screen.queryByText("Pending remove")).not.toBeInTheDocument();
    expect(screen.queryByText("Pending add")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("renders the transitional statuses reported by the API", async () => {
    stubGetAssignments(
      [
        { ...userAssignment, syncStatus: "revoking" },
        groupAssignment,
        desiredOnly({ principalId: "carol-id", syncStatus: "granting" }),
      ],
      "UPDATE",
    );
    renderTab();

    const aliceRow = (
      await screen.findByText("owner-test@example.com")
    ).closest("tr")!;
    expect(within(aliceRow).getByText("Revoking")).toBeInTheDocument();

    const groupRow = screen.getByText("Engineering").closest("tr")!;
    expect(within(groupRow).getByText("Active")).toBeInTheDocument();

    expect(await screen.findByText("Granting")).toBeInTheDocument();
  });

  it("renders the failure statuses reported by the API", async () => {
    // The API decides these; the client only projects them. It no longer infers
    // failure from a divergence between two independently-fetched endpoints.
    stubGetAssignments([
      { ...userAssignment, syncStatus: "revokeFailed" },
      desiredOnly({ principalId: "carol-id", syncStatus: "grantFailed" }),
    ]);
    renderTab();

    const aliceRow = (
      await screen.findByText("owner-test@example.com")
    ).closest("tr")!;
    expect(within(aliceRow).getByText("Revoke failed")).toBeInTheDocument();
    expect(await screen.findByText("Grant failed")).toBeInTheDocument();
  });

  describe("frozen lease", () => {
    const frozenLease: Lease = { ...lease, status: "Frozen" };

    it("shows suspended principals without calling them failures", async () => {
      // A freeze revokes the records but retains the desired set, so the API
      // reports this steady state as suspended rather than a failed grant.
      stubGetAssignments([
        desiredOnly({ principalId: "carol-id", syncStatus: "suspended" }),
      ]);
      renderTab({ lease: frozenLease });

      expect(await screen.findByText("Access suspended")).toBeInTheDocument();
      expect(screen.queryByText("Grant failed")).not.toBeInTheDocument();
    });

    it("renders read-only and explains why, since the API rejects edits", async () => {
      // putLeaseAssignmentsHandler returns 409 "Lease is not in an active
      // status", so the editing controls must be gated on status, not just role.
      stubGetAssignments([userAssignment]);
      renderTab({ lease: frozenLease, isElevated: true });

      expect(
        await screen.findByText(/This lease is frozen, so account access/),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Save changes" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Remove" }),
      ).not.toBeInTheDocument();
    });

    it("names a freeze in progress and shows no pending grants", async () => {
      stubGetAssignments(
        [
          { ...userAssignment, syncStatus: "revoking" },
          desiredOnly({ principalId: "carol-id", syncStatus: "suspended" }),
        ],
        "FREEZE",
      );
      renderTab({ lease: frozenLease, isElevated: true });

      expect(
        await screen.findByText(/Freezing this lease/),
      ).toBeInTheDocument();
      expect(screen.getByText("Revoking")).toBeInTheDocument();
      expect(screen.queryByText("Granting")).not.toBeInTheDocument();
      expect(screen.queryByText("Grant failed")).not.toBeInTheDocument();
    });

    it("does not offer Retry while frozen", async () => {
      // Retrying would PUT and get a 409.
      stubGetAssignments([
        desiredOnly({ principalId: "carol-id", syncStatus: "suspended" }),
      ]);
      renderTab({ lease: frozenLease, isElevated: true });

      expect(await screen.findByText("Access suspended")).toBeInTheDocument();
      expect(
        screen.queryByText("Some access changes did not apply"),
      ).not.toBeInTheDocument();
    });
  });

  describe("terminated lease", () => {
    // The tab stays available on a terminal lease so an operator can answer
    // "who had access to this account", but nothing about it is editable.
    const terminatedLease: Lease = {
      ...lease,
      status: "ManuallyTerminated",
    } as Lease;

    it("lists who had access, read-only", async () => {
      stubGetAssignments([
        desiredOnly({ principalId: "carol-id", syncStatus: "suspended" }),
      ]);
      renderTab({ lease: terminatedLease, isElevated: true });

      expect(await screen.findByText("Carol Davis")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Save changes" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Remove" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Share access")).not.toBeInTheDocument();
    });

    it("says access ended rather than suspended", async () => {
      // Same server status as a frozen lease, but a termination cannot be undone.
      stubGetAssignments([
        desiredOnly({ principalId: "carol-id", syncStatus: "suspended" }),
      ]);
      renderTab({ lease: terminatedLease, isElevated: true });

      expect(await screen.findByText("Access ended")).toBeInTheDocument();
      expect(screen.queryByText("Access suspended")).not.toBeInTheDocument();
      expect(
        screen.getByText(/list is kept as a record of who had access/),
      ).toBeInTheDocument();
    });

    it("still surfaces a failed revoke, since that is orphaned access", async () => {
      // A record surviving on a terminated lease means the principal may still
      // reach the account. Hiding it would defeat the point of the audit view.
      stubGetAssignments([lingeringRecord({ principalId: "dave-id" })]);
      renderTab({ lease: terminatedLease, isElevated: true });

      expect(await screen.findByText("Revoke failed")).toBeInTheDocument();
    });

    it("does not offer Retry", async () => {
      // Retry would PUT and get a 409 — the lease is not active.
      stubGetAssignments([lingeringRecord({ principalId: "dave-id" })]);
      renderTab({ lease: terminatedLease, isElevated: true });

      expect(await screen.findByText("Revoke failed")).toBeInTheDocument();
      expect(
        screen.queryByText("Some access changes did not apply"),
      ).not.toBeInTheDocument();
    });
  });

  it("names an unfreeze in progress without reporting failures", async () => {
    // Mid-unfreeze the records are not restored yet. Because the status and the
    // operation arrive on one response, this can never read as a failed grant.
    stubGetAssignments(
      [desiredOnly({ principalId: "carol-id", syncStatus: "granting" })],
      "UNFREEZE",
    );
    renderTab();

    expect(
      await screen.findByText(/Unfreezing this lease/),
    ).toBeInTheDocument();
    expect(screen.getByText("Granting")).toBeInTheDocument();
    expect(screen.queryByText("Grant failed")).not.toBeInTheDocument();
  });

  it("excludes a pending revoke from the submitted desired set", async () => {
    // Regression: every non-removed row used to be echoed back as desired, so
    // retrying a failed revoke re-desired the principal and cancelled the
    // revoke — repairing the desired state to match reality instead of applying
    // it. The API marks such rows isDesired: false and they must be dropped.
    stubGetAssignments([
      userAssignment,
      lingeringRecord({ principalId: "dave-id" }),
    ]);

    let putBody: { assignments: { principalId: string }[] } | undefined;
    server.use(
      http.put(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        async ({ request }) => {
          putBody = (await request.json()) as typeof putBody;
          return HttpResponse.json(
            { status: "success", data: { desiredCount: 1 } },
            { status: 202 },
          );
        },
      ),
    );

    renderTab();
    const user = userEvent.setup();

    expect(await screen.findByText("Revoke failed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(putBody).toBeDefined());
    const submitted = putBody!.assignments.map((a) => a.principalId);
    expect(submitted).toContain("user-1");
    expect(submitted).not.toContain("dave-id");
  });

  describe("pending revoke", () => {
    it("offers Undo instead of Remove, leaving other rows editable", async () => {
      // Removal is what's already pending, so Remove is meaningless. The revoke
      // may itself be the mistake, so the row offers to undo it.
      stubGetAssignments([
        userAssignment,
        lingeringRecord({ principalId: "dave-id" }),
      ]);
      renderTab();

      const daveRow = (await screen.findByText("dave@example.com")).closest(
        "tr",
      )!;
      expect(
        within(daveRow).getByRole("button", { name: "Undo" }),
      ).toBeInTheDocument();
      expect(
        within(daveRow).queryByRole("button", { name: "Remove" }),
      ).not.toBeInTheDocument();

      const aliceRow = screen
        .getByText("owner-test@example.com")
        .closest("tr")!;
      expect(
        within(aliceRow).getByRole("button", { name: "Remove" }),
      ).not.toBeDisabled();
    });

    it("stages the undo and submits the principal as desired", async () => {
      // The access record still exists, so the backend resolves this to a NO_OP
      // and the row settles back to active — nothing is re-granted.
      stubGetAssignments([
        userAssignment,
        lingeringRecord({ principalId: "dave-id" }),
      ]);

      let putBody: { assignments: { principalId: string }[] } | undefined;
      server.use(
        http.put(
          `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
          async ({ request }) => {
            putBody = (await request.json()) as typeof putBody;
            return HttpResponse.json(
              { status: "success", data: { desiredCount: 2 } },
              { status: 202 },
            );
          },
        ),
      );

      renderTab();
      const user = userEvent.setup();

      const daveRow = (await screen.findByText("dave@example.com")).closest(
        "tr",
      )!;
      await user.click(within(daveRow).getByRole("button", { name: "Undo" }));

      // Reuses the add wording — the principal is going back into the desired set.
      expect(screen.getByText("Pending add")).toBeInTheDocument();
      const save = screen.getByRole("button", { name: "Save changes" });
      expect(save).not.toBeDisabled();

      await user.click(save);

      await waitFor(() => expect(putBody).toBeDefined());
      expect(putBody!.assignments.map((a) => a.principalId)).toEqual([
        "user-1",
        "dave-id",
      ]);
    });

    it("reverts the staged undo via Remove, back to the pending revoke", async () => {
      // Reverting means "not desired" again, which the server already wants —
      // so it discards the staged change instead of staging a removal.
      stubGetAssignments([
        userAssignment,
        lingeringRecord({ principalId: "dave-id" }),
      ]);
      renderTab();
      const user = userEvent.setup();

      const daveRow = (await screen.findByText("dave@example.com")).closest(
        "tr",
      )!;
      await user.click(within(daveRow).getByRole("button", { name: "Undo" }));
      expect(screen.getByText("Pending add")).toBeInTheDocument();

      const stagedRow = screen.getByText("dave@example.com").closest("tr")!;
      await user.click(
        within(stagedRow).getByRole("button", { name: "Remove" }),
      );

      await waitFor(() =>
        expect(screen.queryByText("Pending add")).not.toBeInTheDocument(),
      );
      // Back to the server's view, not staged as a fresh removal.
      expect(screen.getByText("Revoke failed")).toBeInTheDocument();
      expect(screen.queryByText("Pending remove")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Save changes" }),
      ).toBeDisabled();
    });

    it("hides the Retry alert once a change is staged", async () => {
      // Retry submits the same desired set Save does, so offering both would be
      // two buttons for one action.
      stubGetAssignments([
        userAssignment,
        lingeringRecord({ principalId: "dave-id" }),
      ]);
      renderTab();
      const user = userEvent.setup();

      expect(
        await screen.findByText("Some access changes did not apply"),
      ).toBeInTheDocument();

      const daveRow = screen.getByText("dave@example.com").closest("tr")!;
      await user.click(within(daveRow).getByRole("button", { name: "Undo" }));

      await waitFor(() =>
        expect(
          screen.queryByText("Some access changes did not apply"),
        ).not.toBeInTheDocument(),
      );
    });
  });

  it("offers a Retry that reapplies the desired set without staging an edit", async () => {
    // Save is gated on isDirty, so without this affordance the only way to
    // recover from a failed reconcile is to fake an edit.
    stubGetAssignments([
      userAssignment,
      desiredOnly({ principalId: "carol-id", syncStatus: "grantFailed" }),
    ]);

    let putBody: { assignments: { principalId: string }[] } | undefined;
    server.use(
      http.put(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        async ({ request }) => {
          putBody = (await request.json()) as typeof putBody;
          return HttpResponse.json({
            status: "success",
            data: { assignments: [] },
          });
        },
      ),
    );

    renderTab();
    const user = userEvent.setup();

    expect(
      await screen.findByText("Some access changes did not apply"),
    ).toBeInTheDocument();

    // Save stays disabled (nothing staged); Retry is the recovery path.
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(putBody).toBeDefined());
    expect(putBody!.assignments.map((a) => a.principalId)).toContain(
      "carol-id",
    );
  });

  it("hides the Retry affordance while the backend is still processing", async () => {
    // A transitional row is not a failure, so there is nothing to retry.
    stubGetAssignments(
      [
        userAssignment,
        desiredOnly({ principalId: "carol-id", syncStatus: "granting" }),
      ],
      "UPDATE",
    );
    renderTab();

    expect(await screen.findByText("Granting")).toBeInTheDocument();
    expect(
      screen.queryByText("Some access changes did not apply"),
    ).not.toBeInTheDocument();
  });

  it("drops an unsaved add outright when Remove is clicked on it", async () => {
    stubGetAssignments([ownerAssignment]);
    renderTab();
    const user = userEvent.setup();

    // Wait for the owner row.
    expect(
      (await screen.findAllByText("owner@example.com")).length,
    ).toBeGreaterThan(0);

    // Add carol via typeahead stub.
    await user.click(screen.getByRole("button", { name: "Add carol-id" }));
    expect(screen.getByText("Pending add")).toBeInTheDocument();
    expect(screen.getByText("Carol Davis")).toBeInTheDocument();

    // Remove the unsaved add — it should disappear entirely (not stage as "removed").
    const carolRow = screen.getByText("Carol Davis").closest("tr")!;
    await user.click(within(carolRow).getByRole("button", { name: "Remove" }));
    expect(screen.queryByText("Carol Davis")).not.toBeInTheDocument();
    expect(screen.queryByText("Pending remove")).not.toBeInTheDocument();
  });

  it("shows Undo button on removed rows and restores them on click", async () => {
    stubGetAssignments([ownerAssignment, userAssignment]);
    renderTab();
    const user = userEvent.setup();

    expect(
      (await screen.findAllByText("alice@example.com")).length,
    ).toBeGreaterThan(0);

    // Stage alice for removal.
    const aliceRow = screen.getByText("owner-test@example.com").closest("tr")!;
    await user.click(within(aliceRow).getByRole("button", { name: "Remove" }));
    expect(screen.getByText("Pending remove")).toBeInTheDocument();

    // Undo button should appear.
    const updatedRow = screen
      .getByText("owner-test@example.com")
      .closest("tr")!;
    const undoButton = within(updatedRow).getByRole("button", { name: "Undo" });
    expect(undoButton).toBeInTheDocument();

    // Click Undo — row returns to current state.
    await user.click(undoButton);
    await waitFor(() =>
      expect(screen.queryByText("Pending remove")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("shows error toast when save fails", async () => {
    const { showErrorToast: mockErrorToast } =
      await import("@amzn/innovation-sandbox-frontend/components/Toast");
    stubGetAssignments([ownerAssignment, userAssignment]);
    server.use(
      http.put(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        () => HttpResponse.json({ status: "error" }, { status: 500 }),
      ),
    );
    renderTab();
    const user = userEvent.setup();

    expect(
      (await screen.findAllByText("alice@example.com")).length,
    ).toBeGreaterThan(0);

    // Stage a removal so Save is enabled.
    const aliceRow = screen.getByText("owner-test@example.com").closest("tr")!;
    await user.click(within(aliceRow).getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(mockErrorToast).toHaveBeenCalled());
  });

  it("renders ErrorPanel when the assignments query fails", async () => {
    server.use(
      http.get(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        () => HttpResponse.json({ status: "error" }, { status: 500 }),
      ),
    );

    const Wrapper = createQueryClientWrapper();
    const { MemoryRouter } = await import("react-router-dom");
    render(
      <MemoryRouter>
        <Wrapper>
          <AssignmentsTab
            lease={lease}
            leaseRouteId={LEASE_ROUTE_ID}
            leaseSharingEnabled={true}
            enablePrincipalSearch={true}
            isElevated={false}
            isOwner={true}
          />
        </Wrapper>
      </MemoryRouter>,
    );

    expect(
      await screen.findByText(
        /There was a problem loading assignments for this lease/i,
      ),
    ).toBeInTheDocument();
  });

  it("disables Remove and Undo buttons while backend is processing", async () => {
    stubGetAssignments([ownerAssignment, userAssignment], "UPDATE");
    renderTab();

    const aliceRow = (
      await screen.findByText("owner-test@example.com")
    ).closest("tr")!;

    // Remove button should be disabled while lock is held.
    const removeBtn = within(aliceRow).getByRole("button", { name: "Remove" });
    expect(removeBtn).toBeDisabled();
  });
});
// Ensure createWrapper isn't tree-shaken; some Cloudscape tests need it for
// future expansion (e.g., asserting on the typeahead dropdown).
void createWrapper;
