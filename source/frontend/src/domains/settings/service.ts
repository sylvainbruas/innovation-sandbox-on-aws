// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { registerApiSingletonReset } from "@amzn/innovation-sandbox-frontend/helpers/apiSingletons";
import type { ConfigSection } from "@amzn/innovation-sandbox-shared/types/configuration.js";

import type { AdminConfigurationView, ConfigurationSectionView } from "./model";
import {
  createConfigurationClient,
  SmithyConfigurationApi,
  SmithyConfigurationClient,
} from "./smithy-client";
import type { ConfigurationSectionRequest } from "./types";

export class SettingService {
  constructor(private readonly api: SmithyConfigurationApi) {}

  /** All six config sections plus read-only deploy-time fields. */
  async getConfigurations(): Promise<AdminConfigurationView> {
    return this.api.getConfigurations();
  }

  /** Read a single config section. */
  async getConfigurationSection<T extends ConfigSection>(
    section: T,
  ): Promise<ConfigurationSectionView<T>> {
    return this.api.getConfigurationSection(section);
  }

  /**
   * Full replacement of a single section. The caller supplies the section's
   * fields plus `meta.lastEditTime` for optimistic concurrency; the API rejects
   * a stale write with 409 (surfaced as an `ApiError` with `statusCode === 409`).
   * `lastSavedBy` is set server-side and must not be in the request body.
   */
  async putConfigurationSection<T extends ConfigSection>(
    section: T,
    data: ConfigurationSectionRequest<T>,
  ): Promise<ConfigurationSectionView<T>> {
    return this.api.putConfigurationSection(section, data);
  }
}

let settingService: SettingService | undefined;

// Lazily-initialized singleton.
export function getSettingService(): SettingService {
  settingService ??= new SettingService(
    new SmithyConfigurationClient(createConfigurationClient()),
  );
  return settingService;
}

registerApiSingletonReset(() => {
  settingService = undefined;
});
