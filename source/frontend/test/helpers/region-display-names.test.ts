// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  formatRegionLabel,
  getRegionDisplayName,
} from "@amzn/innovation-sandbox-frontend/helpers/region-display-names";

describe("region-display-names", () => {
  describe("getRegionDisplayName", () => {
    it("should return friendly name for known region", () => {
      expect(getRegionDisplayName("us-east-1")).toBe("US East (N. Virginia)");
    });

    it("should return raw code for unknown region", () => {
      expect(getRegionDisplayName("xx-fake-1")).toBe("xx-fake-1");
    });
  });

  describe("formatRegionLabel", () => {
    it("should return friendly name with code for known region", () => {
      expect(formatRegionLabel("us-east-1")).toBe(
        "US East (N. Virginia) (us-east-1)",
      );
    });

    it("should return raw code only for unknown region", () => {
      expect(formatRegionLabel("xx-fake-1")).toBe("xx-fake-1");
    });
  });
});
