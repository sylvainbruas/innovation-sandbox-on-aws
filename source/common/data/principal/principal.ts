// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import {
  createItemWithMetadataSchema,
  createVersionRangeSchema,
} from "@amzn/innovation-sandbox-commons/data/metadata.js";
import {
  IdcPrincipalIdSchema,
  IdcPrincipalSchema,
} from "@amzn/innovation-sandbox-shared/types/principal.js";

export const PrincipalSchemaVersion = 1;

const PrincipalSupportedVersionsSchema = createVersionRangeSchema(
  1,
  PrincipalSchemaVersion,
);

const PrincipalItemWithMetadataSchema = createItemWithMetadataSchema(
  PrincipalSupportedVersionsSchema,
);

const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

// IDC principal ID: plain UUID (36 chars) or 10-char hex prefix + UUID (47 chars)
const IDC_PRINCIPAL_ID_PATTERN =
  "([0-9a-f]{10}-)?[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}";

/** Direct user-to-lease assignment record. PK: `user#<userId>`, SK: `lease#<leaseId>`. */
export const PersistedUserAssignmentSchema = z
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
export const PersistedGroupAssignmentSchema = z
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
export const PersistedGroupIndexProjectionSchema =
  PersistedGroupAssignmentSchema.pick({
    pk: true,
    sk: true,
    groupId: true,
  });

/** Cached IDC group IDs for a user, refreshed lazily with 24h TTL. PK: `user#<userId>`, SK: `groupMembership`. */
export const PersistedGroupMembershipCacheSchema = z
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

export type PersistedUserAssignment = z.infer<
  typeof PersistedUserAssignmentSchema
>;
export type PersistedGroupAssignment = z.infer<
  typeof PersistedGroupAssignmentSchema
>;
export type PersistedGroupMembershipCache = z.infer<
  typeof PersistedGroupMembershipCacheSchema
>;

/** Union of user and group assignment records, discriminated on principalType. */
export const PersistedAssignmentSchema = z.discriminatedUnion("principalType", [
  PersistedUserAssignmentSchema,
  PersistedGroupAssignmentSchema,
]);
export type PersistedAssignment = z.infer<typeof PersistedAssignmentSchema>;

/** Union of all principal table item types. */
export type PersistedPrincipalTableItem =
  | PersistedUserAssignment
  | PersistedGroupAssignment
  | PersistedGroupMembershipCache
  | PersistedPrincipalCacheItem;

/** Cached IDC principal for typeahead search. PK: `principalCache`, SK: `user#<userId>` or `group#<groupId>`. */
export const PRINCIPAL_CACHE_PK = "principalCache" as const;
export const PRINCIPAL_CACHE_USER_SK_PREFIX = "user#" as const;
export const PRINCIPAL_CACHE_GROUP_SK_PREFIX = "group#" as const;

/** Schema for cached principal records synced hourly from Identity Store. */
export const PersistedPrincipalCacheItemSchema = z
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
    ...IdcPrincipalSchema.shape,
    syncedAt: z.iso.datetime(),
    ttl: z.number().int().nonnegative(),
  })
  .merge(PrincipalItemWithMetadataSchema)
  .strict();

export type PersistedPrincipalCacheItem = z.infer<
  typeof PersistedPrincipalCacheItemSchema
>;
