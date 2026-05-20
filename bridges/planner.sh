#!/usr/bin/env bash
set -euo pipefail

# planner.sh - Thin wrapper: delegates to Node phase runner
# Usage: planner.sh <project> "<task>"

CPB_EXECUTOR_ROOT="${CPB_EXECUTOR_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CPB_ROOT="${CPB_ROOT:-$CPB_EXECUTOR_ROOT}"

PROJECT="${1:?Usage: planner.sh <project> '<task>'}"
TASK="${2:?Usage: planner.sh <project> '<task>'}"

exec node "$CPB_EXECUTOR_ROOT/bridges/run-phase.mjs" \
  plan \
  --executor-root "$CPB_EXECUTOR_ROOT" \
  --cpb-root "$CPB_ROOT" \
  --project "$PROJECT" \
  --task "$TASK"
