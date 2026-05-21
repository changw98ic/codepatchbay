import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  getWorkflow,
  phaseRequiresSubagents,
  getVerificationLayers,
  getSubagentConfig,
} from "./workflow-definition.js";
import { loadProfile, selectProfileSkills, loadProfileSkills } from "./profile-loader.js";

async function preRead(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return `[file not found: ${filePath}]`;
  }
}

export async function buildSkillsSection(executorRoot, role, context = {}, options = {}) {
  const selected = await selectProfileSkills(executorRoot, role, context, options);
  const { diagnostics } = await loadProfileSkills(executorRoot, role, options);

  if (selected.length === 0 && diagnostics.length === 0) return "";

  const lines = [];

  if (selected.length > 0) {
    lines.push("## Loaded Role Skills");
    for (const skill of selected) {
      lines.push(`### /${skill.name}`);
      lines.push(`- Source: ${skill.source}`);
      lines.push(`- Reason: ${skill.reason}`);
      lines.push("");
      lines.push(skill.content);
      lines.push("");
    }
  }

  lines.push("## Role Skill Diagnostics");
  for (const skill of selected) {
    lines.push(`- loaded /${skill.name} from ${skill.source} because ${skill.reason}`);
  }
  for (const d of diagnostics) {
    lines.push(`- skipped ${d.source} because ${d.code}`);
  }

  return lines.join("\n");
}

async function readRoleTitle(executorRoot, role) {
  const soulFile = path.join(executorRoot, "profiles", role, "soul.md");
  try {
    const content = await readFile(soulFile, "utf8");
    const lines = content.split("\n");
    for (const line of lines) {
      if (line.startsWith("# ")) return line.replace(/^# /, "").trim();
    }
  } catch {}
  return role;
}

const LAYER_DESCRIPTIONS = {
  fast: "Fast focused tests - targeted tests for directly changed code paths (under 60s total).",
  changed: "Changed-scope checks - test suites for the specific modules/files modified.",
  regression: "Broad regression tests - full project test suite to catch unintended side effects.",
  acceptance: "Acceptance and static checks - linting, type checking, and plan acceptance criteria verification.",
};

function buildSubagentGuidance(phase, profile) {
  const wfName = process.env.CPB_WORKFLOW;
  const wf = wfName ? getWorkflow(wfName) : null;
  const wfRequires = wf ? phaseRequiresSubagents(wf, phase) : false;
  const profileGuidance = profile?.subagentGuidance;
  const profileRequired = profileGuidance?.required === true;
  const profilePhases = profileGuidance?.phases;
  const profileApplies = profileRequired && (!profilePhases || profilePhases.includes(phase));

  if (!wfRequires && !profileApplies) return "";

  const wfConfig = wf ? getSubagentConfig(wf) : null;
  const maxConcurrency = profileApplies && profileGuidance?.maxConcurrency
    ? profileGuidance.maxConcurrency
    : (wfConfig?.maxConcurrency ?? 3);
  const isClaudePhase = phase === "execute" || phase === "repair";
  const runtimeLine = isClaudePhase
    ? "This phase runs under Claude ACP. You MUST use Claude Code native subagents / Task tool for parallel work."
    : "This phase runs under Codex. You MUST use Codex native subagents for parallel work.";

  return `\n## Subagent Requirements (MANDATORY)
${runtimeLine}
This phase REQUIRES you to dispatch bounded native subagents for independent subtasks when throughput benefits.
- Maximum concurrent subagents: ${maxConcurrency}
- Each subagent must be bounded: no commits, pushes, merges, wiki modifications, or runtime artifact changes.
- You MUST integrate every subagent result into your final output.
- If your runtime cannot dispatch subagents, stop and report: BLOCKED: subagent tool unavailable.
- If no independent subagent lane exists (single-step task with no parallelizable work), report: BLOCKED: no independent subagent lane with reason.
- Include a "Subagents used" section in your final output listing each lane, findings, and integration summary.`;
}

function buildLayeredVerification() {
  const wfName = process.env.CPB_WORKFLOW;
  if (!wfName) return "";
  const wf = getWorkflow(wfName);
  const layers = getVerificationLayers(wf);
  if (!layers) return "";

  const layerList = layers.map((l) => `- **${l}**: ${LAYER_DESCRIPTIONS[l] || l}`).join("\n");

  return `\n## Layered Verification
Run verification in these distinct layers instead of treating tests as one serial bucket. Use independent subagent lanes for safe parallel execution of non-conflicting layers:

${layerList}

For each layer, report: what was run, pass/fail status, any issues found, and the subagent lane status. Aggregate results into the final verdict JSON envelope.`;
}

export async function buildPlannerPrompt(executorRoot, cpbRoot, project, task, planFile) {
  const roleTitle = await readRoleTitle(executorRoot, "planner");
  const skillsSection = await buildSkillsSection(executorRoot, "planner", { phase: "plan", task });
  const profile = await loadProfile(executorRoot, "planner");

  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);
  const projContext = await preRead(path.join(wikiDir, "context.md"));
  const decisions = await preRead(path.join(wikiDir, "decisions.md"));
  const handshake = await preRead(path.join(executorRoot, "wiki", "system", "handshake-protocol.md"));
  const planTpl = await preRead(path.join(executorRoot, "templates", "handoff", "plan-to-execute.md"));

  const dangerous = process.env.CPB_DANGEROUS === "1";
  const constraints = dangerous
    ? ""
    : `## Constraints
- ONLY write files under: ${path.join(cpbRoot, "wiki", "projects", project, "inbox")}/
- You may run read-only local inspection commands only (for example: pwd, ls, cat, sed, rg, git status, git diff).`;

  return `You are CodePatchbay Planner. Role: ${roleTitle}

${skillsSection}
${buildSubagentGuidance("plan", profile)}
## CRITICAL: Primary Directive
Your plan MUST address THIS EXACT task. Do NOT plan for any other work regardless of project context:
**${task}**

${constraints}

## Project Context
${projContext}

## Existing Decisions
${decisions}

## Handshake Protocol
${handshake}

## Plan Template
${planTpl}

## Output
Write the plan to: ${planFile}
The plan title/heading MUST reference the task: "${task}"
Follow handshake-protocol (planner->executor, Phase: plan).
Use scope-matched step count with concrete acceptance criteria.`;
}

