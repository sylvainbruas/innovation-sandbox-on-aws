// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Member parity between the lease-template domain/persistence schemas (Zod) and
 * the Smithy model. See `README.md` in this folder for what this guards, why
 * nothing else catches it, and when it can be deleted.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  PersistedLeaseTemplateMetadataSchema,
  PersistedLeaseTemplateSchema,
} from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import {
  BudgetThresholdSchema,
  DurationThresholdSchema,
  LeaseTemplateWritableSchema,
} from "@amzn/innovation-sandbox-shared/types/lease-template.js";

import {
  alwaysPresentOnOutput,
  expectMemberTypeParity,
  modelMember,
  modelMembers,
  modelMemberTrait,
  modelQueryParameters,
  modelRequired,
  requiredOnInput,
  zodMembers,
} from "./parity-helpers.js";

const createRequestShape = LeaseTemplateWritableSchema.shape as Record<
  string,
  z.ZodType
>;

const leaseTemplateShape = PersistedLeaseTemplateSchema.shape as Record<
  string,
  z.ZodType
>;

describe("LeaseTemplate", () => {
  it("declares the same members as the persistence schema", () => {
    expect(modelMembers("LeaseTemplate")).toEqual(
      zodMembers(leaseTemplateShape),
    );
  });

  it("requires exactly the members the persistence schema always produces", () => {
    expect(modelRequired("LeaseTemplate")).toEqual(
      alwaysPresentOnOutput(leaseTemplateShape),
    );
  });

  it("matches every member's type and the visibility enum target", () => {
    // Guards against a silent target-type change (e.g. requiresApproval
    // Boolean -> String) that member-set + requiredness alone would miss.
    expectMemberTypeParity("LeaseTemplate", leaseTemplateShape);
    expect(modelMember("LeaseTemplate", "visibility").target).toBe(
      "com.amazon.isb#Visibility",
    );
  });
});

describe("CreateLeaseTemplateInput", () => {
  it("declares the same members as the create request schema", () => {
    expect(modelMembers("CreateLeaseTemplateInput")).toEqual(
      zodMembers(createRequestShape),
    );
  });

  it("requires exactly the members the create request schema requires", () => {
    // Fewer than the response shape: `visibility` and `allowOwnerToShareLease`
    // are `.default()`, so a client may omit them.
    expect(modelRequired("CreateLeaseTemplateInput")).toEqual(
      requiredOnInput(createRequestShape),
    );
  });
});

describe("threshold shapes", () => {
  it.each([
    ["BudgetThreshold", BudgetThresholdSchema],
    ["DurationThreshold", DurationThresholdSchema],
  ])("%s matches its persistence schema", (name, schema) => {
    const shape = schema.shape as Record<string, z.ZodType>;
    expect(modelMembers(name as string)).toEqual(zodMembers(shape));
    expect(modelRequired(name as string)).toEqual(alwaysPresentOnOutput(shape));
    expectMemberTypeParity(name as string, shape);
    expect(modelMember(name as string, "action").target).toBe(
      "com.amazon.isb#ThresholdAction",
    );
  });
});

describe("ListLeaseTemplates query parameters", () => {
  // Model-only: there is no independent Zod request schema for pagination
  // (the DAO stores use maxResults for their own paging, not the API contract).
  // Pin the query bindings and bounds so a drift in the model fails here.
  it("binds pageIdentifier and a bounded maxResults", () => {
    const params = Object.fromEntries(
      modelQueryParameters("ListLeaseTemplates").map((p) => [p.name, p]),
    );
    expect(Object.keys(params).sort()).toEqual([
      "maxResults",
      "pageIdentifier",
    ]);
    expect(params.maxResults?.target).toBe("smithy.api#Integer");
    expect(
      modelMemberTrait(
        "ListLeaseTemplatesInput",
        "maxResults",
        "smithy.api#range",
      ),
    ).toEqual({ min: 1, max: 2000 });
  });
});

describe("Metadata", () => {
  it("declares the same members as the persisted metadata schema", () => {
    expect(modelMembers("Metadata")).toEqual(
      zodMembers(
        PersistedLeaseTemplateMetadataSchema.shape as Record<string, z.ZodType>,
      ),
    );
  });
});
