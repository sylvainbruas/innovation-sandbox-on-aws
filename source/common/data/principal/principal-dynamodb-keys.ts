// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * DynamoDB Key Constants and Helper Functions for Principal Table
 *
 * The Principal table uses a 3-item-type single-table design:
 *
 * Item Type 1: User Assignment
 *   - PK: "user#{userId}"
 *   - SK: "lease#{leaseId}"
 *
 * Item Type 2: Group Assignment
 *   - PK: "group#{groupId}"
 *   - SK: "lease#{leaseId}"
 *
 * Item Type 3: Group Membership Cache
 *   - PK: "user#{userId}"
 *   - SK: "groupMembership"
 */

export const USER_PK_PREFIX = "user#";
export const GROUP_PK_PREFIX = "group#";
export const LEASE_SK_PREFIX = "lease#";
export const GROUP_MEMBERSHIP_SK = "groupMembership" as const;

export function userPk(userId: string): string {
  return `${USER_PK_PREFIX}${userId}`;
}

export function groupPk(groupId: string): string {
  return `${GROUP_PK_PREFIX}${groupId}`;
}

export function leaseSk(leaseId: string): string {
  return `${LEASE_SK_PREFIX}${leaseId}`;
}
