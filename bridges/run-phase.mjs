#!/usr/bin/env node
// run-phase.mjs - Unified Node phase entrypoint (plan/execute/verify/review/repair)
// Replaces shell bridge business logic. Shell wrappers exec this for CLI compatibility.
//
// Usage:
//   node bridges/run-phase.mjs plan --executor-root <r> --cpb-root <r> --project <p> --task "<t>"
//   node bridges/run-phase.mjs execute --executor-root <r> --cpb-root <r> --project <p> --plan-id <id> [--verdict-file <path>]
//   node bridges/run-phase.mjs verify --executor-root <r> --cpb-root <r> --project <p> --deliverable-id <id>
//   node bridges/run-phase.mjs verify --executor-root <r> --cpb-root <r> --project <p> --job-id <id>
//   node bridges/run-phase.mjs review --executor-root <r> --cpb-root <r> --project <p> --deliverable-id <id>
//   node bridges/run-phase.mjs repair --executor-root <r> --cpb-root <r> --project <p> --job-id <id>

import { readFile, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  buildPlannerPrompt,
  buildExecutorPrompt,
  buildExecutorJobPrompt,
  buildVerifierPrompt,
  buildVerifierJobPrompt,
  buildRepairerPrompt,
  buildReviewerReviewPrompt,
} from "../server/services/prompt-builder.js";
import {
  allocateArtifactId,
  planFilePath,
  deliverableFilePath,
  verdictFilePath,
  reviewFilePath,
  wikiLogPath,
  dashboardPath,
} from "../server/services/artifact-locator.js";
import { parseVerdictEnvelope } from "../core/workflow/verdict.js";
import { isWorkflowName, listWorkflows } from "../core/workflow/definition.js";
import { applyVariant } from "../runtime/apply-variant.js";
import { runRepair, completeRepair } from "../server/services/repair-handler.js";
import { resolveAcpLane } from "../core/acp/policy.js";
import { recordUiEscalations } from "../runtime/record-ui-escalation.js";
import { validateNonEmptyMarkdownArtifact, resolveDeliverableIssue, validateIssueMatch } from "../server/services/artifact-integrity.js";
import { loadRegistry, legacyAgentForPhase, defaultAgentForRole } from "../core/agents/registry.js";

// --- CLI arg parsing ---

function parseArgs(argv) {
  const phase = argv[0];
  if (!phase || !["plan", "execute", "verify", "review", "repair"].includes(phase)) {
    throw new Error(`first argument must be a phase name (plan|execute|verify|review|repair), got: ${phase}`);
  }

  const options = new Map();
  for (let i = 1; i < argv.length; i++) {
    const name = argv[i];
    if (!name.startsWith("--")) {
      throw new Error(`unexpected argument: ${name}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${name}`);
    }
    options.set(name, value);
    i++;
  }

  const executorRoot = options.get("--executor-root") || process.env.CPB_EXECUTOR_ROOT || path.resolve(path.dirname(import.meta.url.replace("file://", "")), "..");
  const cpbRoot = options.get("--cpb-root") || process.env.CPB_ROOT || executorRoot;
  const project = options.get("--project") || "";
  const workflow = options.get("--workflow") || process.env.CPB_WORKFLOW || "";
  if (workflow && !isWorkflowName(workflow)) {
    throw new Error(`invalid workflow: ${workflow} (valid: ${listWorkflows().join(", ")})`);
  }

  if (!project || !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(project)) {
    throw new Error(`invalid project name: ${project}`);
  }

  const agent = options.get("--agent") || "";

  return { phase, executorRoot: path.resolve(executorRoot), cpbRoot: path.resolve(cpbRoot), project, workflow, agent, options };
}

// --- Logging helpers ---

const CYAN = "\x1b[0;36m";
const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const YELLOW = "\x1b[1;33m";
const NC = "\x1b[0m";

async function logAppend(cpbRoot, project, msg) {
  const logFile = wikiLogPath(cpbRoot, project);
  const lockDir = path.join(path.dirname(logFile), ".cpb-log.lock");
  let acquired = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await mkdir(lockDir);
      acquired = true;
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    await appendFile(logFile, `- **${ts}** | ${msg}\n`, "utf8");
  } finally {
    if (acquired) {
      try {
        const { rmdir } = await import("node:fs/promises");
        await rmdir(lockDir);
      } catch {}
    }
  }
}

