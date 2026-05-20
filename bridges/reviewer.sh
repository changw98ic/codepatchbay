#!/usr/bin/env bash
set -euo pipefail

# reviewer.sh - Thin wrapper: delegates to Node phase runner
# Usage: reviewer.sh <project> <deliverable-id>

CPB_EXECUTOR_ROOT="${CPB_EXECUTOR_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CPB_ROOT="${CPB_ROOT:-$CPB_EXECUTOR_ROOT}"

PROJECT="${1:?Usage: reviewer.sh <project> <deliverable-id>}"
DELIVERABLE_ID="${2:?Usage: reviewer.sh <project> <deliverable-id>}"

exec node "$CPB_EXECUTOR_ROOT/bridges/run-phase.mjs" \
  review \
  --executor-root "$CPB_EXECUTOR_ROOT" \
  --cpb-root "$CPB_ROOT" \
  --project "$PROJECT" \
  --deliverable-id "$DELIVERABLE_ID"
