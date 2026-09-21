// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  BlueprintView,
  BlueprintWithStackSetsView,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/model";
import {
  BlueprintDetailResponse,
  BlueprintListResponse,
  RegisterBlueprintRequest,
  StackSetListResponse,
  UpdateBlueprintRequest,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/types";
import { registerApiSingletonReset } from "@amzn/innovation-sandbox-frontend/helpers/apiSingletons";

import {
  createBlueprintClient,
  SmithyBlueprintApi,
  SmithyBlueprintClient,
} from "./smithy-client";

export class BlueprintService {
  constructor(private readonly api: SmithyBlueprintApi) {}

  async getBlueprints(): Promise<BlueprintListResponse> {
    return this.api.getBlueprints();
  }

  async getBlueprintById(id: string): Promise<BlueprintDetailResponse> {
    return this.api.getBlueprintById(id);
  }

  async registerBlueprint(
    blueprint: RegisterBlueprintRequest,
  ): Promise<BlueprintView> {
    return this.api.registerBlueprint(blueprint);
  }

  async updateBlueprint(
    id: string,
    updates: UpdateBlueprintRequest,
  ): Promise<BlueprintWithStackSetsView> {
    return this.api.updateBlueprint(id, updates);
  }

  async unregisterBlueprint(id: string): Promise<void> {
    await this.api.unregisterBlueprint(id);
  }

  async unregisterBlueprints(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.api.unregisterBlueprint(id);
    }
  }

  async listStackSets(params?: {
    pageIdentifier?: string;
    maxResults?: number;
  }): Promise<StackSetListResponse> {
    return this.api.listStackSets(params);
  }
}

let blueprintService: BlueprintService | undefined;

// Lazily-initialized singleton.
export function getBlueprintService(): BlueprintService {
  blueprintService ??= new BlueprintService(
    new SmithyBlueprintClient(createBlueprintClient()),
  );
  return blueprintService;
}

registerApiSingletonReset(() => {
  blueprintService = undefined;
});
