// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { vi } from "vitest";

import {
  ConfigSchemaVersion,
  PersistedConfigSectionData,
} from "@amzn/innovation-sandbox-commons/data/config/config.js";
import { DynamoConfigStore } from "@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js";
import { GlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { ReportingConfig } from "@amzn/innovation-sandbox-commons/data/reporting-config/reporting-config.js";
import { nowAsIsoDatetimeString } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import {
  ConfigSchemas,
  ConfigSection,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";

export const bulkStubEnv = (envVars: Record<string, string>) => {
  for (let [key, value] of Object.entries(envVars)) {
    vi.stubEnv(key, value);
  }
};

export const mockAppConfigMiddleware = (
  globalConfig: GlobalConfig,
  reportingConfig?: ReportingConfig,
) => {
  const now = nowAsIsoDatetimeString();
  const sections = {} as {
    [K in ConfigSection]?: PersistedConfigSectionData<K>;
  };
  for (const section of Object.keys(ConfigSchemas) as ConfigSection[]) {
    const fields =
      section === "costReporting" && reportingConfig
        ? reportingConfig
        : globalConfig[section];
    (
      sections as Record<
        ConfigSection,
        PersistedConfigSectionData<ConfigSection>
      >
    )[section] = {
      ...fields,
      lastSavedBy: null,
      meta: {
        createdTime: now,
        lastEditTime: now,
        schemaVersion: ConfigSchemaVersion,
      },
    };
  }

  vi.spyOn(DynamoConfigStore.prototype, "getAllSections").mockResolvedValue(
    sections,
  );
};