async function dashboardUpdate(cpbRoot, project, phase, status, next) {
  const dashFile = dashboardPath(cpbRoot);
  try {
    let content = await readFile(dashFile, "utf8");
    const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const entry = `\n### ${project}\n- **status**: ${status}\n- **phase**: ${phase}\n- **updated**: ${ts}\n- **next**: ${next}\n`;
    const marker = "## 活跃项目";
    const idx = content.indexOf(marker);
    if (idx >= 0) {
      const rest = content.substring(idx + marker.length);
      const escaped = project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const cleaned = rest.replace(new RegExp(`\\n### ${escaped}\\n(- .+\\n)*`), "");
      content = content.substring(0, idx) + marker + entry + cleaned;
    }
    const { writeFile: writeDash } = await import("node:fs/promises");
    await writeDash(dashFile, content, "utf8");
  } catch {}
}

// --- ACP runner ---

async function runAcpManaged(agent, prompt, cwd, timeoutMs, executorRoot, options = {}) {
  const { getManagedAcpPool } = await import("../server/services/acp-pool.js");
  const cpbRoot = process.env.CPB_ROOT || executorRoot;
  const pool = getManagedAcpPool({ cpbRoot, hubRoot: undefined });
  try {
    const stdout = await pool.execute(agent, prompt, cwd, timeoutMs, { ...options, _executorRoot: executorRoot });
    return { exitCode: 0, stdout: typeof stdout === "string" ? stdout : "", stderr: "", error: null };
  } catch (err) {
    return { exitCode: 1, stdout: "", stderr: err.message, error: err };
  }
}

async function runAcp(agent, prompt, cwd, executorRoot) {
  if (process.env.CPB_ACP_USE_MANAGED_POOL !== "0") {
    return runAcpManaged(agent, prompt, cwd, 300_000, executorRoot);
  }
  const { spawn } = await import("node:child_process");
  const clientPath = process.env.CPB_ACP_CLIENT || path.join(executorRoot, "bridges", "acp-client.mjs");
  const useDirect = !!process.env.CPB_ACP_CLIENT;

  if (agent === "claude") {
    applyVariant();
  }

  return new Promise((resolve) => {
    let settled = false;
    const stdoutChunks = [];
    const stderrChunks = [];

    function finish(result) {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    let child;
    try {
      const command = useDirect ? clientPath : process.execPath;
      const args = useDirect ? ["--agent", agent, "--cwd", cwd] : [clientPath, "--agent", agent, "--cwd", cwd];
      const env = { ...process.env };

      if (!process.env.CPB_TEST_ENV_LOG && !env.ANTHROPIC_API_KEY && env.ANTHROPIC_AUTH_TOKEN) {
        env.ANTHROPIC_API_KEY = env.ANTHROPIC_AUTH_TOKEN;
        delete env.ANTHROPIC_AUTH_TOKEN;
      }

      child = spawn(command, args, {
        cwd,
        env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ exitCode: 1, stdout: "", stderr: err.message, error: err });
      return;
    }

    child.stdin.write(prompt);
    child.stdin.end();

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
      process.stderr.write(chunk);
    });
    child.on("error", (err) => finish({ exitCode: 1, stdout: "", stderr: "", error: err }));
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      finish({ exitCode: code ?? 1, stdout, stderr });
    });

    // Forward signals to child process group when possible
    const forwardSignal = (sig) => {
      try {
        if (child.pid && !child.killed) {
          process.kill(-child.pid, sig);
        }
      } catch {}
    };
    process.on("SIGINT", forwardSignal);
    process.on("SIGTERM", forwardSignal);
    child.on("close", () => {
      process.removeListener("SIGINT", forwardSignal);
      process.removeListener("SIGTERM", forwardSignal);
    });
  });
}

// --- Verdict parsing ---

async function recordUiEscalationsWrapper(stdout, cpbRoot, project, phase, agent) {
  const jobId = process.env.CPB_ACP_JOB_ID || "";
  const acpProfile = process.env.CPB_ACP_LAUNCH_PROFILE || "headless";
  await recordUiEscalations(stdout, cpbRoot, project, jobId, phase, agent, acpProfile);
}

function parseVerdictFromContent(content) {
  const envelope = parseVerdictEnvelope(content);
  const mapped = { pass: "PASS", fail: "FAIL", inconclusive: "UNKNOWN", infra_error: "INFRA_FAILURE" };
  return mapped[envelope.status] || "UNKNOWN";
}

