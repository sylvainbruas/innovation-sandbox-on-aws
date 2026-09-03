// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * maintaining accurate and consistent schema versions for all tables is critical to the update methodology
 * of the solution (described in ADR-0002)
 *
 * this file tests that all schemas match their specified schema version. if a test fails, the test should be
 * updated to pass ONLY after verifying that schema versions have been correctly maintained.
 *
 * rules for updating schema version:
 *   - if any fields have been added or changed since the last public release of the solution, the schema version
 *   must be incremented exactly once for the next release of the solution.
 *   - changes to any schema must also include a migration script and related migration test (under test/migration)
 *   that ensures data can be safely migrated.
 */
import objectHash from "object-hash";
import { expect, test } from "vitest";

import {
  BlueprintItemSchema,
  BlueprintSchemaVersion,
  DeploymentHistoryItemSchema,
  StackSetItemSchema,
} from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint.js";
import {
  LeaseTemplateSchema,
  LeaseTemplateSchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import {
  ApprovalDeniedLeaseSchema,
  ExpiredLeaseSchema,
  LeaseSchemaVersion,
  MonitoredLeaseSchema,
  PendingLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  GroupAssignmentSchema,
  GroupMembershipCacheSchema,
  PrincipalSchemaVersion,
  UserAssignmentSchema,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import {
  SandboxAccountSchema,
  SandboxAccountSchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";

test("LeaseTemplate Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(objectHash.sha1(LeaseTemplateSchema.shape)).toMatchInlineSnapshot(
    `"3ce2bba84ef99205bc2131aaa09a7e1a0e2c8388"`,
  );
  expect(LeaseTemplateSchemaVersion).toEqual(4);
});

test("Lease Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(objectHash.sha1(PendingLeaseSchema.shape)).toMatchInlineSnapshot(
    `"66fcec3c54b2e9cbfa5eb2de1a911bf460b0b3cd"`,
  );
  expect(
    objectHash.sha1(ApprovalDeniedLeaseSchema.shape),
  ).toMatchInlineSnapshot(`"52adb1f2637db740794d78758b1775dc784ab48d"`);
  expect(objectHash.sha1(MonitoredLeaseSchema.shape)).toMatchInlineSnapshot(
    `"672070dbe8e918aa89ed239e055a09fe6ca61d19"`,
  );
  expect(objectHash.sha1(ExpiredLeaseSchema.shape)).toMatchInlineSnapshot(
    `"4a393dc9007e6ec192a292385cb13c954f3e6a1b"`,
  );
  expect(LeaseSchemaVersion).toEqual(4);
});

test("SandboxAccount Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(objectHash.sha1(SandboxAccountSchema.shape)).toMatchInlineSnapshot(
    `"986a4e50112549f8d283df4c3bc5ebdb0304e756"`,
  );
  expect(SandboxAccountSchemaVersion).toEqual(2);
});

test("Blueprint Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(objectHash.sha1(BlueprintItemSchema.shape)).toMatchInlineSnapshot(
    `"4791d017fe73a3890bc634759b83e06110e777c9"`,
  );
  expect(objectHash.sha1(StackSetItemSchema.shape)).toMatchInlineSnapshot(
    `"29048ca26d32f1ad5c03d9b69decbcd70b35eb97"`,
  );
  expect(
    objectHash.sha1(DeploymentHistoryItemSchema.shape),
  ).toMatchInlineSnapshot(`"4627b913d536e97fbb9ffcb83f9b215aadb13a08"`);
  expect(BlueprintSchemaVersion).toEqual(1);
});

test("Principal Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(objectHash.sha1(UserAssignmentSchema.shape)).toMatchInlineSnapshot(
    `"117b5fdde1d7fffabfb8837e1c19bff46bb05563"`,
  );
  expect(objectHash.sha1(GroupAssignmentSchema.shape)).toMatchInlineSnapshot(
    `"45228edf4477170c4a8835e673bdf09d3b131ccf"`,
  );
  expect(
    objectHash.sha1(GroupMembershipCacheSchema.shape),
  ).toMatchInlineSnapshot(`"0642e5aa84b4478db15f3c22a56a646bedef044b"`);
  expect(PrincipalSchemaVersion).toEqual(1);
});
