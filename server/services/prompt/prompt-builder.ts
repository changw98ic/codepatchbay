import { recordValue, type LooseRecord } from "../../../shared/types.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  getWorkflow,
  phaseRequiresSubagents,
  getVerificationLayers,
  getSubagentConfig,
} from "../../../core/workflow/definition.js";
import { loadProfile, selectProfileSkills, loadProfileSkills } from "../prompt/prompt-resources.js";
import { getJob } from "../job/job-store.js";
import { resolveProjectDataRoot } from "../runtime.js";
import { buildRetryInputFromVerdict, parseVerdictEnvelope } from "../../../core/workflow/verdict.js";
import { DISPATCH_FEEDBACK_SCHEMA_VERSION, dispatchFeedbackPath } from "../../../core/workflow/dispatch-feedback.js";

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

// ── prompt-budget helpers (merged from prompt-budget.ts) ──────────────

/**
 * Returns the UTF-8 byte length of a string value.
 *
 * @param {string} value
 * @returns {number}
 */
export function estimatePromptBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Clips text to maxBytes, cutting at the last newline boundary before maxBytes.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {{ text: string, clipped: boolean, originalBytes: number, resultBytes: number }}
 */
export function clipTextByBytes(text: string, maxBytes: number) {
  const originalBytes = Buffer.byteLength(text, "utf8");

  if (originalBytes <= maxBytes) {
    return {
      text,
      clipped: false,
      originalBytes,
      resultBytes: originalBytes,
    };
  }

  // Binary search for the longest prefix that fits within maxBytes
  // and ends at a newline boundary.
  // We walk the string char-by-char, tracking byte position.
  let bytePos = 0;
  let lastNewlineBytePos = 0;
  let cutCharIndex = text.length;

  for (let i = 0; i < text.length; i++) {
    const charBytes = Buffer.byteLength(text[i], "utf8");
    if (bytePos + charBytes > maxBytes) {
      cutCharIndex = i;
      break;
    }
    bytePos += charBytes;
    if (text[i] === "\n") {
      lastNewlineBytePos = bytePos;
    }
  }

  // Prefer cutting at last newline boundary
  let result;
  if (lastNewlineBytePos > 0) {
    // Find the char index corresponding to lastNewlineBytePos
    let scanBytes = 0;
    let charIdx = 0;
    for (; charIdx < text.length; charIdx++) {
      if (scanBytes === lastNewlineBytePos) break;
      scanBytes += Buffer.byteLength(text[charIdx], "utf8");
      if (scanBytes === lastNewlineBytePos) {
        charIdx++;
        break;
      }
    }
    result = text.slice(0, charIdx);
  } else {
    result = text.slice(0, cutCharIndex);
  }

  const resultBytes = Buffer.byteLength(result, "utf8");

  return {
    text: result,
    clipped: true,
    originalBytes,
    resultBytes,
  };
}

/**
 * Builds a budget report by including sections in order:
 * 1. Required sections always included (even if they exceed maxBytes)
 * 2. Optional sections included if they fit within remaining budget
 *
 * @param {Array<{ name: string, content: string, required: boolean }>} sections
 * @param {number} maxBytes
 * @returns {{
 *   sections: Array<{ name: string, bytes: number, included: boolean, required: boolean }>,
 *   totalBytes: number,
 *   maxBytes: number,
 *   clipped: boolean
 * }}
 */
export function buildBudgetReport(sections: LooseRecord[], maxBytes: number) {
  const report: LooseRecord[] = [];
  let usedBytes = 0;

  for (const section of sections) {
    const sectionContent = String(section.content ?? "");
    const sectionBytes = Buffer.byteLength(sectionContent, "utf8");

    if (section.required) {
      report.push({
        name: section.name,
        bytes: sectionBytes,
        included: true,
        required: true,
      });
      usedBytes += sectionBytes;
    } else {
      const included = usedBytes + sectionBytes <= maxBytes;
      report.push({
        name: section.name,
        bytes: sectionBytes,
        included,
        required: false,
      });
      if (included) {
        usedBytes += sectionBytes;
      }
    }
  }

  return {
    sections: report,
    totalBytes: usedBytes,
    maxBytes,
    clipped: usedBytes > maxBytes,
  };
}

// ── prompt builder (original prompt-builder.ts) ───────────────────────

async function resolvePromptDataRoot(cpbRoot: string, project: string, options: LooseRecord = {}) {
  if (options.dataRoot) return path.resolve(options.dataRoot);
  return resolveProjectDataRoot(cpbRoot, project, { hubRoot: options.hubRoot || process.env.CPB_HUB_ROOT });
}

async function preRead(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return `[file not found: ${filePath}]`;
  }
}

async function projectInstructionsSection(wikiDir: string): Promise<string> {
  const content = await preRead(path.join(wikiDir, "agent-instructions.md"));
  if (!content || content.startsWith("[file not found")) return "";
  return `\n\n## Project Instructions\n${content}`;
}

