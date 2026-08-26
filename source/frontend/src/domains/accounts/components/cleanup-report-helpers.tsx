// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Box, Popover } from "@cloudscape-design/components";
import { DateTime } from "luxon";

import { CleanupReport } from "@amzn/innovation-sandbox-frontend/domains/accounts/types";

export const renderTimePopover = (date: string) => (
  <Popover
    position="top"
    size="large"
    dismissButton={false}
    content={DateTime.fromISO(date).toLocaleString(DateTime.DATETIME_HUGE)}
  >
    <Box>{DateTime.fromISO(date).toRelative()}</Box>
  </Popover>
);

export function formatDuration(report: CleanupReport): string {
  const start = DateTime.fromISO(report.startedAt);
  const end = report.completedAt
    ? DateTime.fromISO(report.completedAt)
    : DateTime.now();
  const diff = end.diff(start, ["hours", "minutes", "seconds"]);
  // Floor seconds to avoid millisecond spillover, then rescale to drop zero units
  const floored = diff.set({
    seconds: Math.floor(diff.seconds),
    milliseconds: 0,
  });
  return floored.rescale().toHuman({ unitDisplay: "narrow" });
}

export function formatReason(reason: string): string {
  const reasonMap: Record<string, string> = {
    LEASE_TERMINATION: "Lease terminated",
    ACCOUNT_REGISTRATION: "Account registration",
    MANUALLY_INITIATED: "Manually initiated",
    RETRY_FAILED_CLEANUP: "Manually initiated",
    LEASE_RESET: "Lease reset",
  };
  return reasonMap[reason] ?? reason;
}
