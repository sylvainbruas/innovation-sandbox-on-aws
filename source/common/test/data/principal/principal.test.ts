// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  GroupAssignmentSchema,
  GroupMembershipCacheSchema,
  IdcPrincipalIdSchema,
  PRINCIPAL_CACHE_GROUP_SK_PREFIX,
  PRINCIPAL_CACHE_PK,
  PRINCIPAL_CACHE_USER_SK_PREFIX,
  PrincipalCacheItemSchema,
  PrincipalSchemaVersion,
  PrincipalTypeSchema,
  UserAssignmentSchema,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";

const VALID_UUID = "00000000-0000-4000-8000-000000000001";
const VALID_IDC_ID_PREFIXED = "0000000000-00000000-0000-0000-0000-000000000002";
const NOW = new Date().toISOString();

const validMeta = {
  meta: {
    schemaVersion: PrincipalSchemaVersion,
    createdTime: NOW,
    lastEditTime: NOW,
  },
};

function validUserAssignment(overrides = {}) {
  return {
    pk: "user#" + VALID_UUID,
    sk: "lease#" + VALID_UUID,
    userId: VALID_UUID,
    principalType: "USER" as const,
    leaseId: VALID_UUID,
    assigneeEmail: "assignee@example.com",
    leaseOwnerEmail: "owner@example.com",
    addedBy: "admin@example.com",
    addedDate: NOW,
    ...validMeta,
    ...overrides,
  };
}

function validGroupAssignment(overrides = {}) {
  return {
    pk: "group#" + VALID_UUID,
    sk: "lease#" + VALID_UUID,
    leaseId: VALID_UUID,
    groupId: VALID_UUID,
    principalType: "GROUP" as const,
    displayName: "Engineering Team",
    leaseOwnerEmail: "owner@example.com",
    addedBy: "admin@example.com",
    addedDate: NOW,
    ...validMeta,
    ...overrides,
  };
}

function validGroupMembershipCache(overrides = {}) {
  return {
    pk: "user#" + VALID_UUID,
    sk: "groupMembership" as const,
    groupIds: [VALID_UUID, VALID_IDC_ID_PREFIXED],
    ttl: Math.floor(Date.now() / 1000) + 86400,
    ...validMeta,
    ...overrides,
  };
}

