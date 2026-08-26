#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Assumes an ISB M2M client role and outputs temporary credentials.
#
# Per-client M2M model: each automation client has its own dedicated
# CloudFormation stack (deployed from the IsbM2mClientStack template) that
# creates one IAM role and exports the role ARN + ExternalId. This script
# operates on one client stack per invocation.
#
# Usage:
#   ./assume-m2m-role.sh --client-stack InnovationSandbox-M2mClient-Admin-deploy-pipeline
#   source <(./assume-m2m-role.sh --client-stack <stack> --output export)
#   ./assume-m2m-role.sh --client-stack <stack> --output profile --write-profile <name>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "${SCRIPT_DIR}/_common.sh"

CLIENT_STACK=""
ROLE_ARN=""
EXTERNAL_ID=""
REGION="${AWS_REGION:-us-east-1}"
SESSION_NAME="isb-m2m-session"
DURATION_SECONDS=""
OUTPUT_MODE="json"
SOURCE_PROFILE=""
WRITE_PROFILE=""
VERBOSE="false"

print_usage() {
  cat >&2 <<EOF
Usage: assume-m2m-role.sh --client-stack <stack-name> [options]
       assume-m2m-role.sh --role-arn <arn> --external-id <id> [options]

Either --client-stack OR (--role-arn AND --external-id) must be provided.
When --client-stack is given, role ARN and ExternalId are resolved from
that stack's outputs (M2MRoleArn, M2MExternalId).

Source-credential resolution (the credentials used to call sts:AssumeRole):
  1. --profile <name>            — explicit profile (highest priority)
  2. AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env vars (and AWS_SESSION_TOKEN if set)
  3. AWS_PROFILE env var
  4. AWS CLI default profile / IMDS / SSO (the standard CLI chain)

The assumed-role credentials are NEVER written to your environment or
default profile. They are returned via --output json (default), as
shell statements via --output export, or written to a separate named
profile via --output profile --write-profile <name>.

Options:
  --client-stack, -c     Client stack name — resolves role ARN and ExternalId from outputs
  --role-arn             Full role ARN (required if no --client-stack)
  --external-id, -e      ExternalId (required if no --client-stack)
  --region               AWS region (default: \$AWS_REGION or us-east-1)
  --session-name, -s     STS session name (default: isb-m2m-session)
  --duration-seconds, -d Session duration (900-43200; default: STS default of 3600;
                         capped at the role's MaxSessionDuration regardless)
  --output, -o           Output mode: json (default), export, profile
  --profile              SOURCE AWS profile to use for sts:AssumeRole (CLI convention — credentials in)
  --write-profile        DEST AWS profile name for --output profile (defaults to isb-m2m-<clientName>)
  --verbose, -v          Print AWS calls and intermediate values to stderr (credentials are never printed)
  --help, -h             Show this help

Output modes:
  json      Print credentials as JSON to stdout (default)
  export    Print shell export statements (use with: source <(...) or eval \$(...))
  profile   Write credentials to ~/.aws/credentials under the --write-profile name
EOF
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --client-stack|-c) CLIENT_STACK="$2"; shift 2 ;;
    --role-arn) ROLE_ARN="$2"; shift 2 ;;
    --external-id|-e) EXTERNAL_ID="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --session-name|-s) SESSION_NAME="$2"; shift 2 ;;
    --duration-seconds|-d) DURATION_SECONDS="$2"; shift 2 ;;
    --output|-o) OUTPUT_MODE="$2"; shift 2 ;;
    --profile) SOURCE_PROFILE="$2"; shift 2 ;;
    --write-profile) WRITE_PROFILE="$2"; shift 2 ;;
    --verbose|-v) VERBOSE="true"; shift ;;
    --help|-h) print_usage; exit 0 ;;
    *) log_err "Unknown option: $1"; print_usage; exit 2 ;;
  esac
done

# Validate --output up front so bad input fails BEFORE any (potentially
# expensive) AWS calls.
case "$OUTPUT_MODE" in
  json|export|profile) ;;
  *) log_err "Unknown output mode '${OUTPUT_MODE}'. Use json, export, or profile."; exit 2 ;;
esac