function parseJsonObject(name: string, raw: string | undefined): LooseRecord | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} must contain valid JSON`, { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`${name} must contain a JSON object`);
  }
  return parsed as LooseRecord;
}

function requireNonEmptyString(record: LooseRecord, field: string, name: string): void {
  if (typeof record[field] !== "string" || !String(record[field]).trim()) {
    throw new TypeError(`${name}.${field} must be a non-empty string`);
  }
}

export function parseParentPlanCacheJson(raw: string | undefined): LooseRecord | null {
  const cache = parseJsonObject("CPB_PARENT_PLAN_CACHE_JSON", raw);
  if (!cache) return null;
  requireNonEmptyString(cache, "planGroupId", "CPB_PARENT_PLAN_CACHE_JSON");
  requireNonEmptyString(cache, "planCacheKey", "CPB_PARENT_PLAN_CACHE_JSON");
  if (typeof cache.cacheHit !== "boolean") {
    throw new TypeError("CPB_PARENT_PLAN_CACHE_JSON.cacheHit must be a boolean");
  }
  return cache;
}

export function parseSourceContextJson(raw: string | undefined): LooseRecord | null {
  const sourceContext = parseJsonObject("CPB_SOURCE_CONTEXT_JSON", raw);
  if (!sourceContext) return null;

  if (Object.hasOwn(sourceContext, "contextPackPath")) {
    requireNonEmptyString(sourceContext, "contextPackPath", "CPB_SOURCE_CONTEXT_JSON");
  }
  if (Object.hasOwn(sourceContext, "contextPack")) {
    const contextPack = sourceContext.contextPack;
    if (contextPack === null || typeof contextPack !== "object" || Array.isArray(contextPack)) {
      throw new TypeError("CPB_SOURCE_CONTEXT_JSON.contextPack must be an object");
    }
    const contextPackRecord = contextPack as LooseRecord;
    if (Object.hasOwn(contextPackRecord, "path")) {
      requireNonEmptyString(contextPackRecord, "path", "CPB_SOURCE_CONTEXT_JSON.contextPack");
    }
  }

  return sourceContext;
}

function plannerModeSection() {
  const planMode = process.env.CPB_PLAN_MODE || "auto";
  if (planMode === "light") {
    return `## Light Plan Mode (MANDATORY CONSTRAINTS)
Produce a concise plan for low-risk work. This mode enforces hard limits:

- MAX 80 LINES total. Plans exceeding this will be rejected.
- NO broad research or exploration steps.
- NO full design reasoning or architecture proposals.
- Required sections (all three must be present):
  1. **Affected Files** — list every file that will change, with one-line change description.
  2. **Tests** — describe test changes or new tests needed.
  3. **Risk** — one-line risk assessment (low/medium/high) with brief justification.
- Keep step count ≤ 5. Each step must map to a specific file change.
- Skip context preamble — assume the executor has read this plan file.`;
  }
  if (planMode === "parent") {
    const cache = parseParentPlanCacheJson(process.env.CPB_PARENT_PLAN_CACHE_JSON);
    const cacheLines = cache
      ? [
          `- Parent plan group: ${cache.planGroupId || "unavailable"}`,
          `- Plan cache key: ${cache.planCacheKey || "unavailable"}`,
          `- Cache hit: ${cache.cacheHit ? "yes" : "no"}`,
        ].join("\n")
      : "- Parent plan cache metadata unavailable.";
    return `## Parent Plan Mode
Create a reusable parent plan that can guide child task planning and future cache reuse. Include task boundaries, shared assumptions, and merge/reuse notes.
${cacheLines}`;
  }
  if (planMode === "full") {
    return `## Full Plan Mode
