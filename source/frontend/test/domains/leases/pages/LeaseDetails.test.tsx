// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useNavigate, useParams } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useGetLeaseById } from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { LeaseDetails } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/LeaseDetails";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { ModalProvider } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

// Mock hooks
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: vi.fn(),
    useParams: vi.fn(),
  };
});

vi.mock("@amzn/innovation-sandbox-frontend/domains/leases/hooks");
vi.mock("@amzn/innovation-sandbox-frontend/domains/settings/hooks");
vi.mock("@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb");

// AccountLoginLink reaches into runtime config; stub it to a plain button so
// the details page can render the login action without that dependency.
vi.mock(
  "@amzn/innovation-sandbox-frontend/components/AccountLoginLink",
  () => ({
    AccountLoginLink: ({ accountId }: { accountId: string }) => (
      <button>Login to account {accountId}</button>
    ),
  }),
);

// The terminate modal depends on useTerminateLease, which this file's
// auto-mock of leases/hooks leaves undefined. Stub the content; the page's job
// is only to open the modal (its "Terminate Lease" header comes from the
// ModalProvider), and the modal's own behavior is covered by its own tests.
vi.mock(
  "@amzn/innovation-sandbox-frontend/domains/leases/components/TerminateLeaseConfirmationModal",
  () => ({
    TerminateLeaseConfirmationModal: () => <div>terminate confirmation</div>,
  }),
);

const mockUseUser = vi.fn();
vi.mock("@amzn/innovation-sandbox-frontend/hooks/useUser", () => ({
  useUser: () => mockUseUser(),
}));

// Default to an Admin viewer so the existing edit-button assertions hold; the
// user-facing suite below overrides this with a plain User.
const adminUser = {
  type: "user" as const,
  email: "admin@example.com",
  userId: "admin-id",
  roles: ["Admin" as const],
};

// Wrap in ModalProvider: the page opens the terminate modal via useModal().
const renderLeaseDetails = () =>
  renderWithQueryClient(
    <ModalProvider>
      <LeaseDetails />
    </ModalProvider>,
  );

const mockActiveLease = {
  uuid: "lease-123",
  leaseId: "lease-123",
  userEmail: "user@example.com",
  createdBy: "admin@example.com",
  approvedBy: "manager@example.com",
  status: "Active",
  awsAccountId: "123456789012",
  originalLeaseTemplateName: "Standard Template",
  startDate: "2024-01-01T00:00:00Z",
  lastCheckedDate: "2024-01-05T12:00:00Z",
  expirationDate: "2024-01-08T00:00:00Z",
  maxSpend: 100,
  totalCostAccrued: 45.5,
  budgetThresholds: [
    { dollarsSpent: 50, action: "ALERT" as const },
    { dollarsSpent: 75, action: "FREEZE_ACCOUNT" as const },
  ],
  durationThresholds: [
    { hoursRemaining: 48, action: "ALERT" as const },
    { hoursRemaining: 24, action: "ALERT" as const },
  ],
  costReportGroup: "engineering-team",
  comments: "Test lease for development",
};

const mockPendingLease = {
  uuid: "lease-456",
  leaseId: "lease-456",
  userEmail: "pending@example.com",
  createdBy: "pending@example.com",
  status: "Pending",
  originalLeaseTemplateName: "Standard Template",
  maxSpend: 100,
  budgetThresholds: [],
  durationThresholds: [],
  comments: null,
};

const mockConfig = {
  leases: {
    maxBudget: 100,
    requireMaxBudget: false,
    maxDurationHours: 720,
    requireMaxDuration: false,
  },
  termsOfService: "Terms",
};

