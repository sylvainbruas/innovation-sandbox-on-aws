// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import {
  base64DecodeCompositeKey,
  base64EncodeCompositeKey,
} from "@amzn/innovation-sandbox-commons/data/encoding.js";

describe("lastEvaluatedKey Encording", () => {
  test("multi-part key can be encoded and decoded", () => {
    const key = {
      somePK: "partitionKey",
      someSK: "sortKey",
    };

    const encodedKey = base64EncodeCompositeKey(key);
    const decodedKey = base64DecodeCompositeKey(encodedKey!);

    expect(key).toEqual(decodedKey);
  });

  test("encoding undefined key returns null", () => {
    expect(base64EncodeCompositeKey(undefined)).toBeNull();
  });

  test("decoding undefined key returns undefined", () => {
    expect(base64DecodeCompositeKey(undefined)).toBeUndefined();
  });

  test("emits URL-safe (base64url) output with no '+', '/', or '=' padding", () => {
    const encoded = base64EncodeCompositeKey({
      userEmail: "test-user@example.com",
      uuid: "a57dbb39-442f-4eea-9d2a-c949c50c275e",
    })!;
    expect(encoded).not.toMatch(/[+/=]/);
  });

  test("round-trips a value whose base64url contains '-' and '_'", () => {
    // Five non-ASCII bytes chosen so the base64url output uses both '-' (index 62)
    // and '_' (index 63) — the chars that would be '+' and '/' in standard base64.
    const key = {
      userEmail: "test-user@example.com",
      uuid: Buffer.from([0xfb, 0x20, 0xef, 0xa0, 0xbe]).toString("latin1"),
    };
    const encoded = base64EncodeCompositeKey(key)!;
    expect(encoded).toContain("-");
    expect(encoded).toContain("_");
    expect(base64DecodeCompositeKey(encoded)).toEqual(key);
  });
});