Produce a complete plan with explicit risks, acceptance criteria, and verification steps.`;
  }
  return "";
}

function contextPackPathFromSourceContext(sourceContext: LooseRecord | null = null): string | null {
  if (!sourceContext || typeof sourceContext !== "object") return null;
  const context = recordValue(sourceContext);
  const contextPack = recordValue(context.contextPack);
  return stringValue(context.contextPackPath) || stringValue(contextPack.path) || null;
}

async function jobSourceContext(cpbRoot: string, project: string, jobId: string, options: LooseRecord = {}) {
  try {
    const dataRoot = await resolvePromptDataRoot(cpbRoot, project, options);
    const job = await getJob(cpbRoot, project, jobId, { dataRoot });
    if (job?.sourceContext) return job.sourceContext;
  } catch {}
  return null;
}

async function resolveContextPackLocator(cpbRoot: string, project: string, jobId: string, options: LooseRecord = {}) {
  const sourceContext = await jobSourceContext(cpbRoot, project, jobId, options);
  const jobPath = contextPackPathFromSourceContext(sourceContext);
  if (jobPath) return { path: jobPath, source: "job" };

  const envSource = parseSourceContextJson(process.env.CPB_SOURCE_CONTEXT_JSON);
  const envSourcePath = contextPackPathFromSourceContext(envSource);
  if (envSourcePath) return { path: envSourcePath, source: "job" };

  const envPath = process.env.CPB_CONTEXT_PACK_PATH || null;
  if (envPath) return { path: envPath, source: "job" };

  return null;
}

export async function buildSkillsSection(executorRoot: string, role: string, context: LooseRecord = {}, options: LooseRecord = {}): Promise<string> {
  const selected = await selectProfileSkills(executorRoot, role, context, options);
  const { diagnostics } = await loadProfileSkills(executorRoot, role, options);

  if (selected.length === 0 && diagnostics.length === 0) return "";

  const lines: string[] = [];

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

async function readRoleTitle(executorRoot: string, role: string): Promise<string> {
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

const LAYER_DESCRIPTIONS: Record<string, string> = {
  fast: "Fast focused tests - targeted tests for directly changed code paths (under 60s total).",
  changed: "Changed-scope checks - test suites for the specific modules/files modified.",
  regression: "Broad regression tests - full project test suite to catch unintended side effects.",
  acceptance: "Acceptance and static checks - linting, type checking, and plan acceptance criteria verification.",
};

function buildSubagentGuidance(phase: string, profile: { subagentGuidance?: unknown }): string {
  const wfName = process.env.CPB_WORKFLOW;
  const wf = wfName ? getWorkflow(wfName) : null;
  const wfRequires = wf ? phaseRequiresSubagents(wf, phase) : false;
  const profileGuidance = recordValue(profile?.subagentGuidance);
  const profileRequired = profileGuidance.required === true;
  const profilePhases = stringArray(profileGuidance.phases);
  const profileApplies = profileRequired && (profilePhases.length === 0 || profilePhases.includes(phase));

  if (!wfRequires && !profileApplies) return "";

  const wfConfig = recordValue(wf ? getSubagentConfig(wf) : null);
  const maxConcurrency = profileApplies && typeof profileGuidance.maxConcurrency === "number"
    ? profileGuidance.maxConcurrency
    : (typeof wfConfig.maxConcurrency === "number" ? wfConfig.maxConcurrency : 3);
  const isClaudePhase = phase === "execute" || phase === "remediate";
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

  const layerList = stringArray(layers).map((l) => `- **${l}**: ${LAYER_DESCRIPTIONS[l] || l}`).join("\n");

  return `\n## Layered Verification
Run verification in these distinct layers instead of treating tests as one serial bucket. Use independent subagent lanes for safe parallel execution of non-conflicting layers:

${layerList}

For each layer, report: what was run, pass/fail status, any issues found, and the subagent lane status. Aggregate results into the final verdict JSON envelope.`;
}

function executionIntensitySection(phase: string): string {
  const phaseLine = {
    plan: "Plan only the smallest file-scoped path to satisfy this task; do not design unrelated product surface.",
    execute: "Implement only the approved file-scoped path; do not re-plan the product or broaden scope unless a verifier-blocking issue proves it is required.",
    verify: "Verify the task-specific acceptance criteria before broad regression; do not pass a task on generic test success alone.",
    review: "Review the delivered change and evidence only; do not restart implementation.",
    remediate: "Remediate the CPB/runtime fault only; do not redo the original product task.",
  }[phase] || "Stay inside this phase boundary.";

  return `\n## Execution Intensity Contract (MANDATORY)
${phaseLine}
- Start with CodeGraph lookup when available; otherwise use \`rg --files\` and focused \`rg\`. Avoid broad recursive reading.
- If a CodeGraph MCP tool is available, call it first (for example codegraph_context or mcp__codegraph__codegraph_context) before shell/file fallback.
- Inspect as many relevant files and symbols as needed to establish the exact scope and acceptance probes; do not stop discovery because of an arbitrary lookup count.
- Prefer loaded role skills/profile guidance when relevant; record which index/skill path you used in the artifact.
- Create 2-5 task-specific acceptance probes from the request before broad regression. A generic \`npm test\` pass is not enough when the request asks for a concrete artifact/API/UI behavior.
- Stop after this phase's artifact is written. Do not continue into the next phase's responsibilities.`;
}

const HEADLESS_ESCALATION_CONTRACT = `## Headless Mode Escalation Contract
You are running in a headless ACP session without UI automation tools (no Computer Use, Browser, Chrome, or desktop automation).
If you encounter a situation where UI observation is genuinely necessary to proceed:
- Emit exactly one of these markers with a brief reason: needs_ui_observation, needs_browser_check, or blocked_requires_ui_lane
- Do NOT attempt to invoke any UI tool, browser tool, or desktop automation
- Continue with the best non-UI approach available, or state that you are blocked
This escalation marker will be recorded by CPB and may trigger a separate UI lane session if explicitly allowed.`;

