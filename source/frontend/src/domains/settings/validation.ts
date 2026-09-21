// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Forms wire the browser-safe shared schemas into React Hook Form. The same
 * schemas are consumed by backend persistence and request validation.
 */
import {
  CONFIG_BOUNDS,
  ConfigSchemas,
  type ConfigSection,
  ConfigWriteSchemas,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";

export { ConfigSchemas, ConfigWriteSchemas };
export type { ConfigSection };

/**
 * Field bound constants for UI `constraintText` props. Re-exported from the
 * shared package, where the Zod schemas reference the same values, so forms
 * render exactly the limits the schemas enforce (single source of truth).
 */
export const CONFIG_CONSTRAINTS = CONFIG_BOUNDS;
