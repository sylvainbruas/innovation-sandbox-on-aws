// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The customizer has one job: render every modeled constraint failure the generated
 * validator produces as the pre-Smithy JSend `ValidationError`. (Constraints the model
 * cannot express faithfully — e.g. `.gt(0)` on the `Double` amount/duration fields,
 * which the inclusive-only `@range` cannot express — are not modeled and are enforced
 * by the operation's Zod re-parse instead, so the customizer has nothing to suppress.)
 * Its field naming, message wording, and absent top-level `message` are pinned here.
 */
import {
  JSendStatus,
  ValidationError,
} from "@amzn/innovation-sandbox-api-server/lease-templates";
import { jsendValidationCustomizer } from "@amzn/innovation-sandbox-commons/lambda/smithy/jsend-validation-customizer.js";
import { RequiredValidationFailure } from "@aws-smithy/server-common";
import { describe, expect, it } from "vitest";

const context = { operation: "CreateLeaseTemplate" as const };
// The customizer is domain-agnostic; the caller supplies its domain's generated
// `ValidationError`. `lease-templates` is used here as a representative domain.
const customize = jsendValidationCustomizer<"CreateLeaseTemplate">(
  (errors) =>
    new ValidationError({
      status: JSendStatus.FAIL,
      message: "",
      data: { errors },
    }),
);

describe("enforced failures", () => {
  it("renders the pre-Smithy JSend fail envelope", () => {
    const error = customize(context, [
      new RequiredValidationFailure("/name"),
    ]) as ValidationError;

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.status).toBe(JSendStatus.FAIL);
    expect(error.data).toEqual({
      errors: [
        {
          field: "name",
          message:
            "Value at '/name' failed to satisfy constraint: Member must not be null",
        },
      ],
    });
  });

  it("keeps the top-level message out of the body", () => {
    // The customizer blanks `message` to `undefined` rather than leaving the `""`
    // the ValidationError constructor requires: the serializer keeps empty strings,
    // so `""` would surface as a top-level `"message": ""` the pre-Smithy 400 body
    // never had.
    const error = customize(context, [
      new RequiredValidationFailure("/name"),
    ]) as ValidationError;

    expect(Object.hasOwn(error, "message")).toBe(true);
    expect(error.message).toBeUndefined();
    expect(JSON.parse(JSON.stringify({ message: error.message }))).toEqual({});
  });

  it("names nested fields the way a Zod issue path would", () => {
    const error = customize(context, [
      new RequiredValidationFailure("/budgetThresholds/0/dollarsSpent"),
    ]) as ValidationError;

    expect(error.data?.errors?.[0]?.field).toBe(
      "budgetThresholds.0.dollarsSpent",
    );
  });

  it("falls back to `input` for a whole-payload failure", () => {
    const error = customize(context, [
      new RequiredValidationFailure(""),
    ]) as ValidationError;

    expect(error.data?.errors?.[0]?.field).toBe("input");
  });

  it("reports every enforced failure in order", () => {
    const error = customize(context, [
      new RequiredValidationFailure("/name"),
      {
        path: "/visibility",
        constraintType: "enum",
        constraintValues: ["PRIVATE", "PUBLIC"],
        failureValue: "SECRET",
      },
    ]) as ValidationError;

    expect(error.data?.errors?.map((entry) => entry.field)).toEqual([
      "name",
      "visibility",
    ]);
    expect(error.data?.errors?.[1]?.message).toBe(
      "Value at '/visibility' failed to satisfy constraint: Member must satisfy enum value set: [PRIVATE, PUBLIC]",
    );
  });
});
