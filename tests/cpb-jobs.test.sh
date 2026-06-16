#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
HUB="$TMP/hub"
SRC="$TMP/source"
project="jobs-test-$$"
job_id="job-20260513-000001-abc123"
legacy_job_id="job-legacy-20260513-000001"
out_file="/tmp/cpb-jobs-out.$$"

cleanup() {
  rm -rf "$TMP" "$out_file"
}
trap cleanup EXIT

mkdir -p "$HUB/projects/demo/events/demo" "$SRC"
cat > "$HUB/projects/demo/events/demo/$job_id.jsonl" <<JSONL
{"type":"job_created","jobId":"job-20260513-000001-abc123","project":"demo","task":"Add login","workflow":"standard","ts":"2026-05-13T00:00:00.000Z"}
JSONL

cat > "$HUB/projects.json" <<JSON
{
  "version": 1,
  "updatedAt": "2026-06-11T00:00:00.000Z",
  "projects": {
    "demo": {
      "id": "demo",
      "name": "demo",
      "sourcePath": "$SRC",
      "projectRuntimeRoot": "$HUB/projects/demo",
      "enabled": true
    }
  }
}
JSON

CPB_ROOT="$TMP" CPB_HUB_ROOT="$HUB" "$ROOT/cpb" jobs | grep -q "$job_id"

mkdir -p "$TMP/cpb-task/events/$project"
cat > "$TMP/cpb-task/events/$project/$job_id.jsonl" <<JSONL
{"type":"job_created","jobId":"$legacy_job_id","project":"$project","task":"Legacy job","workflow":"standard","ts":"2026-05-13T00:00:00.000Z"}
JSONL

CPB_ROOT="$TMP" CPB_HUB_ROOT="$HUB" "$ROOT/cpb" jobs >"$out_file" 2>&1
grep -q "$job_id" "$out_file"
if grep -q "$legacy_job_id" "$out_file"; then
  echo "FAIL: cpb jobs should ignore legacy runtime data" >&2
  exit 1
fi

echo "PASS: jobs command reads project runtime roots and ignores legacy data"
