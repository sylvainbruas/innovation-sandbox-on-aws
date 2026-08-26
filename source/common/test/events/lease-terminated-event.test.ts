// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import { MonitoredLeaseSchema } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { getLeaseTerminatedReason } from "@amzn/innovation-sandbox-commons/events/lease-terminated-event.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";

describe("getLeaseTerminatedReason", () => {
  test("returns UserTerminated reason payload for UserTerminated status", () => {
    const lease = generateSchemaData(MonitoredLeaseSchema, {
      status: "Active",
    });

    expect(getLeaseTerminatedReason("UserTerminated", lease)).toEqual({
      type: "UserTerminated",
      comment: "Terminated by user",
    });
  });
});
