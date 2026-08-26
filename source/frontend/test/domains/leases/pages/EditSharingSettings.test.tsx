// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { EditSharingSettings } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/EditSharingSettings";
import { MonitoredLeaseWithLeaseId } from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";
import { ApiResponse } from "@amzn/innovation-sandbox-frontend/types";

const mockNavigate = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ leaseId: "lease-123" }),
  };
});

vi.mock("@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb", () => ({
  useBreadcrumb: () => vi.fn(),
}));

vi.mock("@amzn/innovation-sandbox-frontend/components/Toast", () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
}));

const mockLease: MonitoredLeaseWithLeaseId = {
  uuid: "lease-123",
  leaseId: "lease-123",
  userEmail: "user@example.com",
  status: "Active",
  awsAccountId: "123456789012",
  startDate: "2024-01-01T00:00:00.000Z",
  approvedBy: "manager@example.com",
  lastCheckedDate: "2024-01-01T00:00:00.000Z",
  originalLeaseTemplateName: "Test Template",
  originalLeaseTemplateUuid: crypto.randomUUID(),
  totalCostAccrued: 0,
  allowOwnerToShareLease: false,
};

const mockConfig = {
  costReportGroups: [],
  requireCostReportGroup: false,
  leases: {
    maxBudget: 500,
    requireMaxBudget: false,
    maxDurationHours: 720,
    requireMaxDuration: false,
    leaseSharingEnabled: true,
  },
  termsOfService: "Terms",
  isbManagedRegions: ["us-east-1"],
};

