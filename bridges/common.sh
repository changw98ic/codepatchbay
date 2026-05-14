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
- Do NOT execute terminal commands (npm, node, git, etc). This is a planning-only phase.
- You MAY and SHOULD use your Read, Glob, and Grep tools to read files — these are NOT terminal commands."
  fi
  local skills_section
  skills_section=$(build_skills_section codex)
  cat << PROMPT
You are Flow Codex (Planner). Role: $(head -3 "$FLOW_ROOT/profiles/codex/soul.md" | tail -1 | sed 's/^# //')

$skills_section

## CRITICAL: Primary Directive
Your plan MUST address THIS EXACT task. Do NOT plan for any other work regardless of project context:
**$task**

$constraints

## Files to read
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
- Do NOT read or write files outside the project, Flow wiki, and Flow profiles directories."
  fi
  local fix_section=""
  if [ -n "$verdict_file" ] && [ -f "$verdict_file" ]; then
    fix_section="## Previous Verification Failure (FIX REQUIRED)
The previous deliverable was verified and REJECTED. Read the verdict for details:
- Verdict file: $verdict_file
You MUST address the specific failures listed in the verdict. Do NOT repeat the same approach."
  fi
  local skills_section
  skills_section=$(build_skills_section claude)
  cat << PROMPT
You are Flow Claude (Executor). Role: $(head -3 "$FLOW_ROOT/profiles/claude/soul.md" | tail -1 | sed 's/^# //')

$skills_section

$constraints

$fix_section

## Files to read
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
- Do NOT execute terminal commands (npm, node, git, etc). This is a verification-only phase.
- Do NOT modify any code files.
- You MAY and SHOULD use your Read, Glob, and Grep tools to read files — these are NOT terminal commands."
  fi
  local diff_section=""
  if [ -n "$diff_artifact" ] && [ -f "$diff_artifact" ]; then
    diff_section="## Diff Artifact
A code diff was generated before this verification phase. Read it to understand what changed:
- Diff file: $diff_artifact

Use the diff to verify the actual code changes match the deliverable claims."
  fi
  local skills_section
  skills_section=$(build_skills_section codex)
  cat << PROMPT
You are Flow Codex (Verifier). Role: $(head -3 "$FLOW_ROOT/profiles/codex/soul.md" | tail -1 | sed 's/^# //')

$skills_section

$constraints

$diff_section

## Files to read
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

# ─── Skill catalog builder ───
build_skills_section() {
  local role="$1"
  local skills_dir="$FLOW_ROOT/profiles/$role/skills"
  [ -d "$skills_dir" ] || return 0
  local count=0
  echo "## Available Skills"
  for f in $(ls "$skills_dir"/*.md 2>/dev/null | sort); do
    [ -f "$f" ] || continue
    [ $count -ge 10 ] && { echo "- ... (truncated, max 10)"; break; }
    local name desc
    local fm
    fm=$(awk 'BEGIN{n=0} /^---$/{n++; if(n==2) exit} n==1 && !/^---$/{print}' "$f")
    name=$(echo "$fm" | sed -n 's/^name: *//p' | head -1)
    desc=$(echo "$fm" | sed -n 's/^description: *//p' | head -1)
    if [ -n "$name" ]; then
      echo "- /$name: $desc → $f"
      count=$((count + 1))
    fi
  done
}

# ─── Claude provider variant overlays ───
flow_apply_claude_variant() {
  local variant_script="${FLOW_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}/bridges/apply-variant.mjs"
  if [ ! -f "$variant_script" ]; then
    echo -e "${RED}Variant module not found: $variant_script${NC}" >&2
    exit 1
  fi
  local output
  output="$(node "$variant_script" --export 2>&1)" || {
    echo -e "${RED}${output}${NC}" >&2
    exit 1
  }
  eval "$output"
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
