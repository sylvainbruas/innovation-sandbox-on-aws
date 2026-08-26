// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  CONFIG_CONSTRAINTS,
  ConfigSchemas,
  ConfigWriteSchemas,
} from "@amzn/innovation-sandbox-frontend/domains/settings/validation";

// A complete, valid leases write payload reused across tests. Individual tests
// override single fields to exercise specific rules.
const validLeases = {
  requireMaxBudget: true,
  maxBudget: 50,
  requireMaxDuration: true,
  maxDurationHours: 168,
  maxLeasesPerUser: 3,
  ttl: 30,
  allowUserLeaseTermination: true,
  leaseRequestWindowHours: 168,
  maxLeaseRequestsPerWindow: 10,
  leaseSharingEnabled: false,
  enablePrincipalSearch: true,
};

const validWritePayloads = {
  leases: validLeases,
  cleanup: {
    numberOfFailedAttemptsToCancelCleanup: 3,
    waitBeforeRetryFailedAttemptSeconds: 5,
    numberOfSuccessfulAttemptsToFinishCleanup: 2,
    waitBeforeRerunSuccessfulAttemptSeconds: 30,
    validation: { failureAction: "Quarantine" },
    cooldownPeriodHours: 0,
    reportRetentionDays: 730,
  },
  notification: { emailFrom: "admin@example.com" },
  maintenance: { enabled: false },
  termsOfService: { content: "Some terms" },
  costReporting: { costReportGroups: ["team-a"], requireCostReportGroup: true },
} as const;

describe("settings validation re-exports", () => {
  it("exposes all six sections on both read and write schema maps", () => {
    const sections = [
      "leases",
      "cleanup",
      "notification",
      "maintenance",
      "termsOfService",
      "costReporting",
    ] as const;
    for (const section of sections) {
      expect(ConfigSchemas[section]).toBeDefined();
      expect(ConfigWriteSchemas[section]).toBeDefined();
    }
  });
});

describe("read schemas (defaults-first)", () => {
  it("produces a full code-default object when parsing an empty object", () => {
    const leases = ConfigSchemas.leases.parse({});
    expect(leases).toMatchObject({
      requireMaxBudget: true,
      maxBudget: 50,
      ttl: 30,
      maxLeasesPerUser: 3,
      enablePrincipalSearch: true,
      leaseSharingEnabled: false,
    });
  });

  it("defaults maintenance.enabled to true (fresh installs start in maintenance mode)", () => {
    expect(ConfigSchemas.maintenance.parse({})).toEqual({ enabled: true });
  });

  it("defaults costReporting to an empty, non-required group list", () => {
    expect(ConfigSchemas.costReporting.parse({})).toEqual({
      costReportGroups: [],
      requireCostReportGroup: false,
    });
  });
});

describe("write schemas accept valid payloads", () => {
  for (const [section, payload] of Object.entries(validWritePayloads)) {
    it(`accepts a valid ${section} payload`, () => {
      const schema =
        ConfigWriteSchemas[section as keyof typeof ConfigWriteSchemas];
      expect(schema.safeParse(payload).success).toBe(true);
    });
  }

  it("requires every leases field (no defaults applied on write)", () => {
    const { maxBudget, ...missingOneField } = validLeases;
    void maxBudget;
    expect(ConfigWriteSchemas.leases.safeParse(missingOneField).success).toBe(
      false,
    );
  });
});

