#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Makes a SigV4-signed API call to the ISB API Gateway using the current
# AWS credentials (from environment, profile, or default credential chain).
#
# Usage:
#   ./call-api.sh --path /leases --api-url https://abc.execute-api.us-east-1.amazonaws.com/prod/
#   ./call-api.sh --path /leases --client-stack <client-stack> --profile isb-m2m-<client>
#
# Prerequisites:
#   - AWS CLI v2
#   - curl with --aws-sigv4 support (7.75+)
#   - jq
#   - AWS credentials in environment or named profile (run assume-m2m-role.sh first)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "${SCRIPT_DIR}/_common.sh"

API_PATH=""
API_URL=""
METHOD="GET"
BODY=""
REGION="${AWS_REGION:-us-east-1}"
CLIENT_STACK=""
AWS_PROFILE_OPT=""
VERBOSE="false"

print_usage() {
  cat >&2 <<EOF
Usage: call-api.sh --path <api-path> [--api-url <url> | --client-stack <stack>] [options]

Signs and sends an API request using the current AWS credentials.
Does NOT assume a role — use assume-m2m-role.sh first to get credentials.

Either --api-url or --client-stack must be provided to determine the API endpoint.
With --client-stack, the API URL is read from the client stack's ApiGatewayUrl
output (constructed from the REST API ID imported from the Compute stack via SSM).

Options:
  --path, -p           API path, e.g. /leases [required]
  --api-url            API Gateway URL with stage [required if no --client-stack]
  --client-stack, -c   Client stack name — resolves the API URL from outputs
  --method, -m         HTTP method (default: GET)
  --body, -b           JSON request body
  --region             AWS region (default: \$AWS_REGION or us-east-1)
  --profile            AWS profile to use for credentials (e.g. isb-m2m-<client>)
  --verbose, -v        Print resolved request details to stderr (credentials and signed headers are never printed)
  --help, -h           Show this help

Examples:
  # Option 1: Use profile created by assume-m2m-role.sh --output profile
  ./call-api.sh --path /leases --client-stack <stack> --profile isb-m2m-<client>

  # Option 2: Use exported env vars
  source <(./assume-m2m-role.sh --client-stack <stack> --output export)
  ./call-api.sh --path /leases --client-stack <stack>
EOF
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --path|-p) API_PATH="$2"; shift 2 ;;
    --api-url) API_URL="$2"; shift 2 ;;
    --method|-m) METHOD="$2"; shift 2 ;;
    --body|-b) BODY="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --client-stack|-c) CLIENT_STACK="$2"; shift 2 ;;
    --profile) AWS_PROFILE_OPT="$2"; shift 2 ;;
    --verbose|-v) VERBOSE="true"; shift ;;
    --help|-h) print_usage; exit 0 ;;
    *) log_err "Unknown option: $1"; print_usage; exit 2 ;;
  esac
done

if [[ -z "$API_PATH" ]]; then
  log_err "--path is required"
  print_usage
  exit 2
fi

if [[ -z "$API_URL" && -z "$CLIENT_STACK" ]]; then
  log_err "either --api-url or --client-stack must be provided"
  print_usage
  exit 2
fi

debug "Region: ${REGION}"
debug "Profile: ${AWS_PROFILE_OPT:-<env vars / default chain>}"

# Resolve API URL from client stack if needed. The describe-stacks call
# deliberately uses the DEFAULT credential chain (env vars / AWS_PROFILE /
# default profile / IMDS / SSO) — NOT --profile when set. The reason:
# --profile here points at the assumed M2M role written by
# assume-m2m-role.sh, and that role only has execute-api:Invoke. Asking it
# to call cloudformation:DescribeStacks fails with AccessDenied. The
# operator's own credentials (whatever ran assume-m2m-role.sh) almost
# always have CFN access. If they don't, pass --api-url explicitly to skip
# the resolution step.
if [[ -z "$API_URL" && -n "$CLIENT_STACK" ]]; then
  debug "describe-stacks --stack-name ${CLIENT_STACK} --region ${REGION} (default credential chain)"
  if ! API_URL=$(aws cloudformation describe-stacks \
    --stack-name "$CLIENT_STACK" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='ApiGatewayUrl'].OutputValue" \
    --output text 2>&1); then
    log_err "Failed to resolve ApiGatewayUrl from stack '${CLIENT_STACK}':"
    log_err "  ${API_URL}"
    log_err "describe-stacks runs with the DEFAULT AWS credentials (not --profile, which targets the assumed M2M role)."
    log_err "Either configure default credentials with cloudformation:DescribeStacks access, or pass --api-url <url> explicitly."
    exit 1
  fi
  if [[ -z "$API_URL" || "$API_URL" == "None" ]]; then
    log_err "Stack '${CLIENT_STACK}' does not have ApiGatewayUrl output."
    exit 1
  fi
  debug "Resolved API URL: ${API_URL}"
