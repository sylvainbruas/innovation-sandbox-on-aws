// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  AllLeaseStatusSchema,
  ApprovalDeniedLeaseSchema,
  ExpiredLease,
  ExpiredLeaseSchema,
  LeaseSchema,
  MonitoredLease,
  MonitoredLeaseSchema,
  PendingLease,
  PendingLeaseSchema,
  isActiveLease,
  isApprovalDeniedLease,
  isExpiredLease,
  isFrozenLease,
  isMonitoredLease,
  isPendingLease,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  ResourceLockSchema,
  type ResourceLock,
} from "@amzn/innovation-sandbox-commons/data/resource-lock.js";

const baseMeta = {
  meta: { schemaVersion: 4, createdTime: "2024-01-01T00:00:00Z" },
};

const basePendingLease: PendingLease = {
  userEmail: "user@example.com",
  uuid: "550e8400-e29b-41d4-a716-446655440000",
  status: "PendingApproval" as const,
  originalLeaseTemplateUuid: "660e8400-e29b-41d4-a716-446655440001",
  originalLeaseTemplateName: "Default Template",
  ...baseMeta,
};

const baseMonitoredLease: MonitoredLease = {
  ...basePendingLease,
  status: "Active" as const,
  awsAccountId: "123456789012",
  approvedBy: "admin@example.com",
  startDate: "2024-01-01T00:00:00Z",
  lastCheckedDate: "2024-01-01T00:00:00Z",
  totalCostAccrued: 0,
};

const baseExpiredLease: ExpiredLease = {
  ...baseMonitoredLease,
  status: "Expired" as const,
  endDate: "2024-02-01T00:00:00Z",
  ttl: 1706745600,
};

const validResourceLock: ResourceLock = {
  ownerId:
    "arn:aws:states:us-east-1:123456789012:execution:AssignmentProcessor:exec-123",
  acquiredAt: "2024-01-01T00:00:00Z",
  expiresAt: "2024-01-01T00:15:00Z",
  meta: { intent: "UPDATE" },
};

describe("PendingLeaseSchema", () => {
  it("should accept a minimal valid pending lease", () => {
    const result = PendingLeaseSchema.safeParse(basePendingLease);
    expect(result.success).toBe(true);
  });

  it("should accept pending lease with all optional fields", () => {
    const result = PendingLeaseSchema.safeParse({
      ...basePendingLease,
      comments: "Test comment",
      createdBy: "creator@example.com",
      maxSpend: 100,
      leaseDurationInHours: 24,
      budgetThresholds: [{ dollarsSpent: 50, action: "ALERT" }],
      durationThresholds: [{ hoursRemaining: 2, action: "ALERT" }],
      costReportGroup: "team-a",
      blueprintId: "770e8400-e29b-41d4-a716-446655440002",
      blueprintName: "TestBlueprint",
      allowOwnerToShareLease: true,
      resourceLock: validResourceLock,
    });
    expect(result.success).toBe(true);
  });

  it.each(["not-an-email", "", "missing-at-sign"])(
    "should reject invalid userEmail: %s",
    (userEmail) => {
      const result = PendingLeaseSchema.safeParse({
        ...basePendingLease,
        userEmail,
      });
      expect(result.success).toBe(false);
    },
  );

  it.each(["not-a-uuid", "", "12345"])(
    "should reject invalid uuid: %s",
    (uuid) => {
      const result = PendingLeaseSchema.safeParse({
        ...basePendingLease,
        uuid,
      });
      expect(result.success).toBe(false);
    },
  );

  it("should reject invalid status", () => {
    const result = PendingLeaseSchema.safeParse({
      ...basePendingLease,
      status: "InvalidStatus",
    });
    expect(result.success).toBe(false);
  });

  it.each([1, 2, 3, 4])("should accept schema version %i", (version) => {
    const result = PendingLeaseSchema.safeParse({
      ...basePendingLease,
      meta: { schemaVersion: version },
    });
    expect(result.success).toBe(true);
  });

  it.each([0, 5, -1])("should reject schema version %i", (version) => {
    const result = PendingLeaseSchema.safeParse({
      ...basePendingLease,
      meta: { schemaVersion: version },
    });
    expect(result.success).toBe(false);
  });
});

