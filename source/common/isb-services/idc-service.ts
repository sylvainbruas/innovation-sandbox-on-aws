// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import {
  DescribeGroupCommand,
  DescribeUserCommand,
  GetGroupIdCommand,
  GetUserIdCommand,
  GroupMembership,
  IdentitystoreClient,
  IdentitystorePaginationConfiguration,
  ListGroupMembershipsCommand,
  ListGroupMembershipsForMemberCommandInput,
  ResourceNotFoundException,
  User,
  paginateListGroupMemberships,
  paginateListGroupMembershipsForMember,
  paginateListGroups,
  paginateListUsers,
} from "@aws-sdk/client-identitystore";
import {
  CreateAccountAssignmentCommand,
  DeleteAccountAssignmentCommand,
  ListAccountAssignmentsCommandInput,
  PrincipalType,
  SSOAdminClient,
  SSOAdminPaginationConfiguration,
  TargetType,
  paginateListAccountAssignments,
} from "@aws-sdk/client-sso-admin";

import { PaginatedQueryResult } from "@amzn/innovation-sandbox-commons/data/common-types.js";
import { IdcConfig } from "@amzn/innovation-sandbox-commons/data/idc-stack-config/idc-stack-config.js";
import { IdcStackConfigStore } from "@amzn/innovation-sandbox-commons/data/idc-stack-config/ssm-idc-stack-config-store.js";
import { PrincipalStore } from "@amzn/innovation-sandbox-commons/data/principal/principal-store.js";
import {
  PRINCIPAL_CACHE_GROUP_SK_PREFIX,
  PRINCIPAL_CACHE_PK,
  PRINCIPAL_CACHE_USER_SK_PREFIX,
  PrincipalCacheItem,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import {
  cacheAdmins,
  cacheManagers,
  cacheUsers,
  getCachedAdmins,
  getCachedManagers,
  getCachedUsers,
} from "@amzn/innovation-sandbox-commons/isb-services/idc-cache.js";
import { assertDefined } from "@amzn/innovation-sandbox-commons/utils/assertions.js";
import type {
  IdcIdentity,
  IsbRole,
  IsbUser,
} from "@amzn/innovation-sandbox-commons/utils/auth-utils.js";
import {
  calculateTtlInEpochSeconds,
  nowAsIsoDatetimeString,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import { Transaction } from "@amzn/innovation-sandbox-commons/utils/transactions.js";
import pThrottle from "p-throttle";

// IDC supports 20 TPS for all requests
// (https://docs.aws.amazon.com/singlesignon/latest/userguide/limits.html)
const throttle1PerSec = pThrottle({
  limit: 1,
  interval: 1000,
});

// Conservative pagination throttle: 10 TPS leaves headroom for other IDC operations
const paginationThrottle = pThrottle({
  limit: 10,
  interval: 1000,
});

const throttledPage = paginationThrottle(() => Promise.resolve());

export interface IdcPrincipal {
  principalId: string;
  principalType: "USER" | "GROUP";
  displayName?: string;
  email?: string;
}

export class IdcService {
  readonly identityStoreClient;
  readonly ssoAdminClient;
  readonly idcStackConfigStore: IdcStackConfigStore;
  public static defaultPageSize = 50;
  private static readonly defaultListProps = {
    pageSize: IdcService.defaultPageSize,
  };

  constructor(props: {
    identityStoreClient: IdentitystoreClient;
    ssoAdminClient: SSOAdminClient;
    idcStackConfigStore: IdcStackConfigStore;
  }) {
    this.identityStoreClient = props.identityStoreClient;
    this.ssoAdminClient = props.ssoAdminClient;
    this.idcStackConfigStore = props.idcStackConfigStore;
  }

  private async getIdcConfig(): Promise<IdcConfig> {
    // SSMProvider in the store already caches for 5 minutes
    return this.idcStackConfigStore.get();
  }

  /**
   * Converts an IDC User SDK object to our IdcIdentity domain type.
   * Throws on missing UserId or primary email — these are data integrity
   * assertions that indicate corrupted IDC data, not expected failure modes.
   * They will be handled as unexpected errors in the facade layer or Lambda handlers.
   */
  private isbUserFromIdcUser(user: User, roles?: IsbRole[]): IdcIdentity {
    const context = JSON.stringify({
      UserId: user.UserId,
      UserName: user.UserName,
      Emails: user.Emails,
    });
    const userId = assertDefined(
      user.UserId,
      `IDC user has no UserId: ${context}`,
    );
    const email = assertDefined(
      user.Emails?.filter((emailTuple) => emailTuple.Primary).map(
        (emailTuple) => emailTuple.Value,
      )[0],
      `IDC user has no primary email: ${context}`,
    );
    return {
      type: "user",
      displayName: user.DisplayName,
      userName: user.UserName,
      userId,
      email,
      roles: roles ?? [],
    };
  }

  /**
   * requires actions
   *  "identitystore:ListGroupMemberships",
   *  "identitystore:DescribeUser",
   */
  public async listIsbUsers(
    props: {
      pageSize?: number;
      pageIdentifier?: string;
    } = IdcService.defaultListProps,
  ): Promise<PaginatedQueryResult<IsbUser>> {
    const cachedUsers = getCachedUsers(props.pageIdentifier ?? "FIRST_PAGE");
    if (cachedUsers) {
      return cachedUsers;
    }
    const config = await this.getIdcConfig();
    const users = await this.listGroupMembers({
      ...props,
      groupId: config.userGroupId,
    });
    cacheUsers(props.pageIdentifier ?? "FIRST_PAGE", users);
    return users;
  }

  /**
   * requires actions
   *  "identitystore:ListGroupMemberships",
   *  "identitystore:DescribeUser",
   */
  public async listIsbManagers(
    props: {
      pageSize?: number;
      pageIdentifier?: string;
    } = IdcService.defaultListProps,
  ): Promise<PaginatedQueryResult<IsbUser>> {
    const cachedManagers = getCachedManagers(
      props.pageIdentifier ?? "FIRST_PAGE",
    );
    if (cachedManagers) {
      return cachedManagers;
    }
    const config = await this.getIdcConfig();
    const managers = await this.listGroupMembers({
      ...props,
      groupId: config.managerGroupId,
    });
    cacheManagers(props.pageIdentifier ?? "FIRST_PAGE", managers);
    return managers;
  }

  /**
   * requires actions
   *  "identitystore:ListGroupMemberships",
   *  "identitystore:DescribeUser",
   */
  public async listIsbAdmins(
    props: {
      pageSize?: number;
      pageIdentifier?: string;
    } = IdcService.defaultListProps,
  ): Promise<PaginatedQueryResult<IsbUser>> {
    const cachedAdmins = getCachedAdmins(props.pageIdentifier ?? "FIRST_PAGE");
    if (cachedAdmins) {
      return cachedAdmins;
    }
    const config = await this.getIdcConfig();
    const admins = await this.listGroupMembers({
      ...props,
      groupId: config.adminGroupId,
    });
    cacheAdmins(props.pageIdentifier ?? "FIRST_PAGE", admins);
    return admins;
  }

  private async listGroupMembers(props: {
    groupId: string;
    pageSize?: number;
    pageIdentifier?: string;
  }): Promise<PaginatedQueryResult<IsbUser>> {
    const config = await this.getIdcConfig();
    const command = new ListGroupMembershipsCommand({
      GroupId: props.groupId,
      IdentityStoreId: config.identityStoreId,
      MaxResults: props.pageSize,
      NextToken: props.pageIdentifier,
    });
    const response = await this.identityStoreClient.send(command);
    const users: IsbUser[] = [];
    const throttledDescribeUser = throttle1PerSec(
      async (descUserCommand: DescribeUserCommand) => {
        const user = await this.identityStoreClient.send(descUserCommand);
        return this.isbUserFromIdcUser(user);
      },
    );
    if (response.GroupMemberships) {
      for (const membership of response.GroupMemberships) {
        const descUserCommand = new DescribeUserCommand({
          IdentityStoreId: config.identityStoreId,
          UserId: membership.MemberId?.UserId,
        });
        const user = await throttledDescribeUser(descUserCommand);
        users.push(user);
      }
    }
    return {
      result: users,
      nextPageIdentifier: response.NextToken ?? null,
    };
  }

  /**
   * Returns all member UserIds for a given group by exhausting ListGroupMemberships pagination.
   *
   * requires actions
   *  "identitystore:ListGroupMemberships"
   */
  public async listGroupMemberIds(groupId: string): Promise<Set<string>> {
    const config = await this.getIdcConfig();
    const memberIds: string[] = [];

    const paginatorConfig: IdentitystorePaginationConfiguration = {
      client: this.identityStoreClient,
    };
    const paginator = paginateListGroupMemberships(paginatorConfig, {
      GroupId: groupId,
      IdentityStoreId: config.identityStoreId,
      MaxResults: 100,
    });

    for await (const { GroupMemberships } of paginator) {
      await throttledPage();
      const userIds = (GroupMemberships ?? [])
        .map((m) => m.MemberId?.UserId)
        .filter((id): id is string => !!id);
      memberIds.push(...userIds);
    }

    return new Set(memberIds);
  }

  /**
   * Returns the union of all member UserIds across all ISB groups (Users, Managers, Admins).
   *
   * requires actions
   *  "identitystore:ListGroupMemberships"
   */
  public async listAllIsbMemberIds(): Promise<Set<string>> {
    const config = await this.getIdcConfig();

    const [userIds, managerIds, adminIds] = await Promise.all([
      this.listGroupMemberIds(config.userGroupId),
      this.listGroupMemberIds(config.managerGroupId),
      this.listGroupMemberIds(config.adminGroupId),
    ]);

    return new Set([...userIds, ...managerIds, ...adminIds]);
  }

  /**
   * Returns all groups the given user is a member of by exhausting
   * ListGroupMembershipsForMember pagination.
   *
   * The IDC API only returns GroupId per membership; richer group attributes
   * (e.g., displayName) would require per-group DescribeGroup calls.
   *
   * requires actions
   *  "identitystore:ListGroupMembershipsForMember"
   */
  public async listGroupsForUser(userId: string): Promise<GroupMembership[]> {
    const config = await this.getIdcConfig();
    const groups: GroupMembership[] = [];

    const paginatorConfig: IdentitystorePaginationConfiguration = {
      client: this.identityStoreClient,
    };
    const input: ListGroupMembershipsForMemberCommandInput = {
      IdentityStoreId: config.identityStoreId,
      MemberId: { UserId: userId },
    };
    const paginator = paginateListGroupMembershipsForMember(
      paginatorConfig,
      input,
    );

    for await (const { GroupMemberships } of paginator) {
      await throttledPage();
      for (const membership of GroupMemberships ?? []) {
        if (membership.GroupId) {
          groups.push(membership);
        }
      }
    }

    return groups;
  }

  /**
   * requires actions
   *  "identitystore:GetUserId",
   *  "identitystore:DescribeUser",
   *  "identitystore:ListGroupMembershipsForMember"
   *
   * NOTE: This method only resolves real IDC users; M2M synthetic emails
   * (m2m-{clientId}@automation.local) return undefined. In normal operation it
   * is never called with a synthetic email: `postLeaseHandler` refuses
   * M2M-assignee lease creation up front (see `m2m-guard.ts`), and the IDC-grant
   * paths (`approveLease`/`publishLease`) assert the assignee is non-M2M as
   * defense in depth before calling this.
   */
  public async getUserFromEmail(
    email: string,
  ): Promise<IdcIdentity | undefined> {
    return this.getUserFromUniqueAttr("emails.value", email);
  }

  /**
   * Resolves a principal's ID and display info from an email (USER) or
   * display name (GROUP). Uses a read-through cache strategy:
   * 1. Check principalStore cache for a match
   * 2. On cache miss, resolve from IDC via GetUserId/GetGroupId
   * 3. Best-effort write-through on IDC resolution success
   *
   * requires actions:
   *  "identitystore:GetUserId",
   *  "identitystore:DescribeUser",
   *  "identitystore:GetGroupId"
   */
  public async getCachedPrincipalByAttr(
    type: "USER" | "GROUP",
    identifier: string,
    principalStore: PrincipalStore,
    logger: Logger,
  ): Promise<IdcPrincipal | undefined> {
    // Step 1: Cache scan
    const cacheItems = await principalStore.getCacheItems({ type });
    const lower = identifier.toLowerCase();

    const cacheHit = cacheItems.find((item) => {
      if (type === "USER") {
        return item.email?.toLowerCase() === lower;
      }
      return item.displayName?.toLowerCase() === lower;
    });

    if (cacheHit) {
      logger.debug("Principal cache hit (byAttr)", {
        principalId: cacheHit.principalId,
        principalType: type,
      });
      return {
        principalId: cacheHit.principalId,
        principalType: cacheHit.principalType,
        displayName: cacheHit.displayName,
        ...(cacheHit.email && { email: cacheHit.email }),
      };
    }

    // Step 2: Cache miss — resolve from IDC + write-through
    logger.debug("Principal cache miss (byAttr)", { type, identifier });
    const resolved = await this.getPrincipalByAttr(type, identifier);
    if (resolved) {
      this.writeThroughToCache(resolved, principalStore, logger);
    }
    return resolved;
  }

  /**
   * Resolves a principal by email (USER) or displayName (GROUP) directly
   * from IDC without any cache interaction. Returns undefined if not found.
   *
   * requires actions:
   *  "identitystore:GetUserId",
   *  "identitystore:DescribeUser",
   *  "identitystore:GetGroupId"
   */
  private async getPrincipalByAttr(
    type: "USER" | "GROUP",
    identifier: string,
  ): Promise<IdcPrincipal | undefined> {
    if (type === "USER") {
      const result = await this.getUserByAttr("emails.value", identifier);
      if (!result) return undefined;

      const { userId, user } = result;
      const displayName = user.DisplayName ?? user.UserName ?? identifier;
      const primaryEmail =
        user.Emails?.find((e) => e.Primary)?.Value ?? identifier;

      return {
        principalId: userId,
        principalType: "USER",
        displayName,
        email: primaryEmail,
      };
    }

    const result = await this.getGroupByAttr(identifier);
    if (!result) return undefined;

    return {
      principalId: result.groupId,
      principalType: "GROUP",
      displayName: identifier,
    };
  }

  /**
   * Describes a principal by its IDC ID. Uses a read-through cache strategy:
   * 1. Check principalStore cache via batchGetCacheItems
   * 2. On cache miss, resolve via DescribeUser/DescribeGroup
   * 3. Best-effort write-through on IDC resolution success
   *
   * requires actions:
   *  "identitystore:DescribeUser",
   *  "identitystore:DescribeGroup"
   */
  public async getCachedPrincipalById(
    type: "USER" | "GROUP",
    principalId: string,
    principalStore: PrincipalStore,
    logger: Logger,
  ): Promise<IdcPrincipal | undefined> {
    // Step 1: Single-key batch lookup
    const cacheItems = await principalStore.batchGetCacheItems([
      { principalId, principalType: type },
    ]);

    if (cacheItems.length > 0) {
      const hit = cacheItems[0]!;
      logger.debug("Principal cache hit (byId)", {
        principalId: hit.principalId,
        principalType: type,
      });
      return {
        principalId: hit.principalId,
        principalType: hit.principalType,
        displayName: hit.displayName,
        ...(hit.email && { email: hit.email }),
      };
    }

    // Step 2: Cache miss — resolve from IDC + write-through
    logger.debug("Principal cache miss (byId)", { principalId, type });
    const resolved = await this.getPrincipalById(type, principalId);
    if (resolved) {
      this.writeThroughToCache(resolved, principalStore, logger);
    }
    return resolved;
  }

  /**
   * Resolves a principal by its IDC ID directly from IDC without any cache
   * interaction. Returns undefined if the principal does not exist.
   *
   * requires actions:
   *  "identitystore:DescribeUser",
   *  "identitystore:DescribeGroup"
   */
  private async getPrincipalById(
    type: "USER" | "GROUP",
    principalId: string,
  ): Promise<IdcPrincipal | undefined> {
    const config = await this.getIdcConfig();

    if (type === "USER") {
      try {
        const result = await this.identityStoreClient.send(
          new DescribeUserCommand({
            IdentityStoreId: config.identityStoreId,
            UserId: principalId,
          }),
        );
        return {
          principalId,
          principalType: "USER",
          displayName: result.DisplayName ?? result.UserName ?? principalId,
          email: result.Emails?.find((e) => e.Primary)?.Value,
        };
      } catch (error: unknown) {
        if (error instanceof ResourceNotFoundException) return undefined;
        throw error;
      }
    }

    try {
      const result = await this.identityStoreClient.send(
        new DescribeGroupCommand({
          IdentityStoreId: config.identityStoreId,
          GroupId: principalId,
        }),
      );
      return {
        principalId,
        principalType: "GROUP",
        displayName: result.DisplayName ?? principalId,
      };
    } catch (error: unknown) {
      if (error instanceof ResourceNotFoundException) return undefined;
      throw error;
    }
  }

  /**
   * Fire-and-forget cache write for a resolved principal.
   */
  private writeThroughToCache(
    resolved: IdcPrincipal,
    principalStore: PrincipalStore,
    logger: Logger,
  ): void {
    const skPrefix =
      resolved.principalType === "USER"
        ? PRINCIPAL_CACHE_USER_SK_PREFIX
        : PRINCIPAL_CACHE_GROUP_SK_PREFIX;

    const cacheItem: PrincipalCacheItem = {
      pk: PRINCIPAL_CACHE_PK,
      sk: `${skPrefix}${resolved.principalId}`,
      principalId: resolved.principalId,
      principalType: resolved.principalType,
      displayName: resolved.displayName,
      ...(resolved.email && { email: resolved.email }),
      syncedAt: nowAsIsoDatetimeString(),
      ttl: calculateTtlInEpochSeconds(2),
    };
    principalStore.batchPutCacheItems([cacheItem]).catch((error) => {
      logger.warn("Principal cache write-through failed", {
        principalId: resolved.principalId,
        principalType: resolved.principalType,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Shared helper: resolves a group via GetGroupId with AlternateIdentifier.
   * Returns undefined on ResourceNotFoundException.
   */
  private async getGroupByAttr(
    displayName: string,
  ): Promise<{ groupId: string } | undefined> {
    const config = await this.getIdcConfig();
    const command = new GetGroupIdCommand({
      IdentityStoreId: config.identityStoreId,
      AlternateIdentifier: {
        UniqueAttribute: {
          AttributePath: "displayName",
          AttributeValue: displayName,
        },
      },
    });

    try {
      const { GroupId: groupId } = await this.identityStoreClient.send(command);
      if (!groupId) return undefined;
      return { groupId };
    } catch (error: unknown) {
      if (error instanceof ResourceNotFoundException) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * requires actions
   *  "identitystore:GetUserId",
   *  "identitystore:DescribeUser",
   *  "identitystore:ListGroupMembershipsForMember"
   */
  public async getUserFromUsername(
    userName: string,
  ): Promise<IdcIdentity | undefined> {
    return this.getUserFromUniqueAttr("userName", userName);
  }

  private async getUserFromUniqueAttr(
    attr: "emails.value" | "userName",
    value: string,
  ): Promise<IdcIdentity | undefined> {
    const result = await this.getUserByAttr(attr, value);
    if (!result) return undefined;

    const { userId, user } = result;
    const config = await this.getIdcConfig();

    const input: ListGroupMembershipsForMemberCommandInput = {
      IdentityStoreId: config.identityStoreId,
      MemberId: {
        UserId: userId,
      },
    };
    const paginatorConfig: IdentitystorePaginationConfiguration = {
      client: this.identityStoreClient,
    };
    const paginator = paginateListGroupMembershipsForMember(
      paginatorConfig,
      input,
    );
    const groupIdToRole: Record<string, IsbRole> = {
      [config.userGroupId]: "User",
      [config.managerGroupId]: "Manager",
      [config.adminGroupId]: "Admin",
    };
    const roles: IsbRole[] = [];
    for await (const { GroupMemberships } of paginator) {
      if (GroupMemberships) {
        for (const groupMembership of GroupMemberships) {
          const role = groupIdToRole[groupMembership.GroupId!];
          if (role) {
            roles.push(role);
          }
        }
      }
    }
    if (roles.length === 0) {
      // the user isn't an ISB user
      return undefined;
    }
    return this.isbUserFromIdcUser(user, roles);
  }

  /**
   * Shared helper: resolves a user via GetUserId + DescribeUser.
   * Returns undefined on ResourceNotFoundException.
   */
  private async getUserByAttr(
    attr: "emails.value" | "userName",
    value: string,
  ): Promise<{ userId: string; user: User } | undefined> {
    const config = await this.getIdcConfig();
    const command = new GetUserIdCommand({
      IdentityStoreId: config.identityStoreId,
      AlternateIdentifier: {
        UniqueAttribute: {
          AttributePath: attr,
          AttributeValue: value,
        },
      },
    });

    try {
      const { UserId: userId } = await this.identityStoreClient.send(command);
      if (!userId) return undefined;

      const descUserCommand = new DescribeUserCommand({
        IdentityStoreId: config.identityStoreId,
        UserId: userId,
      });
      const user = await this.identityStoreClient.send(descUserCommand);
      return { userId, user };
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Exhausts pagination for ListUsers and returns all users as principals.
   * requires actions
   *  "identitystore:ListUsers"
   */
  public async listAllUsers(): Promise<IdcPrincipal[]> {
    const config = await this.getIdcConfig();
    const users: IdcPrincipal[] = [];

    const paginator = paginateListUsers(
      {
        client: this.identityStoreClient,
      },
      {
        IdentityStoreId: config.identityStoreId,
        MaxResults: 100,
      },
    );

    for await (const page of paginator) {
      await throttledPage();
      if (page.Users) {
        for (const user of page.Users) {
          if (user.UserId) {
            const email = user.Emails?.find((email) => email.Primary)?.Value;
            const displayName =
              user.DisplayName || user.UserName || email || user.UserId;

            users.push({
              principalId: user.UserId,
              principalType: "USER",
              displayName,
              ...(email && { email }),
            });
          }
        }
      }
    }

    return users;
  }

  /**
   * Exhausts pagination for ListGroups and returns all groups in the identity store.
   * requires actions
   *  "identitystore:ListGroups"
   */
  public async listAllGroups(): Promise<IdcPrincipal[]> {
    const config = await this.getIdcConfig();
    const groups: IdcPrincipal[] = [];

    const paginator = paginateListGroups(
      { client: this.identityStoreClient },
      { IdentityStoreId: config.identityStoreId, MaxResults: 100 },
    );

    for await (const page of paginator) {
      await throttledPage();
      if (page.Groups) {
        for (const group of page.Groups) {
          if (group.GroupId && group.DisplayName) {
            groups.push({
              principalId: group.GroupId,
              principalType: "GROUP",
              displayName: group.DisplayName,
            });
          }
        }
      }
    }

    return groups;
  }

  private async grantUserAccess(accountId: string, isbUser: IdcIdentity) {
    const config = await this.getIdcConfig();
    const userPS = { PermissionSetArn: config.userPermissionSetArn };
    const command = new CreateAccountAssignmentCommand({
      InstanceArn: config.ssoInstanceArn,
      PermissionSetArn: userPS.PermissionSetArn,
      PrincipalId: isbUser.userId,
      PrincipalType: "USER",
      TargetId: accountId,
      TargetType: TargetType.AWS_ACCOUNT,
    });
    await this.ssoAdminClient.send(command);
  }

  /**
   * requires actions
   *  "sso:DeleteAccountAssignment",
   */
  private async revokeUserAccess(accountId: string, isbUser: IdcIdentity) {
    const config = await this.getIdcConfig();
    const userPS = { PermissionSetArn: config.userPermissionSetArn };
    const command = new DeleteAccountAssignmentCommand({
      InstanceArn: config.ssoInstanceArn,
      PermissionSetArn: userPS.PermissionSetArn,
      PrincipalId: isbUser.userId,
      PrincipalType: "USER",
      TargetId: accountId,
      TargetType: TargetType.AWS_ACCOUNT,
    });
    await this.ssoAdminClient.send(command);
  }

  /**
   * requires actions
   *  "sso:CreateAccountAssignment",
   *  "sso:DeleteAccountAssignment",
   */
  public transactionalGrantUserAccess(accountId: string, isbUser: IdcIdentity) {
    return new Transaction({
      beginTransaction: () => this.grantUserAccess(accountId, isbUser),
      rollbackTransaction: () => this.revokeUserAccess(accountId, isbUser),
    });
  }

  /**
   * removes access to all users which have the user Permission Set
   * requires actions
   *  sso:ListAccountAssignments,
   *  sso:DeleteAccountAssignment,
   */
  public async revokeAllUserAccess(accountId: string) {
    const config = await this.getIdcConfig();
    const userPS = { PermissionSetArn: config.userPermissionSetArn };
    const input: ListAccountAssignmentsCommandInput = {
      InstanceArn: config.ssoInstanceArn,
      AccountId: accountId,
      PermissionSetArn: userPS.PermissionSetArn,
    };
    const paginatorConfig: SSOAdminPaginationConfiguration = {
      client: this.ssoAdminClient,
    };
    const paginator = paginateListAccountAssignments(paginatorConfig, input);
    const throttledDeleteAccountAssignment = throttle1PerSec(
      async (command: DeleteAccountAssignmentCommand) => {
        await this.ssoAdminClient.send(command);
      },
    );
    for await (const page of paginator) {
      if (page.AccountAssignments) {
        for (const accountAssignment of page.AccountAssignments) {
          if (accountAssignment.PrincipalType !== PrincipalType.USER) {
            continue;
          }
          const command = new DeleteAccountAssignmentCommand({
            InstanceArn: config.ssoInstanceArn,
            PermissionSetArn: userPS.PermissionSetArn,
            PrincipalId: accountAssignment.PrincipalId,
            PrincipalType: accountAssignment.PrincipalType,
            TargetId: accountId,
            TargetType: TargetType.AWS_ACCOUNT,
          });
          await throttledDeleteAccountAssignment(command);
        }
      }
    }
  }

  private async getCorrespondingPSAndGroup(
    role: Exclude<IsbRole, "User">,
  ): Promise<{
    permissionSetArn: string;
    groupId: string;
  }> {
    const config = await this.getIdcConfig();
    return {
      permissionSetArn:
        role === "Admin"
          ? config.adminPermissionSetArn
          : config.managerPermissionSetArn,
      groupId: role === "Admin" ? config.adminGroupId : config.managerGroupId,
    };
  }

  /**
   * requires actions
   *  "sso:CreateAccountAssignment",
   */
  public async assignGroupAccess(
    accountId: string,
    role: Exclude<IsbRole, "User">,
  ) {
    const config = await this.getIdcConfig();
    const { groupId, permissionSetArn } =
      await this.getCorrespondingPSAndGroup(role);
    const command = new CreateAccountAssignmentCommand({
      InstanceArn: config.ssoInstanceArn,
      PermissionSetArn: permissionSetArn,
      PrincipalId: groupId,
      PrincipalType: "GROUP",
      TargetId: accountId,
      TargetType: TargetType.AWS_ACCOUNT,
    });
    await this.ssoAdminClient.send(command);
  }

  /**
   * requires actions
   *  "sso:DeleteAccountAssignment",
   */
  public async revokeGroupAccess(
    accountId: string,
    role: Exclude<IsbRole, "User">,
  ) {
    const config = await this.getIdcConfig();
    const { groupId, permissionSetArn } =
      await this.getCorrespondingPSAndGroup(role);
    const command = new DeleteAccountAssignmentCommand({
      InstanceArn: config.ssoInstanceArn,
      PermissionSetArn: permissionSetArn,
      PrincipalId: groupId,
      PrincipalType: "GROUP",
      TargetId: accountId,
      TargetType: TargetType.AWS_ACCOUNT,
    });
    await this.ssoAdminClient.send(command);
  }

  /**
   * requires actions
   *  "sso:CreateAccountAssignment",
   *  "sso:DeleteAccountAssignment"
   */
  public transactionalAssignGroupAccess(
    accountId: string,
    role: Exclude<IsbRole, "User">,
  ) {
    return new Transaction({
      beginTransaction: () => this.assignGroupAccess(accountId, role),
      rollbackTransaction: () => this.revokeGroupAccess(accountId, role),
    });
  }

  /**
   * requires actions
   *  "sso:CreateAccountAssignment",
   *  "sso:DeleteAccountAssignment"
   */
  public transactionalRevokeGroupAccess(
    accountId: string,
    role: Exclude<IsbRole, "User">,
  ) {
    return new Transaction({
      beginTransaction: () => this.revokeGroupAccess(accountId, role),
      rollbackTransaction: () => this.assignGroupAccess(accountId, role),
    });
  }
}
