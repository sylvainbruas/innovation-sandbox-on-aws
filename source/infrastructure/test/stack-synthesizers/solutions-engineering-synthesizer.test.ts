// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { compactCloudFormationTemplates } from "@amzn/innovation-sandbox-infrastructure/stack-synthesizers/solutions-engineering-synthesizer";

describe("compactCloudFormationTemplates", () => {
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(path.join(tmpdir(), "isb-cfn-templates-"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(outDir, { recursive: true, force: true });
  });

  it("removes insignificant whitespace", () => {
    const templatePath = path.join(outDir, "Compute.template.json");
    const template = {
      Resources: { Example: { Type: "AWS::S3::Bucket" } },
    };
    writeFileSync(templatePath, JSON.stringify(template, null, 2));

    compactCloudFormationTemplates(outDir);

    expect(readFileSync(templatePath, "utf8")).toBe(JSON.stringify(template));
    expect(console.log).toHaveBeenCalledWith(
      `Compute.template.json compacted size: ${Buffer.byteLength(JSON.stringify(template))} bytes (1 line)`,
    );
  });

  it("warns when a compacted template approaches the limit", () => {
    const templatePath = path.join(outDir, "Compute.template.json");
    writeFileSync(
      templatePath,
      JSON.stringify({ Metadata: { Padding: "x".repeat(900_000) } }),
    );

    compactCloudFormationTemplates(outDir);

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("is approaching CloudFormation's 1000000-byte"),
    );
    expect(console.error).not.toHaveBeenCalled();
  });

  it("emits a critical warning without throwing above the limit", () => {
    const templatePath = path.join(outDir, "Compute.template.json");
    writeFileSync(
      templatePath,
      JSON.stringify({ Metadata: { Padding: "x".repeat(1_000_000) } }),
    );

    expect(() => compactCloudFormationTemplates(outDir)).not.toThrow();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "CRITICAL WARNING: Compute.template.json exceeds CloudFormation's 1000000-byte",
      ),
    );
  });
});
