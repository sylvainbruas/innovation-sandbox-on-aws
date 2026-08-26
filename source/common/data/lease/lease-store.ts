// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  EmailAddress,
  OptionalItem,
  PaginatedQueryResult,
  PutResult,
  SingleItemResult,
} from "@amzn/innovation-sandbox-commons/data/common-types.js";
import {
  DesiredAssignmentWithDisplay,
  ExpiredLeaseStatus,
  Lease,
  LeaseKey,
  type LeaseLockMeta,
  type LeaseResourceLock,
  LeaseStatus,
  MonitoredLeaseStatus,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { Transaction } from "@amzn/innovation-sandbox-commons/utils/transactions.js";

export interface LeaseAcquireLockProps {
  leaseId: string;
  userEmail: string;
  ownerId: string;
  timeoutSeconds: number;
  meta?: LeaseLockMeta;
}

export interface LeaseAcquireLockWithDesiredAssignmentsProps extends LeaseAcquireLockProps {
  desiredAssignments: DesiredAssignmentWithDisplay[];
}

export interface LeaseReleaseLockProps {
  leaseId: string;
  userEmail: string;
  ownerId: string;
}

export abstract class LeaseStore {
  /**
   * Acquires a resource lock on a lease. Succeeds if:
   * - No lock exists
   * - The existing lock is owned by the same ownerId (idempotent re-acquire)
   * - The existing lock has expired
   * - The intent is critical (TERMINATE/FREEZE) and the existing lock is non-critical
   *
   * @throws {ResourceLockConflictError} if the lock is held by another owner and cannot be overridden
   */
  abstract acquireLock(
    props: LeaseAcquireLockProps,
  ): Promise<LeaseResourceLock>;

  /**
   * Atomically acquires a resource lock AND writes desiredAssignments on the lease record
   * in a single DynamoDB conditional write. This is the declarative model entry point:
   * the API persists intent (desired state + lock) atomically, then emits an event.
   *
   * Same lock acquisition semantics as acquireLock (same condition expression).
   */
  abstract acquireLockWithDesiredAssignments(
    props: LeaseAcquireLockWithDesiredAssignmentsProps,
  ): Promise<LeaseResourceLock>;

  /**
   * Releases a resource lock on a lease. Succeeds if:
   * - The lease exists and no lock is held (idempotent)
   * - The lease exists and the lock is owned by the given ownerId
   * - The lock is held by a different owner (e.g., critical override took ownership)
   * - The lease does not exist
   *
   * This makes releaseLock safe for defensive cleanup in catch blocks and
   * overridden Step Functions whose lock was taken by a critical operation.
   */
  abstract releaseLock(props: LeaseReleaseLockProps): Promise<void>;

  abstract create<T extends Lease>(lease: T): Promise<T>;

  abstract update<T extends Lease>(
    lease: T,
    expected?: T, //fail the update if the lease has been modified from the expected (uses lastEdit meta)
  ): Promise<PutResult<T>>;

  transactionalUpdate<T extends Lease>(lease: T): Transaction<PutResult<T>> {
    return new Transaction({
      beginTransaction: async () => {
        return this.update(lease);
      },
      rollbackTransaction: async (putResult) => {
        await this.update(putResult.oldItem as Lease, putResult.newItem);
      },
    });
  }

  abstract delete(key: LeaseKey): Promise<OptionalItem>;

  abstract get(
    key: LeaseKey,
    options?: { consistentRead?: boolean },
  ): Promise<SingleItemResult<Lease>>;

  abstract batchGet(keys: LeaseKey[]): Promise<Lease[]>;

  abstract findAll(props: {
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<Lease>>;

  abstract findByUserEmail(props: {
    userEmail: EmailAddress;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<Lease>>;

  abstract findByLeaseTemplateUuid(props: {
    status: LeaseStatus;
    uuid: string;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<Lease>>;

  abstract findByStatus(props: {
    status: LeaseStatus;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<Lease>>;

  abstract findByStatusAndAccountID(props: {
    status: MonitoredLeaseStatus | ExpiredLeaseStatus;
    awsAccountId: string;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<Lease>>;
}
