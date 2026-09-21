// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  SandboxAccountView,
  UnregisteredAccountView,
} from "@amzn/innovation-sandbox-frontend/domains/accounts/model";
import { AccountService } from "@amzn/innovation-sandbox-frontend/domains/accounts/service";
import { SmithyAccountApi } from "@amzn/innovation-sandbox-frontend/domains/accounts/smithy-client";
import { CleanupReportView } from "@amzn/innovation-sandbox-frontend/domains/accounts/types";
import { ApiPaginatedResult } from "@amzn/innovation-sandbox-frontend/types";

const account = (id: string): SandboxAccountView => ({
  awsAccountId: id,
  status: "Available",
});

const report: CleanupReportView = {
  accountId: "000000000000",
  durableExecutionArn: "arn",
  status: "COMPLETED",
  cleanupStatus: "SUCCESS",
  startedAt: "2026-08-10T00:00:00.000Z",
  reasonForCleanup: "MANUALLY_INITIATED",
  steps: [],
};

function stubApi(overrides: Partial<SmithyAccountApi> = {}): SmithyAccountApi {
  return {
    listAccounts: vi.fn(),
    listUnregisteredAccounts: vi.fn(),
    getAccount: vi.fn(),
    registerAccount: vi.fn(),
    ejectAccount: vi.fn(),
    retryCleanup: vi.fn(),
    quarantineAccount: vi.fn(),
    listCleanupReports: vi.fn(),
    skipCooldown: vi.fn(),
    ...overrides,
  };
}

describe("AccountService", () => {
  it("getAccounts follows the continuation token across pages", async () => {
    const listAccounts = vi
      .fn()
      .mockResolvedValueOnce({
        result: [account("000000000000")],
        nextPageIdentifier: "page-2",
      })
      .mockResolvedValueOnce({
        result: [account("111111111111")],
        nextPageIdentifier: null,
      });
    const service = new AccountService(stubApi({ listAccounts }));

    const accounts = await service.getAccounts();

    expect(accounts.map((a) => a.awsAccountId)).toEqual([
      "000000000000",
      "111111111111",
    ]);
    expect(listAccounts).toHaveBeenNthCalledWith(1, undefined);
    expect(listAccounts).toHaveBeenNthCalledWith(2, "page-2");
  });

  it("getUnregisteredAccounts follows the continuation token across pages", async () => {
    const a = (Id: string): UnregisteredAccountView => ({
      Id,
      Email: `${Id}@example.com`,
    });
    const listUnregisteredAccounts = vi
      .fn()
      .mockResolvedValueOnce({ result: [a("1")], nextPageIdentifier: "next" })
      .mockResolvedValueOnce({ result: [a("2")], nextPageIdentifier: null });
    const service = new AccountService(stubApi({ listUnregisteredAccounts }));

    const accounts = await service.getUnregisteredAccounts();

    expect(accounts.map((x) => x.Id)).toEqual(["1", "2"]);
    expect(listUnregisteredAccounts).toHaveBeenNthCalledWith(2, "next");
  });

  it("getLatestCleanupReport requests one report and returns the first", async () => {
    const listCleanupReports = vi
      .fn<() => Promise<ApiPaginatedResult<CleanupReportView>>>()
      .mockResolvedValue({ result: [report], nextPageIdentifier: null });
    const service = new AccountService(stubApi({ listCleanupReports }));

    await expect(
      service.getLatestCleanupReport("000000000000"),
    ).resolves.toEqual(report);
    expect(listCleanupReports).toHaveBeenCalledWith(
      "000000000000",
      undefined,
      1,
    );
  });

  it("getLatestCleanupReport returns null when the fetch fails", async () => {
    const listCleanupReports = vi.fn().mockRejectedValue(new Error("boom"));
    const service = new AccountService(stubApi({ listCleanupReports }));

    await expect(
      service.getLatestCleanupReport("000000000000"),
    ).resolves.toBeNull();
  });

  it("getLatestCleanupReport returns null when there are no reports", async () => {
    const listCleanupReports = vi
      .fn()
      .mockResolvedValue({ result: [], nextPageIdentifier: null });
    const service = new AccountService(stubApi({ listCleanupReports }));

    await expect(
      service.getLatestCleanupReport("000000000000"),
    ).resolves.toBeNull();
  });

  it("delegates the single-target methods to the adapter", async () => {
    const api = stubApi();
    const service = new AccountService(api);

    await service.getAccountById("000000000000");
    await service.addAccount("000000000000");
    await service.ejectAccount("000000000000");
    await service.cleanupAccount("000000000000");
    await service.quarantineAccount("000000000000");
    await service.skipCooldown("000000000000");
    await service.getCleanupReports("000000000000", "page");

    expect(api.getAccount).toHaveBeenCalledWith("000000000000");
    expect(api.registerAccount).toHaveBeenCalledWith("000000000000");
    expect(api.ejectAccount).toHaveBeenCalledWith("000000000000");
    expect(api.retryCleanup).toHaveBeenCalledWith("000000000000");
    expect(api.quarantineAccount).toHaveBeenCalledWith("000000000000");
    expect(api.skipCooldown).toHaveBeenCalledWith("000000000000");
    expect(api.listCleanupReports).toHaveBeenCalledWith("000000000000", "page");
  });
});
