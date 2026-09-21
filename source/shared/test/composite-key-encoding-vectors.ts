// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export interface CompositeKeyEncodingVector {
  name: string;
  key: Record<string, unknown>;
  encoded: string;
}

/**
 * Fixed UTF-8/base64url contract vectors shared by the browser and Node tests.
 * Keeping expected values independent of either implementation detects format
 * drift without coupling frontend tests to backend code.
 */
export const CompositeKeyEncodingVectors: readonly CompositeKeyEncodingVector[] =
  [
    {
      name: "lease composite key",
      key: {
        userEmail: "test-user@example.com",
        uuid: "a57dbb39-442f-4eea-9d2a-c949c50c275e",
      },
      encoded:
        "eyJ1c2VyRW1haWwiOiJ0ZXN0LXVzZXJAZXhhbXBsZS5jb20iLCJ1dWlkIjoiYTU3ZGJiMzktNDQyZi00ZWVhLTlkMmEtYzk0OWM1MGMyNzVlIn0",
    },
    {
      name: "UTF-8 data using both base64url substitutions",
      key: { raw: "½¾¿À" },
      encoded: "eyJyYXciOiLCvcK-wr_DgCJ9",
    },
  ];
