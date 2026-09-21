// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  compareRouteSpecificity,
  preferLiteralRoutes,
  specificityVector,
} from "@amzn/innovation-sandbox-commons/lambda/smithy/prefer-literal-routes.js";

const label = { type: "path" };
const literal = (value: string) => ({ type: "path_literal", value });
const greedy = { type: "greedy" };

// `compareRouteSpecificity` returns < 0 when `a` should sort before `b` (i.e. `a`
// is the more specific / higher-precedence route).
type TestSpec = { pathSegments: { type: string }[]; querySegments?: unknown[] };
const firstOf = (a: TestSpec, b: TestSpec) =>
  compareRouteSpecificity(a, b) < 0 ? a : b;

describe("specificityVector", () => {
  it("scores literal > label > greedy per segment and appends query segments", () => {
    expect(
      specificityVector({
        pathSegments: [literal("a"), label, greedy],
        querySegments: [{}],
      }),
    ).toEqual([2, 1, 0, 1]);
  });
});

describe("compareRouteSpecificity", () => {
  it("prefers a literal over a label at the same position", () => {
    const lit = {
      pathSegments: [literal("accounts"), literal("unregistered")],
    };
    const lbl = { pathSegments: [literal("accounts"), label] };
    expect(firstOf(lit, lbl)).toBe(lit);
  });

  it("decides segment-by-segment, not by aggregate literal count", () => {
    // Both sum to the same aggregate literal weight (2+1+2 === 2+2+1 === 5), so an
    // aggregate ranker would tie them and fall back to codegen order. A request to
    // /a/b/c matches both, and the route with the literal `b` at position 2 must
    // win. Segment-by-segment picks it; aggregate could not.
    const litAtPos2 = { pathSegments: [literal("a"), literal("b"), label] };
    const litAtPos3 = { pathSegments: [literal("a"), label, literal("c")] };
    expect(firstOf(litAtPos2, litAtPos3)).toBe(litAtPos2);
  });

  it("ranks a deeper path above a shorter prefix", () => {
    const deep = { pathSegments: [literal("a"), literal("b"), literal("c")] };
    const shallow = { pathSegments: [literal("a"), literal("b")] };
    expect(firstOf(deep, shallow)).toBe(deep);
  });

  it("ranks a greedy match below a literal or label at the same position", () => {
    const lbl = { pathSegments: [literal("a"), label] };
    const grd = { pathSegments: [literal("a"), greedy] };
    expect(firstOf(lbl, grd)).toBe(lbl);
  });
});

describe("preferLiteralRoutes", () => {
  it("re-sorts the mux so a literal route wins a tie with a label route", () => {
    // Mirrors the generated mux: two same-length routes with the label route
    // emitted first (codegen orders alphabetically: GetAccount before
    // ListUnregisteredAccounts). HttpBindingMux.match returns the first matching
    // spec, so without this the label route would swallow /accounts/unregistered.
    const specs = [
      {
        pathSegments: [literal("accounts"), label],
        target: { operation: "GetAccount" },
      },
      {
        pathSegments: [literal("accounts"), literal("unregistered")],
        target: { operation: "ListUnregisteredAccounts" },
      },
    ];
    const handler = { mux: { specs } };

    expect(preferLiteralRoutes(handler)).toBe(handler);
    expect(handler.mux.specs[0]!.target.operation).toBe(
      "ListUnregisteredAccounts",
    );
  });

  it("fails fast when the mux shape is not reachable (rather than silently no-op)", () => {
    // A silent no-op would reintroduce the misrouting bug this helper fixes, so a
    // changed @smithy/server-common internal shape must surface loudly here.
    expect(() => preferLiteralRoutes({})).toThrow(/could not find `mux.specs`/);
    expect(() => preferLiteralRoutes({ handle: 1 })).toThrow(
      /could not find `mux.specs`/,
    );
    expect(() => preferLiteralRoutes({ mux: {} })).toThrow(
      /could not find `mux.specs`/,
    );
  });
});
