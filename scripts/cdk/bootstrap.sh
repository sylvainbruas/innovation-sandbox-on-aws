#!/bin/bash
set -e
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

# =============================================================================
# Bootstrap-specific functions
# =============================================================================

show_help() {
  cat <<EOF
Innovation Sandbox - CDK Bootstrap

Bootstraps the CDK toolkit stack in the target AWS account(s) and region.
Uses DEPLOY_REGION and profile settings from .env.

Usage:
  ./scripts/bootstrap.sh               Bootstrap all accounts
  ./scripts/bootstrap.sh hub           Bootstrap only the Hub account
  ./scripts/bootstrap.sh org           Bootstrap only the Org Management account
  ./scripts/bootstrap.sh idc           Bootstrap only the IDC account

Options:
  --help, -h             Show this help message
EOF
  exit 0
}

validate_required_vars() {
  if [ -z "$DEPLOY_REGION" ]; then
    log_err "DEPLOY_REGION is not set in .env"
    exit 1
  fi
}

bootstrap_account() {
  local label="$1"
  local profile="$2"
  local args=()

  [ -n "$profile" ] && args+=(--profile "$profile")

  if [ -n "$STACK_TAGS" ]; then
    read -ra TAG_ARRAY <<< "$STACK_TAGS"
    for tag in "${TAG_ARRAY[@]}"; do
      args+=(--tags "$tag")
    done
  fi

  log_info "Bootstrapping ${label}..."
  run_cdk bootstrap "${args[@]}"
  log_ok "${label} bootstrapped"
}

# =============================================================================
# Execution
# =============================================================================

TARGETS=()

for arg in "$@"; do
  case "$arg" in
    --help|-h) show_help ;;
    hub|org|idc) TARGETS+=("$arg") ;;
    all) TARGETS=(hub org idc) ;;
    *)
      printf "${RED}Unknown argument: %s${NC}\n" "$arg"
      printf "Usage: %s [hub|org|idc|all] [--help]\n" "$0"
      exit 1
      ;;
  esac
done

if [ ${#TARGETS[@]} -eq 0 ]; then
  TARGETS=(hub org idc)
fi

check_dependencies
load_env
validate_required_vars

# Deduplicate targets by profile (same profile = same account/region, only bootstrap once)
SEEN_PROFILES=()
for target in "${TARGETS[@]}"; do
  case "$target" in
    hub) label="Hub account"; profile="${HUB_ACCOUNT_PROFILE:-}" ;;
    org) label="Org Management account"; profile="${ORG_MANAGEMENT_ACCOUNT_PROFILE:-}" ;;
    idc) label="IDC account"; profile="${IDC_ACCOUNT_PROFILE:-}" ;;
  esac

  # Skip if we've already bootstrapped this profile
  profile_key="${profile:-default}"
  skip=false
  for seen in "${SEEN_PROFILES[@]}"; do
    if [ "$seen" = "$profile_key" ]; then
      skip=true
      break
    fi
  done

  if [ "$skip" = true ]; then
    log_info "Skipping ${label} (same account as already bootstrapped)"
    continue
  fi

  SEEN_PROFILES+=("$profile_key")
  bootstrap_account "$label" "$profile"
done
