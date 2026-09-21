# Service-topology parity tests

These tests guard the aggregate-vs-per-domain service topology (see
`scripts/generate.mjs` and `smithy-build.json`): the aggregate `IsbApi` service drives
the client, OpenAPI document, and (later) CLI; each per-domain `*Api` service
drives its Lambda's server bindings via a `server-<domain>` SSDK projection and
a subpath export of the committed server package.

## What must stay in lockstep

Four legs, each with a silent failure mode if it drifts:

1. **Exactly one domain-service owner per aggregate operation.** An operation in
   a domain service but not `IsbApi` is served by a Lambda yet missing from every
   SDK, the OpenAPI document, and the CLI; one in `IsbApi` with no domain service
   reaches the client but no Lambda handler is typed to implement it; one in two
   domain services violates the one-domain/one-Lambda topology.
2. **Every domain service's `errors` list equals the aggregate's.** Service-level
   errors bind to every operation and the generated server serializes them; a
   domain service silently dropping (or adding) one would change that Lambda's
   error serialization without failing anything else.
3. **Every domain service is wired to a `server-<domain>` projection.** Adding a
   service and its operations to `IsbApi` but forgetting the projection would
   otherwise build green with no server binding generated at all.
4. **Every registered domain has an exports entry in the committed server
   package.** `validateServerManifest` enforces the same at generation time;
   the test here fails earlier, without a build.

## How the model is read

The `.smithy` sources are parsed directly with `//`/`///` comments stripped
first — so a commented-out service template (e.g. a "how to add a domain"
snippet) cannot register as a real service or swallow the following real
declaration. Service bodies carry no nested braces, so a non-greedy match to the
closing brace is sufficient. `smithy-build.json` and the server `package.json`
are read as plain JSON. No build output is needed, so the suite runs without
Gradle.

## When this can change

If the topology ever collapses back to a single service + single Lambda (or a
codegen extension generates domain-scoped handlers from one service), legs 1–3
become tautological and this folder shrinks accordingly; see the "Service
topology" decision row in `smithy-migration.md` §7.
