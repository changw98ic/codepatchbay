#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cpb-variant-env.XXXXXX")"
trap 'cleanup_project; rm -rf "$TMP_DIR"' EXIT

PROJECT_DIR="$TMP_DIR/project"
AGENT_LOG="$TMP_DIR/agents.log"
ENV_LOG="$TMP_DIR/env.log"
mkdir -p "$PROJECT_DIR"
printf '{"scripts":{"test":"echo ok"}}\n' > "$PROJECT_DIR/package.json"

project="variant-env-$$"

cleanup_project() {
  rm -rf "$ROOT/wiki/projects/$project"
}

"$ROOT/cpb" init "$PROJECT_DIR" "$project" >/dev/null
printf '# Plan\n\nExercise provider env overlay.\n' > "$ROOT/wiki/projects/$project/inbox/plan-001.md"

CPB_ACP_CLIENT="$ROOT/tests/fixtures/acp-client-stub.sh" \
CPB_TEST_AGENT_LOG="$AGENT_LOG" \
CPB_TEST_ENV_LOG="$ENV_LOG" \
OLLAMA_CLOUD_URL="https://kimi.example/v1" \
OLLAMA_CLOUD_KEY="kimi-token" \
OLLAMA_CLOUD_MODEL="kimi-custom-model" \
  "$ROOT/cpb" execute "$project" "001" >/dev/null

grep -qx 'claude|https://kimi.example/v1|kimi-token|kimi-custom-model|kimi-custom-model|kimi-custom-model' "$ENV_LOG"

CPB_ACP_CLIENT="$ROOT/tests/fixtures/acp-client-stub.sh" \
CPB_TEST_AGENT_LOG="$AGENT_LOG" \
CPB_TEST_ENV_LOG="$ENV_LOG" \
CPB_CLAUDE_VARIANT="mimo-v2.5pro" \
XIAOMI_BASE_URL="https://xiaomi.example/v1" \
XIAOMI_API_KEY="xiaomi-token" \
XIAOMI_MODEL="mimo-custom-model" \
  "$ROOT/cpb" execute "$project" "001" >/dev/null

grep -qx 'claude|https://xiaomi.example/v1|xiaomi-token|mimo-custom-model|mimo-custom-model|mimo-custom-model' "$ENV_LOG"

CPB_ACP_CLIENT="$ROOT/tests/fixtures/acp-client-stub.sh" \
CPB_TEST_AGENT_LOG="$AGENT_LOG" \
CPB_TEST_ENV_LOG="$ENV_LOG" \
CPB_CLAUDE_VARIANT="none" \
OLLAMA_CLOUD_URL="https://kimi.example/v1" \
OLLAMA_CLOUD_KEY="kimi-token" \
OLLAMA_CLOUD_MODEL="kimi-custom-model" \
ANTHROPIC_BASE_URL="https://existing.example/v1" \
ANTHROPIC_AUTH_TOKEN="existing-token" \
ANTHROPIC_MODEL="existing-model" \
ANTHROPIC_DEFAULT_SONNET_MODEL="existing-sonnet" \
ANTHROPIC_CUSTOM_MODEL_OPTION="existing-custom" \
  "$ROOT/cpb" execute "$project" "001" >/dev/null

grep -qx 'claude|https://existing.example/v1|existing-token|existing-model|existing-sonnet|existing-custom' "$ENV_LOG"
