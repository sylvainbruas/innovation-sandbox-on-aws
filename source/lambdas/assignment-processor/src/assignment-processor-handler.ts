// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { z } from "zod";

import type { DesiredAssignmentWithDisplay } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  CriticalLockIntents,
  LeaseLockIntentSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  PrincipalTypeSchema,
  type GroupAssignment,
  type UserAssignment,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import { AssignmentCreatedEvent } from "@amzn/innovation-sandbox-commons/events/assignment-created-event.js";
import { AssignmentRemovedEvent } from "@amzn/innovation-sandbox-commons/events/assignment-removed-event.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  AssignmentProcessorEnvironment,
  AssignmentProcessorEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/assignment-processor-environment.js";
import baseMiddlewareBundle, {
  IsbLambdaContext,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { SubscribableLog } from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import {
  addCorrelationContext,
  searchableAssignmentProperties,
} from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { assertNever } from "@amzn/innovation-sandbox-commons/types/type-guards.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";

const serviceName = "AssignmentProcessor";
const tracer = new Tracer({ serviceName });
const logger = new Logger({ serviceName });

const FannedOutPrincipalSchema = z.object({
  principalId: z.string(),
  principalType: PrincipalTypeSchema,
});

const FanOutInputSchema = z.object({
  action: z.literal("FAN_OUT"),
  leaseId: z.string(),
  intent: LeaseLockIntentSchema,
  lockOwnerId: z.string(),
  leaseOwnerEmail: z.email(),
  requestedBy: z.email(),
  executionArn: z.string(),
});

const HandleCompletionInputSchema = z.object({
  action: z.literal("HANDLE_COMPLETION"),
  leaseId: z.string(),
  intent: LeaseLockIntentSchema,
  lockOwnerId: z.string(),
  leaseOwnerEmail: z.email(),
  requestedBy: z.email(),
  accountId: AwsAccountIdSchema,
  executionArn: z.string(),
  fannedOutPrincipals: z.array(FannedOutPrincipalSchema).optional(),
  preExistingPrincipalIds: z.array(z.string()).optional(),
});

const AssignmentProcessorInputSchema = z.discriminatedUnion("action", [
  FanOutInputSchema,
  HandleCompletionInputSchema,
]);

type ProcessorContext = IsbLambdaContext<AssignmentProcessorEnvironment>;

/**
 * A single principal to process, emitted by FAN_OUT for the Step Function Map state.
 * Extends the lease's desired-assignment display shape with the runtime-resolved
 * permissionSetArn so the worker doesn't need to read IDC config. A single permission
 * set is used today; per-principal permission sets can be resolved in FAN_OUT later.
 *
 * displayName and email are required strings (empty when unknown) — the Step Function
 * ItemSelector references them with `$.item.*`, which throws States.Runtime if a field
 * is absent. JSON serialization drops undefined, so these must never be undefined.
 */
type FanOutWorkItem = Omit<
  DesiredAssignmentWithDisplay,
  "displayName" | "email"
> & {
  displayName: string;
  email: string;
  permissionSetArn: string;
};

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: AssignmentProcessorEnvironmentSchema,
  moduleName: "assignment-processor",
}).handler(handleAssignmentProcessor);

/**
 * Assignment Processor Lambda — invoked by the Assignment Processor Step Function.
 *
 * Actions:
 * - FAN_OUT: Read desiredAssignments from the lease record and current assignment records
 *   from the Principal Table (LeaseIndex GSI). Union all unique principal IDs and return
 *   them for the Map state to fan out. No diff computation, no action determination —
 *   workers decide GRANT/REVOKE/NO-OP at execution time via JIT diff.
 * - HANDLE_COMPLETION: Publish AssignmentCreated/AssignmentRemoved events based on
 *   pre/post state comparison, emit OrphanedAccessDetected metric when TERMINATE intent
 *   has lingering records, then clear resourceLock on the lease record.
 *
 * Worker-exhausted assignments (after SQS maxReceiveCount) land in the DLQ for alarming
 * and manual investigation. The Step Function Map branch is unblocked either by the
 * worker calling SendTaskFailure on its last attempt or by the SendAssignmentToSQS
 * heartbeat timeout — the processor does not drain the DLQ.
 */
async function handleAssignmentProcessor(
  event: unknown,
  context: ProcessorContext,
) {
  const validatedEvent = AssignmentProcessorInputSchema.parse(event);

  switch (validatedEvent.action) {
    case "FAN_OUT":
      return handleFanOut(validatedEvent, context);
    case "HANDLE_COMPLETION":
      return handleCompletion(validatedEvent, context);
    default:
      assertNever(validatedEvent);
  }
}

