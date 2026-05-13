#!/usr/bin/env bash
set -euo pipefail

# codex-plan.sh — ACP + RTK：Codex 规划
# Usage: codex-plan.sh <project> "<task>"

FLOW_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=common.sh
source "$FLOW_ROOT/bridges/common.sh"

PROJECT="${1:?Usage: codex-plan.sh <project> '<task>'}"
TASK="${2:?Usage: codex-plan.sh <project> '<task>'}"
WIKI_DIR="$FLOW_ROOT/wiki/projects/$PROJECT"

require_safe_name "$PROJECT"
require_project "$PROJECT"

# Set ACP cwd to target project (not Flow repo)
FLOW_ACP_CWD=$(get_project_path "$PROJECT")
export FLOW_ACP_CWD

PLAN_ID=$(next_id "$WIKI_DIR/inbox" "plan")
PLAN_FILE="$WIKI_DIR/inbox/plan-${PLAN_ID}.md"

echo "Planning [$PROJECT]: $TASK"
echo "Output: $PLAN_FILE"

PROMPT=$(rtk_codex_plan "$PROJECT" "$TASK" "$PLAN_FILE")
printf '%s' "$PROMPT" | acp_run codex 2>&1

if [ -f "$PLAN_FILE" ]; then
  log_append "$WIKI_DIR" "codex | plan | Created plan-$PLAN_ID for: $TASK | SUCCESS"
  dashboard_update "$PROJECT" "plan" "EXECUTING" "flow execute $PROJECT $PLAN_ID"
  echo ""
  echo "Plan: $PLAN_FILE"
  echo "Next: flow execute $PROJECT $PLAN_ID"
else
  log_append "$WIKI_DIR" "codex | plan | Failed to create plan for: $TASK | FAIL"
  echo "Warning: Plan file not created." >&2
  exit 1
fi
