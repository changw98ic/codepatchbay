#!/usr/bin/env bash
# common.sh — CodePatchbay bridge 共享函数库
# source "$(dirname "$0")/common.sh"

CPB_EXECUTOR_ROOT="${CPB_EXECUTOR_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CPB_ROOT="${CPB_ROOT:-$CPB_EXECUTOR_ROOT}"
# ─── RTK Prompt 构建器 (with cwd + permission constraints) ───

# ─── 颜色 ───
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

# ─── 项目校验 ───
require_project() {
  local project="$1" wiki_dir="$CPB_ROOT/wiki/projects/$1"
  if [ ! -d "$wiki_dir" ]; then
    echo -e "${RED}Project '$project' not found. Run 'cpb init' first.${NC}" >&2
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
  if [ -n "${CPB_PROJECT_PATH_OVERRIDE:-}" ]; then
    printf "%s" "$CPB_PROJECT_PATH_OVERRIDE"
    return 0
  fi
  local meta="$CPB_ROOT/wiki/projects/$project/project.json"
  if [ -f "$meta" ]; then
    META_FILE="$meta" node -e "try{const p=JSON.parse(require('fs').readFileSync(process.env.META_FILE,'utf8'));process.stdout.write(p.sourcePath||'')}catch{}" 2>/dev/null
  fi
}

# Resolve a directory path to its git repository toplevel when possible,
# falling back to the resolved absolute path.
# Usage: resolve_repo_root [path]   (defaults to $PWD)
resolve_repo_root() {
  local target="${1:-$PWD}"
  local resolved
  resolved="$(cd "$target" 2>/dev/null && pwd -P)" || { echo "$target"; return; }
  local git_root
  git_root="$(git -C "$resolved" rev-parse --show-toplevel 2>/dev/null)" || true
  if [ -n "$git_root" ]; then
    echo "$git_root"
  else
    echo "$resolved"
  fi
}

