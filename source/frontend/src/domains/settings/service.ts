// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type AdminConfig,
  type ConfigMetadata,
  type ConfigSection,
  type ConfigSectionResponse,
} from "@amzn/innovation-sandbox-commons/data/config/config.js";
import {
  ApiProxy,
  IApiProxy,
} from "@amzn/innovation-sandbox-frontend/helpers/ApiProxy";

/**
 * A single config section as returned by the API. Alias of the shared
 * `ConfigSectionResponse` (section fields + `lastSavedBy` + optional `meta`).
 */
export type SectionData<T extends ConfigSection> = ConfigSectionResponse<T>;

export type { AdminConfig, ConfigMetadata, ConfigSection };

export class SettingService {
  private api: IApiProxy;

  constructor(apiProxy?: IApiProxy) {
    this.api = apiProxy ?? new ApiProxy();
  }

  /** All six config sections plus read-only deploy-time fields. */
  async getConfigurations(): Promise<AdminConfig> {
    return this.api.get<AdminConfig>("/configurations");
  }

  /** Read a single config section. */
  async getConfigurationSection<T extends ConfigSection>(
    section: T,
  ): Promise<SectionData<T>> {
    return this.api.get<SectionData<T>>(
      `/configurations/${encodeURIComponent(section)}`,
    );
  }

  /**
   * Full replacement of a single section. The caller supplies the section's
   * fields plus `meta.lastEditTime` for optimistic concurrency; the API rejects
   * a stale write with 409. `lastSavedBy` is set server-side and must not be in
   * the request body.
   */
  async putConfigurationSection<T extends ConfigSection>(
    section: T,
    data: unknown,
  ): Promise<SectionData<T>> {
    return this.api.put<SectionData<T>>(
      `/configurations/${encodeURIComponent(section)}`,
      data,
    );
  }
}
