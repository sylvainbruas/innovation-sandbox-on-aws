// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { PersistedPrincipalCacheItemSchema } from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import {
  IdcPrincipalSchema,
  PrincipalTypeSchema,
} from "@amzn/innovation-sandbox-shared/types/principal.js";

import {
  alwaysPresentOnOutput,
  modelEnum,
  modelHttpOperation,
  modelMember,
  modelMemberSchema,
  modelMemberTargetTrait,
  modelMemberTrait,
  modelMembers,
  modelQueryParameters,
  modelRequired,
  requiredOnInput,
  zodComparableSchema,
  zodMembers,
} from "./parity-helpers.js";

/**
 * Executable snapshot of the query contract removed with the pre-Smithy
 * handler. Smithy owns runtime query validation now; this test-only schema is
 * the independent compatibility baseline for the contract it replaced.
 */
const LegacySearchQueryParametersSchema = z.object({
  q: z.string().max(200).default(""),
  type: z.enum(["users", "groups", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  exact: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

const principalCacheShape = PersistedPrincipalCacheItemSchema.shape;
const principalResponseShape = IdcPrincipalSchema.shape as Record<
  string,
  z.ZodType
>;

const legacyQueryShape = LegacySearchQueryParametersSchema.shape as Record<
  string,
  z.ZodType
>;

describe("Principal search model parity", () => {
  it("matches every shared principal field and its optionality", () => {
    expect(modelMembers("Principal")).toEqual(
      zodMembers(principalResponseShape),
    );
    expect(modelRequired("Principal")).toEqual(
      alwaysPresentOnOutput(principalResponseShape),
    );
  });

  it("matches every projected member's scalar type and enum target", () => {
    // Member-set + requiredness alone do not catch a member whose target type
    // changed (e.g. principalId String -> Integer is a breaking, silent drift).
    for (const [name, field] of Object.entries(principalResponseShape)) {
      expect(
        modelMemberSchema("Principal", name).type,
        `Principal.${name} scalar type`,
      ).toBe(zodComparableSchema(field).type);
    }
    // principalType must target the shared enum, not merely be a string.
    expect(modelMember("Principal", "principalType").target).toBe(
      "com.amazon.isb#PrincipalType",
    );
  });

  it("PrincipalType matches the production principal enum", () => {
    expect(modelEnum("PrincipalType")).toEqual(
      [...PrincipalTypeSchema.options].sort(),
    );
  });

  it("keeps the model-only PrincipalSearchResult envelope stable", () => {
    // There was no pre-Smithy response Zod schema for this envelope. Keep this
    // explicitly model-only rather than creating production code for the test.
    expect(modelMembers("PrincipalSearchResult")).toEqual([
      "principals",
      "totalMatches",
    ]);
    expect(modelRequired("PrincipalSearchResult")).toEqual([
      "principals",
      "totalMatches",
    ]);
  });

  it("matches the legacy query contract after transport decoding", () => {
    const parameters = modelQueryParameters("SearchPrincipals");
    const byName = Object.fromEntries(
      parameters.map((parameter) => [parameter.name, parameter]),
    );
    const qSchema = LegacySearchQueryParametersSchema.shape.q.unwrap();
    const typeSchema = LegacySearchQueryParametersSchema.shape.type.unwrap();
    const limitSchema = LegacySearchQueryParametersSchema.shape.limit.unwrap();
    const decodedDefaults = LegacySearchQueryParametersSchema.parse({});

    expect(modelHttpOperation("SearchPrincipals")).toEqual({
      method: "GET",
      uri: "/principals/search",
      code: 200,
    });
    expect(modelMembers("SearchPrincipalsInput")).toEqual(
      zodMembers(legacyQueryShape),
    );
    expect(Object.keys(byName).sort()).toEqual(zodMembers(legacyQueryShape));
    expect(
      parameters.map(({ memberName, name }) => [memberName, name]).sort(),
    ).toEqual(zodMembers(legacyQueryShape).map((name) => [name, name]));
    expect(
      parameters
        .filter(({ required }) => required)
        .map(({ name }) => name)
        .sort(),
    ).toEqual(requiredOnInput(legacyQueryShape));
    expect(
      modelMemberTrait("SearchPrincipalsInput", "q", "smithy.api#length"),
    ).toEqual({ max: qSchema.maxLength });
    expect(byName.type?.target).toBe(
      "com.amazon.isb#PrincipalSearchTypeFilter",
    );
    expect(modelEnum("PrincipalSearchTypeFilter")).toEqual(
      [...typeSchema.options].sort(),
    );
    expect(
      modelMemberTrait("SearchPrincipalsInput", "limit", "smithy.api#range"),
    ).toEqual({
      min: limitSchema.minValue,
      max: limitSchema.maxValue,
    });
    expect(byName.exact?.target).toBe("smithy.api#Boolean");
    expect(typeof decodedDefaults.exact).toBe("boolean");
  });

  it("records legacy defaults as runtime behavior outside the Smithy model", () => {
    expect(LegacySearchQueryParametersSchema.parse({})).toEqual({
      q: "",
      type: "all",
      limit: 20,
      exact: false,
    });
    for (const member of zodMembers(legacyQueryShape)) {
      expect(
        modelMemberTrait("SearchPrincipalsInput", member, "smithy.api#default"),
      ).toBeUndefined();
    }
  });
});

describe("accepted Principal model constraint deviations", () => {
  it("does not model the cache principal-id pattern", () => {
    // Accepted: persistence validates IDC ids, while the public Smithy member
    // remains an unconstrained string.
    expect(principalCacheShape.principalId.safeParse("not-an-id").success).toBe(
      false,
    );
    expect(
      modelMemberTrait("Principal", "principalId", "smithy.api#pattern"),
    ).toBeUndefined();
  });

  it("does not model the cache display-name minimum length", () => {
    // Accepted: persistence rejects an empty present value, while Smithy has no
    // @length(min: 1). If the model gains it, remove this deviation.
    expect(principalCacheShape.displayName.unwrap().safeParse("").success).toBe(
      false,
    );
    expect(
      modelMemberTrait("Principal", "displayName", "smithy.api#length"),
    ).toBeUndefined();
  });

  it("does not mistake Smithy sensitivity for Zod email validation", () => {
    // Accepted: Smithy redacts the value but does not validate email syntax.
    expect(
      principalCacheShape.email.unwrap().safeParse("not-an-email").success,
    ).toBe(false);
    expect(
      modelMemberTrait("Principal", "email", "smithy.api#pattern"),
    ).toBeUndefined();
    expect(
      modelMemberTargetTrait("Principal", "email", "smithy.api#sensitive"),
    ).toEqual({});
  });

  it("does not model totalMatches as nonnegative", () => {
    // Accepted: operation code returns Array.length, so runtime values cannot be
    // negative even though Smithy currently has no @range(min: 0).
    expect(
      modelMemberTrait(
        "PrincipalSearchResult",
        "totalMatches",
        "smithy.api#range",
      ),
    ).toBeUndefined();
  });
});
