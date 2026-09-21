// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { enumErrorMap } from "../utils/zod.js";

/**
 * Account and cleanup values shared by persistence, API supplements, and the
 * frontend. DynamoDB metadata, record locks, and UI-only projections do not
 * belong in this module.
 */
export const IsbOuSchema = z.enum(
  ["Available", "Active", "CleanUp", "Quarantine", "Frozen", "Entry", "Exit"],
  {
    error: enumErrorMap,
  },
);

export const SandboxAccountStatusSchema = IsbOuSchema.exclude([
  "Entry",
  "Exit",
]);

export const CleanupStatusSchema = z
  .enum([
    "INITIALIZING",
    "REVOKING_ACCESS",
    "VALIDATING",
    "COOLING_DOWN",
    "COMPLETED",
    "FAILED",
  ])
  .or(z.string().regex(/^NUKE_PHASE_\d+$/));

export const ActiveCleanupSchema = z.object({
  status: CleanupStatusSchema,
  executionArn: z.string(),
  startedAt: z.iso.datetime(),
});

export const CurrentLeaseSchema = z.object({
  leaseId: z.uuid(),
  ownerEmail: z.email(),
});

/**
 * Post-cleanup validation mode. Single source of truth shared by the cleanup
 * config `failureAction` field and the cleanup report's `validationMode`:
 *  - "Silent" (default): validation runs in the background but never warns
 *    the user or quarantines the account.
 *  - "Warn": surfaces remaining resources in reports/logs but still proceeds.
 *  - "Quarantine": a failed validation quarantines the account.
 */
export const CleanupValidationModeSchema = z.enum([
  "Quarantine",
  "Warn",
  "Silent",
]);

export type SandboxAccountStatus = z.infer<typeof SandboxAccountStatusSchema>;
export type IsbOu = z.infer<typeof IsbOuSchema>;
export type CleanupStatus = z.infer<typeof CleanupStatusSchema>;
export type ActiveCleanup = z.infer<typeof ActiveCleanupSchema>;
export type CurrentLease = z.infer<typeof CurrentLeaseSchema>;
export type CleanupValidationMode = z.infer<typeof CleanupValidationModeSchema>;
