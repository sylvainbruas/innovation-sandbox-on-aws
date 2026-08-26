// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Single import seam between the Admin Settings frontend and the shared config
 * schemas in the common package. Forms wire `ConfigWriteSchemas[section]` into
 * React Hook Form via `zodResolver`; the service and hooks use `ConfigSection`
 * and the section data types.
 *
 * All config schemas live in `@amzn/innovation-sandbox-commons` so the backend
 * PUT handler and the frontend forms validate against one source of truth.
 */
import {
  CONFIG_BOUNDS,
  ConfigSchemas,
  type ConfigSection,
  ConfigWriteSchemas,
} from "@amzn/innovation-sandbox-commons/data/config/config.js";

export { ConfigSchemas, ConfigWriteSchemas };
export type { ConfigSection };

/**
 * Field bound constants for UI `constraintText` props. Re-exported from the
 * common package, where the Zod schemas reference the same values, so forms
 * render exactly the limits the schemas enforce (single source of truth).
 */
export const CONFIG_CONSTRAINTS = CONFIG_BOUNDS;
