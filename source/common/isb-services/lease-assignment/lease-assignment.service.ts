// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  CreateAccountAssignmentCommand,
  DeleteAccountAssignmentCommand,
  ResourceNotFoundException,
  SSOAdminClient,
  TargetType,
} from "@aws-sdk/client-sso-admin";
import { randomUUID } from "crypto";

import { PaginatedQueryResult } from "@amzn/innovation-sandbox-commons/data/common-types.js";
import {
  base64DecodeCompositeKey,
  base64EncodeCompositeKey,
} from "@amzn/innovation-sandbox-commons/data/encoding.js";
import { IdcStackConfigStore } from "@amzn/innovation-sandbox-commons/data/idc-stack-config/ssm-idc-stack-config-store.js";
import { LeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/lease-store.js";
import {
  CriticalLockIntents,
  type DesiredAssignmentWithDisplay,
  isExpiredLease,
  isFrozenLease,
  type Lease,
  LeaseKey,
  type LeaseResourceLock,
  MAX_ASSIGNMENTS,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { PrincipalStore } from "@amzn/innovation-sandbox-commons/data/principal/principal-store.js";
import type {
  GroupAssignment,
  UserAssignment,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import { AssignmentRequestedEvent } from "@amzn/innovation-sandbox-commons/events/assignment-requested-event.js";
import { getGroupMemberships } from "@amzn/innovation-sandbox-commons/isb-services/group-membership/index.js";
import {
  now,
  nowAsIsoDatetimeString,
  parseDatetime,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";

import { ItemAlreadyExists } from "@amzn/innovation-sandbox-commons/data/errors.js";
import {
  AssignmentAction,
  AssignmentProcessingLock,
  type AssignmentSyncStatus,
  type AssignmentView,
  DesiredAssignment,
  EnrichDesiredAssignmentsServices,
  EnrichedAssignment,
  GetLeasesForUserDirectServices,
  GetLeasesForUserProps,
  GetLeasesForUserViaGroupsServices,
  type LeaseAssignmentsView,
  LeaseLockIntent,
  MaxAssignmentsExceededError,
  ProcessAssignmentInput,
  ProcessAssignmentResult,
  ProcessAssignmentServices,
  ResolveAssignmentActionInput,
  ResolveAssignmentActionServices,
  SharedLease,
  SharedLeaseAccessType,
  TriggerAssignmentProcessingProps,
  TriggerAssignmentProcessingServices,
} from "./lease-assignment.types.js";

const CRITICAL_LOCK_TIMEOUT_SECONDS = 900;
const NON_CRITICAL_LOCK_TIMEOUT_SECONDS = 300;
const CRITICAL_INTENTS: readonly string[] = CriticalLockIntents;

/**
 * Acquires a resource lock on a lease and emits an AssignmentRequested event
 * to trigger the Assignment Processor Step Function.
 */
export async function triggerAssignmentProcessing(
  props: TriggerAssignmentProcessingProps,
  services: TriggerAssignmentProcessingServices,
): Promise<{ lockOwnerId: string; desiredCount: number }> {
  const lock = await acquireAssignmentProcessingLock(props, services);
  await publishAssignmentProcessingRequest(lock, services);
  return { lockOwnerId: lock.lockOwnerId, desiredCount: lock.desiredCount };
}

/**
 * Acquires the lease resource lock without publishing the request event.
 *
 * Use this with publishAssignmentProcessingRequest when the caller must mutate
 * lease state between acquiring the lock and dispatching the processor — the
 * lock then gates the mutation, so a conflict leaves the lease untouched. Use
 * triggerAssignmentProcessing instead when no such mutation is needed.
 *
 * Callers that acquire the lock directly own releasing it if their own work
 * fails before publishing; see releaseAssignmentProcessingLock.
 *
 * @throws {ResourceLockConflictError} when a competing lock cannot be preempted
 */
export async function acquireAssignmentProcessingLock(
  props: TriggerAssignmentProcessingProps,
  services: TriggerAssignmentProcessingServices,
): Promise<AssignmentProcessingLock> {
  const { leaseId, userEmail, intent, desiredAssignments } = props;
  const requestedBy = props.requestedBy ?? userEmail;
  const { leaseStore, principalStore, idcService, logger } = services;

  const isCritical = CRITICAL_INTENTS.includes(intent);
  const releaseLockOnEventFailure =
    props.releaseLockOnEventFailure ?? !isCritical;
  const timeoutSeconds = isCritical
    ? CRITICAL_LOCK_TIMEOUT_SECONDS
    : NON_CRITICAL_LOCK_TIMEOUT_SECONDS;

  const lockOwnerId = `${intent.toLowerCase()}-${randomUUID()}`;

  const { desiredCount, lock } = await acquireAssignmentLock(
    {
      leaseId,
      userEmail,
      intent,
      desiredAssignments,
      lockOwnerId,
      timeoutSeconds,
    },
    { leaseStore, principalStore, idcService, logger },
  );

  return {
    leaseId,
    userEmail,
    intent,
    requestedBy,
    lockOwnerId,
    desiredCount,
    lock,
    releaseLockOnEventFailure,
  };
}

/**
 * Publishes the AssignmentRequested event for a lock obtained via
 * acquireAssignmentProcessingLock, dispatching the Assignment Processor.
 */
export async function publishAssignmentProcessingRequest(
  lock: AssignmentProcessingLock,
  services: TriggerAssignmentProcessingServices,
): Promise<void> {
  const { leaseStore, eventBridgeClient, tracer, logger } = services;

  await publishAssignmentRequestedEvent(
    {
      leaseId: lock.leaseId,
      userEmail: lock.userEmail,
      intent: lock.intent,
      requestedBy: lock.requestedBy,
      lockOwnerId: lock.lockOwnerId,
      releaseLockOnEventFailure: lock.releaseLockOnEventFailure,
    },
    { leaseStore, eventBridgeClient, tracer, logger },
  );
}

/**
 * Best-effort release of a lock acquired via acquireAssignmentProcessingLock.
 *
 * Used to compensate when the caller's own work fails after acquiring the lock
 * but before publishing. A release failure is logged and swallowed so it never
 * shadows the original error — the lock expires on its own regardless.
 */
export async function releaseAssignmentProcessingLock(
  lock: Pick<AssignmentProcessingLock, "leaseId" | "userEmail" | "lockOwnerId">,
  services: {
    leaseStore: TriggerAssignmentProcessingServices["leaseStore"];
    logger: TriggerAssignmentProcessingServices["logger"];
  },
): Promise<void> {
  const { leaseStore, logger } = services;
  await leaseStore
    .releaseLock({
      leaseId: lock.leaseId,
      userEmail: lock.userEmail,
      ownerId: lock.lockOwnerId,
    })
    .catch((error: unknown) => {
      logger.error("Failed to release assignment lock during error cleanup", {
        leaseId: lock.leaseId,
        lockOwnerId: lock.lockOwnerId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });
}

/**
 * Acquires the lease resource lock. When desiredAssignments is provided, the
 * owner is auto-injected, the list is enriched and count-validated, and the
 * lock is written together with the enriched assignments. Returns the total
 * number of desired assignments persisted (including the owner), or 0 when no
 * assignments are provided.
 */
async function acquireAssignmentLock(
  props: {
    leaseId: string;
    userEmail: string;
    intent: LeaseLockIntent;
    desiredAssignments: DesiredAssignment[] | undefined;
    lockOwnerId: string;
    timeoutSeconds: number;
  },
  services: {
    leaseStore: TriggerAssignmentProcessingServices["leaseStore"];
    principalStore: TriggerAssignmentProcessingServices["principalStore"];
    idcService: TriggerAssignmentProcessingServices["idcService"];
    logger: TriggerAssignmentProcessingServices["logger"];
  },
): Promise<{ desiredCount: number; lock: LeaseResourceLock }> {
  const {
    leaseId,
    userEmail,
    intent,
    desiredAssignments,
    lockOwnerId,
    timeoutSeconds,
  } = props;
  const { leaseStore, principalStore, idcService, logger } = services;

  if (!desiredAssignments) {
    const lock = await leaseStore.acquireLock({
      leaseId,
      userEmail,
      ownerId: lockOwnerId,
      timeoutSeconds,
      meta: { intent },
    });
    logger.info("Resource lock acquired without desiredAssignments", {
      leaseId,
      lockOwnerId,
      intent,
    });
    return { desiredCount: 0, lock };
  }

  const enriched = await enrichWithOwner(
    { desiredAssignments, userEmail },
    { principalStore, idcService, logger },
  );
  validateAssignmentCount(enriched);

  const lock = await leaseStore.acquireLockWithDesiredAssignments({
    leaseId,
    userEmail,
    ownerId: lockOwnerId,
    timeoutSeconds,
    meta: { intent },
    desiredAssignments: enriched,
  });
  logger.info("Resource lock acquired with desiredAssignments", {
    leaseId,
    lockOwnerId,
    intent,
    desiredCount: enriched.length,
  });

  return { desiredCount: enriched.length, lock };
}

/**
 * Auto-injects the lease owner (implicit, like publishLease) into the desired
 * assignments and enriches them with display info. principalStore and
 * idcService are required.
 */
async function enrichWithOwner(
  props: { desiredAssignments: DesiredAssignment[]; userEmail: string },
  services: {
    principalStore: TriggerAssignmentProcessingServices["principalStore"];
    idcService: TriggerAssignmentProcessingServices["idcService"];
    logger: TriggerAssignmentProcessingServices["logger"];
  },
): Promise<EnrichedAssignment[]> {
  const { desiredAssignments, userEmail } = props;
  const { principalStore, idcService, logger } = services;

  if (!principalStore) {
    throw new Error(
      "principalStore is required when desiredAssignments is provided",
    );
  }
  if (!idcService) {
    throw new Error(
      "idcService is required when desiredAssignments is provided",
    );
  }

  const ownerPrincipal = await idcService.getCachedPrincipalByAttr(
    "USER",
    userEmail,
    principalStore,
    logger,
  );
  if (!ownerPrincipal) {
    throw new Error(
      "Unable to resolve the lease owner's identity. The owner may not exist in the identity store.",
    );
  }

  const ownerAlreadyIncluded = desiredAssignments.some(
    (a) => a.principalId === ownerPrincipal.principalId,
  );
  const desiredAssignmentsWithOwner: DesiredAssignment[] = ownerAlreadyIncluded
    ? desiredAssignments
    : [
        ...desiredAssignments,
        { principalId: ownerPrincipal.principalId, principalType: "USER" },
      ];

  return enrichDesiredAssignments(desiredAssignmentsWithOwner, {
    principalStore,
    idcService,
    logger,
  });
}

/**
 * Publishes the AssignmentRequested event. On failure, releases the lock when
 * releaseLockOnEventFailure is set (a lock-release failure is logged but never
 * shadows the original publish error), then rethrows.
 */
async function publishAssignmentRequestedEvent(
  props: {
    leaseId: string;
    userEmail: string;
    intent: LeaseLockIntent;
    requestedBy: string;
    lockOwnerId: string;
    releaseLockOnEventFailure: boolean;
  },
  services: {
    leaseStore: TriggerAssignmentProcessingServices["leaseStore"];
    eventBridgeClient: TriggerAssignmentProcessingServices["eventBridgeClient"];
    tracer: TriggerAssignmentProcessingServices["tracer"];
    logger: TriggerAssignmentProcessingServices["logger"];
  },
): Promise<void> {
  const {
    leaseId,
    userEmail,
    intent,
    requestedBy,
    lockOwnerId,
    releaseLockOnEventFailure,
  } = props;
  const { leaseStore, eventBridgeClient, tracer, logger } = services;

  try {
    await eventBridgeClient.sendIsbEvent(
      tracer,
      new AssignmentRequestedEvent({
        intent,
        leaseId,
        requestedBy,
        lockOwnerId,
        leaseOwnerEmail: userEmail,
      }),
    );
    logger.info("AssignmentRequested event published", {
      leaseId,
      lockOwnerId,
      intent,
    });
  } catch (error: unknown) {
    if (releaseLockOnEventFailure) {
      logger.error(
        "Failed to publish AssignmentRequested event, releasing lock",
        {
          leaseId,
          lockOwnerId,
          intent,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      await leaseStore
        .releaseLock({ leaseId, userEmail, ownerId: lockOwnerId })
        .catch((releaseError: unknown) => {
          logger.error("Failed to release lock during error cleanup", {
            leaseId,
            lockOwnerId,
            errorMessage:
              releaseError instanceof Error
                ? releaseError.message
                : String(releaseError),
          });
        });
    }
    throw error;
  }
}

/** Status for a principal that currently holds an access assignment. */
function statusForAssigned(props: {
  shouldNotBeAssigned: boolean;
  isInFlight: boolean;
}): AssignmentSyncStatus {
  if (!props.shouldNotBeAssigned) return "active";
  if (props.isInFlight) return "revoking";
  return "revokeFailed";
}

/** Status for a desired principal that holds no access assignment. */
function statusForUnassigned(props: {
  noAccessExpected: boolean;
  isInFlight: boolean;
}): AssignmentSyncStatus {
  if (props.noAccessExpected) return "suspended";
  if (props.isInFlight) return "granting";
  return "grantFailed";
}

/** Builds an AssignmentView for a desired principal that has no live assignment yet. */
function viewFromDesiredAssignment(props: {
  lease: Lease;
  desiredAssignment: DesiredAssignmentWithDisplay;
  noAccessExpected: boolean;
  isInFlight: boolean;
}): AssignmentView {
  const { desiredAssignment: d, lease, noAccessExpected, isInFlight } = props;
  return {
    principalId: d.principalId,
    principalType: d.principalType,
    displayName: d.displayName ?? d.email ?? d.principalId,
    assigneeEmail: d.principalType === "USER" ? d.email : undefined,
    isOwner: d.principalType === "USER" && d.email === lease.userEmail,
    isDesired: true,
    syncStatus: statusForUnassigned({ noAccessExpected, isInFlight }),
  };
}

/** Builds an AssignmentView for a principal that currently holds a live assignment. */
function viewFromAssignment(props: {
  lease: Lease;
  assignment: UserAssignment | GroupAssignment;
  desiredAssignment?: DesiredAssignmentWithDisplay;
  noAccessExpected: boolean;
  isInFlight: boolean;
}): AssignmentView {
  const { assignment, lease, desiredAssignment, noAccessExpected, isInFlight } =
    props;
  const principalId =
    assignment.principalType === "USER"
      ? assignment.userId
      : assignment.groupId;
  const assigneeEmail =
    "assigneeEmail" in assignment ? assignment.assigneeEmail : undefined;
  const isOwner =
    assignment.principalType === "USER" && assigneeEmail === lease.userEmail;
  const isDesired = !!desiredAssignment || isOwner;

  const shouldNotBeAssigned = noAccessExpected || (!isDesired && !isOwner);

  return {
    principalId,
    principalType: assignment.principalType,
    displayName:
      desiredAssignment?.displayName ??
      assignment.displayName ??
      assigneeEmail ??
      principalId,
    assigneeEmail,
    addedBy: assignment.addedBy,
    addedDate: assignment.addedDate,
    isOwner,
    isDesired,
    syncStatus: statusForAssigned({ shouldNotBeAssigned, isInFlight }),
  };
}

/**
 * Builds the assignments view for a lease: the union of its desired set and its
 * live access assignments, each annotated with a reconciliation status.
 *
 * Status depends on the direction of the in-flight operation, not just on
 * presence/absence: a missing assignment is a pending grant during
 * UPDATE/UNFREEZE but an already-completed revoke during FREEZE/TERMINATE. It
 * mirrors resolveAssignmentAction, which applies the same rule when the worker
 * acts.
 */
export function deriveAssignmentView(
  lease: Lease,
  assignments: Array<UserAssignment | GroupAssignment>,
): LeaseAssignmentsView {
  const { resourceLock } = lease;
  const operationInProgress =
    resourceLock && parseDatetime(resourceLock.expiresAt) > now()
      ? resourceLock.meta?.intent
      : undefined;

  const isInFlight = operationInProgress !== undefined;

  const noAccessExpected =
    operationInProgress === "FREEZE" ||
    operationInProgress === "TERMINATE" ||
    (isFrozenLease(lease) && operationInProgress !== "UNFREEZE") ||
    isExpiredLease(lease);

  const desired = lease.desiredAssignments ?? [];
  const desiredByPrincipalId = new Map(desired.map((d) => [d.principalId, d]));
  const assignedPrincipalIds = new Set(
    assignments.map((a) => (a.principalType === "USER" ? a.userId : a.groupId)),
  );

  const views: AssignmentView[] = assignments.map((a) => {
    const principalId = a.principalType === "USER" ? a.userId : a.groupId;
    return viewFromAssignment({
      assignment: a,
      lease,
      desiredAssignment: desiredByPrincipalId.get(principalId),
      noAccessExpected,
      isInFlight,
    });
  });

  const desiredOnlyViews = desired
    .filter((d) => !assignedPrincipalIds.has(d.principalId))
    .map((d) =>
      viewFromDesiredAssignment({
        desiredAssignment: d,
        lease,
        noAccessExpected,
        isInFlight,
      }),
    );

  return { assignments: [...views, ...desiredOnlyViews], operationInProgress };
}

/**
 * Determines the IDC action for a single principal at execution time (JIT diff)
 * from the lease intent, whether the principal is in the lease's desired
 * assignments, and whether an assignment record currently exists.
 *
 * FREEZE/TERMINATE revoke any existing access (desired state is effectively
 * empty), so the lease is not read for those intents.
 */
export async function resolveAssignmentAction(
  props: ResolveAssignmentActionInput,
  services: ResolveAssignmentActionServices,
): Promise<AssignmentAction> {
  const { principalStore, leaseStore, logger } = services;

  const recordExists = await assignmentRecordExists(principalStore, props);
  const shouldHaveAccess = await shouldPrincipalHaveAccess(leaseStore, props);
  const action = determineAction({
    intent: props.intent,
    isDesired: shouldHaveAccess,
    recordExists,
  });

  logger.info("Resolved assignment action", {
    leaseId: props.leaseId,
    principalId: props.principalId,
    principalType: props.principalType,
    intent: props.intent,
    recordExists,
    shouldHaveAccess,
    action,
  });

  return action;
}

function determineAction(props: {
  intent: LeaseLockIntent;
  isDesired: boolean;
  recordExists: boolean;
}): AssignmentAction {
  if (CRITICAL_INTENTS.includes(props.intent)) {
    return props.recordExists ? "REVOKE" : "NO_OP";
  }
  if (props.isDesired && !props.recordExists) return "GRANT";
  if (!props.isDesired && props.recordExists) return "REVOKE";
  return "NO_OP";
}

async function assignmentRecordExists(
  principalStore: PrincipalStore,
  props: ResolveAssignmentActionInput,
): Promise<boolean> {
  if (props.principalType === "USER") {
    const existing = await principalStore.getUserAssignment(
      props.principalId,
      props.leaseId,
    );
    return existing.result !== undefined;
  }
  const existing = await principalStore.getGroupAssignment(
    props.principalId,
    props.leaseId,
  );
  return existing.result !== undefined;
}

async function shouldPrincipalHaveAccess(
  leaseStore: LeaseStore,
  props: ResolveAssignmentActionInput,
): Promise<boolean> {
  // FREEZE/TERMINATE revoke all access — desired state is effectively empty,
  // so there is no need to read the lease.
  if (CRITICAL_INTENTS.includes(props.intent)) {
    return false;
  }

  const leaseResult = await leaseStore.get({
    userEmail: props.leaseOwnerEmail,
    uuid: props.leaseId,
  });
  const lease = leaseResult.result;

  if (!lease || isFrozenLease(lease) || isExpiredLease(lease)) {
    return false;
  }

  const desiredAssignments = lease.desiredAssignments ?? [];
  return desiredAssignments.some((d) => d.principalId === props.principalId);
}

/**
 * Persists the grant record to the Principal Table after a successful IDC assignment.
 * ItemAlreadyExists is treated as success (idempotent).
 */
async function persistGrantRecord(
  input: ProcessAssignmentInput,
  principalStore: PrincipalStore,
  logger: ProcessAssignmentServices["logger"],
): Promise<void> {
  const { leaseId, principalId, principalType } = input;
  const timestamp = nowAsIsoDatetimeString();
  try {
    if (principalType === "USER") {
      await principalStore.createUserAssignment({
        pk: `user#${principalId}`,
        sk: `lease#${leaseId}`,
        userId: principalId,
        principalType: "USER",
        leaseId,
        displayName: input.displayName,
        assigneeEmail: input.email ?? "", // Enriched by Processor from SQS message
        leaseOwnerEmail: input.leaseOwnerEmail ?? "",
        accountId: input.accountId,
        permissionSetArn: input.permissionSetArn,
        addedBy: input.requestedBy ?? "",
        addedDate: timestamp,
        meta: {
          createdTime: timestamp,
          lastEditTime: timestamp,
          schemaVersion: 1,
        },
      });
    } else {
      await principalStore.createGroupAssignment({
        pk: `group#${principalId}`,
        sk: `lease#${leaseId}`,
        leaseId,
        groupId: principalId,
        principalType: "GROUP",
        displayName: input.displayName ?? principalId,
        leaseOwnerEmail: input.leaseOwnerEmail ?? "",
        accountId: input.accountId,
        permissionSetArn: input.permissionSetArn,
        addedBy: input.requestedBy ?? "",
        addedDate: timestamp,
        meta: {
          createdTime: timestamp,
          lastEditTime: timestamp,
          schemaVersion: 1,
        },
      });
    }
  } catch (error: unknown) {
    // ItemAlreadyExists means the record exists — that's fine (idempotent).
    if (error instanceof ItemAlreadyExists) {
      logger.info("Assignment record already exists (idempotent success)", {
        leaseId,
        principalId,
      });
    } else {
      throw error;
    }
  }
}

/**
 * Processes a single IDC assignment operation.
 *
 * - GRANT: calls CreateAccountAssignment, then writes assignment record to Principal Table
 * - REVOKE: calls DeleteAccountAssignment, then deletes the assignment record from Principal Table
 *
 * @throws on IDC API failure (caller reports failure to Step Function)
 */
export async function processAssignment(
  input: ProcessAssignmentInput,
  context: ProcessAssignmentServices,
): Promise<ProcessAssignmentResult> {
  const { leaseId, action, principalId, principalType } = input;
  const { principalStore, ssoAdminClient, idcStackConfigStore, logger } =
    context;

  if (action === "GRANT") {
    await executeGrant(input, ssoAdminClient, idcStackConfigStore);
    logger.info("IDC CreateAccountAssignment succeeded", {
      leaseId,
      principalId,
      principalType,
    });

    // After IDC success, write the record to Principal Table.
    // ItemAlreadyExists is treated as success (idempotent).
    await persistGrantRecord(input, principalStore, logger);
  } else {
    await executeRevoke(
      input,
      ssoAdminClient,
      idcStackConfigStore,
      principalStore,
    );
    logger.info("IDC DeleteAccountAssignment succeeded, record removed", {
      leaseId,
      principalId,
      principalType,
    });
    // Record deleted by executeRevoke
  }

  return { status: "SUCCEEDED", principalId, principalType, action };
}

/**
 * Enriches desired assignments with displayName and email from the principal cache.
 * Uses a read-through strategy: batch cache check first, then JIT-resolves any
 * misses via IDC (when idcService is provided) and writes them through to cache.
 * Hard-fails if a required field is still missing after resolution.
 */
export async function enrichDesiredAssignments(
  assignments: DesiredAssignment[],
  services: EnrichDesiredAssignmentsServices,
): Promise<EnrichedAssignment[]> {
  if (assignments.length === 0) return [];

  const { principalStore, idcService, logger } = services;

  // 1. Batch cache check
  const cacheItems = await principalStore.batchGetCacheItems(
    assignments.map((a) => ({
      principalId: a.principalId,
      principalType: a.principalType,
    })),
  );

  const cacheMap = new Map(
    cacheItems.map((item) => [
      item.principalId,
      { email: item.email, displayName: item.displayName },
    ]),
  );

  // 2. Identify cache misses and JIT-resolve via IDC (parallel)
  const misses = assignments.filter((a) => !cacheMap.has(a.principalId));

  const resolved = await Promise.all(
    misses.map((miss) =>
      idcService.getCachedPrincipalById(
        miss.principalType,
        miss.principalId,
        principalStore,
        logger,
      ),
    ),
  );

  for (const principal of resolved) {
    if (principal) {
      cacheMap.set(principal.principalId, {
        email: principal.email,
        displayName: principal.displayName,
      });
    }
  }

  // 3. Enrich assignments from the (now-populated) cache map
  return assignments.map((a) => {
    const cached = cacheMap.get(a.principalId);
    if (a.principalType === "USER" && !cached?.email) {
      throw new Error(
        `Principal cache missing email for user ${a.principalId}`,
      );
    }
    if (a.principalType === "GROUP" && !cached) {
      throw new Error(
        `Principal cache missing entry for group ${a.principalId}`,
      );
    }
    // The assertion narrows the union literal (principalType: "USER" | "GROUP")
    // to the discriminated EnrichedAssignment type; TypeScript cannot infer this
    // from conditional spreads alone.
    return {
      principalId: a.principalId,
      principalType: a.principalType,
      ...(cached?.email ? { email: cached.email } : {}),
      ...(cached?.displayName ? { displayName: cached.displayName } : {}),
    } as EnrichedAssignment; // NOSONAR
  });
}

/**
 * Validates that the total number of assignments (including the owner)
 * does not exceed MAX_ASSIGNMENTS.
 */
export function validateAssignmentCount(
  assignments: Array<{ principalType: string; email?: string }>,
): void {
  if (assignments.length > MAX_ASSIGNMENTS) {
    throw new MaxAssignmentsExceededError(
      `Maximum of ${MAX_ASSIGNMENTS} total assignments allowed.`,
    );
  }
}

async function executeGrant(
  input: ProcessAssignmentInput,
  ssoAdminClient: SSOAdminClient,
  idcStackConfigStore: IdcStackConfigStore,
): Promise<void> {
  const config = await idcStackConfigStore.get();
  await ssoAdminClient.send(
    new CreateAccountAssignmentCommand({
      InstanceArn: config.ssoInstanceArn,
      PermissionSetArn: input.permissionSetArn,
      PrincipalId: input.principalId,
      PrincipalType: input.principalType,
      TargetId: input.accountId,
      TargetType: TargetType.AWS_ACCOUNT,
    }),
  );
}

async function executeRevoke(
  input: ProcessAssignmentInput,
  ssoAdminClient: SSOAdminClient,
  idcStackConfigStore: IdcStackConfigStore,
  principalStore: PrincipalStore,
): Promise<void> {
  const config = await idcStackConfigStore.get();

  // Treat ResourceNotFoundException as idempotent success —
  // the assignment was already removed (e.g. by a concurrent revocation).
  await ssoAdminClient
    .send(
      new DeleteAccountAssignmentCommand({
        InstanceArn: config.ssoInstanceArn,
        PermissionSetArn: input.permissionSetArn,
        PrincipalId: input.principalId,
        PrincipalType: input.principalType,
        TargetId: input.accountId,
        TargetType: TargetType.AWS_ACCOUNT,
      }),
    )
    .catch((error: unknown) => {
      if (error instanceof ResourceNotFoundException) {
        return undefined;
      }
      throw error;
    });

  if (input.principalType === "USER") {
    await principalStore.deleteUserAssignment(input.principalId, input.leaseId);
  } else {
    await principalStore.deleteGroupAssignment(
      input.principalId,
      input.leaseId,
    );
  }
}

const DEFAULT_LEASES_FOR_USER_PAGE_SIZE = 50;

/** DIRECT shared leases — native DynamoDB pagination on `pk = user#<id>`. */
export async function getLeasesForUserDirect(
  props: GetLeasesForUserProps,
  services: GetLeasesForUserDirectServices,
): Promise<PaginatedQueryResult<SharedLease>> {
  const {
    userId,
    pageIdentifier,
    pageSize = DEFAULT_LEASES_FOR_USER_PAGE_SIZE,
  } = props;
  const { leaseStore, principalStore, logger } = services;

  if (pageSize <= 0) {
    throw new Error(`pageSize must be > 0, got ${pageSize}`);
  }

  const queryResult = await principalStore.getDirectAssignmentsForUser({
    userId,
    pageIdentifier,
    pageSize,
  });

  const sharedLeases = await fetchAndShapeSharedLeases(
    queryResult.result.map((a) => ({
      key: { userEmail: a.leaseOwnerEmail, uuid: a.leaseId },
      accessType: "direct" as const,
    })),
    leaseStore,
    logger,
  );

  return {
    result: sharedLeases,
    nextPageIdentifier: queryResult.nextPageIdentifier,
  };
}

interface GroupSharedLeaseEntry {
  key: LeaseKey;
  displayName: string;
}

/**
 * GROUP shared leases — `Scan` `GroupIndex` GSI + filter + `BatchGetItem`
 * hydration. Three DynamoDB calls regardless of how many groups the user
 * belongs to. Cross-group dedup is in-memory; alphabetically first
 * `groupId` wins.
 */
export async function getLeasesForUserViaGroups(
  props: GetLeasesForUserProps,
  services: GetLeasesForUserViaGroupsServices,
): Promise<PaginatedQueryResult<SharedLease>> {
  const {
    userId,
    pageIdentifier,
    pageSize = DEFAULT_LEASES_FOR_USER_PAGE_SIZE,
  } = props;
  const { leaseStore, principalStore, logger } = services;

  if (pageSize <= 0) {
    throw new Error(`pageSize must be > 0, got ${pageSize}`);
  }

  const lastKey = pageIdentifier
    ? (base64DecodeCompositeKey(pageIdentifier) as LeaseKey | undefined)
    : undefined;

  // 1. Resolve user's group memberships.
  const userGroupIds = await getGroupMemberships(userId, services);
  const userGroupSet = new Set(userGroupIds);

  // 2. Single Scan on the sparse GroupIndex GSI returns all
  //    (groupId, leaseId) pairs table-wide.
  const allKeys = await principalStore.getAllGroupAssignmentKeys();

  // 3. Filter in memory to keys for groups the user belongs to.
  const matchingKeys = allKeys.filter((k) => userGroupSet.has(k.groupId));

  // 4. Single BatchGetItem hydrates the matching assignment records.
  //    Empty input is short-circuited by the store.
  const allGroupAssignments =
    await principalStore.batchGetGroupAssignments(matchingKeys);

  // 5. Sort by groupId so that cross-group duplicates resolve
  //    deterministically (alphabetically first group wins).
  allGroupAssignments.sort((a, b) =>
    a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0,
  );
  const dedupedByLease = new Map<string, GroupSharedLeaseEntry>();
  for (const a of allGroupAssignments) {
    const key: LeaseKey = { userEmail: a.leaseOwnerEmail, uuid: a.leaseId };
    const mapKey = JSON.stringify([key.userEmail, key.uuid]);
    if (!dedupedByLease.has(mapKey)) {
      dedupedByLease.set(mapKey, { key, displayName: a.displayName });
    }
  }

  // 6. Stable order for pagination.
  const entries = Array.from(dedupedByLease.values()).sort((a, b) =>
    compareLeaseKeys(a.key, b.key),
  );

  logger.debug("Group-based shared leases discovery", {
    userId,
    userGroupCount: userGroupIds.length,
    rawAssignmentCount: allGroupAssignments.length,
    dedupedLeaseCount: entries.length,
  });

  // 7. Apply in-memory pagination. The cursor is "strictly greater than"
  //    semantics: if the cursor lease has been deleted between pages, we
  //    advance to the next entry in sort order rather than restarting.
  const startIndex = resolveGroupSharedLeasePageStart(entries, lastKey);
  const pageEntries = entries.slice(startIndex, startIndex + pageSize);
  const nextStartIndex = startIndex + pageEntries.length;
  const lastPagedEntry = pageEntries.at(-1);
  const nextPageIdentifier =
    nextStartIndex < entries.length && lastPagedEntry !== undefined
      ? base64EncodeCompositeKey(lastPagedEntry.key)
      : null;

  // 8. BatchGet lease details for the current page only. Empty input is
  //    short-circuited by the helper.
  const sharedLeases = await fetchAndShapeSharedLeases(
    pageEntries.map((e) => ({
      key: e.key,
      accessType: "group" as const,
      sourceGroupName: e.displayName,
    })),
    leaseStore,
    logger,
  );

  return { result: sharedLeases, nextPageIdentifier };
}

interface SharedLeaseInput {
  key: LeaseKey;
  accessType: SharedLeaseAccessType;
  sourceGroupName?: string;
}

async function fetchAndShapeSharedLeases(
  inputs: SharedLeaseInput[],
  leaseStore: GetLeasesForUserDirectServices["leaseStore"],
  logger: GetLeasesForUserDirectServices["logger"],
): Promise<SharedLease[]> {
  if (inputs.length === 0) return [];

  const leases = await leaseStore.batchGet(inputs.map((i) => i.key));
  const leasesByKey = new Map(
    leases.map((l) => [JSON.stringify([l.userEmail, l.uuid]), l] as const),
  );

  const result: SharedLease[] = [];
  for (const input of inputs) {
    const lease = leasesByKey.get(
      JSON.stringify([input.key.userEmail, input.key.uuid]),
    );
    if (!lease) {
      logger.warn("Shared lease assignment refers to a missing lease record", {
        uuid: input.key.uuid,
        accessType: input.accessType,
      });
      continue;
    }
    result.push({
      ...lease,
      accessType: input.accessType,
      ...(input.sourceGroupName !== undefined
        ? { sourceGroupName: input.sourceGroupName }
        : {}),
    });
  }
  return result;
}

function compareLeaseKeys(a: LeaseKey, b: LeaseKey): number {
  if (a.userEmail !== b.userEmail) {
    return a.userEmail < b.userEmail ? -1 : 1;
  }
  if (a.uuid === b.uuid) return 0;
  return a.uuid < b.uuid ? -1 : 1;
}

/**
 * Index of the first entry strictly after `lastKey`, or `entries.length`
 * if none. Strictly-greater-than semantics keeps pagination correct even
 * when the cursor lease has been deleted between pages.
 */
function resolveGroupSharedLeasePageStart(
  entries: GroupSharedLeaseEntry[],
  lastKey: LeaseKey | undefined,
): number {
  if (!lastKey) return 0;
  const firstAfterCursor = entries.findIndex(
    (e) => compareLeaseKeys(e.key, lastKey) > 0,
  );
  return firstAfterCursor === -1 ? entries.length : firstAfterCursor;
}