export async function buildExecutorPrompt(executorRoot, cpbRoot, project, planId, deliverableFile, verdictFile) {
  const roleTitle = await readRoleTitle(executorRoot, "executor");
  const profile = await loadProfile(executorRoot, "executor");

  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);
  const planFile = path.join(wikiDir, "inbox", `plan-${planId}.md`);
  const planContent = await preRead(planFile);
  const skillsSection = await buildSkillsSection(executorRoot, "executor", { phase: "execute", artifactText: planContent });

  const projectCwd = process.env.CPB_PROJECT_PATH_OVERRIDE || process.env.CPB_ACP_CWD || "";

  const dangerous = process.env.CPB_DANGEROUS === "1";
  const constraints = dangerous
    ? ""
    : `## Constraints
- Write code ONLY in the target project directory${projectCwd ? ": " + projectCwd : ""}
- Write deliverable ONLY to: ${deliverableFile}
- Write verdicts ONLY under: ${path.join(cpbRoot, "wiki", "projects", project, "outputs")}/
- Do NOT modify files under: ${path.join(executorRoot, "wiki", "system")}/, ${path.join(executorRoot, "profiles")}/, ${path.join(executorRoot, "bridges")}/
- Do NOT mutate git history, publish, deploy, or run destructive shell commands.
- Do NOT read or write files outside the project, CodePatchbay wiki, and CodePatchbay profiles directories.`;

  let fixSection = "";
  if (verdictFile) {
    try {
      await readFile(verdictFile, "utf8");
      fixSection = `## Previous Verification Failure (FIX REQUIRED)
The previous deliverable was verified and REJECTED. Read the verdict for details:
- Verdict file: ${verdictFile}
You MUST address the specific failures listed in the verdict. Do NOT repeat the same approach.`;
    } catch {
      // verdict file doesn't exist yet, skip fix section
    }
  }

  return `You are CodePatchbay Executor. Role: ${roleTitle}

${skillsSection}

${constraints}

${fixSection}
${buildSubagentGuidance("execute", profile)}
## Files to read
- Role definition: ${path.join(executorRoot, "profiles", "executor", "soul.md")}
- Plan to execute: ${planFile}
- Project context: ${path.join(wikiDir, "context.md")}
- Decisions: ${path.join(wikiDir, "decisions.md")}
- Deliverable template: ${path.join(executorRoot, "templates", "handoff", "execute-to-review.md")}
- Handshake format: ${path.join(executorRoot, "wiki", "system", "handshake-protocol.md")}

## Instructions
1. Read the plan file first.
2. Implement code changes described in the plan.
3. Run tests and record results.
4. Write the deliverable to: ${deliverableFile}
Follow handshake-protocol (executor->verifier, Phase: execute).
Include plan-ref: ${planId} in the deliverable metadata.`;
}

