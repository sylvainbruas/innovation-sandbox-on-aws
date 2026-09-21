// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Member parity between the blueprint persistence schemas (Zod) and the Smithy
 * model. See `README.md` for what this guards and the accepted-deviations pattern.
 *
 * The public blueprint responses are projections of the persisted entities: the
 * pre-Smithy handler returned the raw store items, so `PK`/`SK`/`itemType` (and,
 * on deployment history, `ttl`/`meta`) currently reach the wire but no consumer
 * reads them (the frontend view types omit them). The model drops them — an
 * accepted deviation asserted below — so parity is checked against the persistence
 * shapes with those internal fields removed.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  RegisterBlueprintRequestSchema,
  UpdateBlueprintRequestSchema,
} from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint-request-schemas.js";
import {
  PersistedBlueprintItemSchema,
  PersistedBlueprintWithStackSetsSchema,
  PersistedDeploymentHistoryItemSchema,
  PersistedStackSetItemSchema,
} from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint.js";

import {
  alwaysPresentOnOutput,
  expectMemberTypeParity,
  modelEnum,
  modelHttpOperation,
  modelMember,
  modelMembers,
  modelMemberSchema,
  modelMemberTargetTrait,
  modelMemberTrait,
  modelRequired,
  modelShape,
  requiredOnInput,
  zodComparableSchema,
  zodMembers,
} from "./parity-helpers.js";

// Blueprint entity on the wire: the PersistedBlueprintItem minus the internal
// DynamoDB keys/type discriminator.
const blueprintShape = PersistedBlueprintItemSchema.omit({
  PK: true,
  SK: true,
  itemType: true,
}).shape as Record<string, z.ZodType>;

// StackSet config on the wire: the PersistedStackSetItem minus the same internal
// fields.
const stackSetShape = PersistedStackSetItemSchema.omit({
  PK: true,
  SK: true,
  itemType: true,
}).shape as Record<string, z.ZodType>;

// Deployment history on the wire: the persisted item minus internal fields AND the
// storage-only `ttl` + `meta` (the frontend `DeploymentHistory` type omits both).
const deploymentShape = PersistedDeploymentHistoryItemSchema.omit({
  PK: true,
  SK: true,
  itemType: true,
  ttl: true,
  meta: true,
}).shape as Record<string, z.ZodType>;

const compositeShape = PersistedBlueprintWithStackSetsSchema.shape as Record<
  string,
  z.ZodType
>;

// Blueprint `meta` keeps the timestamps AND `schemaVersion` (unlike Accounts /
// Configurations, whose frontends never read it — this domain's does).
const blueprintMetaShape = (
  PersistedBlueprintItemSchema.shape.meta as unknown as {
    unwrap(): z.ZodObject;
  }
).unwrap().shape as Record<string, z.ZodType>;

