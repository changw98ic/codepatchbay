#!/usr/bin/env bash
# verifier.sh - Verify phase bridge
# Usage:
#   verifier.sh <project> <deliverable-id>
#   verifier.sh <project> --job-id <job-id>
script_dir="$(cd "$(dirname "$0")" && pwd)"

PROJECT="$1"
shift

if [ "$1" = "--job-id" ]; then
  JOB_ID="$2"
  exec node "${script_dir}/run-phase.mjs" verify --project "$PROJECT" --job-id "$JOB_ID"
else
  DELIVERABLE_ID="$1"
  exec node "${script_dir}/run-phase.mjs" verify --project "$PROJECT" --deliverable-id "$DELIVERABLE_ID"
fi