export async function buildExecutorJobPrompt(executorRoot, cpbRoot, project, jobId, deliverableFile) {
  const roleTitle = await readRoleTitle(executorRoot, "executor");
  const skillsSection = await buildSkillsSection(executorRoot, "executor");
  const profile = await loadProfile(executorRoot, "executor");

  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);
  const eventLog = path.join(cpbRoot, "cpb-task", "events", project, `${jobId}.jsonl`);
  const stateRoot = path.join(cpbRoot, "cpb-task");

  const projectCwd = process.env.CPB_PROJECT_PATH_OVERRIDE || process.env.CPB_ACP_CWD || "";

  const dangerous = process.env.CPB_DANGEROUS === "1";
  const constraints = dangerous
    ? ""
    : `## Constraints
- Write code ONLY in the target project directory${projectCwd ? ": " + projectCwd : ""}
- Write deliverable ONLY to: ${deliverableFile}
- Write verdicts ONLY under: ${path.join(cpbRoot, "wiki", "projects", project, "outputs")}/
- Do NOT modify files under: ${path.join(executorRoot, "wiki", "system")}/, ${path.join(executorRoot, "profiles")}/, ${path.join(executorRoot, "bridges")}/
- Do NOT mutate git history, publish, deploy, or run destructive shell commands.
- Do NOT read or write files outside the project, CodePatchbay wiki, and CodePatchbay profiles directories.`;

  return `You are CodePatchbay Executor. Role: ${roleTitle}

${skillsSection}

## CRITICAL: Read from locators, not copied artifacts
Reconstruct your task and current state from locators and job/event state below.
Artifacts (plans, deliverables, verdicts) are audit context - verify them against live state.
Do NOT treat copied artifact contents as authoritative.

## Locators
- Job ID: ${jobId}
- Event log: ${eventLog}
- State root: ${stateRoot}
- Plans directory: ${path.join(wikiDir, "inbox")}
- Outputs directory: ${path.join(wikiDir, "outputs")}
- Project context: ${path.join(wikiDir, "context.md")}
- Decisions: ${path.join(wikiDir, "decisions.md")}
- Project metadata: ${path.join(wikiDir, "project.json")}
- Role definition: ${path.join(executorRoot, "profiles", "executor", "soul.md")}
- Deliverable template: ${path.join(executorRoot, "templates", "handoff", "execute-to-review.md")}
- Handshake format: ${path.join(executorRoot, "wiki", "system", "handshake-protocol.md")}

${constraints}
${buildSubagentGuidance("execute", profile)}
## Instructions
1. Read the event log to reconstruct the task goal and plan phase output.
2. Read the plan from the plans directory (audit context, not sole truth).
3. Verify current job/task state from the locators above.
4. Implement code changes described in the plan.
5. Run tests and record results.
6. Write the deliverable to: ${deliverableFile}
Follow handshake-protocol (executor->verifier, Phase: execute).
Include plan-ref derived from the plan artifact in the deliverable metadata.`;
}

export async function buildVerifierPrompt(executorRoot, cpbRoot, project, deliverableId, verdictFile) {
  const roleTitle = await readRoleTitle(executorRoot, "verifier");
  const profile = await loadProfile(executorRoot, "verifier");

  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);
  const deliverableFile = path.join(wikiDir, "outputs", `deliverable-${deliverableId}.md`);
  const deliverableContent = await preRead(deliverableFile);
  const skillsSection = await buildSkillsSection(executorRoot, "verifier", { phase: "verify", artifactText: deliverableContent });

  const dangerous = process.env.CPB_DANGEROUS === "1";
  const constraints = dangerous
    ? ""
    : `## Constraints
- ONLY write the verdict to: ${verdictFile}
- You may use read-only local inspection commands/tools for observation when available (for example: pwd, ls, sed, cat, rg, git status, git diff).
- Run build/test commands only when they are expected to be safe for this workspace; otherwise record them as not run.
- Do NOT modify code, project files, wiki inputs, git state, dependencies, caches, or runtime state.`;

  return `You are CodePatchbay Verifier. Role: ${roleTitle}

${skillsSection}

${constraints}
${buildSubagentGuidance("verify", profile)}
${buildLayeredVerification()}
## Verification locators
- Deliverable file: ${deliverableFile}
- Plans directory: ${path.join(wikiDir, "inbox")}
- Outputs directory: ${path.join(wikiDir, "outputs")}
- Project context: ${path.join(wikiDir, "context.md")}
- Decisions: ${path.join(wikiDir, "decisions.md")}
- Project metadata: ${path.join(wikiDir, "project.json")}

## Instructions
1. Read the deliverable file and referenced plan from the locators above.
2. Verify the deliverable against the task goal and plan Acceptance-Criteria.
3. Give a verdict based on your own inspection of the current files and task intent.
4. Write the verdict to: ${verdictFile}

Give a verdict by writing a JSON envelope as the VERY FIRST LINE of the verdict file (no markdown, no headers before it):

\`\`\`json
{
  "status": "<pass|fail|inconclusive|infra_error>",
  "basis": {
    "taskGoal": "<what the task was trying to achieve>",
    "worktreeDiff": "<summary of code changes or 'none'>",
    "tests": "<test results summary or 'not run'>",
    "buildLogs": "<build status or 'not run'>",
    "events": "<relevant event log observations or 'none'>",
    "runtimeState": "<runtime/process state observations or 'none'>",
    "executorSummary": "<what the executor claimed to do>"
  },
  "blockingMissingInputs": [],
  "reason": "<one-line explanation of the verdict>",
  "summary": "<optional broader narrative>"
}
\`\`\`

Use "pass" when all acceptance criteria are met. Use "fail" for quality or correctness issues. Use "inconclusive" when you cannot determine the outcome (missing data, ambiguous results). Use "infra_error" when infrastructure problems prevent verification (missing files, corrupt data, permission errors, agent crash).
Every key in "basis" MUST be present. Use descriptive strings, never omit keys. "blockingMissingInputs" lists any inputs that were missing and prevented a confident verdict.
Follow with concise findings and reasoning. State what passed, what failed, and what should happen next.`;
}