describe("Blueprint model parity", () => {
  it("Blueprint projects the persistence fields (minus internal PK/SK/itemType)", () => {
    expect(modelMembers("Blueprint")).toEqual(zodMembers(blueprintShape));
    expect(modelRequired("Blueprint")).toEqual(
      alwaysPresentOnOutput(blueprintShape),
    );
  });

  it("StackSetConfig projects the persisted StackSet fields (minus internal fields)", () => {
    expect(modelMembers("StackSetConfig")).toEqual(zodMembers(stackSetShape));
    expect(modelRequired("StackSetConfig")).toEqual(
      alwaysPresentOnOutput(stackSetShape),
    );
  });

  it("DeploymentHistory projects the persisted fields (minus PK/SK/itemType/ttl/meta)", () => {
    expect(modelMembers("DeploymentHistory")).toEqual(
      zodMembers(deploymentShape),
    );
    expect(modelRequired("DeploymentHistory")).toEqual(
      alwaysPresentOnOutput(deploymentShape),
    );
  });

  it("BlueprintWithStackSets mirrors the composite response shape", () => {
    expect(modelMembers("BlueprintWithStackSets")).toEqual(
      zodMembers(compositeShape),
    );
    expect(modelRequired("BlueprintWithStackSets")).toEqual(
      alwaysPresentOnOutput(compositeShape),
    );
  });

  it("blueprint metadata keeps the timestamps AND schemaVersion", () => {
    expect(modelMembers("BlueprintMetadata")).toEqual(
      zodMembers(blueprintMetaShape),
    );
    expect(modelRequired("BlueprintMetadata")).toEqual(
      zodMembers(blueprintMetaShape),
    );
  });

  it("matches every member's target type (guards a silent type drift)", () => {
    // `tags` (a string map) and `meta` (a structure) are excluded: `z.toJSONSchema`
    // does not lower the refined-key record, and the member-set/requiredness checks
    // above already cover both. The remaining members — including the nested
    // `totalHealthMetrics`/`healthMetrics` objects and the `regions` list — are
    // compared.
    const { tags: _tags, meta: _meta, ...blueprintTypeShape } = blueprintShape;
    expectMemberTypeParity("Blueprint", blueprintTypeShape);

    const { meta: _stackSetMeta, ...stackSetTypeShape } = stackSetShape;
    expectMemberTypeParity("StackSetConfig", stackSetTypeShape);

    expectMemberTypeParity("DeploymentHistory", deploymentShape);
  });

  it("enums match the production values", () => {
    // Asserted against the production contract values (the persistence enums are
    // inline/defaulted, so deriving them would require brittle unwrapping).
    expect(modelEnum("RegionConcurrencyType")).toEqual([
      "PARALLEL",
      "SEQUENTIAL",
    ]);
    expect(modelEnum("ConcurrencyMode")).toEqual([
      "SOFT_FAILURE_TOLERANCE",
      "STRICT_FAILURE_TOLERANCE",
    ]);
    expect(modelEnum("DeploymentStatus")).toEqual([
      "FAILED",
      "QUEUED",
      "RUNNING",
      "SUCCEEDED",
    ]);
  });

  it("the list operations carry the pre-Smithy pagination bound (max 100)", () => {
    expect(
      modelMemberTrait("ListStackSetsInput", "maxResults", "smithy.api#range"),
    ).toEqual({ min: 1, max: 100 });
    expect(
      modelMemberTrait("ListBlueprintsInput", "maxResults", "smithy.api#range"),
    ).toEqual({ min: 1, max: 100 });
  });

  it("ListBlueprints returns its collection under `blueprints` (not `result`)", () => {
    expect(modelMembers("ListBlueprintsResult")).toEqual([
      "blueprints",
      "nextPageIdentifier",
    ]);
    expect(modelRequired("ListBlueprintsResult")).toEqual(["blueprints"]);
  });

  it("declares the six operations with their pre-Smithy HTTP bindings", () => {
    expect(modelHttpOperation("ListStackSets")).toEqual({
      method: "GET",
      uri: "/blueprints/stacksets",
      code: 200,
    });
    expect(modelHttpOperation("ListBlueprints")).toEqual({
      method: "GET",
      uri: "/blueprints",
      code: 200,
    });
    expect(modelHttpOperation("RegisterBlueprint")).toEqual({
      method: "POST",
      uri: "/blueprints",
      code: 201,
    });
    expect(modelHttpOperation("GetBlueprint")).toEqual({
      method: "GET",
      uri: "/blueprints/{blueprintId}",
      code: 200,
    });
    expect(modelHttpOperation("UpdateBlueprint")).toEqual({
      method: "PUT",
      uri: "/blueprints/{blueprintId}",
      code: 200,
    });
    expect(modelHttpOperation("DeleteBlueprint")).toEqual({
      method: "DELETE",
      uri: "/blueprints/{blueprintId}",
      code: 200,
    });
  });
});

describe("accepted Blueprint model deviations", () => {
  it("drops the internal DynamoDB fields from the wire projection", () => {
    // Documented deviation: the pre-Smithy handler returned raw store items, so
    // these appeared in responses; no consumer reads them, so the model omits them.
    for (const internal of ["PK", "SK", "itemType"]) {
      expect(modelMembers("Blueprint")).not.toContain(internal);
      expect(modelMembers("StackSetConfig")).not.toContain(internal);
    }
    for (const internal of ["PK", "SK", "itemType", "ttl", "meta"]) {
      expect(modelMembers("DeploymentHistory")).not.toContain(internal);
    }
  });

  it("models the StackSet summary status/permissionModel as open strings", () => {
    // Accepted: these are CloudFormation passthroughs (permissionModel may be
    // absent in member accounts); modeled as open `String`, not closed enums.
    expect(modelMember("StackSetSummary", "status").target).toBe(
      "smithy.api#String",
    );
    expect(modelMember("StackSetSummary", "permissionModel").target).toBe(
      "smithy.api#String",
    );
  });
});

