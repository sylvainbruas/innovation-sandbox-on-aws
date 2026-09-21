// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  PersistedBlueprintItem,
  PersistedBlueprintWithStackSets,
  PersistedDeploymentHistoryItem,
  PersistedStackSetItem,
} from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint.js";
import {
  OptionalItem,
  PaginatedQueryResult,
  PutResult,
  SingleItemResult,
} from "@amzn/innovation-sandbox-commons/data/common-types.js";
import { Transaction } from "@amzn/innovation-sandbox-commons/utils/transactions.js";

export type BlueprintKey = {
  blueprintId: string;
};

export abstract class BlueprintStore {
  abstract createBlueprintWithStackSet(
    blueprint: PersistedBlueprintItem,
    stackSet: PersistedStackSetItem,
  ): Promise<PersistedBlueprintWithStackSets>;

  abstract update<T extends PersistedBlueprintItem>(
    blueprint: T,
    expected?: T,
  ): Promise<PutResult<T>>;

  abstract updateBlueprintWithStackSet(
    blueprint: PersistedBlueprintItem,
    stackSet: PersistedStackSetItem,
  ): Promise<PersistedBlueprintWithStackSets>;

  transactionalUpdate<T extends PersistedBlueprintItem>(
    blueprint: T,
  ): Transaction<PutResult<T>> {
    return new Transaction({
      beginTransaction: async () => {
        return this.update(blueprint);
      },
      rollbackTransaction: async (putResult) => {
        await this.update(
          putResult.oldItem as PersistedBlueprintItem,
          putResult.newItem,
        );
      },
    });
  }

  abstract delete(key: BlueprintKey): Promise<OptionalItem>;

  /**
   * Returns blueprints enriched with recent deployment history (last 10).
   * StackSets array is empty for performance - use get() for complete details.
   */
  abstract listBlueprints(props?: {
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<PersistedBlueprintWithStackSets>>;

  abstract get(
    blueprintId: string,
  ): Promise<SingleItemResult<PersistedBlueprintWithStackSets>>;

  abstract recordDeploymentStart(props: {
    blueprintId: string;
    stackSetId: string;
    leaseId: string;
    accountId: string;
    operationId: string;
    deploymentStartedAt: string;
  }): Promise<PersistedDeploymentHistoryItem>;

  abstract getDeploymentHistory(
    blueprintId: string,
    props?: {
      pageIdentifier?: string;
      pageSize?: number;
    },
  ): Promise<PaginatedQueryResult<PersistedDeploymentHistoryItem>>;

  abstract updateDeploymentStatusAndMetrics(props: {
    blueprintId: string;
    stackSetId: string;
    deploymentSK: string;
    status: "SUCCEEDED" | "FAILED";
    duration: number;
    deploymentTimestamp: string;
    errorType?: string;
    errorMessage?: string;
  }): Promise<void>;
}
