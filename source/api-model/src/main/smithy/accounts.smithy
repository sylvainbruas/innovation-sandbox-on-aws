$version: "2"

namespace com.amazon.isb

use aws.protocols#restJson1

// Per-domain service for the accounts Lambda. Binds only this domain's operations,
// so the generated `AccountsApiService` types the Lambda's handler to exactly these,
// while the aggregate `IsbApi` (main.smithy) binds the same operations for the
// shared client/OpenAPI.
//
// Server-only: feeds only the `server-accounts` SSDK projection. It omits the
// `@service` (sdkId) and `@sigv4` traits that `IsbApi` carries — a client/CLI is
// generated from the aggregate `IsbApi`, never from a per-domain service (auth is
// enforced by middleware ahead of the Smithy handler).
//
// Accepted deviations (documented, consistent with the other domains):
//   - `meta.schemaVersion` is dropped from the wire (persisted, never a public
//     field); the frontend reads only `meta.createdTime`/`meta.lastEditTime`.
//   - `RegisterAccount` accepts ONLY `awsAccountId`. The pre-Smithy handler used
//     `SandboxAccountSchema.omit(...).strict()`, which also accepted the other
//     valid SandboxAccount fields (all ignored). The standalone request schema
//     (Task 3.4a/b) narrows acceptance to the single field the operation uses;
//     unknown/extra keys are still rejected with 400. Registration bodies carry
//     only `awsAccountId` in practice, but this is a deliberate contract
//     narrowing, not byte-for-byte parity.
//   - `maxResults` (list operations) is parsed strictly by the generated
//     deserializer (`strictParseInt32`): a plain decimal integer only. The
//     pre-Smithy `z.coerce.number()` (JS `Number()`) coercion also accepted a
//     leading `+`, leading zeros (`01`), surrounding whitespace, and hex (`0x10`);
//     those spellings now return 400 instead of being coerced. A well-formed
//     in-range integer is unaffected. Deliberate tightening for a bounded
//     pagination cap, not byte-for-byte parity.
//
// `resourceLock` IS modeled (below): the pre-Smithy handler returned the raw store
// record, and the frontend reads `resourceLock.expiresAt` to gate the retry-cleanup
// actions (`isCleanupLockActive`), so dropping it would be a behavior regression,
// not a safe deviation.
@restJson1
@title("Innovation Sandbox on AWS — Accounts")
service AccountsApi {
    version: "2026-07-31"
    operations: [
        ListAccounts
        RegisterAccount
        GetAccount
        RetryCleanup
        EjectAccount
        QuarantineAccount
        ListUnregisteredAccounts
        ListCleanupReports
        SkipCooldown
    ]
    errors: [
        ValidationError
        UnauthenticatedError
        AccessDeniedError
        InternalServerError
    ]
}

// ---------------------------------------------------------------------------
// Shared account shapes
// ---------------------------------------------------------------------------
/// A 12-digit AWS account id.
@pattern("^[0-9]{12}$")
string AwsAccountId

/// The account's operational state (the ISB OU it sits in, excluding the
/// transient Entry/Exit OUs). Registered accounts are always one of these.
enum SandboxAccountStatus {
    AVAILABLE = "Available"
    ACTIVE = "Active"
    CLEAN_UP = "CleanUp"
    QUARANTINE = "Quarantine"
    FROZEN = "Frozen"
}

/// In-flight cleanup summary attached to an account while it is being cleaned.
structure ActiveCleanup {
    /// The cleanup phase. Open string: enumerated phases plus `NUKE_PHASE_<n>`.
    @required
    status: String

    @required
    executionArn: String

    @required
    startedAt: String
}

/// The lease currently occupying the account, when one does.
structure CurrentLease {
    @required
    leaseId: String

    @required
    ownerEmail: OwnerEmail
}

/// Deprecated legacy Step Function context, still emitted when present.
// Preserved on older DynamoDB records.
structure CleanupExecutionContext {
    @required
    stateMachineExecutionArn: String

    @required
    stateMachineExecutionStartTime: String
}

/// Record metadata. Only the timestamps are public.
// Persisted record. `schemaVersion` is intentionally dropped from the wire (see
// the service doc); it is stored but never a public field.
structure AccountMetadata {
    createdTime: String
    lastEditTime: String
}

/// Record-level optimistic lock. Timestamps are ISO 8601 strings.
// DynamoDB record-level lock. Timestamps are modeled as `String`, not `@timestamp`,
// so the wire is byte-identical to the persisted record — the frontend does
// `new Date(resourceLock.expiresAt)`.
structure ResourceLock {
    @required
    ownerId: String

    @required
    acquiredAt: String

    @required
    expiresAt: String

    /// Domain-specific context the lock owner attaches; opaque string map.
    meta: LockMeta
}

