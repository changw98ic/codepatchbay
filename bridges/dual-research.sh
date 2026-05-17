#!/usr/bin/env bash
set -euo pipefail

# dual-research.sh — Dual-agent parallel research
# Usage: dual-research.sh <project> "<task>"

CPB_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=common.sh
source "$CPB_ROOT/bridges/common.sh"

PROJECT="${1:?Usage: dual-research.sh <project> '<task>'}"
TASK="${2:?Usage: dual-research.sh <project> '<task>'}"
WIKI_DIR="$CPB_ROOT/wiki/projects/$PROJECT"

require_safe_name "$PROJECT"
require_project "$PROJECT"

# Set ACP cwd to target project
CPB_ACP_CWD=$(get_project_path "$PROJECT")
export CPB_ACP_CWD

RESEARCH_ID=$(next_id "$WIKI_DIR/inbox" "research")
RESEARCH_FILE="$WIKI_DIR/inbox/research-${RESEARCH_ID}.md"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

CODEX_OUT="$TMPDIR/codex.txt"
CLAUDE_OUT="$TMPDIR/claude.txt"

echo "Research [$PROJECT]: $TASK"
echo "Running dual-agent research (Codex + Claude in parallel)..."

PROMPT=$(rtk_research_prompt "$PROJECT" "$TASK")

# Run both agents in parallel
printf '%s' "$PROMPT" | acp_run codex > "$CODEX_OUT" 2>&1 &
CODEX_PID=$!

printf '%s' "$PROMPT" | acp_run claude > "$CLAUDE_OUT" 2>&1 &
CLAUDE_PID=$!

# Wait for both, capture exit codes (don't fail if one fails)
CODEX_EXIT=0
wait "$CODEX_PID" || CODEX_EXIT=$?

CLAUDE_EXIT=0
wait "$CLAUDE_PID" || CLAUDE_EXIT=$?

echo "  Codex: $([ $CODEX_EXIT -eq 0 ] && echo 'done' || echo 'failed (exit '$CODEX_EXIT')')"
echo "  Claude: $([ $CLAUDE_EXIT -eq 0 ] && echo 'done' || echo 'failed (exit '$CLAUDE_EXIT')')"

# Both failed = hard fail
if [ "$CODEX_EXIT" -ne 0 ] && [ "$CLAUDE_EXIT" -ne 0 ]; then
  echo "Error: Both research agents failed." >&2
  exit 1
fi

# Merge results
node "$CPB_ROOT/bridges/merge-research.mjs" \
  --codex "$CODEX_OUT" --codex-exit "$CODEX_EXIT" \
  --claude "$CLAUDE_OUT" --claude-exit "$CLAUDE_EXIT" \
  --task "$TASK" \
  --output "$RESEARCH_FILE"

log_append "$WIKI_DIR" "research | dual | research-$RESEARCH_ID for: $TASK | $([ $CODEX_EXIT -eq 0 ] && [ $CLAUDE_EXIT -eq 0 ] && echo 'FULL' || echo 'PARTIAL')"

echo ""
echo "Research: $RESEARCH_FILE"
