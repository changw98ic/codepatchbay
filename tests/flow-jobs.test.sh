#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
project="jobs-test-$$"
job_id="job-20260513-000001-abc123"

cleanup() {
  rm -rf "$TMP" "$ROOT/flow-task/events/$project"
}
trap cleanup EXIT

mkdir -p "$TMP/flow-task/events/demo"
cat > "$TMP/flow-task/events/demo/$job_id.jsonl" <<JSONL
{"type":"job_created","jobId":"job-20260513-000001-abc123","project":"demo","task":"Add login","workflow":"standard","ts":"2026-05-13T00:00:00.000Z"}
JSONL

FLOW_ROOT="$TMP" node "$ROOT/bridges/list-jobs.mjs" | grep -q "$job_id"

mkdir -p "$ROOT/flow-task/events/$project"
cat > "$ROOT/flow-task/events/$project/$job_id.jsonl" <<JSONL
{"type":"job_created","jobId":"$job_id","project":"$project","task":"Add login","workflow":"standard","ts":"2026-05-13T00:00:00.000Z"}
JSONL

"$ROOT/flow" jobs | grep -q "$job_id"

echo "PASS: list-jobs found the durable job"