fi

if [[ "$VERBOSE" == "true" && -n "$AWS_PROFILE_OPT" ]]; then
  # `aws configure get` prints the value on success — discard it; we only
  # want the exit code so the AKID itself doesn't land in operator logs.
  if aws configure get aws_access_key_id --profile "$AWS_PROFILE_OPT" >/dev/null 2>&1; then
    debug "Profile [${AWS_PROFILE_OPT}] has aws_access_key_id: yes"
  else
    debug "Profile [${AWS_PROFILE_OPT}] has aws_access_key_id: no"
  fi
fi

# Resolve credentials
if [[ -n "$AWS_PROFILE_OPT" ]]; then
  CRED_ACCESS_KEY=$(aws configure get aws_access_key_id --profile "$AWS_PROFILE_OPT" 2>/dev/null || true)
  CRED_SECRET_KEY=$(aws configure get aws_secret_access_key --profile "$AWS_PROFILE_OPT" 2>/dev/null || true)
  CRED_SESSION_TOKEN=$(aws configure get aws_session_token --profile "$AWS_PROFILE_OPT" 2>/dev/null || true)
  if [[ -z "$CRED_ACCESS_KEY" || -z "$CRED_SECRET_KEY" ]]; then
    log_err "Could not read credentials from profile '${AWS_PROFILE_OPT}'."
    log_err "Run: assume-m2m-role.sh --client-stack <stack> --output profile --write-profile ${AWS_PROFILE_OPT}"
    exit 1
  fi
else
  CRED_ACCESS_KEY="${AWS_ACCESS_KEY_ID:-}"
  CRED_SECRET_KEY="${AWS_SECRET_ACCESS_KEY:-}"
  CRED_SESSION_TOKEN="${AWS_SESSION_TOKEN:-}"
  if [[ -z "$CRED_ACCESS_KEY" || -z "$CRED_SECRET_KEY" ]]; then
    log_err "AWS credentials not found in environment."
    log_err "Run assume-m2m-role.sh --output export first, or use --profile."
    exit 1
  fi
fi

# Remove trailing slash
API_URL="${API_URL%/}"
URL="${API_URL}${API_PATH}"

log_info "Calling: ${METHOD} ${URL}"
[[ -n "$BODY" ]] && debug "Request body: ${BODY}"
debug "Signing service: execute-api / region: ${REGION}"

# Pass credentials and the session-token header via a curl config file
# (`-K <file>`) instead of the command line. `--user $AKID:$SECRET` would
# expose the session secret in the process table for any local user with
# `ps`. The config file lives in $TMPDIR with mode 0600 and is removed on
# exit (success, error, or signal).
CRED_FILE="$(mktemp -t isb-m2m-call-api.XXXXXX)"
chmod 600 "$CRED_FILE"
trap 'rm -f "$CRED_FILE"' EXIT INT TERM
{
  printf 'user = "%s:%s"\n' "$CRED_ACCESS_KEY" "$CRED_SECRET_KEY"
  if [[ -n "$CRED_SESSION_TOKEN" ]]; then
    printf 'header = "x-amz-security-token: %s"\n' "$CRED_SESSION_TOKEN"
  fi
} > "$CRED_FILE"

CURL_ARGS=(
  -s
  -X "$METHOD"
  -w '\n%{http_code}'
  --aws-sigv4 "aws:amz:${REGION}:execute-api"
  -K "$CRED_FILE"
)

# Content-Type is only meaningful when there's a body; sending it on a
# bodiless GET is harmless but pollutes the canonical request.
if [[ -n "$BODY" ]]; then
  CURL_ARGS+=(-H "Content-Type: application/json" -d "$BODY")
fi

CURL_ARGS+=("$URL")

# Capture body + status code separately. -w '\n%{http_code}' appends the
# HTTP status code on its own line so we can split the two without parsing
# the body.
RESPONSE=$(curl "${CURL_ARGS[@]}")
HTTP_STATUS="${RESPONSE##*$'\n'}"
HTTP_BODY="${RESPONSE%$'\n'*}"

# Guard against curl emitting a non-numeric or empty status (network failure,
# %{http_code} not populated). `set -u` + arithmetic on empty would crash.
if ! [[ "$HTTP_STATUS" =~ ^[0-9]+$ ]]; then
  HTTP_STATUS="000"
fi

# Pretty-print JSON body to stdout when it parses; fall back to raw text.
if echo "$HTTP_BODY" | jq . >/dev/null 2>&1; then
  echo "$HTTP_BODY" | jq .
else
  echo "$HTTP_BODY"
fi

log_info "HTTP ${HTTP_STATUS}"
if (( HTTP_STATUS < 200 || HTTP_STATUS >= 300 )); then
  exit 1
fi
