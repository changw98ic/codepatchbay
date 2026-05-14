#!/usr/bin/env bash
# show-plan.sh — Display plan summary for user confirmation
# Usage: show-plan.sh <plan-file>

PLAN_FILE="${1:?Usage: show-plan.sh <plan-file>}"

if [ ! -f "$PLAN_FILE" ]; then
  echo -e "\033[0;31mPlan file not found: $PLAN_FILE\033[0m" >&2
  exit 1
fi

GREEN='\033[0;32m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

PLAN_CONTENT=$(cat "$PLAN_FILE")

# Extract title (first heading), fallback to filename
TITLE=$(echo "$PLAN_CONTENT" | grep -m1 '^#' | sed 's/^#* *//')
[ -z "$TITLE" ] && TITLE="$PLAN_ID"

# Extract plan ID from filename
PLAN_ID=$(basename "$PLAN_FILE" .md)

echo ""
echo -e "${BOLD}Plan: ${PLAN_ID}${NC}"
echo -e "${CYAN}Task: ${TITLE}${NC}"
echo ""

# Show acceptance criteria section if present
CRITERIA=$(echo "$PLAN_CONTENT" | sed -n '/^## Acceptance-Criteria\|^## Acceptance Criteria/,/^## /p' | head -20)
if [ -n "$CRITERIA" ]; then
  echo -e "${BOLD}Acceptance Criteria:${NC}"
  echo "$CRITERIA" | grep -E '^\s*-\s*\[' | head -10
  echo ""
fi

# Show first few steps
STEPS=$(echo "$PLAN_CONTENT" | sed -n '/^## [0-9]\|^### [0-9]\|^## Step\|^### Step/,/^## /p' | head -20)
if [ -n "$STEPS" ]; then
  echo -e "${BOLD}Key Steps:${NC}"
  echo "$STEPS" | grep -E '^\s*[-0-9]' | head -8
  echo ""
fi

echo -e "${CYAN}Full plan: $PLAN_FILE${NC}"
