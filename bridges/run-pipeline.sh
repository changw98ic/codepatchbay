#!/usr/bin/env bash
set -euo pipefail

# run-pipeline.sh — 全自动流水线 (ACP + RTK)
# Usage: run-pipeline.sh <project> "<task>" [max-retries] [timeout-minutes]

FLOW_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=common.sh
source "$FLOW_ROOT/bridges/common.sh"

PROJECT="${1:?Usage: run-pipeline.sh <project> '<task>' [max-retries] [timeout-min]}"
TASK="${2:?Usage: run-pipeline.sh <project> '<task>' [max-retries] [timeout-min]}"
MAX_RETRIES="${3:-3}"
TIMEOUT_MIN="${4:-0}"  # 0 = no total timeout (rely on ACP idle timeout)

require_safe_name "$PROJECT"
require_project "$PROJECT"

log() { echo -e "${CYAN}[pipeline:$PROJECT]${NC} $1"; }
ok() { echo -e "${GREEN}[PASS]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

WIKI_DIR="$FLOW_ROOT/wiki/projects/$PROJECT"
PLAN_ID="" DELIVERABLE_ID=""
TIMED_OUT=false

# Check if timeout was flagged by watchdog (state-based, no process killing)
check_timeout() {
  local st
  st=$(state_read "$PROJECT" "status")
  if [ "$st" = "timeout" ]; then
    TIMED_OUT=true
    return 0
  fi
  return 1
}

# Total timeout: writes state flag instead of killing process
# Pipeline checks between phases via check_timeout()
if [ "$TIMEOUT_MIN" -gt 0 ]; then
  (
    sleep $((TIMEOUT_MIN * 60))
    if kill -0 "$$" 2>/dev/null; then
      echo -e "${RED}[pipeline:$PROJECT] Total timeout ($TIMEOUT_MIN min) exceeded${NC}" >&2
      state_write "$PROJECT" "'status'" "'timeout'"
    fi
  ) &
  WATCHDOG_PID=$!
  trap 'kill $WATCHDOG_PID 2>/dev/null' EXIT
fi

# 初始化状态
state_init "$PROJECT" "$TASK" "$MAX_RETRIES"
log "Started (max $MAX_RETRIES retries${TIMEOUT_MIN:+, ${TIMEOUT_MIN}min timeout})"

# ─── Phase 1: Plan ───
log "Phase 1/3: Plan (Codex)"
"$FLOW_ROOT/bridges/codex-plan.sh" "$PROJECT" "$TASK" 2>&1

if check_timeout; then fail "Timed out after plan phase."; exit 1; fi

PLAN_ID=$(find "$WIKI_DIR/inbox" -maxdepth 1 -name 'plan-*.md' -print 2>/dev/null \
  | sort | tail -1 | sed -E 's/.*plan-([0-9]+)\.md$/\1/')

if [ -z "$PLAN_ID" ]; then
  fail "Plan not created. Aborting."
  state_write "$PROJECT" "'status'" "'failed'"
  exit 1
fi
ok "plan-$PLAN_ID"
state_write "$PROJECT" "'phase'" "'execute'"

# ─── Phase 2: Execute (+ retry) ───
RETRY=0
while [ "$RETRY" -lt "$MAX_RETRIES" ]; do
  if check_timeout; then fail "Timed out during execute phase."; exit 1; fi

  log "Phase 2/3: Execute (Claude) attempt $((RETRY + 1))/$MAX_RETRIES"
  "$FLOW_ROOT/bridges/claude-execute.sh" "$PROJECT" "$PLAN_ID" 2>&1

  DELIVERABLE_ID=$(find "$WIKI_DIR/outputs" -maxdepth 1 -name 'deliverable-*.md' -newer "$WIKI_DIR/inbox/plan-${PLAN_ID}.md" -print 2>/dev/null \
    | sort | tail -1 | sed -E 's/.*deliverable-([0-9]+)\.md$/\1/')

  if [ -n "$DELIVERABLE_ID" ]; then
    ok "deliverable-$DELIVERABLE_ID"
    break
  fi
  RETRY=$((RETRY + 1))
  warn "No deliverable. Retry $RETRY/$MAX_RETRIES"
done

if [ -z "$DELIVERABLE_ID" ]; then
  fail "Execute failed after $MAX_RETRIES attempts."
  state_write "$PROJECT" "'status'" "'failed'"
  exit 1
fi

state_write "$PROJECT" "'phase'" "'verify'"

# ─── Phase 3: Verify (+ fix loop) ───
RETRY=0
while [ "$RETRY" -lt "$MAX_RETRIES" ]; do
  if check_timeout; then fail "Timed out during verify phase."; exit 1; fi

  log "Phase 3/3: Verify (Codex) attempt $((RETRY + 1))/$MAX_RETRIES"
  "$FLOW_ROOT/bridges/codex-verify.sh" "$PROJECT" "$DELIVERABLE_ID" 2>&1

  VERDICT_FILE="$WIKI_DIR/outputs/verdict-${DELIVERABLE_ID}.md"
  if [ ! -f "$VERDICT_FILE" ]; then
    RETRY=$((RETRY + 1))
    warn "No verdict. Retry $RETRY/$MAX_RETRIES"
    continue
  fi

  VERDICT=$(grep -E "^VERDICT:" "$VERDICT_FILE" | head -1 | sed 's/^VERDICT:[[:space:]]*//' || echo "")
  if [ -z "$VERDICT" ]; then
    VERDICT=$(head -5 "$VERDICT_FILE" | grep -iE "VERDICT:[[:space:]]*(PASS|FAIL|PARTIAL)" | head -1 | sed 's/.*VERDICT:[[:space:]]*//' 2>/dev/null || true)
    if [ -z "$VERDICT" ]; then
      VERDICT=$(head -5 "$VERDICT_FILE" | grep -iE "^(PASS|FAIL|PARTIAL)" | head -1 || echo "UNKNOWN")
    fi
  fi

  if echo "$VERDICT" | grep -qi "PASS"; then
    ok "Pipeline complete!"
    state_write "$PROJECT" "'status'" "'completed'"
    exit 0
  elif echo "$VERDICT" | grep -qi "FAIL"; then
    RETRY=$((RETRY + 1))
    warn "FAIL. Fix attempt $RETRY/$MAX_RETRIES"
    if [ "$RETRY" -lt "$MAX_RETRIES" ]; then
      log "Re-executing (Claude fix)..."
      "$FLOW_ROOT/bridges/claude-execute.sh" "$PROJECT" "$PLAN_ID" "$VERDICT_FILE" 2>&1
      DELIVERABLE_ID=$(find "$WIKI_DIR/outputs" -maxdepth 1 -name 'deliverable-*.md' -newer "$VERDICT_FILE" -print 2>/dev/null \
        | sort | tail -1 | sed -E 's/.*deliverable-([0-9]+)\.md$/\1/')
    fi
  else
    warn "Unclear verdict: $VERDICT"
    RETRY=$((RETRY + 1))
  fi
done

fail "Pipeline failed after $MAX_RETRIES cycles."
state_write "$PROJECT" "'status'" "'failed'"
exit 1