function headlessEscalationSection() {
  return process.env.CPB_ACP_LAUNCH_PROFILE !== "ui" ? HEADLESS_ESCALATION_CONTRACT : "";
}

export async function buildPlannerPrompt(executorRoot: string, cpbRoot: string, project: string, task: string, planFile: string, _options: LooseRecord = {}): Promise<string> {
  const roleTitle = await readRoleTitle(executorRoot, "planner");
  const skillsSection = await buildSkillsSection(executorRoot, "planner", { phase: "plan", task });
  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);
  const profile = await loadProfile(executorRoot, "planner", { projectWikiDir: wikiDir });
  const projContext = await preRead(path.join(wikiDir, "context.md"));
  const decisions = await preRead(path.join(wikiDir, "decisions.md"));
  const handshake = await preRead(path.join(executorRoot, "wiki", "system", "handshake-protocol.md"));
  const planTpl = await preRead(path.join(executorRoot, "templates", "handoff", "plan-to-execute.md"));
  const planModeGuidance = plannerModeSection();

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

${headlessEscalationSection()}

${executionIntensitySection("plan")}

${planModeGuidance}

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
Use scope-matched step count with concrete acceptance criteria.${await projectInstructionsSection(wikiDir)}`;
}

export async function buildExecutorPrompt(executorRoot: string, cpbRoot: string, project: string, planId: string, deliverableFile: string, verdictFile: string, _options: LooseRecord = {}): Promise<string> {
  const roleTitle = await readRoleTitle(executorRoot, "executor");
  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);

  const profile = await loadProfile(executorRoot, "executor", { projectWikiDir: wikiDir });
  const planFile = path.join(wikiDir, "inbox", `plan-${planId}.md`);
  const planContent = await preRead(planFile);
  const skillsSection = await buildSkillsSection(executorRoot, "executor", { phase: "execute", artifactText: planContent });

  const projectCwd = process.env.CPB_PROJECT_PATH_OVERRIDE || process.env.CPB_ACP_CWD || "";

  const issueNumber = process.env.CPB_ISSUE_NUMBER;
  let issueContextSection = "";
  if (issueNumber) {
    issueContextSection = `## Issue Context
- Expected GitHub issue: #${issueNumber}
- Exact plan file to read: ${planFile}
- You MUST read the plan file at the exact path above. Do NOT substitute or fall back to any other plan-*.md file.
- Your deliverable Task-Ref MUST reference issue #${issueNumber}. Using a different issue number is a hard failure.`;
  }

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
      const verdictContent = await readFile(verdictFile, "utf8");
      const retryInput = buildRetryInputFromVerdict(parseVerdictEnvelope(verdictContent), {
        retryCount: Number(process.env.CPB_RETRY_COUNT || 1),
        previousVerdictId: path.basename(verdictFile, path.extname(verdictFile)),
        previousVerdictPath: verdictFile,
      });
      fixSection = `## Previous Verification Failure (FIX REQUIRED)
The previous deliverable was verified and REJECTED. Read the verdict for details:
- Verdict file: ${verdictFile}
You MUST address the specific failures listed in the verdict. Do NOT repeat the same approach.
${retryInput.shouldRetry ? `
## Normalized Retry Input
${retryInput.prompt}` : ""}`;
    } catch {
      // verdict file doesn't exist yet, skip fix section
    }
  }

  return `You are CodePatchbay Executor. Role: ${roleTitle}

${skillsSection}

## CRITICAL: Read from locators, verify current state
When a plan references locators or job state, read from those locators directly.
Treat artifact contents as audit context — verify them against live job/event state.

${constraints}

${headlessEscalationSection()}

${executionIntensitySection("execute")}

${issueContextSection}

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
5. After the deliverable is written, stop immediately and return a short completion message. Do not continue exploring or wait for further input.
Follow handshake-protocol (executor->verifier, Phase: execute).
Include plan-ref: ${planId} in the deliverable metadata.${await projectInstructionsSection(wikiDir)}`;
}