describe("Lease blueprintId validation", () => {
  it("should accept blueprintId=null", () => {
    const result = PendingLeaseSchema.safeParse({
      ...basePendingLease,
      blueprintId: null,
      blueprintName: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.blueprintId).toBeNull();
    }
  });

  it("should accept blueprintId=undefined (field absent from DynamoDB read)", () => {
    const result = PendingLeaseSchema.safeParse({
      ...basePendingLease,
      // blueprintId intentionally omitted
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.blueprintId).toBeUndefined();
    }
  });

  it("should accept blueprintId as valid UUID", () => {
    const blueprintId = "660e8400-e29b-41d4-a716-446655440001";
    const result = PendingLeaseSchema.safeParse({
      ...basePendingLease,
      blueprintId,
      blueprintName: "TestBlueprint",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.blueprintId).toBe(blueprintId);
    }
  });

  it("should reject blueprintId with invalid UUID format", () => {
    const result = PendingLeaseSchema.safeParse({
      ...basePendingLease,
      blueprintId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });
});

describe("Lease allowOwnerToShareLease validation", () => {
  it("should accept allowOwnerToShareLease=true", () => {
    const result = PendingLeaseSchema.safeParse({
      ...basePendingLease,
      allowOwnerToShareLease: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowOwnerToShareLease).toBe(true);
    }
  });

  it("should accept allowOwnerToShareLease=false", () => {
    const result = PendingLeaseSchema.safeParse({
      ...basePendingLease,
      allowOwnerToShareLease: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowOwnerToShareLease).toBe(false);
    }
  });

  it("should accept allowOwnerToShareLease=undefined (backward compatible)", () => {
    const result = PendingLeaseSchema.safeParse(basePendingLease);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowOwnerToShareLease).toBeUndefined();
    }
  });

  it("should reject non-boolean value", () => {
    const result = PendingLeaseSchema.safeParse({
      ...basePendingLease,
      allowOwnerToShareLease: "yes",
    });
    expect(result.success).toBe(false);
  });

  it("should propagate to MonitoredLeaseSchema", () => {
    const result = MonitoredLeaseSchema.safeParse({
      ...baseMonitoredLease,
      allowOwnerToShareLease: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowOwnerToShareLease).toBe(true);
    }
  });

  it("should propagate to ExpiredLeaseSchema", () => {
    const result = ExpiredLeaseSchema.safeParse({
      ...baseExpiredLease,
      allowOwnerToShareLease: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowOwnerToShareLease).toBe(false);
    }
  });
});

