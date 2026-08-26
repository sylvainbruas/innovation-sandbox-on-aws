// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  IAMClient,
  ListRolesCommand,
  ListRoleTagsCommand,
} from "@aws-sdk/client-iam";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import {
  buildM2mRolePrefix,
  M2M_ISB_ID_TAG_KEY,
  M2M_ROLE_NAME_INFIX,
  M2M_STACK_TYPE_TAG_KEY,
  M2M_STACK_TYPE_TAG_VALUE,
} from "@amzn/innovation-sandbox-commons/utils/m2m-role-arn.js";
import { countM2mClients } from "@amzn/innovation-sandbox-deployment-summary-heartbeat/m2m-client-discovery.js";

const NAMESPACE = "myisb";
const ROLE_PREFIX = `${NAMESPACE}-${M2M_ROLE_NAME_INFIX}-`;
const iamMock = mockClient(IAMClient);

function role(name: string) {
  return {
    RoleName: name,
    Arn: `arn:aws:iam::123456789012:role/${buildM2mRolePrefix(NAMESPACE)}/${name}`,
    Path: `/${buildM2mRolePrefix(NAMESPACE)}/`,
    RoleId: `AROA${name}`,
    CreateDate: new Date(0),
  };
}

const M2M_TAGS = [
  { Key: M2M_STACK_TYPE_TAG_KEY, Value: M2M_STACK_TYPE_TAG_VALUE },
  { Key: M2M_ISB_ID_TAG_KEY, Value: `${NAMESPACE}_isb` },
];

describe("countM2mClients", () => {
  beforeEach(() => {
    iamMock.reset();
  });

  it("counts roles tagged as M2mClient for the namespace", async () => {
    iamMock.on(ListRolesCommand).resolves({
      Roles: [
        role(`${ROLE_PREFIX}admin-clientA`),
        role(`${ROLE_PREFIX}user-clientB`),
      ],
      IsTruncated: false,
    });
    iamMock.on(ListRoleTagsCommand).resolves({ Tags: M2M_TAGS });

    expect(await countM2mClients(new IAMClient({}), NAMESPACE)).toBe(2);
  });

  it("scopes the ListRoles call to the M2M path prefix", async () => {
    iamMock.on(ListRolesCommand).resolves({ Roles: [] });

    await countM2mClients(new IAMClient({}), NAMESPACE);

    const call = iamMock.commandCalls(ListRolesCommand)[0];
    // Literal on purpose: pins the exact wire format so a change in
    // buildM2mRolePrefix is caught rather than mirrored.
    expect(call?.args[0].input).toMatchObject({
      PathPrefix: `/isb-m2m/${NAMESPACE}/`,
    });
  });

  it("excludes roles missing the M2mClient stack-type tag", async () => {
    iamMock
      .on(ListRolesCommand)
      .resolves({ Roles: [role(`${ROLE_PREFIX}admin-x`)] });
    iamMock.on(ListRoleTagsCommand).resolves({
      Tags: [{ Key: M2M_ISB_ID_TAG_KEY, Value: `${NAMESPACE}_isb` }],
    });

    expect(await countM2mClients(new IAMClient({}), NAMESPACE)).toBe(0);
  });

  it("excludes M2mClient roles from a different namespace (isb-id mismatch)", async () => {
    iamMock
      .on(ListRolesCommand)
      .resolves({ Roles: [role(`${ROLE_PREFIX}admin-x`)] });
    iamMock.on(ListRoleTagsCommand).resolves({
      Tags: [
        { Key: M2M_STACK_TYPE_TAG_KEY, Value: M2M_STACK_TYPE_TAG_VALUE },
        { Key: M2M_ISB_ID_TAG_KEY, Value: "otherns_isb" },
      ],
    });

    expect(await countM2mClients(new IAMClient({}), NAMESPACE)).toBe(0);
  });

  it("pre-filters by the name prefix without fetching tags", async () => {
    // A role returned under the path prefix whose name doesn't match the
    // <ns>-isb-m2m- prefix is dropped by the in-memory belt-and-suspenders
    // check before any ListRoleTags call is made.
    iamMock.on(ListRolesCommand).resolves({
      Roles: [role(`${NAMESPACE}-not-an-m2m-role`)],
    });

    expect(await countM2mClients(new IAMClient({}), NAMESPACE)).toBe(0);
    expect(iamMock.commandCalls(ListRoleTagsCommand)).toHaveLength(0);
  });

  it("paginates list-roles", async () => {
    iamMock
      .on(ListRolesCommand)
      .resolvesOnce({
        Roles: [role(`${ROLE_PREFIX}admin-a`)],
        IsTruncated: true,
        Marker: "next",
      })
      .resolvesOnce({
        Roles: [role(`${ROLE_PREFIX}user-b`)],
        IsTruncated: false,
      });
    iamMock.on(ListRoleTagsCommand).resolves({ Tags: M2M_TAGS });

    expect(await countM2mClients(new IAMClient({}), NAMESPACE)).toBe(2);
    expect(iamMock.commandCalls(ListRolesCommand)).toHaveLength(2);
  });

  it("paginates per-role tags", async () => {
    iamMock
      .on(ListRolesCommand)
      .resolves({ Roles: [role(`${ROLE_PREFIX}admin-a`)] });
    iamMock
      .on(ListRoleTagsCommand)
      .resolvesOnce({
        Tags: [
          { Key: M2M_STACK_TYPE_TAG_KEY, Value: M2M_STACK_TYPE_TAG_VALUE },
        ],
        IsTruncated: true,
        Marker: "next",
      })
      .resolvesOnce({
        Tags: [{ Key: M2M_ISB_ID_TAG_KEY, Value: `${NAMESPACE}_isb` }],
        IsTruncated: false,
      });

    expect(await countM2mClients(new IAMClient({}), NAMESPACE)).toBe(1);
    expect(iamMock.commandCalls(ListRoleTagsCommand)).toHaveLength(2);
  });

  it("returns 0 when there are no roles", async () => {
    iamMock.on(ListRolesCommand).resolves({ Roles: [] });
    expect(await countM2mClients(new IAMClient({}), NAMESPACE)).toBe(0);
  });
});