export async function buildExecutorJobPrompt(executorRoot: string, cpbRoot: string, project: string, jobId: string, deliverableFile: string, _options: LooseRecord = {}): Promise<string> {
  const roleTitle = await readRoleTitle(executorRoot, "executor");
  const skillsSection = await buildSkillsSection(executorRoot, "executor");
  const projectDataRoot = await resolvePromptDataRoot(cpbRoot, project, _options);
  const wikiDir = path.join(projectDataRoot, "wiki");
  const profile = await loadProfile(executorRoot, "executor", { projectWikiDir: wikiDir });
  const planMode = process.env.CPB_PLAN_MODE || "auto";
  const noPlan = planMode === "none";
  const eventLog = path.join(projectDataRoot, "events", project, `${jobId}.jsonl`);
  const stateRoot = projectDataRoot;
  const resolvedDeliverableFile = path.join(wikiDir, "outputs", path.basename(deliverableFile));
  const routingFeedbackFile = path.join(wikiDir, "outputs", path.basename(dispatchFeedbackPath(cpbRoot, project, jobId)));
  const contextPack = await resolveContextPackLocator(cpbRoot, project, jobId, { ..._options, dataRoot: projectDataRoot });
  const contextPackLocator = contextPack?.path
    ? `- Job context pack: ${contextPack.path}`
    : "";

  const projectCwd = process.env.CPB_PROJECT_PATH_OVERRIDE || process.env.CPB_ACP_CWD || "";

  const dangerous = process.env.CPB_DANGEROUS === "1";
  const constraints = dangerous
    ? ""
    : `## Constraints
- Write code ONLY in the target project directory${projectCwd ? ": " + projectCwd : ""}
- Write deliverable ONLY to: ${resolvedDeliverableFile}
- Write verdicts ONLY under: ${path.join(wikiDir, "outputs")}/
- Do NOT modify files under: ${path.join(executorRoot, "wiki", "system")}/, ${path.join(executorRoot, "profiles")}/, ${path.join(executorRoot, "bridges")}/
- Do NOT mutate git history, publish, deploy, or run destructive shell commands.
- Do NOT read or write files outside the project, CodePatchbay wiki, and CodePatchbay profiles directories.`;

  return `You are CodePatchbay Executor. Role: ${roleTitle}

${skillsSection}

## CRITICAL: Read from locators, not copied artifacts
Reconstruct your task and current state from locators and job/event state below.
Artifacts (plans, deliverables, verdicts) are audit context - verify them against live state.
Do NOT treat copied artifact contents as authoritative.
${noPlan ? "This job intentionally skipped planning. Execute directly from the job event log, task text, source context, and current repository state." : ""}

## Locators
- Job ID: ${jobId}
- Event log: ${eventLog}
- State root: ${stateRoot}
- Plans directory: ${path.join(wikiDir, "inbox")}
- Plan mode: ${planMode}
- Outputs directory: ${path.join(wikiDir, "outputs")}
- Project context: ${path.join(wikiDir, "context.md")}
- Decisions: ${path.join(wikiDir, "decisions.md")}
- Project metadata: ${path.join(wikiDir, "project.json")}
${contextPackLocator}
- Role definition: ${path.join(executorRoot, "profiles", "executor", "soul.md")}
- Deliverable template: ${path.join(executorRoot, "templates", "handoff", "execute-to-review.md")}
- Handshake format: ${path.join(executorRoot, "wiki", "system", "handshake-protocol.md")}

${constraints}
${executionIntensitySection("execute")}
${buildSubagentGuidance("execute", profile)}
## Routing Preflight
Before modifying files, decide whether this route is strong enough for the task. If the job needs a stronger route, write this exact JSON shape to ${routingFeedbackFile}, then stop without creating a deliverable:
\`\`\`json
{
  "schemaVersion": ${DISPATCH_FEEDBACK_SCHEMA_VERSION},
  "requested": { "workflow": "complex", "planMode": "full", "reviewer": true },
  "reason": "one sentence explaining why the current route is insufficient",
  "confidence": 0.8,
  "signals": ["security", "auth", "db", "payment"]
}
\`\`\`
Valid requested.workflow values are "standard" and "complex"; use "complex" for security/auth/db/payment risk. Valid requested.planMode values are "light", "full", and "parent"; use "full" for protected or complex work.

## Instructions
1. Read the event log to reconstruct the task goal${noPlan ? "." : " and plan phase output."}
2. ${contextPack?.path ? "Read the job-specific context pack locator above before selecting files to inspect." : "Use CodeGraph or focused repository inspection before selecting files to inspect."}
3. ${noPlan ? "Use the task text, source context, and repository state as the implementation brief." : "Read the plan from the plans directory (audit context, not sole truth)."}
4. Verify current job/task state from the locators above.
5. Implement the requested code changes.
6. Run tests and record results.
7. Write the deliverable to: ${resolvedDeliverableFile}
8. After the deliverable is written, stop immediately and return a short completion message. Do not continue exploring or wait for further input.
Follow handshake-protocol (executor->verifier, Phase: execute).
Include plan-ref derived from the plan artifact in the deliverable metadata.${await projectInstructionsSection(wikiDir)}`;
}

