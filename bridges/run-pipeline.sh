#!/usr/bin/env bash
set -euo pipefail

# run-pipeline.sh — compatibility wrapper for the durable Node pipeline
# Usage: run-pipeline.sh <project> "<task>" [max-retries] [timeout-minutes] [workflow]

CPB_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=common.sh
source "$CPB_ROOT/bridges/common.sh"

PROJECT="${1:?Usage: run-pipeline.sh <project> '<task>' [max-retries] [timeout-min] [workflow]}"
TASK="${2:?Usage: run-pipeline.sh <project> '<task>' [max-retries] [timeout-min] [workflow]}"
MAX_RETRIES="${3:-3}"
TIMEOUT_MIN="${4:-0}"  # 0 = no total timeout (rely on ACP idle timeout)
WORKFLOW="${5:-standard}"

require_safe_name "$PROJECT"
require_project "$PROJECT"

exec node "$CPB_ROOT/bridges/run-pipeline.mjs" \
  --project "$PROJECT" \
  --task "$TASK" \
  --max-retries "$MAX_RETRIES" \
  --timeout-min "$TIMEOUT_MIN" \
  --workflow "$WORKFLOW"
