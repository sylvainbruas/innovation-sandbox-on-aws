// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import {
  type ConfigSection,
  type ConfigSectionFields,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";

/**
 * Schema version stamped onto every configuration item written to DynamoDB.
 * Increment when the stored shape changes in a non-additive way.
 */
export const ConfigSchemaVersion = 1;

/**
 * Audit identity stored on each section. Either a human email address or a
 * `system:` namespaced sentinel for system writers.
 */
export const PersistedLastSavedBySchema = z.union([
  z.email(),
  z.string().regex(/^system:[a-z][a-z0-9-]{0,49}$/),
]);

export type PersistedLastSavedBy = z.infer<typeof PersistedLastSavedBySchema>;

/**
 * DynamoDB metadata. All fields are required on a stored record; API response
 * metadata is a separate frontend/server-adapter concern.
 */
export type PersistedConfigMetadata = {
  createdTime: string;
  lastEditTime: string;
  schemaVersion: number;
};

/** A persisted section: neutral configuration fields plus storage metadata. */
export type PersistedConfigSectionData<T extends ConfigSection> =
  ConfigSectionFields<T> & {
    lastSavedBy: PersistedLastSavedBy | null;
    meta: PersistedConfigMetadata;
  };
