$version: "2"

namespace com.amazon.isb

// ---------------------------------------------------------------------------
// JSend envelope
// ---------------------------------------------------------------------------
/// `success` on 2xx, `fail` on 4xx, `error` on 5xx.
enum JSendStatus {
    SUCCESS = "success"
    FAIL = "fail"
    ERROR = "error"
}

/// Failure payload. Populated for validation failures; absent on errors that
/// carry only a top-level message.
structure JSendErrorData {
    errors: FieldErrorList
}

structure FieldError {
    /// Dotted path to the rejected field, or `input` when not attributable to
    /// one field.
    field: String

    message: String
}

list FieldErrorList {
    member: FieldError
}

// ---------------------------------------------------------------------------
// Shared scalars
// ---------------------------------------------------------------------------
// `@sensitive`: encodes internal DynamoDB key material; redacted in
// generated-client/SDK logs.
/// Opaque pagination token.
@sensitive
string ContinuationToken

// `@sensitive` so generated logging redacts it.
/// An email address.
@sensitive
string OwnerEmail

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
// Responses now carry `x-amzn-errortype` for the modeled statuses the middleware
// and generated path render (400 `ValidationError`, 409 `ConflictError`, 415
// `UnsupportedMediaTypeError`, 500 `InternalServerError`), so a generated client can
// dispatch those by type. `NotFoundError` (404) deliberately omits the header so a
// response does not disclose that a resource exists, and 401/403 currently carry no
// discriminator (they are produced by middleware before the handler). All are
// modeled so the contract is complete and typed dispatch works wherever the
// discriminator is present; elsewhere callers branch on status code.
/// Request validation failed. `data.errors` carries per-field detail.
@error("client")
@httpError(400)
structure ValidationError {
    @required
    status: JSendStatus

    message: String

    data: JSendErrorData
}

/// Identity token missing, expired, invalid, or lacking required claims.
@error("client")
@httpError(401)
structure UnauthenticatedError {
    @required
    status: JSendStatus

    message: String

    data: JSendErrorData
}

/// Caller authenticated but not authorized for this operation.
@error("client")
@httpError(403)
structure AccessDeniedError {
    @required
    status: JSendStatus

    message: String

    data: JSendErrorData
}

/// The addressed resource does not exist, or the caller is not entitled to
/// learn that it exists. A PRIVATE lease template returns this rather than a 403
/// to callers without the Admin or Manager role.
@error("client")
@httpError(404)
structure NotFoundError {
    @required
    status: JSendStatus

    message: String

    data: JSendErrorData
}

@error("client")
@httpError(409)
structure ConflictError {
    @required
    status: JSendStatus

    message: String

    data: JSendErrorData
}

// Correcting the invalid/absent-payload case to 400 is deferred to the pilot cutover.
/// `Content-Type` is not a JSON media type. (An acceptable media type carrying
/// an invalid or absent payload also currently returns 415.)
@error("client")
@httpError(415)
structure UnsupportedMediaTypeError {
    @required
    status: JSendStatus

    message: String

    data: JSendErrorData
}

@error("server")
@httpError(500)
structure InternalServerError {
    @required
    status: JSendStatus

    message: String

    data: JSendErrorData
}
