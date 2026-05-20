#!/usr/bin/env bash
set -euo pipefail

# codex-verify.sh — ACP + RTK：Codex 验证
# Usage: codex-verify.sh <project> <deliverable-id>
#        codex-verify.sh <project> --job-id <job-id>

CPB_EXECUTOR_ROOT="${CPB_EXECUTOR_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CPB_ROOT="${CPB_ROOT:-$CPB_EXECUTOR_ROOT}"
# shellcheck source=common.sh
source "$CPB_EXECUTOR_ROOT/bridges/common.sh"

if [ "$#" -ne 2 ] && [ "$#" -ne 3 ]; then
  echo "Usage: codex-verify.sh <project> <deliverable-id> | <project> --job-id <job-id>" >&2
  exit 2
fi

PROJECT="$1"
WIKI_DIR="$CPB_ROOT/wiki/projects/$PROJECT"
VERIFY_BY_JOB=0
JOB_ID=""
DELIVERABLE_ID=""

if [ "${2:-}" = "--job-id" ]; then
  if [ "$#" -ne 3 ]; then
    echo "Usage: codex-verify.sh <project> --job-id <job-id>" >&2
    exit 2
  fi
  VERIFY_BY_JOB=1
  JOB_ID="$3"
else
  if [ "$#" -ne 2 ]; then
    echo "Usage: codex-verify.sh <project> <deliverable-id>" >&2
    exit 2
  fi
  DELIVERABLE_ID="$2"
fi

require_safe_name "$PROJECT"
require_project "$PROJECT"
if [ "$VERIFY_BY_JOB" -eq 0 ]; then
  require_file "$WIKI_DIR/outputs/deliverable-${DELIVERABLE_ID}.md"
fi

# Set ACP cwd to target project (not CodePatchbay repo)
CPB_ACP_CWD=$(get_project_path "$PROJECT")
export CPB_ACP_CWD

if [ "$VERIFY_BY_JOB" -eq 1 ]; then
  VERDICT_FILE="$WIKI_DIR/outputs/verdict-${JOB_ID}.md"
else
  VERDICT_FILE="$WIKI_DIR/outputs/verdict-${DELIVERABLE_ID}.md"
fi

if [ "$VERIFY_BY_JOB" -eq 1 ]; then
  echo "Verifying [$PROJECT] job-$JOB_ID..."
else
  echo "Verifying [$PROJECT] deliverable-$DELIVERABLE_ID..."
fi
echo "Output: $VERDICT_FILE"

if [ "$VERIFY_BY_JOB" -eq 1 ]; then
  PROMPT=$(rtk_codex_verify_job "$PROJECT" "$JOB_ID" "$VERDICT_FILE")
else
  PROMPT=$(rtk_codex_verify "$PROJECT" "$DELIVERABLE_ID" "$VERDICT_FILE")
fi
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
  if [ "$VERIFY_BY_JOB" -eq 1 ]; then
    log_append "$WIKI_DIR" "codex | verify | job-$JOB_ID | $VERDICT"
  else
    log_append "$WIKI_DIR" "codex | verify | deliverable-$DELIVERABLE_ID | $VERDICT"
  fi

  echo ""
  echo "Verdict: $VERDICT"
  if echo "$VERDICT" | grep -qi "FAIL"; then
    dashboard_update "$PROJECT" "verify" "FIXING" "cpb execute $PROJECT (fix)"
    echo "Fix needed: $VERDICT_FILE"
    echo "Next: cpb execute $PROJECT <plan-id>"
  elif echo "$VERDICT" | grep -qi "PASS"; then
    dashboard_update "$PROJECT" "verify" "DONE" "completed"
    echo "Deliverable accepted."
  else
    dashboard_update "$PROJECT" "verify" "UNCLEAR" "manual review needed"
  fi
else
  if [ "$VERIFY_BY_JOB" -eq 1 ]; then
    log_append "$WIKI_DIR" "codex | verify | verdict not created for job-$JOB_ID | FAIL"
  else
    log_append "$WIKI_DIR" "codex | verify | verdict not created for deliverable-$DELIVERABLE_ID | FAIL"
  fi
  echo "Warning: Verdict not created." >&2
  exit 1
fi
