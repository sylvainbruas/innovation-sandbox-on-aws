// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  AwsAccountId,
  OptionalItem,
  PaginatedQueryResult,
  PutResult,
  SingleItemResult,
} from "@amzn/innovation-sandbox-commons/data/common-types.js";
import {
  SandboxAccount,
  SandboxAccountStatus,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { Transaction } from "@amzn/innovation-sandbox-commons/utils/transactions.js";

export abstract class SandboxAccountStore {
  abstract put(account: SandboxAccount): Promise<PutResult<SandboxAccount>>;

  transactionalPut(
    account: SandboxAccount,
  ): Transaction<PutResult<SandboxAccount>> {
    return new Transaction({
      beginTransaction: async () => {
        return this.put(account);
      },
      rollbackTransaction: async (putResult) => {
        if (putResult.oldItem) {
          await this.put(putResult.oldItem as SandboxAccount);
        } else {
          await this.delete(account.awsAccountId);
        }
      },
    });
  }

  abstract delete(accountId: AwsAccountId): Promise<OptionalItem>;

  abstract findByStatus(args: {
    status: SandboxAccountStatus;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<SandboxAccount>>;

  abstract findAll(args: {
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<SandboxAccount>>;

  abstract get(
    accountId: AwsAccountId,
  ): Promise<SingleItemResult<SandboxAccount>>;

  /**
   * Partially updates specific fields on an account record using DynamoDB UpdateCommand.
   * Only touches the specified fields — does not overwrite the entire item.
   * Automatically updates `meta.lastEditTime`.
   *
   * Semantics:
   * - `set`: fields to SET (including null values, which store DynamoDB NULL type)
   * - `remove`: field names to REMOVE (delete the attribute from the item).
   *   Only optional fields can be removed — required fields (`status`) are excluded.
   */
  abstract update(
    accountId: AwsAccountId,
    params: {
      set?: Partial<Omit<SandboxAccount, "awsAccountId" | "meta">>;
      remove?: Array<
        keyof Omit<SandboxAccount, "awsAccountId" | "meta" | "status">
      >;
    },
  ): Promise<void>;

  abstract acquireLock(
    accountId: AwsAccountId,
    ownerId: string,
    timeoutSeconds: number,
    meta?: Record<string, string>,
  ): Promise<SandboxAccount>;

  /**
   * Releases the lock only if held by `ownerId`. Returns true when this owner
   * held the lock and it was removed; false when the lock was absent, already
   * released, or owned by a different execution (a no-op).
   */
  abstract releaseLock(
    accountId: AwsAccountId,
    ownerId: string,
  ): Promise<boolean>;
}
