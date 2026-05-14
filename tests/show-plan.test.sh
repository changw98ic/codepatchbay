#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

pass=0
fail=0

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    pass=$((pass + 1))
  else
    echo "FAIL: $label - expected to contain '$needle'" >&2
    fail=$((fail + 1))
  fi
}

# Test 1: Plan with title and acceptance criteria
PLAN_FILE="$TMP_DIR/plan-001.md"
printf '%s\n' \
  '# Add dark mode' \
  '' \
  '## Steps' \
  '1. Add CSS variables' \
  '2. Create toggle component' \
  '' \
  '## Acceptance-Criteria' \
  '- [ ] Toggle switches theme' \
  '- [ ] Preference persists in localStorage' \
  > "$PLAN_FILE"

output=$("$ROOT/bridges/show-plan.sh" "$PLAN_FILE" 2>&1)
assert_contains "title" "Add dark mode" "$output"
assert_contains "plan id" "plan-001" "$output"
assert_contains "criteria" "Toggle switches theme" "$output"

# Test 2: Plan without heading (fallback to filename)
PLAN_FILE2="$TMP_DIR/plan-bare.md"
printf '%s\n' \
  'Some content without a heading.' \
  '- Step 1' \
  '- Step 2' \
  > "$PLAN_FILE2"

output2=$("$ROOT/bridges/show-plan.sh" "$PLAN_FILE2" 2>&1)
assert_contains "fallback title" "plan-bare" "$output2"

# Test 3: Missing file
if "$ROOT/bridges/show-plan.sh" "/nonexistent/file.md" 2>/dev/null; then
  echo "FAIL: should exit non-zero for missing file" >&2
  fail=$((fail + 1))
else
  pass=$((pass + 1))
fi

echo ""
echo "show-plan.sh: $pass passed, $fail failed"
test "$fail" -eq 0
