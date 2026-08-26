// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Returns a new array of the strings sorted alphabetically, case-insensitively
 * (base sensitivity: ignores case and accents). Does not mutate the input.
 * Shared so every surface that displays the same list (e.g. a token field, its
 * read-only view, and a diff of it) renders one consistent order.
 */
export const sortedCaseInsensitive = (values: string[]): string[] =>
  [...values].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
