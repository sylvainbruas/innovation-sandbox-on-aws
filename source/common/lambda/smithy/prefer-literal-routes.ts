// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Restores literal-over-label routing precedence for a generated Smithy service
 * handler.
 *
 * `@smithy/server-common`'s `HttpBindingMux` ranks routes by total segment count
 * (`pathSegments.length + querySegments.length`) and weights a path **literal**
 * and a path **label** equally. Two routes that differ only literal-vs-label at
 * the same position therefore tie, and the tie is broken by the order codegen
 * emits them (alphabetical by operation name). That mis-routes, for example,
 * `GET /accounts/unregistered` to `GetAccount` (`/accounts/{awsAccountId}`,
 * alphabetically first) instead of `ListUnregisteredAccounts` — producing a 400
 * from the `awsAccountId` pattern. The pre-Smithy `@middy/http-router` routed
 * static segments before parameters, so this is a regression the migration must
 * not ship.
 *
 * This re-sorts the mux's route specs by a **segment-by-segment** specificity
 * comparison: the two specificity vectors (literal=2, label=1, greedy=0 per path
 * segment, then query segments) are compared position by position, and the first
 * differing position decides — so a literal at an earlier position wins, exactly
 * like a longest-static-prefix router. This is stronger than an aggregate literal
 * count, which would tie `/a/{x}/c` with `/a/b/{y}` (both sum to 5) even though a
 * request to `/a/b/c` should prefer the route with the literal `b` at position 2.
 * A longer, more specific path outranks a shorter prefix. `/accounts/unregistered`
 * (two literals) thus beats `/accounts/{id}` (literal + label). `HttpBindingMux`
 * returns the first matching spec, so re-sorting in place fixes precedence without
 * touching generated code. Two specs can both match a request only at equal
 * segment count, which is precisely where this comparison is decisive; specs of
 * different lengths (or differing at a literal *value*) never both match, so their
 * relative order is inert. Generic: every migrated domain can wrap its handler
 * (Accounts now, Leases' `/leases/shared` vs `/leases/{param}` next).
 *
 * Reaches the mux's internal `specs` reflectively. If the internal shape ever
 * changes (e.g. a `@smithy/server-common` upgrade) it throws rather than
 * silently no-op'ing: a silent no-op would reintroduce the exact misrouting bug
 * this helper exists to fix, discoverable only as unexplained pattern-rejection
 * 400s in production. Throwing surfaces the breakage loudly in unit/integration/
 * deploy tests instead — the shape is always present for our generated handlers,
 * so this path is not a normal runtime condition. `prefer-literal-routes.test.ts`
 * guards the ranking, and each domain's handler tests exercise the real collision
 * end to end.
 */

interface RankablePathSegment {
  type: string;
}

interface RankableSpec {
  pathSegments?: RankablePathSegment[];
  querySegments?: unknown[];
}

/** Per-segment specificity: a literal is most specific, a label less, greedy least. */
function segmentWeight(segment: RankablePathSegment): number {
  if (segment.type === "path_literal") return 2;
  if (segment.type === "greedy") return 0;
  return 1; // path label
}

/**
 * The specificity vector for a spec: path segments (positional) followed by query
 * segments. Compared lexicographically, this yields segment-by-segment precedence.
 */
export function specificityVector(spec: RankableSpec): number[] {
  return [
    ...(spec.pathSegments ?? []).map(segmentWeight),
    ...(spec.querySegments ?? []).map(() => 1),
  ];
}

/**
 * Orders specs most-specific-first (an `Array.sort` comparator): compares the two
 * specificity vectors position by position; the first differing position decides,
 * and a longer vector (a more specific, deeper path) outranks a shorter prefix.
 */
export function compareRouteSpecificity(
  a: RankableSpec,
  b: RankableSpec,
): number {
  const va = specificityVector(a);
  const vb = specificityVector(b);
  const shared = Math.min(va.length, vb.length);
  for (let i = 0; i < shared; i++) {
    if (va[i] !== vb[i]) return vb[i]! - va[i]!;
  }
  return vb.length - va.length;
}

/**
 * Re-sorts a generated service handler's mux route specs so more-literal routes
 * win, then returns the same handler. Safe to call once at module load.
 */
export function preferLiteralRoutes<T>(serviceHandler: T): T {
  const mux = (serviceHandler as { mux?: { specs?: RankableSpec[] } }).mux;
  if (!mux || !Array.isArray(mux.specs)) {
    throw new Error(
      "preferLiteralRoutes: could not find `mux.specs` on the generated service " +
        "handler. The @smithy/server-common internals may have changed; " +
        "literal-over-label routing precedence is not being applied, so static " +
        "routes (e.g. /accounts/unregistered) would be shadowed by label routes.",
    );
  }
  mux.specs = [...mux.specs].sort(compareRouteSpecificity);
  return serviceHandler;
}
