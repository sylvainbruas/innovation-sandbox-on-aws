// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export {
  AssignmentSchema,
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

export type {
  Assignment,
  GroupAssignment,
  GroupMembershipCache,
  PrincipalCacheItem,
  PrincipalTableItem,
  PrincipalType,
  UserAssignment,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";

export { PrincipalStore } from "@amzn/innovation-sandbox-commons/data/principal/principal-store.js";

export { DynamoPrincipalStore } from "@amzn/innovation-sandbox-commons/data/principal/dynamo-principal-store.js";

export {
  GROUP_MEMBERSHIP_SK,
  GROUP_PK_PREFIX,
  LEASE_SK_PREFIX,
  USER_PK_PREFIX,
  groupPk,
  leaseSk,
  userPk,
} from "@amzn/innovation-sandbox-commons/data/principal/principal-dynamodb-keys.js";
