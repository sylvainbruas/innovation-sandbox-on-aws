$version: "2"

namespace com.amazon.isb

use aws.protocols#restJson1

// Principal search (A4). A response-projection domain: `GET /principals/search`
// reads the IDC principal cache (fuzzy) or resolves one principal exactly, and
// projects each match onto the wire shape below. There is no request body — the
// query parameters are fully expressible as model constraints (@length, enum,
// @range, Boolean), so unlike the write domains this operation needs no Zod
// re-parse supplement (see `zod-validation-supplements.md`). The per-domain
// `PrincipalsApi` service is server-only (no `@service`/`@sigv4`); the aggregate
// `IsbApi` (main.smithy) lists the same operation for the client/OpenAPI.
/// Whether a matched principal is an IDC user or group.
enum PrincipalType {
    USER
    GROUP
}

/// The `type` query filter: restrict to users, groups, or both. The public wire
/// values are lowercase.
// The lowercase wire values are retained from the pre-Smithy contract.
enum PrincipalSearchTypeFilter {
    USERS = "users"
    GROUPS = "groups"
    ALL = "all"
}

/// A resolved IDC principal in the search response.
// Response-projection shape: only these four members reach the wire; no
// cache/persistence field (TTL, cache keys) is exposed.
structure Principal {
    /// IDC identifier for the user or group.
    @required
    principalId: String

    @required
    principalType: PrincipalType

    /// Human-readable name shown in the assignment UI. Optional: may be absent
    /// when the principal has no display name.
    // The IDC cache permits a principal with no display name, and the pre-Smithy
    // response omitted the member in that case (so it must not be `@required`).
    displayName: String

    /// Present for users, absent for groups.
    // Typed `OwnerEmail` so generated logging redacts it (`@sensitive`).
    email: OwnerEmail
}

list PrincipalList {
    member: Principal
}

/// The `data` payload of a principal search: the (capped) matches plus the total
/// that matched before `limit` was applied.
structure PrincipalSearchResult {
    @required
    principals: PrincipalList

    /// Total matches before the `limit` cap (the returned list may be shorter).
    @required
    totalMatches: Integer
}

/// Searches IDC principals for the assignment UI.
///
/// Two modes on one route, selected by `exact`:
///   - fuzzy (`exact=false`, the default): case-insensitive substring match over
///     the cached principals, capped at `limit`; requires
///     `leases.enablePrincipalSearch` (else 403 `AccessDeniedError`);
///   - exact (`exact=true`): resolves one principal by exact attribute through IDC;
///     requires a non-empty `q` and a specific `type`
///     (`users` or `groups`, not `all`) — otherwise 400 — and returns 404 when no
///     principal resolves. Exact lookups bypass `leases.enablePrincipalSearch`,
///     but group lookups still require `leases.groupAssignmentMode` to be `ALL`.
///
/// When `leases.groupAssignmentMode` is `NONE`, explicit fuzzy or exact group
/// searches return 403, and unfiltered fuzzy searches return users only. Existing
/// group associations remain visible through lease assignment reads.
///
/// Applies these defaults when a parameter is absent: `q=""`, `type=all`,
/// `limit=20`, `exact=false`.
///
/// This operation is not paginated: it is a typeahead search, not a
/// list/describe. The caller shows the top `limit` matches (≤ 100) and never
/// pages; `totalMatches` exists only so the UI can show "N of M".
// exact (`exact=true`) resolves through a read-through cache.
// The defaults above are the pre-Smithy defaults.
// A non-numeric, out-of-range, or repeated query value is rejected by generated
// validation (a `restJson1` 400) rather than the pre-Smithy Zod field error — an
// accepted deviation.
// Non-pagination is an accepted deviation from the pagination standard. Preserves
// the pre-Smithy contract; adding `nextToken` would be a new, non-additive client
// contract for no consumer that pages.
@examples([
    {
        title: "Search principals by name"
        input: { q: "jane" }
        output: {
            status: "success"
            data: {
                principals: [
                    {
                        principalId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
                        principalType: "USER"
                        displayName: "Jane Doe"
                        email: "jane@example.com"
                    }
                ]
                totalMatches: 47
            }
        }
    }
])
@http(method: "GET", uri: "/principals/search", code: 200)
@readonly
@tags(["principals"])
operation SearchPrincipals {
    input := {
        /// Case-insensitive substring matched against display name and email.
        @httpQuery("q")
        @length(max: 200)
        q: String

        @httpQuery("type")
        type: PrincipalSearchTypeFilter

        /// Maximum matches to return. The operation defaults it to 20 when absent.
        @httpQuery("limit")
        @range(min: 1, max: 100)
        limit: Integer

        /// When true, resolve one principal by exact attribute instead of fuzzy
        /// search.
        // The pre-Smithy contract accepts only `"true"`/`"false"`; a generated
        // Boolean query parses the same two tokens.
        @httpQuery("exact")
        exact: Boolean
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: PrincipalSearchResult
    }

    // No operation-level `errors`: the exact-lookup 404 is thrown as a delegated
    // JSend error with no `x-amzn-errortype` (matching the deliberate no-existence-
    // oracle convention and the other domains, which do not model a typed 404).
}

// Principal search domain service (server SSDK only — no `@service`/`@sigv4`;
// those live on the aggregate `IsbApi`).
@restJson1
@title("Innovation Sandbox on AWS — Principals")
service PrincipalsApi {
    version: "2026-07-31"
    operations: [
        SearchPrincipals
    ]
    errors: [
        ValidationError
        UnauthenticatedError
        AccessDeniedError
        InternalServerError
    ]
}
