#!/usr/bin/env bash
set -euo pipefail

# executor.sh - Thin wrapper: delegates to Node phase runner
# Usage: executor.sh <project> <plan-id> [verdict-file]
#        executor.sh <project> --job-id <job-id> [verdict-file]

CPB_EXECUTOR_ROOT="${CPB_EXECUTOR_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CPB_ROOT="${CPB_ROOT:-$CPB_EXECUTOR_ROOT}"

PROJECT="${1:?Usage: executor.sh <project> <plan-id|--job-id <job-id>> [verdict-file]}"
shift

cmd=(
  node "$CPB_EXECUTOR_ROOT/bridges/run-phase.mjs"
  execute
  --executor-root "$CPB_EXECUTOR_ROOT"
  --cpb-root "$CPB_ROOT"
  --project "$PROJECT"
)

if [ "${1:-}" = "--job-id" ]; then
  cmd+=(--job-id "${2:?Usage: executor.sh <project> --job-id <job-id>}")
  shift 2
else
  cmd+=(--plan-id "${1:?Usage: executor.sh <project> <plan-id>}")
  shift
fi

VERDICT_FILE="${1:-}"
[ -n "$VERDICT_FILE" ] && cmd+=(--verdict-file "$VERDICT_FILE")

exec "${cmd[@]}"
