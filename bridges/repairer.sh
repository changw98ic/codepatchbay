#!/usr/bin/env bash
set -euo pipefail

# repairer.sh - Thin wrapper: delegates to Node repair handler
# Usage: repairer.sh <project> <job-id>

CPB_EXECUTOR_ROOT="${CPB_EXECUTOR_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CPB_ROOT="${CPB_ROOT:-$CPB_EXECUTOR_ROOT}"

PROJECT="${1:?Usage: repairer.sh <project> <job-id>}"
JOB_ID="${2:?Usage: repairer.sh <project> <job-id>}"

exec node "$CPB_EXECUTOR_ROOT/bridges/run-phase.mjs" \
  repair \
  --executor-root "$CPB_EXECUTOR_ROOT" \
  --cpb-root "$CPB_ROOT" \
  --project "$PROJECT" \
  --job-id "$JOB_ID"
