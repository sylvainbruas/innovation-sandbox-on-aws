// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Accounts typed adapter over the generated aggregate `IsbClient`. The shared
// transport (signed client, CloudFront handler, JSend error normalization) lives
// in `helpers/isbApiClient`; this file is only the domain-specific command calls
// and input/output mappers. Every migrated domain follows the same shape.
//
// Unlike leaseTemplates there is no Date<->ISO conversion here: account
// timestamps are modeled as raw `String` (not `@timestamp`, see accounts.smithy),
// so values pass through without conversion. List operations validate each item
// independently and omit malformed entries; the single-account GET validates the
// complete response and surfaces malformed data as an error.
import type {
  CleanupReport as SmithyCleanupReport,
  SandboxAccount as SmithySandboxAccount,
  UnregisteredAccount as SmithyUnregisteredAccount,
} from "@amzn/innovation-sandbox-api-client";
import {
  EjectAccountCommand,
  GetAccountCommand,
  IsbClient,
  ListAccountsCommand,
  ListCleanupReportsCommand,
  ListUnregisteredAccountsCommand,
  QuarantineAccountCommand,
  RegisterAccountCommand,
  RetryCleanupCommand,
  SkipCooldownCommand,
} from "@amzn/innovation-sandbox-api-client";
import {
  SandboxAccountView,
  SandboxAccountViewSchema,
  UnregisteredAccountView,
  UnregisteredAccountViewSchema,
} from "@amzn/innovation-sandbox-frontend/domains/accounts/model";
import {
  CleanupReportView,
  CleanupReportViewSchema,
} from "@amzn/innovation-sandbox-frontend/domains/accounts/types";
import { ApiPaginatedResult } from "@amzn/innovation-sandbox-frontend/types";

import { normalizeSmithyError } from "../../helpers/isbApiClient";
import { toValidListItems } from "../../helpers/validListItems";

// Domain-scoped name for the shared signed-client factory.
export { createIsbClient as createAccountClient } from "../../helpers/isbApiClient";

export interface SmithyAccountApi {
  listAccounts(
    pageIdentifier?: string,
  ): Promise<ApiPaginatedResult<SandboxAccountView>>;
  listUnregisteredAccounts(
    pageIdentifier?: string,
  ): Promise<ApiPaginatedResult<UnregisteredAccountView>>;
  getAccount(id: string): Promise<SandboxAccountView>;
  registerAccount(awsAccountId: string): Promise<void>;
  ejectAccount(awsAccountId: string): Promise<void>;
  retryCleanup(awsAccountId: string): Promise<void>;
  quarantineAccount(awsAccountId: string): Promise<void>;
  listCleanupReports(
    accountId: string,
    pageIdentifier?: string,
    maxResults?: number,
  ): Promise<ApiPaginatedResult<CleanupReportView>>;
  skipCooldown(awsAccountId: string): Promise<void>;
}

function mapSandboxAccount(account: SmithySandboxAccount) {
  // Keep every generated member explicit so additions to the Smithy response
  // cannot be silently dropped at the frontend boundary.
  return {
    awsAccountId: account.awsAccountId,
    status: account.status,
    email: account.email,
    name: account.name,
    driftAtLastScan: account.driftAtLastScan,
    activeCleanup: account.activeCleanup,
    lastCleanupCompletedAt: account.lastCleanupCompletedAt,
    currentLease: account.currentLease,
    cleanupExecutionContext: account.cleanupExecutionContext,
    resourceLock: account.resourceLock,
    meta: account.meta,
  } satisfies Record<keyof SmithySandboxAccount, unknown>;
}

function toSandboxAccount(account: SmithySandboxAccount): SandboxAccountView {
  return SandboxAccountViewSchema.parse(mapSandboxAccount(account));
}

function mapUnregisteredAccount(account: SmithyUnregisteredAccount) {
  // Keep every generated member explicit so additions to the Smithy response
  // cannot be silently dropped at the frontend boundary.
  return {
    Id: account.Id,
    Email: account.Email,
    Name: account.Name,
  } satisfies Record<keyof SmithyUnregisteredAccount, unknown>;
}

