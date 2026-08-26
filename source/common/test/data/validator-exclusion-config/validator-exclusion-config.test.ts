// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  ValidatorExclusionConfig,
  ValidatorExclusionConfigSchema,
} from "@amzn/innovation-sandbox-commons/data/validator-exclusion-config/validator-exclusion-config.js";
import fs from "fs";
import yaml from "js-yaml";
import path from "path";
import { describe, expect, it } from "vitest";

describe("ValidatorExclusionConfigSchema", () => {
  const validConfig: ValidatorExclusionConfig = {
    validation: {
      excludedArnPatterns: [
        "arn:aws:iam::*:role/InnovationSandbox-*",
        "arn:aws:iam::*:role/aws-service-role/*",
        "arn:aws:cloudformation:*:*:stack/StackSet-Isb-*/*",
      ],
    },
  };

  it("should parse a valid config successfully", () => {
    const result = ValidatorExclusionConfigSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.validation.excludedArnPatterns).toHaveLength(3);
    }
  });

  it("should accept empty array", () => {
    const config = {
      validation: {
        excludedArnPatterns: [],
      },
    };
    const result = ValidatorExclusionConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("should reject missing validation object", () => {
    const result = ValidatorExclusionConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("should reject missing excludedArnPatterns", () => {
    const result = ValidatorExclusionConfigSchema.safeParse({
      validation: {},
    });
    expect(result.success).toBe(false);
  });

  it("should reject empty strings in excludedArnPatterns", () => {
    const result = ValidatorExclusionConfigSchema.safeParse({
      validation: {
        excludedArnPatterns: [""],
      },
    });
    expect(result.success).toBe(false);
  });

  it("should reject non-string items in excludedArnPatterns", () => {
    const result = ValidatorExclusionConfigSchema.safeParse({
      validation: {
        excludedArnPatterns: [null],
      },
    });
    expect(result.success).toBe(false);
  });

  it("should pass strict validation (no extra fields at top level)", () => {
    const result = ValidatorExclusionConfigSchema.strict().safeParse({
      validation: {
        excludedArnPatterns: ["arn:aws:iam::*:role/test-*"],
      },
      extraField: "should fail",
    });
    expect(result.success).toBe(false);
  });

  it("should parse the default config YAML shipped with the solution", () => {
    const configPath = path.resolve(
      __dirname,
      "../../../../infrastructure/lib/components/config/validator-exclusion-config.yaml",
    );
    const content = yaml.load(fs.readFileSync(configPath, "utf-8"));
    const result = ValidatorExclusionConfigSchema.strict().safeParse(content);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.validation.excludedArnPatterns.length).toBeGreaterThan(
        0,
      );
    }
  });
});
