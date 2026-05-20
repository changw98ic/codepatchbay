import { readFile } from "node:fs/promises";
import path from "node:path";

async function preRead(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return `[file not found: ${filePath}]`;
  }
}

export async function buildSkillsSection(executorRoot, role) {
  const skillsDir = path.join(executorRoot, "profiles", role, "skills");
  let files;
  try {
    const { readdir } = await import("node:fs/promises");
    files = (await readdir(skillsDir)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return "";
  }
  if (files.length === 0) return "";

  const lines = ["## Available Skills"];
  let count = 0;
  for (const f of files) {
    if (count >= 10) {
      lines.push("- ... (truncated, max 10)");
      break;
    }
    const content = await readFile(path.join(skillsDir, f), "utf8");
    const fmBlock = content.split("---");
    let name = "";
    let desc = "";
    if (fmBlock.length >= 3) {
      for (const line of fmBlock[1].split("\n")) {
        const nm = line.match(/^name:\s*(.+)/);
        if (nm) name = nm[1].trim();
        const dm = line.match(/^description:\s*(.+)/);
        if (dm) desc = dm[1].trim();
      }
    }
    if (name) {
      lines.push(`- /${name}: ${desc} -> ${path.join(skillsDir, f)}`);
      count++;
    }
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

export async function buildCodexPlanPrompt(executorRoot, cpbRoot, project, task, planFile) {
  const roleTitle = await readRoleTitle(executorRoot, "codex");
  const skillsSection = await buildSkillsSection(executorRoot, "codex");

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
- Do NOT execute terminal commands (npm, node, git, etc). This is a planning-only phase.`;

  return `You are CodePatchbay Codex (Planner). Role: ${roleTitle}

${skillsSection}

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
Follow handshake-protocol (codex->claude, Phase: plan).
Use scope-matched step count with concrete acceptance criteria.`;
}

export async function buildClaudeExecutePrompt(executorRoot, cpbRoot, project, planId, deliverableFile, verdictFile) {
  const roleTitle = await readRoleTitle(executorRoot, "claude");
  const skillsSection = await buildSkillsSection(executorRoot, "claude");

  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);
  const planFile = path.join(wikiDir, "inbox", `plan-${planId}.md`);

  const projectCwd = process.env.CPB_PROJECT_PATH_OVERRIDE || process.env.CPB_ACP_CWD || "";

  const dangerous = process.env.CPB_DANGEROUS === "1";
  const constraints = dangerous
    ? ""
    : `## Constraints
- Write code ONLY in the target project directory${projectCwd ? ": " + projectCwd : ""}
- Write deliverable ONLY to: ${deliverableFile}
- Write verdicts ONLY under: ${path.join(cpbRoot, "wiki", "projects", project, "outputs")}/
- Do NOT modify files under: ${path.join(executorRoot, "wiki", "system")}/, ${path.join(executorRoot, "profiles")}/, ${path.join(executorRoot, "bridges")}/
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

  return `You are CodePatchbay Claude (Executor). Role: ${roleTitle}

${skillsSection}

${constraints}

${fixSection}

## Files to read
- Role definition: ${path.join(executorRoot, "profiles", "claude", "soul.md")}
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
Follow handshake-protocol (claude->codex, Phase: execute).
Include plan-ref: ${planId} in the deliverable metadata.`;
}

export async function buildCodexVerifyPrompt(executorRoot, cpbRoot, project, deliverableId, verdictFile) {
  const roleTitle = await readRoleTitle(executorRoot, "codex");
  const skillsSection = await buildSkillsSection(executorRoot, "codex");

  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);
  const deliverableFile = path.join(wikiDir, "outputs", `deliverable-${deliverableId}.md`);

  const dangerous = process.env.CPB_DANGEROUS === "1";
  const constraints = dangerous
    ? ""
    : `## Constraints
- ONLY write the verdict to: ${verdictFile}
- Do NOT execute terminal commands (npm, node, git, etc). This is a verification-only phase.
- Do NOT modify any code files.`;

  return `You are CodePatchbay Codex (Verifier). Role: ${roleTitle}

${skillsSection}

${constraints}

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

export async function buildCodexVerifyJobPrompt(executorRoot, cpbRoot, project, jobId, verdictFile) {
  const roleTitle = await readRoleTitle(executorRoot, "codex");
  const skillsSection = await buildSkillsSection(executorRoot, "codex");

  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);

  const dangerous = process.env.CPB_DANGEROUS === "1";
  const constraints = dangerous
    ? ""
    : `## Constraints
- ONLY write the verdict to: ${verdictFile}
- Do NOT execute terminal commands (npm, node, git, etc). This is a verification-only phase.
- Do NOT modify any code files.`;

  return `You are CodePatchbay Codex (Verifier). Role: ${roleTitle}

${skillsSection}

${constraints}

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

export async function buildClaudeRepairPrompt(executorRoot, cpbRoot, project, jobId, repairFile) {
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

  return `You are CodePatchbay Claude (External Repair). Your job is to repair CodePatchbay executor/runtime code when a CPB job failed because CPB itself behaved incorrectly.

${constraints}

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
  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);
  const deliverableFile = path.join(wikiDir, "outputs", `deliverable-${deliverableId}.md`);
  const reviewFile = path.join(wikiDir, "outputs", `review-${deliverableId}.md`);

  const planFile = path.join(wikiDir, "inbox", `plan-${deliverableId}.md`);

  const dangerous = process.env.CPB_DANGEROUS === "1";
  const constraints = dangerous
    ? ""
    : `## Constraints
- ONLY write the review to: ${reviewFile}
- ONLY read files under: ${path.join(cpbRoot, "wiki", "projects", project)}/ or ${path.join(executorRoot, "profiles")}/
- Do NOT execute terminal commands. This is a review-only phase.
- Do NOT modify any code files.`;

  return `You are CodePatchbay Reviewer. Role: Code Review Expert

## Task
Review the deliverable for code quality, correctness, maintainability, and security.

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
