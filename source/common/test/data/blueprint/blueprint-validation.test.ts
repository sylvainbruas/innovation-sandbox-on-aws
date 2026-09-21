// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import {
  PersistedBlueprintItemSchema,
  PersistedStackSetItemSchema,
} from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint.js";
import {
  createTestBlueprintItem,
  createTestStackSetItem,
} from "@amzn/innovation-sandbox-commons/test/fixtures/blueprint-fixtures.js";

describe("Blueprint Validation", () => {
  describe("Name Validation", () => {
    test("should accept valid blueprint names", () => {
      const validNames = [
        "MyBlueprint",
        "Blueprint-123",
        "A",
        "A" + "b".repeat(49), // 50 characters (max length)
      ];

      validNames.forEach((name) => {
        const result = PersistedBlueprintItemSchema.pick({
          name: true,
        }).safeParse({
          name,
        });
        expect(result.success).toBe(true);
      });
    });

    test("should reject names not starting with a letter", () => {
      const result = PersistedBlueprintItemSchema.pick({
        name: true,
      }).safeParse({
        name: "123-invalid",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain(
          "must start with a letter",
        );
      }
    });

    test("should reject names with invalid characters", () => {
      const result = PersistedBlueprintItemSchema.pick({
        name: true,
      }).safeParse({
        name: "invalid_name",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain(
          "letters, numbers, and hyphens",
        );
      }
    });

    test("should reject empty name", () => {
      const result = PersistedBlueprintItemSchema.pick({
        name: true,
      }).safeParse({
        name: "",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain("required");
      }
    });

    test("should reject names exceeding maximum length", () => {
      const result = PersistedBlueprintItemSchema.pick({
        name: true,
      }).safeParse({
        name: "A" + "b".repeat(50), // 51 characters
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain(
          "50 characters or less",
        );
      }
    });
  });

  describe("Regions Validation", () => {
    test("should accept unique regions", () => {
      const result = PersistedStackSetItemSchema.pick({
        regions: true,
      }).safeParse({
        regions: ["us-east-1", "us-west-2", "eu-west-1"],
      });

      expect(result.success).toBe(true);
    });

    test("should accept single region", () => {
      const result = PersistedStackSetItemSchema.pick({
        regions: true,
      }).safeParse({
        regions: ["us-east-1"],
      });

      expect(result.success).toBe(true);
    });

    test("should reject duplicate regions", () => {
      const result = PersistedStackSetItemSchema.pick({
        regions: true,
      }).safeParse({
        regions: ["us-east-1", "us-west-2", "us-east-1"],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain("Duplicate regions");
      }
    });

    test("should reject empty regions array", () => {
      const result = PersistedStackSetItemSchema.pick({
        regions: true,
      }).safeParse({
        regions: [],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain(
          "At least one region",
        );
      }
    });
  });
  describe("Metadata Version Validation", () => {
    test("should reject unsupported schema versions", () => {
      const unsupportedMeta = {
        schemaVersion: 2,
        createdTime: "2024-01-01T00:00:00.000Z",
        lastEditTime: "2024-01-01T00:00:00.000Z",
      };

      expect(
        PersistedBlueprintItemSchema.safeParse(
          createTestBlueprintItem({ meta: unsupportedMeta }),
        ).success,
      ).toBe(false);
      expect(
        PersistedStackSetItemSchema.safeParse(
          createTestStackSetItem({ meta: unsupportedMeta }),
        ).success,
      ).toBe(false);
    });
  });
});
