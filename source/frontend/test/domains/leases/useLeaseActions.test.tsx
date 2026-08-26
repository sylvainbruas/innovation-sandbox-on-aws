// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { renderHook } from "@testing-library/react";
import { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  Lease,
  LeaseWithLeaseId,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { useLeaseActions } from "@amzn/innovation-sandbox-frontend/domains/leases/useLeaseActions";
import { ModalProvider } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import { createConfiguration } from "@amzn/innovation-sandbox-frontend/mocks/factories/configurationFactory";
import {
  createActiveLease,
  createExpiredLease,
  createPendingLease,
} from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";

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

// createConfiguration shallow-merges the leases override onto schema defaults,
// so a per-test override can flip a single field; spread this base and flip one.
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

const adminUser = {
  ...ownerUser,
  roles: ["Admin" as const],
};

const managerUser = {
  ...ownerUser,
  roles: ["Manager" as const],
};

const withLeaseId = (lease: Lease): LeaseWithLeaseId => ({
  ...lease,
  leaseId: "encoded-lease-id",
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <ModalProvider>{children}</ModalProvider>
);

const renderActions = (
  lease: LeaseWithLeaseId | undefined,
  options?: { includeElevatedActions?: boolean },
) => renderHook(() => useLeaseActions(lease, options), { wrapper });

describe("useLeaseActions", () => {
  beforeEach(() => {
    mockUseUser.mockReset();
    mockUseGetConfigurations.mockReset();
    mockUseUser.mockReturnValue({ user: ownerUser });
    mockUseGetConfigurations.mockReturnValue({
      data: createConfiguration({ leases: defaultLeasesConfig }),
    });
  });

  test("reports no actions for a lease that is neither active nor pending", () => {
    const { result } = renderActions(withLeaseId(createExpiredLease()));

    expect(result.current.hasAnyAction).toBe(false);
    expect(result.current.canTerminate).toBe(false);
  });

  test("reports no actions when the lease is undefined", () => {
    // Callers invoke the hook before the lease has loaded (Rules of Hooks
    // require it run unconditionally), so undefined must be tolerated.
    const { result } = renderActions(undefined);

    expect(result.current.hasAnyAction).toBe(false);
  });

  test("reports an action for an active lease (login applies)", () => {
    const { result } = renderActions(withLeaseId(createActiveLease()));

    expect(result.current.hasAnyAction).toBe(true);
  });

  test("reports an action for a pending lease (pending indicator applies)", () => {
    const { result } = renderActions(withLeaseId(createPendingLease()));

    expect(result.current.hasAnyAction).toBe(true);
  });

  test("allows terminate when owner, active, and feature enabled", () => {
    const { result } = renderActions(
      withLeaseId(createActiveLease({ userEmail: ownerEmail })),
    );

    expect(result.current.canTerminate).toBe(true);
  });

  test("forbids terminate for a non-owner", () => {
    const { result } = renderActions(
      withLeaseId(createActiveLease({ userEmail: "someone-else@example.com" })),
    );

    expect(result.current.canTerminate).toBe(false);
  });

  test("forbids terminate when the feature is disabled", () => {
    mockUseGetConfigurations.mockReturnValue({
      data: createConfiguration({
        leases: { ...defaultLeasesConfig, allowUserLeaseTermination: false },
      }),
    });
    const { result } = renderActions(
      withLeaseId(createActiveLease({ userEmail: ownerEmail })),
    );

    expect(result.current.canTerminate).toBe(false);
  });

  test("forbids terminate while configuration is still loading", () => {
    // useGetConfigurations returns undefined data until the query resolves; an
    // owner of an active lease must not see terminate before config loads.
    mockUseGetConfigurations.mockReturnValue({ data: undefined });
    const { result } = renderActions(
      withLeaseId(createActiveLease({ userEmail: ownerEmail })),
    );

    expect(result.current.canTerminate).toBe(false);
    expect(result.current.hasAnyAction).toBe(true); // login still applies
  });

  describe("assignment lock gating", () => {
    const liveLock = (intent?: string) => ({
      ownerId: "assignment-execution",
      acquiredAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...(intent ? { meta: { intent: intent as "UPDATE" } } : {}),
    });

    beforeEach(() => {
      mockUseUser.mockReturnValue({ user: adminUser, isAdmin: true });
    });

    test("blocks unfreeze while any live lock is held", () => {
      // UNFREEZE is non-critical, so the API rejects it against any live lock.
      const { result } = renderActions(
        withLeaseId(
          createActiveLease({
            status: "Frozen",
            resourceLock: liveLock("UPDATE"),
          }),
        ),
        { includeElevatedActions: true },
      );

      expect(result.current.canUnfreeze).toBe(true); // still rendered
      expect(result.current.unfreezeDisabledReason).toContain(
        "Assignment processing is in progress",
      );
    });

    test("allows freeze to preempt a lock held for an overridable intent", () => {
      const { result } = renderActions(
        withLeaseId(createActiveLease({ resourceLock: liveLock("UPDATE") })),
        { includeElevatedActions: true },
      );

      expect(result.current.canFreeze).toBe(true);
      expect(result.current.freezeDisabledReason).toBeUndefined();
    });

    test("blocks freeze and terminate while a termination is in progress", () => {
      const { result } = renderActions(
        withLeaseId(createActiveLease({ resourceLock: liveLock("TERMINATE") })),
        { includeElevatedActions: true },
      );

      expect(result.current.freezeDisabledReason).toContain(
        "already in progress",
      );
      expect(result.current.terminateDisabledReason).toContain(
        "A termination is already in progress",
      );
    });

    test("keeps terminate available while a freeze is in progress", () => {
      // Terminate is the escape hatch: an in-flight freeze must not stop an
      // operator from terminating the lease.
      const { result } = renderActions(
        withLeaseId(createActiveLease({ resourceLock: liveLock("FREEZE") })),
        { includeElevatedActions: true },
      );

      expect(result.current.canTerminate).toBe(true);
      expect(result.current.terminateDisabledReason).toBeUndefined();
      // Freeze itself is still blocked — a freeze cannot preempt a freeze.
      expect(result.current.freezeDisabledReason).toContain(
        "already in progress",
      );
    });

    test("keeps terminate available while an overridable lock is held", () => {
      const { result } = renderActions(
        withLeaseId(createActiveLease({ resourceLock: liveLock("UPDATE") })),
        { includeElevatedActions: true },
      );

      expect(result.current.terminateDisabledReason).toBeUndefined();
    });

    test("ignores an expired lock so a stuck execution does not block actions", () => {
      const expired = {
        ...liveLock("TERMINATE"),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      };
      const { result } = renderActions(
        withLeaseId(createActiveLease({ resourceLock: expired })),
        { includeElevatedActions: true },
      );

      expect(result.current.freezeDisabledReason).toBeUndefined();
      expect(result.current.terminateDisabledReason).toBeUndefined();
    });

    test("reports no disabled reasons when no lock is held", () => {
      const { result } = renderActions(withLeaseId(createActiveLease()), {
        includeElevatedActions: true,
      });

      expect(result.current.freezeDisabledReason).toBeUndefined();
      expect(result.current.unfreezeDisabledReason).toBeUndefined();
      expect(result.current.terminateDisabledReason).toBeUndefined();
    });

    test("does not open the unfreeze modal while blocked", () => {
      const { result } = renderActions(
        withLeaseId(
          createActiveLease({
            status: "Frozen",
            resourceLock: liveLock("UPDATE"),
          }),
        ),
        { includeElevatedActions: true },
      );

      // Defense in depth: the button is disabled, but the opener must also
      // no-op if invoked programmatically.
      expect(() => result.current.openUnfreezeModal()).not.toThrow();
    });
  });

  describe("elevated terminate", () => {
    test("allows an admin to terminate an active lease they do not own", () => {
      mockUseUser.mockReturnValue({ user: adminUser, isAdmin: true });
      const { result } = renderActions(
        withLeaseId(
          createActiveLease({ userEmail: "someone-else@example.com" }),
        ),
        { includeElevatedActions: true },
      );

      expect(result.current.canTerminate).toBe(true);
    });

    test("allows an admin to terminate a frozen lease", () => {
      mockUseUser.mockReturnValue({ user: adminUser, isAdmin: true });
      const { result } = renderActions(
        withLeaseId(createActiveLease({ status: "Frozen" })),
        { includeElevatedActions: true },
      );

      expect(result.current.canTerminate).toBe(true);
    });

    test("allows a manager to terminate a frozen lease", () => {
      mockUseUser.mockReturnValue({ user: managerUser, isManager: true });
      const { result } = renderActions(
        withLeaseId(createActiveLease({ status: "Frozen" })),
        { includeElevatedActions: true },
      );

      expect(result.current.canTerminate).toBe(true);
    });

    test("forbids an admin from terminating a provisioning lease", () => {
      // The API permits it, but the leases list restricts terminate to active
      // or frozen leases and the details page matches that.
      mockUseUser.mockReturnValue({ user: adminUser, isAdmin: true });
      const { result } = renderActions(
        withLeaseId(createActiveLease({ status: "Provisioning" })),
        { includeElevatedActions: true },
      );

      expect(result.current.canTerminate).toBe(false);
    });

    test("forbids the owner from terminating their own frozen lease", () => {
      // The API returns 403 when a user-only caller targets a Frozen lease, so
      // the button must not appear for a non-elevated owner.
      const { result } = renderActions(
        withLeaseId(
          createActiveLease({ userEmail: ownerEmail, status: "Frozen" }),
        ),
        { includeElevatedActions: true },
      );

      expect(result.current.canTerminate).toBe(false);
    });

    test("forbids elevated terminate when includeElevatedActions is not passed", () => {
      mockUseUser.mockReturnValue({ user: adminUser, isAdmin: true });
      const { result } = renderActions(
        withLeaseId(createActiveLease({ status: "Frozen" })),
      );

      expect(result.current.canTerminate).toBe(false);
      expect(result.current.hasAnyAction).toBe(false);
    });
  });

  describe("freeze / unfreeze", () => {
    test("allows freeze for an admin on an active lease", () => {
      mockUseUser.mockReturnValue({ user: adminUser, isAdmin: true });
      const { result } = renderActions(withLeaseId(createActiveLease()), {
        includeElevatedActions: true,
      });

      expect(result.current.canFreeze).toBe(true);
      expect(result.current.canUnfreeze).toBe(false);
    });

    test("allows unfreeze for a manager on a frozen lease", () => {
      mockUseUser.mockReturnValue({ user: managerUser, isManager: true });
      const { result } = renderActions(
        withLeaseId(createActiveLease({ status: "Frozen" })),
        { includeElevatedActions: true },
      );

      expect(result.current.canUnfreeze).toBe(true);
      expect(result.current.canFreeze).toBe(false);
    });

    test("forbids both for a non-elevated user", () => {
      // ownerUser holds only the User role.
      const { result } = renderActions(withLeaseId(createActiveLease()), {
        includeElevatedActions: true,
      });

      expect(result.current.canFreeze).toBe(false);
      expect(result.current.canUnfreeze).toBe(false);
    });

    test("forbids both when includeElevatedActions is not passed", () => {
      // Being an admin is not sufficient: the calling component must also ask
      // for these controls. The home LeasePanel card passes no options, so it
      // keeps its existing action set even for an admin.
      mockUseUser.mockReturnValue({ user: adminUser, isAdmin: true });
      const { result } = renderActions(withLeaseId(createActiveLease()));

      expect(result.current.canFreeze).toBe(false);
      expect(result.current.canUnfreeze).toBe(false);
    });

    test("reports an action for a frozen lease with includeElevatedActions", () => {
      // A frozen lease has no login/terminate/pending action, so unfreeze is
      // the only thing keeping hasAnyAction true here.
      mockUseUser.mockReturnValue({ user: adminUser, isAdmin: true });
      const frozenLease = withLeaseId(createActiveLease({ status: "Frozen" }));

      expect(renderActions(frozenLease).result.current.hasAnyAction).toBe(
        false,
      );
      expect(
        renderActions(frozenLease, { includeElevatedActions: true }).result
          .current.hasAnyAction,
      ).toBe(true);
    });
  });
});
