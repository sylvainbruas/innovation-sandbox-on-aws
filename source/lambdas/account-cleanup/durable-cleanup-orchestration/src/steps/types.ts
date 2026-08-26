// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { CleanupReportKey } from "@amzn/innovation-sandbox-commons/data/cleanup-report/cleanup-report.js";
import { SandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account-store.js";
import { CleanupReason } from "@amzn/innovation-sandbox-commons/events/clean-account-request.js";
import { OrganizationsTaggingService } from "@amzn/innovation-sandbox-commons/isb-services/organizations-tagging-service.js";
import { DurableCleanupLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/durable-cleanup-lambda-environment.js";
import { IsbEventBridgeClient } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { DurableContext } from "@aws/durable-execution-sdk-js";
import z from "zod";

import { CleanupReportWriter } from "../cleanup-report-writer.js";

export type DurableCleanupEnv = z.infer<
  typeof DurableCleanupLambdaEnvironmentSchema
>;

/**
 * Immutable context for the entire cleanup execution.
 * Constructed once after the lock step and threaded through all steps.
 */
export interface CleanupContext {
  durableContext: DurableContext;
  env: DurableCleanupEnv;
  accountId: string;
  executionArn: string;
  cleanupReason: CleanupReason;
  executionStartTime: string;
  accountStore: SandboxAccountStore;
  eventBridge: IsbEventBridgeClient;
  organizationsTaggingService: OrganizationsTaggingService;
  reportWriter: CleanupReportWriter;
  reportKey: CleanupReportKey;
}

/**
 * Output of the nuke iteration loop.
 */
export interface NukeIterationsResult {
  totalIterations: number;
  succeededCount: number;
  failedCount: number;
}
