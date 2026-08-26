// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  Lease,
  LeaseWithLeaseId,
} from "@amzn/innovation-sandbox-commons/data/lease/lease";
import { useBulkLeaseActions } from "@amzn/innovation-sandbox-frontend/domains/leases/components/useBulkLeaseActions";
import { ModalProvider } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import { createActiveLease } from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import { createQueryClientWrapper } from "@amzn/innovation-sandbox-frontend/setupTests";

const mockUseUser = vi.fn();
vi.mock("@amzn/innovation-sandbox-frontend/hooks/useUser", () => ({
  useUser: () => mockUseUser(),
}));

const withLeaseId = (lease: Lease): LeaseWithLeaseId => ({
  ...lease,
  leaseId: "encoded-lease-id",
});

const liveLock = (intent?: string) => ({
  ownerId: "assignment-execution",
  acquiredAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...(intent ? { meta: { intent: intent as "UPDATE" } } : {}),
});

/**
 * Renders the hook, applies a selection, then mounts the returned header
 * actions and opens the dropdown so item disabled state can be asserted.
 */
async function openActionsFor(selected: LeaseWithLeaseId[]) {
  const QueryWrapper = createQueryClientWrapper();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryWrapper>
      <MemoryRouter>
        <ModalProvider>{children}</ModalProvider>
      </MemoryRouter>
    </QueryWrapper>
  );

  const { result, rerender } = renderHook(() => useBulkLeaseActions(), {
    wrapper: Wrapper,
  });

  act(() => result.current.onSelectionChange!(selected));
  rerender();

  render(<Wrapper>{result.current.headerActions}</Wrapper>);

  await userEvent.click(screen.getByRole("button", { name: /Actions/ }));
}

const itemFor = (name: string) => screen.getByRole("menuitem", { name });

describe("useBulkLeaseActions lock gating", () => {
  beforeEach(() => {
    mockUseUser.mockReset();
    mockUseUser.mockReturnValue({ isAdmin: true, isManager: false });
  });

  test("disables Unfreeze when a selected frozen lease holds any live lock", async () => {
    await openActionsFor([
      withLeaseId(
        createActiveLease({
          status: "Frozen",
          resourceLock: liveLock("UPDATE"),
        }),
      ),
    ]);

    expect(itemFor("Unfreeze")).toHaveAttribute("aria-disabled", "true");
  });

  test("enables Unfreeze for a frozen lease with no lock", async () => {
    await openActionsFor([
      withLeaseId(
        createActiveLease({ status: "Frozen", resourceLock: undefined }),
      ),
    ]);

    expect(itemFor("Unfreeze")).not.toHaveAttribute("aria-disabled", "true");
  });

  test("lets Freeze preempt an overridable lock but not a critical one", async () => {
    await openActionsFor([
      withLeaseId(createActiveLease({ resourceLock: liveLock("UPDATE") })),
    ]);
    expect(itemFor("Freeze")).not.toHaveAttribute("aria-disabled", "true");
  });

  test("disables Freeze when a selected lease holds a critical lock", async () => {
    await openActionsFor([
      withLeaseId(createActiveLease({ resourceLock: liveLock("FREEZE") })),
    ]);

    expect(itemFor("Freeze")).toHaveAttribute("aria-disabled", "true");
    // Terminate stays available during a freeze — it is the escape hatch.
    expect(itemFor("Terminate")).not.toHaveAttribute("aria-disabled", "true");
  });

  test("disables Terminate only while a termination is in progress", async () => {
    await openActionsFor([
      withLeaseId(createActiveLease({ resourceLock: liveLock("TERMINATE") })),
    ]);

    expect(itemFor("Terminate")).toHaveAttribute("aria-disabled", "true");
  });

  test("ignores an expired lock", async () => {
    await openActionsFor([
      withLeaseId(
        createActiveLease({
          status: "Frozen",
          resourceLock: {
            ...liveLock("FREEZE"),
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
          },
        }),
      ),
    ]);

    expect(itemFor("Unfreeze")).not.toHaveAttribute("aria-disabled", "true");
  });
});
