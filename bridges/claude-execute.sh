#!/usr/bin/env bash
set -euo pipefail

# claude-execute.sh - Thin wrapper: delegates to Node phase runner
# Usage: claude-execute.sh <project> <plan-id> [verdict-file]

CPB_EXECUTOR_ROOT="${CPB_EXECUTOR_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CPB_ROOT="${CPB_ROOT:-$CPB_EXECUTOR_ROOT}"

PROJECT="${1:?Usage: claude-execute.sh <project> <plan-id> [verdict-file]}"
PLAN_ID="${2:?Usage: claude-execute.sh <project> <plan-id> [verdict-file]}"
VERDICT_FILE="${3:-}"

cmd=(
  node "$CPB_EXECUTOR_ROOT/bridges/run-phase.mjs"
  execute
  --executor-root "$CPB_EXECUTOR_ROOT"
  --cpb-root "$CPB_ROOT"
  --project "$PROJECT"
  --plan-id "$PLAN_ID"
)
[ -n "$VERDICT_FILE" ] && cmd+=(--verdict-file "$VERDICT_FILE")

exec "${cmd[@]}"