# Validate --duration-seconds against the AWS-documented bound (900-43200).
# Going outside this range fails the AssumeRole call anyway — fail fast here
# with a helpful message.
if [[ -n "$DURATION_SECONDS" ]]; then
  if ! [[ "$DURATION_SECONDS" =~ ^[0-9]+$ ]] || (( DURATION_SECONDS < 900 )) || (( DURATION_SECONDS > 43200 )); then
    log_err "--duration-seconds must be a number between 900 and 43200 (got: '$DURATION_SECONDS')"
    exit 2
  fi
fi

# Build the AWS CLI source-credentials args. With --profile we set
# AWS_PROFILE for the child process *only* (so the user's shell env is
# untouched). Without --profile we fall through to the CLI's default chain.
AWS_SRC_ARGS=()
[[ -n "$SOURCE_PROFILE" ]] && AWS_SRC_ARGS+=(--profile "$SOURCE_PROFILE")

debug "Region: ${REGION}"
debug "Source profile: ${SOURCE_PROFILE:-<default chain>}"
if [[ "$VERBOSE" == "true" ]]; then
  CALLER=$(aws sts get-caller-identity --output json ${AWS_SRC_ARGS[@]+"${AWS_SRC_ARGS[@]}"} 2>&1 || true)
  debug "Caller identity: ${CALLER}"
fi

if [[ -z "$CLIENT_STACK" && (-z "$ROLE_ARN" || -z "$EXTERNAL_ID") ]]; then
  log_err "either --client-stack or both --role-arn and --external-id must be provided"
  print_usage
  exit 2
fi

# Resolve from client stack if provided
if [[ -n "$CLIENT_STACK" ]]; then
  log_info "Resolving from client stack: ${CLIENT_STACK}"
  debug "describe-stacks --stack-name ${CLIENT_STACK} --region ${REGION}"
  STACK_JSON=$(aws cloudformation describe-stacks \
    --stack-name "$CLIENT_STACK" \
    --region "$REGION" \
    --query "Stacks[0]" \
    --output json \
    ${AWS_SRC_ARGS[@]+"${AWS_SRC_ARGS[@]}"})

  if [[ -z "$ROLE_ARN" ]]; then
    ROLE_ARN=$(echo "$STACK_JSON" | jq -r '.Outputs[] | select(.OutputKey=="M2MRoleArn") | .OutputValue')
    if [[ -z "$ROLE_ARN" || "$ROLE_ARN" == "null" ]]; then
      log_err "Stack '${CLIENT_STACK}' does not have M2MRoleArn output."
      exit 1
    fi
  fi

  if [[ -z "$EXTERNAL_ID" ]]; then
    EXTERNAL_ID=$(echo "$STACK_JSON" | jq -r '.Outputs[] | select(.OutputKey=="M2MExternalId") | .OutputValue')
    if [[ -z "$EXTERNAL_ID" || "$EXTERNAL_ID" == "null" ]]; then
      log_err "Stack '${CLIENT_STACK}' does not have M2MExternalId output."
      exit 1
    fi
  fi

  # Default write-profile name: derive from the client stack's `ClientName`
  # parameter (the canonical source). Falls back to deriving from the stack
  # name shape `<prefix>-M2mClient-<Role>-<clientName>` if the parameter is
  # absent — clientName is everything after `-M2mClient-<Role>-` so client
  # names with hyphens (e.g. `deploy-pipeline-prod`) round-trip correctly.
  if [[ -z "$WRITE_PROFILE" ]]; then
    CLIENT_NAME=$(echo "$STACK_JSON" | jq -r '.Parameters[]? | select(.ParameterKey=="ClientName") | .ParameterValue')
    if [[ -z "$CLIENT_NAME" || "$CLIENT_NAME" == "null" ]]; then
      # Fall back to parsing the stack name. If it doesn't follow the
      # `<prefix>-M2mClient-<Role>-<clientName>` convention, sed leaves the
      # whole stack name as-is, which would yield a confusing
      # WRITE_PROFILE="isb-m2m-<full-stack-name>". Detect that case and use
      # a generic name with a warning instead.
      DERIVED=$(echo "$CLIENT_STACK" | sed -E 's/^.*-M2mClient-(Admin|Manager|User)-//')
      if [[ "$DERIVED" == "$CLIENT_STACK" ]]; then
        log_warn "Stack '${CLIENT_STACK}' has no ClientName parameter and does not match the conventional shape '<prefix>-M2mClient-<Role>-<clientName>'. Falling back to generic profile name; pass --write-profile <name> to override."
        WRITE_PROFILE="isb-m2m"
      else
        WRITE_PROFILE="isb-m2m-${DERIVED}"
      fi
    else
      WRITE_PROFILE="isb-m2m-${CLIENT_NAME}"
    fi
  fi
