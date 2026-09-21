// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Leases typed adapter over the generated aggregate `IsbClient`. The shared
// transport (signed client, CloudFront handler, JSend error normalization) lives
// in `helpers/isbApiClient`; this file is only the domain-specific command calls
// and input/output mappers. Every migrated domain follows the same shape.
//
// Unlike leaseTemplates there is NO Date<->ISO conversion here: lease timestamps
// (startDate, expirationDate, meta.createdTime, resourceLock.expiresAt, ...) are
// modeled as raw `String` (deviation #3), so the wire strings deserialize
// untouched. Explicit mappers keep generated-member drift visible; frontend
// schemas validate single-item reads and filter malformed entries from lists.

import { HttpRequest } from "@smithy/core/protocols";

import type {
  AssignmentView,
  LeaseAssignmentsView,
  LeaseWithId,
  SharedLease,
  UpdateLeaseAssignmentsResult,
} from "@amzn/innovation-sandbox-api-client";
import {
  FreezeLeaseCommand,
  GetLeaseAssignmentsCommand,
  GetLeaseCommand,
  IsbClient,
  ListLeasesCommand,
  ListSharedLeasesCommand,
  RequestLeaseCommand,
  ReviewLeaseCommand,
  TerminateLeaseCommand,
  UnfreezeLeaseCommand,
  UpdateLeaseAssignmentsCommand,
  UpdateLeaseCommand,
} from "@amzn/innovation-sandbox-api-client";
import {
  GetLeaseAssignmentsResponse,
  GetLeaseAssignmentsResponseSchema,
  LeaseView,
  LeaseViewSchema,
  SharedLeaseView,
  SharedLeaseViewSchema,
  UpdateLeaseAssignmentsResponse,
  UpdateLeaseAssignmentsResponseSchema,
} from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import {
  AssignmentPrincipalRef,
  LeasePatchRequest,
  NewLeaseRequest,
} from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { ApiPaginatedResult } from "@amzn/innovation-sandbox-frontend/types";

import { normalizeSmithyError } from "../../helpers/isbApiClient";
import { toValidListItems } from "../../helpers/validListItems";

// The access types the shared-lease QUERY endpoint actually accepts. The server
// (and the modeled `SharedLeaseAccessType` enum) only ever receives `direct` or
// `group`; the wider frontend `SharedLeaseAccessType`
// (`direct|group|owner|global`) exists solely for display components
// (AccessTypeBadge, the lease table), and its extra values are never routed to
// this endpoint. Narrowing the query param to this type removes the need for an
// `as` cast onto the generated command's input.
export type SharedLeaseQueryAccessType = "direct" | "group";

// Domain-scoped name for the shared signed-client factory.
export { createIsbClient as createLeaseClient } from "../../helpers/isbApiClient";

export interface SmithyLeaseApi {
  listLeases(
    pageIdentifier?: string,
    userEmail?: string,
  ): Promise<ApiPaginatedResult<LeaseView>>;
  getLease(leaseId: string): Promise<LeaseView>;
  requestLease(request: NewLeaseRequest): Promise<void>;
  updateLease(request: LeasePatchRequest): Promise<void>;
  reviewLease(leaseId: string, approve: boolean): Promise<void>;
  terminateLease(leaseId: string): Promise<void>;
  freezeLease(leaseId: string): Promise<void>;
  unfreezeLease(leaseId: string): Promise<void>;
  getAssignments(leaseId: string): Promise<GetLeaseAssignmentsResponse>;
  updateAssignments(
    leaseId: string,
    assignments: AssignmentPrincipalRef[],
  ): Promise<UpdateLeaseAssignmentsResponse>;
  listSharedLeases(
    userId: string,
    accessType: SharedLeaseQueryAccessType,
    maxResults: number,
    pageIdentifier?: string,
  ): Promise<ApiPaginatedResult<SharedLeaseView>>;
}

/**
 * Re-adds explicitly-cleared members as `null` to an already-serialized restJson1
 * request body. The serializer omits null members, but `UpdateLease`'s edit forms
 * use `null` to CLEAR maxSpend/expirationDate/costReportGroup (vs. an absent member
 * = leave unchanged), so `updateLease` restores them via a build-step middleware
 * before signing. `serializedBody` is the serializer's output; `@aws-sdk/core`'s
 * codec-v2 (`JsonCodec2`) hands it back as a `Uint8Array`, while older codecs used a
 * `string`, so decode both. An undefined/empty body is treated as `{}` (the command
 * carried no serializable members). Any other, non-empty body type throws rather
 * than silently starting from `{}` — otherwise a future codec change would again
 * drop the serializer's members and send only the null clears. Returns the
 * re-serialized body with each named member set to `null`. Exported for unit testing.
 */
