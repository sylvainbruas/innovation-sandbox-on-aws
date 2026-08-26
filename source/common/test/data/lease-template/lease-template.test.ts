// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  LeaseTemplate,
  LeaseTemplateSchema,
  LeaseTemplateSchemaVersion,
  Visibility,
} from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";

const VALID_UUID = "00000000-0000-4000-8000-000000000001";
const NOW = "2024-01-01T00:00:00Z";

function validTemplate(overrides: Partial<LeaseTemplate> = {}): LeaseTemplate {
  return {
    uuid: VALID_UUID,
    name: "Test Template",
    description: "A test template",
    requiresApproval: false,
    createdBy: "admin@example.com",
    visibility: "PUBLIC" as Visibility,
    costReportGroup: "team-alpha",
    blueprintId: "00000000-0000-4000-8000-000000000002",
    blueprintName: "My Blueprint",
    allowOwnerToShareLease: false,
    maxSpend: 500,
    leaseDurationInHours: 48,
    budgetThresholds: [{ dollarsSpent: 100, action: "ALERT" }],
    durationThresholds: [{ hoursRemaining: 4, action: "FREEZE_ACCOUNT" }],
    meta: {
      schemaVersion: LeaseTemplateSchemaVersion,
      createdTime: NOW,
      lastEditTime: NOW,
    },
    ...overrides,
  };
}

