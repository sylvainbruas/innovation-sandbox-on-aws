// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import z from "zod";

import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import {
  AwsAccountIdSchema,
  enumErrorMap,
} from "@amzn/innovation-sandbox-commons/utils/zod.js";

/**
 * Canonical cleanup reason values used by new code paths.
 * `MANUALLY_INITIATED` replaces the legacy `RETRY_FAILED_CLEANUP` value.
 */
export const CleanupReasonSchema = z.enum(
  [
    "ACCOUNT_REGISTRATION",
    "LEASE_TERMINATION",
    "MANUALLY_INITIATED",
    "LEASE_RESET",
  ],
  {
    error: enumErrorMap,
  },
);

export type CleanupReason = z.infer<typeof CleanupReasonSchema>;

/**
 * Backward-compatible schema that accepts old `RETRY_FAILED_CLEANUP` values
 * from existing DynamoDB records and transforms them to `MANUALLY_INITIATED`.
 * Use this when parsing data that may contain the legacy value.
 *
 * Implementation: a union of the canonical enum (passes through unchanged) and
 * a literal match for the legacy value (transforms to canonical). The output
 * type is correctly inferred as `CleanupReason` without a type assertion.
 */
export const CleanupReasonBackwardCompatibleSchema = z.union([
  CleanupReasonSchema,
  z
    .literal("RETRY_FAILED_CLEANUP")
    .transform((): CleanupReason => "MANUALLY_INITIATED"),
]);

export const CleanAccountRequestSchema = z.object({
  accountId: AwsAccountIdSchema,
  reason: CleanupReasonSchema,
  /**
   * Identity that initiated the cleanup, when a specific actor is known
   * (e.g. the admin email for a manually-initiated cleanup). Omitted for
   * system-triggered cleanups.
   */
  initiatedBy: z.string().optional(),
});

export class CleanAccountRequest implements IsbEvent {
  readonly DetailType = EventDetailTypes.CleanAccountRequest;
  readonly Detail: z.infer<typeof CleanAccountRequestSchema>;

  constructor(eventData: z.infer<typeof CleanAccountRequestSchema>) {
    this.Detail = eventData;
  }

  public static parse(eventDetail: unknown) {
    return new CleanAccountRequest(
      CleanAccountRequestSchema.parse(eventDetail),
    );
  }
}
