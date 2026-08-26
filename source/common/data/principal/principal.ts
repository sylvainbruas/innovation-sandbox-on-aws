// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import {
  createItemWithMetadataSchema,
  createVersionRangeSchema,
} from "@amzn/innovation-sandbox-commons/data/metadata.js";
import { enumErrorMap } from "@amzn/innovation-sandbox-commons/utils/zod.js";

export const PrincipalSchemaVersion = 1;

const PrincipalSupportedVersionsSchema = createVersionRangeSchema(
  1,
  PrincipalSchemaVersion,
);

const PrincipalItemWithMetadataSchema = createItemWithMetadataSchema(
  PrincipalSupportedVersionsSchema,
);

// Shared enums

/** Distinguishes between user and group principals. */
export const PrincipalTypeSchema = z.enum(["USER", "GROUP"], {
  error: enumErrorMap,
});

const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

// IDC principal ID: plain UUID (36 chars) or 10-char hex prefix + UUID (47 chars)
const IDC_PRINCIPAL_ID_PATTERN =
  "([0-9a-f]{10}-)?[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}";

/** Validates an IDC principal ID (plain UUID or 10-char hex prefix + UUID). */
export const IdcPrincipalIdSchema = z
  .string()
  .regex(
    new RegExp(`^${IDC_PRINCIPAL_ID_PATTERN}$`),
    "Must be a valid IDC principal ID",
  );

/** Direct user-to-lease assignment record. PK: `user#<userId>`, SK: `lease#<leaseId>`. */
export const UserAssignmentSchema = z
  .object({
    pk: z
      .string()
      .regex(
        new RegExp(`^user#${IDC_PRINCIPAL_ID_PATTERN}$`),
        "pk must be 'user#' followed by a valid IDC user ID",
      ),
    sk: z
      .string()
      .regex(
        new RegExp(`^lease#${UUID_PATTERN}$`),
        "sk must be 'lease#' followed by a valid UUID",
      ),
    userId: IdcPrincipalIdSchema,
    principalType: z.literal("USER"),
    leaseId: z.uuid(),
    displayName: z.string().min(1).optional(),
    assigneeEmail: z.email(),
    leaseOwnerEmail: z.email(),
    accountId: z.string().optional(),
    permissionSetArn: z.string().optional(),
    addedBy: z.email(),
    addedDate: z.iso.datetime(),
  })
  .merge(PrincipalItemWithMetadataSchema)
  .strict();

/** Group-to-lease assignment record. PK: `group#<groupId>`, SK: `lease#<leaseId>`. */
export const GroupAssignmentSchema = z
  .object({
    pk: z
      .string()
      .regex(
        new RegExp(`^group#${IDC_PRINCIPAL_ID_PATTERN}$`),
        "pk must be 'group#' followed by a valid IDC group ID",
      ),
    sk: z
      .string()
      .regex(
        new RegExp(`^lease#${UUID_PATTERN}$`),
        "sk must be 'lease#' followed by a valid UUID",
      ),
    leaseId: z.uuid(),
    groupId: IdcPrincipalIdSchema,
    principalType: z.literal("GROUP"),
    displayName: z
      .string()
      .min(1)
      .max(1024)
      .regex(
        /^[\p{L}\p{M}\p{S}\p{N}\p{P}\t\n\r  ]+$/u,
        "Must be a valid IDC group display name",
      ),
    leaseOwnerEmail: z.email(),
    accountId: z.string().optional(),
    permissionSetArn: z.string().optional(),
    addedBy: z.email(),
    addedDate: z.iso.datetime(),
  })
  .merge(PrincipalItemWithMetadataSchema)
  .strict();

/** Validates the KEYS_ONLY projection of group-assignment records on the `GroupIndex` GSI. */
export const GroupIndexProjectionSchema = GroupAssignmentSchema.pick({
  pk: true,
  sk: true,
  groupId: true,
});

/** Cached IDC group IDs for a user, refreshed lazily with 24h TTL. PK: `user#<userId>`, SK: `groupMembership`. */
export const GroupMembershipCacheSchema = z
  .object({
    pk: z
      .string()
      .regex(
        new RegExp(`^user#${IDC_PRINCIPAL_ID_PATTERN}$`),
        "pk must be 'user#' followed by a valid IDC user ID",
      ),
    sk: z.literal("groupMembership"),
    groupIds: z.array(IdcPrincipalIdSchema),
    ttl: z.number().int().nonnegative(),
  })
  .merge(PrincipalItemWithMetadataSchema)
  .strict();

export type PrincipalType = z.infer<typeof PrincipalTypeSchema>;
export type UserAssignment = z.infer<typeof UserAssignmentSchema>;
export type GroupAssignment = z.infer<typeof GroupAssignmentSchema>;
export type GroupMembershipCache = z.infer<typeof GroupMembershipCacheSchema>;

/** Union of user and group assignment records, discriminated on principalType. */
export const AssignmentSchema = z.discriminatedUnion("principalType", [
  UserAssignmentSchema,
  GroupAssignmentSchema,
]);
export type Assignment = z.infer<typeof AssignmentSchema>;

/** Union of all principal table item types. */
export type PrincipalTableItem =
  | UserAssignment
  | GroupAssignment
  | GroupMembershipCache
  | PrincipalCacheItem;

/** Cached IDC principal for typeahead search. PK: `principalCache`, SK: `user#<userId>` or `group#<groupId>`. */
export const PRINCIPAL_CACHE_PK = "principalCache" as const;
export const PRINCIPAL_CACHE_USER_SK_PREFIX = "user#" as const;
export const PRINCIPAL_CACHE_GROUP_SK_PREFIX = "group#" as const;

/** Schema for cached principal records synced hourly from Identity Store. */
export const PrincipalCacheItemSchema = z
  .object({
    pk: z.literal(PRINCIPAL_CACHE_PK),
    sk: z
      .string()
      .regex(
        new RegExp(
          `^(${PRINCIPAL_CACHE_USER_SK_PREFIX}|${PRINCIPAL_CACHE_GROUP_SK_PREFIX})${IDC_PRINCIPAL_ID_PATTERN}$`,
        ),
        "sk must be 'user#' or 'group#' followed by a valid IDC principal ID",
      ),
    principalId: IdcPrincipalIdSchema,
    principalType: PrincipalTypeSchema,
    displayName: z.string().min(1).optional(),
    email: z.email().optional(),
    syncedAt: z.iso.datetime(),
    ttl: z.number().int().nonnegative(),
  })
  .merge(PrincipalItemWithMetadataSchema)
  .strict();

export type PrincipalCacheItem = z.infer<typeof PrincipalCacheItemSchema>;