# ─── 原子 ID 生成 (mkdir lock, placeholder file prevents race) ───
# next_id <dir> <prefix>
next_id() {
  local dir="$1"
  local prefix="$2"
  local lockdir="$dir/.cpb-id.lock"
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
  local lockdir="$wiki_dir/.cpb-log.lock"
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
# Set CPB_DANGEROUS=1 to disable all constraints (unrestricted agent access)

# Pre-read a file, return empty string if missing
_pre_read() { [ -f "$1" ] && cat "$1" 2>/dev/null || echo "[file not found: $1]"; }

# rtk_codex_plan <project> <task> <plan_file>
rtk_codex_plan() {
  local project="$1" task="$2" plan_file="$3"
  local project_cwd
  project_cwd=$(get_project_path "$project")
  local constraints=""
  if [ "${CPB_DANGEROUS:-0}" != "1" ]; then
    constraints="## Constraints
- ONLY write files under: $CPB_ROOT/wiki/projects/$project/inbox/
- Do NOT execute terminal commands (npm, node, git, etc). This is a planning-only phase."
  fi
  local skills_section
  skills_section=$(build_skills_section codex)

  # Pre-read reference files so Codex doesn't need file-reading tools
  local proj_context decisions handshake plan_tpl
  proj_context=$(_pre_read "$CPB_ROOT/wiki/projects/$project/context.md")
  decisions=$(_pre_read "$CPB_ROOT/wiki/projects/$project/decisions.md")
  handshake=$(_pre_read "$CPB_EXECUTOR_ROOT/wiki/system/handshake-protocol.md")
  plan_tpl=$(_pre_read "$CPB_EXECUTOR_ROOT/templates/handoff/plan-to-execute.md")

  cat << PROMPT
You are CodePatchbay Codex (Planner). Role: $(head -3 "$CPB_EXECUTOR_ROOT/profiles/codex/soul.md" | tail -1 | sed 's/^# //')

$skills_section

## CRITICAL: Primary Directive
Your plan MUST address THIS EXACT task. Do NOT plan for any other work regardless of project context:
**$task**

$constraints

## Project Context
$proj_context

## Existing Decisions
$decisions

## Handshake Protocol
$handshake

## Plan Template
$plan_tpl

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
  local plan_file="$CPB_ROOT/wiki/projects/$project/inbox/plan-${plan_id}.md"
  local project_cwd
  project_cwd=$(get_project_path "$project")
  local constraints=""
  if [ "${CPB_DANGEROUS:-0}" != "1" ]; then
    constraints="## Constraints
- Write code ONLY in the target project directory${project_cwd:+: $project_cwd}
- Write deliverable ONLY to: $deliverable_file
- Write verdicts ONLY under: $CPB_ROOT/wiki/projects/$project/outputs/
- Do NOT modify files under: $CPB_EXECUTOR_ROOT/wiki/system/, $CPB_EXECUTOR_ROOT/profiles/, $CPB_EXECUTOR_ROOT/bridges/
- Do NOT read or write files outside the project, CodePatchbay wiki, and CodePatchbay profiles directories."
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
You are CodePatchbay Claude (Executor). Role: $(head -3 "$CPB_EXECUTOR_ROOT/profiles/claude/soul.md" | tail -1 | sed 's/^# //')

$skills_section

$constraints

$fix_section

## Files to read
- Role definition: $CPB_EXECUTOR_ROOT/profiles/claude/soul.md
- Plan to execute: $plan_file
- Project context: $CPB_ROOT/wiki/projects/$project/context.md
- Decisions: $CPB_ROOT/wiki/projects/$project/decisions.md
- Deliverable template: $CPB_EXECUTOR_ROOT/templates/handoff/execute-to-review.md
- Handshake format: $CPB_EXECUTOR_ROOT/wiki/system/handshake-protocol.md

## Instructions
1. Read the plan file first.
2. Implement code changes described in the plan.
3. Run tests and record results.
4. Write the deliverable to: $deliverable_file
Follow handshake-protocol (claude->codex, Phase: execute).
Include plan-ref: $plan_id in the deliverable metadata.
PROMPT
}

# rtk_codex_verify <project> <deliverable_id> <verdict_file>
rtk_codex_verify() {
  if [ "$#" -ne 3 ]; then
    echo "Usage: rtk_codex_verify <project> <deliverable_id> <verdict_file>" >&2
    return 2
  fi
  local project="$1" deliverable_id="$2" verdict_file="$3"
  local deliverable_file="$CPB_ROOT/wiki/projects/$project/outputs/deliverable-${deliverable_id}.md"
  local constraints=""
  if [ "${CPB_DANGEROUS:-0}" != "1" ]; then
    constraints="## Constraints
- ONLY write the verdict to: $verdict_file
- Do NOT execute terminal commands (npm, node, git, etc). This is a verification-only phase.
- Do NOT modify any code files."
  fi

  local skills_section
  skills_section=$(build_skills_section codex)

  cat << PROMPT
You are CodePatchbay Codex (Verifier). Role: $(head -3 "$CPB_EXECUTOR_ROOT/profiles/codex/soul.md" | tail -1 | sed 's/^# //')

$skills_section

$constraints

## Verification locators
- Deliverable file: $deliverable_file
- Plans directory: $CPB_ROOT/wiki/projects/$project/inbox
- Outputs directory: $CPB_ROOT/wiki/projects/$project/outputs
- Project context: $CPB_ROOT/wiki/projects/$project/context.md
- Decisions: $CPB_ROOT/wiki/projects/$project/decisions.md
- Project metadata: $CPB_ROOT/wiki/projects/$project/project.json

## Instructions
1. Read the deliverable file and referenced plan from the locators above.
2. Verify the deliverable against the task goal and plan Acceptance-Criteria.
3. Give a verdict based on your own inspection of the current files and task intent.
4. Write the verdict to: $verdict_file

The verdict file MUST have this as the VERY FIRST LINE (no markdown, no headers before it):
VERDICT: <PASS|FAIL|PARTIAL>
Follow with concise findings and reasoning. State what passed, what failed, and what should happen next.
PROMPT
}

# rtk_claude_repair <project> <job-id> <repair-report-file>
rtk_claude_repair() {
  if [ "$#" -ne 3 ]; then
    echo "Usage: rtk_claude_repair <project> <job-id> <repair-report-file>" >&2
    return 2
  fi
  local project="$1" job_id="$2" repair_file="$3"
  local wiki_dir="$CPB_ROOT/wiki/projects/$project"
  local event_log="$CPB_ROOT/cpb-task/events/$project/$job_id.jsonl"
  local project_cwd
  project_cwd=$(get_project_path "$project")
  local constraints=""
  if [ "${CPB_DANGEROUS:-0}" != "1" ]; then
    constraints="## Scope
- Work in the CodePatchbay executor root: $CPB_EXECUTOR_ROOT
- Use the target project only for direct inspection when needed: ${project_cwd:-[missing project root]}
- Write the repair report only to: $repair_file
- Leave verifier, retry, recover, and pipeline execution paths outside this repair run."
  fi

  cat << PROMPT
You are CodePatchbay Claude (External Repair). Your job is to repair CodePatchbay executor/runtime code when a CPB job failed because CPB itself behaved incorrectly.

$constraints

## Locators
- CPB executor root: $CPB_EXECUTOR_ROOT
- CPB runtime root: $CPB_ROOT
- Target project root: ${project_cwd:-[missing project root]}
- Job event log: $event_log
- Project context: $wiki_dir/context.md
- Decisions: $wiki_dir/decisions.md
- Project log: $wiki_dir/log.md
- Outputs directory: $wiki_dir/outputs
- Project metadata: $wiki_dir/project.json

## Instructions
1. Read the logs and code from the locators above. Treat copied summaries as stale.
2. Diagnose whether the failure is caused by CPB executor/runtime logic.
3. If it is a CPB self-bug, make the smallest code change that repairs that bug.
4. After a successful repair, the execution channel points to a new task carrying repair lineage metadata; the original failed job remains an audit record.
5. Write the repair report at the path below.

Write the repair report to: $repair_file

The report's first line MUST be exactly one of:
REPAIR: FIXED
REPAIR: NOOP
REPAIR: BLOCKED

After the first line, include concise findings, changed files, and verification you ran.
PROMPT
}

# rtk_research_prompt <project> <task>
rtk_research_prompt() {
  local project="$1" task="$2"
  local skills_section
  skills_section=$(build_skills_section codex)
  cat << PROMPT
You are CodePatchbay Research Agent. Analyze this task for project "$project".

Skills: Read skill files from $CPB_EXECUTOR_ROOT/profiles/codex/skills/ or $CPB_EXECUTOR_ROOT/profiles/claude/skills/ as needed.

$skills_section

## Task
$task

## Analysis Required
Provide a structured analysis covering:

### 1. Feasibility
- Technical complexity (low/medium/high)
- Estimated effort
- Required knowledge/domains

### 2. Risks & Dependencies
- Key risks that could block or delay
- External dependencies
- Potential blockers

### 3. Suggested Approach
- High-level implementation strategy
- Key design decisions
- Alternative approaches considered

### 4. Questions & Ambiguities
- What information is missing?
- What assumptions are being made?
- What needs clarification from the user?

Be concise and evidence-based. If the task is too vague to analyze, say so explicitly and list what's needed.
PROMPT
}

# rtk_codex_plan_with_research <project> <task> <plan_file> <research_file>
rtk_codex_plan_with_research() {
  local project="$1" task="$2" plan_file="$3" research_file="$4"
  local project_cwd
  project_cwd=$(get_project_path "$project")
  local constraints=""
  if [ "${CPB_DANGEROUS:-0}" != "1" ]; then
    constraints="## Constraints
- ONLY write files under: $CPB_ROOT/wiki/projects/$project/inbox/
- Do NOT execute terminal commands (npm, node, git, etc). This is a planning-only phase."
  fi
  local skills_section
  skills_section=$(build_skills_section codex)

  local proj_context decisions handshake plan_tpl research_content
  proj_context=$(_pre_read "$CPB_ROOT/wiki/projects/$project/context.md")
  decisions=$(_pre_read "$CPB_ROOT/wiki/projects/$project/decisions.md")
  handshake=$(_pre_read "$CPB_EXECUTOR_ROOT/wiki/system/handshake-protocol.md")
  plan_tpl=$(_pre_read "$CPB_EXECUTOR_ROOT/templates/handoff/plan-to-execute.md")
  research_content=$(_pre_read "$research_file")

  cat << PROMPT
You are CodePatchbay Codex (Planner). Role: $(head -3 "$CPB_EXECUTOR_ROOT/profiles/codex/soul.md" | tail -1 | sed 's/^# //')

$skills_section

## CRITICAL: Primary Directive
Your plan MUST address THIS EXACT task. Do NOT plan for any other work regardless of project context:
**$task**

$constraints

## Collaborative Research (from dual-agent analysis)
$research_content

## Project Context
$proj_context

## Existing Decisions
$decisions

## Handshake Protocol
$handshake

## Plan Template
$plan_tpl

## Output
Write the plan to: $plan_file
The plan title/heading MUST reference the task: "$task"
Follow handshake-protocol (codex->claude, Phase: plan).
Use scope-matched step count with concrete acceptance criteria.
Address risks and questions identified in the research above.
PROMPT
}

# ─── Dashboard 更新 ───
dashboard_update() {
  local project="$1" phase="$2" status="$3" next="$4"
  local dash="$CPB_ROOT/wiki/system/dashboard.md"
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
  local skills_dir="$CPB_EXECUTOR_ROOT/profiles/$role/skills"
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
cpb_apply_claude_variant() {
  local variant_script="${CPB_EXECUTOR_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}/bridges/apply-variant.mjs"
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

  # The Anthropic SDK prefers authToken (Bearer) over apiKey (x-api-key).
  # Some gateway-compatible providers require x-api-key, so normalize real
  # executions while leaving test stubs able to assert the selected token.
  if [ -z "${CPB_TEST_ENV_LOG:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
    export ANTHROPIC_API_KEY="$ANTHROPIC_AUTH_TOKEN"
    unset ANTHROPIC_AUTH_TOKEN
  fi
}

# ─── ACP 执行 ───
acp_run() {
  local agent="$1"; shift
  local acp="${CPB_ACP_CLIENT:-$CPB_EXECUTOR_ROOT/bridges/acp-client.mjs}"
  if [ ! -x "$acp" ]; then
    echo -e "${RED}ACP client not executable: $acp${NC}" >&2
    exit 1
  fi
  if [ "$agent" = "claude" ]; then
    cpb_apply_claude_variant
  fi
  "$acp" --agent "$agent" --cwd "${CPB_ACP_CWD:-$PWD}" "$@"
}
