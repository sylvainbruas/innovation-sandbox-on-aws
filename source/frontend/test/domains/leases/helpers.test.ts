// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";

import {
  ExpiredLease,
  Lease,
  MonitoredLease,
} from "@amzn/innovation-sandbox-commons/data/lease/lease";
import {
  enrichLeasesWithName,
  getLeaseDisplayName,
  getLeaseStatusDisplayName,
  isAssignmentLockActive,
  isCriticalAssignmentLockActive,
  isTerminationLockActive,
  leaseExpirySortingComparator,
} from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";
import {
  createActiveLease,
  createExpiredLease,
  createPendingLease,
} from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";

describe("leaseExpirySortingComparator", () => {
  const now = DateTime.now();

  it("should sort monitored leases by expirationDate chronologically", () => {
    const earlier = createActiveLease({
      expirationDate: now.plus({ days: 1 }).toISO()!,
    });
    const later = createActiveLease({
      expirationDate: now.plus({ days: 30 }).toISO()!,
    });

    const leases: MonitoredLease[] = [later, earlier];
    leases.sort(leaseExpirySortingComparator);

    expect(leases[0]).toBe(earlier);
    expect(leases[1]).toBe(later);
  });

  it("should sort expired leases by endDate chronologically", () => {
    const earlier = createExpiredLease({
      endDate: now.minus({ days: 30 }).toISO()!,
    });
    const later = createExpiredLease({
      endDate: now.minus({ days: 1 }).toISO()!,
    });

    const leases: ExpiredLease[] = [later, earlier];
    leases.sort(leaseExpirySortingComparator);

    expect(leases[0]).toBe(earlier);
    expect(leases[1]).toBe(later);
  });

  it("should sort pending leases by durationInHours", () => {
    const short = createPendingLease({ leaseDurationInHours: 2 });
    const long = createPendingLease({ leaseDurationInHours: 48 });

    const leases: Lease[] = [long, short];
    leases.sort(leaseExpirySortingComparator);

    expect(leases[0]).toBe(short);
    expect(leases[1]).toBe(long);
  });

  it("should sort monitored leases before pending leases when expiry is sooner", () => {
    const active = createActiveLease({
      expirationDate: now.plus({ hours: 1 }).toISO()!,
    });
    const pending = createPendingLease({ leaseDurationInHours: 48 });

    const leases: Lease[] = [pending, active];
    leases.sort(leaseExpirySortingComparator);

    expect(leases[0]).toBe(active);
    expect(leases[1]).toBe(pending);
  });

  it("should sort expired leases before pending leases", () => {
    const expired = createExpiredLease({
      endDate: now.minus({ days: 7 }).toISO()!,
    });
    const pending = createPendingLease({ leaseDurationInHours: 1 });

    const leases: Lease[] = [pending, expired];
    leases.sort(leaseExpirySortingComparator);

    expect(leases[0]).toBe(expired);
    expect(leases[1]).toBe(pending);
  });

  it("should handle mixed lease states and sort correctly", () => {
    const expired = createExpiredLease({
      endDate: now.minus({ days: 30 }).toISO()!,
    });
    const active = createActiveLease({
      expirationDate: now.plus({ days: 7 }).toISO()!,
    });
    const pending = createPendingLease({ leaseDurationInHours: 720 });

    const leases: Lease[] = [pending, active, expired];
    leases.sort(leaseExpirySortingComparator);

    // expired (past) < active (now+7d) < pending (now+720h ≈ 30d)
    expect(leases[0]).toBe(expired);
    expect(leases[1]).toBe(active);
    expect(leases[2]).toBe(pending);
  });

  it("should return 0 for two leases with the same date", () => {
    const date = now.plus({ days: 5 }).toISO()!;
    const a = createActiveLease({ expirationDate: date });
    const b = createActiveLease({ expirationDate: date });

    expect(leaseExpirySortingComparator(a, b)).toBe(0);
  });
});

describe("getLeaseStatusDisplayName", () => {
  it("returns 'Terminated by User' for UserTerminated", () => {
    expect(getLeaseStatusDisplayName("UserTerminated")).toBe(
      "Terminated by User",
    );
  });

  it("returns 'Lease Manually Terminated' for ManuallyTerminated", () => {
    expect(getLeaseStatusDisplayName("ManuallyTerminated")).toBe(
      "Lease Manually Terminated",
    );
  });
});

describe("getLeaseDisplayName", () => {
  it("returns templateName (first8) format", () => {
    expect(
      getLeaseDisplayName({
        uuid: "abcdefgh-1234-5678-9012-ijklmnopqrst",
        originalLeaseTemplateName: "Developer Sandbox",
      }),
    ).toBe("Developer Sandbox (abcdefgh)");
  });

  it("uses only the first 8 characters of the uuid", () => {
    expect(
      getLeaseDisplayName({
        uuid: "12345678-abcd-efgh-ijkl-mnopqrstuvwx",
        originalLeaseTemplateName: "Test",
      }),
    ).toBe("Test (12345678)");
  });
});

