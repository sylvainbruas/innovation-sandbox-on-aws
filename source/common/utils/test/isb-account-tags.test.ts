// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { MonitoredLeaseSchema } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  buildLeaseTagSet,
  fromCeTagKey,
  isbAccountTagKeys,
  IsbStatusTagValueSchema,
  isbTagKeyPrefix,
  NO_COST_REPORT_GROUP_TAG_VALUE,
  toCeTagKey,
  toIsbTagKey,
} from "@amzn/innovation-sandbox-commons/utils/isb-account-tags.js";

describe("IsbStatusTagValueSchema", () => {
  it.each(["Available", "Active", "Frozen", "CleanUp", "Quarantine"] as const)(
    "accepts %s",
    (status) => {
      expect(IsbStatusTagValueSchema.parse(status)).toBe(status);
    },
  );

  it("rejects arbitrary strings", () => {
    expect(() => IsbStatusTagValueSchema.parse("Something")).toThrow();
  });
});

describe("buildLeaseTagSet", () => {
  const leaseWithGroup = generateSchemaData(MonitoredLeaseSchema, {
    uuid: "00000000-0000-4000-8000-000000000001",
    userEmail: "user@example.com",
    originalLeaseTemplateUuid: "00000000-0000-4000-8000-000000000002",
    costReportGroup: "team-alpha",
  });
  const leaseWithoutGroup = generateSchemaData(MonitoredLeaseSchema, {
    uuid: "00000000-0000-4000-8000-000000000001",
    userEmail: "user@example.com",
    originalLeaseTemplateUuid: "00000000-0000-4000-8000-000000000002",
    costReportGroup: undefined,
  });
  const userId = "idc-user-abc123";

  it("returns exactly 4 entries", () => {
    const tags = buildLeaseTagSet(leaseWithGroup, userId);
    expect(Object.keys(tags)).toHaveLength(4);
  });

  it("populates each key from the expected source", () => {
    expect(buildLeaseTagSet(leaseWithGroup, userId)).toEqual({
      LeaseId: "00000000-0000-4000-8000-000000000001",
      CostReportGroup: "team-alpha",
      LeaseTemplate: "00000000-0000-4000-8000-000000000002",
      User: "idc-user-abc123",
    });
  });

  it("falls back to the sentinel when the lease has no costReportGroup", () => {
    expect(buildLeaseTagSet(leaseWithoutGroup, userId)).toMatchObject({
      CostReportGroup: NO_COST_REPORT_GROUP_TAG_VALUE,
    });
  });

  it("does not include the Status tag", () => {
    const tags = buildLeaseTagSet(leaseWithGroup, userId);
    expect(Object.keys(tags)).not.toContain("Status");
  });
});

describe("namespaced tag keys", () => {
  it("prefixes keys with ISB-<namespace>:", () => {
    expect(isbTagKeyPrefix("myisb")).toBe("ISB-myisb:");
    expect(toIsbTagKey("myisb", "LeaseId")).toBe("ISB-myisb:LeaseId");
  });

  it("isbAccountTagKeys returns all 5 keys for the namespace", () => {
    expect(isbAccountTagKeys("myisb")).toEqual([
      "ISB-myisb:LeaseId",
      "ISB-myisb:CostReportGroup",
      "ISB-myisb:LeaseTemplate",
      "ISB-myisb:User",
      "ISB-myisb:Status",
    ]);
  });

  it("keeps two deployments in the same organization disjoint", () => {
    const a = isbAccountTagKeys("teamA");
    const b = isbAccountTagKeys("teamB");
    expect(a.filter((key) => b.includes(key))).toEqual([]);
  });
});

describe("toCeTagKey / fromCeTagKey", () => {
  it("toCeTagKey prepends the accountTag/ prefix", () => {
    expect(toCeTagKey("ISB-myisb:LeaseId")).toBe(
      "accountTag/ISB-myisb:LeaseId",
    );
  });

  it("fromCeTagKey strips the accountTag/ prefix when present", () => {
    expect(fromCeTagKey("accountTag/ISB-myisb:LeaseId")).toBe(
      "ISB-myisb:LeaseId",
    );
  });

  it("fromCeTagKey returns the input unchanged when the prefix is missing", () => {
    // Safe-passthrough: callers can pass already-bare keys without harm.
    expect(fromCeTagKey("ISB-myisb:LeaseId")).toBe("ISB-myisb:LeaseId");
  });

  it("fromCeTagKey only strips at the start, not embedded occurrences", () => {
    // "accountTag/" inside the key (not at position 0) must not be stripped.
    expect(fromCeTagKey("foo/accountTag/bar")).toBe("foo/accountTag/bar");
  });

  it("toCeTagKey and fromCeTagKey round-trip cleanly", () => {
    const original = "ISB-myisb:CostReportGroup";
    expect(fromCeTagKey(toCeTagKey(original))).toBe(original);
  });
});
