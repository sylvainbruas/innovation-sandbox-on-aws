#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Smoke test for one M2M client's API access via SigV4-signed requests.
#
# Per-client M2M model: each client has its own dedicated CloudFormation
# stack that creates one IAM role with its own ExternalId and trust
# policy. This script targets ONE client stack per invocation: it
# assumes that client's role and exercises a few API endpoints to
# verify RBAC enforcement matches the client's `Role` parameter.
#
# Why single-client (not fleet-wide):
#   Different clients trust different external principals. There is
#   typically no single operator identity that can assume every
#   client's role. The caller is responsible for invoking this script
#   with credentials (env vars, default profile, or --profile) that
#   the target client's TrustedPrincipal trusts.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "${SCRIPT_DIR}/_common.sh"

print_usage() {
  cat >&2 <<EOF
Usage: smoke-test.sh --client-stack <stack> [options]

Tests one M2M client by assuming its role and verifying RBAC
enforcement on a few representative endpoints.

Source-credential resolution (used to call sts:AssumeRole):
  1. --profile <name>       (explicit; matches AWS CLI convention)
  2. AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env vars
  3. AWS_PROFILE env var
  4. AWS CLI default profile / IMDS / SSO

The principal these credentials resolve to must match the client
stack's TrustedPrincipal parameter, otherwise sts:AssumeRole will
fail with AccessDenied. To list deployed client stacks under a stack
prefix, run:

  aws cloudformation list-stacks \\
    --query 'StackSummaries[?starts_with(StackName, \`InnovationSandbox-M2mClient-\`)].StackName'

Options:
  --client-stack, -c <name>   Client stack name (e.g. InnovationSandbox-M2mClient-Admin-deploy-pipeline) [required]
  --region <region>           AWS region (default: \$AWS_REGION or us-east-1)
  --profile <name>            AWS profile to use (CLI default chain otherwise)
  --verbose, -v               Print resolved values, AWS calls, and per-request signing details to stderr (credentials never printed)
  --help, -h                  Show this help

Tested endpoints (the expected status code depends on the client's Role):
  GET /accounts         200 (Admin), 403 (Manager, User)
  GET /leases           200 (Admin, Manager), 403 (User)
  GET /leaseTemplates   200 (all roles)
  GET /blueprints       200 (Admin, Manager), 403 (User)
EOF
}

CLIENT_STACK=""
REGION="${AWS_REGION:-us-east-1}"
PROFILE=""
VERBOSE="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --client-stack|-c) CLIENT_STACK="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --verbose|-v) VERBOSE="true"; shift ;;
    --help|-h) print_usage; exit 0 ;;
    *) log_err "Unknown option: $1"; print_usage; exit 2 ;;
  esac
done

if [[ -z "$CLIENT_STACK" ]]; then
  log_err "--client-stack is required"
  print_usage
  exit 2
fi

AWS_SRC_ARGS=()
[[ -n "$PROFILE" ]] && AWS_SRC_ARGS+=(--profile "$PROFILE")

debug "Region: ${REGION}"
debug "Profile: ${PROFILE:-<default chain>}"
debug "Client stack: ${CLIENT_STACK}"
if [[ "$VERBOSE" == "true" ]]; then
  CALLER=$(aws sts get-caller-identity --output json ${AWS_SRC_ARGS[@]+"${AWS_SRC_ARGS[@]}"} 2>&1 || true)
  debug "Caller identity: ${CALLER}"
fi

# Expected status code per role: "role|endpoint|expected"
EXPECTED=(
  "Admin|/accounts|200"
  "Admin|/leases|200"
  "Admin|/leaseTemplates|200"
  "Admin|/blueprints|200"
  "Manager|/accounts|403"
  "Manager|/leases|200"
  "Manager|/leaseTemplates|200"
  "Manager|/blueprints|200"
  "User|/accounts|403"
  "User|/leases|403"
  "User|/leaseTemplates|200"
  "User|/blueprints|403"
)

log_header "=== Client stack: ${CLIENT_STACK} ==="

# Resolve the stack's Role parameter and API URL
STACK_INFO=$(aws cloudformation describe-stacks \
  --stack-name "$CLIENT_STACK" \
  --region "$REGION" \
  --query "Stacks[0]" \
  --output json \
  ${AWS_SRC_ARGS[@]+"${AWS_SRC_ARGS[@]}"})

CLIENT_ROLE=$(echo "$STACK_INFO" | jq -r '.Parameters[] | select(.ParameterKey=="Role") | .ParameterValue')
API_URL=$(echo "$STACK_INFO" | jq -r '.Outputs[] | select(.OutputKey=="ApiGatewayUrl") | .OutputValue')

