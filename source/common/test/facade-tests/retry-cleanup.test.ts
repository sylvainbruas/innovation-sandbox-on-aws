// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SandboxAccountSchema } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { CleanAccountRequest } from "@amzn/innovation-sandbox-commons/events/clean-account-request.js";
import {
  AccountInCleanUpError,
  InnovationSandbox,
} from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  mockedAccountStore,
  mockedIsbEventBridge,
  mockedOrganizationsTaggingService,
  mockedOrgsService,
} from "@amzn/innovation-sandbox-commons/test/mocking/common-mocks.js";
import { createMockOf } from "@amzn/innovation-sandbox-commons/test/mocking/mock-utils.js";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

function createMockContext() {
  return {
    sandboxAccountStore: mockedAccountStore(),
    orgsService: mockedOrgsService(),
    organizationsTaggingService: mockedOrganizationsTaggingService(),
    eventBridgeClient: mockedIsbEventBridge(),
    logger: createMockOf(Logger),
    tracer: new Tracer(),
  };
}

const currentDateTime = DateTime.fromISO("2024-12-20T08:45:00.000Z", {
  zone: "utc",
}) as DateTime<true>;

describe("InnovationSandbox.retryCleanup()", () => {
  let mockContext: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    mockContext = createMockContext();
    vi.useFakeTimers();
    vi.setSystemTime(currentDateTime.toJSDate());
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("HappyPath - RetryCleanup on account in Quarantine", async () => {
    const account = generateSchemaData(SandboxAccountSchema, {
      status: "Quarantine",
    });

    await InnovationSandbox.retryCleanup(
      {
        sandboxAccount: account,
      },
      mockContext,
    );

    expect(mockContext.orgsService.moveAccount).toHaveBeenCalledWith(
      account,
      "Quarantine",
      "CleanUp",
    );

    expect(mockContext.eventBridgeClient.sendIsbEvents).toHaveBeenCalledWith(
      mockContext.tracer,
      new CleanAccountRequest({
        accountId: account.awsAccountId,
        reason: "MANUALLY_INITIATED",
      }),
    );
  });

  test("includes initiatedBy in the emitted event when provided", async () => {
    const account = generateSchemaData(SandboxAccountSchema, {
      status: "Quarantine",
    });

    await InnovationSandbox.retryCleanup(
      {
        sandboxAccount: account,
        initiatedBy: "admin@example.com",
      },
      mockContext,
    );

    expect(mockContext.eventBridgeClient.sendIsbEvents).toHaveBeenCalledWith(
      mockContext.tracer,
      new CleanAccountRequest({
        accountId: account.awsAccountId,
        reason: "MANUALLY_INITIATED",
        initiatedBy: "admin@example.com",
      }),
    );
  });

  test("HappyPath - RetryCleanup on account already in CleanUp OU", async () => {
    const account = generateSchemaData(SandboxAccountSchema, {
      status: "CleanUp",
    });

    await InnovationSandbox.retryCleanup(
      {
        sandboxAccount: account,
      },
      mockContext,
    );

    expect(mockContext.orgsService.moveAccount).not.toHaveBeenCalled();

    expect(mockContext.eventBridgeClient.sendIsbEvents).toHaveBeenCalledWith(
      mockContext.tracer,
      new CleanAccountRequest({
        accountId: account.awsAccountId,
        reason: "MANUALLY_INITIATED",
      }),
    );
  });

  test("writes the Status tag as CleanUp after the OU move from Quarantine", async () => {
    const account = generateSchemaData(SandboxAccountSchema, {
      status: "Quarantine",
    });

    await InnovationSandbox.retryCleanup(
      { sandboxAccount: account },
      mockContext,
    );

    expect(
      mockContext.organizationsTaggingService.updateStatusTag,
    ).toHaveBeenCalledWith(account.awsAccountId, "CleanUp");
  });

  test("does NOT write the Status tag when account was already in CleanUp", async () => {
    const account = generateSchemaData(SandboxAccountSchema, {
      status: "CleanUp",
    });

    await InnovationSandbox.retryCleanup(
      { sandboxAccount: account },
      mockContext,
    );

    expect(
      mockContext.organizationsTaggingService.updateStatusTag,
    ).not.toHaveBeenCalled();
  });

  test("status-tag failure does not block the lifecycle", async () => {
    const account = generateSchemaData(SandboxAccountSchema, {
      status: "Quarantine",
    });
    mockContext.organizationsTaggingService.updateStatusTag.mockRejectedValue(
      new Error("AccessDenied"),
    );

    await InnovationSandbox.retryCleanup(
      { sandboxAccount: account },
      mockContext,
    );

    // Lifecycle continues — event still emitted.
    expect(mockContext.eventBridgeClient.sendIsbEvents).toHaveBeenCalled();
  });

  test("rejects when an active (non-expired) resourceLock is held by another execution", async () => {
    // A live lock means a cleanup execution is already running; dispatching a
    // second CleanAccountRequest would let two executions race on the account.
    const account = generateSchemaData(SandboxAccountSchema, {
      status: "CleanUp",
      resourceLock: {
        ownerId: "arn:aws:states:us-east-1:111122223333:execution:running",
        acquiredAt: currentDateTime.minus({ minutes: 1 }).toISO()!,
        expiresAt: currentDateTime.plus({ minutes: 4 }).toISO()!,
      },
    });

    await expect(
      InnovationSandbox.retryCleanup({ sandboxAccount: account }, mockContext),
    ).rejects.toThrow(AccountInCleanUpError);

    expect(mockContext.eventBridgeClient.sendIsbEvents).not.toHaveBeenCalled();
  });

  test("allows retry when the resourceLock has expired (stuck execution recovery)", async () => {
    // An expired lock is exactly the stuck-cleanup case retryCleanup exists to
    // recover, so it must NOT be blocked.
    const account = generateSchemaData(SandboxAccountSchema, {
      status: "CleanUp",
      resourceLock: {
        ownerId: "arn:aws:states:us-east-1:111122223333:execution:dead",
        acquiredAt: currentDateTime.minus({ minutes: 20 }).toISO()!,
        expiresAt: currentDateTime.minus({ minutes: 5 }).toISO()!,
      },
    });

    await InnovationSandbox.retryCleanup(
      { sandboxAccount: account },
      mockContext,
    );

    expect(mockContext.eventBridgeClient.sendIsbEvents).toHaveBeenCalled();
  });
});
