#!/bin/bash
# Shared utilities for Innovation Sandbox deploy/destroy scripts.
# Source this file — do not execute directly.

# =============================================================================
# Colors and logging
# =============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

timestamp() { date "+%H:%M:%S"; }

_log() {
  local color="$1"; shift
  local ts=""
  if [ "$1" = "-t" ]; then
    ts="[$(timestamp)] "
    shift
  fi
  printf "${color}${ts}%s${NC}\n" "$1"
}

log_info() { _log "$BLUE" "$@"; }
log_ok() { _log "$GREEN" "$@"; }
log_err() { _log "$RED" "$@"; }
log_warn() { _log "$YELLOW" "$@"; }

# =============================================================================
# Setup
# =============================================================================

check_dependencies() {
  for cmd in aws npm node; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      log_err "Required command '$cmd' not found in PATH"
      exit 1
    fi
  done
}

load_env() {
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
  cd "$PROJECT_ROOT" || exit

  if [ ! -f .env ]; then
    log_err "Error: .env file not found. Run 'npm run env:init' to create it."
    exit 1
  fi

  source .env

  if [ -n "$DEPLOY_REGION" ]; then
    export AWS_DEFAULT_REGION="$DEPLOY_REGION"
  fi
}

resolve_stack_names() {
  PREFIX="${STACK_PREFIX:-InnovationSandbox}"
  ACCOUNT_POOL_STACK="${PREFIX}-AccountPool"
  IDC_STACK="${PREFIX}-IDC"
  DATA_STACK="${PREFIX}-Data"
  COMPUTE_STACK="${PREFIX}-Compute"
}

# =============================================================================
# Stack configuration
# =============================================================================

get_stack_name() {
  case "$1" in
    account-pool) echo "$ACCOUNT_POOL_STACK" ;;
    idc) echo "$IDC_STACK" ;;
    data) echo "$DATA_STACK" ;;
    compute) echo "$COMPUTE_STACK" ;;
  esac
}

get_stack_profile() {
  case "$1" in
    account-pool) echo "${ORG_MANAGEMENT_ACCOUNT_PROFILE:-}" ;;
    idc) echo "${IDC_ACCOUNT_PROFILE:-}" ;;
    data|compute) echo "${HUB_ACCOUNT_PROFILE:-}" ;;
  esac
}

# =============================================================================
# CDK execution
# =============================================================================

run_cdk() {
  local action="$1"; shift
  npm run --workspace @amzn/innovation-sandbox-infrastructure cdk -- "$action" "$@"
}

# =============================================================================
# Summary
# =============================================================================

print_summary() {
  local action_label="$1"; shift
  local all_stacks=("$@")

  if [ -n "$FAILED_STACK" ]; then
    printf "\n"
    log_err "========================================"
    log_err "$action_label failed"
    log_err "========================================"

    if [ ${#SUCCEEDED_STACKS[@]} -gt 0 ]; then
      printf "Succeeded:\n"
      for s in "${SUCCEEDED_STACKS[@]}"; do
        log_ok "  $(get_stack_name "$s")"
      done
    fi

    printf "Failed:\n"
    log_err "  $(get_stack_name "$FAILED_STACK")"

    local not_attempted=()
    local past_failed=false
    for s in "${all_stacks[@]}"; do
      [ "$past_failed" = true ] && not_attempted+=("$s")
      [ "$s" = "$FAILED_STACK" ] && past_failed=true
    done

    if [ ${#not_attempted[@]} -gt 0 ]; then
      printf "Not attempted:\n"
      for s in "${not_attempted[@]}"; do
        printf "  %s\n" "$(get_stack_name "$s")"
      done
    fi
  else
    log_ok "========================================"
    log_ok "$action_label completed successfully!"
    log_ok "========================================"
  fi
}
