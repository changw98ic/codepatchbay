#!/usr/bin/env bash
set -euo pipefail

# verifier.sh - Thin wrapper: delegates to Node phase runner
# Usage: verifier.sh <project> <deliverable-id>
#        verifier.sh <project> --job-id <job-id>

CPB_EXECUTOR_ROOT="${CPB_EXECUTOR_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CPB_ROOT="${CPB_ROOT:-$CPB_EXECUTOR_ROOT}"

PROJECT="$1"
artifact_args=()

if [ "${2:-}" = "--job-id" ]; then
  artifact_args=(--job-id "${3:?Usage: verifier.sh <project> --job-id <job-id>}")
else
  artifact_args=(--deliverable-id "${2:?Usage: verifier.sh <project> <deliverable-id>}")
fi

exec node "$CPB_EXECUTOR_ROOT/bridges/run-phase.mjs" \
  verify \
  --executor-root "$CPB_EXECUTOR_ROOT" \
  --cpb-root "$CPB_ROOT" \
  --project "$PROJECT" \
  "${artifact_args[@]}"
