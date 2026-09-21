# Model and runtime-contract parity tests

These tests compare the projected Smithy model with an independent application
contract for each migrated domain.

## Why this guard exists

Smithy owns modeled HTTP shapes and serialization, while existing Zod schemas
still own persistence and supplemental runtime validation. Drift can otherwise
be silent: a member present in a runtime object but absent from Smithy is simply
omitted by the generated serializer.

Other checks do not cover this boundary:

- compatibility verification compares Smithy artifacts with other Smithy
  artifacts;
- generated-code compilation proves internal consistency, not agreement with
  application schemas;
- golden tests may miss a newly added optional field.

## Contract sources

Use the strongest independent source that already exists:

- production Zod schemas for persisted or runtime-validated shapes;
- exported production enums;
- a test-local legacy fixture when Smithy replaced and removed the previous
  contract;
- an explicit model-only assertion when no Zod counterpart exists.

Do not add production schemas or consumers solely to support these tests.
Principal response parity uses the browser-safe `IdcPrincipalSchema` as the neutral
domain contract. Additions to that schema require a corresponding Smithy
decision; fields added only to `PrincipalCacheItemSchema` remain
persistence-owned and do not participate in API parity.

Principal query parity uses `LegacySearchQueryParametersSchema`, an exact
recreation of the removed pre-Smithy query schema. It is an executable historical
compatibility baseline, not current runtime validation. Comparisons are semantic:
Smithy sees decoded numbers and Booleans, whereas the old schema consumed and
coerced raw query strings. Defaults are operation behavior and remain covered by
handler tests; this suite records their legacy values and verifies that they are
not represented as Smithy model defaults.

## Reading the model

The tests read the aggregate Smithy JSON model projection at:

`build/smithyprojections/isb-api-model/aggregate/model/model.json`

This is the canonical machine-readable Smithy model after projection. Tests use
structure members, member and target traits, enum values, operation HTTP traits,
and query bindings directly. The helper recursively expands Smithy mixins because
the JSON AST retains them instead of flattening inherited members.

OpenAPI is deliberately not the source for model parity. OpenAPI is a downstream
translation that can flatten, rename, or discard Smithy semantics; this suite
checks the model that drives it.

This does mean **no test currently compares the generated OpenAPI document (or
the generated client) against an independent runtime contract** — the model→
OpenAPI codegen leg is not guarded here or anywhere else in the repository. That
is an accepted, deliberate scope boundary of a _model_-parity suite, not a
division of labour with another test. A focused OpenAPI-artifact gate, if wanted,
belongs with the OpenAPI publication work.

The suite reads a generated projection dump that the codegen cache does not
fingerprint, so `parity-helpers.ts` asserts at load time that `model.json` exists
and is at least as new as every `.smithy` source, failing with a message that
names `smithy:prepare` rather than validating a stale model or throwing a bare
`ENOENT`. The root `npm test` runs `smithy:prepare` via `pretest`; a package-local
run must generate the projection first.

`parity-helpers.ts` centralizes repeated mechanics: loading the model, resolving
shapes and mixins, reading traits, normalizing comparable Smithy/Zod constraints,
and determining Zod input/output requiredness. Domain mappings and intentional
model-only assertions stay in each domain test.

## Accepted deviations

An accepted mismatch is a named executable test, not an unmentioned exclusion.
Where both contracts exist, the assertion checks both sides and its comment
explains the rationale. Model-only invariants are labeled as such. If the model
later closes a recorded gap, the test fails until the deviation is deliberately
removed.

The Principal test currently records:

- the cache principal-id pattern is absent from Smithy;
- the cache display-name minimum length is absent from Smithy;
- Zod email validation and Smithy sensitivity are independent concerns;
- the model-only `totalMatches` nonnegative runtime invariant is absent from
  Smithy.

The Configuration test records:

- min-only integer fields are Smithy `Integer` (int32, `expectInt32`) while Zod
  permits safe integers — the normalizer drops Zod's safe-integer pseudo-maximum
  on purpose, so the gap is asserted as a named deviation instead;
- the raw PUT body tolerates and strips `lastSavedBy`, which the request model
  omits.

### Unsupported comparison dimensions

The comparable-schema normalizer carries only member/scalar type, inclusive
numeric range, and length/size. It does **not** compare pattern, string format,
exclusive bounds, union structure, or nullability; enum values are compared
separately. Those dimensions are Zod-owned and, where they differ from the model,
are recorded as named deviations above. So a green run means the compared
dimensions match — not that every constraint kind was checked. A mismatch in a
compared dimension outside an explicit deviation fails the ordinary parity
assertions.

## Domain coverage

Each domain also asserts **member target types** (and list item types) and
**enum-target linkage**, so a member silently changing scalar type (a breaking
contract change) fails, not just member-set or requiredness drift.

- `lease-template.test.ts`: Lease Template persistence, create input, threshold,
  and metadata shapes; member types + `Visibility`/`ThresholdAction` linkage; the
  `ListLeaseTemplates` pagination query bindings and `maxResults` bound
  (model-only — no independent Zod request schema).
- `configuration.test.ts`: section read/write shapes with per-field types,
  metadata, constraints, and enums; response-only TypeScript contracts and the
  int32/`lastSavedBy` deviations remain clearly model-only.
- `principals.test.ts`: cache-to-response projection with member types and
  `PrincipalType` linkage, Principal enums, the legacy query contract and HTTP
  query bindings, model-only response envelope, and accepted deviations.

## When this can be deleted

These checks become redundant only when one generated source owns both sides of
the comparison, for example when runtime request/response schemas are generated
from Smithy rather than maintained independently.
