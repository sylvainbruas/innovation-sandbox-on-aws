// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser-safe equivalent of `base64EncodeCompositeKey` from
 * `@amzn/innovation-sandbox-commons/data/encoding.js`.
 *
 * Encodes a composite key object as a base64url string for use in API URLs.
 * Uses TextEncoder to handle UTF-8 correctly (unlike raw btoa which only
 * supports Latin1).
 *
 * The output is base64url (not standard base64): btoa emits '+', '/', and '='
 * padding, but the backend validates the key path parameter against the
 * base64url alphabet (/^[A-Za-z0-9_-]+$/) and decodes it as base64url. Emitting
 * standard base64 would be rejected with a 400 before reaching the handler.
 */
export function base64EncodeCompositeKey(key: Record<string, unknown>): string {
  const jsonStr = JSON.stringify(key);
  const bytes = new TextEncoder().encode(jsonStr);
  const binaryStr = Array.from(bytes, (b) => String.fromCodePoint(b)).join("");
  return btoa(binaryStr)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