function parseReviewVerdict(content) {
  const lines = content.split(/\r?\n/).slice(0, 20);
  for (const line of lines) {
    const match = line.match(/^REVIEW:\s*(PASS|FAIL)\b/i);
    if (match) return match[1].toUpperCase();
  }
  for (const line of lines) {
    const inline = line.match(/\bREVIEW:\s*(PASS|FAIL)\b/i);
    if (inline) return inline[1].toUpperCase();
  }
  return "UNKNOWN";
}

// --- Phase handlers ---

async function handlePlan(args, agent) {
  const { executorRoot, cpbRoot, project, options } = args;
  const task = options.get("--task") || "";
  if (!task) throw new Error("--task is required for plan phase");

  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);
  const inboxDir = path.join(wikiDir, "inbox");
  const planId = await allocateArtifactId(inboxDir, "plan");
  const planFile = planFilePath(cpbRoot, project, planId);

  console.log(`Planning [${project}]: ${task}`);
  console.log(`Output: ${planFile}`);

  const prompt = await buildPlannerPrompt(executorRoot, cpbRoot, project, task, planFile);
  const result = await runAcp(agent, prompt, process.env.CPB_ACP_CWD || process.cwd(), executorRoot);

  if (result.error) {
    console.error(`Plan spawn failed: ${result.error.message}`);
    return 1;
  }

  await recordUiEscalationsWrapper(result.stdout, cpbRoot, project, "plan", agent);

  // Check if plan file was created and is non-empty
  const planValidation = await validateNonEmptyMarkdownArtifact({ path: planFile, kind: "plan", id: planId });
  if (!planValidation.valid) {
    await logAppend(cpbRoot, project, `planner | plan | Plan artifact invalid (${planValidation.reason}) for: ${task} | FAIL`);
    console.error(`Plan artifact invalid: ${planValidation.reason}`);
    return 1;
  }

  await logAppend(cpbRoot, project, `planner | plan | Created plan-${planId} for: ${task} | SUCCESS`);
  await dashboardUpdate(cpbRoot, project, "plan", "EXECUTING", `cpb execute ${project} ${planId}`);
  console.log("");
  console.log(`Plan: ${planFile}`);
  console.log(`Next: cpb execute ${project} ${planId}`);
  return 0;
}

