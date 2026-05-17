#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(cd "$(mktemp -d)" && pwd -P)"
export CPB_HUB_ROOT="$TMP_DIR/hub"
trap 'rm -rf "$TMP_DIR"' EXIT

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

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    pass=$((pass + 1))
  else
    echo "FAIL: $label — expected='$expected' actual='$actual'" >&2
    fail=$((fail + 1))
  fi
}

assert_output() {
  local label="$1" pattern="$2" output="$3"
  if [[ "$output" == *"$pattern"* ]]; then
    pass=$((pass + 1))
  else
    echo "FAIL: $label — expected pattern '$pattern' in output: ${output:0:120}" >&2
    fail=$((fail + 1))
  fi
}

# ─── Setup: create a git repo ───
mkdir -p "$TMP_DIR/fake-repo/src/subdir"
cd "$TMP_DIR/fake-repo"
git init -q
git config user.email "test@test.com"
git config user.name "Test"
echo "hello" > README.md
git add . && git commit -q -m "init"

# ─── Setup: non-git directory ───
mkdir -p "$TMP_DIR/non-git-dir"

# ─── Test 1: resolve_repo_root from repo root ───
source "$ROOT/bridges/common.sh"
result="$(resolve_repo_root "$TMP_DIR/fake-repo")"
assert_eq "resolve_repo_root from repo root" "$TMP_DIR/fake-repo" "$result"

# ─── Test 2: resolve_repo_root from subdirectory ───
result="$(resolve_repo_root "$TMP_DIR/fake-repo/src/subdir")"
assert_eq "resolve_repo_root from subdir" "$TMP_DIR/fake-repo" "$result"

# ─── Test 3: resolve_repo_root from non-git dir falls back to resolved path ───
result="$(resolve_repo_root "$TMP_DIR/non-git-dir")"
assert_eq "resolve_repo_root non-git fallback" "$TMP_DIR/non-git-dir" "$result"

# ─── Test 4: resolve_repo_root with default (PWD inside repo subdir) ───
cd "$TMP_DIR/fake-repo/src/subdir"
result="$(resolve_repo_root)"
assert_eq "resolve_repo_root default PWD in subdir" "$TMP_DIR/fake-repo" "$result"

# ─── Test 5: cpb no-arg from inside git repo auto-discovers ───
cd "$TMP_DIR/fake-repo"
output="$("$ROOT/cpb" 2>&1)" && rc=$? || rc=$?
assert_output "no-arg auto-discover from repo root" "Auto-discovered" "$output"
assert_output "no-arg auto-discover attaches" "attached" "$output"

# ─── Test 6: cpb no-arg from inside subdir auto-discovers ───
cd "$TMP_DIR/fake-repo/src/subdir"
output="$("$ROOT/cpb" 2>&1)" && rc=$? || rc=$?
assert_output "no-arg auto-discover from subdir" "Auto-discovered" "$output"

# ─── Test 7: cpb no-arg from non-git dir shows help ───
cd "$TMP_DIR/non-git-dir"
output="$("$ROOT/cpb" 2>&1)" && rc=$? || rc=$?
assert_output "no-arg non-git shows help" "CodePatchbay" "$output"
# Must NOT show auto-discover
if [[ "$output" == *"Auto-discovered"* ]]; then
  echo "FAIL: no-arg non-git should not auto-discover" >&2
  fail=$((fail + 1))
else
  pass=$((pass + 1))
fi

# ─── Test 8: cpb --help still works ───
output="$("$ROOT/cpb" --help 2>&1)" && rc=$? || rc=$?
assert_output "--help shows usage" "CodePatchbay" "$output"

# ─── Test 9: cpb help still works ───
output="$("$ROOT/cpb" help 2>&1)" && rc=$? || rc=$?
assert_output "help shows usage" "CodePatchbay" "$output"

# ─── Test 10: cpb attach from subdirectory resolves to git root ───
cd "$TMP_DIR/fake-repo/src/subdir"
output="$("$ROOT/cpb" attach . 2>&1)" && rc=$? || rc=$?
assert_output "attach from subdir uses git root" "$TMP_DIR/fake-repo" "$output"
assert_output "attach from subdir attaches" "attached" "$output"

# ─── Test 11: cpb attach with explicit path still works ───
cd "$TMP_DIR"
output="$("$ROOT/cpb" attach "$TMP_DIR/fake-repo" 2>&1)" && rc=$? || rc=$?
assert_output "attach explicit path" "attached" "$output"

# ─── Test 12: cpb worker heartbeat from subdirectory resolves to git root ───
cd "$TMP_DIR/fake-repo/src/subdir"
output="$("$ROOT/cpb" worker heartbeat . 2>&1)" && rc=$? || rc=$?
assert_output "worker heartbeat from subdir uses git root" "$TMP_DIR/fake-repo" "$output"
assert_output "worker heartbeat succeeds" "heartbeat" "$output"

# ─── Test 13: cpb worker run from subdirectory resolves to git root ───
cd "$TMP_DIR/fake-repo/src/subdir"
output="$("$ROOT/cpb" worker run . --once 2>&1)" && rc=$? || rc=$?
assert_output "worker run once exits idle" "idle" "$output"
project_source="$("$ROOT/cpb" hub projects --json | node -e "let s=''; process.stdin.on('data', d => s += d).on('end', () => { const p = JSON.parse(s).find((item) => item.id === 'fake-repo'); process.stdout.write(p?.sourcePath || ''); });")"
assert_eq "worker run from subdir uses git root" "$TMP_DIR/fake-repo" "$project_source"

# ─── Test 14: cpb no-arg from CPB_ROOT shows help (not auto-discover) ───
cd "$ROOT"
output="$("$ROOT/cpb" 2>&1)" && rc=$? || rc=$?
assert_output "no-arg from CPB_ROOT shows help" "CodePatchbay" "$output"
if [[ "$output" == *"Auto-discovered"* ]]; then
  echo "FAIL: no-arg from CPB_ROOT should not auto-discover" >&2
  fail=$((fail + 1))
else
  pass=$((pass + 1))
fi

# ─── Test 15: cpb version still works ───
output="$("$ROOT/cpb" version 2>&1)"
assert_output "version flag" "cpb v" "$output"

echo ""
echo "cpb-repo-discovery: $pass passed, $fail failed"
test "$fail" -eq 0
