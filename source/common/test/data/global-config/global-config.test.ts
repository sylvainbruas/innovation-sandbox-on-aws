// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  AppConfigGlobalConfig,
  GlobalConfigSchema,
} from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { describe, expect, it } from "vitest";

function validConfig(
  overrides?: Partial<AppConfigGlobalConfig>,
): AppConfigGlobalConfig {
  return generateSchemaData(GlobalConfigSchema, overrides);
}

describe("GlobalConfigSchema lease rate-limit and self-termination defaults", () => {
  function leasesWithoutNewFields() {
    return {
      requireMaxBudget: true,
      maxBudget: 50,
      requireMaxDuration: true,
      maxDurationHours: 168,
      maxLeasesPerUser: 3,
      ttl: 30,
    };
  }

  it("applies defaults when the three new fields are missing", () => {
    const base = validConfig();
    const parsed = GlobalConfigSchema.parse({
      ...base,
      leases: leasesWithoutNewFields(),
    });
    expect(parsed.leases.allowUserLeaseTermination).toBe(true);
    expect(parsed.leases.leaseRequestWindowHours).toBe(168);
    expect(parsed.leases.maxLeaseRequestsPerWindow).toBe(10);
  });

  it("respects overrides when the three new fields are provided", () => {
    const base = validConfig();
    const parsed = GlobalConfigSchema.parse({
      ...base,
      leases: {
        ...leasesWithoutNewFields(),
        allowUserLeaseTermination: false,
        leaseRequestWindowHours: 72,
        maxLeaseRequestsPerWindow: 5,
      },
    });
    expect(parsed.leases.allowUserLeaseTermination).toBe(false);
    expect(parsed.leases.leaseRequestWindowHours).toBe(72);
    expect(parsed.leases.maxLeaseRequestsPerWindow).toBe(5);
  });

  it.each([
    { field: "leaseRequestWindowHours", value: 0 },
    { field: "leaseRequestWindowHours", value: -1 },
    { field: "maxLeaseRequestsPerWindow", value: 0 },
    { field: "maxLeaseRequestsPerWindow", value: -1 },
  ])("rejects $field = $value", ({ field, value }) => {
    const base = validConfig();
    const result = GlobalConfigSchema.safeParse({
      ...base,
      leases: {
        ...leasesWithoutNewFields(),
        [field]: value,
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("GlobalConfigSchema cleanup validation, cooldown, and retention defaults", () => {
  function cleanupWithoutNewFields() {
    return {
      numberOfFailedAttemptsToCancelCleanup: 3,
      waitBeforeRetryFailedAttemptSeconds: 5,
      numberOfSuccessfulAttemptsToFinishCleanup: 2,
      waitBeforeRerunSuccessfulAttemptSeconds: 30,
    };
  }

  it("applies defaults when validation, cooldownPeriodHours, and reportRetentionDays are missing", () => {
    const base = validConfig();
    const parsed = GlobalConfigSchema.parse({
      ...base,
      cleanup: cleanupWithoutNewFields(),
    });
    expect(parsed.cleanup.validation).toEqual({
      failureAction: "Silent",
    });
    expect(parsed.cleanup.cooldownPeriodHours).toBe(0);
    expect(parsed.cleanup.reportRetentionDays).toBe(730);
  });

  it("respects overrides when new fields are provided", () => {
    const base = validConfig();
    const parsed = GlobalConfigSchema.parse({
      ...base,
      cleanup: {
        ...cleanupWithoutNewFields(),
        validation: { failureAction: "Warn" },
        cooldownPeriodHours: 24,
        reportRetentionDays: 365,
      },
    });
    expect(parsed.cleanup.validation.failureAction).toBe("Warn");
    expect(parsed.cleanup.cooldownPeriodHours).toBe(24);
    expect(parsed.cleanup.reportRetentionDays).toBe(365);
  });

  it.each([
    { field: "cooldownPeriodHours", value: 8761 },
    { field: "cooldownPeriodHours", value: -1 },
    { field: "reportRetentionDays", value: 5 },
    { field: "reportRetentionDays", value: 4000 },
  ])("rejects cleanup.$field = $value", ({ field, value }) => {
    const base = validConfig();
    const result = GlobalConfigSchema.safeParse({
      ...base,
      cleanup: { ...cleanupWithoutNewFields(), [field]: value },
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid failureAction enum value", () => {
    const base = validConfig();
    const result = GlobalConfigSchema.safeParse({
      ...base,
      cleanup: {
        ...cleanupWithoutNewFields(),
        validation: { failureAction: "Invalid" },
      },
    });
    expect(result.success).toBe(false);
  });
});