async function handleExecute(args, agent) {
  const { executorRoot, cpbRoot, project, options } = args;
  const planId = options.get("--plan-id") || "";
  const jobId = options.get("--job-id") || "";
  const legacyContent = options.has("--legacy-content");
  if (!planId && !jobId) throw new Error("--plan-id or --job-id is required for execute phase");

  const verdictFile = options.get("--verdict-file") || "";
  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);

  if (planId) {
    const planFile = planFilePath(cpbRoot, project, planId);
    const planValidation = await validateNonEmptyMarkdownArtifact({ path: planFile, kind: "plan", id: planId });
    if (!planValidation.valid) {
      console.error(`Plan artifact invalid: ${planValidation.reason} (${planFile})`);
      return 1;
    }
  }

  const outputsDir = path.join(wikiDir, "outputs");
  const deliverableId = await allocateArtifactId(outputsDir, "deliverable");
  const deliverableFile = deliverableFilePath(cpbRoot, project, deliverableId);

  let prompt;
  if (jobId && !planId) {
    // Locator-first path: build prompt from job/event state, not artifact content
    console.log(`Executing [${project}] job-${jobId} (locator-first)...`);
    prompt = await buildExecutorJobPrompt(executorRoot, cpbRoot, project, jobId, deliverableFile);
  } else if (planId && !legacyContent && jobId) {
    // Legacy artifact ID provided but jobId is available: use locator-first context packet
    console.log(`Executing [${project}] plan-${planId} via job-${jobId} (locator-first)...`);
    prompt = await buildExecutorJobPrompt(executorRoot, cpbRoot, project, jobId, deliverableFile);
  } else {
    // Backward-compatible artifact-based path (only with --legacy-content or no jobId)
    const planFile = planFilePath(cpbRoot, project, planId);
    try { await readFile(planFile, "utf8"); } catch {
      console.error(`Plan file not found: ${planFile}`);
      return 1;
    }
    console.log(`Executing [${project}] plan-${planId}${legacyContent ? " (legacy-content)" : ""}...`);
    prompt = await buildExecutorPrompt(executorRoot, cpbRoot, project, planId, deliverableFile, verdictFile || null);
  }
  console.log(`Output: ${deliverableFile}`);

  const result = await runAcp(agent, prompt, process.env.CPB_ACP_CWD || process.cwd(), executorRoot);

  if (result.error) {
    console.error(`Execute spawn failed: ${result.error.message}`);
    return 1;
  }

  if (result.exitCode !== 0) {
    await logAppend(cpbRoot, project, `executor | execute | ACP exited ${result.exitCode} for plan-${planId} | FAIL`);
    console.error(`Execute failed: ACP agent exited with code ${result.exitCode}`);
    return 1;
  }

  await recordUiEscalationsWrapper(result.stdout, cpbRoot, project, "execute", agent);

  let deliverableContent;
  try {
    deliverableContent = await readFile(deliverableFile, "utf8");
  } catch {
    await logAppend(cpbRoot, project, `executor | execute | deliverable not created from plan-${planId} | FAIL`);
    console.error("Deliverable not created.");
    return 1;
  }

  if (!deliverableContent.trim()) {
    await logAppend(cpbRoot, project, `executor | execute | deliverable-${deliverableId} is empty (0-byte placeholder) | FAIL`);
    console.error("Deliverable is empty — agent produced no output.");
    return 1;
  }

  // Check issue match when expected issue is set
  const expectedIssue = process.env.CPB_ISSUE_NUMBER;
  if (expectedIssue) {
    const artifactIssue = resolveDeliverableIssue(deliverableContent);
    const issueResult = validateIssueMatch({
      expectedIssueNumber: parseInt(expectedIssue, 10),
      artifactIssueNumber: artifactIssue,
      artifactPath: deliverableFile,
    });
    if (!issueResult.match) {
      await logAppend(cpbRoot, project, `executor | execute | deliverable-${deliverableId} issue mismatch: expected #${issueResult.expected}, got #${issueResult.actual} | FAIL`);
      console.error(`Deliverable issue mismatch: expected #${issueResult.expected}, resolves to #${issueResult.actual}`);
      return 1;
    }
  }

  await logAppend(cpbRoot, project, `executor | execute | deliverable-${deliverableId} from plan-${planId} | SUCCESS`);
  await dashboardUpdate(cpbRoot, project, "execute", "VERIFYING", `cpb verify ${project} ${deliverableId}`);
  console.log("");
  console.log(`Deliverable: ${deliverableFile}`);
  console.log(`Next: cpb verify ${project} ${deliverableId}`);
  return 0;
}

