#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
project="jobs-test-$$"
job_id="job-20260513-000001-abc123"

cleanup() {
  rm -rf "$TMP" "$ROOT/cpb-task/events/$project"
}
trap cleanup EXIT

mkdir -p "$TMP/cpb-task/events/demo"
cat > "$TMP/cpb-task/events/demo/$job_id.jsonl" <<JSONL
{"type":"job_created","jobId":"job-20260513-000001-abc123","project":"demo","task":"Add login","workflow":"standard","ts":"2026-05-13T00:00:00.000Z"}
JSONL

CPB_ROOT="$TMP" node "$ROOT/bridges/list-jobs.mjs" | grep -q "$job_id"

mkdir -p "$ROOT/cpb-task/events/$project"
cat > "$ROOT/cpb-task/events/$project/$job_id.jsonl" <<JSONL
{"type":"job_created","jobId":"$job_id","project":"$project","task":"Add login","workflow":"standard","ts":"2026-05-13T00:00:00.000Z"}
JSONL

"$ROOT/cpb" jobs | grep -q "$job_id"

echo "PASS: list-jobs found the durable job"

# --- jobs report ---
REPORT_TMP="$(mktemp -d)"
report_project="report-sh-$$"
failed_job="job-20260513-000002-def456"

mkdir -p "$REPORT_TMP/cpb-task/events/$report_project"
cat > "$REPORT_TMP/cpb-task/events/$report_project/$failed_job.jsonl" <<JSONL
{"type":"job_created","jobId":"$failed_job","project":"$report_project","task":"Fail me","workflow":"standard","ts":"2026-05-13T00:10:00.000Z"}
{"type":"job_failed","jobId":"$failed_job","project":"$report_project","reason":"boom","code":"FATAL","phase":"execute","ts":"2026-05-13T00:11:00.000Z"}
JSONL

# Human output
CPB_ROOT="$REPORT_TMP" CPB_EXECUTOR_ROOT="$ROOT" "$ROOT/cpb" jobs report | grep -q "Job run report"
CPB_ROOT="$REPORT_TMP" CPB_EXECUTOR_ROOT="$ROOT" "$ROOT/cpb" jobs report | grep -q "Total jobs: 1"
CPB_ROOT="$REPORT_TMP" CPB_EXECUTOR_ROOT="$ROOT" "$ROOT/cpb" jobs report | grep -q "$failed_job"
echo "PASS: jobs report human output"

# JSON output
CPB_ROOT="$REPORT_TMP" CPB_EXECUTOR_ROOT="$ROOT" "$ROOT/cpb" jobs report --json > "$REPORT_TMP/report.json"
node -e "
const r = JSON.parse(require('fs').readFileSync('$REPORT_TMP/report.json','utf8'));
if (r.command !== 'cpb jobs report') throw new Error('bad command');
if (r.totalJobs !== 1) throw new Error('totalJobs ' + r.totalJobs);
if (r.statusCounts.failed !== 1) throw new Error('failed ' + r.statusCounts.failed);
if (r.phaseFailureCounts.length !== 1) throw new Error('phaseFailureCounts ' + r.phaseFailureCounts.length);
if (r.phaseFailureCounts[0].phase !== 'execute') throw new Error('phase ' + r.phaseFailureCounts[0].phase);
if (r.recentAnomalousJobs.length !== 1) throw new Error('anomalies ' + r.recentAnomalousJobs.length);
if (r.recentAnomalousJobs[0].jobId !== '$failed_job') throw new Error('anomaly jobId');
console.log('PASS: jobs report JSON output');
"

# Empty report
EMPTY_TMP="$(mktemp -d)"
CPB_ROOT="$EMPTY_TMP" CPB_EXECUTOR_ROOT="$ROOT" "$ROOT/cpb" jobs report | grep -q "Total jobs: 0"
echo "PASS: jobs report empty"

rm -rf "$REPORT_TMP" "$EMPTY_TMP"
