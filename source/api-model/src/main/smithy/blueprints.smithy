$version: "2"

namespace com.amazon.isb

use aws.protocols#restJson1

// Per-domain service for the blueprints Lambda. Binds only this domain's
// operations, so the generated `BlueprintsApiService` types the Lambda's handler
// to exactly these, while the aggregate `IsbApi` (main.smithy) binds the same
// operations for the shared client/OpenAPI.
//
// Server-only: feeds only the `server-blueprints` SSDK projection. It omits the
// `@service` (sdkId) and `@sigv4` traits that `IsbApi` carries (auth is enforced
// by middleware ahead of the Smithy handler).
//
// Routing note (server, not model): `GET /blueprints/stacksets` is a path LITERAL
// that collides with `GET /blueprints/{blueprintId}` (a label). As with
// `/accounts/unregistered` and `/leases/shared`, the generated mux ranks by
// segment count only, so the handler applies the shared `preferLiteralRoutes`
// helper to keep the literal ahead of the label. The model just declares both URIs.
//
// Accepted deviations (documented, consistent with the other domains):
//   - Internal DynamoDB fields are dropped from the wire. The pre-Smithy handler
//     returned the RAW store items, so `PK`, `SK`, and `itemType` (on `Blueprint`
//     and `StackSetConfig`) and additionally `ttl` + `meta` (on `DeploymentHistory`)
//     currently appear in responses. No consumer reads them — the frontend view
//     types omit them entirely — so the modeled wire omits them. Observable, but
//     no current consumer impact (same class as the other domains' internal-field
//     drops).
//   - `meta.schemaVersion` IS retained here (unlike Accounts/Configurations): the
//     frontend `Blueprint`/`StackSetConfig` types read `meta.schemaVersion`.
//   - Timestamps are modeled as raw `String` (byte-faithful passthrough), not
//     `@timestamp`, matching the persisted ISO strings.
//   - `maxResults` (list operations) is parsed strictly by the generated
//     deserializer (`strictParseInt32`); the pre-Smithy `z.coerce.number()`
//     coercion also accepted `+1`/`01`/whitespace/`0x10`. Deliberate cross-domain
//     pagination tightening, not byte-for-byte parity.
//   - `ListBlueprints` returns its collection under `blueprints` (not `result`),
//     reproducing the pre-Smithy handler exactly. Register/Update inputs are
//     modeled STANDALONE (the StackSet-level params — `maxConcurrentPercentage`,
//     `failureTolerancePercentage`, `concurrencyMode` — live on the API input on
//     their own terms, not derived from the persistence entity).
//   - Request validation the model CAN express is now model-owned, so its failure
//     messages are the generated ones, not the pre-Smithy Zod wording: `name` and
//     `stackSetId` (`@length`/`@pattern`), `regions` (`@length(min:1)`), the tag
//     count/key/value (`@length`/`@pattern`), and `blueprintId` (the RFC `@pattern`).
//     All remain 400 `ValidationError`. The retained Zod re-parse owns only what the
//     model cannot express — the reserved `aws:` tag-prefix refinement and strict
//     unknown-key rejection — plus, when it fires first, those keep their Zod message.
//   - A body member sent with the wrong JSON type (e.g. a string for
//     `deploymentTimeoutMinutes`) is rejected at the restJson1 deserialization layer
//     as a generic 400 (`"Invalid JSON in request body…"`, no per-field detail),
//     where the pre-Smithy Zod re-parse gave a field-specific error. Inherent to the
//     generated restJson1 path unless a custom deserializer/shim is added; still 400.
//   - `nextPageIdentifier` is `null` in the store when there is no next page; the
//     serializer drops null members, so it is absent on the wire (→ `undefined` at
//     the client). Optional pagination field; no consumer distinguishes null from
//     absence.
@restJson1
@title("Innovation Sandbox on AWS — Blueprints")
service BlueprintsApi {
    version: "2026-07-31"
    operations: [
        ListStackSets
        ListBlueprints
        RegisterBlueprint
        GetBlueprint
        UpdateBlueprint
        DeleteBlueprint
    ]
    errors: [
        ValidationError
        UnauthenticatedError
        AccessDeniedError
        InternalServerError
    ]
}

// ---------------------------------------------------------------------------
// Shared blueprint scalars & enums
// ---------------------------------------------------------------------------
// The pattern mirrors the persisted `z.uuid()` refinement (the RFC layout it enforces),
// so an RFC-invalid id is rejected at the edge rather than reaching the store and
// returning 404. Keep in sync with zod's `uuid` regex.
/// A blueprint id — the server-generated UUID. The pattern is the exact RFC layout
/// (versions 1–8, variant 8/9/a/b, plus the nil and max UUIDs), so a hex-shaped but
/// RFC-invalid id is rejected 400 rather than returning 404.
@pattern("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$")
string BlueprintId