describe("ResourceLockSchema", () => {
  it("should accept valid resource lock", () => {
    const result = ResourceLockSchema.safeParse(validResourceLock);
    expect(result.success).toBe(true);
  });

  it("should accept lock without meta", () => {
    const { meta: _, ...withoutMeta } = validResourceLock;
    const result = ResourceLockSchema.safeParse(withoutMeta);
    expect(result.success).toBe(true);
  });

  it("should accept lock with arbitrary meta keys", () => {
    const result = ResourceLockSchema.safeParse({
      ...validResourceLock,
      meta: { type: "REVOKE", intent: "TERMINATE", reason: "lease-expired" },
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ["empty ownerId", { ...validResourceLock, ownerId: "" }],
    ["invalid acquiredAt", { ...validResourceLock, acquiredAt: "not-a-date" }],
    ["invalid expiresAt", { ...validResourceLock, expiresAt: "not-a-date" }],
    [
      "extra fields (strict)",
      { ...validResourceLock, extraField: "should-fail" },
    ],
  ])("should reject %s", (_label, input) => {
    const result = ResourceLockSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe("Lease resourceLock field validation", () => {
  it("should accept resourceLock with valid data", () => {
    const result = PendingLeaseSchema.safeParse({
      ...basePendingLease,
      resourceLock: validResourceLock,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resourceLock).toEqual(validResourceLock);
    }
  });

  it("should accept resourceLock=null (cleared after completion)", () => {
    const result = PendingLeaseSchema.safeParse({
      ...basePendingLease,
      resourceLock: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resourceLock).toBeNull();
    }
  });

  it("should accept resourceLock=undefined (no lock ever acquired)", () => {
    const result = PendingLeaseSchema.safeParse(basePendingLease);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resourceLock).toBeUndefined();
    }
  });

  it("should reject resourceLock with invalid nested data", () => {
    const result = PendingLeaseSchema.safeParse({
      ...basePendingLease,
      resourceLock: { ...validResourceLock, ownerId: "" },
    });
    expect(result.success).toBe(false);
  });

  it("should propagate to MonitoredLeaseSchema", () => {
    const result = MonitoredLeaseSchema.safeParse({
      ...baseMonitoredLease,
      resourceLock: validResourceLock,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resourceLock).toEqual(validResourceLock);
    }
  });
});

describe("ApprovalDeniedLeaseSchema", () => {
  it("should accept valid denied lease", () => {
    const result = ApprovalDeniedLeaseSchema.safeParse({
      ...basePendingLease,
      status: "ApprovalDenied",
      ttl: 1706745600,
    });
    expect(result.success).toBe(true);
  });

  it("should require ttl", () => {
    const result = ApprovalDeniedLeaseSchema.safeParse({
      ...basePendingLease,
      status: "ApprovalDenied",
    });
    expect(result.success).toBe(false);
  });
});

describe("MonitoredLeaseSchema", () => {
  it.each(["Active", "Frozen", "Provisioning"])(
    "should accept %s status",
    (status) => {
      const result = MonitoredLeaseSchema.safeParse({
        ...baseMonitoredLease,
        status,
      });
      expect(result.success).toBe(true);
    },
  );

  it("should accept AUTO_APPROVED as approvedBy", () => {
    const result = MonitoredLeaseSchema.safeParse({
      ...baseMonitoredLease,
      approvedBy: "AUTO_APPROVED",
    });
    expect(result.success).toBe(true);
  });

  it("should require awsAccountId as 12-digit string", () => {
    const result = MonitoredLeaseSchema.safeParse({
      ...baseMonitoredLease,
      awsAccountId: "12345",
    });
    expect(result.success).toBe(false);
  });

  it("should accept optional expirationDate", () => {
    const result = MonitoredLeaseSchema.safeParse({
      ...baseMonitoredLease,
      expirationDate: "2024-02-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });
});

describe("ExpiredLeaseSchema", () => {
  it("should accept valid expired lease", () => {
    const result = ExpiredLeaseSchema.safeParse(baseExpiredLease);
    expect(result.success).toBe(true);
  });

  it.each([
    "Expired",
    "BudgetExceeded",
    "ManuallyTerminated",
    "UserTerminated",
    "AccountQuarantined",
    "Ejected",
    "ProvisioningFailed",
  ])("should accept %s status", (status) => {
    const result = ExpiredLeaseSchema.safeParse({
      ...baseExpiredLease,
      status,
    });
    expect(result.success).toBe(true);
  });

  it("should require endDate", () => {
    const { endDate: _, ...withoutEndDate } = baseExpiredLease;
    const result = ExpiredLeaseSchema.safeParse(withoutEndDate);
    expect(result.success).toBe(false);
  });

  it("should require ttl", () => {
    const { ttl: _, ...withoutTtl } = baseExpiredLease;
    const result = ExpiredLeaseSchema.safeParse(withoutTtl);
    expect(result.success).toBe(false);
  });
});

describe("LeaseSchema (discriminated union)", () => {
  it("should parse PendingApproval as PendingLease", () => {
    const result = LeaseSchema.safeParse(basePendingLease);
    expect(result.success).toBe(true);
  });

  it("should parse Active as MonitoredLease", () => {
    const result = LeaseSchema.safeParse(baseMonitoredLease);
    expect(result.success).toBe(true);
  });

  it("should parse Expired as ExpiredLease", () => {
    const result = LeaseSchema.safeParse(baseExpiredLease);
    expect(result.success).toBe(true);
  });

  it("should reject unknown status", () => {
    const result = LeaseSchema.safeParse({
      ...basePendingLease,
      status: "Unknown",
    });
    expect(result.success).toBe(false);
  });
});

describe("AllLeaseStatusSchema", () => {
  const allStatuses = [
    "PendingApproval",
    "ApprovalDenied",
    "Active",
    "Frozen",
    "Provisioning",
    "Expired",
    "BudgetExceeded",
    "ManuallyTerminated",
    "UserTerminated",
    "AccountQuarantined",
    "Ejected",
    "ProvisioningFailed",
  ];

  it.each(allStatuses)("should accept %s", (status) => {
    expect(AllLeaseStatusSchema.safeParse(status).success).toBe(true);
  });

  it("should reject invalid status", () => {
    expect(AllLeaseStatusSchema.safeParse("Invalid").success).toBe(false);
  });
});

describe("Type guard functions", () => {
  it("isPendingLease identifies PendingApproval", () => {
    const lease = LeaseSchema.parse(basePendingLease);
    expect(isPendingLease(lease)).toBe(true);
    expect(isMonitoredLease(lease)).toBe(false);
    expect(isExpiredLease(lease)).toBe(false);
  });

  it("isApprovalDeniedLease identifies ApprovalDenied", () => {
    const lease = LeaseSchema.parse({
      ...basePendingLease,
      status: "ApprovalDenied",
      ttl: 1706745600,
    });
    expect(isApprovalDeniedLease(lease)).toBe(true);
    expect(isPendingLease(lease)).toBe(false);
  });

  it("isMonitoredLease identifies Active", () => {
    const lease = LeaseSchema.parse(baseMonitoredLease);
    expect(isMonitoredLease(lease)).toBe(true);
    expect(isActiveLease(lease)).toBe(true);
    expect(isFrozenLease(lease)).toBe(false);
  });

  it("isFrozenLease identifies Frozen", () => {
    const lease = LeaseSchema.parse({
      ...baseMonitoredLease,
      status: "Frozen",
    });
    expect(isFrozenLease(lease)).toBe(true);
    expect(isActiveLease(lease)).toBe(false);
    expect(isMonitoredLease(lease)).toBe(true);
  });

  it("isExpiredLease identifies Expired", () => {
    const lease = LeaseSchema.parse(baseExpiredLease);
    expect(isExpiredLease(lease)).toBe(true);
    expect(isMonitoredLease(lease)).toBe(false);
  });
});
