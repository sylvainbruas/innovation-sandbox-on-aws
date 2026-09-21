// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift gate for the published OpenAPI contract (Task 3.7d).
 *
 * `docs/openapi/innovation-sandbox-api.json` is generated but committed. Generation
 * is non-mutating by default (`generate.mjs` only writes the tracked copy on
 * `--write-docs`), so this compares the *committed* contract against the freshly
 * generated projection (which `pretest`'s `smithy:prepare` produced) and fails if
 * they drift — the enforcement `smithy-migration.md` calls for, without any Git
 * plumbing (both are on-disk files).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { openapiJson, publishedOpenapi } from "../scripts/lib/paths.mjs";

describe("published OpenAPI contract", () => {
  it("matches a fresh generation (if this fails, run `npm run smithy:generate -- --write-docs` and commit)", () => {
    const committed = readFileSync(publishedOpenapi, "utf8");
    const generated = readFileSync(openapiJson, "utf8");
    expect(committed).toBe(generated);
  });
});
