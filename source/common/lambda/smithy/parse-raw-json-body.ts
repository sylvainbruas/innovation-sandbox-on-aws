// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Re-reads the raw API Gateway request body as JSON, base64-decoding it first
 * when the payload was binary-encoded.
 *
 * A Smithy operation gets its input from the generated `restJson1` deserializer,
 * which parses the body into the *model* input — dropping unknown members and
 * skipping the pre-Smithy Zod defaults/strict rules. Operations that still own a
 * Zod contract re-parse the raw body with this helper to recover strict
 * unknown-key rejection, refined formats, and the pre-Smithy defaults.
 *
 * By the time an operation runs, the generated deserializer has already confirmed
 * the body is syntactically valid JSON (an invalid body raised a
 * `SerializationException` beforehand) and required-member validation rejected an
 * absent body, so no error handling is needed here — this is purely the raw-body
 * accessor for that Zod re-parse.
 */
export function parseRawJsonBody(event: {
  body?: string | null;
  isBase64Encoded?: boolean;
}): unknown {
  if (event.body == null) {
    return undefined;
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  return JSON.parse(raw);
}
