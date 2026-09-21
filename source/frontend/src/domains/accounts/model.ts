// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import {
  ActiveCleanupSchema,
  CurrentLeaseSchema,
  SandboxAccountStatusSchema,
} from "@amzn/innovation-sandbox-shared/types/sandbox-account";

const AccountMetadataViewSchema = z.strictObject({
  createdTime: z.string().optional(),
  lastEditTime: z.string().optional(),
});

export type AccountMetadataView = z.infer<typeof AccountMetadataViewSchema>;

const AccountResourceLockViewSchema = z.strictObject({
  ownerId: z.string(),
  acquiredAt: z.string(),
  expiresAt: z.string(),
  meta: z.record(z.string(), z.string()).optional(),
});

export type AccountResourceLockView = z.infer<
  typeof AccountResourceLockViewSchema
>;

const CleanupExecutionContextViewSchema = z.strictObject({
  stateMachineExecutionArn: z.string(),
  stateMachineExecutionStartTime: z.string(),
});

export type CleanupExecutionContextView = z.infer<
  typeof CleanupExecutionContextViewSchema
>;

/**
 * Account representation consumed by frontend services and components.
 *
 * It intentionally excludes persistence-only schema versioning while retaining
 * the public metadata and lock fields returned by the Accounts API.
 */
export const SandboxAccountViewSchema = z.strictObject({
  awsAccountId: z.string().regex(/^\d{12}$/),
  status: SandboxAccountStatusSchema,
  email: z.email().optional(),
  name: z.string().optional(),
  driftAtLastScan: z.boolean().optional(),
  activeCleanup: ActiveCleanupSchema.optional(),
  lastCleanupCompletedAt: z.string().optional(),
  currentLease: CurrentLeaseSchema.optional(),
  cleanupExecutionContext: CleanupExecutionContextViewSchema.optional(),
  resourceLock: AccountResourceLockViewSchema.optional(),
  meta: AccountMetadataViewSchema.optional(),
});

export type SandboxAccountView = z.infer<typeof SandboxAccountViewSchema>;

export const UnregisteredAccountViewSchema = z.strictObject({
  Id: z.string(),
  Email: z.string(),
  Name: z.string().optional(),
});

export type UnregisteredAccountView = z.infer<
  typeof UnregisteredAccountViewSchema
>;
