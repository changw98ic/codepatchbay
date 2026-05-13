#!/usr/bin/env bash
# common.sh — Flow bridge 共享函数库
# source "$(dirname "$0")/common.sh"

FLOW_ROOT="${FLOW_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# ─── RTK Prompt 构建器 (with cwd + permission constraints) ───

# ─── 颜色 ───
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

# ─── 项目校验 ───
require_project() {
  local project="$1" wiki_dir="$FLOW_ROOT/wiki/projects/$1"
  if [ ! -d "$wiki_dir" ]; then
    echo -e "${RED}Project '$project' not found. Run 'flow init' first.${NC}" >&2
    exit 1
  fi
}

require_file() {
  if [ ! -f "$1" ]; then
    echo -e "${RED}File not found: $1${NC}" >&2
    exit 1
  fi
}

# Validate project name: alphanumeric + hyphens only
require_safe_name() {
  local name="$1"
  if [[ ! "$name" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$ ]]; then
    echo -e "${RED}Invalid project name: '$name' (alphanumeric + hyphens only)${NC}" >&2
    exit 1
  fi
}

# Get the target project's source directory (stored by init-project.sh)
# Usage: get_project_path <project-name>
get_project_path() {
  local project="$1"
  local meta="$FLOW_ROOT/wiki/projects/$project/project.json"
  if [ -f "$meta" ]; then
    META_FILE="$meta" node -e "try{const p=JSON.parse(require('fs').readFileSync(process.env.META_FILE,'utf8'));process.stdout.write(p.sourcePath||'')}catch{}" 2>/dev/null
  fi
}

