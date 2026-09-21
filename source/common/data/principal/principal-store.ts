// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  OptionalItem,
  PaginatedQueryResult,
  SingleItemResult,
} from "@amzn/innovation-sandbox-commons/data/common-types.js";
import type {
  PersistedAssignment,
  PersistedGroupAssignment,
  PersistedGroupMembershipCache,
  PersistedPrincipalCacheItem,
  PersistedUserAssignment,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import type { PrincipalType } from "@amzn/innovation-sandbox-shared/types/principal.js";

export abstract class PrincipalStore {
  abstract createUserAssignment(
    assignment: PersistedUserAssignment,
  ): Promise<PersistedUserAssignment>;

  abstract createGroupAssignment(
    assignment: PersistedGroupAssignment,
  ): Promise<PersistedGroupAssignment>;

  abstract getUserAssignment(
    userId: string,
    leaseId: string,
  ): Promise<SingleItemResult<PersistedUserAssignment>>;

  abstract getGroupAssignment(
    groupId: string,
    leaseId: string,
  ): Promise<SingleItemResult<PersistedGroupAssignment>>;

  abstract getAssignmentsForLease(props: {
    leaseId: string;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<PersistedAssignment>>;

  abstract getDirectAssignmentsForUser(props: {
    userId: string;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<PersistedUserAssignment>>;

  abstract getGroupMembershipCache(
    userId: string,
  ): Promise<SingleItemResult<PersistedGroupMembershipCache>>;

  abstract putGroupMembershipCache(
    cache: PersistedGroupMembershipCache,
  ): Promise<void>;

  abstract deleteUserAssignment(
    userId: string,
    leaseId: string,
  ): Promise<OptionalItem>;

  abstract deleteGroupAssignment(
    groupId: string,
    leaseId: string,
  ): Promise<OptionalItem>;

  abstract batchPutAssignments(
    assignments: PersistedAssignment[],
  ): Promise<void>;

  abstract getAllGroupAssignmentKeys(): Promise<
    { groupId: string; leaseId: string }[]
  >;

  abstract batchGetGroupAssignments(
    keys: { groupId: string; leaseId: string }[],
  ): Promise<PersistedGroupAssignment[]>;

  abstract batchPutCacheItems(
    items: PersistedPrincipalCacheItem[],
  ): Promise<void>;

  abstract getCacheItems(props: {
    type?: PrincipalType;
  }): Promise<PersistedPrincipalCacheItem[]>;

  abstract batchGetCacheItems(
    keys: { principalId: string; principalType: PrincipalType }[],
  ): Promise<PersistedPrincipalCacheItem[]>;

  abstract batchDeleteCacheItemsBySk(sks: string[]): Promise<void>;

  abstract listAllAssignments(props: {
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<PersistedAssignment>>;
}