function mapCleanupReport(report: SmithyCleanupReport) {
  // Keep every generated member explicit so additions to the Smithy response
  // cannot be silently dropped at the frontend boundary.
  return {
    accountId: report.accountId,
    durableExecutionArn: report.durableExecutionArn,
    status: report.status,
    cleanupStatus: report.cleanupStatus,
    startedAt: report.startedAt,
    completedAt: report.completedAt,
    reasonForCleanup: report.reasonForCleanup,
    initiatedBy: report.initiatedBy,
    resourceSummary: report.resourceSummary,
    steps: report.steps,
    error: report.error,
    cooldownSkippedBy: report.cooldownSkippedBy,
  } satisfies Record<keyof SmithyCleanupReport, unknown>;
}

export class SmithyAccountClient implements SmithyAccountApi {
  constructor(private readonly client: IsbClient) {}

  async listAccounts(
    pageIdentifier?: string,
  ): Promise<ApiPaginatedResult<SandboxAccountView>> {
    try {
      const output = await this.client.send(
        new ListAccountsCommand({ pageIdentifier }),
      );
      // A missing page is not equivalent to a valid empty result.
      if (!output.data?.result) {
        throw new Error("Accounts list response did not contain data");
      }
      return {
        result: toValidListItems({
          clientName: "SmithyAccountClient",
          getItemId: (account) => account.awsAccountId,
          items: output.data.result,
          itemType: "account",
          mapItem: mapSandboxAccount,
          schema: SandboxAccountViewSchema,
        }),
        nextPageIdentifier: output.data.nextPageIdentifier ?? null,
      };
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async listUnregisteredAccounts(
    pageIdentifier?: string,
  ): Promise<ApiPaginatedResult<UnregisteredAccountView>> {
    try {
      // The continuation token here originates from AWS Organizations' own
      // pagination (not the DynamoDB-sourced tokens the sibling list operations
      // use), so it is not interchangeable across those operations.
      const output = await this.client.send(
        new ListUnregisteredAccountsCommand({ pageIdentifier }),
      );
      if (!output.data?.result) {
        throw new Error("Unregistered accounts response did not contain data");
      }
      return {
        result: toValidListItems({
          clientName: "SmithyAccountClient",
          getItemId: (account) => account.Id,
          items: output.data.result,
          itemType: "unregistered account",
          mapItem: mapUnregisteredAccount,
          schema: UnregisteredAccountViewSchema,
        }),
        nextPageIdentifier: output.data.nextPageIdentifier ?? null,
      };
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async getAccount(id: string): Promise<SandboxAccountView> {
    try {
      const output = await this.client.send(
        new GetAccountCommand({ awsAccountId: id }),
      );
      // Trust the wire: the handler returns 404 for a missing account (see
      // account-operations.ts `requireAccount`), and pre-Smithy `ApiProxy.get`
      // threw `ApiError` on that 404 — it did not swallow it into `undefined`. On
      // a 200 the handler always populates `data`; guard it so a malformed
      // success surfaces as an error rather than a bad cast.
      if (!output.data) {
        throw new Error("Account response did not contain data");
      }
      return toSandboxAccount(output.data);
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async registerAccount(awsAccountId: string): Promise<void> {
    try {
      await this.client.send(new RegisterAccountCommand({ awsAccountId }));
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async ejectAccount(awsAccountId: string): Promise<void> {
    try {
      await this.client.send(new EjectAccountCommand({ awsAccountId }));
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async retryCleanup(awsAccountId: string): Promise<void> {
    try {
      await this.client.send(new RetryCleanupCommand({ awsAccountId }));
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async quarantineAccount(awsAccountId: string): Promise<void> {
    try {
      await this.client.send(new QuarantineAccountCommand({ awsAccountId }));
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async listCleanupReports(
    accountId: string,
    pageIdentifier?: string,
    maxResults?: number,
  ): Promise<ApiPaginatedResult<CleanupReportView>> {
    try {
      const output = await this.client.send(
        new ListCleanupReportsCommand({
          awsAccountId: accountId,
          pageIdentifier,
          maxResults,
        }),
      );
      if (!output.data?.result) {
        throw new Error("Cleanup reports response did not contain data");
      }
      return {
        result: toValidListItems({
          clientName: "SmithyAccountClient",
          getItemId: (report) => report.accountId,
          items: output.data.result,
          itemType: "cleanup report",
          mapItem: mapCleanupReport,
          schema: CleanupReportViewSchema,
        }),
        nextPageIdentifier: output.data.nextPageIdentifier ?? null,
      };
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async skipCooldown(awsAccountId: string): Promise<void> {
    try {
      await this.client.send(new SkipCooldownCommand({ awsAccountId }));
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }
}
