// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { isValidElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  compareResourceTypeRows,
  formatCooldownRemaining,
  getStepDetails,
  getStepDurationText,
  getStepStatus,
  ResourceTypeRow,
} from "@amzn/innovation-sandbox-frontend/domains/accounts/components/CleanupDetails.helpers";
import { CleanupReport } from "@amzn/innovation-sandbox-frontend/domains/accounts/types";

type Step = CleanupReport["steps"][number];

// Minimal report builder — helpers only read status/error, so we cast the
// rest away rather than populate every envelope field.
function report(overrides: Partial<CleanupReport>): CleanupReport {
  return {
    status: "IN_PROGRESS",
    steps: [],
    ...overrides,
  } as CleanupReport;
}

function step(name: string, startedAt: string): Step {
  return { name, startedAt };
}

// Walks a rendered React node tree looking for a literal text fragment. Used
// to assert which getStepDetails branch produced the node without a DOM render.
function nodeContainsText(node: ReactNode, text: string): boolean {
  if (node == null || typeof node === "boolean") return false;
  if (typeof node === "string" || typeof node === "number") {
    return String(node).includes(text);
  }
  if (Array.isArray(node)) {
    return node.some((child) => nodeContainsText(child, text));
  }
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return nodeContainsText(props.children, text);
  }
  return false;
}

describe("getStepStatus", () => {
  const s = step("nuke-phase-1", "2024-06-15T12:00:00.000Z");

  test("marks the step that matches report.error as error when FAILED", () => {
    const r = report({
      status: "FAILED",
      error: { step: "nuke-phase-1", message: "boom" },
    });
    expect(
      getStepStatus({ step: s, isLast: false, nextStep: undefined, report: r }),
    ).toBe("error");
  });

  test("marks the last step as error on a terminal failure with no error field", () => {
    const r = report({ status: "FAILED" });
    expect(
      getStepStatus({ step: s, isLast: true, nextStep: undefined, report: r }),
    ).toBe("error");
  });

  test("marks a 'cleanup-failed' step as error regardless of position", () => {
    const r = report({ status: "IN_PROGRESS" });
    expect(
      getStepStatus({
        step: step("cleanup-failed", "2024-06-15T12:00:00.000Z"),
        isLast: false,
        nextStep: s,
        report: r,
      }),
    ).toBe("error");
  });

  test("marks validate-cleanup as warning when validation is warn-only with remainders", () => {
    const r = report({
      status: "COMPLETED",
      resourceSummary: {
        beforeCleanup: { totalCount: 5, ignoredCount: 0, byType: {} },
        afterCooldown: { totalCount: 2, ignoredCount: 0, byType: {} },
        remainingTypes: [],
      },
    });
    expect(
      getStepStatus({
        step: step("validate-cleanup", "2024-06-15T12:00:00.000Z"),
        isLast: false,
        nextStep: s,
        report: r,
      }),
    ).toBe("warning");
  });

  test("marks the trailing step as loading while IN_PROGRESS", () => {
    const r = report({ status: "IN_PROGRESS" });
    expect(
      getStepStatus({ step: s, isLast: true, nextStep: undefined, report: r }),
    ).toBe("loading");
    // also loading when there is simply no next step
    expect(
      getStepStatus({ step: s, isLast: false, nextStep: undefined, report: r }),
    ).toBe("loading");
  });

  test("defaults to success for completed intermediate steps", () => {
    const r = report({ status: "COMPLETED" });
    expect(
      getStepStatus({
        step: s,
        isLast: false,
        nextStep: step("next", "2024-06-15T12:01:00.000Z"),
        report: r,
      }),
    ).toBe("success");
  });
});

describe("getStepDurationText", () => {
  const r = report({ status: "IN_PROGRESS" });

  test("renders '<1s' for sub-second gaps to the next step", () => {
    expect(
      getStepDurationText({
        step: step("a", "2024-06-15T12:00:00.000Z"),
        nextStep: step("b", "2024-06-15T12:00:00.500Z"),
        isLast: false,
        report: r,
      }),
    ).toBe("<1s");
  });

  test("renders a human duration for multi-minute gaps", () => {
    expect(
      getStepDurationText({
        step: step("a", "2024-06-15T12:00:00.000Z"),
        nextStep: step("b", "2024-06-15T12:03:30.000Z"),
        isLast: false,
        report: r,
      }),
    ).toBe("3m, 30s");
  });

  test("renders 'In progress' for the last step while IN_PROGRESS", () => {
    expect(
      getStepDurationText({
        step: step("a", "2024-06-15T12:00:00.000Z"),
        nextStep: undefined,
        isLast: true,
        report: r,
      }),
    ).toBe("In progress");
  });

  test("renders empty string for a completed final step", () => {
    expect(
      getStepDurationText({
        step: step("a", "2024-06-15T12:00:00.000Z"),
        nextStep: undefined,
        isLast: true,
        report: report({ status: "COMPLETED" }),
      }),
    ).toBe("");
  });
});