export async function buildVerifierJobPrompt(executorRoot, cpbRoot, project, jobId, verdictFile) {
  const roleTitle = await readRoleTitle(executorRoot, "verifier");
  const skillsSection = await buildSkillsSection(executorRoot, "verifier", { phase: "verify" });
  const profile = await loadProfile(executorRoot, "verifier");

  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);

  const dangerous = process.env.CPB_DANGEROUS === "1";
  const constraints = dangerous
    ? ""
    : `## Constraints
- ONLY write the verdict to: ${verdictFile}
- You may use read-only local inspection commands/tools for observation when available (for example: pwd, ls, sed, cat, rg, git status, git diff).
- Run build/test commands only when they are expected to be safe for this workspace; otherwise record them as not run.
- Do NOT modify code, project files, wiki inputs, git state, dependencies, caches, or runtime state.`;

  return `You are CodePatchbay Verifier. Role: ${roleTitle}

${skillsSection}

${constraints}
${buildSubagentGuidance("verify", profile)}
${buildLayeredVerification()}
## Verification locators
- Job ID: ${jobId}
- Event log: ${path.join(cpbRoot, "cpb-task", "events", project, `${jobId}.jsonl`)}
- Plans directory: ${path.join(wikiDir, "inbox")}
- Outputs directory: ${path.join(wikiDir, "outputs")}
- Project context: ${path.join(wikiDir, "context.md")}
- Decisions: ${path.join(wikiDir, "decisions.md")}
- Project metadata: ${path.join(wikiDir, "project.json")}

## Instructions
1. Reconstruct the task goal and phase history from the job/event locators above.
2. Inspect current project state from the locators; executor deliverables are optional audit context, not required truth.
3. If data is missing, return a diagnostic verdict instead of crashing.
4. Write the verdict to: ${verdictFile}

Give a verdict by writing a JSON envelope as the VERY FIRST LINE of the verdict file (no markdown, no headers before it):

\`\`\`json
{
  "status": "<pass|fail|inconclusive|infra_error>",
  "basis": {
    "taskGoal": "<what the task was trying to achieve>",
    "worktreeDiff": "<summary of code changes or 'none'>",
    "tests": "<test results summary or 'not run'>",
    "buildLogs": "<build status or 'not run'>",
    "events": "<relevant event log observations or 'none'>",
    "runtimeState": "<runtime/process state observations or 'none'>",
    "executorSummary": "<what the executor claimed to do>"
  },
  "blockingMissingInputs": [],
  "reason": "<one-line explanation of the verdict>",
  "summary": "<optional broader narrative>"
}
\`\`\`

Use "pass" when all acceptance criteria are met. Use "fail" for quality or correctness issues. Use "inconclusive" when you cannot determine the outcome (missing data, ambiguous results). Use "infra_error" when infrastructure problems prevent verification (missing files, corrupt data, permission errors, agent crash).
Every key in "basis" MUST be present. Use descriptive strings, never omit keys. "blockingMissingInputs" lists any inputs that were missing and prevented a confident verdict.
Follow with concise findings and reasoning. State what passed, what failed, and what should happen next.`;
}

