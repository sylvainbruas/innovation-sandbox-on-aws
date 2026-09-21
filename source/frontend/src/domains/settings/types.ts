// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ConfigSection,
  ConfigSectionWriteFields,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";

/** Full-replacement request for one configuration section. */
export type ConfigurationSectionRequest<T extends ConfigSection> =
  ConfigSectionWriteFields<T> & {
    meta?: { lastEditTime?: string };
  };
