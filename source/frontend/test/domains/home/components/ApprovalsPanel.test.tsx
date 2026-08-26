// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";

import { ApprovalsPanel } from "@amzn/innovation-sandbox-frontend/domains/home/components/ApprovalsPanel";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { createPendingLease } from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import { mockLeaseApi } from "@amzn/innovation-sandbox-frontend/mocks/mockApi";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

// Mock ResizeObserver
class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

window.ResizeObserver = ResizeObserver;

// Mock the useNavigate hook
const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe("ApprovalsPanel", () => {
  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <ApprovalsPanel />
      </Router>,
    );

  test("renders the header", async () => {
    renderComponent();

    expect(screen.getByText("Approvals")).toBeInTheDocument();
  });

  test("displays loading state while fetching approvals", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leases`, () => {
        return new Promise((resolve) =>
          setTimeout(() => resolve(HttpResponse.json([])), 100),
        );
      }),
    );

    renderComponent();

    expect(
      screen.getByText("Checking for approval requests..."),
    ).toBeInTheDocument();
  });

  test("displays success message when there are no pending approvals", async () => {
    mockLeaseApi.returns([]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText("No pending approvals. Nothing to review."),
      ).toBeInTheDocument();
    });
  });

  test("displays warning with number of pending approvals", async () => {
    const mockPendingLeases = [createPendingLease(), createPendingLease()];
    mockLeaseApi.returns(mockPendingLeases);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Pending approvals")).toBeInTheDocument();
      expect(
        screen.getByText((content) => content.includes("There are")),
      ).toBeInTheDocument();
      expect(
        screen.getByText((content) => content.includes("2")),
      ).toBeInTheDocument();
      expect(
        screen.getByText((content) => content.includes("pending approvals")),
      ).toBeInTheDocument();
      expect(screen.getByText("View approvals")).toBeInTheDocument();
    });
  });

  test("navigates to approvals page when 'View approvals' button is clicked", async () => {
    const mockPendingLeases = [createPendingLease()];
    mockLeaseApi.returns(mockPendingLeases);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("View approvals")).toBeInTheDocument();
    });

    const viewApprovalsButton = screen.getByText("View approvals");
    await userEvent.click(viewApprovalsButton);

    expect(mockNavigate).toHaveBeenCalledWith("/approvals");
  });

  test("handles error state", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leases`, () => {
        return HttpResponse.json(
          { status: "error", message: "Internal Server Error" },
          { status: 500 },
        );
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText("Approvals could not be loaded."),
      ).toBeInTheDocument();
      expect(screen.getByText("Try again")).toBeInTheDocument();
    });
  });
});
