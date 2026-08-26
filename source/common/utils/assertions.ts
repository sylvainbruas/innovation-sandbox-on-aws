// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Asserts a value is defined (not null or undefined).
 * Throws a generic Error for data integrity violations.
 *
 * Use for defensive checks where a value should always be present
 * but the type system allows undefined (e.g., AWS SDK response fields).
 */
export function assertDefined<T>(
  value: T | undefined | null,
  message: string,
): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}
