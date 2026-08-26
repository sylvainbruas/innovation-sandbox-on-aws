#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Lists deployed M2M client stacks in the current account/region.
#
# Discovery queries IAM directly (not resourcegroupstaggingapi) for roles
# tagged with three CDK-emitted tags (no separate registry):
#   aws-solutions:isb-stack-type=M2mClient   — identifies M2M client roles
#   aws-solutions:isb-stack-name=<stackName> — resolves the role back to its stack
#   aws-solutions:isb-id=<namespace>_isb     — scopes to one ISB deployment
#
# Why query IAM directly:
#   - resourcegroupstaggingapi is eventually consistent for IAM (lags
#     minutes to hours after a tag change). IAM list-roles + tag fetch
#     is strongly consistent.
#   - IAM roles are one of the few resource types CFN does NOT auto-tag
#     with aws:cloudformation:stack-name, so we carry our own.
#
# This is a pure read-only view: roles are discovered via
# aws iam list-roles, the owning stack name is read from the
# aws-solutions:isb-stack-name tag, then we describe each stack to
# pull parameters + outputs.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "${SCRIPT_DIR}/_common.sh"

print_usage() {
  cat >&2 <<EOF
Usage: list-clients.sh [options]

Lists M2M client stacks for one ISB deployment in the current
account/region (discovered by the aws-solutions:isb-stack-type=M2mClient tag).

Options:
  --namespace, -n <ns>   REQUIRED. ISB deployment namespace (3-8 alphanumeric);
                         scopes the search to /isb-m2m/<ns>/ roles tagged
                         aws-solutions:isb-id=<ns>_isb
  --output, -o <fmt>     Output format: 'table' (default) or 'json'
  --region <region>      AWS region (default: \$AWS_REGION or us-east-1)
  --profile <name>       AWS profile to use (CLI default chain otherwise)
  --verbose, -v          Print the AWS calls and their results to stderr
  --help, -h             Show this help
EOF
}

NAMESPACE=""
OUTPUT="table"
REGION="${AWS_REGION:-us-east-1}"
PROFILE=""
VERBOSE="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace|-n) NAMESPACE="$2"; shift 2 ;;
    --output|-o) OUTPUT="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --verbose|-v) VERBOSE="true"; shift ;;
    --help|-h) print_usage; exit 0 ;;
    *) log_err "Unknown option: $1"; print_usage; exit 2 ;;
  esac
done

if [[ -z "$NAMESPACE" ]]; then
  log_err "--namespace is required."
  print_usage
  exit 2
fi
if ! [[ "$NAMESPACE" =~ ^[a-zA-Z0-9]{3,8}$ ]]; then
  log_err "--namespace must be 3-8 alphanumeric characters (got '$NAMESPACE')."
  exit 2
fi

case "$OUTPUT" in
  table|json) ;;
  *) log_err "--output must be 'table' or 'json' (got '$OUTPUT')"; exit 2 ;;
esac

AWS_SRC_ARGS=(--region "$REGION")
[[ -n "$PROFILE" ]] && AWS_SRC_ARGS+=(--profile "$PROFILE")

debug "Region: ${REGION}"
debug "Profile: ${PROFILE:-<default chain>}"

# Show the caller identity so users know which account is being queried.
if [[ "$VERBOSE" == "true" ]]; then
  CALLER=$(aws sts get-caller-identity --output json ${AWS_SRC_ARGS[@]+"${AWS_SRC_ARGS[@]}"} 2>&1 || true)
  debug "Caller identity:"
  echo "$CALLER" | jq . >&2 || echo "$CALLER" >&2
fi

# Discover the M2M client stacks for this namespace (see m2m_discover_stack_names
# in _common.sh: server-side path-prefix filter + name-prefix + tag checks).
# Check the exit status explicitly — inside `$(...)` set -e is disabled, so a
# failed ListRoles would otherwise surface as an empty "no clients" result.
if ! STACK_NAMES=$(m2m_discover_stack_names "$NAMESPACE" ${AWS_SRC_ARGS[@]+"${AWS_SRC_ARGS[@]}"}); then
  log_err "Failed to discover M2M client roles."
  exit 1
fi

debug "Distinct stack names: ${STACK_NAMES:-<none>}"

if [[ -z "$STACK_NAMES" ]]; then
  log_info "No M2M client stacks found for namespace '${NAMESPACE}' in ${REGION}."
  [[ "$OUTPUT" == "json" ]] && echo "[]"
  exit 0
fi

# Per-stack describe to collect parameters + outputs.
ENTRIES=()
for STACK_NAME in $STACK_NAMES; do
  STACK_JSON=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0]" \
    --output json \
    ${AWS_SRC_ARGS[@]+"${AWS_SRC_ARGS[@]}"} 2>/dev/null || true)

  if [[ -z "$STACK_JSON" ]]; then
    log_err "Skipping ${STACK_NAME} — describe-stacks failed"
    continue
  fi

  ENTRY=$(echo "$STACK_JSON" | jq --arg name "$STACK_NAME" '
    {
      StackName: $name,
      Namespace: (.Parameters[]? | select(.ParameterKey=="Namespace") | .ParameterValue),
      ClientName: (.Parameters[]? | select(.ParameterKey=="ClientName") | .ParameterValue),
      Role: (.Parameters[]? | select(.ParameterKey=="Role") | .ParameterValue),
      TrustedPrincipal: (.Parameters[]? | select(.ParameterKey=="TrustedPrincipal") | .ParameterValue),
      MaxSessionDuration: (.Parameters[]? | select(.ParameterKey=="MaxSessionDuration") | .ParameterValue),
      RoleArn: (.Outputs[]? | select(.OutputKey=="M2MRoleArn") | .OutputValue),
      ExternalId: (.Outputs[]? | select(.OutputKey=="M2MExternalId") | .OutputValue),
      ApiGatewayUrl: (.Outputs[]? | select(.OutputKey=="ApiGatewayUrl") | .OutputValue)
    }
  ')
  ENTRIES+=("$ENTRY")
done

# Combine into a single JSON array.
ALL_JSON=$(printf '%s\n' "${ENTRIES[@]}" | jq -s '.')

if [[ "$OUTPUT" == "json" ]]; then
  echo "$ALL_JSON"
  exit 0
fi

# Table output
COUNT=$(echo "$ALL_JSON" | jq 'length')
log_info ""
log_info "M2M client stacks: ${COUNT}"
log_info ""

# Print as a fixed-width table; let `column` handle alignment when present.
HEADER="StackName|Namespace|ClientName|Role|TrustedPrincipal|MaxSession|RoleArn"
ROWS=$(echo "$ALL_JSON" | jq -r '.[] | [.StackName, .Namespace, .ClientName, .Role, .TrustedPrincipal, .MaxSessionDuration, .RoleArn] | @tsv' | tr '\t' '|')

if command -v column >/dev/null 2>&1; then
  printf '%s\n%s\n' "$HEADER" "$ROWS" | column -t -s '|'
else
  printf '%s\n%s\n' "$HEADER" "$ROWS"
fi