describe("enrichLeasesWithName", () => {
  it("adds a name field to each lease", () => {
    const leases = [
      {
        uuid: "aaaaaaaa-1111-2222-3333-444444444444",
        originalLeaseTemplateName: "Dev Sandbox",
      },
      {
        uuid: "bbbbbbbb-5555-6666-7777-888888888888",
        originalLeaseTemplateName: "Prod Sandbox",
      },
    ];

    const enriched = enrichLeasesWithName(leases);

    expect(enriched[0].name).toBe("Dev Sandbox (aaaaaaaa)");
    expect(enriched[1].name).toBe("Prod Sandbox (bbbbbbbb)");
  });

  it("preserves all original fields", () => {
    const lease = {
      uuid: "cccccccc-1234-5678-9012-dddddddddddd",
      originalLeaseTemplateName: "My Template",
      status: "Active",
      userEmail: "user@example.com",
    };

    const [enriched] = enrichLeasesWithName([lease]);

    expect(enriched.uuid).toBe(lease.uuid);
    expect(enriched.status).toBe("Active");
    expect(enriched.userEmail).toBe("user@example.com");
    expect(enriched.name).toBe("My Template (cccccccc)");
  });

  it("returns empty array for empty input", () => {
    expect(enrichLeasesWithName([])).toEqual([]);
  });
});

const lock = (expiresAt: string, intent?: string) => ({
  ownerId: "assignment-execution",
  acquiredAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt,
  ...(intent ? { meta: { intent: intent as "UPDATE" } } : {}),
});

describe("isAssignmentLockActive", () => {
  it("is false when the lease has no resource lock", () => {
    expect(
      isAssignmentLockActive(createActiveLease({ resourceLock: undefined })),
    ).toBe(false);
  });

  it("is false when the resource lock is explicitly null", () => {
    // The API returns null (not undefined) once the processor clears the lock.
    expect(
      isAssignmentLockActive(createActiveLease({ resourceLock: null })),
    ).toBe(false);
  });

  it("is true while the lock has not expired", () => {
    expect(
      isAssignmentLockActive(
        createActiveLease({
          resourceLock: lock(new Date(Date.now() + 60_000).toISOString()),
        }),
      ),
    ).toBe(true);
  });

  it("is false once the lock has expired (the stuck-execution case)", () => {
    // The backend acquire condition also treats an expired lock as free, so a
    // stuck Step Function execution must not permanently block actions.
    expect(
      isAssignmentLockActive(
        createActiveLease({
          resourceLock: lock(new Date(Date.now() - 60_000).toISOString()),
        }),
      ),
    ).toBe(false);
  });
});

describe("isCriticalAssignmentLockActive", () => {
  const future = () => new Date(Date.now() + 60_000).toISOString();

  it.each(["TERMINATE", "FREEZE"])(
    "is true for a live %s lock (cannot be preempted)",
    (intent) => {
      expect(
        isCriticalAssignmentLockActive(
          createActiveLease({ resourceLock: lock(future(), intent) }),
        ),
      ).toBe(true);
    },
  );

  it.each(["UPDATE", "PUBLISH", "UNFREEZE"])(
    "is false for a live %s lock (a critical operation preempts it)",
    (intent) => {
      expect(
        isCriticalAssignmentLockActive(
          createActiveLease({ resourceLock: lock(future(), intent) }),
        ),
      ).toBe(false);
    },
  );

  it("is false when the lock carries no intent", () => {
    expect(
      isCriticalAssignmentLockActive(
        createActiveLease({ resourceLock: lock(future()) }),
      ),
    ).toBe(false);
  });

  it("is false for an expired critical lock", () => {
    expect(
      isCriticalAssignmentLockActive(
        createActiveLease({
          resourceLock: lock(
            new Date(Date.now() - 60_000).toISOString(),
            "FREEZE",
          ),
        }),
      ),
    ).toBe(false);
  });
});

describe("isTerminationLockActive", () => {
  const future = () => new Date(Date.now() + 60_000).toISOString();

  it("is true for a live TERMINATE lock", () => {
    expect(
      isTerminationLockActive(
        createActiveLease({ resourceLock: lock(future(), "TERMINATE") }),
      ),
    ).toBe(true);
  });

  it("is false for a live FREEZE lock so terminate stays available", () => {
    // Terminate is the escape hatch and is intentionally narrower than
    // isCriticalAssignmentLockActive, which does block on FREEZE.
    const lease = createActiveLease({
      resourceLock: lock(future(), "FREEZE"),
    });

    expect(isTerminationLockActive(lease)).toBe(false);
    expect(isCriticalAssignmentLockActive(lease)).toBe(true);
  });

  it.each(["UPDATE", "PUBLISH", "UNFREEZE"])(
    "is false for a live %s lock",
    (intent) => {
      expect(
        isTerminationLockActive(
          createActiveLease({ resourceLock: lock(future(), intent) }),
        ),
      ).toBe(false);
    },
  );

  it("is false for an expired TERMINATE lock", () => {
    expect(
      isTerminationLockActive(
        createActiveLease({
          resourceLock: lock(
            new Date(Date.now() - 60_000).toISOString(),
            "TERMINATE",
          ),
        }),
      ),
    ).toBe(false);
  });

  it("is false when there is no lock", () => {
    expect(
      isTerminationLockActive(createActiveLease({ resourceLock: undefined })),
    ).toBe(false);
  });
});
