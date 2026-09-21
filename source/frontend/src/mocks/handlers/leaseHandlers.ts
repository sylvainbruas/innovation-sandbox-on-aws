// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  LeaseView,
  MonitoredLeaseView,
} from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import { createActiveLease } from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import { mockLeaseApi } from "@amzn/innovation-sandbox-frontend/mocks/mockApi";

export const mockLease: MonitoredLeaseView = createActiveLease();
mockLeaseApi.returns([mockLease]);

/**
 * Projects a persisted lease into the shape the API returns it as — what a hook
 * receives after the generated client deserializes a read-path response. The
 * restJson1 serializer/deserializer omits, at EVERY level (nested objects and
 * array items), what is not on the wire:
 *   - `meta.schemaVersion` (not modeled — no consumer reads it);
 *   - members that are `null` (e.g. a cleared `blueprintId`) or `undefined` (unset
 *     optionals — e.g. `costReportGroup`, a desired-assignment's `displayName`);
 *   - a structure left with no present members (e.g. a `meta` whose only field was
 *     the dropped `schemaVersion`).
 * A persisted `Lease` (from the store/factory) always carries a required
 * `schemaVersion` and, from `generateSchemaData`, optionals that vary run to run,
 * so it can never equal the API shape directly — read-path tests compare the hook
 * result against `mockApiLease`, not `mockLease`.
 */
export function toApiLease(lease: LeaseView): Record<string, unknown> {
  return stripUnmodeled(lease) as Record<string, unknown>;
}

// Recursive worker: walks arbitrary nested wire values (hence `unknown`), dropping
// what `toApiLease` documents. Only the public entry above is lease-typed.
function stripUnmodeled(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUnmodeled);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      // `schemaVersion` is present-but-unmodeled, so the wire drops it whatever
      // its value; the null/undefined/empty rules below cover everything else.
      if (key === "schemaVersion" || member === null || member === undefined) {
        continue;
      }
      const projected = stripUnmodeled(member);
      if (
        projected !== null &&
        typeof projected === "object" &&
        !Array.isArray(projected) &&
        Object.keys(projected).length === 0
      ) {
        continue;
      }
      out[key] = projected;
    }
    return out;
  }
  return value;
}

/** `mockLease` as the API returns it (see `toApiLease`). */
export const mockApiLease = toApiLease(mockLease);

export const leaseHandlers = [
  mockLeaseApi.getHandler(),
  mockLeaseApi.getHandler("/:id"),
  mockLeaseApi.patchHandler("/:id"),
  mockLeaseApi.postHandler("/request"),
  mockLeaseApi.reviewHandler("/review"),
];
