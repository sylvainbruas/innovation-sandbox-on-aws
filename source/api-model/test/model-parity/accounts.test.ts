// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Member parity between the account/cleanup-report persistence schemas (Zod) and
 * the Smithy model. See `README.md` for what this guards and the accepted
 * deviations pattern.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CleanupReportStatusSchema,
  PersistedCleanupReportSchema,
} from "@amzn/innovation-sandbox-commons/data/cleanup-report/cleanup-report.js";
import { PersistedSandboxAccountSchema } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { ResourceLockSchema } from "@amzn/innovation-sandbox-shared/types/resource-lock.js";
import { SandboxAccountStatusSchema } from "@amzn/innovation-sandbox-shared/types/sandbox-account.js";

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

// The public account response is the full persistence record (the pre-Smithy
// handler returned the raw store item); every field participates, including
// `resourceLock` — the frontend reads `resourceLock.expiresAt`.
const accountResponseShape = PersistedSandboxAccountSchema.shape as Record<
  string,
  z.ZodType
>;

// resourceLock members on the wire (timestamps modeled as raw String).
const resourceLockShape = ResourceLockSchema.shape as Record<string, z.ZodType>;

// The account `meta` on the wire keeps the timestamps and drops `schemaVersion`.
const accountMetaShape = (
  PersistedSandboxAccountSchema.shape.meta as unknown as {
    unwrap(): z.ZodObject;
  }
).unwrap().shape as Record<string, z.ZodType>;

// The cleanup-report response is the `toApiResponse` projection: the durable
// diagnostics minus storage/internal fields (pk, sk, ttl, meta,
// accessCleanupSummary, skipCooldownCallbackId).
const cleanupReportResponseShape = PersistedCleanupReportSchema.pick({
  accountId: true,
  durableExecutionArn: true,
  status: true,
  cleanupStatus: true,
  startedAt: true,
  completedAt: true,
  reasonForCleanup: true,
  initiatedBy: true,
  resourceSummary: true,
  steps: true,
  error: true,
  cooldownSkippedBy: true,
}).shape as Record<string, z.ZodType>;

describe("Account model parity", () => {
  it("SandboxAccount projects every persistence field, including the resource lock", () => {
    expect(modelMembers("SandboxAccount")).toEqual(
      zodMembers(accountResponseShape),
    );
    expect(modelRequired("SandboxAccount")).toEqual(
      alwaysPresentOnOutput(accountResponseShape),
    );
  });

  it("ResourceLock mirrors the persisted lock shape", () => {
    expect(modelMembers("ResourceLock")).toEqual(zodMembers(resourceLockShape));
    expect(modelRequired("ResourceLock")).toEqual(
      alwaysPresentOnOutput(resourceLockShape),
    );
  });

  it("matches every member's target type (guards a silent type drift)", () => {
    // Member-set + requiredness alone would miss e.g. driftAtLastScan
    // Boolean -> String, or a number/list-item target change.
    expectMemberTypeParity("SandboxAccount", accountResponseShape);
    // `meta` is a string map; the helper does not model Smithy map targets, and
    // the member-set/requiredness checks above already cover it.
    expectMemberTypeParity(
      "ResourceLock",
      ResourceLockSchema.omit({ meta: true }).shape as Record<
        string,
        z.ZodType
      >,
    );
    // `reasonForCleanup` is a backward-compatible union carrying a `.transform()`,
    // which cannot be lowered to JSON Schema (the helper's comparison basis); it is
    // modeled as an open String and covered by the member-set check above.
    const { reasonForCleanup: _reasonForCleanup, ...cleanupTypeShape } =
      cleanupReportResponseShape;
    expectMemberTypeParity(
      "CleanupReport",
      cleanupTypeShape as Record<string, z.ZodType>,
    );
  });

  it("SandboxAccountStatus matches the production status enum", () => {
    expect(modelEnum("SandboxAccountStatus")).toEqual(
      [...SandboxAccountStatusSchema.options].sort(),
    );
  });

  it("account metadata carries the timestamps (schemaVersion dropped)", () => {
    expect(modelMembers("AccountMetadata")).toEqual(
      zodMembers(accountMetaShape).filter((m) => m !== "schemaVersion"),
    );
  });

  it("RegisterAccount is a strict single-field registration POST", () => {
    expect(modelHttpOperation("RegisterAccount")).toEqual({
      method: "POST",
      uri: "/accounts",
      code: 201,
    });
    expect(modelMembers("RegisterAccountInput")).toEqual(["awsAccountId"]);
    expect(modelRequired("RegisterAccountInput")).toEqual(["awsAccountId"]);
  });

  it("the list operations carry the pre-Smithy pagination bounds", () => {
    expect(
      modelMemberTrait("ListAccountsInput", "maxResults", "smithy.api#range"),
    ).toEqual({ min: 1, max: 2000 });
    expect(
      modelMemberTrait(
        "ListUnregisteredAccountsInput",
        "maxResults",
        "smithy.api#range",
      ),
    ).toEqual({ min: 1, max: 20 });
    expect(
      modelMemberTrait(
        "ListCleanupReportsInput",
        "maxResults",
        "smithy.api#range",
      ),
    ).toEqual({ min: 1, max: 10 });
  });

  it("the list envelope forwards the store's optional error diagnostic", () => {
    // Model-only: pre-Smithy forwarded the raw store result, which can include a
    // top-level `error` string; kept byte-faithful.
    expect(modelMembers("ListAccountsResult")).toEqual([
      "error",
      "nextPageIdentifier",
      "result",
    ]);
    expect(modelRequired("ListAccountsResult")).toEqual(["result"]);
  });
});

describe("CleanupReport model parity", () => {
  it("projects the toApiResponse fields with matching optionality", () => {
    expect(modelMembers("CleanupReport")).toEqual(
      zodMembers(cleanupReportResponseShape),
    );
    expect(modelRequired("CleanupReport")).toEqual(
      alwaysPresentOnOutput(cleanupReportResponseShape),
    );
  });

  it("CleanupReportStatus matches the production status enum", () => {
    expect(modelEnum("CleanupReportStatus")).toEqual(
      [...CleanupReportStatusSchema.options].sort(),
    );
  });
});

describe("accepted Account model constraint deviations", () => {
  it("models cleanupStatus as an open string, not a closed enum", () => {
    // Accepted: the runtime cleanupStatus is an enum plus a `NUKE_PHASE_<n>`
    // pattern, which a closed Smithy enum cannot represent; modeled as String.
    expect(modelMember("CleanupReport", "cleanupStatus").target).toBe(
      "smithy.api#String",
    );
  });
});
