#!/usr/bin/env bash
set -euo pipefail

agent="${1:-codex}"
if [[ -n "${CPB_TEST_AGENT_LOG:-}" ]]; then
  printf '%s\n' "$agent" >> "$CPB_TEST_AGENT_LOG"
fi

prompt="$(cat)"
target=""
if [[ "$prompt" =~ Write[[:space:]].*to:[[:space:]](.+) ]]; then
  target="${BASH_REMATCH[1]}"
fi

case "$target" in
  *plan-*.md)
    mkdir -p "$(dirname "$target")"
    cat > "$target" <<'EOF'
## Handoff
ACP stub plan.

## Acceptance-Criteria
- Plan written.
EOF
    ;;
  *deliverable-*.md)
    mkdir -p "$(dirname "$target")"
    cat > "$target" <<'EOF'
## Handoff
ACP stub deliverable.

## Acceptance-Criteria
- Deliverable written.
EOF
    ;;
  *verdict-*.md)
    mkdir -p "$(dirname "$target")"
    cat > "$target" <<'EOF'
VERDICT: PASS
ACP stub verification passed.
EOF
    ;;
esac

printf 'done\n'