async function handleVerify(args, agent) {
  const { executorRoot, cpbRoot, project, options } = args;
  const deliverableId = options.get("--deliverable-id") || "";
  const jobId = options.get("--job-id") || "";
  const planId = options.get("--plan-id") || "";
  const legacyContent = options.has("--legacy-content");

  if (!deliverableId && !jobId) {
    throw new Error("--deliverable-id or --job-id is required for verify phase");
  }

  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);

  if (deliverableId && !legacyContent) {
    // Lightweight existence check only (no content read)
    const deliverableFile = deliverableFilePath(cpbRoot, project, deliverableId);
    try { await readFile(deliverableFile, "utf8"); } catch {
      console.error(`Deliverable file not found: ${deliverableFile}`);
      return 1;
    }
  } else if (deliverableId && legacyContent) {
    const deliverableFile = deliverableFilePath(cpbRoot, project, deliverableId);
    try { await readFile(deliverableFile, "utf8"); } catch {
      console.error(`Deliverable file not found: ${deliverableFile}`);
      return 1;
    }
  }

  const artifactId = deliverableId || jobId;
  const verdictFile = verdictFilePath(cpbRoot, project, artifactId);

  const label = jobId ? `job-${jobId}` : `deliverable-${deliverableId}`;
  console.log(`Verifying [${project}] ${label}${legacyContent ? " (legacy-content)" : ""}...`);
  console.log(`Output: ${verdictFile}`);

  const promptOpts = planId ? { planId } : {};
  let prompt;
  if (jobId) {
    // Locator-first: prompt uses context packet with locators, not embedded content
    prompt = await buildVerifierJobPrompt(executorRoot, cpbRoot, project, jobId, verdictFile, promptOpts);
  } else if (deliverableId && !legacyContent) {
    // Deliverable-ID path but locator-first: resolve via job prompt builder if possible
    prompt = await buildVerifierPrompt(executorRoot, cpbRoot, project, deliverableId, verdictFile, promptOpts);
  } else {
    prompt = await buildVerifierPrompt(executorRoot, cpbRoot, project, deliverableId, verdictFile, promptOpts);
  }

  // Block desktop text editor — verifier must read files via text tools, not open editors
  process.env.CPB_ACP_DENY_TOOLS = process.env.CPB_ACP_DENY_TOOLS
    ? `${process.env.CPB_ACP_DENY_TOOLS},text_edit,text-edit`
    : "text_edit,text-edit";

  const result = await runAcp(agent, prompt, process.env.CPB_ACP_CWD || process.cwd(), executorRoot);

  if (result.error) {
    console.error(`Verify spawn failed: ${result.error.message}`);
    return 1;
  }

  await recordUiEscalationsWrapper(result.stdout, cpbRoot, project, "verify", agent);

  // Parse verdict
  let verdictContent;
  try {
    verdictContent = await readFile(verdictFile, "utf8");
  } catch {
    await logAppend(cpbRoot, project, `verifier | verify | verdict not created for ${label} | FAIL`);
    console.error("Warning: Verdict not created.");
    return 1;
  }

  const verdict = parseVerdictFromContent(verdictContent);
  await logAppend(cpbRoot, project, `verifier | verify | ${label} | ${verdict}`);

  console.log("");
  console.log(`Verdict: ${verdict}`);
  if (verdict === "FAIL" || verdict === "PARTIAL") {
    await dashboardUpdate(cpbRoot, project, "verify", "FIXING", `cpb execute ${project} (fix)`);
    console.log(`Fix needed: ${verdictFile}`);
    console.log(`Next: cpb execute ${project} <plan-id>`);
  } else if (verdict === "PASS") {
    await dashboardUpdate(cpbRoot, project, "verify", "DONE", "completed");
    console.log("Deliverable accepted.");
  } else {
    await dashboardUpdate(cpbRoot, project, "verify", "UNCLEAR", "manual review needed");
  }
  return 0;
}

async function handleReview(args, agent) {
  const { executorRoot, cpbRoot, project, options } = args;
  const deliverableId = options.get("--deliverable-id") || "";
  if (!deliverableId) throw new Error("--deliverable-id is required for review phase");

  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);
  const deliverableFile = deliverableFilePath(cpbRoot, project, deliverableId);
  try { await readFile(deliverableFile, "utf8"); } catch {
    console.error(`Deliverable file not found: ${deliverableFile}`);
    return 1;
  }

  const reviewFile = reviewFilePath(cpbRoot, project, deliverableId);
  console.log(`Reviewing [${project}] deliverable-${deliverableId}...`);
  console.log(`Output: ${reviewFile}`);

  const prompt = await buildReviewerReviewPrompt(executorRoot, cpbRoot, project, deliverableId);
  const result = await runAcp(agent, prompt, process.env.CPB_ACP_CWD || process.cwd(), executorRoot);

  if (result.error) {
    console.error(`Review spawn failed: ${result.error.message}`);
    return 1;
  }

  await recordUiEscalationsWrapper(result.stdout, cpbRoot, project, "review", agent);

  let reviewContent;
  try {
    reviewContent = await readFile(reviewFile, "utf8");
  } catch {
    await logAppend(cpbRoot, project, `reviewer | review | review not created for deliverable-${deliverableId} | FAIL`);
    console.error("Warning: Review not created.");
    return 1;
  }

  const reviewVerdict = parseReviewVerdict(reviewContent);
  await logAppend(cpbRoot, project, `reviewer | review | deliverable-${deliverableId} | ${reviewVerdict}`);

  console.log("");
  console.log(`Review: ${reviewVerdict}`);
  if (reviewVerdict === "FAIL") {
    console.log(`Review failed. Must-fix items in: ${reviewFile}`);
  } else {
    console.log("Review passed.");
  }
  return 0;
}