fi

# Fallback write-profile name if explicit args were used and --write-profile not set
if [[ -z "$WRITE_PROFILE" ]]; then
  WRITE_PROFILE="isb-m2m"
fi

# Reject the [default] profile early — before AssumeRole — so a typo doesn't
# spend an STS call. Case-insensitive: AWS profile names are technically
# case-sensitive, but writing temp creds to "Default" / "DEFAULT" is almost
# certainly a typo for "default" rather than a deliberate distinct profile.
WRITE_PROFILE_LC="$(printf '%s' "$WRITE_PROFILE" | tr '[:upper:]' '[:lower:]')"
if [[ "$OUTPUT_MODE" == "profile" && "$WRITE_PROFILE_LC" == "default" ]]; then
  log_err "Refusing to write assumed credentials to a profile named '${WRITE_PROFILE}' (case-insensitive match on 'default')."
  log_err "Use --write-profile <name> to specify a different profile."
  exit 2
fi

log_info "Assuming role: ${ROLE_ARN}"
debug "ExternalId: ${EXTERNAL_ID}"
debug "Session name: ${SESSION_NAME}"
debug "Output mode: ${OUTPUT_MODE}"
[[ -n "$DURATION_SECONDS" ]] && debug "Duration: ${DURATION_SECONDS}s"
[[ "$OUTPUT_MODE" == "profile" ]] && debug "Write profile: ${WRITE_PROFILE}"

ASSUME_ROLE_ARGS=(
  --role-arn "$ROLE_ARN"
  --role-session-name "$SESSION_NAME"
  --external-id "$EXTERNAL_ID"
  --region "$REGION"
  --output json
)
[[ -n "$DURATION_SECONDS" ]] && ASSUME_ROLE_ARGS+=(--duration-seconds "$DURATION_SECONDS")

CREDS=$(aws sts assume-role "${ASSUME_ROLE_ARGS[@]}" ${AWS_SRC_ARGS[@]+"${AWS_SRC_ARGS[@]}"})

ACCESS_KEY_ID=$(echo "$CREDS" | jq -r '.Credentials.AccessKeyId')
SECRET_ACCESS_KEY=$(echo "$CREDS" | jq -r '.Credentials.SecretAccessKey')
SESSION_TOKEN=$(echo "$CREDS" | jq -r '.Credentials.SessionToken')
EXPIRATION=$(echo "$CREDS" | jq -r '.Credentials.Expiration')
debug "AssumeRole succeeded; expiration=${EXPIRATION} (credentials redacted from output)"

case "$OUTPUT_MODE" in
  json)
    jq -n \
      --arg ak "$ACCESS_KEY_ID" \
      --arg sk "$SECRET_ACCESS_KEY" \
      --arg st "$SESSION_TOKEN" \
      --arg exp "$EXPIRATION" \
      --arg arn "$ROLE_ARN" \
      '{accessKeyId: $ak, secretAccessKey: $sk, sessionToken: $st, expiration: $exp, roleArn: $arn}'
    ;;
  export)
    echo "export AWS_ACCESS_KEY_ID='${ACCESS_KEY_ID}'"
    echo "export AWS_SECRET_ACCESS_KEY='${SECRET_ACCESS_KEY}'"
    echo "export AWS_SESSION_TOKEN='${SESSION_TOKEN}'"
    log_info "# Expires: ${EXPIRATION}"
    log_info "# Role: ${ROLE_ARN}"
    ;;
  profile)
    aws configure set aws_access_key_id "$ACCESS_KEY_ID" --profile "$WRITE_PROFILE"
    aws configure set aws_secret_access_key "$SECRET_ACCESS_KEY" --profile "$WRITE_PROFILE"
    aws configure set aws_session_token "$SESSION_TOKEN" --profile "$WRITE_PROFILE"
    aws configure set region "$REGION" --profile "$WRITE_PROFILE"
    log_ok "Credentials written to profile [${WRITE_PROFILE}]"
    log_info "Use with: --profile ${WRITE_PROFILE}"
    log_info "Expires: ${EXPIRATION}"
    ;;
esac