export async function buildRepairerPrompt(executorRoot, cpbRoot, project, jobId, repairFile) {
  const roleTitle = await readRoleTitle(executorRoot, "repairer");
  const skillsSection = await buildSkillsSection(executorRoot, "repairer", { phase: "repair" });
  const profile = await loadProfile(executorRoot, "repairer");
  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);
  const eventLog = path.join(cpbRoot, "cpb-task", "events", project, `${jobId}.jsonl`);
  const projectCwd = process.env.CPB_PROJECT_PATH_OVERRIDE || process.env.CPB_ACP_CWD || "";

  const dangerous = process.env.CPB_DANGEROUS === "1";
  const constraints = dangerous
    ? ""
    : `## Scope
- Work in the CodePatchbay executor root: ${executorRoot}
- Use the target project only for direct inspection when needed: ${projectCwd || "[missing project root]"}
- Write the repair report only to: ${repairFile}
- Leave verifier, retry, recover, and pipeline execution paths outside this repair run.`;

  return `You are CodePatchbay Repairer. Role: ${roleTitle}

${skillsSection}

Your job is to repair CodePatchbay executor/runtime code when a CPB job failed because CPB itself behaved incorrectly.

${constraints}
${buildSubagentGuidance("repair", profile)}

## Locators
- CPB executor root: ${executorRoot}
- CPB runtime root: ${cpbRoot}
- Target project root: ${projectCwd || "[missing project root]"}
- Job event log: ${eventLog}
- Project context: ${path.join(wikiDir, "context.md")}
- Decisions: ${path.join(wikiDir, "decisions.md")}
- Project log: ${path.join(wikiDir, "log.md")}
- Outputs directory: ${path.join(wikiDir, "outputs")}
- Project metadata: ${path.join(wikiDir, "project.json")}

## Instructions
1. Read the logs and code from the locators above. Treat copied summaries as stale.
2. Diagnose whether the failure is caused by CPB executor/runtime logic.
3. If it is a CPB self-bug, make the smallest code change that repairs that bug.
4. After a successful repair, the execution channel points to a new task carrying repair lineage metadata; the original failed job remains an audit record.
5. Write the repair report at the path below.

Write the repair report to: ${repairFile}

The report's first line MUST be exactly one of:
REPAIR: FIXED
REPAIR: NOOP
REPAIR: BLOCKED

After the first line, include concise findings, changed files, and verification you ran.`;
}

export async function buildReviewerReviewPrompt(executorRoot, cpbRoot, project, deliverableId) {
  const roleTitle = await readRoleTitle(executorRoot, "reviewer");
  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);
  const deliverableFile = path.join(wikiDir, "outputs", `deliverable-${deliverableId}.md`);
  const reviewFile = path.join(wikiDir, "outputs", `review-${deliverableId}.md`);

  const planFile = path.join(wikiDir, "inbox", `plan-${deliverableId}.md`);
  const deliverableContent = await preRead(deliverableFile);
  const planContent = await preRead(planFile);
  const skillsSection = await buildSkillsSection(executorRoot, "reviewer", { phase: "review", artifactText: deliverableContent + "\n" + planContent });

  const dangerous = process.env.CPB_DANGEROUS === "1";
  const constraints = dangerous
    ? ""
    : `## Constraints
- ONLY write the review to: ${reviewFile}
- You may read project wiki, outputs, system context, profiles, and target source files.
- You may run read-only inspection commands and safe validation commands.
- Do NOT modify any code files.`;

  return `You are CodePatchbay Reviewer. Role: ${roleTitle}

## Task
Review the deliverable for code quality, correctness, maintainability, and security.

${skillsSection}

${constraints}

## Files (read via fs/read_text_file as needed)
- Deliverable to review: ${deliverableFile}
${await preRead(planFile) !== `[file not found: ${planFile}]` ? `- Implementation plan: ${planFile}` : ""}
- Project context: ${path.join(wikiDir, "context.md")}
- Decisions: ${path.join(wikiDir, "decisions.md")}
- Role definition: ${path.join(executorRoot, "profiles", "reviewer", "soul.md")}

## Review Criteria
Rate each area: Critical / Major / Minor / Suggestion
- Correctness: logic, edge cases, error handling
- Readability: naming, structure, clarity
- Maintainability: coupling, abstraction level
- Security: injection, leaks, OWASP top 10
- Performance: obvious bottlenecks

## Output
Write the review to: ${reviewFile}

Format:
## Summary
[Overall assessment]

## Findings
### [Severity] [Title]
- **File**: path:line
- **Issue**: description
- **Fix**: suggested fix

## Verdict
REVIEW: <PASS|FAIL>
[If FAIL, list must-fix items]`;
}