async function handleRepair(args, agent) {
  const { executorRoot, cpbRoot, project, options } = args;
  const jobId = options.get("--job-id") || "";
  if (!jobId) throw new Error("--job-id is required for repair phase");

  const repairDetails = options.has("--repair-file")
    ? (() => {
        const repairFile = options.get("--repair-file");
        const base = path.basename(repairFile, ".md");
        const repairId = base.startsWith("repair-") ? base.slice("repair-".length) : jobId;
        return { repairId, repairFile, repairArtifact: `repair-${repairId}` };
      })()
    : await runRepair(cpbRoot, {
        project,
        jobId,
        executorRoot,
      });
  const { repairId, repairFile, repairArtifact } = repairDetails;
  if (repairDetails.workflow && !process.env.CPB_WORKFLOW) {
    process.env.CPB_WORKFLOW = repairDetails.workflow;
  }
  if (repairDetails.sourcePath && !process.env.CPB_PROJECT_PATH_OVERRIDE) {
    process.env.CPB_PROJECT_PATH_OVERRIDE = repairDetails.sourcePath;
  }
  if (!process.env.CPB_ACP_CWD || process.env.CPB_ACP_CWD === repairDetails.sourcePath) {
    process.env.CPB_ACP_CWD = executorRoot;
  }
  console.log(`Repairing [${project}] job-${jobId}...`);
  console.log(`Repair: ${repairFile}`);

  const { appendEvent: appendEv, checkpointJob, readEvents: readEv, materializeJob } = await import("../server/services/event-store.js");
  const { updateJobsIndexEntry } = await import("../server/services/jobs-index.js");

  async function recordEvent(event) {
    await appendEv(cpbRoot, project, jobId, event);
    await checkpointJob(cpbRoot, project, jobId).catch(() => {});
    const state = materializeJob(await readEv(cpbRoot, project, jobId));
    await updateJobsIndexEntry(cpbRoot, project, jobId, state).catch(() => {});
  }

  await recordEvent({
    type: "external_repair_started",
    jobId,
    project,
    artifact: repairArtifact,
    file: repairFile,
    ts: new Date().toISOString(),
  });

  const prompt = await buildRepairerPrompt(executorRoot, cpbRoot, project, jobId, repairFile);
  const result = await runAcp(agent, prompt, process.env.CPB_ACP_CWD || process.cwd(), executorRoot);

  if (result.error) {
    console.error(`Repair spawn failed: ${result.error.message}`);
    await completeRepair(cpbRoot, {
      project, jobId, repairId, repairFile, repairArtifact,
      status: "failed", error: `repairer spawn failed: ${result.error.message}`,
      executorRoot,
    }).catch(() => {});
    return 1;
  }

  if (result.exitCode !== 0) {
    await completeRepair(cpbRoot, {
      project, jobId, repairId, repairFile, repairArtifact,
      status: "failed", error: `repairer exited ${result.exitCode}`,
      executorRoot,
    }).catch(() => {});
    return result.exitCode;
  }

  await recordUiEscalationsWrapper(result.stdout, cpbRoot, project, "repair", agent);

  try {
    const repairStatus = await completeRepair(cpbRoot, {
      project, jobId, repairId, repairFile, repairArtifact,
      status: "completed", executorRoot,
    });
    await logAppend(cpbRoot, project, `repairer | repair | repair-${repairId} for job-${jobId} | ${repairStatus}`);
  } catch (err) {
    await logAppend(cpbRoot, project, `repairer | repair | repair-${repairId} for job-${jobId} | FAIL: ${err.message}`);
    console.error(`Repair failed: ${err.message}`);
    return 1;
  }
  return 0;
}

// --- Exported API (for Node.js CLI consumption) ---