map LockMeta {
    key: String
    value: String
}

/// A registered sandbox account.
// Mirrors the persisted record minus the internal `meta.schemaVersion` (see the
// service doc); `resourceLock` is retained.
structure SandboxAccount {
    @required
    awsAccountId: AwsAccountId

    @required
    status: SandboxAccountStatus

    email: OwnerEmail

    @length(max: 50)
    name: String

    driftAtLastScan: Boolean

    activeCleanup: ActiveCleanup

    lastCleanupCompletedAt: String

    currentLease: CurrentLease

    cleanupExecutionContext: CleanupExecutionContext

    resourceLock: ResourceLock

    meta: AccountMetadata
}

list SandboxAccountList {
    member: SandboxAccount
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------
list UnregisteredAccountList {
    member: UnregisteredAccount
}

/// An AWS Organizations account in the Entry OU that has not been registered
/// with ISB. Field names mirror the Organizations API (`Id`, `Email`, `Name`).
structure UnregisteredAccount {
    @required
    Id: String

    Email: OwnerEmail

    Name: String
}

// ---------------------------------------------------------------------------
// Cleanup report projection (the public shape of `toApiResponse`)
// ---------------------------------------------------------------------------
list CleanupReportList {
    member: CleanupReport
}

/// Overall lifecycle status of a cleanup run.
enum CleanupReportStatus {
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
}

/// One appended cleanup step. `meta` carries step-specific data as an opaque map.
structure CleanupStep {
    @required
    name: String

    @required
    startedAt: String

    completedAt: String

    meta: Document
}

list CleanupStepList {
    member: CleanupStep
}

/// Counts of resources found, by phase.
map ResourceCountByType {
    key: String
    value: Integer
}

structure ResourceCount {
    @required
    totalCount: Integer

    @required
    ignoredCount: Integer

    @required
    byType: ResourceCountByType
}

structure ResourceEntry {
    @required
    arn: String

    @required
    resourceType: String

    @required
    region: String
}

list ResourceEntryList {
    member: ResourceEntry
}

list StringList {
    member: String
}

/// Resource-scan summary written after cleanup validation.
structure ResourceSummary {
    /// Validation mode in effect: `Quarantine` enforces (a failed validation
    /// quarantines the account); `Warn` surfaces remaining resources without
    /// blocking; `Silent` records metrics only. Absent if validation did not run.
    validationMode: String

    /// Resource snapshot taken before cleanup ran.
    beforeCleanup: ResourceCount

    /// Post-nuke, pre-cooldown snapshot (metrics-only). Diffed against
    /// `afterCooldown` to detect Resource Explorer staleness: resources present
    /// here but gone after cooldown are index ghosts that cleared during cooldown.
    afterCleanup: ResourceCount

    /// Post-cooldown snapshot — the enforcement/validation result. A non-empty
    /// `byType` (after exclusions) indicates a validation failure.
    afterCooldown: ResourceCount

    remainingTypes: StringList

    remainingResources: ResourceEntryList

    remainingResourcesTotalCount: Integer

    ignoredResources: ResourceEntryList

    ignoredResourcesTotalCount: Integer
}

/// A cleanup failure: the failing step and its message.
structure CleanupReportError {
    @required
    step: String

    @required
    message: String
}

/// A cleanup report.
// Public projection (`toApiResponse`). Internal fields (`pk`, `sk`, `ttl`, `meta`,
// `accessCleanupSummary`, `skipCooldownCallbackId`) are excluded.
structure CleanupReport {
    @required
    accountId: AwsAccountId

    @required
    durableExecutionArn: String

    @required
    status: CleanupReportStatus

    /// Open string: enumerated cleanup phases plus `NUKE_PHASE_<n>`.
    @required
    cleanupStatus: String

    @required
    startedAt: String

    completedAt: String

    /// Backward-compatible cleanup reason (enumerated plus legacy values).
    @required
    reasonForCleanup: String

    initiatedBy: String

    resourceSummary: ResourceSummary

    @required
    steps: CleanupStepList

    error: CleanupReportError

    cooldownSkippedBy: String
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------
/// Paginated list of registered sandbox accounts. `maxResults` caps at 2000.
@http(method: "GET", uri: "/accounts", code: 200)
@readonly
@tags(["accounts"])
// pageIdentifier/nextPageIdentifier are the pre-Smithy wire names, kept for backward compatibility (not renamed to nextToken).
@paginated(
    inputToken: "pageIdentifier"
    pageSize: "maxResults"
    outputToken: "data.nextPageIdentifier"
    items: "data.result"
)
operation ListAccounts {
    input := {
        @httpQuery("pageIdentifier")
        pageIdentifier: ContinuationToken

        @httpQuery("maxResults")
        @range(min: 1, max: 2000)
        maxResults: Integer
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: ListAccountsResult
    }
}

/// `error` is an optional validation-warning string forwarded verbatim; a
/// non-contractual diagnostic, not a failure.
// Store-side warning: the pre-Smithy handler returned the raw store result. Modeled
// to keep the response byte-faithful.
structure ListAccountsResult {
    @required
    result: SandboxAccountList

    nextPageIdentifier: ContinuationToken

    error: String
}

/// Get a single registered account by id. 404 when it does not exist.
@http(method: "GET", uri: "/accounts/{awsAccountId}", code: 200)
@readonly
@tags(["accounts"])
operation GetAccount {
    input := {
        @required
        @httpLabel
        awsAccountId: AwsAccountId
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: SandboxAccount
    }

    errors: [
        NotFoundError
    ]
}

/// Paginated list of unregistered accounts in the Entry OU. `maxResults` caps at 20.
@http(method: "GET", uri: "/accounts/unregistered", code: 200)
@readonly
@tags(["accounts"])
// pageIdentifier/nextPageIdentifier are the pre-Smithy wire names, kept for backward compatibility (not renamed to nextToken).
@paginated(
    inputToken: "pageIdentifier"
    pageSize: "maxResults"
    outputToken: "data.nextPageIdentifier"
    items: "data.result"
)
operation ListUnregisteredAccounts {
    input := {
        @httpQuery("pageIdentifier")
        pageIdentifier: ContinuationToken

        @httpQuery("maxResults")
        @range(min: 1, max: 20)
        maxResults: Integer
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: ListUnregisteredAccountsResult
    }
}

structure ListUnregisteredAccountsResult {
    @required
    result: UnregisteredAccountList

    nextPageIdentifier: ContinuationToken
}

/// Paginated recent cleanup reports for an account. `maxResults` caps at 10
/// (default 5).
@http(method: "GET", uri: "/accounts/{awsAccountId}/cleanup-reports", code: 200)
@readonly
@tags(["accounts"])
// pageIdentifier/nextPageIdentifier are the pre-Smithy wire names, kept for backward compatibility (not renamed to nextToken).
@paginated(
    inputToken: "pageIdentifier"
    pageSize: "maxResults"
    outputToken: "data.nextPageIdentifier"
    items: "data.result"
)
operation ListCleanupReports {
    input := {
        @required
        @httpLabel
        awsAccountId: AwsAccountId

        @httpQuery("pageIdentifier")
        pageIdentifier: ContinuationToken

        @httpQuery("maxResults")
        @range(min: 1, max: 10)
        maxResults: Integer
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: ListCleanupReportsResult
    }
}

structure ListCleanupReportsResult {
    @required
    result: CleanupReportList

    nextPageIdentifier: ContinuationToken
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
/// Register an AWS account with ISB. Accepts only `awsAccountId`; rejects an ISB
/// administration account (400) and unknown body keys (400, strict). Returns the
/// registered account (201). The Entry->CleanUp Organizations move surfaces a 409
/// (ConflictError) when the account is no longer where expected (someone moved it
/// out of the Entry OU) or the organization was concurrently modified — the same
/// mapping the other OU-moving actions carry.
// Accepts only `awsAccountId`: a documented contract narrowing (see the service doc).
// Retry: NOT safe to auto-retry after an ambiguous failure. The OU move and IDC
// grants run in one Transaction (rolled back on failure), but the EventBridge
// registration event is published *after* it commits — a failure there leaves the
// account registered with no event, and a retry returns an error without
// republishing it. Not marked `@idempotent`.
@http(method: "POST", uri: "/accounts", code: 201)
@tags(["accounts"])
@examples([
    {
        title: "Register an account"
        input: { awsAccountId: "123456789012" }
        output: {
            status: "success"
            // Registration moves the account Entry -> CleanUp for sanitization, so
            // the returned account is in `CleanUp`, not `Available`.
            data: { awsAccountId: "123456789012", status: "CleanUp" }
        }
    }
])
operation RegisterAccount {
    input := {
        @required
        awsAccountId: AwsAccountId
    }

    output := {
        @required
        status: JSendStatus

        @required
        data: SandboxAccount
    }

    errors: [
        ValidationError
        ConflictError
    ]
}

// ---------------------------------------------------------------------------
// Custom actions (no request body; success carries empty data)
// ---------------------------------------------------------------------------
/// Re-drive cleanup for an account. 404 when missing; 409 when not in quarantine
/// or already cleaning up.
// Retry: NOT safe to auto-retry. The cleanup event is dispatched with no dedup
// token; and when the account is already in CleanUp the OU move is skipped and the
// event dispatched directly (no preceding durable state change). The re-entrancy
// guard only blocks a *live* lock — a stuck execution's lock is expired, which is
// the case retry exists for — so two rapid retries both pass the guard and
// duplicate the dispatch before the consumer installs a new lock. Deliberately not
// `@idempotent`.
@http(method: "POST", uri: "/accounts/{awsAccountId}/retryCleanup", code: 200)
@tags(["accounts"])
operation RetryCleanup {
    input := {
        @required
        @httpLabel
        awsAccountId: AwsAccountId
    }

    output := {
        @required
        status: JSendStatus
    }

    errors: [
        NotFoundError
        ConflictError
    ]
}

/// Eject an account from ISB back to the Entry OU. 404 when missing; 409 while
/// cleanup is in progress.
// Retry: idempotent only on the fully-successful path. The OU move -> IDC revoke
// -> record delete run sequentially (not transactional); after a partial move a
// retry can fail the source-OU check and leave provisioning incomplete, and a
// retry after the delete 404s without completing any skipped step. NOT safe to
// blindly auto-retry after an ambiguous failure; not marked `@idempotent`.
@http(method: "POST", uri: "/accounts/{awsAccountId}/eject", code: 200)
@tags(["accounts"])
operation EjectAccount {
    input := {
        @required
        @httpLabel
        awsAccountId: AwsAccountId
    }

    output := {
        @required
        status: JSendStatus
    }

    errors: [
        NotFoundError
        ConflictError
    ]
}

/// Manually quarantine an account. 404 when missing; 409 when already quarantined
/// or while cleanup is in progress.
// Retry: NOT safe to auto-retry after an ambiguous failure. The event is
// published *after* the OU move commits, so a failure there leaves the account
// quarantined with no event; a retry returns 409 ("already quarantined") without
// republishing it. Not marked `@idempotent`.
@http(method: "POST", uri: "/accounts/{awsAccountId}/quarantine", code: 200)
@tags(["accounts"])
@examples([
    {
        title: "Already quarantined"
        input: { awsAccountId: "123456789012" }
        error: {
            shapeId: ConflictError
            content: {
                status: "fail"
                data: {
                    errors: [
                        {
                            message: "Account is already quarantined."
                        }
                    ]
                }
            }
        }
    }
    {
        title: "Cleanup in progress"
        input: { awsAccountId: "123456789012" }
        error: {
            shapeId: ConflictError
            content: {
                status: "fail"
                data: {
                    errors: [
                        {
                            message: "Account cannot be quarantined while cleanup is in progress."
                        }
                    ]
                }
            }
        }
    }
])
operation QuarantineAccount {
    input := {
        @required
        @httpLabel
        awsAccountId: AwsAccountId
    }

    output := {
        @required
        status: JSendStatus
    }

    errors: [
        NotFoundError
        ConflictError
    ]
}

/// Skip an account's active cleanup cooldown by resuming the durable execution.
/// 409 when there is no active cooldown or callback to resume.
// Retry: unsafe to auto-retry after an ambiguous failure. The report is updated
// (`cooldownSkippedBy`) *before* the durable-execution callback is sent. Once the
// resumed execution has propagated (the report leaves COOLING_DOWN), a later retry
// returns 409; but an immediate retry can still pass the unchanged cooldown guard
// and resend the same callback. Callback-level dedup is not established here, so
// timing decides the outcome. Not marked `@idempotent`.
@http(method: "POST", uri: "/accounts/{awsAccountId}/skipCooldown", code: 200)
@tags(["accounts"])
@examples([
    {
        title: "Cooldown skipped"
        input: { awsAccountId: "123456789012" }
        output: {
            status: "success"
            data: { message: "Cooldown skipped successfully." }
        }
    }
    {
        title: "No active cooldown"
        input: { awsAccountId: "123456789012" }
        error: {
            shapeId: ConflictError
            content: {
                status: "fail"
                data: {
                    errors: [
                        {
                            message: "Account is not in an active cooldown."
                        }
                    ]
                }
            }
        }
    }
])
operation SkipCooldown {
    input := {
        @required
        @httpLabel
        awsAccountId: AwsAccountId
    }

    output := {
        @required
        status: JSendStatus

        // Always populated on success (`{ message }`); required so generated
        // clients never handle an impossible `undefined`.
        @required
        data: SkipCooldownData
    }

    errors: [
        ConflictError
    ]
}

structure SkipCooldownData {
    @required
    message: String
}