describe("EditSharingSettings", () => {
  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <EditSharingSettings />
      </Router>,
    );

  const mockedShowSuccessToast = vi.mocked(showSuccessToast);
  const mockedShowErrorToast = vi.mocked(showErrorToast);

  beforeEach(() => {
    vi.clearAllMocks();

    server.use(
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, () => {
        const response: ApiResponse<MonitoredLeaseWithLeaseId> = {
          status: "success",
          data: mockLease,
        };
        return HttpResponse.json(response);
      }),
      http.get(`${getConfig().ApiUrl}/configurations`, () => {
        const response: ApiResponse<typeof mockConfig> = {
          status: "success",
          data: mockConfig,
        };
        return HttpResponse.json(response);
      }),
    );
  });

  it("shows loading state while fetching lease data", () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, () => {
        return new Promise(() => {});
      }),
    );

    renderComponent();

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows error state when lease fails to load", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, () => {
        return HttpResponse.json(
          { status: "error", message: "Failed to load lease" },
          { status: 500 },
        );
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText("There was a problem loading this lease."),
      ).toBeInTheDocument();
    });
  });

  it("shows error state when config fails to load", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () => {
        return HttpResponse.json(
          { status: "error", message: "Failed to load config" },
          { status: 500 },
        );
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText("There was a problem loading configuration settings."),
      ).toBeInTheDocument();
    });
  });

  it("renders the edit form with toggle initialized to false", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Sharing Settings")).toBeInTheDocument();
    });

    const toggle = screen.getByRole("checkbox");
    expect(toggle).not.toBeChecked();
    expect(screen.getByText("Sharing disabled")).toBeInTheDocument();
  });

  it("renders toggle initialized to true when lease has sharing enabled", async () => {
    const leaseWithSharing = {
      ...mockLease,
      allowOwnerToShareLease: true,
    };

    server.use(
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, () => {
        const response: ApiResponse<MonitoredLeaseWithLeaseId> = {
          status: "success",
          data: leaseWithSharing as MonitoredLeaseWithLeaseId,
        };
        return HttpResponse.json(response);
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Sharing Settings")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByRole("checkbox")).toBeChecked();
    });
    expect(screen.getByText("Sharing enabled")).toBeInTheDocument();
  });

  it("disables toggle when leaseSharingEnabled is false globally", async () => {
    const configWithSharingDisabled = {
      ...mockConfig,
      leases: {
        ...mockConfig.leases,
        leaseSharingEnabled: false,
      },
    };

    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () => {
        const response: ApiResponse<typeof configWithSharingDisabled> = {
          status: "success",
          data: configWithSharingDisabled,
        };
        return HttpResponse.json(response);
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Sharing Settings")).toBeInTheDocument();
    });

    const toggle = screen.getByRole("checkbox");
    expect(toggle).toBeDisabled();
    expect(
      screen.getByText(
        "Lease sharing is globally disabled. Enable it in the global configuration to allow owners to share leases.",
      ),
    ).toBeInTheDocument();

    // Save button should also be disabled since toggle can't be changed (form stays pristine)
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    expect(saveButton).toBeDisabled();
  });

  it("submits form with allowOwnerToShareLease: true", async () => {
    let submittedData: any = null;

    server.use(
      http.patch(
        `${getConfig().ApiUrl}/leases/lease-123`,
        async ({ request }) => {
          submittedData = await request.json();
          return HttpResponse.json({ status: "success", data: {} });
        },
      ),
    );

    const user = userEvent.setup();
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Sharing Settings")).toBeInTheDocument();
    });

    // Toggle from false to true
    const toggle = screen.getByRole("checkbox");
    await user.click(toggle);

    await waitFor(() => {
      expect(toggle).toBeChecked();
    });

    // Submit
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    await waitFor(() => {
      expect(saveButton).not.toBeDisabled();
    });
    await user.click(saveButton);

    await waitFor(() => {
      expect(submittedData).toEqual({
        allowOwnerToShareLease: true,
      });
      expect(mockedShowSuccessToast).toHaveBeenCalledWith(
        "Sharing settings updated successfully.",
      );
      expect(mockNavigate).toHaveBeenCalledWith("/leases/lease-123");
    });
  });

  it("submits form with allowOwnerToShareLease: false", async () => {
    let submittedData: any = null;

    const leaseWithSharing = {
      ...mockLease,
      allowOwnerToShareLease: true,
    };

    server.use(
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, () => {
        const response: ApiResponse<MonitoredLeaseWithLeaseId> = {
          status: "success",
          data: leaseWithSharing as MonitoredLeaseWithLeaseId,
        };
        return HttpResponse.json(response);
      }),
      http.patch(
        `${getConfig().ApiUrl}/leases/lease-123`,
        async ({ request }) => {
          submittedData = await request.json();
          return HttpResponse.json({ status: "success", data: {} });
        },
      ),
    );

    const user = userEvent.setup();
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Sharing Settings")).toBeInTheDocument();
    });

    // Toggle from true to false
    const toggle = screen.getByRole("checkbox");
    await waitFor(() => {
      expect(toggle).toBeChecked();
    });
    await user.click(toggle);

    await waitFor(() => {
      expect(toggle).not.toBeChecked();
    });

    // Submit
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    await waitFor(() => {
      expect(saveButton).not.toBeDisabled();
    });
    await user.click(saveButton);

    await waitFor(() => {
      expect(submittedData).toEqual({
        allowOwnerToShareLease: false,
      });
      expect(mockedShowSuccessToast).toHaveBeenCalledWith(
        "Sharing settings updated successfully.",
      );
      expect(mockNavigate).toHaveBeenCalledWith("/leases/lease-123");
    });
  });

  it("shows error toast when submission fails", async () => {
    server.use(
      http.patch(`${getConfig().ApiUrl}/leases/lease-123`, () => {
        return HttpResponse.json(
          { status: "error", message: "Network error" },
          { status: 500 },
        );
      }),
    );

    const user = userEvent.setup();
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Sharing Settings")).toBeInTheDocument();
    });

    // Toggle to make form dirty
    const toggle = screen.getByRole("checkbox");
    await user.click(toggle);

    // Submit
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    await waitFor(() => {
      expect(saveButton).not.toBeDisabled();
    });
    await user.click(saveButton);

    await waitFor(() => {
      expect(mockedShowErrorToast).toHaveBeenCalledWith(
        expect.stringContaining("Failed to update sharing settings"),
        "Update Failed",
      );
    });

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("navigates back on cancel", async () => {
    const user = userEvent.setup();
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Sharing Settings")).toBeInTheDocument();
    });

    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    await user.click(cancelButton);

    expect(mockNavigate).toHaveBeenCalledWith("/leases/lease-123");
  });

  it("disables save button when form is not dirty", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Sharing Settings")).toBeInTheDocument();
    });

    const saveButton = screen.getByRole("button", { name: "Save changes" });
    expect(saveButton).toBeDisabled();
  });
});
