// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Member parity between the lease persistence schemas (Zod) and the Smithy model.
 * See `README.md` for what this guards and the accepted-deviations pattern.
 *
 * The persisted `Lease` is a Zod discriminatedUnion (Pending / ApprovalDenied /
 * Monitored / Expired). Smithy cannot express per-variant requiredness, so the
 * wire `Lease` is modeled as the UNION of every variant's members with ONLY the
 * always-present intersection `@required` (the flattened-requiredness deviation).
 * These tests assert exactly that shape and document the deviation.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  PersistedApprovalDeniedLeaseSchema,
  PersistedExpiredLeaseSchema,
  PersistedMonitoredLeaseSchema,
  PersistedPendingLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { AssignmentSyncStatusSchema } from "@amzn/innovation-sandbox-commons/isb-services/lease-assignment/lease-assignment.types.js";
import {
  AllLeaseStatusSchema,
  DesiredAssignmentSchema,
  DesiredAssignmentWithDisplaySchema,
  LeaseLockIntentSchema,
  LeaseLockMetaSchema,
  LeaseResourceLockSchema,
  MAX_USER_MANAGED_ASSIGNMENTS,
} from "@amzn/innovation-sandbox-shared/types/lease.js";

import {
  alwaysPresentOnOutput,
  expectMemberTypeParity,
  modelEnum,
  modelHttpOperation,
  modelMember,
  modelMembers,
  modelMemberTrait,
  modelRequired,
  zodMembers,
} from "./parity-helpers.js";

// The four Zod lease variants, in discriminatedUnion order.
const variantShapes = [
  PersistedPendingLeaseSchema.shape,
  PersistedApprovalDeniedLeaseSchema.shape,
  PersistedMonitoredLeaseSchema.shape,
  PersistedExpiredLeaseSchema.shape,
] as Record<string, z.ZodType>[];

// The flattened superset: the union of every variant's members. Later variants
// override earlier ones for shared members (e.g. `status`), matching how the
// Smithy superset carries one member per name.
const leaseSuperset: Record<string, z.ZodType> = Object.assign(
  {},
  ...variantShapes,
);

// The always-present intersection: members that every variant produces on output.
// This is the ONLY set the flattened `Lease` marks `@required`.
const requiredIntersection = variantShapes
  .map(alwaysPresentOnOutput)
  .reduce((acc, cur) => acc.filter((member) => cur.includes(member)));

const lockShape = LeaseResourceLockSchema.shape as Record<string, z.ZodType>;
const lockMetaShape = LeaseLockMetaSchema.shape as Record<string, z.ZodType>;
const desiredWithDisplayShape =
  DesiredAssignmentWithDisplaySchema.shape as Record<string, z.ZodType>;
const desiredShape = DesiredAssignmentSchema.shape as Record<string, z.ZodType>;

// The lease `meta` on the wire keeps the timestamps and drops `schemaVersion`.
const leaseMetaShape = (
  PersistedPendingLeaseSchema.shape.meta as unknown as { unwrap(): z.ZodObject }
).unwrap().shape as Record<string, z.ZodType>;

describe("Lease model parity", () => {
  it("Lease projects the union of every variant's members (flattened superset)", () => {
    expect(modelMembers("Lease")).toEqual(zodMembers(leaseSuperset));
  });

  it("Lease requires ONLY the always-present intersection (flattened requiredness)", () => {
    // Documents accepted deviation #1: status-conditional requiredness is lost;
    // only members present-and-required in ALL four variants stay `@required`.
    expect(modelRequired("Lease")).toEqual([...requiredIntersection].sort());
    // Pin the intersection so a schema change that widens/narrows it is caught.
    expect(modelRequired("Lease")).toEqual([
      "originalLeaseTemplateName",
      "originalLeaseTemplateUuid",
      "status",
      "userEmail",
      "uuid",
    ]);
  });

  it("matches every superset member's target type (guards silent type drift)", () => {
    // `approvedBy` is a Zod union (email | "AUTO_APPROVED") with no single
    // canonical type; the helper skips it, and it is modeled as an open String.
    // The nullable `blueprintId`/`blueprintName` also carry no comparable scalar
    // type and are skipped.
    expectMemberTypeParity("Lease", leaseSuperset);
  });

  it("LeaseWithId and SharedLease carry the full Lease superset plus their injected members", () => {
    // Both reuse the LeaseFields mixin, so requiredness stays identical, then add
    // the handler-injected members.
    expect(modelMembers("LeaseWithId")).toEqual(
      [...zodMembers(leaseSuperset), "leaseId"].sort(),
    );
    expect(modelMembers("SharedLease")).toEqual(
      [
        ...zodMembers(leaseSuperset),
        "accessType",
        "leaseId",
        "sourceGroupName",
      ].sort(),
    );
    expect(modelMember("LeaseWithId", "leaseId").target).toBe(
      "com.amazon.isb#LeaseId",
    );
    expect(modelRequired("SharedLease")).toEqual(
      [...requiredIntersection, "accessType", "leaseId"].sort(),
    );
  });

  it("ttl is a Long, not an Integer (Unix epoch seconds cross the 32-bit ceiling)", () => {
    // Model-contract pin: `ttl` is a Unix-epoch-second timestamp that crosses the
    // signed 32-bit ceiling (2,147,483,647 → Jan 2038). A regression to `Integer`
    // would silently truncate/overflow valid persisted records; pin the target so
    // that cannot happen without failing this test. See leases.smithy deviation
    // note on `ttl` and the handler round-trip test in leases-handler.test.ts.
    expect(modelMember("Lease", "ttl").target).toBe("smithy.api#Long");
  });

  it("lease metadata carries the timestamps (schemaVersion dropped)", () => {
    // Accepted deviation #2, mirroring AccountMetadata.
    expect(modelMembers("LeaseMetadata")).toEqual(
      zodMembers(leaseMetaShape).filter((m) => m !== "schemaVersion"),
    );
  });
});

