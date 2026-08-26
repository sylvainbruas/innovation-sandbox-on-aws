// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import {
  CleanupReasonBackwardCompatibleSchema,
  CleanupReasonSchema,
} from "@amzn/innovation-sandbox-commons/events/clean-account-request.js";

describe("CleanupReasonSchema", () => {
  test("accepts MANUALLY_INITIATED", () => {
    expect(CleanupReasonSchema.parse("MANUALLY_INITIATED")).toBe(
      "MANUALLY_INITIATED",
    );
  });

  test("accepts ACCOUNT_REGISTRATION", () => {
    expect(CleanupReasonSchema.parse("ACCOUNT_REGISTRATION")).toBe(
      "ACCOUNT_REGISTRATION",
    );
  });

  test("accepts LEASE_TERMINATION", () => {
    expect(CleanupReasonSchema.parse("LEASE_TERMINATION")).toBe(
      "LEASE_TERMINATION",
    );
  });

  test("accepts LEASE_RESET", () => {
    expect(CleanupReasonSchema.parse("LEASE_RESET")).toBe("LEASE_RESET");
  });

  test("rejects legacy RETRY_FAILED_CLEANUP", () => {
    expect(() => CleanupReasonSchema.parse("RETRY_FAILED_CLEANUP")).toThrow();
  });

  test("rejects unknown values", () => {
    expect(() => CleanupReasonSchema.parse("UNKNOWN_REASON")).toThrow();
  });
});

describe("CleanupReasonBackwardCompatibleSchema", () => {
  test("transforms legacy RETRY_FAILED_CLEANUP to MANUALLY_INITIATED", () => {
    expect(
      CleanupReasonBackwardCompatibleSchema.parse("RETRY_FAILED_CLEANUP"),
    ).toBe("MANUALLY_INITIATED");
  });

  test("passes through MANUALLY_INITIATED unchanged", () => {
    expect(
      CleanupReasonBackwardCompatibleSchema.parse("MANUALLY_INITIATED"),
    ).toBe("MANUALLY_INITIATED");
  });

  test("passes through ACCOUNT_REGISTRATION unchanged", () => {
    expect(
      CleanupReasonBackwardCompatibleSchema.parse("ACCOUNT_REGISTRATION"),
    ).toBe("ACCOUNT_REGISTRATION");
  });

  test("passes through LEASE_TERMINATION unchanged", () => {
    expect(
      CleanupReasonBackwardCompatibleSchema.parse("LEASE_TERMINATION"),
    ).toBe("LEASE_TERMINATION");
  });

  test("passes through LEASE_RESET unchanged", () => {
    expect(CleanupReasonBackwardCompatibleSchema.parse("LEASE_RESET")).toBe(
      "LEASE_RESET",
    );
  });

  test("rejects unknown values", () => {
    expect(() =>
      CleanupReasonBackwardCompatibleSchema.parse("UNKNOWN_REASON"),
    ).toThrow();
  });
});
