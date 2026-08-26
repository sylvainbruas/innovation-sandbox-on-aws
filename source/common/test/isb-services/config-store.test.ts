// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { DynamoConfigStore } from "@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";

describe("IsbServices.configStore", () => {
  it("builds a DynamoConfigStore from the environment", () => {
    const configStore = IsbServices.configStore({
      CONFIG_TABLE_NAME: "test-config-table",
      USER_AGENT_EXTRA: "test-agent",
    });

    expect(configStore).toBeInstanceOf(DynamoConfigStore);
  });
});
