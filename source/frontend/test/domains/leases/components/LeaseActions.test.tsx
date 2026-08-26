// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  Lease,
  LeaseWithLeaseId,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { LeaseActions } from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseActions";
import { ModalProvider } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import { createConfiguration } from "@amzn/innovation-sandbox-frontend/mocks/factories/configurationFactory";
import {
  createActiveLease,
  createExpiredLease,
  createPendingLease,
} from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

vi.mock(
  "@amzn/innovation-sandbox-frontend/components/AccountLoginLink",
  () => ({
    AccountLoginLink: ({ accountId }: { accountId: string }) => (
      <button>Login to account {accountId}</button>
    ),
  }),
);

vi.mock(
  "@amzn/innovation-sandbox-frontend/domains/leases/components/TerminateLeaseConfirmationModal",
  () => ({
    TerminateLeaseConfirmationModal: ({
      leaseId,
      uuid,
      accountId,
    }: {
      leaseId: string;
      uuid: string;
      accountId: string;
    }) => (
      <div>
        terminate leaseId:{leaseId} uuid:{uuid} accountId:{accountId}
      </div>
    ),
  }),
);

vi.mock(
  "@amzn/innovation-sandbox-frontend/domains/leases/components/FreezeLeaseConfirmationModal",
  () => ({
    FreezeLeaseConfirmationModal: ({
      action,
      leaseId,
    }: {
      action: string;
      leaseId: string;
    }) => (
      <div>
        {action} leaseId:{leaseId}
      </div>
    ),
  }),
);

const mockUseUser = vi.fn();
vi.mock("@amzn/innovation-sandbox-frontend/hooks/useUser", () => ({
  useUser: () => mockUseUser(),
}));

const mockUseGetConfigurations = vi.fn();
vi.mock("@amzn/innovation-sandbox-frontend/domains/settings/hooks", () => ({
  useGetConfigurations: () => mockUseGetConfigurations(),
}));

const ownerEmail = "owner@example.com";
const ownerUser = {
  type: "user" as const,
  email: ownerEmail,
  userId: "owner-id",
  roles: ["User" as const],
};

const defaultLeasesConfig = {
  requireMaxBudget: false,
  maxBudget: 100,
  requireMaxDuration: false,
  maxDurationHours: 999,
  maxLeasesPerUser: 2,
  ttl: 30,
  leaseSharingEnabled: false,
  allowUserLeaseTermination: true,
  leaseRequestWindowHours: 168,
  maxLeaseRequestsPerWindow: 10,
  enablePrincipalSearch: true,
};

const withLeaseId = (lease: Lease): LeaseWithLeaseId => ({
  ...lease,
  leaseId: "encoded-lease-id",
});

const adminUser = { ...ownerUser, roles: ["Admin" as const] };

const renderActions = (
  lease: LeaseWithLeaseId,
  { includeElevatedActions = false } = {},
) =>
  renderWithQueryClient(
    <ModalProvider>
      <LeaseActions
        lease={lease}
        includeElevatedActions={includeElevatedActions}
      />
    </ModalProvider>,
  );

