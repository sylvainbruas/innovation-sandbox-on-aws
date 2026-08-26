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
    `"1e46cde63c2b28d5547f1903b4cf54b8a214ede3"`,
  );
  expect(LeaseTemplateSchemaVersion).toEqual(4);
});

test("Lease Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(objectHash.sha1(PendingLeaseSchema.shape)).toMatchInlineSnapshot(
    `"739c05d6d508f176215c589da02ec411d70b7cf0"`,
  );
  expect(
    objectHash.sha1(ApprovalDeniedLeaseSchema.shape),
  ).toMatchInlineSnapshot(`"debf5d0f05944bc1b73326919a4441bfbf00c5ea"`);
  expect(objectHash.sha1(MonitoredLeaseSchema.shape)).toMatchInlineSnapshot(
    `"fd7006975b048fc87e2ee0892a04c9fce7a40c0b"`,
  );
  expect(objectHash.sha1(ExpiredLeaseSchema.shape)).toMatchInlineSnapshot(
    `"78baad9302cb24b73ad94c88cf8c6436a9b26242"`,
  );
  expect(LeaseSchemaVersion).toEqual(4);
});

test("SandboxAccount Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(objectHash.sha1(SandboxAccountSchema.shape)).toMatchInlineSnapshot(
    `"a3347fd7aac558b63b24198e3bc039aa13dd36f6"`,
  );
  expect(SandboxAccountSchemaVersion).toEqual(2);
});

test("Blueprint Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(objectHash.sha1(BlueprintItemSchema.shape)).toMatchInlineSnapshot(
    `"281fee84ac41a3208505e530c60792da92f73d42"`,
  );
  expect(objectHash.sha1(StackSetItemSchema.shape)).toMatchInlineSnapshot(
    `"b30be5fc056b1fd4102a28b337daf5edfba10561"`,
  );
  expect(
    objectHash.sha1(DeploymentHistoryItemSchema.shape),
  ).toMatchInlineSnapshot(`"dcbcc8e9cb9a31704d9e4caf1ab7ea1a75416477"`);
  expect(BlueprintSchemaVersion).toEqual(1);
});

test("Principal Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(objectHash.sha1(UserAssignmentSchema.shape)).toMatchInlineSnapshot(
    `"7fccccb74e31d6ece696994096fd5de3a76c97f0"`,
  );
  expect(objectHash.sha1(GroupAssignmentSchema.shape)).toMatchInlineSnapshot(
    `"d20730a6aec66a4a1d6f7b7b59b7510c521eac07"`,
  );
  expect(
    objectHash.sha1(GroupMembershipCacheSchema.shape),
  ).toMatchInlineSnapshot(`"7d6b270ae7f4ffbd3793d1425cf5e5ad38ed791a"`);
  expect(PrincipalSchemaVersion).toEqual(1);
});