describe("LeaseResourceLock model parity", () => {
  it("mirrors the persisted lock shape", () => {
    expect(modelMembers("LeaseResourceLock")).toEqual(zodMembers(lockShape));
    expect(modelRequired("LeaseResourceLock")).toEqual(
      alwaysPresentOnOutput(lockShape),
    );
  });

  it("matches the lock's member target types (meta compared separately)", () => {
    // `meta` is a typed structure (LeaseLockMeta), covered by its own test below;
    // the timestamp members are raw String (deviation #3).
    expectMemberTypeParity(
      "LeaseResourceLock",
      LeaseResourceLockSchema.omit({ meta: true }).shape as Record<
        string,
        z.ZodType
      >,
    );
  });

  it("LeaseLockMeta mirrors the typed lock meta", () => {
    expect(modelMembers("LeaseLockMeta")).toEqual(zodMembers(lockMetaShape));
    expect(modelRequired("LeaseLockMeta")).toEqual(
      alwaysPresentOnOutput(lockMetaShape),
    );
    expect(modelMember("LeaseLockMeta", "intent").target).toBe(
      "com.amazon.isb#LeaseLockIntent",
    );
  });
});

describe("assignment shapes", () => {
  it("DesiredAssignmentWithDisplay mirrors the persisted desired assignment", () => {
    expect(modelMembers("DesiredAssignmentWithDisplay")).toEqual(
      zodMembers(desiredWithDisplayShape),
    );
    expect(modelRequired("DesiredAssignmentWithDisplay")).toEqual(
      alwaysPresentOnOutput(desiredWithDisplayShape),
    );
    expect(
      modelMember("DesiredAssignmentWithDisplay", "principalType").target,
    ).toBe("com.amazon.isb#PrincipalType");
  });

  it("DesiredAssignment (request body) mirrors the caller-supplied shape", () => {
    expect(modelMembers("DesiredAssignment")).toEqual(zodMembers(desiredShape));
    expect(modelRequired("DesiredAssignment")).toEqual(
      alwaysPresentOnOutput(desiredShape),
    );
  });
});

describe("assignment view shapes (TS-interface-only contracts, no Zod schema)", () => {
  // `AssignmentView` and `LeaseAssignmentsView` correspond to the TypeScript
  // interfaces in `common/isb-services/lease-assignment/lease-assignment.types.ts`
  // (`AssignmentView` / `LeaseAssignmentsView`), which have NO runtime Zod schema.
  // The expected member sets are therefore hardcoded here (not derived from a
  // schema); these guard Smithy-model drift only — a divergence between the TS
  // interface and the model would not be caught at runtime (see README).
  it("AssignmentView pins the reconciliation-row member set", () => {
    expect(modelMembers("AssignmentView")).toEqual([
      "addedBy",
      "addedDate",
      "assigneeEmail",
      "displayName",
      "isDesired",
      "isOwner",
      "principalId",
      "principalType",
      "syncStatus",
    ]);
    expect(modelRequired("AssignmentView")).toEqual([
      "displayName",
      "isDesired",
      "isOwner",
      "principalId",
      "principalType",
      "syncStatus",
    ]);
  });

  it("LeaseAssignmentsView pins the view-plus-operation member set", () => {
    expect(modelMembers("LeaseAssignmentsView")).toEqual([
      "assignments",
      "operationInProgress",
    ]);
    expect(modelRequired("LeaseAssignmentsView")).toEqual(["assignments"]);
  });
});

describe("assignments list-length cap ties to MAX_USER_MANAGED_ASSIGNMENTS", () => {
  it("RequestLease and UpdateLeaseAssignments cap `assignments` at the constant (19)", () => {
    // The model can cap the list length (`@length(max: 19)`) but not enforce the
    // cross-item distinctness rule (that is the Zod supplement). Pin the modeled
    // cap to the shared production constant so the two cannot silently diverge.
    expect(MAX_USER_MANAGED_ASSIGNMENTS).toBe(19);
    expect(
      modelMemberTrait("RequestLeaseInput", "assignments", "smithy.api#length"),
    ).toEqual({ max: MAX_USER_MANAGED_ASSIGNMENTS });
    expect(
      modelMemberTrait(
        "UpdateLeaseAssignmentsInput",
        "assignments",
        "smithy.api#length",
      ),
    ).toEqual({ max: MAX_USER_MANAGED_ASSIGNMENTS });
  });
});

