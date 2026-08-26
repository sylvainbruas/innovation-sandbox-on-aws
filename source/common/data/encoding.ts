// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
export function base64EncodeCompositeKey(
  key: Record<string, any> | undefined,
): string | null {
  if (key === undefined) {
    return null;
  }

  const jsonStr = JSON.stringify(key);
  // base64url so the value is safe in URL path segments and query strings.
  return Buffer.from(jsonStr, "utf8").toString("base64url");
}

export function base64DecodeCompositeKey(
  encodedKey: string | undefined,
): Record<string, any> | undefined {
  if (encodedKey === undefined) {
    return undefined;
  }

  const jsonStr = Buffer.from(encodedKey, "base64url").toString("utf8");
  return JSON.parse(jsonStr);
}