describe("Blueprint request-input parity (derived from the runtime Zod re-parse)", () => {
  // Real parity: the request bodies are validated by a strict Zod re-parse
  // (deviation #6), so these compare the Smithy inputs against the EXACT schemas the
  // operations re-parse with — `RegisterBlueprintRequestSchema`/`UpdateBlueprintRequestSchema`.
  // Any drift between the model and that runtime Zod (a member, its requiredness,
  // type, or a numeric/length bound) fails here rather than only at runtime. `tags`
  // is compared structurally in its own case below: `z.toJSONSchema` cannot lower
  // its refined-key record.
  const registerShape = RegisterBlueprintRequestSchema.shape as Record<
    string,
    z.ZodType
  >;
  const updateShape = UpdateBlueprintRequestSchema.shape as Record<
    string,
    z.ZodType
  >;

  it("RegisterBlueprintInput mirrors RegisterBlueprintRequestSchema (members + requiredness)", () => {
    expect(modelMembers("RegisterBlueprintInput")).toEqual(
      zodMembers(registerShape),
    );
    expect(modelRequired("RegisterBlueprintInput")).toEqual(
      requiredOnInput(registerShape),
    );
  });

  it("RegisterBlueprintInput members match the Zod type + numeric/length bounds", () => {
    for (const [name, field] of Object.entries(registerShape)) {
      if (name === "tags") continue;
      expect(
        modelMemberSchema("RegisterBlueprintInput", name),
        `RegisterBlueprintInput.${name}`,
      ).toEqual(zodComparableSchema(field));
    }
  });

  it("UpdateBlueprintInput mirrors UpdateBlueprintRequestSchema (PATCH body + blueprintId label)", () => {
    // The model input adds the `blueprintId` httpLabel, which is not part of the JSON
    // body schema; every body member is optional (PATCH), so the label is the only
    // required member.
    expect(
      modelMembers("UpdateBlueprintInput").filter((m) => m !== "blueprintId"),
    ).toEqual(zodMembers(updateShape));
    expect(modelRequired("UpdateBlueprintInput")).toEqual(["blueprintId"]);
    expect(requiredOnInput(updateShape)).toEqual([]);
  });

  it("UpdateBlueprintInput members match the Zod type + numeric/length bounds", () => {
    for (const [name, field] of Object.entries(updateShape)) {
      if (name === "tags") continue;
      expect(
        modelMemberSchema("UpdateBlueprintInput", name),
        `UpdateBlueprintInput.${name}`,
      ).toEqual(zodComparableSchema(field));
    }
  });

  it("models the tag count + key/value length/pattern the Zod record also enforces", () => {
    // `tags` cannot be lowered by `z.toJSONSchema` (refined-key record), so its
    // constraints are pinned directly. The reserved `aws:` key-prefix refinement has
    // no Smithy equivalent and stays Zod-owned (accepted deviation).
    expect(
      modelMemberTrait("RegisterBlueprintInput", "tags", "smithy.api#length"),
    ).toEqual({ max: 10 });
    expect(modelShape("BlueprintTagKey").traits?.["smithy.api#length"]).toEqual(
      {
        min: 1,
        max: 128,
      },
    );
    expect(
      modelShape("BlueprintTagValue").traits?.["smithy.api#length"],
    ).toEqual({ max: 256 });
    // Both carry the CloudFormation-tag character pattern (exact regex asserted
    // behaviorally in the handler suite; here we pin that a pattern exists).
    expect(
      modelShape("BlueprintTagKey").traits?.["smithy.api#pattern"],
    ).toBeDefined();
    expect(
      modelShape("BlueprintTagValue").traits?.["smithy.api#pattern"],
    ).toBeDefined();
  });

  it("BlueprintId pattern equals the persisted z.uuid() layout (RFC versions + nil/max)", () => {
    // Guards C2: a future loosening back to a bare hex layout — which would turn the
    // pre-Smithy 400 into a store-miss 404 — fails here.
    expect(
      modelMemberTargetTrait(
        "GetBlueprintInput",
        "blueprintId",
        "smithy.api#pattern",
      ),
    ).toBe(
      "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
    );
  });
});
