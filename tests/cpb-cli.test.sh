#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

project="cli-test-$$"

cleanup() {
  rm -rf "$ROOT/wiki/projects/$project"
}
trap 'cleanup; rm -rf "$TMP_DIR"' EXIT

# Init project
mkdir -p "$TMP_DIR/src"
printf '{"scripts":{"test":"echo ok"}}\n' > "$TMP_DIR/src/package.json"
"$ROOT/cpb" init "$TMP_DIR/src" "$project" >/dev/null

pass=0
fail=0

run_test() {
  local label="$1" cmd="$2"
  if eval "$cmd" >/dev/null 2>&1; then
    pass=$((pass + 1))
  else
    echo "FAIL: $label (exit $?)" >&2
    fail=$((fail + 1))
  fi
}

# Test help
run_test "help" "$ROOT/cpb help"

# Test list
run_test "list" "$ROOT/cpb list"

# Test status
run_test "status" "$ROOT/cpb status $project"

# Test inbox (empty)
run_test "inbox empty" "$ROOT/cpb inbox $project"

# Test outputs (empty)
run_test "outputs empty" "$ROOT/cpb outputs $project"

# Test diff (no git repo, should fail gracefully)
run_test "diff no-git" "! $ROOT/cpb diff $project"

# Test log (no log file)
run_test "log empty" "$ROOT/cpb log $project"

# Test remove with --force
run_test "remove --force" "$ROOT/cpb remove $project --force"

# Re-create for cleanup
"$ROOT/cpb" init "$TMP_DIR/src" "$project" >/dev/null

echo ""
echo "cpb-cli: $pass passed, $fail failed"
test "$fail" -eq 0
