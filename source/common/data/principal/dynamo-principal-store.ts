// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  BatchWriteCommand,
  BatchWriteCommandInput,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  paginateScan,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { backOff } from "exponential-backoff";
import pMap from "p-map";

import {
  OptionalItem,
  PaginatedQueryResult,
  SingleItemResult,
} from "@amzn/innovation-sandbox-commons/data/common-types.js";
import {
  base64DecodeCompositeKey,
  base64EncodeCompositeKey,
} from "@amzn/innovation-sandbox-commons/data/encoding.js";
import {
  BatchUnprocessedItemsError,
  ItemAlreadyExists,
} from "@amzn/innovation-sandbox-commons/data/errors.js";
import { withUpdatedMetadata } from "@amzn/innovation-sandbox-commons/data/metadata.js";
import {
  GROUP_MEMBERSHIP_SK,
  groupPk,
  LEASE_SK_PREFIX,
  leaseSk,
  userPk,
} from "@amzn/innovation-sandbox-commons/data/principal/principal-dynamodb-keys.js";
import { PrincipalStore } from "@amzn/innovation-sandbox-commons/data/principal/principal-store.js";
import {
  Assignment,
  AssignmentSchema,
  GroupAssignment,
  GroupAssignmentSchema,
  GroupIndexProjectionSchema,
  GroupMembershipCache,
  GroupMembershipCacheSchema,
  PRINCIPAL_CACHE_GROUP_SK_PREFIX,
  PRINCIPAL_CACHE_PK,
  PRINCIPAL_CACHE_USER_SK_PREFIX,
  PrincipalCacheItem,
  PrincipalCacheItemSchema,
  PrincipalSchemaVersion,
  PrincipalType,
  UserAssignment,
  UserAssignmentSchema,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import {
  chunk,
  parseResults,
  parseSingleItemResult,
  removeNullFieldsForDynamoDB,
  validateItem,
  withMetadata,
} from "@amzn/innovation-sandbox-commons/data/utils.js";

export class DynamoPrincipalStore extends PrincipalStore {
  private readonly tableName: string;
  private readonly ddbClient: DynamoDBDocumentClient;

  constructor(props: {
    client: DynamoDBDocumentClient;
    principalTableName: string;
  }) {
    super();
    this.tableName = props.principalTableName;
    this.ddbClient = props.client;
  }

  @validateItem(UserAssignmentSchema)
  @withMetadata(PrincipalSchemaVersion)
  public override async createUserAssignment(
    assignment: UserAssignment,
  ): Promise<UserAssignment> {
    try {
      await this.ddbClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: removeNullFieldsForDynamoDB(assignment),
          ConditionExpression:
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        }),
      );
      return assignment;
    } catch (error: unknown) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new ItemAlreadyExists("User assignment already exists.");
      }
      throw error;
    }
  }

  @validateItem(GroupAssignmentSchema)
  @withMetadata(PrincipalSchemaVersion)
  public override async createGroupAssignment(
    assignment: GroupAssignment,
  ): Promise<GroupAssignment> {
    try {
      await this.ddbClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: removeNullFieldsForDynamoDB(assignment),
          ConditionExpression:
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        }),
      );
      return assignment;
    } catch (error: unknown) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new ItemAlreadyExists("Group assignment already exists.");
      }
      throw error;
    }
  }

  public override async getUserAssignment(
    userId: string,
    leaseId: string,
  ): Promise<SingleItemResult<UserAssignment>> {
    const result = await this.ddbClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: userPk(userId), sk: leaseSk(leaseId) },
      }),
    );
    return parseSingleItemResult(result.Item, UserAssignmentSchema);
  }

  public override async getGroupAssignment(
    groupId: string,
    leaseId: string,
  ): Promise<SingleItemResult<GroupAssignment>> {
    const result = await this.ddbClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: groupPk(groupId), sk: leaseSk(leaseId) },
      }),
    );
    return parseSingleItemResult(result.Item, GroupAssignmentSchema);
  }

  public override async getAssignmentsForLease(props: {
    leaseId: string;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<Assignment>> {
    const { leaseId, pageIdentifier, pageSize } = props;
    const result = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "LeaseIndex",
        KeyConditionExpression: "#leaseId = :leaseId",
        ExpressionAttributeNames: { "#leaseId": "leaseId" },
        ExpressionAttributeValues: { ":leaseId": leaseId },
        ExclusiveStartKey: base64DecodeCompositeKey(pageIdentifier),
        Limit: pageSize,
      }),
    );
    return {
      ...parseResults(result.Items, AssignmentSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  public override async getDirectAssignmentsForUser(props: {
    userId: string;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<UserAssignment>> {
    const { userId, pageIdentifier, pageSize } = props;
    const result = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: {
          ":pk": userPk(userId),
          ":skPrefix": LEASE_SK_PREFIX,
        },
        ExclusiveStartKey: base64DecodeCompositeKey(pageIdentifier),
        Limit: pageSize,
      }),
    );
    return {
      ...parseResults(result.Items, UserAssignmentSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  public override async getGroupMembershipCache(
    userId: string,
  ): Promise<SingleItemResult<GroupMembershipCache>> {
    const result = await this.ddbClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: userPk(userId), sk: GROUP_MEMBERSHIP_SK },
      }),
    );
    return parseSingleItemResult(result.Item, GroupMembershipCacheSchema);
  }

  @validateItem(GroupMembershipCacheSchema)
  @withMetadata(PrincipalSchemaVersion)
  public override async putGroupMembershipCache(
    cache: GroupMembershipCache,
  ): Promise<void> {
    await this.ddbClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: removeNullFieldsForDynamoDB(cache),
      }),
    );
  }

  public override async deleteUserAssignment(
    userId: string,
    leaseId: string,
  ): Promise<OptionalItem> {
    return this.deleteAssignmentByKey(userPk(userId), leaseSk(leaseId));
  }

  public override async deleteGroupAssignment(
    groupId: string,
    leaseId: string,
  ): Promise<OptionalItem> {
    return this.deleteAssignmentByKey(groupPk(groupId), leaseSk(leaseId));
  }

  private async deleteAssignmentByKey(
    pk: string,
    sk: string,
  ): Promise<OptionalItem> {
    const result = await this.ddbClient.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { pk, sk },
        ReturnValues: "ALL_OLD",
      }),
    );
    return result.Attributes;
  }

  /**
   * Writes up to 25 assignment records in a single BatchWrite call with retry.
   *
   * **Important:** BatchWriteItem does not support condition expressions, so this
   * method will silently overwrite existing records.
   */
  public override async batchPutAssignments(
    assignments: Assignment[],
  ): Promise<void> {
    if (assignments.length === 0) return;
    if (assignments.length > 25) {
      throw new Error(
        `batchPutAssignments accepts at most 25 items, received ${assignments.length}`,
      );
    }

    const enrichedAssignments = assignments.map((assignment) => {
      AssignmentSchema.parse(assignment);
      return withUpdatedMetadata(assignment, PrincipalSchemaVersion);
    });

    let requestItems: BatchWriteCommandInput["RequestItems"] = {
      [this.tableName]: enrichedAssignments.map((assignment) => ({
        PutRequest: {
          Item: removeNullFieldsForDynamoDB(assignment),
        },
      })),
    };

    await backOff(
      async () => {
        const result = await this.ddbClient.send(
          new BatchWriteCommand({ RequestItems: requestItems }),
        );

        const unprocessed = result.UnprocessedItems?.[this.tableName];
        if (unprocessed && unprocessed.length > 0) {
          requestItems = { [this.tableName]: unprocessed };
          throw new BatchUnprocessedItemsError(unprocessed.length);
        }
      },
      {
        numOfAttempts: 4,
        startingDelay: 100,
        jitter: "full",
        retry: (error: unknown) => {
          return error instanceof BatchUnprocessedItemsError;
        },
      },
    );
  }

  public override async getAllGroupAssignmentKeys(): Promise<
    { groupId: string; leaseId: string }[]
  > {
    const allRawItems: Record<string, unknown>[] = [];
    const paginator = paginateScan(
      { client: this.ddbClient },
      { TableName: this.tableName, IndexName: "GroupIndex" },
    );
    for await (const page of paginator) {
      allRawItems.push(...(page.Items ?? []));
    }

    const { result: validProjections } = parseResults(
      allRawItems,
      GroupIndexProjectionSchema,
    );

    return validProjections.map((p) => ({
      groupId: p.groupId,
      leaseId: p.sk.slice(LEASE_SK_PREFIX.length),
    }));
  }

  public override async batchGetGroupAssignments(
    keys: { groupId: string; leaseId: string }[],
  ): Promise<GroupAssignment[]> {
    if (keys.length === 0) return [];

    // Dedupe input keys (BatchGetItem rejects duplicates). Tuple-stable
    // composite key avoids any chance of separator collision.
    const uniqueKeys = Array.from(
      new Map(
        keys.map((k) => [JSON.stringify([k.groupId, k.leaseId]), k] as const),
      ).values(),
    );

    const batches = chunk(uniqueKeys, 100);
    const allRawItems: Record<string, unknown>[] = [];

    await pMap(
      batches,
      async (batch) => {
        let pendingKeys = batch.map(({ groupId, leaseId }) => ({
          pk: groupPk(groupId),
          sk: leaseSk(leaseId),
        }));

        await backOff(
          async () => {
            const result = await this.ddbClient.send(
              new BatchGetCommand({
                RequestItems: {
                  [this.tableName]: { Keys: pendingKeys },
                },
              }),
            );

            allRawItems.push(...(result.Responses?.[this.tableName] ?? []));

            const unprocessed =
              result.UnprocessedKeys?.[this.tableName]?.Keys ?? [];
            if (unprocessed.length > 0) {
              pendingKeys = unprocessed as typeof pendingKeys;
              throw new BatchUnprocessedItemsError(unprocessed.length);
            }
          },
          {
            numOfAttempts: 4,
            startingDelay: 100,
            jitter: "full",
            retry: (error: unknown) =>
              error instanceof BatchUnprocessedItemsError,
          },
        );
      },
      { concurrency: 5 },
    );

    const { result } = parseResults(allRawItems, GroupAssignmentSchema);
    return result;
  }

  /**
   * Writes cached principal items to DynamoDB in batches of 25 with retry on unprocessed items.
   * Validates each item against the schema and enriches with metadata before writing.
   * Batches are written in parallel with a concurrency limit of 2.
   */
  public override async batchPutCacheItems(
    items: PrincipalCacheItem[],
  ): Promise<void> {
    if (items.length === 0) return;

    const enrichedItems = items.map((item) => {
      const parsed = PrincipalCacheItemSchema.parse(item);
      return withUpdatedMetadata(parsed, PrincipalSchemaVersion);
    });

    const batches = chunk(enrichedItems, 25);

    await pMap(
      batches,
      async (batch) => {
        let requestItems: BatchWriteCommandInput["RequestItems"] = {
          [this.tableName]: batch.map((item) => ({
            PutRequest: { Item: removeNullFieldsForDynamoDB(item) },
          })),
        };

        await backOff(
          async () => {
            const result = await this.ddbClient.send(
              new BatchWriteCommand({ RequestItems: requestItems }),
            );
            const unprocessed = result.UnprocessedItems?.[this.tableName];
            if (unprocessed && unprocessed.length > 0) {
              requestItems = { [this.tableName]: unprocessed };
              throw new BatchUnprocessedItemsError(unprocessed.length);
            }
          },
          {
            numOfAttempts: 5,
            startingDelay: 1000,
            jitter: "full",
            retry: (error: unknown) =>
              error instanceof BatchUnprocessedItemsError,
          },
        );
      },
      { concurrency: 2 },
    );
  }

  /**
   * Queries all cached principals from the `principalCache` partition.
   * Optionally filters by type using `begins_with(sk, "user#"|"group#")`.
   * Paginates internally and validates each item against the schema.
   * Invalid items are excluded from results and reported via the error field.
   */
  public override async getCacheItems(props: {
    type?: PrincipalType;
  }): Promise<PrincipalCacheItem[]> {
    const allRawItems: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;

    do {
      let keyCondition: string;
      const expressionNames: Record<string, string> = { "#pk": "pk" };
      const expressionValues: Record<string, unknown> = {
        ":pk": PRINCIPAL_CACHE_PK,
      };

      if (props.type === "USER") {
        keyCondition = "#pk = :pk AND begins_with(#sk, :skPrefix)";
        expressionNames["#sk"] = "sk";
        expressionValues[":skPrefix"] = PRINCIPAL_CACHE_USER_SK_PREFIX;
      } else if (props.type === "GROUP") {
        keyCondition = "#pk = :pk AND begins_with(#sk, :skPrefix)";
        expressionNames["#sk"] = "sk";
        expressionValues[":skPrefix"] = PRINCIPAL_CACHE_GROUP_SK_PREFIX;
      } else {
        keyCondition = "#pk = :pk";
      }

      const result = await this.ddbClient.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: keyCondition,
          ExpressionAttributeNames: expressionNames,
          ExpressionAttributeValues: expressionValues,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );

      allRawItems.push(...(result.Items ?? []));
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);

    const { result } = parseResults(allRawItems, PrincipalCacheItemSchema);
    return result;
  }

  /**
   * Retrieves multiple cached principals in a single BatchGetItem call.
   * Returns only items that exist in the cache; missing items are silently omitted.
   * Retries unprocessed keys with exponential backoff.
   */
  public override async batchGetCacheItems(
    keys: { principalId: string; principalType: PrincipalType }[],
  ): Promise<PrincipalCacheItem[]> {
    if (keys.length === 0) return [];

    let dynamoKeys = keys.map(({ principalId, principalType }) => {
      const skPrefix =
        principalType === "USER"
          ? PRINCIPAL_CACHE_USER_SK_PREFIX
          : PRINCIPAL_CACHE_GROUP_SK_PREFIX;
      return { pk: PRINCIPAL_CACHE_PK, sk: `${skPrefix}${principalId}` };
    });

    const allRawItems: Record<string, unknown>[] = [];

    await backOff(
      async () => {
        const result = await this.ddbClient.send(
          new BatchGetCommand({
            RequestItems: {
              [this.tableName]: { Keys: dynamoKeys },
            },
          }),
        );

        allRawItems.push(...(result.Responses?.[this.tableName] ?? []));

        const unprocessed =
          result.UnprocessedKeys?.[this.tableName]?.Keys ?? [];
        if (unprocessed.length > 0) {
          dynamoKeys = unprocessed as typeof dynamoKeys;
          throw new BatchUnprocessedItemsError(unprocessed.length);
        }
      },
      {
        numOfAttempts: 4,
        startingDelay: 100,
        jitter: "full",
        retry: (error: unknown) => error instanceof BatchUnprocessedItemsError,
      },
    );

    const { result } = parseResults(allRawItems, PrincipalCacheItemSchema);
    return result;
  }

  /**
   * Deletes cached principal items by sort key in batches of 25 with retry on unprocessed items.
   * Batches are deleted in parallel with a concurrency limit of 2.
   * Used to remove stale records that no longer exist in Identity Store.
   */
  public override async batchDeleteCacheItemsBySk(
    sks: string[],
  ): Promise<void> {
    if (sks.length === 0) return;

    const batches = chunk(sks, 25);

    await pMap(
      batches,
      async (batch) => {
        let requestItems: BatchWriteCommandInput["RequestItems"] = {
          [this.tableName]: batch.map((sk) => ({
            DeleteRequest: { Key: { pk: PRINCIPAL_CACHE_PK, sk } },
          })),
        };

        await backOff(
          async () => {
            const result = await this.ddbClient.send(
              new BatchWriteCommand({ RequestItems: requestItems }),
            );
            const unprocessed = result.UnprocessedItems?.[this.tableName];
            if (unprocessed && unprocessed.length > 0) {
              requestItems = { [this.tableName]: unprocessed };
              throw new BatchUnprocessedItemsError(unprocessed.length);
            }
          },
          {
            numOfAttempts: 5,
            startingDelay: 1000,
            jitter: "full",
            retry: (error: unknown) =>
              error instanceof BatchUnprocessedItemsError,
          },
        );
      },
      { concurrency: 2 },
    );
  }

  /**
   * Scans the LeaseIndex GSI and returns assignment records with pagination.
   * A full scan is required because the GSI PK is `leaseId` — there is no
   * single partition to query for cross-lease data.
   */
  public override async listAllAssignments(props: {
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<Assignment>> {
    const { pageIdentifier, pageSize = 100 } = props;

    const result = await this.ddbClient.send(
      new ScanCommand({
        TableName: this.tableName,
        IndexName: "LeaseIndex",
        Select: "ALL_PROJECTED_ATTRIBUTES",
        Limit: pageSize,
        ExclusiveStartKey: base64DecodeCompositeKey(pageIdentifier),
      }),
    );

    const { result: parsed } = parseResults(
      result.Items ?? [],
      AssignmentSchema,
    );

    return {
      result: parsed,
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }
}