async function handleFanOut(
  input: z.infer<typeof FanOutInputSchema>,
  context: ProcessorContext,
): Promise<{
  workItems: FanOutWorkItem[];
  accountId: string;
  preExistingPrincipalIds: string[];
}> {
  const { env } = context;
  const leaseStore = IsbServices.leaseStore(env);
  const principalStore = IsbServices.principalStore(env);
  const idcStackConfigStore = IsbServices.idcStackConfigStore(env);

  addCorrelationContext(
    logger,
    searchableAssignmentProperties({
      leaseId: input.leaseId,
      intent: input.intent,
    }),
  );

  logger.info("Processing FAN_OUT", {
    executionArn: input.executionArn,
  });

  const leaseResult = await leaseStore.get({
    userEmail: input.leaseOwnerEmail,
    uuid: input.leaseId,
  });

  if (!leaseResult.result) {
    throw new Error(
      `Lease not found during FAN_OUT: ${input.leaseId} (owner: ${input.leaseOwnerEmail})`,
    );
  }

  const lease = leaseResult.result;
  const desiredAssignments = lease.desiredAssignments ?? [];

  const accountId = "awsAccountId" in lease ? lease.awsAccountId : undefined;
  if (!accountId) {
    throw new Error(
      `Lease ${input.leaseId} has no awsAccountId — cannot process assignments`,
    );
  }

  const currentRecords = await principalStore.getAssignmentsForLease({
    leaseId: input.leaseId,
  });

  const { workItems, preExistingPrincipalIds } = await buildWorkItems(
    desiredAssignments,
    currentRecords.result,
    idcStackConfigStore,
  );

  logger.info("FAN_OUT complete", {
    desiredCount: desiredAssignments.length,
    currentRecordCount: currentRecords.result.length,
    workItemCount: workItems.length,
  });

  return { workItems, accountId, preExistingPrincipalIds };
}

