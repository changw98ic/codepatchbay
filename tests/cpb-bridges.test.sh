#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cpb-bridges.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

PROJECT_DIR="$TMP_DIR/project"
CPB_RUNTIME="$TMP_DIR/runtime"
CPB_HUB="$TMP_DIR/hub"
AGENT_LOG="$TMP_DIR/agents.log"
mkdir -p "$PROJECT_DIR" "$CPB_RUNTIME" "$CPB_HUB"
printf '{"scripts":{"test":"echo ok"}}\n' > "$PROJECT_DIR/package.json"

pipeline_project="acp-pipeline-$$"

cleanup_project() {
  rm -rf "$CPB_RUNTIME" "$CPB_HUB"
}
trap 'cleanup_project; rm -rf "$TMP_DIR"' EXIT

CPB_ROOT="$CPB_RUNTIME" CPB_HUB_ROOT="$CPB_HUB" "$ROOT/cpb" init "$PROJECT_DIR" "$pipeline_project" >/dev/null

CPB_ACP_CLIENT="$ROOT/tests/fixtures/acp-client-stub.sh" \
CPB_TEST_AGENT_LOG="$AGENT_LOG" \
CPB_ROOT="$CPB_RUNTIME" CPB_HUB_ROOT="$CPB_HUB" \
  "$ROOT/cpb" pipeline "$pipeline_project" "Add pipeline events" 1 >/dev/null

test ! -e "$CPB_RUNTIME/cpb-task/state/pipeline-${pipeline_project}.json"
grep -q "$pipeline_project" "$CPB_HUB/queue/queue.json"
