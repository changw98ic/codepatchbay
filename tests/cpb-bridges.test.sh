#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cpb-bridges.XXXXXX")"
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
  rm -rf "$ROOT/cpb-task/events/$pipeline_project"
}
trap 'cleanup_project; rm -rf "$TMP_DIR"' EXIT

"$ROOT/cpb" init "$PROJECT_DIR" "$project" >/dev/null

CPB_ACP_CLIENT="$ROOT/tests/fixtures/acp-client-stub.sh" \
CPB_TEST_AGENT_LOG="$AGENT_LOG" \
  "$ROOT/cpb" plan "$project" "Add ACP bridge" >/dev/null

test -f "$ROOT/wiki/projects/$project/inbox/plan-001.md"

CPB_ACP_CLIENT="$ROOT/tests/fixtures/acp-client-stub.sh" \
CPB_TEST_AGENT_LOG="$AGENT_LOG" \
  "$ROOT/cpb" execute "$project" "001" >/dev/null

test -f "$ROOT/wiki/projects/$project/outputs/deliverable-001.md"

CPB_ACP_CLIENT="$ROOT/tests/fixtures/acp-client-stub.sh" \
CPB_TEST_AGENT_LOG="$AGENT_LOG" \
  "$ROOT/cpb" verify "$project" "001" >/dev/null

test -f "$ROOT/wiki/projects/$project/outputs/verdict-001.md"
grep -qx 'codex' "$AGENT_LOG"
grep -qx 'claude' "$AGENT_LOG"
test "$(grep -xc 'codex' "$AGENT_LOG")" -eq 2

"$ROOT/cpb" init "$PROJECT_DIR" "$pipeline_project" >/dev/null

CPB_ACP_CLIENT="$ROOT/tests/fixtures/acp-client-stub.sh" \
CPB_TEST_AGENT_LOG="$AGENT_LOG" \
  "$ROOT/cpb" pipeline "$pipeline_project" "Add pipeline events" 1 >/dev/null

test -f "$ROOT/wiki/projects/$pipeline_project/inbox/plan-001.md"
test -f "$ROOT/wiki/projects/$pipeline_project/outputs/deliverable-001.md"
test -f "$ROOT/wiki/projects/$pipeline_project/outputs/verdict-001.md"
find "$ROOT/cpb-task/events/$pipeline_project" -name 'job-*.jsonl' -print -quit | grep -q .
