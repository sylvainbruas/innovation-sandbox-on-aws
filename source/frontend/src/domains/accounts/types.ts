// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { CleanupValidationMode } from "@amzn/innovation-sandbox-commons/data/config/config";

export type UnregisteredAccount = {
  Id: string;
  Email: string;
  Name?: string;
};

export interface CleanupReportStep {
  name: string;
  startedAt: string;
  completedAt?: string;
  meta?: {
    codeBuildExecutionArn?: string;
    outcome?: "SUCCEEDED" | "FAILED";
    cooldownDurationHours?: number;
    skippedBy?: string;
    skippedAt?: string;
    [key: string]: unknown;
  };
}

export interface CleanupResourceSummary {
  validationMode?: CleanupValidationMode;
  beforeCleanup?: {
    totalCount: number;
    ignoredCount: number;
    byType: Record<string, number>;
  };
  afterCooldown?: {
    totalCount: number;
    ignoredCount: number;
    byType: Record<string, number>;
  };
  remainingTypes: string[];
  remainingResources?: CleanupRemainingResource[];
  remainingResourcesTotalCount?: number;
  ignoredResources?: CleanupRemainingResource[];
  ignoredResourcesTotalCount?: number;
}

export interface CleanupRemainingResource {
  arn: string;
  resourceType: string;
  region: string;
}

export interface CleanupReport {
  accountId: string;
  durableExecutionArn: string;
  status: "IN_PROGRESS" | "COMPLETED" | "FAILED";
  cleanupStatus: string;
  startedAt: string;
  completedAt?: string;
  reasonForCleanup: string;
  initiatedBy?: string;
  resourceSummary?: CleanupResourceSummary;
  steps: CleanupReportStep[];
  cooldownSkippedBy?: string;
  error?: {
    step: string;
    message: string;
  };
}
