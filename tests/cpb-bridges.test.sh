#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cpb-bridges.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

PROJECT_DIR="$TMP_DIR/project"
AGENT_LOG="$TMP_DIR/agents.log"
mkdir -p "$PROJECT_DIR"
printf '{"scripts":{"test":"echo ok"}}\n' > "$PROJECT_DIR/package.json"

pipeline_project="acp-pipeline-$$"

cleanup_project() {
  rm -rf "$ROOT/wiki/projects/$pipeline_project"
  rm -rf "$ROOT/cpb-task/events/$pipeline_project" "$ROOT/cpb-task/state/pipeline-${pipeline_project}.json"
}
trap 'cleanup_project; rm -rf "$TMP_DIR"' EXIT

"$ROOT/cpb" init "$PROJECT_DIR" "$pipeline_project" >/dev/null

CPB_ACP_CLIENT="$ROOT/tests/fixtures/acp-client-stub.sh" \
CPB_TEST_AGENT_LOG="$AGENT_LOG" \
  "$ROOT/cpb" pipeline "$pipeline_project" "Add pipeline events" 1 >/dev/null

test ! -e "$ROOT/cpb-task/state/pipeline-${pipeline_project}.json"
