// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { backOff } from "exponential-backoff";
import pMap from "p-map";

import {
  OptionalItem,
  PaginatedQueryResult,
  PutResult,
  SingleItemResult,
  type EmailAddress,
} from "@amzn/innovation-sandbox-commons/data/common-types.js";
import {
  base64DecodeCompositeKey,
  base64EncodeCompositeKey,
} from "@amzn/innovation-sandbox-commons/data/encoding.js";
import {
  BatchUnprocessedItemsError,
  ConcurrentDataModificationException,
  ItemAlreadyExists,
  ResourceLockConflictError,
  UnknownItem,
} from "@amzn/innovation-sandbox-commons/data/errors.js";
import {
  LeaseAcquireLockProps,
  LeaseAcquireLockWithDesiredAssignmentsProps,
  LeaseReleaseLockProps,
  LeaseStore,
} from "@amzn/innovation-sandbox-commons/data/lease/lease-store.js";
import {
  BlockingLockIntents,
  DesiredAssignmentWithDisplaySchema,
  ExpiredLeaseStatus,
  Lease,
  LeaseKey,
  LeaseLockIntent,
  LeaseResourceLock,
  LeaseResourceLockSchema,
  LeaseSchema,
  LeaseSchemaVersion,
  LeaseStatus,
  MonitoredLeaseStatus,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  chunk,
  parseResults,
  parseSingleItemResult,
  removeNullFieldsForDynamoDB,
  validateItem,
  withMetadata,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import {
  nowAsIsoDatetimeString,
  parseDatetime,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";

export class DynamoLeaseStore extends LeaseStore {
  private readonly tableName: string;
  private readonly ddbClient: DynamoDBDocumentClient;

  constructor(props: {
    client: DynamoDBDocumentClient;
    leaseTableName: string;
  }) {
    super();
    this.tableName = props.leaseTableName;
    this.ddbClient = props.client;
  }

  /**
   * Builds the lock-acquisition ConditionExpression and its intent-related
   * attribute values.
   *
   * Precedence comes from BlockingLockIntents. The rule is expressed in the
   * condition rather than a read-then-write to avoid a TOCTOU race, and is
   * shared by both acquire paths so they cannot drift apart.
   */
  private buildLockAcquisitionCondition(props: {
    ownerId: string;
    acquiredAt: string;
    intent: LeaseLockIntent | undefined;
  }): {
    conditionExpression: string;
    expressionAttributeValues: Record<string, unknown>;
  } {
    const { ownerId, acquiredAt, intent } = props;

    const blockingIntents =
      intent !== undefined && intent in BlockingLockIntents
        ? BlockingLockIntents[intent as keyof typeof BlockingLockIntents]
        : undefined;

    const placeholderFor = (blocked: string) => `:${blocked.toLowerCase()}`;

    const conditionExpression = [
      "attribute_exists(userEmail) AND (",
      "attribute_not_exists(resourceLock)",
      "OR resourceLock.ownerId = :ownerId",
      "OR resourceLock.expiresAt < :acquiredAt",
      // Guard attribute_not_exists first: a lock written without meta must
      // still be preemptible by a critical intent.
      ...(blockingIntents
        ? [
            `OR (attribute_not_exists(resourceLock.meta.intent) OR NOT resourceLock.meta.intent IN (${blockingIntents
              .map(placeholderFor)
              .join(", ")}))`,
          ]
        : []),
      ")",
    ].join(" ");

    return {
      conditionExpression,
      expressionAttributeValues: {
        ":ownerId": ownerId,
        ":acquiredAt": acquiredAt,
        // Only declare placeholders the expression references; DynamoDB rejects
        // unused ExpressionAttributeValues.
        ...Object.fromEntries(
          (blockingIntents ?? []).map((blocked) => [
            placeholderFor(blocked),
            blocked,
          ]),
        ),
      },
    };
  }

  public override async acquireLock(
    props: LeaseAcquireLockProps,
  ): Promise<LeaseResourceLock> {
    const { leaseId, userEmail, ownerId, timeoutSeconds, meta } = props;
    const acquiredAt = nowAsIsoDatetimeString();
    const expiresAt = parseDatetime(acquiredAt)
      .plus({ seconds: timeoutSeconds })
      .toISO();

    const parseResult = LeaseResourceLockSchema.safeParse({
      ownerId,
      acquiredAt,
      expiresAt,
      meta,
    });

    if (!parseResult.success) {
      throw new Error(
        `Invalid lock data for lease ${leaseId}: ${parseResult.error.message}`,
      );
    }

    const lock = parseResult.data;

    const { conditionExpression, expressionAttributeValues } =
      this.buildLockAcquisitionCondition({
        ownerId,
        acquiredAt,
        intent: meta?.intent,
      });

    try {
      await this.ddbClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { userEmail, uuid: leaseId },
          UpdateExpression: "SET resourceLock = :lock",
          ConditionExpression: conditionExpression,
          ExpressionAttributeValues: {
            ...expressionAttributeValues,
            ":lock": lock,
          },
        }),
      );
    } catch (error: unknown) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new ResourceLockConflictError(
          `Lock conflict on lease ${leaseId}: held by another owner and not expired`,
        );
      }
      throw error;
    }

    return lock;
  }

  public override async acquireLockWithDesiredAssignments(
    props: LeaseAcquireLockWithDesiredAssignmentsProps,
  ): Promise<LeaseResourceLock> {
    const {
      leaseId,
      userEmail,
      ownerId,
      timeoutSeconds,
      meta,
      desiredAssignments,
    } = props;
    const acquiredAt = nowAsIsoDatetimeString();
    const expiresAt = parseDatetime(acquiredAt)
      .plus({ seconds: timeoutSeconds })
      .toISO();

    const parseResult = LeaseResourceLockSchema.safeParse({
      ownerId,
      acquiredAt,
      expiresAt,
      meta,
    });

    if (!parseResult.success) {
      throw new Error(
        `Invalid lock data for lease ${leaseId}: ${parseResult.error.message}`,
      );
    }

    const lock = parseResult.data;

    // Validate desiredAssignments against schema
    const parsedDesired = desiredAssignments.map((a) =>
      DesiredAssignmentWithDisplaySchema.parse(a),
    );

    const { conditionExpression, expressionAttributeValues } =
      this.buildLockAcquisitionCondition({
        ownerId,
        acquiredAt,
        intent: meta?.intent,
      });

    try {
      await this.ddbClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { userEmail, uuid: leaseId },
          UpdateExpression:
            "SET resourceLock = :lock, desiredAssignments = :desiredAssignments",
          ConditionExpression: conditionExpression,
          ExpressionAttributeValues: {
            ...expressionAttributeValues,
            ":lock": lock,
            ":desiredAssignments": parsedDesired,
          },
        }),
      );
    } catch (error: unknown) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new ResourceLockConflictError(
          `Lock conflict on lease ${leaseId}: held by another owner and not expired`,
        );
      }
      throw error;
    }

    return lock;
  }

  public override async releaseLock(
    props: LeaseReleaseLockProps,
  ): Promise<void> {
    const { leaseId, userEmail, ownerId } = props;
    try {
      await this.ddbClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { userEmail, uuid: leaseId },
          UpdateExpression: "REMOVE resourceLock",
          ConditionExpression:
            "attribute_exists(userEmail) AND (attribute_not_exists(resourceLock) OR resourceLock.ownerId = :ownerId)",
          ExpressionAttributeValues: {
            ":ownerId": ownerId,
          },
        }),
      );
    } catch (error: unknown) {
      if (error instanceof ConditionalCheckFailedException) {
        // No-op: lock doesn't exist, already released, or owned by someone else
        // (e.g., a critical override took ownership). This makes releaseLock safe
        // for defensive cleanup in catch blocks and overridden Step Functions.
        return;
      }
      throw error;
    }
  }

  @validateItem(LeaseSchema)
  @withMetadata(LeaseSchemaVersion)
  public override async update<T extends Lease>(
    lease: T,
    expected?: T,
  ): Promise<PutResult<T>> {
    if (expected) {
      try {
        const result = await this.ddbClient.send(
          new PutCommand({
            TableName: this.tableName,
            Item: removeNullFieldsForDynamoDB(lease),
            ReturnValues: "ALL_OLD",
            ConditionExpression: `attribute_exists(userEmail) and meta.lastEditTime = :expectedTime`,
            ExpressionAttributeValues: {
              ":expectedTime": expected.meta?.lastEditTime,
            },
          }),
        );
        return {
          oldItem: result.Attributes,
          newItem: lease,
        };
      } catch (error: unknown) {
        if (error instanceof ConditionalCheckFailedException) {
          throw new ConcurrentDataModificationException(
            "The lease has been modified from the expected value.",
          );
        }
        throw error; // Re-throw other errors
      }
    } else {
      try {
        const result = await this.ddbClient.send(
          new PutCommand({
            TableName: this.tableName,
            Item: removeNullFieldsForDynamoDB(lease),
            ReturnValues: "ALL_OLD",
            ConditionExpression: "attribute_exists(userEmail)", //PK -- ensures item exists
          }),
        );
        return {
          oldItem: result.Attributes,
          newItem: lease,
        };
      } catch (error: unknown) {
        if (error instanceof ConditionalCheckFailedException) {
          throw new UnknownItem("Unknown Lease.");
        }
        throw error; // Re-throw other errors
      }
    }
  }

  @validateItem(LeaseSchema)
  @withMetadata(LeaseSchemaVersion)
  public override async create<T extends Lease>(lease: T): Promise<T> {
    try {
      await this.ddbClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: removeNullFieldsForDynamoDB(lease),
          ConditionExpression: "attribute_not_exists(userEmail)", //PK -- ensures item does not exist
        }),
      );
      return lease;
    } catch (error: unknown) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new ItemAlreadyExists("Lease already exists.");
      }
      throw error; // Re-throw other errors
    }
  }

  public override async get(
    key: LeaseKey,
    options?: { consistentRead?: boolean },
  ): Promise<SingleItemResult<Lease>> {
    const result = await this.ddbClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: key,
        ...(options?.consistentRead && { ConsistentRead: true }),
      }),
    );

    return parseSingleItemResult(result.Item, LeaseSchema);
  }

  public override async batchGet(keys: LeaseKey[]): Promise<Lease[]> {
    if (keys.length === 0) return [];

    // Deduplicate input keys (BatchGetItem rejects duplicates). Tuple-stable
    // composite key avoids any chance of separator collision.
    const uniqueKeys = Array.from(
      new Map(
        keys.map((k) => [JSON.stringify([k.userEmail, k.uuid]), k] as const),
      ).values(),
    );

    const batches = chunk(uniqueKeys, 100);
    const allRawItems: Record<string, unknown>[] = [];

    await pMap(
      batches,
      async (batch) => {
        let pendingKeys: LeaseKey[] = batch;

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
              pendingKeys = unprocessed as LeaseKey[];
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

    const { result } = parseResults(allRawItems, LeaseSchema);
    return result;
  }

  public override async delete(key: LeaseKey): Promise<OptionalItem> {
    const result = await this.ddbClient.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: key,
        ReturnValues: "ALL_OLD",
      }),
    );

    return result.Attributes;
  }

  public override async findAll(props: {
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<Lease>> {
    const { pageIdentifier, pageSize } = props;

    const result = await this.ddbClient.send(
      new ScanCommand({
        TableName: this.tableName,
        ExclusiveStartKey: base64DecodeCompositeKey(pageIdentifier),
        Limit: pageSize,
      }),
    );

    return {
      ...parseResults(result.Items, LeaseSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  public override async findByStatus(props: {
    status: LeaseStatus;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<Lease>> {
    const { status, pageIdentifier, pageSize } = props;

    const result = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "StatusIndex",
        KeyConditionExpression: "#leaseStatus = :leaseStatus",
        ExpressionAttributeNames: {
          "#leaseStatus": "status",
        },
        ExpressionAttributeValues: {
          ":leaseStatus": status,
        },
        ExclusiveStartKey: base64DecodeCompositeKey(pageIdentifier),
        Limit: pageSize,
      }),
    );

    return {
      ...parseResults(result.Items, LeaseSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  public override async findByStatusAndAccountID(props: {
    status: MonitoredLeaseStatus | ExpiredLeaseStatus; //types that include awsAccountId
    awsAccountId: string;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<Lease>> {
    const { status, awsAccountId, pageIdentifier, pageSize } = props;

    const result = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "StatusIndex",
        KeyConditionExpression: "#leaseStatus = :leaseStatus",
        FilterExpression: `#awsAccountId = :awsAccountId`,
        ExpressionAttributeNames: {
          "#leaseStatus": "status",
          "#awsAccountId": "awsAccountId",
        },
        ExpressionAttributeValues: {
          ":leaseStatus": status,
          ":awsAccountId": awsAccountId,
        },
        ExclusiveStartKey: base64DecodeCompositeKey(pageIdentifier),
        Limit: pageSize,
      }),
    );

    return {
      ...parseResults(result.Items, LeaseSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  public override async findByUserEmail(props: {
    userEmail: EmailAddress;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<Lease>> {
    const { userEmail, pageIdentifier, pageSize } = props;

    const result = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "#userEmail = :userEmail",
        ExpressionAttributeNames: {
          "#userEmail": "userEmail",
        },
        ExpressionAttributeValues: {
          ":userEmail": userEmail,
        },
        ExclusiveStartKey: base64DecodeCompositeKey(pageIdentifier),
        Limit: pageSize,
      }),
    );
    return {
      ...parseResults(result.Items, LeaseSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  public override async findByLeaseTemplateUuid(props: {
    status: LeaseStatus;
    uuid: string;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<Lease>> {
    const { status, uuid, pageIdentifier, pageSize } = props;

    const result = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "StatusIndex",
        KeyConditionExpression:
          "#leaseStatus = :leaseStatus AND #leaseTemplateKey = :templateUuid",
        ExpressionAttributeNames: {
          "#leaseStatus": "status",
          "#leaseTemplateKey": "originalLeaseTemplateUuid",
        },
        ExpressionAttributeValues: {
          ":leaseStatus": status,
          ":templateUuid": uuid,
        },
        ExclusiveStartKey: base64DecodeCompositeKey(pageIdentifier),
        Limit: pageSize,
      }),
    );
    return {
      ...parseResults(result.Items, LeaseSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }
}
