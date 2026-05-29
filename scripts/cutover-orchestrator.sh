#!/usr/bin/env bash
# Cutover script: migrate from legacy worker to Hub Orchestrator v1
set -euo pipefail

HUB_ROOT="${1:-$HOME/.cpb}"
BACKUP_TS=$(date +%s)

echo "=== CPB Hub Orchestrator v1 Cutover ==="
echo ""

# 1. Stop legacy workers
echo "[1/5] Stopping legacy workers..."
node "${CPB_ROOT:-$(dirname "$0")/..}/scripts/stop-legacy-workers.mjs" 2>/dev/null || true

# 2. Stop hub if running
echo "[2/5] Stopping hub..."
npx codepatchbay hub stop 2>/dev/null || true

# 3. Backup old state
echo "[3/5] Backing up old state..."
for dir in queue workers assignments; do
  if [ -d "${HUB_ROOT}/${dir}" ]; then
    echo "  backing up ${dir} → ${dir}.legacy.${BACKUP_TS}"
    mv "${HUB_ROOT}/${dir}" "${HUB_ROOT}/${dir}.legacy.${BACKUP_TS}"
  fi
done

# 4. Create new runtime structure
echo "[4/5] Initializing new runtime..."
mkdir -p "${HUB_ROOT}/orchestrator"
mkdir -p "${HUB_ROOT}/assignments"
mkdir -p "${HUB_ROOT}/workers/registry"
mkdir -p "${HUB_ROOT}/workers/inbox"
mkdir -p "${HUB_ROOT}/workers/desired"
mkdir -p "${HUB_ROOT}/supervisor/decisions"

echo "  Runtime initialized at ${HUB_ROOT}"

# 5. Verify
echo "[5/5] Verifying..."
if [ -d "${HUB_ROOT}/orchestrator" ] && [ -d "${HUB_ROOT}/assignments" ]; then
  echo ""
  echo "=== Cutover complete ==="
  echo "Start the orchestrator with: cpb hub-orch start"
  echo ""
  echo "Legacy backups:"
  for dir in "${HUB_ROOT}"/*.legacy.*; do
    [ -d "$dir" ] && echo "  $(basename "$dir")"
  done
else
  echo "ERROR: Runtime initialization failed" >&2
  exit 1
fi