describe("LeaseActions", () => {
  beforeEach(() => {
    mockUseUser.mockReset();
    mockUseGetConfigurations.mockReset();
    mockUseUser.mockReturnValue({ user: ownerUser });
    mockUseGetConfigurations.mockReturnValue({
      data: createConfiguration({ leases: defaultLeasesConfig }),
    });
  });

  test("renders nothing for a lease with no actions", () => {
    const { container } = renderActions(withLeaseId(createExpiredLease()));

    expect(container).toBeEmptyDOMElement();
  });

  test("renders the login link for an active lease", () => {
    renderActions(
      withLeaseId(createActiveLease({ awsAccountId: "111122223333" })),
    );

    expect(
      screen.getByText("Login to account 111122223333"),
    ).toBeInTheDocument();
  });

  test("does not render the login link for a frozen lease the user owns", () => {
    // Frozen is monitored (not active); login is gated on active status only.
    renderActions(
      withLeaseId(
        createActiveLease({ userEmail: ownerEmail, status: "Frozen" }),
      ),
    );

    expect(screen.queryByText(/Login to account/i)).not.toBeInTheDocument();
  });

  test("does not render the login link for an expired lease the user owns", () => {
    renderActions(withLeaseId(createExpiredLease({ userEmail: ownerEmail })));

    expect(screen.queryByText(/Login to account/i)).not.toBeInTheDocument();
  });

  test("renders the pending indicator (and no login) for a pending lease", () => {
    renderActions(withLeaseId(createPendingLease()));

    expect(
      screen.getByText("Your account is pending approval"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Login to account/i)).not.toBeInTheDocument();
  });

  test("renders the terminate button when the owner can terminate", () => {
    renderActions(withLeaseId(createActiveLease({ userEmail: ownerEmail })));

    expect(
      screen.getByRole("button", { name: "Terminate lease" }),
    ).toBeInTheDocument();
  });

  test("opens the terminate modal with opaque leaseId and readable uuid", async () => {
    renderActions(
      withLeaseId(
        createActiveLease({ userEmail: ownerEmail, uuid: "lease-uuid-123" }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Terminate lease" }));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/leaseId:encoded-lease-id/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/uuid:lease-uuid-123/)).toBeInTheDocument();
  });

  describe("freeze / unfreeze", () => {
    beforeEach(() => {
      mockUseUser.mockReturnValue({ user: adminUser, isAdmin: true });
    });

    test("renders the freeze button for an admin on an active lease", () => {
      renderActions(withLeaseId(createActiveLease()), {
        includeElevatedActions: true,
      });

      expect(
        screen.getByRole("button", { name: "Freeze lease" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Unfreeze lease" }),
      ).not.toBeInTheDocument();
    });

    test("renders the unfreeze button for an admin on a frozen lease", () => {
      renderActions(withLeaseId(createActiveLease({ status: "Frozen" })), {
        includeElevatedActions: true,
      });

      expect(
        screen.getByRole("button", { name: "Unfreeze lease" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Freeze lease" }),
      ).not.toBeInTheDocument();
    });

    test("renders no freeze controls for a non-elevated user", () => {
      mockUseUser.mockReturnValue({ user: ownerUser });
      renderActions(withLeaseId(createActiveLease()), {
        includeElevatedActions: true,
      });

      expect(
        screen.queryByRole("button", { name: "Freeze lease" }),
      ).not.toBeInTheDocument();
    });

    test("opens the freeze confirmation with the opaque leaseId", async () => {
      renderActions(withLeaseId(createActiveLease()), {
        includeElevatedActions: true,
      });

      fireEvent.click(screen.getByRole("button", { name: "Freeze lease" }));

      const dialog = await screen.findByRole("dialog");
      expect(
        within(dialog).getByText(/^freeze leaseId:encoded-lease-id/),
      ).toBeInTheDocument();
    });

    test("opens the unfreeze confirmation from a frozen lease", async () => {
      renderActions(withLeaseId(createActiveLease({ status: "Frozen" })), {
        includeElevatedActions: true,
      });

      fireEvent.click(screen.getByRole("button", { name: "Unfreeze lease" }));

      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(/^unfreeze/)).toBeInTheDocument();
    });

    test("renders unfreeze alongside terminate for a frozen lease", () => {
      renderActions(withLeaseId(createActiveLease({ status: "Frozen" })), {
        includeElevatedActions: true,
      });

      expect(
        screen.getByRole("button", { name: "Unfreeze lease" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Terminate lease" }),
      ).toBeInTheDocument();
    });

    test("disables unfreeze but keeps it visible while a lock is held", async () => {
      renderActions(
        withLeaseId(
          createActiveLease({
            status: "Frozen",
            resourceLock: {
              ownerId: "update-abc",
              acquiredAt: new Date(Date.now() - 60_000).toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              meta: { intent: "UPDATE" },
            },
          }),
        ),
        { includeElevatedActions: true },
      );

      // disabledReason keeps the control focusable, so Cloudscape marks it
      // aria-disabled rather than using the disabled attribute.
      const button = screen.getByRole("button", { name: "Unfreeze lease" });
      expect(button).toHaveAttribute("aria-disabled", "true");

      // Clicking a disabled action must not open the confirmation. The
      // ModalProvider always keeps a hidden role="dialog" mounted, so assert on
      // the modal's content instead of the dialog element.
      fireEvent.click(button);
      expect(screen.queryByText(/^unfreeze leaseId/)).not.toBeInTheDocument();
    });
  });
});
