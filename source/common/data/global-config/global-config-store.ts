// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { AppConfigGlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";

export abstract class GlobalConfigStore {
  abstract put(
    globalConfig: AppConfigGlobalConfig,
  ): Promise<AppConfigGlobalConfig>;

  abstract get(): Promise<AppConfigGlobalConfig>;
}
