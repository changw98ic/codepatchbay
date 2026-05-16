#!/usr/bin/env bash
set -euo pipefail

# claude-execute.sh — ACP + RTK：Claude 执行
# Usage: claude-execute.sh <project> <plan-id> [verdict-file]

CPB_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=common.sh
source "$CPB_ROOT/bridges/common.sh"

# Ensure SDK uses x-api-key auth (not Bearer) when using a gateway.
# The Anthropic SDK prefers authToken (Bearer) over apiKey (x-api-key).
# When only ANTHROPIC_AUTH_TOKEN is set (no ANTHROPIC_API_KEY), the SDK
# sends Bearer auth which some gateways reject. Fix: promote token to apiKey.
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
  export ANTHROPIC_API_KEY="$ANTHROPIC_AUTH_TOKEN"
fi
unset ANTHROPIC_AUTH_TOKEN
export CPB_CLAUDE_VARIANT=none

PROJECT="${1:?Usage: claude-execute.sh <project> <plan-id> [verdict-file]}"
PLAN_ID="${2:?Usage: claude-execute.sh <project> <plan-id> [verdict-file]}"
VERDICT_FILE="${3:-}"
WIKI_DIR="$CPB_ROOT/wiki/projects/$PROJECT"

require_safe_name "$PROJECT"
require_project "$PROJECT"
require_file "$WIKI_DIR/inbox/plan-${PLAN_ID}.md"

# Set ACP cwd to target project (not CodePatchbay repo)
CPB_ACP_CWD=$(get_project_path "$PROJECT")
export CPB_ACP_CWD

DELIVERABLE_ID=$(next_id "$WIKI_DIR/outputs" "deliverable")
DELIVERABLE_FILE="$WIKI_DIR/outputs/deliverable-${DELIVERABLE_ID}.md"

echo "Executing [$PROJECT] plan-$PLAN_ID..."
echo "Output: $DELIVERABLE_FILE"

PROMPT=$(rtk_claude_execute "$PROJECT" "$PLAN_ID" "$DELIVERABLE_FILE" "$VERDICT_FILE")
printf '%s' "$PROMPT" | acp_run claude 2>&1

if [ -f "$DELIVERABLE_FILE" ]; then
  log_append "$WIKI_DIR" "claude | execute | deliverable-$DELIVERABLE_ID from plan-$PLAN_ID | SUCCESS"
  dashboard_update "$PROJECT" "execute" "VERIFYING" "cpb verify $PROJECT $DELIVERABLE_ID"
  echo ""
  echo "Deliverable: $DELIVERABLE_FILE"
  echo "Next: cpb verify $PROJECT $DELIVERABLE_ID"
else
  log_append "$WIKI_DIR" "claude | execute | deliverable not created from plan-$PLAN_ID | FAIL"
  echo "Warning: Deliverable not created." >&2
  exit 1
fi
