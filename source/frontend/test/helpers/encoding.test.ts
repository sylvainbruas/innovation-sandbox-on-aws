// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import { base64DecodeCompositeKey } from "@amzn/innovation-sandbox-commons/data/encoding.js";
import { base64EncodeCompositeKey } from "@amzn/innovation-sandbox-frontend/helpers/encoding";

// The backend validates the composite key path parameter against this pattern
// (see leases-handler.ts) and decodes it as base64url. The frontend encoder must
// therefore emit base64url (no '+', '/', or '=' padding) or the API rejects the
// value with a 400 before it ever reaches the handler.
const BASE64URL_PATH_PATTERN = /^[A-Za-z0-9_-]+$/;

describe("base64EncodeCompositeKey (frontend)", () => {
  test("emits URL-safe (base64url) output with no '+', '/', or '=' padding", () => {
    // This realistic composite key — the same shape used to link to a lease
    // from AccountDetails — encodes to a value ending in '=' padding under
    // standard base64, which the backend path validation rejects.
    const encoded = base64EncodeCompositeKey({
      userEmail: "test-user@example.com",
      uuid: "a57dbb39-442f-4eea-9d2a-c949c50c275e",
    });
    expect(encoded).not.toMatch(/[+/=]/);
    expect(encoded).toMatch(BASE64URL_PATH_PATTERN);
  });

  test("uses '-' and '_' where standard base64 would use '+' and '/'", () => {
    // These characters (U+00BD..U+00C0) encode to a value whose *standard*
    // base64 contains both '+' (index 62) and '/' (index 63); base64url must
    // emit '-' and '_' in their place instead.
    const encoded = base64EncodeCompositeKey({ raw: "½¾¿À" });
    expect(encoded).toContain("-");
    expect(encoded).toContain("_");
    expect(encoded).not.toMatch(/[+/=]/);
  });

  test("round-trips through the backend base64url decoder", () => {
    const key = {
      userEmail: "test-user@example.com",
      uuid: "a57dbb39-442f-4eea-9d2a-c949c50c275e",
    };
    const encoded = base64EncodeCompositeKey(key);
    expect(base64DecodeCompositeKey(encoded)).toEqual(key);
  });
});
