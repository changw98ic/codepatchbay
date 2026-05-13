#!/usr/bin/env bash
set -euo pipefail

# codex-verify.sh — ACP + RTK：Codex 验证
# Usage: codex-verify.sh <project> <deliverable-id>

FLOW_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=common.sh
source "$FLOW_ROOT/bridges/common.sh"

PROJECT="${1:?Usage: codex-verify.sh <project> <deliverable-id>}"
DELIVERABLE_ID="${2:?Usage: codex-verify.sh <project> <deliverable-id>}"
WIKI_DIR="$FLOW_ROOT/wiki/projects/$PROJECT"

require_safe_name "$PROJECT"
require_project "$PROJECT"
require_file "$WIKI_DIR/outputs/deliverable-${DELIVERABLE_ID}.md"

# Set ACP cwd to target project (not Flow repo)
FLOW_ACP_CWD=$(get_project_path "$PROJECT")
export FLOW_ACP_CWD

VERDICT_FILE="$WIKI_DIR/outputs/verdict-${DELIVERABLE_ID}.md"

echo "Verifying [$PROJECT] deliverable-$DELIVERABLE_ID..."
echo "Output: $VERDICT_FILE"

PROMPT=$(rtk_codex_verify "$PROJECT" "$DELIVERABLE_ID" "$VERDICT_FILE")
printf '%s' "$PROMPT" | acp_run codex 2>&1

if [ -f "$VERDICT_FILE" ]; then
  VERDICT=$(grep -E "^VERDICT:" "$VERDICT_FILE" | head -1 | sed 's/^VERDICT:[[:space:]]*//' || echo "")
  if [ -z "$VERDICT" ]; then
    # Fallback: scan first 5 lines for structured marker, then legacy format
    VERDICT=$(head -5 "$VERDICT_FILE" | grep -iE "VERDICT:[[:space:]]*(PASS|FAIL|PARTIAL)" | head -1 | sed 's/.*VERDICT:[[:space:]]*//' 2>/dev/null || true)
    if [ -z "$VERDICT" ]; then
      VERDICT=$(head -5 "$VERDICT_FILE" | grep -iE "^(PASS|FAIL|PARTIAL)" | head -1 || echo "UNKNOWN")
    fi
  fi
  log_append "$WIKI_DIR" "codex | verify | deliverable-$DELIVERABLE_ID | $VERDICT"

  echo ""
  echo "Verdict: $VERDICT"
  if echo "$VERDICT" | grep -qi "FAIL"; then
    dashboard_update "$PROJECT" "verify" "FIXING" "flow execute $PROJECT (fix)"
    echo "Fix needed: $VERDICT_FILE"
    echo "Next: flow execute $PROJECT <plan-id>"
  elif echo "$VERDICT" | grep -qi "PASS"; then
    dashboard_update "$PROJECT" "verify" "DONE" "completed"
    echo "Deliverable accepted."
  else
    dashboard_update "$PROJECT" "verify" "UNCLEAR" "manual review needed"
  fi
else
  log_append "$WIKI_DIR" "codex | verify | verdict not created for deliverable-$DELIVERABLE_ID | FAIL"
  echo "Warning: Verdict not created." >&2
  exit 1
fi
