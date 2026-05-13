#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/flow-bridges.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

PROJECT_DIR="$TMP_DIR/project"
AGENT_LOG="$TMP_DIR/agents.log"
mkdir -p "$PROJECT_DIR"
printf '{"scripts":{"test":"echo ok"}}\n' > "$PROJECT_DIR/package.json"

project="acp-test-$$"
pipeline_project="acp-pipeline-$$"

cleanup_project() {
  rm -rf "$ROOT/wiki/projects/$project"
  rm -rf "$ROOT/wiki/projects/$pipeline_project"
  rm -rf "$ROOT/flow-task/events/$pipeline_project" "$ROOT/flow-task/state/pipeline-${pipeline_project}.json"
}
trap 'cleanup_project; rm -rf "$TMP_DIR"' EXIT

"$ROOT/flow" init "$PROJECT_DIR" "$project" >/dev/null

FLOW_ACP_CLIENT="$ROOT/tests/fixtures/acp-client-stub.sh" \
FLOW_TEST_AGENT_LOG="$AGENT_LOG" \
  "$ROOT/flow" plan "$project" "Add ACP bridge" >/dev/null

test -f "$ROOT/wiki/projects/$project/inbox/plan-001.md"

FLOW_ACP_CLIENT="$ROOT/tests/fixtures/acp-client-stub.sh" \
FLOW_TEST_AGENT_LOG="$AGENT_LOG" \
  "$ROOT/flow" execute "$project" "001" >/dev/null

test -f "$ROOT/wiki/projects/$project/outputs/deliverable-001.md"

FLOW_ACP_CLIENT="$ROOT/tests/fixtures/acp-client-stub.sh" \
FLOW_TEST_AGENT_LOG="$AGENT_LOG" \
  "$ROOT/flow" verify "$project" "001" >/dev/null

test -f "$ROOT/wiki/projects/$project/outputs/verdict-001.md"
grep -qx 'codex' "$AGENT_LOG"
grep -qx 'claude' "$AGENT_LOG"
test "$(grep -xc 'codex' "$AGENT_LOG")" -eq 2

"$ROOT/flow" init "$PROJECT_DIR" "$pipeline_project" >/dev/null

FLOW_ACP_CLIENT="$ROOT/tests/fixtures/acp-client-stub.sh" \
FLOW_TEST_AGENT_LOG="$AGENT_LOG" \
  "$ROOT/flow" pipeline "$pipeline_project" "Add pipeline events" 1 >/dev/null

test -f "$ROOT/wiki/projects/$pipeline_project/inbox/plan-001.md"
test -f "$ROOT/wiki/projects/$pipeline_project/outputs/deliverable-001.md"
test -f "$ROOT/wiki/projects/$pipeline_project/outputs/verdict-001.md"
test -f "$ROOT/flow-task/state/pipeline-${pipeline_project}.json"
find "$ROOT/flow-task/events/$pipeline_project" -name 'job-*.jsonl' -print -quit | grep -q .