# ─── 原子 ID 生成 (mkdir lock, placeholder file prevents race) ───
# next_id <dir> <prefix>
next_id() {
  local dir="$1"
  local prefix="$2"
  local lockdir="$dir/.flow-id.lock"
  mkdir -p "$dir"

  local attempts=0
  while ! mkdir "$lockdir" 2>/dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -gt 100 ]; then
      rmdir "$lockdir" 2>/dev/null
      continue
    fi
    sleep 0.1
  done

  local last
  last=$(find "$dir" -maxdepth 1 -name "${prefix}-[0-9]*.md" -print 2>/dev/null \
    | sed -E "s/.*${prefix}-([0-9]+)\.md$/\1/" | sort -n | tail -1)
  local new=$((10#${last:-0} + 1))
  local new_id
  new_id=$(printf "%03d" "$new")

  # Create placeholder while still holding lock to prevent ID collision
  touch "$dir/${prefix}-${new_id}.md"

  rmdir "$lockdir" 2>/dev/null
  echo "$new_id"
}

# ─── 原子日志追加 (mkdir lock) ───
log_append() {
  local wiki_dir="$1"
  local msg="$2"
  local log="$wiki_dir/log.md"
  local lockdir="$wiki_dir/.flow-log.lock"
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  local attempts=0
  while ! mkdir "$lockdir" 2>/dev/null; do
    attempts=$((attempts + 1))
    if [ "$attempts" -gt 60 ]; then
      rmdir "$lockdir" 2>/dev/null
      continue
    fi
    sleep 0.05
  done
  echo "- **$ts** | $msg" >> "$log"
  rmdir "$lockdir" 2>/dev/null
}

# ─── RTK Prompt 构建器 (with cwd + permission constraints) ───
# Set FLOW_DANGEROUS=1 to disable all constraints (unrestricted agent access)

# rtk_codex_plan <project> <task> <plan_file>
rtk_codex_plan() {
  local project="$1" task="$2" plan_file="$3"
  local project_cwd
  project_cwd=$(get_project_path "$project")
  local constraints=""
  if [ "${FLOW_DANGEROUS:-0}" != "1" ]; then
    constraints="## Constraints
- ONLY write files under: $FLOW_ROOT/wiki/projects/$project/inbox/
- ONLY read files under: $FLOW_ROOT/wiki/projects/$project/ or $FLOW_ROOT/profiles/ or $FLOW_ROOT/wiki/system/ or $FLOW_ROOT/templates/
- Do NOT execute terminal commands. This is a planning-only phase."
  fi
  cat << PROMPT
You are Flow Codex (Planner). Role: $(head -3 "$FLOW_ROOT/profiles/codex/soul.md" | tail -1 | sed 's/^# //')

## CRITICAL: Primary Directive
Your plan MUST address THIS EXACT task. Do NOT plan for any other work regardless of project context:
**$task**

$constraints

## Files (read via fs/read_text_file as needed)
- Role definition: $FLOW_ROOT/profiles/codex/soul.md
- Project context: $FLOW_ROOT/wiki/projects/$project/context.md
- Existing decisions: $FLOW_ROOT/wiki/projects/$project/decisions.md
- Handshake format: $FLOW_ROOT/wiki/system/handshake-protocol.md
- Plan template: $FLOW_ROOT/templates/handoff/plan-to-execute.md

## Output
Write the plan to: $plan_file
The plan title/heading MUST reference the task: "$task"
Follow handshake-protocol (codex->claude, Phase: plan).
Use scope-matched step count with concrete acceptance criteria.
PROMPT
}

# rtk_claude_execute <project> <plan_id> <deliverable_file> [verdict_file]
rtk_claude_execute() {
  local project="$1" plan_id="$2" deliverable_file="$3"
  local verdict_file="${4:-}"
  local plan_file="$FLOW_ROOT/wiki/projects/$project/inbox/plan-${plan_id}.md"
  local project_cwd
  project_cwd=$(get_project_path "$project")
  local constraints=""
  if [ "${FLOW_DANGEROUS:-0}" != "1" ]; then
    constraints="## Constraints
- Write code ONLY in the target project directory${project_cwd:+: $project_cwd}
- Write deliverable ONLY to: $deliverable_file
- Write verdicts ONLY under: $FLOW_ROOT/wiki/projects/$project/outputs/
- Do NOT modify files under: $FLOW_ROOT/wiki/system/, $FLOW_ROOT/profiles/, $FLOW_ROOT/bridges/
- Do NOT read or write files outside the project and Flow wiki directories."
  fi
  local fix_section=""
  if [ -n "$verdict_file" ] && [ -f "$verdict_file" ]; then
    fix_section="## Previous Verification Failure (FIX REQUIRED)
The previous deliverable was verified and REJECTED. Read the verdict for details:
- Verdict file: $verdict_file
You MUST address the specific failures listed in the verdict. Do NOT repeat the same approach."
  fi
  cat << PROMPT
You are Flow Claude (Executor). Role: $(head -3 "$FLOW_ROOT/profiles/claude/soul.md" | tail -1 | sed 's/^# //')

$constraints

$fix_section

## Files (read via fs/read_text_file as needed)
- Role definition: $FLOW_ROOT/profiles/claude/soul.md
- Plan to execute: $plan_file
- Project context: $FLOW_ROOT/wiki/projects/$project/context.md
- Decisions: $FLOW_ROOT/wiki/projects/$project/decisions.md
- Deliverable template: $FLOW_ROOT/templates/handoff/execute-to-review.md
- Handshake format: $FLOW_ROOT/wiki/system/handshake-protocol.md

## Instructions
1. Read the plan file first.
2. Implement code changes described in the plan.
3. Run tests and record results.
4. Write the deliverable to: $deliverable_file
Follow handshake-protocol (claude->codex, Phase: execute).
Include plan-ref: $plan_id in the deliverable metadata.
PROMPT
}

# rtk_codex_verify <project> <deliverable_id> <verdict_file> [diff_artifact]
rtk_codex_verify() {
  local project="$1" deliverable_id="$2" verdict_file="$3"
  local diff_artifact="${4:-}"
  local deliverable_file="$FLOW_ROOT/wiki/projects/$project/outputs/deliverable-${deliverable_id}.md"
  local constraints=""
  if [ "${FLOW_DANGEROUS:-0}" != "1" ]; then
    constraints="## Constraints
- ONLY write the verdict to: $verdict_file
- ONLY read files under: $FLOW_ROOT/wiki/projects/$project/ or $FLOW_ROOT/profiles/
- Do NOT execute terminal commands. This is a verification-only phase.
- Do NOT modify any code files."
  fi
  local diff_section=""
  if [ -n "$diff_artifact" ] && [ -f "$diff_artifact" ]; then
    diff_section="## Diff Artifact
A code diff was generated before this verification phase. Read it to understand what changed:
- Diff file: $diff_artifact

Use the diff to verify the actual code changes match the deliverable claims."
  fi
  cat << PROMPT
You are Flow Codex (Verifier). Role: $(head -3 "$FLOW_ROOT/profiles/codex/soul.md" | tail -1 | sed 's/^# //')

$constraints

$diff_section

## Files (read via fs/read_text_file as needed)
- Role definition: $FLOW_ROOT/profiles/codex/soul.md
- Deliverable to verify: $deliverable_file
- Project context: $FLOW_ROOT/wiki/projects/$project/context.md
- Decisions: $FLOW_ROOT/wiki/projects/$project/decisions.md

## Instructions
1. Read the deliverable. Extract plan-ref from its metadata.
2. Read the referenced plan file from inbox/.
3. Verify against the plan's Acceptance-Criteria.
4. Give a verdict.
5. Write the verdict to: $verdict_file

The verdict file MUST have this as the VERY FIRST LINE (no markdown, no headers before it):
VERDICT: <PASS|FAIL|PARTIAL>
Follow with detailed evidence and reasoning. Be evidence-based, not reassuring.
PROMPT
}

# ─── Dashboard 更新 ───
dashboard_update() {
  local project="$1" phase="$2" status="$3" next="$4"
  local dash="$FLOW_ROOT/wiki/system/dashboard.md"
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  DASH_FILE="$dash" DASH_PROJECT="$project" DASH_PHASE="$phase" \
  DASH_STATUS="$status" DASH_NEXT="$next" DASH_TS="$ts" \
  node -e '
    const fs = require("fs");
    const f = process.env.DASH_FILE;
    const project = process.env.DASH_PROJECT;
    let c = fs.readFileSync(f, "utf8");
    const entry = "\n### " + project + "\n- **status**: " + process.env.DASH_STATUS +
      "\n- **phase**: " + process.env.DASH_PHASE +
      "\n- **updated**: " + process.env.DASH_TS +
      "\n- **next**: " + process.env.DASH_NEXT + "\n";
    const marker = "## 活跃项目";
    const idx = c.indexOf(marker);
    if (idx >= 0) {
      const rest = c.substring(idx + marker.length);
      const cleaned = rest.replace(new RegExp("\\n### " + project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\n(- .+\\n)*"), "");
      c = c.substring(0, idx) + marker + entry + cleaned;
    }
    fs.writeFileSync(f, c);
  ' 2>/dev/null
}

# ─── Claude provider variant overlays ───
flow_env_first() {
  local name value
  for name in "$@"; do
    value="${!name:-}"
    if [ -n "$value" ]; then
      printf '%s' "$value"
      return 0
    fi
  done
  return 1
}

flow_env_any() {
  local name
  for name in "$@"; do
    if [ -n "${!name:-}" ]; then
      return 0
    fi
  done
  return 1
}

flow_require_variant_env() {
  local variant="$1" label="$2" value="$3" names="$4"
  if [ -z "$value" ]; then
    echo -e "${RED}Missing $label for Claude variant '$variant'. Set one of: $names${NC}" >&2
    exit 1
  fi
}

flow_export_claude_gateway_variant() {
  local variant="$1" display_name="$2" base_url="$3" auth_token="$4" model="$5"
  export ANTHROPIC_BASE_URL="$base_url"
  export ANTHROPIC_AUTH_TOKEN="$auth_token"
  export ANTHROPIC_MODEL="$model"
  export ANTHROPIC_CUSTOM_MODEL_OPTION="$model"
  export ANTHROPIC_CUSTOM_MODEL_OPTION_NAME="$display_name"
  export ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION="Flow provider variant: $variant"
  export ANTHROPIC_DEFAULT_SONNET_MODEL="$model"
  export ANTHROPIC_DEFAULT_OPUS_MODEL="$model"
  export ANTHROPIC_DEFAULT_HAIKU_MODEL="$model"
  export CLAUDE_CODE_SUBAGENT_MODEL="$model"
  export FLOW_ACTIVE_CLAUDE_VARIANT="$variant"
}

flow_apply_kimi_variant() {
  local variant="kimi-k2.6"
  local base_url auth_token model
  base_url="$(flow_env_first OLLAMA_CLOUD_URL OLLAMA_CLOUD_BASE_URL OLLAMACLOUD_BASE_URL OLLAMACLOUD_URL KIMI_BASE_URL MOONSHOT_BASE_URL || true)"
  auth_token="$(flow_env_first OLLAMA_CLOUD_KEY OLLAMA_CLOUD_API_KEY OLLAMACLOUD_API_KEY OLLAMACLOUD_KEY KIMI_API_KEY MOONSHOT_API_KEY || true)"
  model="$(flow_env_first OLLAMA_CLOUD_MODEL OLLAMACLOUD_MODEL KIMI_MODEL MOONSHOT_MODEL || printf 'kimi-k2.6')"

  flow_require_variant_env "$variant" "base URL" "$base_url" "OLLAMA_CLOUD_URL, OLLAMA_CLOUD_BASE_URL, OLLAMACLOUD_BASE_URL, KIMI_BASE_URL, MOONSHOT_BASE_URL"
  flow_require_variant_env "$variant" "API key" "$auth_token" "OLLAMA_CLOUD_KEY, OLLAMA_CLOUD_API_KEY, OLLAMACLOUD_API_KEY, KIMI_API_KEY, MOONSHOT_API_KEY"
  flow_export_claude_gateway_variant "$variant" "Kimi K2.6" "$base_url" "$auth_token" "$model"
}

flow_apply_xiaomi_variant() {
  local variant="mimo-v2.5pro"
  local base_url auth_token model
  base_url="$(flow_env_first XIAOMI_BASE_URL MIMO_BASE_URL || true)"
  auth_token="$(flow_env_first XIAOMI_API_KEY XIAOMI_AUTH_TOKEN MIMO_API_KEY MIMO_AUTH_TOKEN || true)"
  model="$(flow_env_first XIAOMI_MODEL MIMO_MODEL || printf 'mimo-v2.5pro')"

  flow_require_variant_env "$variant" "base URL" "$base_url" "XIAOMI_BASE_URL, MIMO_BASE_URL"
  flow_require_variant_env "$variant" "API key" "$auth_token" "XIAOMI_API_KEY, XIAOMI_AUTH_TOKEN, MIMO_API_KEY, MIMO_AUTH_TOKEN"
  flow_export_claude_gateway_variant "$variant" "MiMo v2.5 Pro" "$base_url" "$auth_token" "$model"
}

flow_apply_claude_variant() {
  local requested normalized
  requested="${FLOW_CLAUDE_VARIANT:-${FLOW_BUILDER_VARIANT:-${FLOW_ACP_CLAUDE_VARIANT:-}}}"

  if [ -z "$requested" ]; then
    if flow_env_any OLLAMA_CLOUD_URL OLLAMA_CLOUD_BASE_URL OLLAMACLOUD_BASE_URL OLLAMACLOUD_URL KIMI_BASE_URL MOONSHOT_BASE_URL; then
      requested="kimi-k2.6"
    elif flow_env_any XIAOMI_BASE_URL MIMO_BASE_URL; then
      requested="mimo-v2.5pro"
    else
      return 0
    fi
  fi

  normalized="$(printf '%s' "$requested" | tr '[:upper:]' '[:lower:]')"
  case "$normalized" in
    none|off|default|anthropic|claude)
      export FLOW_ACTIVE_CLAUDE_VARIANT="none"
      ;;
    kimi|kimi-k2.6|ollama|ollamacloud|ollama-cloud)
      flow_apply_kimi_variant
      ;;
    xiaomi|mimo|mimo-v2.5pro)
      flow_apply_xiaomi_variant
      ;;
    *)
      echo -e "${RED}Unknown Claude variant: '$requested'. Use kimi-k2.6, mimo-v2.5pro, or none.${NC}" >&2
      exit 1
      ;;
  esac
}

# ─── ACP 执行 ───
acp_run() {
  local agent="$1"; shift
  local acp="${FLOW_ACP_CLIENT:-$FLOW_ROOT/bridges/acp-client.mjs}"
  if [ ! -x "$acp" ]; then
    echo -e "${RED}ACP client not executable: $acp${NC}" >&2
    exit 1
  fi
  if [ "$agent" = "claude" ]; then
    flow_apply_claude_variant
  fi
  "$acp" --agent "$agent" --cwd "${FLOW_ACP_CWD:-$PWD}" "$@"
}