export async function buildRepairerPrompt(executorRoot: string, cpbRoot: string, project: string, jobId: string, repairFile: string): Promise<string> {
  const roleTitle = await readRoleTitle(executorRoot, "repairer");
  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);

  const profile = await loadProfile(executorRoot, "repairer", { projectWikiDir: wikiDir });
  const skillsSection = await buildSkillsSection(executorRoot, "repairer", { phase: "repair" });

  const dangerous = process.env.CPB_DANGEROUS === "1";
  const constraints = dangerous
    ? ""
    : `## Constraints
- ONLY write the repair output to: ${repairFile}
- You may modify project code to fix the reported issues.
- Do NOT modify wiki inputs, inbox files, or verdict files.`;

  return `You are CodePatchbay Repairer. Role: ${roleTitle}

${skillsSection}

${constraints}

${headlessEscalationSection()}

${executionIntensitySection("repair")}

## Repair locators
- Repair output file: ${repairFile}
- Job ID: ${jobId}
- Outputs directory: ${path.join(wikiDir, "outputs")}
- Project context: ${path.join(wikiDir, "context.md")}
- Decisions: ${path.join(wikiDir, "decisions.md")}
- Project metadata: ${path.join(wikiDir, "project.json")}

## Instructions
1. Read the deliverable and verdict files from the outputs directory to understand what failed.
2. Identify the root cause of the failure.
3. Apply the minimal fix to resolve the reported issues.
4. Write the repair summary to: ${repairFile}
5. After the repair file is written, stop immediately and return a short completion message.${await projectInstructionsSection(wikiDir)}`;
}

export async function buildVerifierPrompt(executorRoot: string, cpbRoot: string, project: string, deliverableId: string, verdictFile: string, { planId }: LooseRecord = {}): Promise<string> {
  const roleTitle = await readRoleTitle(executorRoot, "verifier");
  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);

  const profile = await loadProfile(executorRoot, "verifier", { projectWikiDir: wikiDir });
  const deliverableFile = path.join(wikiDir, "outputs", `deliverable-${deliverableId}.md`);
  const deliverableContent = await preRead(deliverableFile);
  const skillsSection = await buildSkillsSection(executorRoot, "verifier", { phase: "verify", artifactText: deliverableContent });
  const planArtifactPath = planId ? path.join(wikiDir, "inbox", `plan-${planId}.md`) : null;

  const dangerous = process.env.CPB_DANGEROUS === "1";
  const constraints = dangerous
    ? ""
    : `## Constraints
- ONLY write the verdict to: ${verdictFile}
- You may use read-only local inspection commands/tools for observation when available (for example: pwd, ls, sed, cat, rg, git status, git diff).
- Run build/test commands only when they are expected to be safe for this workspace; otherwise record them as not run.
- Do NOT modify code, project files, wiki inputs, git state, dependencies, caches, or runtime state.`;

  const planLocatorLines = planArtifactPath
    ? `- Exact plan artifact: ${planArtifactPath}
- Plans directory: ${path.join(wikiDir, "inbox")}
- You MUST read the plan at the exact path above. Do NOT substitute or fall back to any other plan-*.md file. Using a different plan is a hard failure.`
    : `- Plans directory: ${path.join(wikiDir, "inbox")}`;

  const issueContextLines = process.env.CPB_ISSUE_NUMBER
    ? `- Expected GitHub issue: #${process.env.CPB_ISSUE_NUMBER}
- If the deliverable resolves to a different GitHub issue, report issue_mismatch in your verdict.`
    : "";

  return `You are CodePatchbay Verifier. Role: ${roleTitle}

${skillsSection}

${constraints}

${headlessEscalationSection()}

${executionIntensitySection("verify")}

## Verification locators
- Deliverable file: ${deliverableFile}
${planLocatorLines}
- Outputs directory: ${path.join(wikiDir, "outputs")}
- Project context: ${path.join(wikiDir, "context.md")}
- Decisions: ${path.join(wikiDir, "decisions.md")}
- Project metadata: ${path.join(wikiDir, "project.json")}
${issueContextLines}

## Instructions
1. Read the deliverable file and referenced plan from the locators above.
2. MANDATORY: Run \`node --check\` on every relevant compiled .js file. If ANY file has a syntax error, the verdict MUST be "fail" — no exceptions.
3. MANDATORY: If a package.json with a "test" script exists in the project root, run \`npm test\`. If tests fail, the verdict MUST be "fail".
4. If both step 2 and step 3 pass, then verify the deliverable against the task goal and plan Acceptance-Criteria.
5. Run broader regression tests only when the above checks pass.
6. Write the verdict to: ${verdictFile}
7. After the verdict file is written, stop immediately and return a short completion message. Do not continue exploring or wait for further input.

## Output Format (MANDATORY)
Write ONLY a JSON object to the verdict file. No markdown, no headers, no free-form text before or after the JSON. The ENTIRE file must be valid JSON.

\`\`\`json
{
  "status": "<pass|fail|inconclusive|infra_error>",
  "confidence": <0.0-1.0>,
  "layers": {
    "fast": { "status": "<pass|fail|not_run>", "detail": "<result in one sentence>" },
    "changed": { "status": "<pass|fail|not_run>", "detail": "<result in one sentence>" },
    "regression": { "status": "<pass|fail|skipped>", "detail": "<result or skip reason>" },
    "acceptance": { "status": "<pass|fail|not_run>", "detail": "<criteria check result>" }
  },
  "blocking": [
    { "criterion": "<what failed>", "evidence": "<observation>", "file": "<path>", "fix_hint": "<suggestion>" }
  ],
  "diff_summary": "<file count and line count>",
  "task_goal": "<what the task was trying to achieve>",
  "executor_summary": "<what the executor claimed>",
  "reason": "<one-line explanation of the verdict>",
  "fix_scope": ["<file paths that need changes>"]
}
\`\`\`

Status values: "pass" (all criteria met), "fail" (correctness/quality issues), "inconclusive" (cannot determine), "infra_error" (infrastructure prevents verification).
Every layer MUST be present. Use "not_run" or "skipped" if a layer was not executed.
"blocking" is REQUIRED when status is "fail". Each entry must have criterion, evidence, and file.
"fix_scope" lists files that need changes for the next retry attempt.
Keep "reason" and all "detail" fields to ONE sentence each. Do NOT write paragraphs.${await projectInstructionsSection(wikiDir)}`;
}

