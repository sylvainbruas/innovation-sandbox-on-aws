// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Box, Link, SpaceBetween } from "@cloudscape-design/components";
import { StepsProps } from "@cloudscape-design/components/steps";
import { DateTime } from "luxon";
import { ReactNode } from "react";

import { CleanupReport } from "@amzn/innovation-sandbox-frontend/domains/accounts/types";

// =============================================================================
// Types
// =============================================================================

export type CleanupStep = CleanupReport["steps"][number];

export interface ResourceTypeRow {
  type: string;
  before: number;
  after: number | null;
  hasRemaining: boolean;
}

// =============================================================================
// Low-level utils
// =============================================================================

const NUKE_STEP_PREFIXES = ["nuke-phase-"];

function isNukeStep(stepName: string): boolean {
  return NUKE_STEP_PREFIXES.some((prefix) => stepName.startsWith(prefix));
}

function getCodeBuildUrl(arn: string): string {
  // arn:aws:codebuild:region:account:build/project:id
  const parts = arn.split(":");
  const region = parts[3];
  const buildResource = parts.slice(5).join(":");
  const [, projectAndId] = buildResource.split("/");
  return `https://${region}.console.aws.amazon.com/codesuite/codebuild/projects/${projectAndId.split(":")[0]}/build/${projectAndId}/log`;
}

export function isSilentMode(report: CleanupReport): boolean {
  return report.resourceSummary?.validationMode === "Silent";
}

export function hasValidationWarning(report: CleanupReport): boolean {
  // Silent mode is metrics-only, so it never warrants a warning.
  if (isSilentMode(report)) {
    return false;
  }
  return (
    report.resourceSummary?.validationMode !== "Quarantine" &&
    (report.resourceSummary?.afterCooldown?.totalCount ?? 0) > 0
  );
}

// =============================================================================
// Step helpers
// =============================================================================

export function getStepStatus(params: {
  step: CleanupStep;
  isLast: boolean;
  nextStep: CleanupStep | undefined;
  report: CleanupReport;
}): StepsProps.Status {
  const { step, isLast, nextStep, report } = params;
  const isFailedStep =
    report.error?.step === step.name && report.status === "FAILED";
  const isTerminalFailed =
    isLast && report.status === "FAILED" && !report.error;
  const isCleanupFailedStep = step.name === "cleanup-failed";
  const isValidationWarning =
    step.name === "validate-cleanup" && hasValidationWarning(report);
  const isFailedNukeIteration =
    isNukeStep(step.name) && step.meta?.outcome === "FAILED";

  if (isFailedStep || isTerminalFailed || isCleanupFailedStep) return "error";
  // Failed nuke iteration — show as warning (the separate cleanup-failed step
  // shows the terminal error).
  if (isFailedNukeIteration) return "warning";
  if (isValidationWarning) return "warning";
  if (isLast && report.status === "IN_PROGRESS") return "loading";
  if (!nextStep && report.status === "IN_PROGRESS") return "loading";
  return "success";
}

export function getStepDurationText(params: {
  step: CleanupStep;
  nextStep: CleanupStep | undefined;
  isLast: boolean;
  report: CleanupReport;
}): string {
  const { step, nextStep, isLast, report } = params;
  if (nextStep) {
    const start = DateTime.fromISO(step.startedAt);
    const end = DateTime.fromISO(nextStep.startedAt);
    const diff = end.diff(start, ["hours", "minutes", "seconds"]);
    if (diff.as("seconds") < 1) return "<1s";
    return diff
      .set({ seconds: Math.floor(diff.seconds), milliseconds: 0 })
      .rescale()
      .toHuman({ unitDisplay: "narrow" });
  }
  if (isLast && report.status === "IN_PROGRESS") return "In progress";
  return "";
}

export function getStepDetails(
  step: CleanupStep,
  report: CleanupReport,
  durationText: string,
): ReactNode {
  if (isNukeStep(step.name) && step.meta?.codeBuildExecutionArn) {
    const buildUrl = getCodeBuildUrl(step.meta.codeBuildExecutionArn);
    return (
      <SpaceBetween direction="horizontal" size="xs">
        {durationText && <Box>{durationText}</Box>}
        <Link href={buildUrl} external variant="primary" fontSize="body-s">
          View build logs
        </Link>
      </SpaceBetween>
    );
  }

  if (step.name === "account-cooldown" && report.cooldownSkippedBy) {
    return (
      <SpaceBetween direction="horizontal" size="xs">
        {durationText && <Box>{durationText}</Box>}
        <Box color="text-body-secondary">
          Skipped by {report.cooldownSkippedBy}
        </Box>
      </SpaceBetween>
    );
  }

  return durationText || undefined;
}

export function getStatusAriaLabel(status: StepsProps.Status): string {
  switch (status) {
    case "success":
      return "Success";
    case "warning":
      return "Warning";
    case "error":
      return "Error";
    default:
      return "Loading";
  }
}

// =============================================================================
// Summary helpers
// =============================================================================

// Returns the " — …remaining" suffix for the cooling-down indicator, or "" when
// the cooldown timing is unknown.
export function formatCooldownRemaining(
  cooldownStep: CleanupStep | undefined,
  cooldownHours: number | undefined,
): string {
  if (!cooldownHours || !cooldownStep?.startedAt) return "";
  const expiresAt = DateTime.fromISO(cooldownStep.startedAt).plus({
    hours: cooldownHours,
  });
  const remaining = expiresAt.diff(DateTime.now(), ["hours", "minutes"]);
  if (remaining.as("minutes") <= 0) return " — completing soon";
  if (remaining.hours >= 1) {
    return ` — ~${Math.round(remaining.hours + remaining.minutes / 60)} hours remaining`;
  }
  return ` — ~${Math.round(remaining.minutes)} minutes remaining`;
}

// Orders resource-type rows: on failure, types with remaining resources sort
// first; otherwise by descending before-count.
export function compareResourceTypeRows(
  a: ResourceTypeRow,
  b: ResourceTypeRow,
  isFailed: boolean,
): number {
  if (isFailed) {
    if (a.hasRemaining && !b.hasRemaining) return -1;
    if (!a.hasRemaining && b.hasRemaining) return 1;
  }
  return b.before - a.before;
}
