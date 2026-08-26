// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  ValidationException,
  validateLeaseTemplateCompliesWithGlobalConfig,
} from "@amzn/innovation-sandbox-commons/data/global-config/global-config-utils.js";
import { LeaseTemplateSchema } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { mockGlobalConfig } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";

function template(fields: {
  maxSpend: number | undefined;
  leaseDurationInHours: number | undefined;
}) {
  return generateSchemaData(LeaseTemplateSchema, {
    allowOwnerToShareLease: false,
    ...fields,
  });
}

function configRequiring() {
  const config = mockGlobalConfig();
  config.leases.maxBudget = 500;
  config.leases.maxDurationHours = 500;
  config.leases.requireMaxBudget = true;
  config.leases.requireMaxDuration = true;
  return config;
}

describe("validateLeaseTemplateCompliesWithGlobalConfig", () => {
  describe("create semantics (no previous provided)", () => {
    it("throws when a required max budget is missing", () => {
      expect(() =>
        validateLeaseTemplateCompliesWithGlobalConfig(
          template({ maxSpend: undefined, leaseDurationInHours: 24 }),
          configRequiring(),
        ),
      ).toThrow(/max budget must be provided/i);
    });

    it("throws when a required duration is missing", () => {
      expect(() =>
        validateLeaseTemplateCompliesWithGlobalConfig(
          template({ maxSpend: 50, leaseDurationInHours: undefined }),
          configRequiring(),
        ),
      ).toThrow(/duration must be provided/i);
    });
  });

  describe("update semantics (previous provided)", () => {
    it("allows editing other fields when required budget/duration are unchanged-missing", () => {
      // A template that predates the requirement: both fields absent, and the
      // update leaves them absent. Editing an unrelated field must be allowed.
      const previous = template({
        maxSpend: undefined,
        leaseDurationInHours: undefined,
      });
      const updated = template({
        maxSpend: undefined,
        leaseDurationInHours: undefined,
      });
      expect(() =>
        validateLeaseTemplateCompliesWithGlobalConfig(
          updated,
          configRequiring(),
          { previous },
        ),
      ).not.toThrow();
    });

    it("still blocks clearing a previously-set required budget", () => {
      const previous = template({
        maxSpend: 100,
        leaseDurationInHours: undefined,
      });
      const updated = template({
        maxSpend: undefined,
        leaseDurationInHours: undefined,
      });
      expect(() =>
        validateLeaseTemplateCompliesWithGlobalConfig(
          updated,
          configRequiring(),
          { previous },
        ),
      ).toThrow(/max budget must be provided/i);
    });

    it("still enforces the max-budget ceiling on update", () => {
      const previous = template({ maxSpend: 100, leaseDurationInHours: 24 });
      const updated = template({ maxSpend: 9999, leaseDurationInHours: 24 });
      expect(() =>
        validateLeaseTemplateCompliesWithGlobalConfig(
          updated,
          configRequiring(),
          { previous },
        ),
      ).toThrow(ValidationException);
    });
  });
});
