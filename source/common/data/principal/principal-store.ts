// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  OptionalItem,
  PaginatedQueryResult,
  SingleItemResult,
} from "@amzn/innovation-sandbox-commons/data/common-types.js";
import type { PrincipalType } from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import {
  Assignment,
  GroupAssignment,
  GroupMembershipCache,
  PrincipalCacheItem,
  UserAssignment,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";

export abstract class PrincipalStore {
  abstract createUserAssignment(
    assignment: UserAssignment,
  ): Promise<UserAssignment>;

  abstract createGroupAssignment(
    assignment: GroupAssignment,
  ): Promise<GroupAssignment>;

  abstract getUserAssignment(
    userId: string,
    leaseId: string,
  ): Promise<SingleItemResult<UserAssignment>>;

  abstract getGroupAssignment(
    groupId: string,
    leaseId: string,
  ): Promise<SingleItemResult<GroupAssignment>>;

  abstract getAssignmentsForLease(props: {
    leaseId: string;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<Assignment>>;

  abstract getDirectAssignmentsForUser(props: {
    userId: string;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<UserAssignment>>;

  abstract getGroupMembershipCache(
    userId: string,
  ): Promise<SingleItemResult<GroupMembershipCache>>;

  abstract putGroupMembershipCache(cache: GroupMembershipCache): Promise<void>;

  abstract deleteUserAssignment(
    userId: string,
    leaseId: string,
  ): Promise<OptionalItem>;

  abstract deleteGroupAssignment(
    groupId: string,
    leaseId: string,
  ): Promise<OptionalItem>;

  abstract batchPutAssignments(assignments: Assignment[]): Promise<void>;

  abstract getAllGroupAssignmentKeys(): Promise<
    { groupId: string; leaseId: string }[]
  >;

  abstract batchGetGroupAssignments(
    keys: { groupId: string; leaseId: string }[],
  ): Promise<GroupAssignment[]>;

  abstract batchPutCacheItems(items: PrincipalCacheItem[]): Promise<void>;

  abstract getCacheItems(props: {
    type?: PrincipalType;
  }): Promise<PrincipalCacheItem[]>;

  abstract batchGetCacheItems(
    keys: { principalId: string; principalType: PrincipalType }[],
  ): Promise<PrincipalCacheItem[]>;

  abstract batchDeleteCacheItemsBySk(sks: string[]): Promise<void>;

  abstract listAllAssignments(props: {
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<Assignment>>;
}
