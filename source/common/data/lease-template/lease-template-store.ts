// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  OptionalItem,
  PaginatedQueryResult,
  PutResult,
  SingleItemResult,
} from "@amzn/innovation-sandbox-commons/data/common-types.js";
import { LeaseTemplate } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { Transaction } from "@amzn/innovation-sandbox-commons/utils/transactions.js";

export abstract class LeaseTemplateStore {
  abstract create(leaseTemplate: LeaseTemplate): Promise<LeaseTemplate>;

  abstract update(
    leaseTemplate: LeaseTemplate,
    expected?: LeaseTemplate,
  ): Promise<PutResult<LeaseTemplate>>;

  transactionalUpdate(
    leaseTemplate: LeaseTemplate,
  ): Transaction<PutResult<LeaseTemplate>> {
    return new Transaction({
      beginTransaction: async () => {
        return this.update(leaseTemplate);
      },
      rollbackTransaction: async (putResult) => {
        await this.update(
          putResult.oldItem as LeaseTemplate,
          putResult.newItem,
        );
      },
    });
  }

  abstract delete(uuid: string): Promise<OptionalItem>;

  /**
   * Returns raw items with no visibility filtering, and a pagination token
   * derived from DynamoDB's LastEvaluatedKey — which can point at a PRIVATE
   * template. Do NOT use for user-facing/visibility-scoped reads; use
   * findAllVisible instead. Intended for elevated or server-internal callers.
   */
  abstract findAll(props?: {
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<LeaseTemplate>>;

  /**
   * Like findAll, but never discloses PRIVATE templates to non-elevated callers
   * — neither in the result set nor via the pagination token. When
   * includePrivate is false, only PUBLIC templates are returned and the
   * nextPageIdentifier is derived from a PUBLIC item, so a PRIVATE template's
   * key can never leak through the token.
   */
  abstract findAllVisible(props: {
    pageIdentifier?: string;
    pageSize?: number;
    includePrivate: boolean;
  }): Promise<PaginatedQueryResult<LeaseTemplate>>;

  abstract get(uuid: string): Promise<SingleItemResult<LeaseTemplate>>;

  abstract findByManager(props: {
    manager: string;
    pageIdentifier?: string;
  }): Promise<PaginatedQueryResult<LeaseTemplate>>;

  /**
   * Finds lease templates that reference a specific blueprint.
   * Returns only key fields (uuid, blueprintId) since the GSI uses KEYS_ONLY projection.
   * Used for validation checks (e.g., preventing blueprint deletion when in use).
   */
  abstract findByBlueprintId(
    blueprintId: string,
  ): Promise<{ uuid: string; blueprintId: string }[]>;
}