export async function buildVerifierJobPrompt(executorRoot: string, cpbRoot: string, project: string, jobId: string, verdictFile: string, options: LooseRecord = {}): Promise<string> {
  const { planId } = options;
  const roleTitle = await readRoleTitle(executorRoot, "verifier");
  const skillsSection = await buildSkillsSection(executorRoot, "verifier", { phase: "verify" });
  const projectDataRoot = await resolvePromptDataRoot(cpbRoot, project, options);
  const wikiDir = path.join(projectDataRoot, "wiki");
  const resolvedVerdictFile = path.join(wikiDir, "outputs", path.basename(verdictFile));

  const profile = await loadProfile(executorRoot, "verifier", { projectWikiDir: wikiDir });
  const planArtifactPath = planId ? path.join(wikiDir, "inbox", `plan-${planId}.md`) : null;

  const dangerous = process.env.CPB_DANGEROUS === "1";
  const constraints = dangerous
    ? ""
    : `## Constraints
- ONLY write the verdict to: ${resolvedVerdictFile}
- You may use read-only local inspection commands/tools for observation when available (for example: pwd, ls, sed, cat, rg, git status, git diff).
- Run build/test commands only when they are expected to be safe for this workspace; otherwise record them as not run.
- Do NOT modify code, project files, wiki inputs, git state, dependencies, caches, or runtime state.`;

  const planLocatorLines = planArtifactPath
    ? `- Exact plan artifact: ${planArtifactPath}
- Plans directory: ${path.join(wikiDir, "inbox")}
- You MUST read the plan at the exact path above. Do NOT substitute or fall back to any other plan-*.md file. Using a different plan is a hard failure.`
    : `- Plans directory: ${path.join(wikiDir, "inbox")}`;

  const issueContextLines = process.env.CPB_ISSUE_NUMBER
    ? `- Expected GitHub issue: #${process.env.CPB_ISSUE_NUMBER}
- If the deliverable resolves to a different GitHub issue, report issue_mismatch in your verdict.`
    : "";

  return `You are CodePatchbay Verifier. Role: ${roleTitle}

${skillsSection}

${constraints}

${headlessEscalationSection()}

${executionIntensitySection("verify")}

## Verification locators
- Job ID: ${jobId}
- Event log: ${path.join(projectDataRoot, "events", project, `${jobId}.jsonl`)}
${planLocatorLines}
- Outputs directory: ${path.join(wikiDir, "outputs")}
- Project context: ${path.join(wikiDir, "context.md")}
- Decisions: ${path.join(wikiDir, "decisions.md")}
- Project metadata: ${path.join(wikiDir, "project.json")}
${issueContextLines}

## Instructions
1. Reconstruct the task goal and phase history from the job/event locators above.
2. MANDATORY: Run \`node --check\` on every relevant compiled .js file. If ANY file has a syntax error, the verdict MUST be "fail" — no exceptions.
3. MANDATORY: If a package.json with a "test" script exists in the project root, run \`npm test\`. If tests fail, the verdict MUST be "fail".
4. If both step 2 and step 3 pass, inspect current project state and verify against task goal.
5. Run broader regression tests only when the above checks pass.
6. If data is missing, return a diagnostic verdict instead of crashing.
7. Write the verdict to: ${resolvedVerdictFile}
8. After the verdict file is written, stop immediately and return a short completion message. Do not continue exploring or wait for further input.

## Output Format (MANDATORY)
Write ONLY a JSON object to the verdict file. No markdown, no headers, no free-form text before or after the JSON. The ENTIRE file must be valid JSON.

\`\`\`json
{
  "status": "<pass|fail|inconclusive|infra_error>",
  "confidence": <0.0-1.0>,
  "layers": {
    "fast": { "status": "<pass|fail|not_run>", "detail": "<result in one sentence>" },
    "changed": { "status": "<pass|fail|not_run>", "detail": "<result in one sentence>" },
    "regression": { "status": "<pass|fail|skipped>", "detail": "<result or skip reason>" },
    "acceptance": { "status": "<pass|fail|not_run>", "detail": "<criteria check result>" }
  },
  "blocking": [
    { "criterion": "<what failed>", "evidence": "<observation>", "file": "<path>", "fix_hint": "<suggestion>" }
  ],
  "diff_summary": "<file count and line count>",
  "task_goal": "<what the task was trying to achieve>",
  "executor_summary": "<what the executor claimed>",
  "reason": "<one-line explanation of the verdict>",
  "fix_scope": ["<file paths that need changes>"]
}
\`\`\`

Status values: "pass" (all criteria met), "fail" (correctness/quality issues), "inconclusive" (cannot determine), "infra_error" (infrastructure prevents verification).
Every layer MUST be present. Use "not_run" or "skipped" if a layer was not executed.
"blocking" is REQUIRED when status is "fail". Each entry must have criterion, evidence, and file.
"fix_scope" lists files that need changes for the next retry attempt.
Keep "reason" and all "detail" fields to ONE sentence each. Do NOT write paragraphs.${await projectInstructionsSection(wikiDir)}`;
}

