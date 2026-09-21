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
  BlueprintSchemaVersion,
  PersistedBlueprintItemSchema,
  PersistedDeploymentHistoryItemSchema,
  PersistedStackSetItemSchema,
} from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint.js";
import {
  LeaseTemplateSchemaVersion,
  PersistedLeaseTemplateSchema,
} from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import {
  LeaseSchemaVersion,
  PersistedApprovalDeniedLeaseSchema,
  PersistedExpiredLeaseSchema,
  PersistedMonitoredLeaseSchema,
  PersistedPendingLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  PersistedGroupAssignmentSchema,
  PersistedGroupMembershipCacheSchema,
  PersistedUserAssignmentSchema,
  PrincipalSchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import {
  PersistedSandboxAccountSchema,
  SandboxAccountSchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";

test("LeaseTemplate Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(
    objectHash.sha1(PersistedLeaseTemplateSchema.shape),
  ).toMatchInlineSnapshot(`"3ce2bba84ef99205bc2131aaa09a7e1a0e2c8388"`);
  expect(LeaseTemplateSchemaVersion).toEqual(4);
});

test("Lease Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(
    objectHash.sha1(PersistedPendingLeaseSchema.shape),
  ).toMatchInlineSnapshot(`"56c366826e834e16daa17e05b8509ae1110e4694"`);
  expect(
    objectHash.sha1(PersistedApprovalDeniedLeaseSchema.shape),
  ).toMatchInlineSnapshot(`"e994b3d0c0c305a542b9204c7e18a940510cc835"`);
  expect(
    objectHash.sha1(PersistedMonitoredLeaseSchema.shape),
  ).toMatchInlineSnapshot(`"ad902edf355918a40baefa5d960afd70e88b6690"`);
  expect(
    objectHash.sha1(PersistedExpiredLeaseSchema.shape),
  ).toMatchInlineSnapshot(`"ed02e23d18c18c891f869be08b4b79872ea3922a"`);
  expect(LeaseSchemaVersion).toEqual(4);
});

test("PersistedSandboxAccount Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(
    objectHash.sha1(PersistedSandboxAccountSchema.shape),
  ).toMatchInlineSnapshot(`"986a4e50112549f8d283df4c3bc5ebdb0304e756"`);
  expect(SandboxAccountSchemaVersion).toEqual(2);
});

test("Blueprint Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(
    objectHash.sha1(PersistedBlueprintItemSchema.shape),
  ).toMatchInlineSnapshot(`"4791d017fe73a3890bc634759b83e06110e777c9"`);
  expect(
    objectHash.sha1(PersistedStackSetItemSchema.shape),
  ).toMatchInlineSnapshot(`"29048ca26d32f1ad5c03d9b69decbcd70b35eb97"`);
  expect(
    objectHash.sha1(PersistedDeploymentHistoryItemSchema.shape),
  ).toMatchInlineSnapshot(`"4627b913d536e97fbb9ffcb83f9b215aadb13a08"`);
  expect(BlueprintSchemaVersion).toEqual(1);
});

test("Principal Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(
    objectHash.sha1(PersistedUserAssignmentSchema.shape),
  ).toMatchInlineSnapshot(`"117b5fdde1d7fffabfb8837e1c19bff46bb05563"`);
  expect(
    objectHash.sha1(PersistedGroupAssignmentSchema.shape),
  ).toMatchInlineSnapshot(`"45228edf4477170c4a8835e673bdf09d3b131ccf"`);
  expect(
    objectHash.sha1(PersistedGroupMembershipCacheSchema.shape),
  ).toMatchInlineSnapshot(`"0642e5aa84b4478db15f3c22a56a646bedef044b"`);
  expect(PrincipalSchemaVersion).toEqual(1);
});
