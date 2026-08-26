// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";

import { LEASE_NOT_PENDING_REVIEW_ERROR } from "@amzn/innovation-sandbox-commons/data/lease/lease";
import {
  ListApprovals,
  reconcileSelectedRequests,
} from "@amzn/innovation-sandbox-frontend/domains/leases/pages/ListApprovals";
import { ModalProvider } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
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

// Mock the useBreadcrumb hook
vi.mock("@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb", () => ({
  useBreadcrumb: () => vi.fn(),
}));

describe("ListApprovals", () => {
  const renderComponent = () =>
    renderWithQueryClient(
      <ModalProvider>
        <BrowserRouter>
          <ListApprovals />
        </BrowserRouter>
      </ModalProvider>,
    );

  const mockPendingLease = createPendingLease();

  describe("reconcileSelectedRequests", () => {
    const leaseA = { ...createPendingLease(), leaseId: "lease-a" } as any;
    const leaseB = { ...createPendingLease(), leaseId: "lease-b" } as any;

    test("drops selections that are no longer pending", () => {
      // leaseA was approved elsewhere and is absent from the latest fetch.
      expect(reconcileSelectedRequests([leaseA, leaseB], [leaseB])).toEqual([
        leaseB,
      ]);
    });

    test("returns the same reference when every selection is still pending", () => {
      const selected = [leaseA, leaseB];
      // Same array reference avoids a needless re-render.
      expect(reconcileSelectedRequests(selected, [leaseA, leaseB])).toBe(
        selected,
      );
    });

    test("clears all selections when none remain pending", () => {
      expect(reconcileSelectedRequests([leaseA, leaseB], [])).toEqual([]);
    });
  });

  test("renders the header correctly", async () => {
    renderComponent();
    const wrapper = createWrapper();
    const header = wrapper.findHeader();
    expect(header?.findHeadingText()?.getElement()).toHaveTextContent(
      "Approvals",
    );
    expect(header?.findDescription()?.getElement()).toHaveTextContent(
      "Manage requests to lease sandbox accounts",
    );
  });

  test("displays pending approvals when they exist", async () => {
    const mockPendingLeases = [createPendingLease(), createPendingLease()];
    mockLeaseApi.returns(mockPendingLeases);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText(mockPendingLeases[0].userEmail),
      ).toBeInTheDocument();
      expect(
        screen.getByText(mockPendingLeases[1].userEmail),
      ).toBeInTheDocument();
      expect(
        screen.getByText(mockPendingLeases[0].originalLeaseTemplateName),
      ).toBeInTheDocument();
      expect(
        screen.getByText(mockPendingLeases[1].originalLeaseTemplateName),
      ).toBeInTheDocument();
    });
  });

  test("displays 'No items to display' when no pending approvals", async () => {
    mockLeaseApi.returns([]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      const wrapper = createWrapper();
      const table = wrapper.findTable();
      expect(table?.findEmptySlot()?.getElement()).toHaveTextContent(
        "No items to display",
      );
    });
  });

  test("allows selecting and deselecting requests", async () => {
    mockLeaseApi.returns([mockPendingLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(mockPendingLease.userEmail)).toBeInTheDocument();
    });
    const wrapper = createWrapper();
    const table = wrapper.findTable();
    const checkbox = table?.findRowSelectionArea(1)?.findCheckbox();

    await userEvent.click(checkbox!.getElement());
    expect(table?.findSelectedRows()).toHaveLength(1);

    await userEvent.click(checkbox!.getElement());

    expect(table?.findSelectedRows()).toHaveLength(0);
  });

  test("shows modal when approve action is clicked", async () => {
    mockLeaseApi.returns([mockPendingLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(mockPendingLease.userEmail)).toBeInTheDocument();
    });

    const wrapper = createWrapper();
    const table = wrapper.findTable();
    const rows = table?.findRows();
    await userEvent.click(
      rows![0].getElement().querySelector('input[type="checkbox"]')!,
    );

    const actionButton = wrapper.findButtonDropdown();
    await userEvent.click(actionButton!.findNativeButton().getElement());

    const approveButton = screen.getByText("Approve request(s)");
    await userEvent.click(approveButton);

    const modal = screen.getByRole("dialog");
    await waitFor(() => {
      expect(modal).toBeInTheDocument();
    });

    const modalContent = within(modal);

    expect(modalContent.getByText("Approve request(s)")).toBeInTheDocument();

    await waitFor(() =>
      expect(
        modalContent.getByText(mockPendingLease.userEmail),
      ).toBeInTheDocument(),
    );
  });

  test("shows modal when deny action is clicked", async () => {
    mockLeaseApi.returns([mockPendingLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(mockPendingLease.userEmail)).toBeInTheDocument();
    });

    const wrapper = createWrapper();
    const table = wrapper.findTable();
    const rows = table?.findRows();
    await userEvent.click(
      rows![0].getElement().querySelector('input[type="checkbox"]')!,
    );

    const actionButton = wrapper.findButtonDropdown();
    await userEvent.click(actionButton!.findNativeButton().getElement());

    const approveButton = screen.getByText("Deny request(s)");
    await userEvent.click(approveButton);

    const modal = screen.getByRole("dialog");
    await waitFor(() => {
      expect(modal).toBeInTheDocument();
    });

    const modalContent = within(modal);

    expect(modalContent.getByText("Deny request(s)")).toBeInTheDocument();

    await waitFor(() =>
      expect(
        modalContent.getByText(mockPendingLease.userEmail),
      ).toBeInTheDocument(),
    );
  });

  test("displays comments in table", async () => {
    const leaseWithComments = createPendingLease({
      comments: "Need this for testing project",
    });
    mockLeaseApi.returns([leaseWithComments]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText("Need this for testing project"),
      ).toBeInTheDocument();
    });
  });

  test("displays shared principals count when lease has desired assignments", async () => {
    // desiredAssignments includes the owner as the first entry,
    // so 4 entries = owner + 3 shared principals
    const leaseWithAssignments = createPendingLease({
      desiredAssignments: [
        { principalId: "owner-1", principalType: "USER" },
        { principalId: "user-1", principalType: "USER" },
        { principalId: "group-1", principalType: "GROUP" },
        { principalId: "user-2", principalType: "USER" },
      ],
    });
    const leaseWithId = { ...leaseWithAssignments, leaseId: "test-lease-123" };
    mockLeaseApi.returns([leaseWithId] as any);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("3 principals")).toBeInTheDocument();
    });

    const link = screen.getByText("3 principals").closest("a");
    expect(link).toHaveAttribute(
      "href",
      "/approvals/test-lease-123?tab=sharing",
    );
  });

  test("displays dash when lease has no desired assignments", async () => {
    const leaseWithoutAssignments = createPendingLease({
      desiredAssignments: undefined,
    });
    mockLeaseApi.returns([leaseWithoutAssignments]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText(leaseWithoutAssignments.userEmail),
      ).toBeInTheDocument();
    });

    // The "Shared with" column should show "-" when no assignments
    const wrapper = createWrapper();
    const table = wrapper.findTable();
    const bodyCell = table?.findBodyCell(1, 6);
    expect(bodyCell?.getElement()).toHaveTextContent("-");
  });

  test("displays dash when lease has only the owner in desired assignments", async () => {
    // Only the owner entry (no additional shared principals)
    const leaseWithOwnerOnly = createPendingLease({
      desiredAssignments: [{ principalId: "owner-1", principalType: "USER" }],
    });
    mockLeaseApi.returns([leaseWithOwnerOnly]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText(leaseWithOwnerOnly.userEmail),
      ).toBeInTheDocument();
    });

    const wrapper = createWrapper();
    const table = wrapper.findTable();
    const bodyCell = table?.findBodyCell(1, 6);
    expect(bodyCell?.getElement()).toHaveTextContent("-");
  });

  test("displays singular principal text for single shared assignment", async () => {
    // Owner + 1 shared = 2 entries, displays "1 principal"
    const leaseWithOneShared = createPendingLease({
      desiredAssignments: [
        { principalId: "owner-1", principalType: "USER" },
        { principalId: "user-2", principalType: "USER" },
      ],
    });
    mockLeaseApi.returns([leaseWithOneShared]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("1 principal")).toBeInTheDocument();
    });
  });

  test("successfully approves lease requests", async () => {
    const { http, HttpResponse } = await import("msw");
    const { getConfig } =
      await import("@amzn/innovation-sandbox-frontend/helpers/config");

    server.use(
      http.post(`${getConfig().ApiUrl}/leases/:leaseId/review`, () => {
        return HttpResponse.json({
          status: "success",
          data: {},
        });
      }),
    );

    mockLeaseApi.returns([mockPendingLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(mockPendingLease.userEmail)).toBeInTheDocument();
    });

    const wrapper = createWrapper();
    const table = wrapper.findTable();
    const rows = table?.findRows();
    await userEvent.click(
      rows![0].getElement().querySelector('input[type="checkbox"]')!,
    );

    const actionButton = wrapper.findButtonDropdown();
    await userEvent.click(actionButton!.findNativeButton().getElement());

    const approveButton = screen.getByText("Approve request(s)");
    await userEvent.click(approveButton);

    const modal = screen.getByRole("dialog");
    await waitFor(() => {
      expect(modal).toBeInTheDocument();
    });

    const submitButton = within(modal).getByRole("button", {
      name: /Submit/i,
    });
    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText("Success")).toBeInTheDocument();
    });
  });

  test("successfully denies lease requests", async () => {
    const { http, HttpResponse } = await import("msw");
    const { getConfig } =
      await import("@amzn/innovation-sandbox-frontend/helpers/config");

    server.use(
      http.post(`${getConfig().ApiUrl}/leases/:leaseId/review`, () => {
        return HttpResponse.json({
          status: "success",
          data: {},
        });
      }),
    );

    mockLeaseApi.returns([mockPendingLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(mockPendingLease.userEmail)).toBeInTheDocument();
    });

    const wrapper = createWrapper();
    const table = wrapper.findTable();
    const rows = table?.findRows();
    await userEvent.click(
      rows![0].getElement().querySelector('input[type="checkbox"]')!,
    );

    const actionButton = wrapper.findButtonDropdown();
    await userEvent.click(actionButton!.findNativeButton().getElement());

    const denyButton = screen.getByText("Deny request(s)");
    await userEvent.click(denyButton);

    const modal = screen.getByRole("dialog");
    await waitFor(() => {
      expect(modal).toBeInTheDocument();
    });

    const submitButton = within(modal).getByRole("button", {
      name: /Submit/i,
    });
    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText("Success")).toBeInTheDocument();
    });
  });

  test("treats an already-reviewed lease (benign 409) as success, not failure", async () => {
    const { http, HttpResponse } = await import("msw");
    const { getConfig } =
      await import("@amzn/innovation-sandbox-frontend/helpers/config");

    // The lease was approved in another session and is no longer pending.
    server.use(
      http.post(`${getConfig().ApiUrl}/leases/:leaseId/review`, () => {
        return HttpResponse.json(
          {
            status: "fail",
            data: { errors: [{ message: LEASE_NOT_PENDING_REVIEW_ERROR }] },
          },
          { status: 409 },
        );
      }),
    );

    mockLeaseApi.returns([mockPendingLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(mockPendingLease.userEmail)).toBeInTheDocument();
    });

    const wrapper = createWrapper();
    const table = wrapper.findTable();
    const rows = table?.findRows();
    await userEvent.click(
      rows![0].getElement().querySelector('input[type="checkbox"]')!,
    );

    const actionButton = wrapper.findButtonDropdown();
    await userEvent.click(actionButton!.findNativeButton().getElement());

    const approveButton = screen.getByText("Approve request(s)");
    await userEvent.click(approveButton);

    const modal = screen.getByRole("dialog");
    await waitFor(() => {
      expect(modal).toBeInTheDocument();
    });

    const submitButton = within(modal).getByRole("button", {
      name: /Submit/i,
    });
    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText("Success")).toBeInTheDocument();
    });
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
  });

  test("surfaces a non-benign 409 (no accounts available) as failure", async () => {
    const { http, HttpResponse } = await import("msw");
    const { getConfig } =
      await import("@amzn/innovation-sandbox-frontend/helpers/config");

    // A different 409 than the "not pending" one must NOT be skipped.
    server.use(
      http.post(`${getConfig().ApiUrl}/leases/:leaseId/review`, () => {
        return HttpResponse.json(
          {
            status: "fail",
            data: {
              errors: [
                {
                  message:
                    "There are no more sandbox accounts available. Please contact your administrator.",
                },
              ],
            },
          },
          { status: 409 },
        );
      }),
    );

    mockLeaseApi.returns([mockPendingLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(mockPendingLease.userEmail)).toBeInTheDocument();
    });

    const wrapper = createWrapper();
    const table = wrapper.findTable();
    const rows = table?.findRows();
    await userEvent.click(
      rows![0].getElement().querySelector('input[type="checkbox"]')!,
    );

    const actionButton = wrapper.findButtonDropdown();
    await userEvent.click(actionButton!.findNativeButton().getElement());

    const approveButton = screen.getByText("Approve request(s)");
    await userEvent.click(approveButton);

    const modal = screen.getByRole("dialog");
    await waitFor(() => {
      expect(modal).toBeInTheDocument();
    });

    const submitButton = within(modal).getByRole("button", {
      name: /Submit/i,
    });
    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText("Failed")).toBeInTheDocument();
    });
  });

  test("handles approval failure and shows error", async () => {
    const { http, HttpResponse } = await import("msw");
    const { getConfig } =
      await import("@amzn/innovation-sandbox-frontend/helpers/config");

    server.use(
      http.post(`${getConfig().ApiUrl}/leases/:leaseId/review`, () => {
        return HttpResponse.json(
          {
            status: "error",
            message: "Failed to approve lease",
          },
          { status: 500 },
        );
      }),
    );

    mockLeaseApi.returns([mockPendingLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(mockPendingLease.userEmail)).toBeInTheDocument();
    });

    const wrapper = createWrapper();
    const table = wrapper.findTable();
    const rows = table?.findRows();
    await userEvent.click(
      rows![0].getElement().querySelector('input[type="checkbox"]')!,
    );

    const actionButton = wrapper.findButtonDropdown();
    await userEvent.click(actionButton!.findNativeButton().getElement());

    const approveButton = screen.getByText("Approve request(s)");
    await userEvent.click(approveButton);

    const modal = screen.getByRole("dialog");
    await waitFor(() => {
      expect(modal).toBeInTheDocument();
    });

    const submitButton = within(modal).getByRole("button", {
      name: /Submit/i,
    });
    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText("Failed")).toBeInTheDocument();
    });
  });
});
