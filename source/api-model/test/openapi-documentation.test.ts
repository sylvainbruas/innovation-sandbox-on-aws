// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Documentation policy for the published OpenAPI (Task 3.7c): customer-facing
 * descriptions must not leak implementation/migration jargon. Enforces the
 * "0 occurrences" scrub claim so a future `///` edit can't silently reintroduce
 * it. (Kept separate from example validation — this is a description-content
 * policy, unrelated to examples.)
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { openapiJson } from "../scripts/lib/paths.mjs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const oa: any = JSON.parse(readFileSync(openapiJson, "utf8"));

// Explicit forbidden phrases (per review) plus unambiguous jargon terms — exact
// phrases, not a broad `persist` regex, so benign wording isn't flagged. Matched
// case-insensitively so a lowercase/re-cased variant still trips it.
const FORBIDDEN = [
  "persisted record",
  "persisted section",
  "Persistence compatibility",
  "DynamoDB",
  "Zod",
  "pre-Smithy",
  "byte-faithful",
  "deviation #",
  "restJson1",
  "Middy",
  "@sensitive",
];

describe("emitted descriptions are free of implementation jargon", () => {
  it("no forbidden phrase appears in any description", () => {
    // Only `description` is scanned: OpenAPI 3.0 `deprecated` is a boolean, and the
    // Smithy converter folds a `@deprecated(message)` into the schema's `description`
    // ("This shape is deprecated: …"), so deprecation messages are covered here too.
    const texts: string[] = [];
    (function walk(node: any) {
      if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          if (key === "description" && typeof value === "string") {
            texts.push(value);
          } else {
            walk(value);
          }
        }
      }
    })(oa);
    const all = texts.join("\n").toLowerCase();
    const hits = FORBIDDEN.filter((phrase) =>
      all.includes(phrase.toLowerCase()),
    );
    expect(
      hits,
      `forbidden jargon in emitted docs: ${hits.join(", ")}`,
    ).toHaveLength(0);
  });
});
