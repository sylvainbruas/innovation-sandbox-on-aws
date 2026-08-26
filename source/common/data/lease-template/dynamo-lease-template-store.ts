// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

import {
  PaginatedQueryResult,
  PutResult,
  SingleItemResult,
} from "@amzn/innovation-sandbox-commons/data/common-types.js";
import {
  base64DecodeCompositeKey,
  base64EncodeCompositeKey,
} from "@amzn/innovation-sandbox-commons/data/encoding.js";
import {
  ConcurrentDataModificationException,
  ItemAlreadyExists,
  UnknownItem,
} from "@amzn/innovation-sandbox-commons/data/errors.js";
import { LeaseTemplateStore } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template-store.js";
import {
  LeaseTemplate,
  LeaseTemplateSchema,
  LeaseTemplateSchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import {
  parseResults,
  parseSingleItemResult,
  removeNullFieldsForDynamoDB,
  validateItem,
  withMetadata,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";

export class DynamoLeaseTemplateStore extends LeaseTemplateStore {
  private readonly tableName: string;
  private readonly ddbClient: DynamoDBDocumentClient;

  constructor(props: {
    leaseTemplateTableName: string;
    client: DynamoDBDocumentClient;
  }) {
    super();
    this.tableName = props.leaseTemplateTableName;
    this.ddbClient = props.client;
  }

  @validateItem(LeaseTemplateSchema)
  @withMetadata(LeaseTemplateSchemaVersion)
  public async create(leaseTemplate: LeaseTemplate): Promise<LeaseTemplate> {
    try {
      await this.ddbClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: removeNullFieldsForDynamoDB(leaseTemplate),
          ReturnValues: "ALL_OLD",
          ConditionExpression: "attribute_not_exists(#uid)", //PK -- ensures item does not exist
          ExpressionAttributeNames: {
            "#uid": "uuid",
          },
        }),
      );
      return leaseTemplate;
    } catch (error: unknown) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new ItemAlreadyExists("LeaseTemplate already exists.");
      }
      throw error; // Re-throw other errors
    }
  }

  @validateItem(LeaseTemplateSchema)
  @withMetadata(LeaseTemplateSchemaVersion)
  public async update(
    leaseTemplate: LeaseTemplate,
    expected?: LeaseTemplate,
  ): Promise<PutResult<LeaseTemplate>> {
    // createdBy and createdTime are server-owned: preserve them from the
    // persisted record so a caller cannot forge them on update. (@withMetadata
    // only carries forward whatever meta was passed in, which may be forged.)
    const persisted = await this.get(leaseTemplate.uuid);
    if (!persisted.result) {
      throw new UnknownItem("Unknown LeaseTemplate.");
    }
    leaseTemplate = {
      ...leaseTemplate,
      createdBy: persisted.result.createdBy,
      meta: leaseTemplate.meta
        ? { ...leaseTemplate.meta, createdTime: persisted.result.meta?.createdTime }
        : leaseTemplate.meta,
    };

    if (expected) {
      try {
        const result = await this.ddbClient.send(
          new PutCommand({
            TableName: this.tableName,
            Item: removeNullFieldsForDynamoDB(leaseTemplate),
            ReturnValues: "ALL_OLD",
            ConditionExpression: `attribute_exists(#uid) and meta.lastEditTime = :expectedTime`,
            ExpressionAttributeValues: {
              ":expectedTime": expected.meta?.lastEditTime,
            },
            ExpressionAttributeNames: {
              "#uid": "uuid",
            },
          }),
        );
        return {
          oldItem: result.Attributes,
          newItem: leaseTemplate,
        };
      } catch (error: unknown) {
        if (error instanceof ConditionalCheckFailedException) {
          throw new ConcurrentDataModificationException(
            "The lease template has been modified from the expected value.",
          );
        }
        throw error; // Re-throw other errors
      }
    } else {
      try {
        const result = await this.ddbClient.send(
          new PutCommand({
            TableName: this.tableName,
            Item: removeNullFieldsForDynamoDB(leaseTemplate),
            ReturnValues: "ALL_OLD",
            ConditionExpression: "attribute_exists(#uid)", //PK -- ensures item exists
            ExpressionAttributeNames: {
              "#uid": "uuid",
            },
          }),
        );
        return {
          oldItem: result.Attributes,
          newItem: leaseTemplate,
        };
      } catch (error: unknown) {
        if (error instanceof ConditionalCheckFailedException) {
          throw new UnknownItem("Unknown LeaseTemplate.");
        }
        throw error; // Re-throw other errors
      }
    }
  }

  public async delete(uuid: string): Promise<Record<string, any> | undefined> {
    const result = await this.ddbClient.send(
      new DeleteCommand({
        TableName: this.tableName,
        ReturnValues: "ALL_OLD",
        Key: {
          uuid,
        },
      }),
    );

    return result.Attributes;
  }

  public async findAll(props?: {
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<LeaseTemplate>> {
    const { pageSize, pageIdentifier } = props ?? {};

    const result = await this.ddbClient.send(
      new ScanCommand({
        TableName: this.tableName,
        ExclusiveStartKey: base64DecodeCompositeKey(pageIdentifier),
        Limit: pageSize,
      }),
    );
    return {
      ...parseResults(result.Items, LeaseTemplateSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  public async findAllVisible(props: {
    pageIdentifier?: string;
    pageSize?: number;
    includePrivate: boolean;
  }): Promise<PaginatedQueryResult<LeaseTemplate>> {
    const { pageSize, pageIdentifier, includePrivate } = props;

    // Elevated callers see everything; the plain scan is sufficient.
    if (includePrivate) {
      return this.findAll({ pageIdentifier, pageSize });
    }

    // For non-elevated callers, filter to PUBLIC server-side AND derive the
    // pagination token from a PUBLIC item we actually return. DynamoDB applies
    // Limit before FilterExpression, so LastEvaluatedKey can point at a PRIVATE
    // item that was filtered out — using it directly would leak that item's
    // UUID. Instead we scan until we have enough PUBLIC items (or the table is
    // exhausted) and encode the last returned item's key as the token.
    const collected: LeaseTemplate[] = [];
    let exclusiveStartKey = base64DecodeCompositeKey(pageIdentifier);
    let errorMessage: string | undefined;

    do {
      const result = await this.ddbClient.send(
        new ScanCommand({
          TableName: this.tableName,
          ExclusiveStartKey: exclusiveStartKey,
          Limit: pageSize,
          // "not PRIVATE" rather than "= PUBLIC": legacy items written before
          // the visibility attribute existed have no visibility field, and the
          // schema defaults those to PUBLIC on read. attribute_not_exists keeps
          // them visible, matching the prior application-layer filter.
          FilterExpression:
            "attribute_not_exists(#visibility) OR #visibility <> :private",
          ExpressionAttributeNames: {
            "#visibility": "visibility",
          },
          ExpressionAttributeValues: {
            ":private": "PRIVATE",
          },
        }),
      );

      const parsed = parseResults(result.Items, LeaseTemplateSchema);
      if (parsed.error) {
        errorMessage = errorMessage
          ? `${errorMessage}${parsed.error}`
          : parsed.error;
      }
      collected.push(...parsed.result);
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (
      exclusiveStartKey !== undefined &&
      (pageSize === undefined || collected.length < pageSize)
    );

    const page =
      pageSize === undefined ? collected : collected.slice(0, pageSize);
    const lastReturned = page.at(-1);

    // More items may remain either because the table isn't exhausted, or
    // because we over-collected past pageSize in the final scan (the overflow
    // is dropped from this page and must be re-fetched on the next one). Emit a
    // token in both cases, anchored to the last RETURNED item so the next page
    // resumes exactly after it — this encodes a PUBLIC item's key, never a
    // PRIVATE one, and never strands the overflow.
    const hasOverflow =
      pageSize !== undefined && collected.length > pageSize;
    const nextPageIdentifier =
      (exclusiveStartKey !== undefined || hasOverflow) &&
      lastReturned !== undefined
        ? base64EncodeCompositeKey({ uuid: lastReturned.uuid })
        : null;

    return {
      result: page,
      nextPageIdentifier,
      error: errorMessage,
    };
  }

  public async findByManager(props: {
    manager: string;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<LeaseTemplate>> {
    const result = await this.ddbClient.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression: "#creator = :manager",
        ExpressionAttributeNames: {
          "#creator": "createdBy",
        },
        ExpressionAttributeValues: {
          ":manager": props.manager,
        },
        ExclusiveStartKey: base64DecodeCompositeKey(props.pageIdentifier),
        Limit: props.pageSize,
      }),
    );
    return {
      ...parseResults(result.Items, LeaseTemplateSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  public async get(uuid: string): Promise<SingleItemResult<LeaseTemplate>> {
    const result = await this.ddbClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { uuid },
      }),
    );

    return parseSingleItemResult(result.Item, LeaseTemplateSchema);
  }

  /**
   * Finds lease templates that reference a specific blueprint.
   *
   * Returns only key fields (uuid, blueprintId) because the blueprintId-index GSI
   * is configured with KEYS_ONLY projection. No schema validation is performed
   * since partial items would fail validation against LeaseTemplateSchema.
   */
  public async findByBlueprintId(
    blueprintId: string,
  ): Promise<{ uuid: string; blueprintId: string }[]> {
    const result = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "blueprintId-index",
        KeyConditionExpression: "blueprintId = :blueprintId",
        ExpressionAttributeValues: {
          ":blueprintId": blueprintId,
        },
      }),
    );

    return (result.Items || []).map((item) => ({
      uuid: item.uuid as string,
      blueprintId: item.blueprintId as string,
    }));
  }
}
