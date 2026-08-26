// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { backOff } from "exponential-backoff";
import { z } from "zod";

import {
  ConfigStore,
  ConflictError,
} from "@amzn/innovation-sandbox-commons/data/config/config-store.js";
import {
  ConfigMetadata,
  ConfigSchemas,
  ConfigSchemaVersion,
  ConfigSection,
  ConfigSectionData,
  ConfigWriteSchemas,
  LastSavedBy,
  LastSavedBySchema,
} from "@amzn/innovation-sandbox-commons/data/config/config.js";
import { BatchGetUnprocessedKeysError } from "@amzn/innovation-sandbox-commons/data/errors.js";
import {
  checkSchemaVersion,
  createVersionRangeSchema,
  ItemWithMetadata,
  SchemaMismatchException,
} from "@amzn/innovation-sandbox-commons/data/metadata.js";
import { nowAsIsoDatetimeString } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";

const CURRENT_SK = "current";

const SUPPORTED_VERSIONS_SCHEMA = createVersionRangeSchema(
  1,
  ConfigSchemaVersion,
);

const ALL_SECTIONS = Object.keys(ConfigSchemas) as ConfigSection[];

/**
 * DynamoDB-backed {@link ConfigStore}. One item per section keyed by
 * `{ section, sk: "current" }`. Writes use {@link UpdateCommand} with a
 * conditional branch for optimistic concurrency (see {@link putSection}); reads
 * validate stored config fields against `ConfigSchemas[section]` and enforce the
 * supported schema-version range.
 */
export class DynamoConfigStore implements ConfigStore {
  private readonly tableName: string;
  private readonly ddbClient: DynamoDBDocumentClient;

  constructor(props: { client: DynamoDBDocumentClient; tableName: string }) {
    this.ddbClient = props.client;
    this.tableName = props.tableName;
  }

  public async getAllSections(): Promise<{
    [K in ConfigSection]?: ConfigSectionData<K>;
  }> {
    const found: Record<string, any>[] = [];
    let keys: { section: string; sk: string }[] = ALL_SECTIONS.map(
      (section) => ({ section, sk: CURRENT_SK }),
    );

    await backOff(
      async () => {
        const result = await this.ddbClient.send(
          new BatchGetCommand({
            RequestItems: { [this.tableName]: { Keys: keys } },
          }),
        );
        found.push(...(result.Responses?.[this.tableName] ?? []));

        const unprocessed = result.UnprocessedKeys?.[this.tableName]?.Keys as
          | { section: string; sk: string }[]
          | undefined;
        if (unprocessed && unprocessed.length > 0) {
          keys = unprocessed;
          throw new BatchGetUnprocessedKeysError(unprocessed.length);
        }
      },
      {
        numOfAttempts: 4,
        startingDelay: 100,
        jitter: "full",
        retry: (error: unknown) =>
          error instanceof BatchGetUnprocessedKeysError,
      },
    );

    const sections: { [K in ConfigSection]?: ConfigSectionData<K> } = {};
    for (const item of found) {
      const section = item.section as ConfigSection;
      try {
        (sections as Record<ConfigSection, ConfigSectionData<ConfigSection>>)[
          section
        ] = this.toSectionData(section, item);
      } catch {
        // Skip a malformed section; missing sections fall back to code defaults.
      }
    }
    return sections;
  }

