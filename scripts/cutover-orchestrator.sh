#!/usr/bin/env bash
set -euo pipefail

cat >&2 <<'EOF'
ERROR: scripts/cutover-orchestrator.sh is retired and did not modify Hub state.

The legacy script moved live queue, worker, and assignment directories without
a maintenance lease or a recoverable transaction. Use the supported offline
workflow instead:

  cpb hub backup --output /secure/backups/cpb-hub

After verification, start the orchestrator with:

  cpb hub orch start
EOF

exit 2
