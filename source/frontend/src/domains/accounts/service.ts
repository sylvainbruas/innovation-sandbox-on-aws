// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  SandboxAccountView,
  UnregisteredAccountView,
} from "@amzn/innovation-sandbox-frontend/domains/accounts/model";
import { CleanupReportView } from "@amzn/innovation-sandbox-frontend/domains/accounts/types";
import { registerApiSingletonReset } from "@amzn/innovation-sandbox-frontend/helpers/apiSingletons";
import { ApiPaginatedResult } from "@amzn/innovation-sandbox-frontend/types";

import {
  createAccountClient,
  SmithyAccountApi,
  SmithyAccountClient,
} from "./smithy-client";

export class AccountService {
  constructor(private readonly api: SmithyAccountApi) {}

  async getAccounts(): Promise<SandboxAccountView[]> {
    let allAccounts: SandboxAccountView[] = [];
    let nextPageIdentifier: string | null = null;

    // keep calling the API until all accounts are collected
    do {
      const response = await this.api.listAccounts(
        nextPageIdentifier ?? undefined,
      );
      allAccounts = [...allAccounts, ...response.result];
      nextPageIdentifier = response.nextPageIdentifier;
    } while (nextPageIdentifier !== null);

    return allAccounts;
  }

  async getUnregisteredAccounts(): Promise<UnregisteredAccountView[]> {
    let allAccounts: UnregisteredAccountView[] = [];
    let nextPageIdentifier: string | null = null;

    // keep calling the API until all accounts are collected
    do {
      const response = await this.api.listUnregisteredAccounts(
        nextPageIdentifier ?? undefined,
      );
      allAccounts = [...allAccounts, ...response.result];
      nextPageIdentifier = response.nextPageIdentifier;
    } while (nextPageIdentifier !== null);

    return allAccounts;
  }

  async getAccountById(id: string): Promise<SandboxAccountView> {
    return this.api.getAccount(id);
  }

  async addAccount(awsAccountId: string): Promise<void> {
    await this.api.registerAccount(awsAccountId);
  }

  async ejectAccount(awsAccountId: string): Promise<void> {
    await this.api.ejectAccount(awsAccountId);
  }

  async cleanupAccount(awsAccountId: string): Promise<void> {
    await this.api.retryCleanup(awsAccountId);
  }

  async quarantineAccount(awsAccountId: string): Promise<void> {
    await this.api.quarantineAccount(awsAccountId);
  }

  async getLatestCleanupReport(
    accountId: string,
  ): Promise<CleanupReportView | null> {
    try {
      // Matches the pre-Smithy `?maxResults=1` single-report fetch; any failure
      // (including a missing envelope) collapses to null as it did before.
      const response = await this.api.listCleanupReports(
        accountId,
        undefined,
        1,
      );
      return response.result[0] ?? null;
    } catch {
      return null;
    }
  }

  async getCleanupReports(
    accountId: string,
    pageIdentifier?: string,
  ): Promise<ApiPaginatedResult<CleanupReportView>> {
    return this.api.listCleanupReports(accountId, pageIdentifier);
  }

  async skipCooldown(awsAccountId: string): Promise<void> {
    await this.api.skipCooldown(awsAccountId);
  }
}

let accountService: AccountService | undefined;

// Lazily-initialized singleton.
export function getAccountService(): AccountService {
  accountService ??= new AccountService(
    new SmithyAccountClient(createAccountClient()),
  );
  return accountService;
}

registerApiSingletonReset(() => {
  accountService = undefined;
});
