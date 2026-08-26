// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, test } from "vitest";

import { ApprovalsBadge } from "@amzn/innovation-sandbox-frontend/domains/leases/components/ApprovalsBadge";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import {
  createActiveLease,
  createExpiredLease,
  createPendingLease,
} from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import { mockLeaseApi } from "@amzn/innovation-sandbox-frontend/mocks/mockApi";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

describe("ApprovalsBadge", () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  beforeEach(() => {
    queryClient.clear();
  });

  const renderComponent = () =>
    renderWithQueryClient(
      <QueryClientProvider client={queryClient}>
        <ApprovalsBadge />
      </QueryClientProvider>,
    );

  test("renders badge with correct count when pending approvals exist", async () => {
    const pendingLeases = [createPendingLease(), createPendingLease()];
    mockLeaseApi.returns(pendingLeases);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      const badge = screen.getByText("2");
      expect(badge).toBeInTheDocument();
    });
  });

  test("does not render badge when no pending approvals exist", async () => {
    mockLeaseApi.returns([]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
  });

  test("handles error when fetching leases fails", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leases`, () => {
        return HttpResponse.json(
          { status: "error", message: "Failed to fetch leases" },
          { status: 500 },
        );
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
  });

  test("updates badge count when pending approvals change", async () => {
    const initialPendingLeases = [createPendingLease(), createPendingLease()];
    mockLeaseApi.returns(initialPendingLeases);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("2")).toBeInTheDocument();
    });

    const updatedPendingLeases = [createPendingLease()];
    mockLeaseApi.returns(updatedPendingLeases);
    server.use(mockLeaseApi.getHandler());

    // Invalidate the cache to trigger a refetch with the new mock data
    await queryClient.invalidateQueries({ queryKey: ["leases"] });

    await waitFor(() => {
      expect(screen.getByText("1")).toBeInTheDocument();
    });
  });

  test("handles large number of pending approvals", async () => {
    const manyPendingLeases = Array(100)
      .fill(null)
      .map(() => createPendingLease());
    mockLeaseApi.returns(manyPendingLeases);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("100")).toBeInTheDocument();
    });
  });

  test("does not count non-pending leases", async () => {
    const mixedLeases = [
      createPendingLease(),
      createActiveLease(),
      createExpiredLease(),
      createPendingLease(),
    ];
    mockLeaseApi.returns(mixedLeases);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("2")).toBeInTheDocument();
    });
  });
});
