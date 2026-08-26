// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { CleanupReport } from "@amzn/innovation-sandbox-frontend/domains/accounts/types";
import { DateTime } from "luxon";

export function createMockCleanupReport(
  overrides?: Partial<CleanupReport>,
): CleanupReport {
  return {
    accountId: "123456789012",
    durableExecutionArn:
      "arn:aws:states:us-east-1:123:execution:cleanup:test-123",
    status: "COMPLETED",
    cleanupStatus: "COMPLETED",
    startedAt: DateTime.now().minus({ hours: 2 }).toISO()!,
    completedAt: DateTime.now().minus({ hours: 1 }).toISO()!,
    reasonForCleanup: "LEASE_TERMINATION",
    steps: [
      {
        name: "acquire-cleanup-lock",
        startedAt: DateTime.now().minus({ hours: 2 }).toISO()!,
      },
      {
        name: "initialize-cleanup",
        startedAt: DateTime.now().minus({ hours: 1, minutes: 55 }).toISO()!,
      },
      {
        name: "cleanup-complete",
        startedAt: DateTime.now().minus({ hours: 1 }).toISO()!,
      },
    ],
    ...overrides,
  };
}

export function createMockInProgressReport(
  overrides?: Partial<CleanupReport>,
): CleanupReport {
  return createMockCleanupReport({
    status: "IN_PROGRESS",
    cleanupStatus: "NUKE_PHASE_1",
    completedAt: undefined,
    steps: [
      {
        name: "acquire-cleanup-lock",
        startedAt: DateTime.now().minus({ minutes: 30 }).toISO()!,
      },
      {
        name: "initialize-cleanup",
        startedAt: DateTime.now().minus({ minutes: 25 }).toISO()!,
      },
      {
        name: "nuke-phase-1",
        startedAt: DateTime.now().minus({ minutes: 20 }).toISO()!,
      },
    ],
    ...overrides,
  });
}

export function createMockFailedReport(
  overrides?: Partial<CleanupReport>,
): CleanupReport {
  return createMockCleanupReport({
    status: "FAILED",
    cleanupStatus: "FAILED",
    error: {
      step: "nuke-phase-1",
      message: "Nuke execution timed out after 60 minutes",
    },
    steps: [
      {
        name: "acquire-cleanup-lock",
        startedAt: DateTime.now().minus({ hours: 1 }).toISO()!,
      },
      {
        name: "initialize-cleanup",
        startedAt: DateTime.now().minus({ minutes: 55 }).toISO()!,
      },
      {
        name: "nuke-phase-1",
        startedAt: DateTime.now().minus({ minutes: 50 }).toISO()!,
      },
    ],
    ...overrides,
  });
}