export async function runPhase(phase, {
  executorRoot,
  cpbRoot,
  project,
  task,
  planId,
  deliverableId,
  jobId,
  verdictFile,
  workflow = "",
  acpProfile = null,
  uiLaneReason = "",
  agent: explicitAgent,
} = {}) {
  const resolvedExecutorRoot = path.resolve(executorRoot || process.env.CPB_EXECUTOR_ROOT || path.resolve(path.dirname(import.meta.url.replace("file://", "")), ".."));
  const resolvedCpbRoot = path.resolve(cpbRoot || process.env.CPB_ROOT || resolvedExecutorRoot);

  if (!project || !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(project)) {
    throw new Error(`invalid project name: ${project}`);
  }
  if (workflow && !isWorkflowName(workflow)) {
    throw new Error(`invalid workflow: ${workflow} (valid: ${listWorkflows().join(", ")})`);
  }

  // Resolve agent from registry
  const roleMap = { plan: "planner", execute: "executor", verify: "verifier", review: "reviewer", repair: "repairer" };
  const role = roleMap[phase] || "";
  let agent = explicitAgent || "";
  if (!agent) {
    try {
      await loadRegistry();
      if (workflow) {
        try {
          const { normalizeWorkflow, resolveNodeAgent } = await import("../core/workflow/definition.js");
          const dag = normalizeWorkflow(workflow);
          const node = dag.nodes?.find((n) => n.id === phase || n.phase === phase);
          if (node) {
            let poolStatus = null;
            try {
              const { getManagedAcpPool } = await import("../server/services/acp-pool.js");
              const pool = getManagedAcpPool({ cpbRoot: resolvedCpbRoot, hubRoot: undefined });
              const status = await pool.statusAsync();
              poolStatus = status?.pools || null;
            } catch {}
            agent = resolveNodeAgent(node, { poolStatus });
          }
        } catch {}
      }
      if (!agent) {
        agent = defaultAgentForRole(role);
      }
    } catch {
      agent = legacyAgentForPhase(phase);
    }
  }

  // Propagate env
  process.env.CPB_EXECUTOR_ROOT = resolvedExecutorRoot;
  process.env.CPB_ROOT = resolvedCpbRoot;
  if (workflow) process.env.CPB_WORKFLOW = workflow;

  // Permission matrix context for ACP enforcement
  process.env.CPB_ACP_ROLE = role;
  process.env.CPB_ACP_PROJECT = project;
  process.env.CPB_ACP_PHASE = phase;
  const resolvedJobId = process.env.CPB_ACP_JOB_ID || process.env.CPB_JOB_ID || jobId || deliverableId || planId || "";
  if (resolvedJobId) process.env.CPB_ACP_JOB_ID = resolvedJobId;
  process.env.CPB_ACP_CPB_ROOT = resolvedCpbRoot;

  // ACP lane resolution (issue #62)
  const acpProfileOverride = acpProfile || process.env.CPB_ACP_LAUNCH_PROFILE;
  const resolvedUiLaneReason = uiLaneReason || process.env.CPB_ACP_UI_LANE_REASON || "";
  const lane = resolveAcpLane({ profile: acpProfileOverride, uiLane: acpProfileOverride === "ui", uiLaneReason: resolvedUiLaneReason });
  if (lane.error) {
    throw new Error(`ACP lane error: ${lane.error}`);
  }
  process.env.CPB_ACP_LAUNCH_PROFILE = lane.profile;
  process.env.CPB_ACP_UI_LANE = lane.uiLane ? "1" : "0";
  if (lane.uiLaneReason) process.env.CPB_ACP_UI_LANE_REASON = lane.uiLaneReason;

  // Set ACP cwd
  if (!process.env.CPB_ACP_CWD && !process.env.CPB_PROJECT_PATH_OVERRIDE) {
    try {
      const metaFile = path.join(resolvedCpbRoot, "wiki", "projects", project, "project.json");
      const meta = JSON.parse(await readFile(metaFile, "utf8"));
      if (meta.sourcePath) process.env.CPB_ACP_CWD = meta.sourcePath;
    } catch {}
  }

  const options = new Map();
  if (task) options.set("--task", task);
  if (planId) options.set("--plan-id", planId);
  if (deliverableId) options.set("--deliverable-id", deliverableId);
  if (jobId) options.set("--job-id", jobId);
  if (verdictFile) options.set("--verdict-file", verdictFile);
  if (workflow) options.set("--workflow", workflow);
  if (acpProfile) options.set("--acp-profile", acpProfile);
  if (uiLaneReason) options.set("--ui-lane-reason", uiLaneReason);
  if (process.env.CPB_LEGACY_CONTENT === "1") options.set("--legacy-content", "1");

  const parsed = { phase, executorRoot: resolvedExecutorRoot, cpbRoot: resolvedCpbRoot, project, workflow, options };

  switch (phase) {
    case "plan": return await handlePlan(parsed, agent);
    case "execute": return await handleExecute(parsed, agent);
    case "verify": return await handleVerify(parsed, agent);
    case "review": return await handleReview(parsed, agent);
    case "repair": return await handleRepair(parsed, agent);
    default:
      throw new Error(`Unknown phase: ${phase}`);
  }
}