/// CloudFormation StackSet region-deployment ordering.
enum RegionConcurrencyType {
    SEQUENTIAL = "SEQUENTIAL"
    PARALLEL = "PARALLEL"
}

/// CloudFormation StackSet concurrency mode — how concurrency reacts to failures.
enum ConcurrencyMode {
    STRICT_FAILURE_TOLERANCE = "STRICT_FAILURE_TOLERANCE"
    SOFT_FAILURE_TOLERANCE = "SOFT_FAILURE_TOLERANCE"
}

/// StackSet-operation deployment status (mirrors the CloudFormation values).
enum DeploymentStatus {
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    QUEUED = "QUEUED"
}

// The reserved `aws:` prefix rule stays a Zod-only refinement (not expressible as a
// pattern here).
/// Tag key: 1–128 chars from the CloudFormation-tag character set. The reserved
/// `aws:` prefix is not allowed.
@length(min: 1, max: 128)
@pattern("^[a-zA-Z0-9_:./@ +=$%&*()\\[\\]{}|\\\\!#^~?-]+$")
string BlueprintTagKey

/// Tag value: up to 256 chars from the same set (empty allowed).
@length(max: 256)
@pattern("^[a-zA-Z0-9_:./@ +=$%&*()\\[\\]{}|\\\\!#^~?-]*$")
string BlueprintTagValue

// At most 10 (matches the persisted Zod refinement).
/// Up to 10 key-value tags.
@length(max: 10)
map BlueprintTags {
    key: BlueprintTagKey
    value: BlueprintTagValue
}

// Matches the register schema's `regions.min(1)`.
/// At least one region.
@length(min: 1)
list RegionList {
    member: String
}

// Unlike the other domains, `schemaVersion` is retained on the wire here (the frontend
// reads it). Timestamps are raw ISO strings (byte-faithful passthrough of the persisted
// values), not `@timestamp`.
/// Record metadata. Timestamps are ISO 8601 strings.
structure BlueprintMetadata {
    @required
    schemaVersion: Integer

    @required
    createdTime: String

    @required
    lastEditTime: String
}

// ---------------------------------------------------------------------------
// Blueprint entity (BlueprintItem projection, minus internal PK/SK/itemType)
// ---------------------------------------------------------------------------
/// Aggregated blueprint health metrics (computed from all StackSets).
structure BlueprintHealthMetrics {
    @required
    totalDeploymentCount: Double

    @required
    totalSuccessfulCount: Double

    lastDeploymentAt: String
}

// Mirrors the persisted `BlueprintItem` minus the internal `PK`/`SK`/`itemType`
// (see the service doc).
/// A registered blueprint.
structure Blueprint {
    @required
    blueprintId: BlueprintId

    @required
    @length(min: 1, max: 50)
    @pattern("^[a-zA-Z][a-zA-Z0-9-]{0,49}$")
    name: String

    /// Key-value tags for the blueprint.
    tags: BlueprintTags

    @required
    createdBy: OwnerEmail

    @required
    @range(min: 5, max: 480)
    deploymentTimeoutMinutes: Double

    @required
    regionConcurrencyType: RegionConcurrencyType

    @required
    totalHealthMetrics: BlueprintHealthMetrics

    meta: BlueprintMetadata
}

// ---------------------------------------------------------------------------
// StackSet configuration (StackSetItem projection, minus internal PK/SK/itemType)
// ---------------------------------------------------------------------------
/// Per-StackSet health metrics.
structure StackSetHealthMetrics {
    @required
    deploymentCount: Double

    @required
    successfulDeploymentCount: Double

    lastFailureAt: String

    lastSuccessAt: String

    @required
    consecutiveFailures: Double
}

// Mirrors the persisted `StackSetItem` minus the internal `PK`/`SK`/`itemType`.
/// A blueprint's StackSet configuration.
structure StackSetConfig {
    @required
    blueprintId: BlueprintId

    @required
    stackSetId: String

    @required
    administrationRoleArn: String

    @required
    executionRoleName: String

    @required
    regions: RegionList

    @required
    deploymentOrder: Double

    @required
    maxConcurrentPercentage: Integer

    @required
    failureTolerancePercentage: Integer

    @required
    concurrencyMode: ConcurrencyMode

    @required
    healthMetrics: StackSetHealthMetrics

    meta: BlueprintMetadata
}

list StackSetConfigList {
    member: StackSetConfig
}

// ---------------------------------------------------------------------------
// Deployment history (DeploymentHistoryItem projection, minus PK/SK/itemType/ttl/meta)
// ---------------------------------------------------------------------------
structure DeploymentHistory {
    @required
    stackSetId: String

    @required
    leaseId: String

    @required
    accountId: String

    @required
    status: DeploymentStatus

    @required
    operationId: String

    @required
    deploymentStartedAt: String

    deploymentCompletedAt: String

    duration: Double

    errorType: String

    errorMessage: String
}

