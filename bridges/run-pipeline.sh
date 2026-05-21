#!/usr/bin/env bash
set -euo pipefail

# run-pipeline.sh — compatibility wrapper for the durable Node pipeline
# Usage: run-pipeline.sh <project> "<task>" [max-retries] [timeout-minutes] [workflow] [job-id] [--acp-profile <profile>] [--ui-lane-reason <reason>]

CPB_EXECUTOR_ROOT="${CPB_EXECUTOR_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CPB_ROOT="${CPB_ROOT:-$CPB_EXECUTOR_ROOT}"

PROJECT="${1:?Usage: run-pipeline.sh <project> '<task>' [max-retries] [timeout-min] [workflow]}"
TASK="${2:?Usage: run-pipeline.sh <project> '<task>' [max-retries] [timeout-min] [workflow]}"
MAX_RETRIES="${3:-3}"
TIMEOUT_MIN="${4:-0}"
WORKFLOW="${5:-standard}"
JOB_ID="${6:-}"

JOB_ID_ARG=""
[ -n "$JOB_ID" ] && JOB_ID_ARG="--job-id $JOB_ID"

exec node "$CPB_EXECUTOR_ROOT/bridges/run-pipeline.mjs" \
  --project "$PROJECT" \
  --task "$TASK" \
  --max-retries "$MAX_RETRIES" \
  --timeout-min "$TIMEOUT_MIN" \
  --workflow "$WORKFLOW" \
  $JOB_ID_ARG \
  "${@:7}"