describe("Principal Validation", () => {
  describe("IdcPrincipalIdSchema", () => {
    it.each([VALID_UUID, VALID_IDC_ID_PREFIXED])(
      "should accept valid IDC ID: %s",
      (id) => {
        expect(IdcPrincipalIdSchema.safeParse(id).success).toBe(true);
      },
    );

    it.each([
      "",
      "not-a-valid-id",
      "000000000-00000000-0000-0000-0000-000000000001",
    ])("should reject invalid IDC ID: %s", (id) => {
      expect(IdcPrincipalIdSchema.safeParse(id).success).toBe(false);
    });
  });

  describe("PrincipalTypeSchema", () => {
    it.each(["USER", "GROUP"])("should accept %s", (type) => {
      expect(PrincipalTypeSchema.safeParse(type).success).toBe(true);
    });

    it("should reject invalid type", () => {
      expect(PrincipalTypeSchema.safeParse("INVALID").success).toBe(false);
    });
  });

  describe("UserAssignmentSchema", () => {
    it("should accept a valid user assignment", () => {
      expect(
        UserAssignmentSchema.safeParse(validUserAssignment()).success,
      ).toBe(true);
    });

    it("should accept with optional fields populated", () => {
      expect(
        UserAssignmentSchema.safeParse(
          validUserAssignment({
            accountId: "123456789012",
            permissionSetArn: "arn:aws:sso:::permissionSet/ssoins-1234/ps-1234",
          }),
        ).success,
      ).toBe(true);
    });

    it("should accept with prefixed IDC ID in pk", () => {
      expect(
        UserAssignmentSchema.safeParse(
          validUserAssignment({
            pk: "user#" + VALID_IDC_ID_PREFIXED,
            userId: VALID_IDC_ID_PREFIXED,
          }),
        ).success,
      ).toBe(true);
    });

    it.each([
      ["pk without user# prefix", { pk: VALID_UUID }],
      ["pk with invalid IDC ID", { pk: "user#not-valid" }],
      ["sk without lease# prefix", { sk: VALID_UUID }],
      ["sk with non-UUID after lease#", { sk: "lease#not-a-uuid" }],
      ["invalid email", { assigneeEmail: "not-an-email" }],
      ["extra fields (strict)", { unexpectedField: "value" }],
    ])("should reject %s", (_label, overrides) => {
      expect(
        UserAssignmentSchema.safeParse(validUserAssignment(overrides)).success,
      ).toBe(false);
    });
  });

  describe("GroupAssignmentSchema", () => {
    it("should accept a valid group assignment", () => {
      expect(
        GroupAssignmentSchema.safeParse(validGroupAssignment()).success,
      ).toBe(true);
    });

    it("should accept with prefixed IDC ID in pk and groupId", () => {
      expect(
        GroupAssignmentSchema.safeParse(
          validGroupAssignment({
            pk: "group#" + VALID_IDC_ID_PREFIXED,
            groupId: VALID_IDC_ID_PREFIXED,
          }),
        ).success,
      ).toBe(true);
    });

    it.each([
      ["pk without group# prefix", { pk: "user#" + VALID_UUID }],
      ["invalid groupId", { groupId: "not-valid" }],
      ["empty group name", { displayName: "" }],
      ["group name exceeding 1024 chars", { displayName: "A".repeat(1025) }],
      ["extra fields (strict)", { unexpectedField: "value" }],
    ])("should reject %s", (_label, overrides) => {
      expect(
        GroupAssignmentSchema.safeParse(validGroupAssignment(overrides))
          .success,
      ).toBe(false);
    });
  });

  describe("GroupMembershipCacheSchema", () => {
    it("should accept a valid cache record", () => {
      expect(
        GroupMembershipCacheSchema.safeParse(validGroupMembershipCache())
          .success,
      ).toBe(true);
    });

    it("should accept empty groupIds array", () => {
      expect(
        GroupMembershipCacheSchema.safeParse(
          validGroupMembershipCache({ groupIds: [] }),
        ).success,
      ).toBe(true);
    });

    it.each([
      ["invalid groupIds entries", { groupIds: ["not-valid-id"] }],
      ["non-groupMembership sk", { sk: "lease#some-id" }],
      ["negative ttl", { ttl: -1 }],
      ["non-integer ttl", { ttl: 1234.56 }],
      ["pk without user# prefix", { pk: "group#" + VALID_UUID }],
      ["extra fields (strict)", { unexpectedField: "value" }],
    ])("should reject %s", (_label, overrides) => {
      expect(
        GroupMembershipCacheSchema.safeParse(
          validGroupMembershipCache(overrides),
        ).success,
      ).toBe(false);
    });
  });

  describe("PrincipalCacheItemSchema", () => {
    function createUserCacheItem(overrides = {}) {
      return {
        pk: PRINCIPAL_CACHE_PK,
        sk: `${PRINCIPAL_CACHE_USER_SK_PREFIX}${VALID_UUID}`,
        principalId: VALID_UUID,
        principalType: "USER",
        displayName: "Test User",
        email: "test@example.com",
        syncedAt: NOW,
        ttl: Math.floor(Date.now() / 1000) + 172800,
        ...overrides,
      };
    }

    function createGroupCacheItem(overrides = {}) {
      return {
        pk: PRINCIPAL_CACHE_PK,
        sk: `${PRINCIPAL_CACHE_GROUP_SK_PREFIX}${VALID_UUID}`,
        principalId: VALID_UUID,
        principalType: "GROUP",
        displayName: "Test Group",
        syncedAt: NOW,
        ttl: Math.floor(Date.now() / 1000) + 172800,
        ...overrides,
      };
    }

    it("should accept a valid USER cache item", () => {
      expect(
        PrincipalCacheItemSchema.safeParse(createUserCacheItem()).success,
      ).toBe(true);
    });

    it("should accept a valid GROUP cache item", () => {
      expect(
        PrincipalCacheItemSchema.safeParse(createGroupCacheItem()).success,
      ).toBe(true);
    });

    it("should reject wrong pk value", () => {
      expect(
        PrincipalCacheItemSchema.safeParse(
          createUserCacheItem({ pk: "wrongValue" }),
        ).success,
      ).toBe(false);
    });

    it("should reject empty displayName", () => {
      expect(
        PrincipalCacheItemSchema.safeParse(
          createUserCacheItem({ displayName: "" }),
        ).success,
      ).toBe(false);
    });

    it("should reject invalid email format", () => {
      expect(
        PrincipalCacheItemSchema.safeParse(
          createUserCacheItem({ email: "not-an-email" }),
        ).success,
      ).toBe(false);
    });

    it("should reject missing required fields", () => {
      const { principalId, ...missing } = createUserCacheItem();
      expect(PrincipalCacheItemSchema.safeParse(missing).success).toBe(false);
    });

    it("should reject extra fields (strict mode)", () => {
      expect(
        PrincipalCacheItemSchema.safeParse(
          createUserCacheItem({ unexpectedField: "value" }),
        ).success,
      ).toBe(false);
    });
  });
});
