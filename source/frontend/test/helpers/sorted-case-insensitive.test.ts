// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { sortedCaseInsensitive } from "../../src/helpers/sorted-case-insensitive";

describe("sortedCaseInsensitive", () => {
  it("sorts alphabetically ignoring case (the helper's reason to exist)", () => {
    // Mixed case: a case-sensitive sort would put all uppercase before
    // lowercase ("Beta","Gamma","alpha"); base sensitivity interleaves them.
    expect(sortedCaseInsensitive(["Beta", "alpha", "Gamma"])).toEqual([
      "alpha",
      "Beta",
      "Gamma",
    ]);
  });

  it("does not mutate the input array", () => {
    const input = ["c", "a", "b"];
    const result = sortedCaseInsensitive(input);
    expect(result).toEqual(["a", "b", "c"]);
    // The original order is preserved (a new array was returned).
    expect(input).toEqual(["c", "a", "b"]);
  });

  it("returns an empty array unchanged", () => {
    expect(sortedCaseInsensitive([])).toEqual([]);
  });

  it("folds accents (base sensitivity), not just case", () => {
    // "é" sorts adjacent to "e" under base sensitivity; a plain localeCompare
    // (no sensitivity option) would order the accented form after plain ASCII.
    expect(sortedCaseInsensitive(["ë", "d", "e", "f"])).toEqual([
      "d",
      "ë",
      "e",
      "f",
    ]);
  });
});
