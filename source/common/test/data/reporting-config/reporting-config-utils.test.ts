// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { CostReportingConfig } from "@amzn/innovation-sandbox-commons/data/config/config.js";
import { ValidationException } from "@amzn/innovation-sandbox-commons/data/global-config/global-config-utils.js";
import { validateCostReportGroup } from "@amzn/innovation-sandbox-commons/data/reporting-config/reporting-config-utils.js";

const notRequired: CostReportingConfig = {
  costReportGroups: ["valid-group-1", "valid-group-2"],
  requireCostReportGroup: false,
};

const required: CostReportingConfig = {
  costReportGroups: ["valid-group-1", "valid-group-2"],
  requireCostReportGroup: true,
};

describe("validateCostReportGroup", () => {
  describe("create semantics (no previous value provided)", () => {
    it("throws when a group is required but not provided", () => {
      expect(() => validateCostReportGroup(undefined, required)).toThrow(
        ValidationException,
      );
    });

    it("passes when a valid group is provided", () => {
      expect(() =>
        validateCostReportGroup("valid-group-1", required),
      ).not.toThrow();
    });

    it("passes when not required and no group provided", () => {
      expect(() =>
        validateCostReportGroup(undefined, notRequired),
      ).not.toThrow();
    });

    it("throws when the provided group is not in the allowed list", () => {
      expect(() =>
        validateCostReportGroup("invalid-group", notRequired),
      ).toThrow("Invalid cost report group");
    });
  });

  describe("update semantics (previous value provided)", () => {
    it("allows an unchanged missing group even when now required", () => {
      expect(() =>
        validateCostReportGroup(undefined, required, {
          previousCostReportGroup: undefined,
        }),
      ).not.toThrow();
    });

    it("blocks clearing a previously-set group when required", () => {
      expect(() =>
        validateCostReportGroup(undefined, required, {
          previousCostReportGroup: "valid-group-1",
        }),
      ).toThrow(ValidationException);
    });

    it("still rejects setting an invalid group on update", () => {
      expect(() =>
        validateCostReportGroup("invalid-group", required, {
          previousCostReportGroup: "valid-group-1",
        }),
      ).toThrow("Invalid cost report group");
    });

    it("allows keeping the same valid group", () => {
      expect(() =>
        validateCostReportGroup("valid-group-1", required, {
          previousCostReportGroup: "valid-group-1",
        }),
      ).not.toThrow();
    });
  });
});