describe("leases field constraints", () => {
  it("rejects maxBudget above the maximum bound", () => {
    const result = ConfigWriteSchemas.leases.safeParse({
      ...validLeases,
      maxBudget: CONFIG_CONSTRAINTS.MAX_BUDGET + 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects maxDurationHours above the maximum bound", () => {
    const result = ConfigWriteSchemas.leases.safeParse({
      ...validLeases,
      maxDurationHours: CONFIG_CONSTRAINTS.MAX_DURATION_HOURS + 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects maxLeasesPerUser below 1 (zero would block all leases)", () => {
    const result = ConfigWriteSchemas.leases.safeParse({
      ...validLeases,
      maxLeasesPerUser: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects ttl below 1 (zero causes immediate TTL deletion)", () => {
    const result = ConfigWriteSchemas.leases.safeParse({
      ...validLeases,
      ttl: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer numeric values", () => {
    const result = ConfigWriteSchemas.leases.safeParse({
      ...validLeases,
      maxBudget: 50.5,
    });
    expect(result.success).toBe(false);
  });
});

describe("leases cross-field rule (window must not exceed ttl * 24)", () => {
  it("rejects a request window longer than the lease TTL in hours", () => {
    const result = ConfigWriteSchemas.leases.safeParse({
      ...validLeases,
      ttl: 1, // 24 hours
      leaseRequestWindowHours: 25, // exceeds 24
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const crossFieldIssue = result.error.issues.find(
        (issue) => issue.path.join(".") === "leaseRequestWindowHours",
      );
      expect(crossFieldIssue).toBeDefined();
      expect(crossFieldIssue?.message).toContain("TTL");
    }
  });

  it("accepts a request window exactly equal to ttl * 24", () => {
    const result = ConfigWriteSchemas.leases.safeParse({
      ...validLeases,
      ttl: 1,
      leaseRequestWindowHours: 24,
    });
    expect(result.success).toBe(true);
  });

  it("tolerates a violating window on the read schema", () => {
    // The read schema intentionally omits the cross-field rule so the leases
    // handler's runtime cap can tolerate stored/migrated config. The rule is
    // enforced on the write path (ConfigWriteSchemas.leases) above.
    const result = ConfigSchemas.leases.safeParse({
      ...validLeases,
      ttl: 2, // 48 hours
      leaseRequestWindowHours: 49,
    });
    expect(result.success).toBe(true);
  });
});

describe("cleanup field constraints", () => {
  it("rejects cleanup attempt counts below 1", () => {
    const result = ConfigWriteSchemas.cleanup.safeParse({
      ...validWritePayloads.cleanup,
      numberOfFailedAttemptsToCancelCleanup: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects wait-second values below 1", () => {
    const result = ConfigWriteSchemas.cleanup.safeParse({
      ...validWritePayloads.cleanup,
      waitBeforeRetryFailedAttemptSeconds: 0,
    });
    expect(result.success).toBe(false);
  });

  it("allows cooldownPeriodHours of 0 (no cooldown)", () => {
    const result = ConfigWriteSchemas.cleanup.safeParse({
      ...validWritePayloads.cleanup,
      cooldownPeriodHours: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects cooldownPeriodHours above the maximum bound", () => {
    const result = ConfigWriteSchemas.cleanup.safeParse({
      ...validWritePayloads.cleanup,
      cooldownPeriodHours: CONFIG_CONSTRAINTS.MAX_COOLDOWN_PERIOD_HOURS + 1,
    });
    expect(result.success).toBe(false);
  });
});

describe("notification emailFrom", () => {
  it("accepts a valid email", () => {
    expect(
      ConfigWriteSchemas.notification.safeParse({ emailFrom: "a@b.com" })
        .success,
    ).toBe(true);
  });

  it('accepts an empty string ("" disables notifications)', () => {
    expect(
      ConfigWriteSchemas.notification.safeParse({ emailFrom: "" }).success,
    ).toBe(true);
  });

  it("rejects a malformed email", () => {
    expect(
      ConfigWriteSchemas.notification.safeParse({ emailFrom: "not-an-email" })
        .success,
    ).toBe(false);
  });
});

describe("termsOfService content", () => {
  it("rejects content longer than the maximum length", () => {
    const result = ConfigWriteSchemas.termsOfService.safeParse({
      content: "x".repeat(CONFIG_CONSTRAINTS.MAX_TERMS_OF_SERVICE_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });
});

describe("costReporting groups", () => {
  it("rejects more than the maximum number of groups", () => {
    const result = ConfigWriteSchemas.costReporting.safeParse({
      costReportGroups: Array.from(
        { length: CONFIG_CONSTRAINTS.MAX_COST_REPORT_GROUPS + 1 },
        (_, i) => `g${i}`,
      ),
      requireCostReportGroup: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a group name longer than the maximum length", () => {
    const result = ConfigWriteSchemas.costReporting.safeParse({
      costReportGroups: [
        "x".repeat(CONFIG_CONSTRAINTS.MAX_COST_REPORT_GROUP_LENGTH + 1),
      ],
      requireCostReportGroup: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty-string group name", () => {
    const result = ConfigWriteSchemas.costReporting.safeParse({
      costReportGroups: [""],
      requireCostReportGroup: false,
    });
    expect(result.success).toBe(false);
  });
});
