// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Shared ResourceLock schema for DynamoDB record-level concurrency control.
 *
 * Used by any store that needs exclusive locking on a record. Each store
 * implements its own acquireLock/releaseLock methods using this shared data shape,
 * since each table has a different key schema.
 *
 * The `meta` field allows callers to attach domain-specific context
 * without modifying the lock interface.
 */
export const ResourceLockSchema = z.strictObject({
  ownerId: z.string().min(1),
  acquiredAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  meta: z.record(z.string(), z.string()).optional(),
});

export type ResourceLock = z.infer<typeof ResourceLockSchema>;
