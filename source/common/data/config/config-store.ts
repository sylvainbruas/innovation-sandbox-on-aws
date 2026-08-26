// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import {
  ConfigSchemas,
  ConfigSection,
  ConfigSectionData,
  ConfigWriteSchemas,
  LastSavedBy,
} from "@amzn/innovation-sandbox-commons/data/config/config.js";

/**
 * Thrown by `putSection` on an optimistic-concurrency conflict
 * (`ConditionalCheckFailedException`). The PUT handler maps this to a static
 * 409 and MUST NOT surface `error.message` to the client.
 */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/**
 * Read/write contract for the six config sections, backed by the Config
 * DynamoDB table (one item per section, key `{ section, sk: "current" }`).
 * See design doc Section 5.1 (access patterns AP-1..AP-4).
 *
 * Implementations validate stored items against `ConfigSchemas[section]` and
 * apply `checkSchemaVersion` on read (per the sibling DynamoDB stores).
 */
export interface ConfigStore {
  /** Returns the section, or `null` if it does not exist in DynamoDB. */
  getSection<T extends ConfigSection>(
    section: T,
  ): Promise<ConfigSectionData<T> | null>;

  /** Returns only the sections present in DynamoDB; callers default the rest. */
  getAllSections(): Promise<{
    [K in ConfigSection]?: ConfigSectionData<K>;
  }>;

  /**
   * Writes a section with optimistic concurrency. Sets `lastSavedBy`,
   * `meta.lastEditTime`, and `meta.schemaVersion` server-side. Uses
   * `meta.lastEditTime = :expected` when `expectedLastEditTime` is given, or
   * `attribute_not_exists(section) AND attribute_not_exists(sk)` on first save.
   *
   * `LastSavedBy` structurally widens to `string`, so implementations MUST
   * `LastSavedBySchema.parse(editedBy)` before writing.
   *
   * @throws {ConflictError} when the condition expression fails.
   */
  putSection<T extends ConfigSection>(
    section: T,
    data: z.infer<(typeof ConfigWriteSchemas)[T]>,
    editedBy: LastSavedBy,
    expectedLastEditTime?: string,
  ): Promise<ConfigSectionData<T>>;

  /**
   * Writes every supplied section atomically as a single DynamoDB transaction,
   * for one-shot system writers such as the upgrade migrator. Sets `sk`,
   * `lastSavedBy`, and `meta` (createdTime/lastEditTime/schemaVersion)
   * server-side; callers pass only the already-validated section fields.
   *
   * `LastSavedBy` structurally widens to `string`, so implementations MUST
   * `LastSavedBySchema.parse(editedBy)` before writing.
   *
   * Idempotent by construction: each section is written under an
   * `attribute_not_exists` condition, so if the sections are already present
   * (a re-invocation of the one-time migrator) the write is a no-op and this
   * resolves to `{ migrated: false }` instead of overwriting admin-saved
   * config. Returns `{ migrated: true }` when the sections were written.
   */
  migrateSections(
    sections: { [K in ConfigSection]?: z.infer<(typeof ConfigSchemas)[K]> },
    editedBy: LastSavedBy,
  ): Promise<{ migrated: boolean }>;
}
