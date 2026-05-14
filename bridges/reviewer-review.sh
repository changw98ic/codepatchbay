#!/usr/bin/env bash
set -euo pipefail

# reviewer-review.sh — ACP + RTK: Reviewer code review
# Usage: reviewer-review.sh <project> <deliverable-id>

FLOW_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=common.sh
source "$FLOW_ROOT/bridges/common.sh"

PROJECT="${1:?Usage: reviewer-review.sh <project> <deliverable-id>}"
DELIVERABLE_ID="${2:?Usage: reviewer-review.sh <project> <deliverable-id>}"
WIKI_DIR="$FLOW_ROOT/wiki/projects/$PROJECT"

require_safe_name "$PROJECT"
require_project "$PROJECT"
require_file "$WIKI_DIR/outputs/deliverable-${DELIVERABLE_ID}.md"

FLOW_ACP_CWD=$(get_project_path "$PROJECT")
export FLOW_ACP_CWD

REVIEW_FILE="$WIKI_DIR/outputs/review-${DELIVERABLE_ID}.md"

echo "Reviewing [$PROJECT] deliverable-$DELIVERABLE_ID..."
echo "Output: $REVIEW_FILE"

# Build reviewer prompt
PLAN_FILE=""
if [ -f "$WIKI_DIR/inbox/plan-${DELIVERABLE_ID}.md" ]; then
  PLAN_FILE="$WIKI_DIR/inbox/plan-${DELIVERABLE_ID}.md"
fi

DELIVERABLE_FILE="$WIKI_DIR/outputs/deliverable-${DELIVERABLE_ID}.md"

constraints=""
if [ "${FLOW_DANGEROUS:-0}" != "1" ]; then
  constraints="## Constraints
- ONLY write the review to: $REVIEW_FILE
- ONLY read files under: $FLOW_ROOT/wiki/projects/$PROJECT/ or $FLOW_ROOT/profiles/
- Do NOT execute terminal commands. This is a review-only phase.
- Do NOT modify any code files."
fi

SKILLS_SECTION=$(build_skills_section reviewer)

PROMPT=$(cat << PROMPT
You are Flow Reviewer. Role: Code Review Expert

$SKILLS_SECTION

## Task
Review the deliverable for code quality, correctness, maintainability, and security.

$constraints

## Files (read via fs/read_text_file as needed)
- Deliverable to review: $DELIVERABLE_FILE
${PLAN_FILE:+- Implementation plan: $PLAN_FILE}
- Project context: $WIKI_DIR/context.md
- Decisions: $WIKI_DIR/decisions.md
- Role definition: $FLOW_ROOT/profiles/reviewer/soul.md

## Review Criteria
Rate each area: Critical / Major / Minor / Suggestion
- Correctness: logic, edge cases, error handling
- Readability: naming, structure, clarity
- Maintainability: coupling, abstraction level
- Security: injection, leaks, OWASP top 10
- Performance: obvious bottlenecks

## Output
Write the review to: $REVIEW_FILE

Format:
## Summary
[Overall assessment]

## Findings
### [Severity] [Title]
- **File**: path:line
- **Issue**: description
- **Fix**: suggested fix

## Verdict
REVIEW: <PASS|FAIL>
[If FAIL, list must-fix items]
PROMPT
)
printf '%s' "$PROMPT" | acp_run codex 2>&1

if [ -f "$REVIEW_FILE" ]; then
  REVIEW_VERDICT=$(grep -E "^REVIEW:" "$REVIEW_FILE" | head -1 | sed 's/^REVIEW:[[:space:]]*//' || echo "")
  if [ -z "$REVIEW_VERDICT" ]; then
    REVIEW_VERDICT=$(head -20 "$REVIEW_FILE" | grep -iE "REVIEW:[[:space:]]*(PASS|FAIL)" | head -1 | sed 's/.*REVIEW:[[:space:]]*//' 2>/dev/null || echo "UNKNOWN")
  fi
  log_append "$WIKI_DIR" "reviewer | review | deliverable-$DELIVERABLE_ID | $REVIEW_VERDICT"

  echo ""
  echo "Review: $REVIEW_VERDICT"
  if echo "$REVIEW_VERDICT" | grep -qi "FAIL"; then
    echo "Review failed. Must-fix items in: $REVIEW_FILE"
  else
    echo "Review passed."
  fi
else
  log_append "$WIKI_DIR" "reviewer | review | review not created for deliverable-$DELIVERABLE_ID | FAIL"
  echo "Warning: Review not created." >&2
  exit 1
fi