describe("formatCooldownRemaining", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("returns '' when cooldown hours are unknown", () => {
    const cooldownStep = step("account-cooldown", "2024-06-15T11:00:00.000Z");
    expect(formatCooldownRemaining(cooldownStep, undefined)).toBe("");
  });

  test("returns '' when the cooldown step has no startedAt", () => {
    expect(formatCooldownRemaining(undefined, 24)).toBe("");
  });

  test("reports hours remaining when more than an hour is left", () => {
    // Started 1h ago, 24h cooldown -> ~23h remaining.
    const cooldownStep = step("account-cooldown", "2024-06-15T11:00:00.000Z");
    expect(formatCooldownRemaining(cooldownStep, 24)).toBe(
      " — ~23 hours remaining",
    );
  });

  test("reports minutes remaining when under an hour is left", () => {
    // Started 1h30m ago, 2h cooldown -> 30m remaining.
    const cooldownStep = step("account-cooldown", "2024-06-15T10:30:00.000Z");
    expect(formatCooldownRemaining(cooldownStep, 2)).toBe(
      " — ~30 minutes remaining",
    );
  });

  test("reports 'completing soon' once the cooldown window has elapsed", () => {
    // Started 3h ago, 2h cooldown -> already past.
    const cooldownStep = step("account-cooldown", "2024-06-15T09:00:00.000Z");
    expect(formatCooldownRemaining(cooldownStep, 2)).toBe(" — completing soon");
  });
});

describe("getStepDetails", () => {
  const durationText = "3m, 30s";

  test("returns the plain duration text for an ordinary step", () => {
    const details = getStepDetails(
      step("initialize-cleanup", "2024-06-15T12:00:00.000Z"),
      report({}),
      durationText,
    );
    expect(details).toBe(durationText);
  });

  test("returns undefined when there is no duration text and no special branch", () => {
    const details = getStepDetails(
      step("initialize-cleanup", "2024-06-15T12:00:00.000Z"),
      report({}),
      "",
    );
    expect(details).toBeUndefined();
  });

  test("renders the build-logs link for a nuke step with a CodeBuild ARN", () => {
    const nukeStep: Step = {
      name: "nuke-phase-1",
      startedAt: "2024-06-15T12:00:00.000Z",
      meta: {
        codeBuildExecutionArn:
          "arn:aws:codebuild:us-east-1:123456789012:build/proj:id",
      },
    };
    const details = getStepDetails(nukeStep, report({}), durationText);
    expect(isValidElement(details)).toBe(true);
    expect(nodeContainsText(details, "View build logs")).toBe(true);
  });

  test("renders the skipped-by note for a skipped account-cooldown step", () => {
    const details = getStepDetails(
      step("account-cooldown", "2024-06-15T12:00:00.000Z"),
      report({ cooldownSkippedBy: "admin@example.com" }),
      durationText,
    );
    expect(isValidElement(details)).toBe(true);
    expect(nodeContainsText(details, "Skipped by")).toBe(true);
    expect(nodeContainsText(details, "admin@example.com")).toBe(true);
  });

  // Locks the I1 refactor: the nuke branch (isNukeStep + CodeBuild ARN) and the
  // cooldown branch (name === "account-cooldown") key off disjoint step names,
  // so no single step can satisfy both. Reordering them (nuke-first vs the
  // original cooldown-last-wins) is therefore behavior-preserving. Even a
  // contrived account-cooldown step carrying a CodeBuild ARN still takes the
  // cooldown branch, never the nuke branch.
  test("account-cooldown never takes the nuke branch even with a CodeBuild ARN", () => {
    const hybridStep: Step = {
      name: "account-cooldown",
      startedAt: "2024-06-15T12:00:00.000Z",
      meta: {
        codeBuildExecutionArn:
          "arn:aws:codebuild:us-east-1:123456789012:build/proj:id",
      },
    };
    const details = getStepDetails(
      hybridStep,
      report({ cooldownSkippedBy: "admin@example.com" }),
      durationText,
    );
    expect(nodeContainsText(details, "Skipped by")).toBe(true);
    expect(nodeContainsText(details, "View build logs")).toBe(false);
  });
});

describe("compareResourceTypeRows", () => {
  const row = (over: Partial<ResourceTypeRow>): ResourceTypeRow => ({
    type: "ec2:instance",
    before: 0,
    after: null,
    hasRemaining: false,
    ...over,
  });

  test("sorts rows with remaining resources first on failure", () => {
    const a = row({ before: 1, hasRemaining: true });
    const b = row({ before: 10, hasRemaining: false });
    expect(compareResourceTypeRows(a, b, true)).toBe(-1);
    expect(compareResourceTypeRows(b, a, true)).toBe(1);
  });

  test("ignores the remaining flag when not failed, sorting by before desc", () => {
    const a = row({ before: 1, hasRemaining: true });
    const b = row({ before: 10, hasRemaining: false });
    // Not failed: pure descending before-count, so b (10) precedes a (1).
    expect(compareResourceTypeRows(a, b, false)).toBeGreaterThan(0);
    expect(compareResourceTypeRows(b, a, false)).toBeLessThan(0);
  });

  test("falls back to descending before-count when remaining flags tie", () => {
    const a = row({ before: 5, hasRemaining: true });
    const b = row({ before: 8, hasRemaining: true });
    expect(compareResourceTypeRows(a, b, true)).toBe(3);
  });
});
