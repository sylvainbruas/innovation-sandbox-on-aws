#!/usr/bin/env bash
#
# The C2J generator is internal tooling and is not publicly available.
# Internal checkouts use it to verify that the committed AWS CLI model still
# matches the Smithy source.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GENERATOR="$SCRIPT_DIR/internal/generate-c2j.sh"

[[ -x "$GENERATOR" ]] || exit 0

command -v brazil >/dev/null \
  || { printf 'verify-c2j-drift: Brazil is required in an internal checkout.\n' >&2; exit 1; }

exec "$GENERATOR" --check
