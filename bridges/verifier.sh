#!/usr/bin/env bash
# verifier.sh - Verify phase bridge
# Usage:
#   verifier.sh <project> <deliverable-id>
#   verifier.sh <project> --job-id <job-id>
script_dir="$(cd "$(dirname "$0")" && pwd)"
CPB_EXECUTOR_ROOT="${CPB_EXECUTOR_ROOT:-$(cd "${script_dir}/.." && pwd)/dist}"

PROJECT="$1"
shift

if [ "$1" = "--job-id" ]; then
  JOB_ID="$2"
  exec node "${CPB_EXECUTOR_ROOT}/bridges/run-phase.js" verify --project "$PROJECT" --job-id "$JOB_ID"
else
  DELIVERABLE_ID="$1"
  exec node "${CPB_EXECUTOR_ROOT}/bridges/run-phase.js" verify --project "$PROJECT" --deliverable-id "$DELIVERABLE_ID"
fi
