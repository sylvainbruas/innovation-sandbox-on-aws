// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { union } from "@amzn/innovation-sandbox-commons/isb-services/notification/email-address-utils.js";
import { describe, expect, it } from "vitest";

describe("email-address-utils", () => {
  describe("union", () => {
    it("returns an empty array when given no recipients", async () => {
      expect(await union()).toEqual([]);
    });

    it("flattens multiple plain arrays into a single list", async () => {
      const result = await union(
        ["admin@example.com"],
        ["manager@example.com", "manager2@example.com"],
      );
      expect(result).toEqual([
        "admin@example.com",
        "manager@example.com",
        "manager2@example.com",
      ]);
    });

    it("deduplicates addresses that appear across recipient groups", async () => {
      const result = await union(
        ["admin@example.com", "shared@example.com"],
        ["shared@example.com", "manager@example.com"],
      );
      expect(result).toEqual([
        "admin@example.com",
        "shared@example.com",
        "manager@example.com",
      ]);
    });

    it("deduplicates repeated addresses within a single group", async () => {
      const result = await union(["dup@example.com", "dup@example.com"]);
      expect(result).toEqual(["dup@example.com"]);
    });

    it("resolves and merges promised recipient lists", async () => {
      const result = await union(
        Promise.resolve(["admin@example.com"]),
        Promise.resolve(["manager@example.com"]),
      );
      expect(result).toEqual(["admin@example.com", "manager@example.com"]);
    });

    it("accepts a mix of plain arrays and promises", async () => {
      const result = await union(
        ["admin@example.com"],
        Promise.resolve(["manager@example.com", "admin@example.com"]),
      );
      expect(result).toEqual(["admin@example.com", "manager@example.com"]);
    });

    it("handles empty recipient groups without emitting empty strings", async () => {
      const result = await union([], ["only@example.com"], Promise.resolve([]));
      expect(result).toEqual(["only@example.com"]);
    });
  });
});
