#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(cd "$(mktemp -d)" && pwd -P)"
export CPB_HUB_ROOT="$TMP_DIR/hub"
# Use a non-default port to avoid conflicts with any running Hub
export CPB_PORT="13456"
export CPB_HOST="127.0.0.1"
trap 'rm -rf "$TMP_DIR"' EXIT

pass=0
fail=0

assert_output() {
  local label="$1" pattern="$2" output="$3"
  if [[ "$output" == *"$pattern"* ]]; then
    pass=$((pass + 1))
  else
    echo "FAIL: $label — expected pattern '$pattern' in output: ${output:0:200}" >&2
    fail=$((fail + 1))
  fi
}

assert_not_output() {
  local label="$1" pattern="$2" output="$3"
  if [[ "$output" != *"$pattern"* ]]; then
    pass=$((pass + 1))
  else
    echo "FAIL: $label — should NOT contain '$pattern' in output: ${output:0:200}" >&2
    fail=$((fail + 1))
  fi
}

# Ensure any leftover server is stopped on exit
cleanup_server() {
  "$ROOT/cpb" hub stop 2>/dev/null || true
}
trap cleanup_server EXIT

# ─── Test 1: hub start starts the server ───
output="$("$ROOT/cpb" hub start 2>&1)" && rc=$? || rc=$?
assert_output "hub start succeeds" "Hub started" "$output"
assert_output "hub start shows port" "http://127.0.0.1:13456" "$output"
assert_output "hub start shows pid" "pid:" "$output"

# ─── Test 2: hub.json exists with health=alive ───
hub_json="$CPB_HUB_ROOT/state/hub.json"
if [ -f "$hub_json" ]; then
  health=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$hub_json','utf8')).health)" 2>/dev/null)
  if [ "$health" = "alive" ]; then
    pass=$((pass + 1))
  else
    echo "FAIL: hub.json health is '$health', expected 'alive'" >&2
    fail=$((fail + 1))
  fi
else
  echo "FAIL: hub.json not found at $hub_json" >&2
  fail=$((fail + 1))
fi

# ─── Test 3: hub status --json shows alive ───
output="$("$ROOT/cpb" hub status --json 2>&1)"
assert_output "hub status json alive" '"alive": true' "$output"

# ─── Test 4: hub status (human) shows alive ───
output="$("$ROOT/cpb" hub status 2>&1)"
assert_output "hub status human alive" "Server: alive" "$output"

# ─── Test 5: hub start when already running reports as such ───
output="$("$ROOT/cpb" hub start 2>&1)" && rc=$? || rc=$?
assert_output "hub start already running" "already running" "$output"

# ─── Test 6: hub stop stops the server ───
output="$("$ROOT/cpb" hub stop 2>&1)" && rc=$? || rc=$?
assert_output "hub stop succeeds" "Hub stopped" "$output"

# Wait briefly for process to exit
sleep 0.3

# ─── Test 7: hub status shows down after stop ───
output="$("$ROOT/cpb" hub status --json 2>&1)"
assert_output "hub status after stop" '"alive": false' "$output"

# ─── Test 8: hub stop when not running reports as such ───
output="$("$ROOT/cpb" hub stop 2>&1)" && rc=$? || rc=$?
assert_output "hub stop not running" "not running" "$output"

# ─── Test 9: auto-discovery shows Hub liveness (down state) ───
mkdir -p "$TMP_DIR/repo"
cd "$TMP_DIR/repo"
git init -q
git config user.email "test@test.com"
git config user.name "Test"
echo "hello" > README.md
git add . && git commit -q -m "init"

output="$("$ROOT/cpb" 2>&1)" && rc=$? || rc=$?
assert_output "auto-discover attaches" "Auto-discovered" "$output"
assert_output "auto-discover shows hub status" "Hub:" "$output"
assert_not_output "auto-discover does not claim alive" "Hub: alive" "$output"

# ─── Test 10: auto-discovery shows Hub alive when started ───
"$ROOT/cpb" hub start >/dev/null 2>&1
sleep 0.3
output="$("$ROOT/cpb" 2>&1)" && rc=$? || rc=$?
assert_output "auto-discover alive shows hub alive" "Hub: alive" "$output"

# Cleanup
"$ROOT/cpb" hub stop >/dev/null 2>&1 || true

echo ""
echo "cpb-hub-start: $pass passed, $fail failed"
test "$fail" -eq 0