// --- Main (CLI entry) ---

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0) {
    console.error("Usage: node bridges/run-phase.mjs <phase> [options]");
    console.error("Phases: plan, execute, verify, review, repair");
    return 1;
  }

  let parsed;
  try {
    parsed = parseArgs(rawArgs);
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  // Propagate env
  process.env.CPB_EXECUTOR_ROOT = parsed.executorRoot;
  process.env.CPB_ROOT = parsed.cpbRoot;
  if (parsed.workflow) process.env.CPB_WORKFLOW = parsed.workflow;

  // Permission matrix context for ACP enforcement
  const roleMap = { plan: "planner", execute: "executor", verify: "verifier", review: "reviewer", repair: "repairer" };
  process.env.CPB_ACP_ROLE = roleMap[parsed.phase] || "";
  process.env.CPB_ACP_PROJECT = parsed.project;
  process.env.CPB_ACP_PHASE = parsed.phase;
  const jobId = process.env.CPB_ACP_JOB_ID || process.env.CPB_JOB_ID
    || parsed.options.get("--job-id")
    || parsed.options.get("--deliverable-id")
    || parsed.options.get("--plan-id")
    || "";
  if (jobId) process.env.CPB_ACP_JOB_ID = jobId;
  process.env.CPB_ACP_CPB_ROOT = parsed.cpbRoot;

  // Resolve agent from registry
  const role = roleMap[parsed.phase] || "";
  let agent = parsed.agent || "";
  if (!agent) {
    try {
      await loadRegistry();
      if (parsed.workflow) {
        try {
          const { normalizeWorkflow, resolveNodeAgent } = await import("../core/workflow/definition.js");
          const dag = normalizeWorkflow(parsed.workflow);
          const node = dag.nodes?.find((n) => n.id === parsed.phase || n.phase === parsed.phase);
          if (node) {
            let poolStatus = null;
            try {
              const { getManagedAcpPool } = await import("../server/services/acp-pool.js");
              const pool = getManagedAcpPool({ cpbRoot: parsed.cpbRoot, hubRoot: undefined });
              const status = await pool.statusAsync();
              poolStatus = status?.pools || null;
            } catch {}
            agent = resolveNodeAgent(node, { poolStatus });
          }
        } catch {}
      }
      if (!agent) {
        agent = defaultAgentForRole(role);
      }
    } catch {
      agent = legacyAgentForPhase(parsed.phase);
    }
  }

  // ACP lane resolution (issue #62)
  const acpProfileOverride = parsed.options.get("--acp-profile") || process.env.CPB_ACP_LAUNCH_PROFILE;
  const uiLaneReason = parsed.options.get("--ui-lane-reason") || process.env.CPB_ACP_UI_LANE_REASON || "";
  const lane = resolveAcpLane({ profile: acpProfileOverride, uiLane: acpProfileOverride === "ui", uiLaneReason });
  if (lane.error) {
    console.error(`ACP lane error: ${lane.error}`);
    return 1;
  }
  process.env.CPB_ACP_LAUNCH_PROFILE = lane.profile;
  process.env.CPB_ACP_UI_LANE = lane.uiLane ? "1" : "0";
  if (lane.uiLaneReason) process.env.CPB_ACP_UI_LANE_REASON = lane.uiLaneReason;

  // Set ACP cwd
  if (!process.env.CPB_ACP_CWD && !process.env.CPB_PROJECT_PATH_OVERRIDE) {
    try {
      const metaFile = path.join(parsed.cpbRoot, "wiki", "projects", parsed.project, "project.json");
      const meta = JSON.parse(await readFile(metaFile, "utf8"));
      if (meta.sourcePath) process.env.CPB_ACP_CWD = meta.sourcePath;
    } catch {}
  }

  switch (parsed.phase) {
    case "plan": return await handlePlan(parsed, agent);
    case "execute": return await handleExecute(parsed, agent);
    case "verify": return await handleVerify(parsed, agent);
    case "review": return await handleReview(parsed, agent);
    case "repair": return await handleRepair(parsed, agent);
    default:
      console.error(`Unknown phase: ${parsed.phase}`);
      return 1;
  }
}

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

function isDirectRun(metaUrl, argvPath) {
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argvPath);
  } catch {
    return false;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  process.exitCode = await main();
}
