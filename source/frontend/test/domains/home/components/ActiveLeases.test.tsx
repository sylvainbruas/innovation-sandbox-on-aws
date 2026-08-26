// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { ActiveLeases } from "@amzn/innovation-sandbox-frontend/domains/home/components/ActiveLeases";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import {
  createActiveLease,
  createExpiredLease,
} from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import { mockLeaseApi } from "@amzn/innovation-sandbox-frontend/mocks/mockApi";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

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

// Mock useLeaseActions to avoid needing ModalProvider context
vi.mock(
  "@amzn/innovation-sandbox-frontend/domains/leases/useLeaseActions",
  () => ({
    useLeaseActions: () => ({ hasAnyAction: false }),
  }),
);

describe("ActiveLeases", () => {
  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <ActiveLeases />
      </Router>,
    );

  const sharedLeasesHandler = (result: any[] = []) =>
    http.get(`${getConfig().ApiUrl}/leases/shared`, () =>
      HttpResponse.json({
        status: "success",
        data: { result, nextPageIdentifier: null },
      }),
    );

  beforeEach(() => {
    // Provide default shared leases handler returning empty
    server.use(sharedLeasesHandler());
  });

  test("renders owned active leases", async () => {
    const lease = createActiveLease({
      userEmail: "test@example.com",
      originalLeaseTemplateName: "My Owned Lease",
      awsAccountId: "111111111111",
    });
    mockLeaseApi.returns([lease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("My Owned Lease")).toBeInTheDocument();
    });
  });

  test("renders shared leases (direct + group merged)", async () => {
    const directLease = {
      ...createActiveLease({
        userEmail: "owner@example.com",
        originalLeaseTemplateName: "DirectTemplate",
      }),
      leaseId: "direct-lease-id",
    };
    const groupLease = {
      ...createActiveLease({
        userEmail: "other@example.com",
        originalLeaseTemplateName: "GroupTemplate",
      }),
      leaseId: "group-lease-id",
    };

    mockLeaseApi.returns([]);
    server.use(
      mockLeaseApi.getHandler(),
      http.get(`${getConfig().ApiUrl}/leases/shared`, ({ request }) => {
        const url = new URL(request.url);
        const type = url.searchParams.get("accessType");
        if (type === "direct") {
          return HttpResponse.json({
            status: "success",
            data: { result: [directLease], nextPageIdentifier: null },
          });
        }
        return HttpResponse.json({
          status: "success",
          data: { result: [groupLease], nextPageIdentifier: null },
        });
      }),
    );

    renderComponent();

    await waitFor(
      () => {
        // LeaseName renders as heading h3 with format "templateName (uuid8)"
        const headings = screen.getAllByRole("heading", { level: 3 });
        const headingTexts = headings.map((h) => h.textContent);
        expect(headingTexts.some((t) => t?.includes("DirectTemplate"))).toBe(
          true,
        );
        expect(headingTexts.some((t) => t?.includes("GroupTemplate"))).toBe(
          true,
        );
      },
      { timeout: 3000 },
    );
  });

  test("deduplicates owned vs shared (owned takes priority)", async () => {
    const ownedLease = {
      ...createActiveLease({
        userEmail: "test@example.com",
        originalLeaseTemplateName: "OwnedTpl",
      }),
      leaseId: "shared-lease-id",
    };
    const sharedLease = {
      ...createActiveLease({
        originalLeaseTemplateName: "SharedTpl",
        uuid: ownedLease.uuid,
      }),
      leaseId: "shared-lease-id",
    };

    mockLeaseApi.returns([ownedLease]);
    server.use(
      mockLeaseApi.getHandler(),
      http.get(`${getConfig().ApiUrl}/leases/shared`, ({ request }) => {
        const url = new URL(request.url);
        const type = url.searchParams.get("accessType");
        if (type === "direct") {
          return HttpResponse.json({
            status: "success",
            data: { result: [sharedLease], nextPageIdentifier: null },
          });
        }
        return HttpResponse.json({
          status: "success",
          data: { result: [], nextPageIdentifier: null },
        });
      }),
    );

    renderComponent();

    await waitFor(() => {
      const headings = screen.getAllByRole("heading", { level: 3 });
      const headingTexts = headings.map((h) => h.textContent);
      // Owned version should be present (owned takes priority in dedup)
      expect(headingTexts.some((t) => t?.includes("OwnedTpl"))).toBe(true);
    });

    // Shared version should not appear since it has the same leaseId
    const headings = screen.getAllByRole("heading", { level: 3 });
    const headingTexts = headings.map((h) => h.textContent);
    expect(headingTexts.some((t) => t?.includes("SharedTpl"))).toBe(false);
    // Only one lease card total
    expect(headings).toHaveLength(1);
  });

  test("filters out expired/terminated leases (only active statuses shown)", async () => {
    const activeLease = createActiveLease({
      userEmail: "test@example.com",
      originalLeaseTemplateName: "Active Lease",
      status: "Active",
    });
    const expiredLease = createExpiredLease({
      userEmail: "test@example.com",
      originalLeaseTemplateName: "Expired Lease",
    });
    const terminatedLease = createExpiredLease({
      userEmail: "test@example.com",
      originalLeaseTemplateName: "Terminated Lease",
      status: "ManuallyTerminated",
    });

    mockLeaseApi.returns([activeLease, expiredLease, terminatedLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText("Active Lease", { exact: false }),
      ).toBeInTheDocument();
    });

    expect(
      screen.queryByText("Expired Lease", { exact: false }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Terminated Lease", { exact: false }),
    ).not.toBeInTheDocument();
  });

  test("shows empty state with 'Request lease' button when no active leases", async () => {
    mockLeaseApi.returns([]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText("You currently don't have any active leases."),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByRole("button", { name: "Request lease" }),
    ).toBeInTheDocument();
  });

  test("shows error state with retry button", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leases`, () =>
        HttpResponse.json(
          { status: "error", message: "Internal Server Error" },
          { status: 500 },
        ),
      ),
    );

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText("Your leases can't be retrieved at the moment."),
      ).toBeInTheDocument();
    });

    expect(screen.getByText("Try again")).toBeInTheDocument();
  });

  test("shows loading state", async () => {
    // Delay response long enough to observe loading
    server.use(
      http.get(`${getConfig().ApiUrl}/leases`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return HttpResponse.json({
          status: "success",
          data: { result: [], nextPageIdentifier: null },
        });
      }),
      http.get(`${getConfig().ApiUrl}/leases/shared`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return HttpResponse.json({
          status: "success",
          data: { result: [], nextPageIdentifier: null },
        });
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Loading leases...")).toBeInTheDocument();
    });
  });

  test("refresh button triggers refetch", async () => {
    const user = userEvent.setup();
    let fetchCount = 0;

    const lease = createActiveLease({
      userEmail: "test@example.com",
      originalLeaseTemplateName: "Refreshable Lease",
      awsAccountId: "888888888888",
    });

    server.use(
      http.get(`${getConfig().ApiUrl}/leases`, ({ request }) => {
        fetchCount++;
        const authHeader = request.headers.get("Authorization");
        const identityHeader = request.headers.get("x-isb-identity");
        if (!authHeader || !identityHeader) {
          return new HttpResponse(null, { status: 401 });
        }
        return HttpResponse.json({
          status: "success",
          data: { result: [lease], nextPageIdentifier: null },
        });
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Refreshable Lease")).toBeInTheDocument();
    });

    const initialCount = fetchCount;

    const refreshButton = screen.getByLabelText("Refresh");
    await user.click(refreshButton);

    await waitFor(() => {
      expect(fetchCount).toBeGreaterThan(initialCount);
    });
  });

  test("displays counter with number of active leases", async () => {
    const lease1 = {
      ...createActiveLease({ userEmail: "test@example.com" }),
      leaseId: "lease-id-1",
    };
    const lease2 = {
      ...createActiveLease({ userEmail: "test@example.com" }),
      leaseId: "lease-id-2",
    };

    mockLeaseApi.returns([lease1, lease2]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("(2)")).toBeInTheDocument();
    });
  });
});