if [[ -z "$CLIENT_ROLE" || "$CLIENT_ROLE" == "null" ]]; then
  log_err "Stack ${CLIENT_STACK} has no Role parameter."
  exit 1
fi
if [[ -z "$API_URL" || "$API_URL" == "null" ]]; then
  log_err "Stack ${CLIENT_STACK} has no ApiGatewayUrl output."
  exit 1
fi

# Strip trailing slash so `${API_URL}${TC_ENDPOINT}` doesn't double up.
API_URL="${API_URL%/}"

log_info "Role: ${CLIENT_ROLE}, API URL: ${API_URL}"

# Assume the client's role (forward the source profile + verbose flag if set)
ASSUME_ARGS=(--client-stack "$CLIENT_STACK" --region "$REGION" --session-name "smoke-test")
[[ -n "$PROFILE" ]] && ASSUME_ARGS+=(--profile "$PROFILE")
[[ "$VERBOSE" == "true" ]] && ASSUME_ARGS+=(--verbose)
debug "assume-m2m-role.sh ${ASSUME_ARGS[*]}"
CREDS_JSON=$(bash "${SCRIPT_DIR}/assume-m2m-role.sh" "${ASSUME_ARGS[@]}")

M2M_ACCESS_KEY_ID=$(echo "$CREDS_JSON" | jq -r '.accessKeyId')
M2M_SECRET_ACCESS_KEY=$(echo "$CREDS_JSON" | jq -r '.secretAccessKey')
M2M_SESSION_TOKEN=$(echo "$CREDS_JSON" | jq -r '.sessionToken')

log_ok "Assumed role: $(echo "$CREDS_JSON" | jq -r '.roleArn')"
log_info ""

PASSED=0
FAILED=0

# Pass credentials via a curl config file rather than --user on the command
# line, so the session secret never lands in `ps` output. Mode 0600, removed
# on exit.
CRED_FILE="$(mktemp -t isb-m2m-smoke.XXXXXX)"
chmod 600 "$CRED_FILE"
trap 'rm -f "$CRED_FILE"' EXIT INT TERM
{
  printf 'user = "%s:%s"\n' "$M2M_ACCESS_KEY_ID" "$M2M_SECRET_ACCESS_KEY"
  printf 'header = "x-amz-security-token: %s"\n' "$M2M_SESSION_TOKEN"
} > "$CRED_FILE"

for tc in "${EXPECTED[@]}"; do
  IFS='|' read -r TC_ROLE TC_ENDPOINT TC_EXPECTED <<< "$tc"
  if [[ "$TC_ROLE" != "$CLIENT_ROLE" ]]; then
    continue
  fi

  URL="${API_URL}${TC_ENDPOINT}"
  debug "GET ${URL} (signed; expecting ${TC_EXPECTED})"

  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -X GET \
    --aws-sigv4 "aws:amz:${REGION}:execute-api" \
    -K "$CRED_FILE" \
    "$URL")

  if [[ "$HTTP_STATUS" == "$TC_EXPECTED" ]]; then
    printf "${M2M_GREEN}[PASS]${M2M_NC} %-10s GET %-25s → %s\n" "[${TC_ROLE}]" "$TC_ENDPOINT" "$HTTP_STATUS"
    PASSED=$((PASSED + 1))
  else
    printf "${M2M_RED}[FAIL]${M2M_NC} %-10s GET %-25s → %s (expected %s)\n" "[${TC_ROLE}]" "$TC_ENDPOINT" "$HTTP_STATUS" "$TC_EXPECTED"
    FAILED=$((FAILED + 1))
  fi
done

log_info ""
TOTAL=$((PASSED + FAILED))

# Guard against a silent "All 0 checks passed!" false positive: if the
# stack's Role parameter doesn't match any entry in EXPECTED (typo, case
# mismatch, future role tier), the loop skips everything and a naive
# success report would mislead a CI runbook.
if [[ $TOTAL -eq 0 ]]; then
  log_err "No test cases matched role '${CLIENT_ROLE}'. Expected one of: Admin, Manager, User."
  exit 1
fi

log_header "--- Summary ---"
printf "Total: %d  |  Passed: %d  |  Failed: %d\n" "$TOTAL" "$PASSED" "$FAILED" >&2

if [[ $FAILED -eq 0 ]]; then
  log_ok "All ${TOTAL} checks passed!"
else
  log_err "${FAILED}/${TOTAL} checks failed"
  exit 1
fi