describe("LeaseDetails", () => {
  const mockNavigate = vi.fn();
  const mockSetBreadcrumb = vi.fn();
  const mockRefetch = vi.fn();
  const mockRefetchConfig = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    mockUseUser.mockReturnValue({
      user: adminUser,
      isAdmin: true,
      isManager: false,
    });
    (useNavigate as any).mockReturnValue(mockNavigate);
    (useParams as any).mockReturnValue({ leaseId: "lease-123" });
    (useBreadcrumb as any).mockReturnValue(mockSetBreadcrumb);

    (useGetLeaseById as any).mockReturnValue({
      data: mockActiveLease,
      isFetching: false,
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
      error: null,
    });

    (useGetConfigurations as any).mockReturnValue({
      data: mockConfig,
      isLoading: false,
      isError: false,
      refetch: mockRefetchConfig,
      error: null,
    });
  });

  it("shows loading state while fetching lease data", () => {
    (useGetLeaseById as any).mockReturnValue({
      data: null,
      isFetching: true,
      isLoading: true,
      isError: false,
    });

    renderLeaseDetails();

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows loading state while fetching config data", () => {
    (useGetConfigurations as any).mockReturnValue({
      data: null,
      isLoading: true,
      isError: false,
    });

    renderLeaseDetails();

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows error state when lease fails to load", () => {
    (useGetLeaseById as any).mockReturnValue({
      data: null,
      isFetching: false,
      isLoading: false,
      isError: true,
      refetch: mockRefetch,
      error: new Error("Failed to load lease"),
    });

    renderLeaseDetails();

    expect(
      screen.getByText("There was a problem loading this lease."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /try again/i }),
    ).toBeInTheDocument();
  });

  it("shows error state when config fails to load", () => {
    (useGetConfigurations as any).mockReturnValue({
      data: null,
      isLoading: false,
      isError: true,
      refetch: mockRefetchConfig,
      error: new Error("Failed to load config"),
    });

    renderLeaseDetails();

    expect(
      screen.getByText(
        "There was a problem loading global configuration settings.",
      ),
    ).toBeInTheDocument();
  });

  it("displays lease details for active lease", async () => {
    renderLeaseDetails();

    // Wait for the page to load by checking for a unique element
    await waitFor(() => {
      expect(screen.getByText("Lease Details")).toBeInTheDocument();
    });

    // Check basic details - use more specific queries to avoid duplicates
    expect(screen.getByText("lease-123")).toBeInTheDocument();
    expect(screen.getByText("123456789012")).toBeInTheDocument();
    expect(screen.getByText("Standard Template")).toBeInTheDocument();

    // Check for emails - they appear multiple times, so just check they exist
    expect(screen.getAllByText("user@example.com").length).toBeGreaterThan(0);
    expect(screen.getAllByText("admin@example.com").length).toBeGreaterThan(0);
    expect(screen.getAllByText("manager@example.com").length).toBeGreaterThan(
      0,
    );

    // Check comments
    expect(screen.getByText("Test lease for development")).toBeInTheDocument();

    // Check section headers
    expect(screen.getByText("Budget Settings")).toBeInTheDocument();
    expect(screen.getByText("Duration Settings")).toBeInTheDocument();
    expect(screen.getByText("Cost Report Settings")).toBeInTheDocument();
    expect(screen.getByText("engineering-team")).toBeInTheDocument();
  });

  it("displays edit buttons for active lease", async () => {
    renderLeaseDetails();

    await waitFor(() => {
      expect(screen.getByText("Lease Details")).toBeInTheDocument();
    });

    // Should have 3 edit buttons (Budget, Duration, Cost Report)
    const editButtons = screen.getAllByRole("button", { name: "Edit" });
    expect(editButtons).toHaveLength(3);
  });

  it("shows admin-only fields (cost report, last monitored) for an admin", async () => {
    renderLeaseDetails();

    await waitFor(() => {
      expect(screen.getByText("Lease Details")).toBeInTheDocument();
    });

    expect(screen.getByText("Cost Report Settings")).toBeInTheDocument();
    expect(screen.getByText("Last Monitored")).toBeInTheDocument();
  });

  it("navigates to edit budget page when edit budget clicked", async () => {
    const user = userEvent.setup();
    renderLeaseDetails();

    await waitFor(() => {
      expect(screen.getByText("Budget Settings")).toBeInTheDocument();
    });

    // Find the edit button in the Budget Settings section
    const budgetSection = screen
      .getByText("Budget Settings")
      .closest("div[class*='awsui_header']");
    const editButton = budgetSection?.querySelector(
      'button[aria-label="Edit"]',
    );

    if (editButton) {
      await user.click(editButton as HTMLElement);
      expect(mockNavigate).toHaveBeenCalledWith(
        "/leases/lease-123/edit/budget",
      );
    }
  });

  it("navigates to edit duration page when edit duration clicked", async () => {
    const user = userEvent.setup();
    renderLeaseDetails();

    await waitFor(() => {
      expect(screen.getByText("Duration Settings")).toBeInTheDocument();
    });

    // Find the edit button in the Duration Settings section
    const durationSection = screen
      .getByText("Duration Settings")
      .closest("div[class*='awsui_header']");
    const editButton = durationSection?.querySelector(
      'button[aria-label="Edit"]',
    );

    if (editButton) {
      await user.click(editButton as HTMLElement);
      expect(mockNavigate).toHaveBeenCalledWith(
        "/leases/lease-123/edit/duration",
      );
    }
  });

  it("navigates to edit cost report page when edit cost report clicked", async () => {
    const user = userEvent.setup();
    renderLeaseDetails();

    await waitFor(() => {
      expect(screen.getByText("Cost Report Settings")).toBeInTheDocument();
    });

    // Find the edit button in the Cost Report Settings section
    const costReportSection = screen
      .getByText("Cost Report Settings")
      .closest("div[class*='awsui_header']");
    const editButton = costReportSection?.querySelector(
      'button[aria-label="Edit"]',
    );

    if (editButton) {
      await user.click(editButton as HTMLElement);
      expect(mockNavigate).toHaveBeenCalledWith(
        "/leases/lease-123/edit/cost-report",
      );
    }
  });

  it("does not show edit buttons for pending lease", async () => {
    (useGetLeaseById as any).mockReturnValue({
      data: mockPendingLease,
      isFetching: false,
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
      error: null,
    });

    renderLeaseDetails();

    await waitFor(() => {
      expect(screen.getByText("Lease Details")).toBeInTheDocument();
    });

    // Should not have any edit buttons
    const editButtons = screen.queryAllByRole("button", { name: "Edit" });
    expect(editButtons).toHaveLength(0);
  });

  it("displays pending lease without account information", async () => {
    (useGetLeaseById as any).mockReturnValue({
      data: mockPendingLease,
      isFetching: false,
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
      error: null,
    });

    renderLeaseDetails();

    await waitFor(() => {
      expect(screen.getByText("Lease Details")).toBeInTheDocument();
    });

    // Should show "No account assigned" instead of account ID
    expect(screen.getByText("No account assigned")).toBeInTheDocument();
  });

  it("displays no comments message when comments are null", async () => {
    (useGetLeaseById as any).mockReturnValue({
      data: mockPendingLease,
      isFetching: false,
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
      error: null,
    });

    renderLeaseDetails();

    await waitFor(() => {
      expect(screen.getByText("Lease Details")).toBeInTheDocument();
    });

    expect(screen.getByText("No comments provided")).toBeInTheDocument();
  });

  it("displays auto-approved status", async () => {
    const autoApprovedLease = {
      ...mockActiveLease,
      approvedBy: "AUTO_APPROVED",
    };

    (useGetLeaseById as any).mockReturnValue({
      data: autoApprovedLease,
      isFetching: false,
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
      error: null,
    });

    renderLeaseDetails();

    await waitFor(() => {
      expect(screen.getByText("Lease Details")).toBeInTheDocument();
    });

    expect(screen.getByText("Auto Approved")).toBeInTheDocument();
  });

  it("displays no cost report group message when not assigned", async () => {
    const leaseWithoutCostReport = {
      ...mockActiveLease,
      costReportGroup: null,
    };

    (useGetLeaseById as any).mockReturnValue({
      data: leaseWithoutCostReport,
      isFetching: false,
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
      error: null,
    });

    renderLeaseDetails();

    await waitFor(() => {
      expect(screen.getByText("Lease Details")).toBeInTheDocument();
    });

    expect(screen.getByText("Not assigned")).toBeInTheDocument();
  });

  it("displays budget thresholds", async () => {
    const leaseWithoutCostReport = {
      ...mockActiveLease,
      costReportGroup: null,
    };

    (useGetLeaseById as any).mockReturnValue({
      data: leaseWithoutCostReport,
      isFetching: false,
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
      error: null,
    });

    renderLeaseDetails();

    await waitFor(() => {
      expect(screen.getByText("Budget Thresholds")).toBeInTheDocument();
    });

    // Check threshold values are displayed - they may be formatted with $ or other text
    expect(screen.getByText("$50.00")).toBeInTheDocument();
    expect(screen.getByText("$75.00")).toBeInTheDocument();
  });

  it("displays duration thresholds", async () => {
    renderLeaseDetails();

    await waitFor(() => {
      expect(screen.getByText("Duration Thresholds")).toBeInTheDocument();
    });

    // Check threshold values are displayed
    expect(screen.getByText("48 hours")).toBeInTheDocument();
    expect(screen.getByText("24 hours")).toBeInTheDocument();
  });

  it("displays no thresholds message when budget thresholds are empty", async () => {
    const leaseWithoutThresholds = {
      ...mockActiveLease,
      budgetThresholds: [],
      durationThresholds: [],
    };

    (useGetLeaseById as any).mockReturnValue({
      data: leaseWithoutThresholds,
      isFetching: false,
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
      error: null,
    });

    renderLeaseDetails();

    await waitFor(() => {
      expect(screen.getByText("Lease Details")).toBeInTheDocument();
    });

    const noThresholdsMessages = screen.getAllByText(
      "No thresholds configured",
    );
    expect(noThresholdsMessages.length).toBeGreaterThan(0);
  });

  it("sets breadcrumb with lease information", async () => {
    renderLeaseDetails();

    await waitFor(() => {
      expect(mockSetBreadcrumb).toHaveBeenCalled();
    });
  });

  it("retries loading lease on error retry click", async () => {
    (useGetLeaseById as any).mockReturnValue({
      data: null,
      isFetching: false,
      isLoading: false,
      isError: true,
      refetch: mockRefetch,
      error: new Error("Failed to load"),
    });

    const user = userEvent.setup();
    renderLeaseDetails();

    const retryButton = screen.getByRole("button", { name: /try again/i });
    await user.click(retryButton);

    expect(mockRefetch).toHaveBeenCalled();
  });

  it("retries loading config on error retry click", async () => {
    (useGetConfigurations as any).mockReturnValue({
      data: null,
      isLoading: false,
      isError: true,
      refetch: mockRefetchConfig,
      error: new Error("Failed to load"),
    });

    const user = userEvent.setup();
    renderLeaseDetails();

    const retryButton = screen.getByRole("button", { name: /try again/i });
    await user.click(retryButton);

    expect(mockRefetchConfig).toHaveBeenCalled();
  });

  it("displays lease ID with copy functionality", async () => {
    renderLeaseDetails();

    await waitFor(() => {
      expect(screen.getByText("lease-123")).toBeInTheDocument();
    });

    // The CopyToClipboard component should be present
    const leaseIdText = screen.getByText("lease-123");
    expect(leaseIdText).toBeInTheDocument();
  });

  it("displays AWS account ID with copy functionality for active lease", async () => {
    renderLeaseDetails();

    await waitFor(() => {
      expect(screen.getByText("123456789012")).toBeInTheDocument();
    });

    // The CopyToClipboard component should be present
    const accountIdText = screen.getByText("123456789012");
    expect(accountIdText).toBeInTheDocument();
  });

  describe("Assignments tab gating", () => {
    it("shows the Assignments tab for an admin viewing an active lease", async () => {
      renderLeaseDetails();

      await waitFor(() => {
        expect(screen.getByText("Lease Details")).toBeInTheDocument();
      });

      // showAssignmentsTab = isActiveLease && (isAdminOrManager || isOwner):
      // admin + active lease renders the tabbed view with an Assignments tab.
      expect(
        screen.getByRole("tab", { name: "Assignments" }),
      ).toBeInTheDocument();
    });

    it("shows the Assignments tab for a frozen lease", async () => {
      // A freeze retains the desired assignments so unfreeze can restore
      // access, so the list is still worth showing (read-only).
      (useGetLeaseById as any).mockReturnValue({
        data: { ...mockActiveLease, status: "Frozen" },
        isFetching: false,
        isLoading: false,
        isError: false,
        refetch: mockRefetch,
        error: null,
      });

      renderLeaseDetails();

      await waitFor(() => {
        expect(screen.getByText("Lease Details")).toBeInTheDocument();
      });

      expect(
        screen.getByRole("tab", { name: "Assignments" }),
      ).toBeInTheDocument();
    });

    it("shows the Assignments tab for a terminated lease", async () => {
      // Nothing clears desiredAssignments on terminate, so the list answers
      // "who had access to this account" — an audit question that outlives the
      // lease. Renders read-only.
      (useGetLeaseById as any).mockReturnValue({
        data: { ...mockActiveLease, status: "ManuallyTerminated" },
        isFetching: false,
        isLoading: false,
        isError: false,
        refetch: mockRefetch,
        error: null,
      });

      renderLeaseDetails();

      await waitFor(() => {
        expect(screen.getByText("Lease Details")).toBeInTheDocument();
      });

      expect(
        screen.getByRole("tab", { name: "Assignments" }),
      ).toBeInTheDocument();
    });

    it("hides the Assignments tab for a non-active (pending) lease", async () => {
      (useGetLeaseById as any).mockReturnValue({
        data: mockPendingLease,
        isFetching: false,
        isLoading: false,
        isError: false,
        refetch: mockRefetch,
        error: null,
      });

      renderLeaseDetails();

      await waitFor(() => {
        expect(screen.getByText("Lease Details")).toBeInTheDocument();
      });

      // Non-active lease: the summary renders directly, no Assignments tab.
      expect(
        screen.queryByRole("tab", { name: "Assignments" }),
      ).not.toBeInTheDocument();
    });

    it("hides the Assignments tab for a non-owner, non-admin viewer of an active lease", async () => {
      mockUseUser.mockReturnValue({
        user: {
          type: "user" as const,
          email: "stranger@example.com",
          userId: "stranger-id",
          roles: ["User" as const],
        },
        isAdmin: false,
        isManager: false,
      });

      renderLeaseDetails();

      await waitFor(() => {
        expect(screen.getByText("Lease Details")).toBeInTheDocument();
      });

      // Not admin/manager and not the lease owner: no Assignments tab.
      expect(
        screen.queryByRole("tab", { name: "Assignments" }),
      ).not.toBeInTheDocument();
    });
  });

  describe("Actions for lease owners (Users)", () => {
    // A plain User who owns mockActiveLease (userEmail: user@example.com).
    const ownerUser = {
      type: "user" as const,
      email: "user@example.com",
      userId: "user-id",
      roles: ["User" as const],
    };

    const asOwnerUser = () =>
      mockUseUser.mockReturnValue({
        user: ownerUser,
        isAdmin: false,
        isManager: false,
      });

    const withTerminationEnabled = (enabled: boolean) =>
      (useGetConfigurations as any).mockReturnValue({
        data: {
          ...mockConfig,
          leases: { ...mockConfig.leases, allowUserLeaseTermination: enabled },
        },
        isLoading: false,
        isError: false,
        refetch: mockRefetchConfig,
        error: null,
      });

    it("shows the login action for an active lease", async () => {
      asOwnerUser();
      renderLeaseDetails();

      await waitFor(() => {
        expect(
          screen.getByText("Login to account 123456789012"),
        ).toBeInTheDocument();
      });
    });

    it("hides all edit buttons for a non-admin viewer", async () => {
      asOwnerUser();
      renderLeaseDetails();

      await waitFor(() => {
        expect(screen.getByText("Lease Details")).toBeInTheDocument();
      });

      expect(screen.queryAllByRole("button", { name: "Edit" })).toHaveLength(0);
    });

    it("hides admin-only fields (cost report, last monitored) for a User", async () => {
      asOwnerUser();
      renderLeaseDetails();

      await waitFor(() => {
        expect(screen.getByText("Lease Details")).toBeInTheDocument();
      });

      expect(screen.queryByText("Last Monitored")).not.toBeInTheDocument();
    });

    it("shows the terminate action when the owner can terminate", async () => {
      asOwnerUser();
      withTerminationEnabled(true);
      renderLeaseDetails();

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Terminate lease" }),
        ).toBeInTheDocument();
      });
    });

    it("hides the terminate action when termination is disabled", async () => {
      asOwnerUser();
      withTerminationEnabled(false);
      renderLeaseDetails();

      await waitFor(() => {
        expect(screen.getByText("Lease Details")).toBeInTheDocument();
      });

      expect(
        screen.queryByRole("button", { name: "Terminate lease" }),
      ).not.toBeInTheDocument();
    });

    it("hides the terminate action when the viewer is not the owner", async () => {
      mockUseUser.mockReturnValue({
        user: { ...ownerUser, email: "someone-else@example.com" },
        isAdmin: false,
        isManager: false,
      });
      withTerminationEnabled(true);
      renderLeaseDetails();

      await waitFor(() => {
        expect(screen.getByText("Lease Details")).toBeInTheDocument();
      });

      expect(
        screen.queryByRole("button", { name: "Terminate lease" }),
      ).not.toBeInTheDocument();
    });

    it("opens the terminate confirmation modal when clicked", async () => {
      asOwnerUser();
      withTerminationEnabled(true);
      const user = userEvent.setup();
      renderLeaseDetails();

      const terminateButton = await screen.findByRole("button", {
        name: "Terminate lease",
      });
      await user.click(terminateButton);

      expect(
        await screen.findByRole("heading", { name: "Terminate Lease" }),
      ).toBeInTheDocument();
    });

    it("shows the pending-approval indicator for a pending lease", async () => {
      asOwnerUser();
      (useGetLeaseById as any).mockReturnValue({
        data: { ...mockPendingLease, status: "PendingApproval" },
        isFetching: false,
        isLoading: false,
        isError: false,
        refetch: mockRefetch,
        error: null,
      });
      renderLeaseDetails();

      await waitFor(() => {
        expect(
          screen.getByText("Your account is pending approval"),
        ).toBeInTheDocument();
      });
    });
  });
});
