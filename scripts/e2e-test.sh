#!/usr/bin/env bash
# E2E test: pack → install → hub → enqueue → pipeline → PR → merge → verify
set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────
REPO="changw98ic/codepatchbay"
PROJECT="flow"
HUB_PORT="${CPB_PORT:-3456}"
HUB_URL="http://localhost:${HUB_PORT}"
FLOW_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG_VERSION=$(node -e "console.log(require('${FLOW_ROOT}/package.json').version)")
TGZ="codepatchbay-${PKG_VERSION}.tgz"
ISSUE_NUMBER="${1:-}"

# ── Colors ──────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

step()  { echo -e "${CYAN}[STEP]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
fail()  { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }

# ── Pre-flight ──────────────────────────────────────────────────────────
step "Pre-flight checks"
command -v gh >/dev/null 2>&1 || fail "gh CLI required"
command -v node >/dev/null 2>&1 || fail "node required"
gh auth status >/dev/null 2>&1 || fail "gh auth required"

if [ -z "$ISSUE_NUMBER" ]; then
  # Pick first open issue that doesn't already have a linked PR
  ISSUE_NUMBER=$(gh issue list --repo "$REPO" --state open --limit 10 --json number,title --jq '.[0].number')
  [ -z "$ISSUE_NUMBER" ] && fail "No open issues found in $REPO"
  warn "No issue specified, using #$ISSUE_NUMBER"
fi

ISSUE_TITLE=$(gh issue view "$ISSUE_NUMBER" --repo "$REPO" --json title --jq '.title')
step "Target: $REPO#$ISSUE_NUMBER — $ISSUE_TITLE"

# ── 1. Pack & Install ───────────────────────────────────────────────────
step "1/7 Packing codepatchbay@${PKG_VERSION}..."
cd "$FLOW_ROOT"
rm -f "/tmp/$TGZ"
npm pack --pack-destination /tmp "$PKG_VERSION" >/dev/null 2>&1 || npm pack --pack-destination /tmp >/dev/null 2>&1
ok "Packed → /tmp/$TGZ"

step "   Installing globally..."
npm install -g "/tmp/$TGZ" >/dev/null 2>&1
ok "Installed: $(cpb --version 2>/dev/null || echo 'cpb')"

# ── 2. Hub lifecycle ────────────────────────────────────────────────────
step "2/7 Stopping hub (if running)..."
cpb hub stop 2>/dev/null || true
sleep 1

step "   Cleaning runtime state (worktrees, queue, workers, assignments, logs)..."
HUB_ROOT="${CPB_HUB_ROOT:-$HOME/.cpb}"
rm -rf "$HUB_ROOT/worktrees"   2>/dev/null || true
rm -rf "$HUB_ROOT/queue"       2>/dev/null || true
rm -rf "$HUB_ROOT/workers"     2>/dev/null || true
rm -rf "$HUB_ROOT/assignments" 2>/dev/null || true
rm -rf "$HUB_ROOT/logs"        2>/dev/null || true
rm -rf "$HUB_ROOT/orchestrator" 2>/dev/null || true
ok "Runtime state cleaned (registry preserved)"

step "   Starting hub..."
cpb hub start 2>&1
sleep 2

# Wait for hub to be ready
step "   Waiting for hub to be ready..."
for i in $(seq 1 30); do
  if curl -sf "${HUB_URL}/api/projects" >/dev/null 2>&1; then
    ok "Hub ready at ${HUB_URL}"
    break
  fi
  if [ "$i" -eq 30 ]; then
    fail "Hub did not start within 30s"
  fi
  sleep 1
done

# ── 3. Enqueue ──────────────────────────────────────────────────────────
step "3/7 Enqueuing pipeline for issue #$ISSUE_NUMBER..."
ENQUEUE_BODY=$(cat <<EOF
{
  "task": "${ISSUE_TITLE}",
  "workflow": "standard",
  "planMode": "full",
  "issueNumber": ${ISSUE_NUMBER},
  "repo": "${REPO}",
  "issueTitle": "${ISSUE_TITLE}"
}
EOF
)

RESPONSE=$(curl -sf -X POST "${HUB_URL}/api/tasks/${PROJECT}/pipeline" \
  -H "Content-Type: application/json" \
  -d "$ENQUEUE_BODY" 2>&1) || fail "Enqueue failed: $RESPONSE"

QUEUE_ID=$(echo "$RESPONSE" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.entry?.id || d.id || 'unknown')")
ok "Enqueued: queueId=$QUEUE_ID"

# ── 4. Wait for pipeline completion ─────────────────────────────────────
step "4/7 Waiting for pipeline to complete (polling every 30s, max 15min)..."

resolve_pr_number() {
  # Check assignment result files for PR info
  local result_files
  result_files=$(find "$HUB_ROOT/assignments" -name "result.json" -newer "$HUB_ROOT/queue" 2>/dev/null || true)
  if [ -n "$result_files" ]; then
    for f in $result_files; do
      local pr_url
      pr_url=$(node -e "
        const d = JSON.parse(require('fs').readFileSync('$f','utf8'));
        const fr = d.finalizeResult;
        if (fr && fr.prUrl) console.log(fr.prUrl);
        else if (d.jobResult?.finalizeResult?.prUrl) console.log(d.jobResult.finalizeResult.prUrl);
      " 2>/dev/null || true)
      if [ -n "$pr_url" ]; then
        echo "$pr_url" | grep -oE 'pull/[0-9]+' | grep -oE '[0-9]+'
        return 0
      fi
    done
  fi
  return 1
}

ELAPSED=0
MAX_WAIT=1800  # 30 minutes
FINAL_FAILURE_SEEN=""
while [ "$ELAPSED" -lt "$MAX_WAIT" ]; do
  sleep 30
  ELAPSED=$((ELAPSED + 30))

  # Check event log for real progress
  CPB_EXEC_ROOT=$(dirname "$(dirname "$(readlink -f "$(which cpb)" 2>/dev/null || which cpb)")")/lib/node_modules/codepatchbay
  JOB_EVENT_LOG="${CPB_EXEC_ROOT}/cpb-task/events/${PROJECT}/job-${QUEUE_ID}.jsonl"
  if [ ! -f "$JOB_EVENT_LOG" ]; then
    JOB_EVENT_LOG="$HUB_ROOT/projects/${PROJECT}/events/job-${QUEUE_ID}.jsonl"
  fi
  if [ -n "$JOB_EVENT_LOG" ] && [ -f "$JOB_EVENT_LOG" ]; then
    PROGRESS=$(tail -1 "$JOB_EVENT_LOG" 2>/dev/null | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      console.log(d.type || '', d.phase || '', d.status || '');
    " 2>/dev/null || echo "")
    if echo "$PROGRESS" | grep -q "job_completed"; then
      ok "Pipeline completed in ${ELAPSED}s (event log)"
    elif [ -n "$PROGRESS" ]; then
      echo -e "   ${YELLOW}[${ELAPSED}s]${NC} event: $PROGRESS"
    fi
  fi

  # Check for assignment failure
  LATEST_RESULT=$(find "$HUB_ROOT/assignments" -name "result.json" -newer "$HUB_ROOT/queue" 2>/dev/null | sort -r | head -1)
  if [ -n "$LATEST_RESULT" ]; then
    RESULT_STATUS=$(node -e "const d=JSON.parse(require('fs').readFileSync('$LATEST_RESULT','utf8')); console.log(d.status)" 2>/dev/null || echo "unknown")
    if [ "$RESULT_STATUS" = "failed" ]; then
      FAIL_REASON=$(node -e "
        const d=JSON.parse(require('fs').readFileSync('$LATEST_RESULT','utf8'));
        const f = d.jobResult?.failure || {};
        console.log(f.kind || 'unknown', f.phase || '', f.reason || '');
      " 2>/dev/null || echo "unknown failure")
      echo -e "   ${YELLOW}[${ELAPSED}s]${NC} attempt failed: $FAIL_REASON"
      # Check if all attempts exhausted (3 attempts = final failure)
      ATTEMPT_COUNT=$(find "$HUB_ROOT/assignments" -name "result.json" -newer "$HUB_ROOT/queue" 2>/dev/null | wc -l | tr -d ' ')
      if [ "$ATTEMPT_COUNT" -ge 3 ]; then
        FINAL_FAILURE_SEEN="$FAIL_REASON (all $ATTEMPT_COUNT attempts failed)"
        break
      fi
      # Otherwise keep waiting — orchestrator may retry
      continue
    fi
  fi

  # Check if worker log shows finalize
  WORKER_LOG=$(ls -t "$HUB_ROOT/logs"/worker-*.log 2>/dev/null | head -1)
  if [ -n "$WORKER_LOG" ]; then
    if grep -q "pr.opened" "$WORKER_LOG" 2>/dev/null; then
      PR_URL=$(grep -oE 'https://github\.com/[^ ]+pull/[0-9]+' "$WORKER_LOG" | tail -1)
      PR_NUMBER=$(echo "$PR_URL" | grep -oE '[0-9]+$')
      ok "Pipeline completed in ${ELAPSED}s — PR: $PR_URL"
      break
    fi
    # Show progress
    LAST_LINE=$(tail -1 "$WORKER_LOG" 2>/dev/null | head -c 120)
    echo -e "   ${YELLOW}[${ELAPSED}s]${NC} $LAST_LINE"
  fi

  # Also try resolving from result files
  PR_NUMBER=$(resolve_pr_number) && {
    PR_URL="https://github.com/${REPO}/pull/${PR_NUMBER}"
    ok "Pipeline completed in ${ELAPSED}s — PR: $PR_URL"
    break
  }

  if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
    fail "Pipeline did not complete within ${MAX_WAIT}s"
  fi
done

# Handle early exit on failure
if [ -n "$FINAL_FAILURE_SEEN" ]; then
  fail "Pipeline failed: $FINAL_FAILURE_SEEN"
fi
if [ -z "$PR_NUMBER" ] || [ -z "$PR_URL" ]; then
  fail "Pipeline completed but no PR was created"
fi

# ── 5. Verify PR ────────────────────────────────────────────────────────
step "5/7 Verifying PR #$PR_NUMBER..."
PR_DATA=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json isDraft,title,body,state,url 2>&1) || fail "Cannot read PR #$PR_NUMBER"

IS_DRAFT=$(echo "$PR_DATA" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.isDraft)")
PR_BODY=$(echo "$PR_DATA" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.body || '')")

if [ "$IS_DRAFT" = "true" ]; then
  fail "PR is DRAFT (expected non-draft)"
else
  ok "PR is NOT draft"
fi

if echo "$PR_BODY" | grep -q "Closes #${ISSUE_NUMBER}"; then
  ok "PR body contains 'Closes #${ISSUE_NUMBER}'"
else
  fail "PR body missing 'Closes #${ISSUE_NUMBER}'"
fi

# ── 6. Merge PR ─────────────────────────────────────────────────────────
step "6/7 Merging PR #$PR_NUMBER..."
gh pr merge "$PR_NUMBER" --repo "$REPO" --merge --auto 2>&1 || \
  gh pr merge "$PR_NUMBER" --repo "$REPO" --merge 2>&1 || \
  warn "Merge may require manual approval"

sleep 3

# ── 7. Verify issue closed ──────────────────────────────────────────────
step "7/7 Verifying issue #$ISSUE_NUMBER is closed..."
ISSUE_STATE=$(gh issue view "$ISSUE_NUMBER" --repo "$REPO" --json state --jq '.state' 2>&1)

if [ "$ISSUE_STATE" = "CLOSED" ]; then
  ok "Issue #$ISSUE_NUMBER is CLOSED"
else
  # Give GitHub a few more seconds
  sleep 5
  ISSUE_STATE=$(gh issue view "$ISSUE_NUMBER" --repo "$REPO" --json state --jq '.state' 2>&1)
  if [ "$ISSUE_STATE" = "CLOSED" ]; then
    ok "Issue #$ISSUE_NUMBER is CLOSED"
  else
    fail "Issue #$ISSUE_NUMBER is still $ISSUE_STATE (expected CLOSED)"
  fi
fi

# ── Summary ─────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN} E2E TEST PASSED${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo "  Issue:    $REPO#$ISSUE_NUMBER — $ISSUE_TITLE"
echo "  PR:       $PR_URL"
echo "  Draft:    $IS_DRAFT → false"
echo "  Closes:   Closes #$ISSUE_NUMBER in body"
echo "  Merged:   yes"
echo "  Issue:    CLOSED"
echo ""