describe("LeaseTemplateSchema", () => {
  it("should accept a valid template", () => {
    expect(LeaseTemplateSchema.safeParse(validTemplate()).success).toBe(true);
  });

  it("should accept with only required fields", () => {
    expect(
      LeaseTemplateSchema.safeParse({
        uuid: VALID_UUID,
        name: "Minimal",
        requiresApproval: true,
        createdBy: "admin@example.com",
        visibility: "PUBLIC",
      }).success,
    ).toBe(true);
  });

  describe("uuid", () => {
    it("should reject when missing", () => {
      const { uuid: _, ...withoutUuid } = validTemplate();
      expect(LeaseTemplateSchema.safeParse(withoutUuid).success).toBe(false);
    });

    it("should reject non-UUID string", () => {
      expect(
        LeaseTemplateSchema.safeParse(validTemplate({ uuid: "not-a-uuid" }))
          .success,
      ).toBe(false);
    });
  });

  describe("name", () => {
    it("should accept name at max length", () => {
      expect(
        LeaseTemplateSchema.safeParse(validTemplate({ name: "A".repeat(50) }))
          .success,
      ).toBe(true);
    });

    it.each([
      ["empty", ""],
      ["exceeding 50 chars", "A".repeat(51)],
    ])("should reject %s", (_label, name) => {
      expect(
        LeaseTemplateSchema.safeParse(validTemplate({ name })).success,
      ).toBe(false);
    });
  });

  describe("description", () => {
    it("should accept when omitted", () => {
      const { description: _, ...rest } = validTemplate();
      expect(LeaseTemplateSchema.safeParse(rest).success).toBe(true);
    });

    it("should reject when exceeding 1000 chars", () => {
      expect(
        LeaseTemplateSchema.safeParse(
          validTemplate({ description: "A".repeat(1001) }),
        ).success,
      ).toBe(false);
    });
  });

  describe("requiresApproval", () => {
    it.each([true, false])("should accept %s", (value) => {
      expect(
        LeaseTemplateSchema.safeParse(
          validTemplate({ requiresApproval: value }),
        ).success,
      ).toBe(true);
    });

    it("should reject missing", () => {
      const { requiresApproval: _, ...rest } = validTemplate();
      expect(LeaseTemplateSchema.safeParse(rest).success).toBe(false);
    });
  });

  describe("createdBy", () => {
    it("should reject invalid email", () => {
      expect(
        LeaseTemplateSchema.safeParse(validTemplate({ createdBy: "not-email" }))
          .success,
      ).toBe(false);
    });
  });

  describe("visibility", () => {
    it.each(["PUBLIC", "PRIVATE"] as Visibility[])(
      "should accept %s",
      (value) => {
        expect(
          LeaseTemplateSchema.safeParse(validTemplate({ visibility: value }))
            .success,
        ).toBe(true);
      },
    );

    it("should reject invalid value", () => {
      expect(
        LeaseTemplateSchema.safeParse(
          validTemplate({ visibility: "INTERNAL" as any }),
        ).success,
      ).toBe(false);
    });
  });

  describe("costReportGroup", () => {
    it("should accept when omitted", () => {
      const { costReportGroup: _, ...rest } = validTemplate();
      expect(LeaseTemplateSchema.safeParse(rest).success).toBe(true);
    });

    it.each([
      ["empty string", ""],
      ["exceeding 50 chars", "A".repeat(51)],
    ])("should reject %s", (_label, value) => {
      expect(
        LeaseTemplateSchema.safeParse(validTemplate({ costReportGroup: value }))
          .success,
      ).toBe(false);
    });
  });

  describe("blueprintId", () => {
    it.each([
      ["null", { blueprintId: null }],
      ["valid UUID", { blueprintId: "00000000-0000-4000-8000-000000000002" }],
    ])("should accept %s", (_label, overrides) => {
      expect(
        LeaseTemplateSchema.safeParse(validTemplate(overrides)).success,
      ).toBe(true);
    });

    it("should reject non-UUID string", () => {
      expect(
        LeaseTemplateSchema.safeParse(
          validTemplate({ blueprintId: "not-uuid" }),
        ).success,
      ).toBe(false);
    });

    it("should accept when omitted", () => {
      const { blueprintId: _, ...rest } = validTemplate();
      expect(LeaseTemplateSchema.safeParse(rest).success).toBe(true);
    });
  });

  describe("blueprintName", () => {
    it.each([
      ["null", { blueprintName: null }],
      ["string", { blueprintName: "My Blueprint" }],
    ])("should accept %s", (_label, overrides) => {
      expect(
        LeaseTemplateSchema.safeParse(validTemplate(overrides)).success,
      ).toBe(true);
    });

    it("should accept when omitted", () => {
      const { blueprintName: _, ...rest } = validTemplate();
      expect(LeaseTemplateSchema.safeParse(rest).success).toBe(true);
    });
  });

  describe("allowOwnerToShareLease", () => {
    it.each([true, false])("should accept %s", (value) => {
      expect(
        LeaseTemplateSchema.safeParse(
          validTemplate({ allowOwnerToShareLease: value }),
        ).success,
      ).toBe(true);
    });

    it("should default to false when omitted", () => {
      const { allowOwnerToShareLease: _, ...rest } = validTemplate();
      const result = LeaseTemplateSchema.parse(rest);
      expect(result.allowOwnerToShareLease).toBe(false);
    });

    it("should reject non-boolean", () => {
      expect(
        LeaseTemplateSchema.safeParse(
          validTemplate({ allowOwnerToShareLease: "yes" as any }),
        ).success,
      ).toBe(false);
    });

    it("should parse a legacy v3 record without allowOwnerToShareLease and default to false", () => {
      const legacyRecord = {
        uuid: VALID_UUID,
        name: "Legacy Template",
        requiresApproval: false,
        createdBy: "admin@example.com",
        visibility: "PUBLIC",
        maxSpend: 100,
        leaseDurationInHours: 24,
        budgetThresholds: [],
        durationThresholds: [],
        meta: {
          schemaVersion: 3,
          createdTime: NOW,
          lastEditTime: NOW,
        },
      };
      const result = LeaseTemplateSchema.parse(legacyRecord);
      expect(result.allowOwnerToShareLease).toBe(false);
    });
  });

  describe("maxSpend", () => {
    it("should accept positive number", () => {
      expect(
        LeaseTemplateSchema.safeParse(validTemplate({ maxSpend: 100 })).success,
      ).toBe(true);
    });

    it.each([0, -1])("should reject %s", (value) => {
      expect(
        LeaseTemplateSchema.safeParse(validTemplate({ maxSpend: value }))
          .success,
      ).toBe(false);
    });
  });

  describe("leaseDurationInHours", () => {
    it("should accept positive number", () => {
      expect(
        LeaseTemplateSchema.safeParse(
          validTemplate({ leaseDurationInHours: 24 }),
        ).success,
      ).toBe(true);
    });

    it.each([0, -1])("should reject %s", (value) => {
      expect(
        LeaseTemplateSchema.safeParse(
          validTemplate({ leaseDurationInHours: value }),
        ).success,
      ).toBe(false);
    });
  });

  describe("budgetThresholds", () => {
    it("should accept valid thresholds", () => {
      expect(
        LeaseTemplateSchema.safeParse(
          validTemplate({
            budgetThresholds: [
              { dollarsSpent: 50, action: "ALERT" },
              { dollarsSpent: 100, action: "FREEZE_ACCOUNT" },
            ],
          }),
        ).success,
      ).toBe(true);
    });

    it("should reject threshold with zero dollarsSpent", () => {
      expect(
        LeaseTemplateSchema.safeParse(
          validTemplate({
            budgetThresholds: [{ dollarsSpent: 0, action: "ALERT" }],
          }),
        ).success,
      ).toBe(false);
    });

    it("should reject threshold with invalid action", () => {
      expect(
        LeaseTemplateSchema.safeParse(
          validTemplate({
            budgetThresholds: [
              { dollarsSpent: 50, action: "TERMINATE" as any },
            ],
          }),
        ).success,
      ).toBe(false);
    });
  });

  describe("durationThresholds", () => {
    it("should accept valid thresholds", () => {
      expect(
        LeaseTemplateSchema.safeParse(
          validTemplate({
            durationThresholds: [
              { hoursRemaining: 4, action: "ALERT" },
              { hoursRemaining: 1, action: "FREEZE_ACCOUNT" },
            ],
          }),
        ).success,
      ).toBe(true);
    });

    it("should reject threshold with zero hoursRemaining", () => {
      expect(
        LeaseTemplateSchema.safeParse(
          validTemplate({
            durationThresholds: [{ hoursRemaining: 0, action: "ALERT" }],
          }),
        ).success,
      ).toBe(false);
    });
  });

  it("should reject unknown fields (strict mode)", () => {
    expect(
      LeaseTemplateSchema.safeParse(
        validTemplate({ unknownField: "value" } as any),
      ).success,
    ).toBe(false);
  });
});