async function handleCompletion(
  input: z.infer<typeof HandleCompletionInputSchema>,
  context: ProcessorContext,
): Promise<{ status: string; eventsPublished: number }> {
  const { env } = context;
  const leaseStore = IsbServices.leaseStore(env);
  const principalStore = IsbServices.principalStore(env);
  const eventBridgeClient = IsbServices.isbEventBridge(env);

  addCorrelationContext(
    logger,
    searchableAssignmentProperties({
      leaseId: input.leaseId,
      intent: input.intent,
      accountId: input.accountId,
    }),
  );

  logger.info("Processing HANDLE_COMPLETION", {
    executionArn: input.executionArn,
    lockOwnerId: input.lockOwnerId,
  });

  try {
    // Read lease to get desiredAssignments
    const leaseResult = await leaseStore.get({
      userEmail: input.leaseOwnerEmail,
      uuid: input.leaseId,
    });

    const desiredAssignments = leaseResult.result?.desiredAssignments ?? [];
    // For critical intents (TERMINATE/FREEZE), desired state is effectively empty —
    // all access should be revoked regardless of what desiredAssignments contains.
    // This mirrors the worker's JIT diff behavior (shouldPrincipalHaveAccess returns
    // false for critical intents) and prevents stale desiredAssignments from poisoning
    // the completion metric (which would otherwise classify successful revocations as
    // "failed grants" because principals remain in stale desiredAssignments).
    const isCriticalIntent = (
      CriticalLockIntents as readonly string[]
    ).includes(input.intent);
    const desiredPrincipalIds = new Set(
      isCriticalIntent ? [] : desiredAssignments.map((d) => d.principalId),
    );

    // Read current assignment records (post-processing state)
    const currentRecords = await principalStore.getAssignmentsForLease({
      leaseId: input.leaseId,
    });

    const currentPrincipalIds = new Set(
      currentRecords.result.map((r) =>
        r.principalType === "USER" ? r.userId : r.groupId,
      ),
    );

    // Derive events: only emit for principals that were actually processed in this execution
    const fannedOutIds = new Set(
      (input.fannedOutPrincipals ?? []).map((p) => p.principalId),
    );
    const preExistingIds = new Set(input.preExistingPrincipalIds ?? []);

    // AssignmentCreated: was fanned out, is in desired, has a record, AND was NOT pre-existing
    const createdEvents = currentRecords.result
      .filter((record) => {
        const principalId =
          record.principalType === "USER" ? record.userId : record.groupId;
        return (
          fannedOutIds.has(principalId) &&
          desiredPrincipalIds.has(principalId) &&
          !preExistingIds.has(principalId)
        );
      })
      .map((record) => {
        const principalId =
          record.principalType === "USER" ? record.userId : record.groupId;
        return new AssignmentCreatedEvent({
          leaseId: input.leaseId,
          principalId,
          principalType: record.principalType,
          assigneeEmail:
            record.principalType === "USER" ? record.assigneeEmail : undefined,
          accountId: input.accountId,
          addedBy: input.requestedBy,
          leaseOwner: input.leaseOwnerEmail,
        });
      });

    // AssignmentRemoved: was fanned out, NOT in desired, AND no longer has a record (confirmed revoke)
    const removedEvents = (input.fannedOutPrincipals ?? [])
      .filter(
        (p) =>
          !currentPrincipalIds.has(p.principalId) &&
          !desiredPrincipalIds.has(p.principalId),
      )
      .map(
        (p) =>
          new AssignmentRemovedEvent({
            leaseId: input.leaseId,
            principalId: p.principalId,
            principalType: p.principalType,
            accountId: input.accountId,
            removedBy: input.requestedBy,
            leaseOwner: input.leaseOwnerEmail,
          }),
      );

    const events = [...createdEvents, ...removedEvents];

    // Publish events
    if (events.length > 0) {
      await eventBridgeClient.sendIsbEvents(tracer, ...events);
      logger.info("Completion events published", {
        created: createdEvents.length,
        removed: removedEvents.length,
      });
    } else {
      logger.info("No completion events to publish (no state changes)");
    }

    emitCompletionMetrics({
      input,
      desiredPrincipalIds,
      currentPrincipalIds,
    });

    return { status: "SUCCESS", eventsPublished: events.length };
  } finally {
    // Always release lock — even if event publishing or DAO operations above throw.
    // releaseLock failure is non-fatal; the lease self-heals via the lock TTL.
    await leaseStore
      .releaseLock({
        leaseId: input.leaseId,
        userEmail: input.leaseOwnerEmail,
        ownerId: input.lockOwnerId,
      })
      .then(() => {
        logger.info("Resource lock cleared", {
          lockOwnerId: input.lockOwnerId,
        });
      })
      .catch((error: unknown) => {
        logger.error("Failed to clear resource lock (non-fatal)", {
          lockOwnerId: input.lockOwnerId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
}

/**
 * Maps a current assignment record to an enriched work item, resolving the
 * USER/GROUP-specific principal id and denormalized display fields.
 */
function recordToWorkItem(
  record: UserAssignment | GroupAssignment,
  permissionSetArn: string,
): FanOutWorkItem {
  const principalId =
    record.principalType === "USER" ? record.userId : record.groupId;
  return {
    principalId,
    principalType: record.principalType,
    displayName:
      record.principalType === "USER"
        ? (record.displayName ?? record.assigneeEmail)
        : record.displayName,
    email: record.principalType === "USER" ? record.assigneeEmail : "",
    permissionSetArn,
  };
}

/**
 * Unions desired + current principal IDs into enriched work items for the Map state.
 * Desired is iterated first so its displayName/email take precedence over the
 * record's denormalized values (they come from the principal cache at request time
 * and are more authoritative than the record's assigneeEmail).
 */
async function buildWorkItems(
  desiredAssignments: Array<{
    principalId: string;
    principalType: string;
    displayName?: string;
    email?: string;
  }>,
  currentRecords: Array<UserAssignment | GroupAssignment>,
  idcStackConfigStore: { get: () => Promise<{ userPermissionSetArn: string }> },
): Promise<{ workItems: FanOutWorkItem[]; preExistingPrincipalIds: string[] }> {
  // Nothing to process — skip the IDC config SSM read.
  if (desiredAssignments.length === 0 && currentRecords.length === 0) {
    return { workItems: [], preExistingPrincipalIds: [] };
  }

  const idcConfig = await idcStackConfigStore.get();
  const permissionSetArn = idcConfig.userPermissionSetArn;

  const principalMap = new Map<string, FanOutWorkItem>();

  for (const desired of desiredAssignments) {
    if (!principalMap.has(desired.principalId)) {
      principalMap.set(desired.principalId, {
        principalId: desired.principalId,
        principalType: desired.principalType as "USER" | "GROUP",
        displayName: desired.displayName ?? "",
        email: desired.email ?? "",
        permissionSetArn,
      });
    }
  }

  for (const record of currentRecords) {
    const workItem = recordToWorkItem(record, permissionSetArn);
    if (!principalMap.has(workItem.principalId)) {
      principalMap.set(workItem.principalId, workItem);
    }
  }

  const workItems = Array.from(principalMap.values());
  const preExistingPrincipalIds = currentRecords.map((r) =>
    r.principalType === "USER" ? r.userId : r.groupId,
  );

  return { workItems, preExistingPrincipalIds };
}

/**
 * Emits completion metrics for the assignment execution. Called once per
 * Step Function run from HANDLE_COMPLETION.
 */
function emitCompletionMetrics(props: {
  input: z.infer<typeof HandleCompletionInputSchema>;
  desiredPrincipalIds: Set<string>;
  currentPrincipalIds: Set<string>;
}): void {
  const { input, desiredPrincipalIds, currentPrincipalIds } = props;
  const fannedOut = input.fannedOutPrincipals ?? [];
  const principalsProcessed = fannedOut.length;

  if (principalsProcessed > 0) {
    // Failed = post-processing state doesn't match desired
    const failed = fannedOut.filter((p) => {
      const inDesired = desiredPrincipalIds.has(p.principalId);
      const hasRecord = currentPrincipalIds.has(p.principalId);
      // Wanted but no record = failed grant; not wanted but has record = failed revoke
      return inDesired !== hasRecord;
    }).length;

    logger.info("Assignment execution completed", {
      logDetailType: "AssignmentExecutionCompleted",
      leaseId: input.leaseId,
      accountId: input.accountId,
      intent: input.intent,
      principalsProcessed,
      succeeded: principalsProcessed - failed,
      failed,
    } satisfies SubscribableLog);
  }
}