describe("lease enums", () => {
  it("LeaseStatus matches every production lease status", () => {
    expect(modelEnum("LeaseStatus")).toEqual(
      [...AllLeaseStatusSchema.options].sort(),
    );
  });

  it("LeaseLockIntent matches the production lock-intent enum", () => {
    expect(modelEnum("LeaseLockIntent")).toEqual(
      [...LeaseLockIntentSchema.options].sort(),
    );
  });

  it("AssignmentSyncStatus matches the production sync-status enum", () => {
    expect(modelEnum("AssignmentSyncStatus")).toEqual(
      [...AssignmentSyncStatusSchema.options].sort(),
    );
  });

  it("ReviewAction matches the Approve/Deny decision enum", () => {
    // TS-interface / handler-literal contract (no Zod enum schema); hardcoded.
    expect(modelEnum("ReviewAction")).toEqual(["Approve", "Deny"]);
  });

  it("SharedLeaseAccessType matches the direct/group access-path enum", () => {
    // The modeled enum is deliberately narrow (direct|group) — the server only
    // ever receives these two values (the query adapter narrows its accessType
    // parameter to direct|group). Hardcoded; no Zod enum schema.
    expect(modelEnum("SharedLeaseAccessType")).toEqual(["direct", "group"]);
  });
});

describe("lease operations", () => {
  it("RequestLease returns the lease WITHOUT a leaseId (201)", () => {
    expect(modelHttpOperation("RequestLease")).toEqual({
      method: "POST",
      uri: "/leases",
      code: 201,
    });
    // Body data is the flat `Lease` (no injected leaseId on the request path);
    // `UnfreezeLease` (with leaseId) proves the two output shapes really differ.
    expect(modelMember("RequestLeaseOutput", "data").target).toBe(
      "com.amazon.isb#Lease",
    );
    expect(modelMember("UnfreezeLeaseOutput", "data").target).toBe(
      "com.amazon.isb#LeaseWithId",
    );
  });

  it("UpdateLeaseAssignments is an accepted (202) PUT returning desiredCount", () => {
    expect(modelHttpOperation("UpdateLeaseAssignments")).toEqual({
      method: "PUT",
      uri: "/leases/{leaseId}/assignments",
      code: 202,
    });
    expect(modelMembers("UpdateLeaseAssignmentsResult")).toEqual([
      "desiredCount",
    ]);
    expect(modelRequired("UpdateLeaseAssignmentsResult")).toEqual([
      "desiredCount",
    ]);
  });

  it("the list operations carry the pre-Smithy pagination bounds", () => {
    expect(
      modelMemberTrait("ListLeasesInput", "maxResults", "smithy.api#range"),
    ).toEqual({ min: 1, max: 2000 });
    expect(
      modelMemberTrait(
        "ListSharedLeasesInput",
        "maxResults",
        "smithy.api#range",
      ),
    ).toEqual({ min: 1, max: 100 });
  });

  it("the list envelopes forward the store's optional error diagnostic", () => {
    // Model-only: pre-Smithy forwarded the raw store result, which can include a
    // top-level `error` string; kept byte-faithful. Each item carries a leaseId.
    expect(modelMembers("ListLeasesResult")).toEqual([
      "error",
      "nextPageIdentifier",
      "result",
    ]);
    expect(modelRequired("ListLeasesResult")).toEqual(["result"]);
    expect(modelMembers("ListSharedLeasesResult")).toEqual([
      "error",
      "nextPageIdentifier",
      "result",
    ]);
    expect(modelRequired("ListSharedLeasesResult")).toEqual(["result"]);
  });
});

describe("accepted Lease model constraint deviations", () => {
  it("data-null actions omit the data member (freeze/review/terminate)", () => {
    // Accepted: the pre-Smithy runtime body was `{status, data: null}`. Smithy
    // cannot model a member whose only value is null, so `data` is absent from the
    // model AND the restJson1 serializer drops the explicit `null` — the wire body
    // is `{status}`, the null is DROPPED (not restored), same as DeleteLeaseTemplate.
    for (const op of ["FreezeLease", "ReviewLease", "TerminateLease"]) {
      expect(
        modelMembers(`${op}Output`),
        `${op} keeps a status-only output`,
      ).toEqual(["status"]);
    }
  });

  it("approvedBy is modeled as an open String, not a closed enum/union", () => {
    // Accepted: the runtime value is `email | "AUTO_APPROVED"`, a union that no
    // single Smithy scalar or enum captures; modeled as String.
    expect(modelMember("Lease", "approvedBy").target).toBe("smithy.api#String");
  });

  it("all lease timestamps are raw String, not @timestamp (byte-faithful)", () => {
    // Accepted deviation #3.
    for (const member of [
      "startDate",
      "expirationDate",
      "lastCheckedDate",
      "endDate",
    ]) {
      expect(modelMember("Lease", member).target).toBe("smithy.api#String");
    }
    expect(modelMember("LeaseResourceLock", "expiresAt").target).toBe(
      "smithy.api#String",
    );
  });
});