export function reinjectNullMembers(
  serializedBody: unknown,
  members: string[],
): string {
  let text: string;
  if (serializedBody == null) {
    text = "";
  } else if (typeof serializedBody === "string") {
    text = serializedBody;
  } else if (ArrayBuffer.isView(serializedBody)) {
    // Realm-agnostic Uint8Array check (@aws-sdk/core codec-v2 bytes); `instanceof`
    // is unreliable across module/JS realms.
    text = new TextDecoder().decode(serializedBody);
  } else {
    throw new TypeError(
      `reinjectNullMembers: unsupported request body type "${typeof serializedBody}"`,
    );
  }
  const body =
    text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
  for (const member of members) {
    body[member] = null;
  }
  return JSON.stringify(body);
}

function mapLease(lease: LeaseWithId) {
  // Keep every generated member explicit so additions to the Smithy response
  // cannot be silently dropped at the frontend boundary.
  return {
    userEmail: lease.userEmail,
    uuid: lease.uuid,
    status: lease.status,
    originalLeaseTemplateUuid: lease.originalLeaseTemplateUuid,
    originalLeaseTemplateName: lease.originalLeaseTemplateName,
    comments: lease.comments,
    createdBy: lease.createdBy,
    blueprintId: lease.blueprintId,
    blueprintName: lease.blueprintName,
    allowOwnerToShareLease: lease.allowOwnerToShareLease,
    desiredAssignments: lease.desiredAssignments,
    resourceLock: lease.resourceLock,
    maxSpend: lease.maxSpend,
    budgetThresholds: lease.budgetThresholds,
    leaseDurationInHours: lease.leaseDurationInHours,
    durationThresholds: lease.durationThresholds,
    costReportGroup: lease.costReportGroup,
    meta: lease.meta,
    awsAccountId: lease.awsAccountId,
    approvedBy: lease.approvedBy,
    startDate: lease.startDate,
    expirationDate: lease.expirationDate,
    lastCheckedDate: lease.lastCheckedDate,
    totalCostAccrued: lease.totalCostAccrued,
    endDate: lease.endDate,
    ttl: lease.ttl,
    leaseId: lease.leaseId,
  } satisfies Record<keyof LeaseWithId, unknown>;
}

function mapSharedLease(lease: SharedLease) {
  return {
    ...mapLease(lease),
    accessType: lease.accessType,
    sourceGroupName: lease.sourceGroupName,
  } satisfies Record<keyof SharedLease, unknown>;
}

function mapAssignment(assignment: AssignmentView) {
  return {
    principalId: assignment.principalId,
    principalType: assignment.principalType,
    assigneeEmail: assignment.assigneeEmail,
    displayName: assignment.displayName,
    addedBy: assignment.addedBy,
    addedDate: assignment.addedDate,
    isOwner: assignment.isOwner,
    isDesired: assignment.isDesired,
    syncStatus: assignment.syncStatus,
  } satisfies Record<keyof AssignmentView, unknown>;
}

function mapLeaseAssignments(assignments: LeaseAssignmentsView) {
  return {
    assignments: assignments.assignments?.map(mapAssignment),
    operationInProgress: assignments.operationInProgress,
  } satisfies Record<keyof LeaseAssignmentsView, unknown>;
}

function mapUpdateAssignments(result: UpdateLeaseAssignmentsResult) {
  return {
    desiredCount: result.desiredCount,
  } satisfies Record<keyof UpdateLeaseAssignmentsResult, unknown>;
}

export class SmithyLeaseClient implements SmithyLeaseApi {
  constructor(private readonly client: IsbClient) {}

