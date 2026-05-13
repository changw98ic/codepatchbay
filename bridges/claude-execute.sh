#!/usr/bin/env bash
set -euo pipefail

# claude-execute.sh — ACP + RTK：Claude 执行
# Usage: claude-execute.sh <project> <plan-id> [verdict-file]

FLOW_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=common.sh
source "$FLOW_ROOT/bridges/common.sh"

PROJECT="${1:?Usage: claude-execute.sh <project> <plan-id> [verdict-file]}"
PLAN_ID="${2:?Usage: claude-execute.sh <project> <plan-id> [verdict-file]}"
VERDICT_FILE="${3:-}"
WIKI_DIR="$FLOW_ROOT/wiki/projects/$PROJECT"

require_safe_name "$PROJECT"
require_project "$PROJECT"
require_file "$WIKI_DIR/inbox/plan-${PLAN_ID}.md"

# Set ACP cwd to target project (not Flow repo)
FLOW_ACP_CWD=$(get_project_path "$PROJECT")
export FLOW_ACP_CWD

DELIVERABLE_ID=$(next_id "$WIKI_DIR/outputs" "deliverable")
DELIVERABLE_FILE="$WIKI_DIR/outputs/deliverable-${DELIVERABLE_ID}.md"

echo "Executing [$PROJECT] plan-$PLAN_ID..."
echo "Output: $DELIVERABLE_FILE"

PROMPT=$(rtk_claude_execute "$PROJECT" "$PLAN_ID" "$DELIVERABLE_FILE" "$VERDICT_FILE")
printf '%s' "$PROMPT" | acp_run claude 2>&1

if [ -f "$DELIVERABLE_FILE" ]; then
  log_append "$WIKI_DIR" "claude | execute | deliverable-$DELIVERABLE_ID from plan-$PLAN_ID | SUCCESS"
  dashboard_update "$PROJECT" "execute" "VERIFYING" "flow verify $PROJECT $DELIVERABLE_ID"
  echo ""
  echo "Deliverable: $DELIVERABLE_FILE"
  echo "Next: flow verify $PROJECT $DELIVERABLE_ID"
else
  log_append "$WIKI_DIR" "claude | execute | deliverable not created from plan-$PLAN_ID | FAIL"
  echo "Warning: Deliverable not created." >&2
  exit 1
fi