  public async getSection<T extends ConfigSection>(
    section: T,
  ): Promise<ConfigSectionData<T> | null> {
    const result = await this.ddbClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { section, sk: CURRENT_SK },
      }),
    );
    if (!result.Item) {
      return null;
    }
    return this.toSectionData(section, result.Item);
  }

  public async putSection<T extends ConfigSection>(
    section: T,
    data: z.infer<(typeof ConfigWriteSchemas)[T]>,
    editedBy: LastSavedBy,
    expectedLastEditTime?: string,
  ): Promise<ConfigSectionData<T>> {
    const validatedEditedBy = LastSavedBySchema.parse(editedBy);
    const now = nowAsIsoDatetimeString();

    // Enforce `.strict()` + field bounds at runtime before any write.
    const parsed = (ConfigWriteSchemas[section] as z.ZodTypeAny).parse(data);

    const setParts: string[] = [];
    const names: Record<string, string> = { "#meta": "meta" };
    const values: Record<string, any> = {};

    for (const [field, value] of Object.entries(parsed as object)) {
      names[`#${field}`] = field;
      values[`:${field}`] = value;
      setParts.push(`#${field} = :${field}`);
    }

    names["#lastSavedBy"] = "lastSavedBy";
    values[":lastSavedBy"] = validatedEditedBy;
    setParts.push("#lastSavedBy = :lastSavedBy");

    let conditionExpression: string;
    if (expectedLastEditTime === undefined) {
      // First save: the meta map does not exist yet, so write it whole.
      names["#section"] = "section";
      names["#sk"] = "sk";
      values[":meta"] = {
        createdTime: now,
        lastEditTime: now,
        schemaVersion: ConfigSchemaVersion,
      };
      setParts.push("#meta = :meta");
      conditionExpression =
        "attribute_not_exists(#section) AND attribute_not_exists(#sk)";
    } else {
      // Subsequent save: leave createdTime untouched (write-once).
      names["#lastEditTime"] = "lastEditTime";
      names["#schemaVersion"] = "schemaVersion";
      values[":now"] = now;
      values[":schemaVersion"] = ConfigSchemaVersion;
      values[":expected"] = expectedLastEditTime;
      setParts.push("#meta.#lastEditTime = :now");
      setParts.push("#meta.#schemaVersion = :schemaVersion");
      conditionExpression = "#meta.#lastEditTime = :expected";
    }

    try {
      const result = await this.ddbClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { section, sk: CURRENT_SK },
          UpdateExpression: `SET ${setParts.join(", ")}`,
          ConditionExpression: conditionExpression,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_NEW",
        }),
      );
      return this.toSectionData(
        section,
        result.Attributes as Record<string, any>,
      );
    } catch (error: unknown) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new ConflictError(
          expectedLastEditTime === undefined
            ? "Configuration section already exists."
            : "Configuration section was modified by another process.",
        );
      }
      throw error;
    }
  }

  public async migrateSections(
    sections: { [K in ConfigSection]?: z.infer<(typeof ConfigSchemas)[K]> },
    editedBy: LastSavedBy,
  ): Promise<{ migrated: boolean }> {
    const validatedEditedBy = LastSavedBySchema.parse(editedBy);
    const now = nowAsIsoDatetimeString();

    const transactItems = (
      Object.entries(sections) as [
        ConfigSection,
        z.infer<(typeof ConfigSchemas)[ConfigSection]>,
      ][]
    ).map(([section, fields]) => ({
      Put: {
        TableName: this.tableName,
        Item: {
          section,
          sk: CURRENT_SK,
          ...(fields as object),
          lastSavedBy: validatedEditedBy,
          meta: {
            createdTime: now,
            lastEditTime: now,
            schemaVersion: ConfigSchemaVersion,
          },
        },
        // Idempotency guard: write only if the section does not already exist,
        // so a re-invoked migrator never overwrites admin-saved config.
        ConditionExpression:
          "attribute_not_exists(#section) AND attribute_not_exists(#sk)",
        ExpressionAttributeNames: { "#section": "section", "#sk": "sk" },
      },
    }));

    try {
      await this.ddbClient.send(
        new TransactWriteCommand({ TransactItems: transactItems }),
      );
      return { migrated: true };
    } catch (error: unknown) {
      // No-op only when the cancellation is purely conditional (every reason
      // is ConditionalCheckFailed or "None"). A transient reason (throttling,
      // TransactionConflict) must surface, not be misread as "already migrated".
      if (
        error instanceof TransactionCanceledException &&
        error.CancellationReasons?.length &&
        error.CancellationReasons.every(
          (reason) =>
            reason.Code === "ConditionalCheckFailed" || reason.Code === "None",
        )
      ) {
        return { migrated: false };
      }
      throw error;
    }
  }

  /**
   * Reassembles a stored item into a typed {@link ConfigSectionData}: enforces
   * the supported schema version, validates the config fields against the
   * section's `.strict()` read schema (key/audit/meta attributes excluded), and
   * normalizes a missing `lastSavedBy` to `null`.
   */
  private toSectionData<T extends ConfigSection>(
    section: T,
    item: Record<string, any>,
  ): ConfigSectionData<T> {
    checkSchemaVersion(item as ItemWithMetadata, SUPPORTED_VERSIONS_SCHEMA);
    const { section: _section, sk: _sk, lastSavedBy, meta, ...fields } = item;
    if (!meta) {
      throw new SchemaMismatchException("Stored config item is missing meta.");
    }
    const parsedFields = (ConfigSchemas[section] as z.ZodTypeAny).parse(
      fields,
    ) as z.infer<(typeof ConfigSchemas)[T]>;
    return {
      ...parsedFields,
      lastSavedBy: lastSavedBy ?? null,
      meta: meta as ConfigMetadata,
    };
  }
}