list DeploymentHistoryList {
    member: DeploymentHistory
}

/// The composite a read path returns: the blueprint, its StackSets, and the most
/// recent deployments.
structure BlueprintWithStackSets {
    @required
    blueprint: Blueprint

    @required
    stackSets: StackSetConfigList

    recentDeployments: DeploymentHistoryList
}

list BlueprintWithStackSetsList {
    member: BlueprintWithStackSets
}

// ---------------------------------------------------------------------------
// StackSet discovery (CloudFormation passthrough for the registration wizard)
// ---------------------------------------------------------------------------
/// A CloudFormation StackSet summary. `status`/`permissionModel` are open strings
/// (CloudFormation passthroughs; `permissionModel` may be absent in member accounts).
structure StackSetSummary {
    @required
    stackSetName: String

    @required
    stackSetId: String

    description: String

    status: String

    permissionModel: String
}

list StackSetSummaryList {
    member: StackSetSummary
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------
/// Paginated CloudFormation StackSets available to attach to a blueprint.
/// `maxResults` caps at 100.
@http(method: "GET", uri: "/blueprints/stacksets", code: 200)
@readonly
@tags(["blueprints"])
@examples([
    {
        title: "Discover available StackSets"
        output: {
            status: "success"
            data: {
                result: [
                    {
                        stackSetName: "my-stackset"
                        stackSetId: "12345678-1234-1234-1234-123456789012"
                        status: "ACTIVE"
                        permissionModel: "SELF_MANAGED"
                    }
                ]
            }
        }
    }
])
// pageIdentifier/nextPageIdentifier are the pre-Smithy wire names, kept for backward compatibility (not renamed to nextToken).
@paginated(
    inputToken: "pageIdentifier"
    pageSize: "maxResults"
    outputToken: "data.nextPageIdentifier"
    items: "data.result"
)
operation ListStackSets {
    input := {
        @httpQuery("pageIdentifier")
        pageIdentifier: ContinuationToken

        @httpQuery("maxResults")
        @range(min: 1, max: 100)
        maxResults: Integer
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: ListStackSetsResult
    }
}

structure ListStackSetsResult {
    @required
    result: StackSetSummaryList

    nextPageIdentifier: ContinuationToken
}

// The `blueprints` collection name (not `result`) reproduces the pre-Smithy handler.
/// Paginated list of registered blueprints (each with its StackSets). `maxResults`
/// caps at 100. The collection is returned under `blueprints` (not `result`).
@http(method: "GET", uri: "/blueprints", code: 200)
@readonly
@tags(["blueprints"])
// pageIdentifier/nextPageIdentifier are the pre-Smithy wire names, kept for backward compatibility (not renamed to nextToken).
@paginated(
    inputToken: "pageIdentifier"
    pageSize: "maxResults"
    outputToken: "data.nextPageIdentifier"
    items: "data.blueprints"
)
operation ListBlueprints {
    input := {
        @httpQuery("pageIdentifier")
        pageIdentifier: ContinuationToken

        @httpQuery("maxResults")
        @range(min: 1, max: 100)
        maxResults: Integer
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: ListBlueprintsResult
    }
}

structure ListBlueprintsResult {
    @required
    blueprints: BlueprintWithStackSetsList

    nextPageIdentifier: ContinuationToken
}

/// Get a single blueprint (with StackSets and recent deployments) by id. 404 when
/// it does not exist.
@http(method: "GET", uri: "/blueprints/{blueprintId}", code: 200)
@readonly
@tags(["blueprints"])
operation GetBlueprint {
    input := {
        @required
        @httpLabel
        blueprintId: BlueprintId
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: BlueprintWithStackSets
    }

    errors: [
        NotFoundError
    ]
}

// ---------------------------------------------------------------------------
// Registration & update (body-bearing writes; a strict Zod re-parse runs on top)
// ---------------------------------------------------------------------------
/// Register a blueprint from an existing CloudFormation StackSet. Returns the
/// created blueprint (201). A missing StackSet is 404; a SERVICE_MANAGED (or
/// otherwise unsupported) permission model is 400.
/// Retry: not idempotent — a re-POST creates another blueprint.
@http(method: "POST", uri: "/blueprints", code: 201)
@tags(["blueprints"])
@examples([
    {
        title: "Register a blueprint"
        input: {
            name: "Web-Application-Blueprint"
            stackSetId: "12345678-1234-1234-1234-123456789012"
            regions: ["us-east-1", "us-west-2"]
            tags: { environment: "production", team: "platform" }
            deploymentTimeoutMinutes: 60
            regionConcurrencyType: "SEQUENTIAL"
            maxConcurrentPercentage: 100
            failureTolerancePercentage: 0
            concurrencyMode: "STRICT_FAILURE_TOLERANCE"
        }
        output: {
            status: "success"
            data: {
                blueprintId: "12345678-90ab-4cde-8f12-34567890abcd"
                name: "Web-Application-Blueprint"
                createdBy: "admin@example.com"
                deploymentTimeoutMinutes: 60
                regionConcurrencyType: "SEQUENTIAL"
                totalHealthMetrics: { totalDeploymentCount: 0, totalSuccessfulCount: 0 }
                tags: { environment: "production", team: "platform" }
                meta: { schemaVersion: 1, createdTime: "2023-05-01T12:00:00Z", lastEditTime: "2023-05-01T12:00:00Z" }
            }
        }
    }
    {
        title: "StackSet not found"
        input: {
            name: "Web-Application-Blueprint"
            stackSetId: "12345678-1234-1234-1234-123456789012"
            regions: ["us-east-1", "us-west-2"]
        }
        error: {
            shapeId: com.amazon.isb#NotFoundError
            content: {
                status: "fail"
                data: {
                    errors: [
                        {
                            message: "StackSet ID 'stackset-id' not found. If the StackSet was deleted and recreated, the blueprint must be deregistered and re-registered with the new StackSet ID."
                        }
                    ]
                }
            }
        }
    }
])
operation RegisterBlueprint {
    input := {
        @required
        @length(min: 1, max: 50)
        @pattern("^[a-zA-Z][a-zA-Z0-9-]{0,49}$")
        name: String

        @required
        @length(min: 1)
        stackSetId: String

        @required
        regions: RegionList

        tags: BlueprintTags

        @range(min: 5, max: 480)
        deploymentTimeoutMinutes: Double

        regionConcurrencyType: RegionConcurrencyType

        @range(min: 1, max: 100)
        maxConcurrentPercentage: Integer

        @range(min: 0, max: 100)
        failureTolerancePercentage: Integer

        concurrencyMode: ConcurrencyMode
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: Blueprint
    }

    errors: [
        ValidationError
        NotFoundError
    ]
}

/// Update a blueprint's mutable fields (and, when supplied, its StackSet-level
/// deployment parameters). PATCH-style: every body member is optional. 404 when the
/// blueprint does not exist.
/// Retry: intentionally not `@idempotent` despite the legacy PUT method. Each call
/// performs a partial read-modify-write and refreshes `meta.lastEditTime`, so retrying
/// after an ambiguous response can apply another write or overwrite a concurrent edit.
@http(method: "PUT", uri: "/blueprints/{blueprintId}", code: 200)
@tags(["blueprints"])
operation UpdateBlueprint {
    input := {
        @required
        @httpLabel
        blueprintId: BlueprintId

        @length(min: 1, max: 50)
        @pattern("^[a-zA-Z][a-zA-Z0-9-]{0,49}$")
        name: String

        tags: BlueprintTags

        @range(min: 5, max: 480)
        deploymentTimeoutMinutes: Double

        regionConcurrencyType: RegionConcurrencyType

        @range(min: 1, max: 100)
        maxConcurrentPercentage: Integer

        @range(min: 0, max: 100)
        failureTolerancePercentage: Integer

        concurrencyMode: ConcurrencyMode
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: BlueprintWithStackSets
    }

    errors: [
        ValidationError
        NotFoundError
    ]
}

/// Unregister (delete) a blueprint. 404 when it does not exist; 409 when it is still
/// in use by one or more lease templates.
@http(method: "DELETE", uri: "/blueprints/{blueprintId}", code: 200)
@idempotent
@tags(["blueprints"])
@examples([
    {
        title: "Unregister a blueprint"
        input: { blueprintId: "12345678-90ab-4cde-8f12-34567890abcd" }
        output: {
            status: "success"
            data: { message: "Blueprint unregistered successfully", blueprintId: "12345678-90ab-4cde-8f12-34567890abcd" }
        }
    }
    {
        title: "Blueprint still in use"
        input: { blueprintId: "12345678-90ab-4cde-8f12-34567890abcd" }
        error: {
            shapeId: com.amazon.isb#ConflictError
            content: {
                status: "fail"
                data: {
                    errors: [
                        {
                            message: "Cannot delete blueprint - currently attached to lease templates"
                        }
                    ]
                }
            }
        }
    }
])
operation DeleteBlueprint {
    input := {
        @required
        @httpLabel
        blueprintId: BlueprintId
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: DeleteBlueprintData
    }

    errors: [
        NotFoundError
        ConflictError
    ]
}

// The pre-Smithy handler returns a confirmation message plus the deleted blueprint id
// (not `data: null`).
/// The delete success payload: a confirmation message plus the deleted blueprint id.
structure DeleteBlueprintData {
    @required
    message: String

    @required
    blueprintId: BlueprintId
}
