// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TerminateLeaseConfirmationModal } from "@amzn/innovation-sandbox-frontend/domains/leases/components/TerminateLeaseConfirmationModal";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const mockTerminateLease = vi.fn();
vi.mock(
  "@amzn/innovation-sandbox-frontend/domains/leases/hooks",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@amzn/innovation-sandbox-frontend/domains/leases/hooks")
      >();
    return {
      ...actual,
      useTerminateLease: () => ({
        mutateAsync: mockTerminateLease,
        isPending: false,
      }),
    };
  },
);

vi.mock("@amzn/innovation-sandbox-frontend/components/Toast", () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
}));

// leaseId is the opaque base64 composite key the API expects; uuid is the
// human-readable identifier shown everywhere else (e.g. LeaseSummary).
const leaseId =
  "eyJ1c2VyRW1haWwiOiJ1c2VyQGV4YW1wbGUuY29tIiwidXVpZCI6ImxlYXNlLTEyMyJ9";
const uuid = "lease-123";
const accountId = "123456789012";

describe("TerminateLeaseConfirmationModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("displays the human-readable lease uuid, not the base64 composite key", () => {
    renderWithQueryClient(
      <TerminateLeaseConfirmationModal
        leaseId={leaseId}
        uuid={uuid}
        accountId={accountId}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(uuid)).toBeInTheDocument();
    expect(screen.queryByText(leaseId)).not.toBeInTheDocument();
  });

  it("terminates using the base64 composite key, not the uuid", async () => {
    const user = userEvent.setup();
    mockTerminateLease.mockResolvedValueOnce(undefined);

    renderWithQueryClient(
      <TerminateLeaseConfirmationModal
        leaseId={leaseId}
        uuid={uuid}
        accountId={accountId}
        onClose={vi.fn()}
      />,
    );

    await user.type(screen.getByRole("textbox"), "terminate");
    await user.click(screen.getByRole("button", { name: "Terminate Lease" }));

    await waitFor(() => {
      expect(mockTerminateLease).toHaveBeenCalledWith(leaseId);
    });
  });
});