export async function buildRemediatorPrompt(executorRoot: string, cpbRoot: string, project: string, jobId: string, remediationFile: string, options: LooseRecord = {}): Promise<string> {
  const roleTitle = await readRoleTitle(executorRoot, "remediator");
  const skillsSection = await buildSkillsSection(executorRoot, "remediator", { phase: "remediate" });
  const projectDataRoot = await resolvePromptDataRoot(cpbRoot, project, options);
  const wikiDir = path.join(projectDataRoot, "wiki");
  const profile = await loadProfile(executorRoot, "remediator", { projectWikiDir: wikiDir });
  const eventLog = path.join(projectDataRoot, "events", project, `${jobId}.jsonl`);
  const projectCwd = process.env.CPB_PROJECT_PATH_OVERRIDE || process.env.CPB_ACP_CWD || "";

  const dangerous = process.env.CPB_DANGEROUS === "1";
  const constraints = dangerous
    ? ""
    : `## Scope
- Work in the CodePatchbay executor root: ${executorRoot}
- Use the target project only for direct inspection when needed: ${projectCwd || "[missing project root]"}
- Write the remediation report only to: ${remediationFile}
- Leave verifier, retry, recover, and pipeline execution paths outside this remediation run.`;

  return `You are CodePatchbay Remediator. Role: ${roleTitle}

${skillsSection}

Your job is to remediate CodePatchbay executor/runtime code when a CPB job failed because CPB itself behaved incorrectly.

${constraints}
${buildSubagentGuidance("remediate", profile)}

${headlessEscalationSection()}

${executionIntensitySection("remediate")}

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
3. If it is a CPB self-bug, make the smallest code change that remediates that bug.
4. After successful remediation, the execution channel points to a new task carrying remediation lineage metadata; the original failed job remains an audit record.
5. Write the remediation report at the path below.

Write the remediation report to: ${remediationFile}

The report's first line MUST be exactly one of:
REMEDIATION: FIXED
REMEDIATION: NOOP
REMEDIATION: BLOCKED

After the first line, include concise findings, changed files, and verification you ran.${await projectInstructionsSection(wikiDir)}`;
}

export async function buildReviewerReviewPrompt(executorRoot: string, cpbRoot: string, project: string, deliverableId: string, _options: LooseRecord = {}): Promise<string> {
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

${headlessEscalationSection()}

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
## Verdict
REVIEW: <PASS|FAIL>

## Summary
[Overall assessment in one short paragraph]

## Blocking Findings
Blocking findings are must-fix issues: correctness errors, security vulnerabilities, broken tests/builds, data loss risks, or acceptance-criteria failures.
If any blocking finding exists, REVIEW: FAIL is required.
If Blocking Findings is empty (write "None."), REVIEW: PASS is required.

Per-finding template:
### [Severity] [Title]
- **File**: path:line
- **Issue**: description
- **Evidence**: what proves this is a problem
- **Fix**: suggested fix

## Non-Blocking Findings
Non-blocking findings are minor readability, maintainability, performance, or follow-up suggestions that do not block approval.
If there are none, write "None."

Per-finding template:
### [Severity] [Title]
- **File**: path:line
- **Issue**: description
- **Evidence**: what proves this is a problem
- **Fix**: suggested fix

Use severity labels: Critical / Major / Minor / Suggestion.
Critical and Major issues normally belong in Blocking Findings unless you can justify otherwise.
Minor and Suggestion issues belong in Non-Blocking Findings.${await projectInstructionsSection(wikiDir)}`;
}
