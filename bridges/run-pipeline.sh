#!/usr/bin/env bash
set -euo pipefail

# run-pipeline.sh — compatibility wrapper for the durable Node pipeline
# Usage: run-pipeline.sh <project> "<task>" [max-retries] [timeout-minutes]

FLOW_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=common.sh
source "$FLOW_ROOT/bridges/common.sh"

PROJECT="${1:?Usage: run-pipeline.sh <project> '<task>' [max-retries] [timeout-min]}"
TASK="${2:?Usage: run-pipeline.sh <project> '<task>' [max-retries] [timeout-min]}"
MAX_RETRIES="${3:-3}"
TIMEOUT_MIN="${4:-0}"  # 0 = no total timeout (rely on ACP idle timeout)

require_safe_name "$PROJECT"
require_project "$PROJECT"

exec node "$FLOW_ROOT/bridges/run-pipeline.mjs" \
  --project "$PROJECT" \
  --task "$TASK" \
  --max-retries "$MAX_RETRIES" \
  --timeout-min "$TIMEOUT_MIN"
)

if [ -n "$JOB_ID" ]; then
  ARGS+=(--job-id "$JOB_ID")
fi

# Pass --worktree if requested
if [ "${CPB_USE_WORKTREE:-0}" = "1" ]; then
  ARGS+=(--worktree)
fi

exec node "${ARGS[@]}"