  async listLeases(
    pageIdentifier?: string,
    userEmail?: string,
  ): Promise<ApiPaginatedResult<LeaseView>> {
    try {
      const output = await this.client.send(
        new ListLeasesCommand({ pageIdentifier, userEmail }),
      );
      // A missing page is not equivalent to a valid empty result. Validate
      // members independently so one malformed lease does not hide the rest.
      if (!output.data?.result) {
        throw new Error("Leases list response did not contain data");
      }
      return {
        result: toValidListItems({
          clientName: "SmithyLeaseClient",
          getItemId: (lease) => lease.leaseId ?? lease.uuid,
          items: output.data.result,
          itemType: "lease",
          mapItem: mapLease,
          schema: LeaseViewSchema,
        }),
        nextPageIdentifier: output.data.nextPageIdentifier ?? null,
      };
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async getLease(leaseId: string): Promise<LeaseView> {
    try {
      const output = await this.client.send(new GetLeaseCommand({ leaseId }));
      // The handler returns 404 for a missing lease, and pre-Smithy
      // `ApiProxy.get` threw `ApiError` on that 404. Validate a successful
      // response so malformed data cannot enter frontend state.
      if (!output.data) {
        throw new Error("Lease response did not contain data");
      }
      return LeaseViewSchema.parse(mapLease(output.data));
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async requestLease(request: NewLeaseRequest): Promise<void> {
    try {
      await this.client.send(
        new RequestLeaseCommand({
          leaseTemplateUuid: request.leaseTemplateUuid,
          comments: request.comments,
          userEmail: request.userEmail,
          assignments: request.assignments,
        }),
      );
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async updateLease(request: LeasePatchRequest): Promise<void> {
    const { leaseId, ...rest } = request;
    // The edit forms send an explicit `null` to CLEAR
    // maxSpend/expirationDate/costReportGroup (vs. an absent member = leave
    // unchanged); the server's Zod re-parse reads a body `null` as clear. The
    // generated `restJson1` serializer OMITS null members, so it cannot carry the
    // clear signal on its own. Rather than delegate to `ApiProxy` (retired once
    // every domain is migrated), send the present (non-null) members through the
    // generated `UpdateLeaseCommand` as usual and re-inject the cleared members as
    // `null` into the serialized body (via `reinjectNullMembers`) with a
    // `build`-step middleware — the one restJson1-inexpressible bit. `build` runs
    // after serialization and before SigV4 signing (`finalizeRequest`), so the
    // signature covers the re-injected body. The result reproduces the pre-Smithy
    // wire (`{ ...rest }` with nulls preserved) byte-faithfully while keeping the
    // operation on the generated client. (Revisit if the clear-semantics are
    // redesigned to a serializable form — see the migration docs.)
    const clearedMembers = Object.keys(rest).filter(
      (key) => rest[key as keyof typeof rest] === null,
    );

    const command = new UpdateLeaseCommand({
      leaseId,
      // `?? undefined` drops an explicit `null` here so the serializer omits it;
      // the middleware below re-adds it. An absent (`undefined`) member stays
      // absent = leave unchanged.
      maxSpend: rest.maxSpend ?? undefined,
      budgetThresholds: rest.budgetThresholds,
      expirationDate: rest.expirationDate ?? undefined,
      durationThresholds: rest.durationThresholds,
      costReportGroup: rest.costReportGroup ?? undefined,
      allowOwnerToShareLease: rest.allowOwnerToShareLease,
    });

    if (clearedMembers.length > 0) {
      command.middlewareStack.add(
        (next) => async (args) => {
          if (HttpRequest.isInstance(args.request)) {
            const body = reinjectNullMembers(args.request.body, clearedMembers);
            args.request.body = body;
            args.request.headers["content-type"] = "application/json";
            args.request.headers["content-length"] = String(
              new TextEncoder().encode(body).length,
            );
          }
          return next(args);
        },
        { step: "build", name: "reinjectClearedLeaseMembers" },
      );
    }

    try {
      await this.client.send(command);
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async reviewLease(leaseId: string, approve: boolean): Promise<void> {
    try {
      await this.client.send(
        new ReviewLeaseCommand({
          leaseId,
          action: approve ? "Approve" : "Deny",
        }),
      );
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async terminateLease(leaseId: string): Promise<void> {
    try {
      await this.client.send(new TerminateLeaseCommand({ leaseId }));
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async freezeLease(leaseId: string): Promise<void> {
    try {
      await this.client.send(new FreezeLeaseCommand({ leaseId }));
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async unfreezeLease(leaseId: string): Promise<void> {
    try {
      await this.client.send(new UnfreezeLeaseCommand({ leaseId }));
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async getAssignments(leaseId: string): Promise<GetLeaseAssignmentsResponse> {
    try {
      const output = await this.client.send(
        new GetLeaseAssignmentsCommand({ leaseId }),
      );
      // Data-bearing read: pre-Smithy returned the JSend `data` and consumers
      // dereference `assignments`, so guard a malformed success (missing `data`)
      // rather than returning `undefined`. A 404 still propagates as `ApiError`.
      if (!output.data) {
        throw new Error("Lease assignments response did not contain data");
      }
      return GetLeaseAssignmentsResponseSchema.parse(
        mapLeaseAssignments(output.data),
      );
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async updateAssignments(
    leaseId: string,
    assignments: AssignmentPrincipalRef[],
  ): Promise<UpdateLeaseAssignmentsResponse> {
    try {
      const output = await this.client.send(
        new UpdateLeaseAssignmentsCommand({ leaseId, assignments }),
      );
      if (!output.data) {
        throw new Error(
          "Update lease assignments response did not contain data",
        );
      }
      return UpdateLeaseAssignmentsResponseSchema.parse(
        mapUpdateAssignments(output.data),
      );
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async listSharedLeases(
    userId: string,
    accessType: SharedLeaseQueryAccessType,
    maxResults: number,
    pageIdentifier?: string,
  ): Promise<ApiPaginatedResult<SharedLeaseView>> {
    try {
      const output = await this.client.send(
        new ListSharedLeasesCommand({
          userId,
          // `accessType` is narrowed to `direct|group` — exactly the modeled
          // `SharedLeaseAccessType` enum the server accepts — so it flows into the
          // generated command's input without a cast. (The wider frontend
          // `SharedLeaseAccessType` is display-only and never reaches here.)
          accessType,
          maxResults,
          pageIdentifier,
        }),
      );
      if (!output.data?.result) {
        throw new Error("Shared leases response did not contain data");
      }
      return {
        result: toValidListItems({
          clientName: "SmithyLeaseClient",
          getItemId: (lease) => lease.leaseId ?? lease.uuid,
          items: output.data.result,
          itemType: "shared lease",
          mapItem: mapSharedLease,
          schema: SharedLeaseViewSchema,
        }),
        nextPageIdentifier: output.data.nextPageIdentifier ?? null,
      };
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }
}
