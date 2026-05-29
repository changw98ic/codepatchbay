#!/usr/bin/env node
// run-pipeline.mjs — Full automated pipeline using job-store as single source of truth
// Usage: node bridges/run-pipeline.mjs --project <name> --task "<desc>" [--source-path <repo>] [--max-retries N] [--timeout-min M]

import { access, mkdir, readFile, realpath, stat, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeDataPath, runtimeDataRoot } from "../server/services/runtime-root.js";
import { appendEvent, readEvents } from "../server/services/event-store.js";
import { getProject, resolveHubRoot } from "../server/services/hub-registry.js";
import { buildGithubIssueBranchParts } from "../server/services/branch-names.js";
import { maybeOpenDraftPrAfterPass } from "../server/services/github-pr.js";
import { ensureIndexFresh, parseEnvSnapshot, snapshotForJob } from "../server/services/index-freshness.js";
import { buildRetryInputFromVerdict, parseVerdictEnvelope } from "../core/workflow/verdict.js";
import {
  ROUTING_FEEDBACK_EXIT_CODE,
  buildRoutingFeedbackEvent,
  readDispatchFeedbackFile,
} from "../core/workflow/dispatch-feedback.js";
import {
  blockJob,
  completeJob,
  completePhase,
  createJob,
  cancelJob,
  consumeRedirect,
  FAILURE_CODES,
  failJob,
  getJob,
  recordWorktreeCreated,
} from "../server/services/job-store.js";
import { enqueue as enqueueQueue, listQueue, updateEntry } from "../server/services/hub-queue.js";
import { bridgeForPhase, getWorkflow, isWorkflowName, normalizeWorkflow } from "../core/workflow/definition.js";
import { isRouteDowngrade, normalizeRoute } from "../core/triage/schema.js";
import { executeDag } from "../core/workflow/dag-executor.js";
import { dispatchPhase } from "../server/services/phase-runner.js";
import {
  dispatchEnabled,
  guardSourcePath as guardDispatchSourcePath,
  lookupDispatch,
  markDispatchCompleted,
  markDispatchFailed,
  markDispatchStarted,
  recordDispatch,
} from "../server/services/worker-dispatch.js";
import { buildMeta, executionBoundaryEvent } from "../core/job/meta.js";
import { executorEnv, executorMetadata, resolveExecutorRoot } from "../server/services/executor-root.js";
import { resolveAcpLane } from "../core/acp/policy.js";
import { requiresApproval } from "../core/policy/team-policy.js";
import { requestApprovalGate, timeoutApprovalGate } from "../server/services/approval-gate.js";
import {
  validateNonEmptyMarkdownArtifact,
  validateLightPlanConstraints,
  resolveDeliverableIssue,
  validateIssueMatch,
} from "../server/services/artifact-integrity.js";
import { resolveParentPlan, writeParentPlanCache } from "../server/services/plan-cache.js";

const PLAN_MODES = new Set(["auto", "none", "light", "full", "parent"]);
const TRIAGE_MODES = new Set(["auto", "rules", "acp", "none"]);

// ─── CLI arg parsing ───

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = new Map();

  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (!name.startsWith("--")) {
      throw new Error(`unexpected argument: ${name}`);
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${name}`);
    }
    options.set(name, value);
    i++;
  }

  const project = options.get("--project");
  const task = options.get("--task");

  if (!project || !task) {
    throw new Error("Usage: node bridges/run-pipeline.mjs --project <name> --task \"<desc>\" [--source-path <repo>] [--max-retries N] [--timeout-min M] [--workflow standard|direct|complex|sdd-standard|blocked] [--plan-mode auto|none|light|full|parent] [--triage auto|rules|acp|none]");
  }

  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(project)) {
    throw new Error(`Invalid project name: '${project}' (alphanumeric + hyphens only)`);
  }

  const maxRetries = Math.max(1, parseInt(options.get("--max-retries") || "3", 10) || 3);
  const timeoutMin = Math.max(0, parseInt(options.get("--timeout-min") || "0", 10) || 0);
  const workflow = options.get("--workflow") || "standard";
  if (!isWorkflowName(workflow)) {
    throw new Error(`invalid workflow: ${workflow}`);
  }
  const planMode = options.get("--plan-mode") || process.env.CPB_PLAN_MODE || "auto";
  if (!PLAN_MODES.has(planMode)) {
    throw new Error(`invalid planMode: ${planMode}`);
  }
  const triageMode = options.get("--triage") || null;
  if (triageMode && !TRIAGE_MODES.has(triageMode)) {
    throw new Error(`invalid triage: ${triageMode}`);
  }

  const jobIdOverride = options.get("--job-id") || null;
  const dispatchId = options.get("--dispatch-id") || null;
  const sourcePath = options.get("--source-path") ? path.resolve(options.get("--source-path")) : null;
  const acpProfile = options.get("--acp-profile") || null;
  const uiLaneReason = options.get("--ui-lane-reason") || "";
  const teamPolicyJson = options.get("--team-policy-json") || null;
  const agent = options.get("--agent") || null;
  const model = options.get("--model") || null;

  return { project, task, maxRetries, timeoutMin, workflow, planMode, triageMode, jobIdOverride, dispatchId, sourcePath, acpProfile, uiLaneReason, teamPolicyJson, agent, model };
}

// ─── Logging helpers (compatible with bash version format) ───

const CYAN = "\x1b[0;36m";
const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const YELLOW = "\x1b[1;33m";
const NC = "\x1b[0m";

function tag(project) {
  return `${CYAN}[pipeline:${project}]${NC}`;
}

function log(project, msg) {
  console.log(`${tag(project)} ${msg}`);
}

function ok(msg) {
  console.log(`${GREEN}[PASS]${NC} ${msg}`);
}

function fail(msg) {
  console.log(`${RED}[FAIL]${NC} ${msg}`);
}

function warn(msg) {
  console.log(`${YELLOW}[WARN]${NC} ${msg}`);
}

function failure(reason, { code = FAILURE_CODES.FATAL, phase, cause, retryable } = {}) {
  return {
    reason,
    code,
    phase,
    retryable: retryable ?? code === FAILURE_CODES.RECOVERABLE,
    cause,
  };
}

function buildSourceContext() {
  if (process.env.CPB_SOURCE_CONTEXT_JSON) {
    try {
      const parsed = JSON.parse(process.env.CPB_SOURCE_CONTEXT_JSON);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return {
          ...parsed,
          queueEntryId: parsed.queueEntryId || process.env.CPB_QUEUE_ENTRY_ID || null,
          contextPackPath: parsed.contextPackPath || process.env.CPB_CONTEXT_PACK_PATH || parsed.contextPack?.path || null,
        };
      }
    } catch {}
  }

  const issueNumber = process.env.CPB_ISSUE_NUMBER;
  if (!issueNumber) return null;
  return {
    queueEntryId: process.env.CPB_QUEUE_ENTRY_ID || null,
    issueNumber: parseInt(issueNumber, 10) || null,
    issueUrl: process.env.CPB_ISSUE_URL || null,
    repo: process.env.CPB_ISSUE_REPO || null,
    issueTitle: process.env.CPB_ISSUE_TITLE || null,
    failedQueueId: process.env.CPB_FAILED_QUEUE_ID || null,
    failedJobId: process.env.CPB_FAILED_JOB_ID || null,
    failureArtifact: process.env.CPB_FAILURE_ARTIFACT || null,
    contextPackPath: process.env.CPB_CONTEXT_PACK_PATH || null,
  };
}

async function validateDeliverableIssue(cpbRoot, project, jobId, deliverableId, expectedIssueNumber, srcCtx) {
  if (!expectedIssueNumber || !deliverableId) return null;
  const deliverablePath = path.resolve(
    path.join(cpbRoot, "wiki", "projects", project, "outputs", `deliverable-${deliverableId}.md`)
  );
  let content;
  try {
    content = await readFile(deliverablePath, "utf8");
  } catch {
    return null;
  }
  const artifactIssue = resolveDeliverableIssue(content);
  const result = validateIssueMatch({
    expectedIssueNumber,
    artifactIssueNumber: artifactIssue,
    artifactPath: deliverablePath,
  });
  if (result.match) return null;
  return {
    reason: result.reason,
    expectedIssueNumber,
    actualIssueNumber: artifactIssue,
    deliverable: `deliverable-${deliverableId}`,
    deliverablePath,
    queueEntryId: srcCtx?.queueEntryId ?? null,
    issueUrl: srcCtx?.issueUrl ?? null,
    issueTitle: srcCtx?.issueTitle ?? null,
    repo: srcCtx?.repo ?? null,
    failedQueueId: srcCtx?.failedQueueId ?? null,
    failedJobId: srcCtx?.failedJobId ?? null,
    failureArtifact: srcCtx?.failureArtifact ?? null,
    taskRef: content.split("\n").find((l) => /Task-Ref/i.test(l))?.trim() || null,
  };
}

export async function canonicalSourcePath(sourcePath) {
  const canonical = await realpath(path.resolve(sourcePath));
  const info = await stat(canonical);
  if (!info.isDirectory()) {
    throw new Error(`--source-path is not a directory: ${sourcePath}`);
  }
  return canonical;
}

function printFailureSummary(cpbRoot, project, jobId, { phase, reason, deliverableId, verdictFile }) {
  console.log("");
  console.log(`${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}`);
  console.log(`${RED}  PIPELINE FAILED${NC}`);
  console.log(`${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}`);
  console.log("");
  console.log(`  ${CYAN}Project:${NC}   ${project}`);
  console.log(`  ${CYAN}Job:${NC}       ${jobId}`);
  if (phase) console.log(`  ${CYAN}Phase:${NC}     ${phase}`);
  if (reason) console.log(`  ${CYAN}Reason:${NC}    ${reason}`);
  if (deliverableId) console.log(`  ${CYAN}Deliverable:${NC} deliverable-${deliverableId}`);
  if (verdictFile) {
    try {
      const content = readFileSync(verdictFile, "utf8");
      const envelope = parseVerdictEnvelope(content);
      const mapped = { pass: "PASS", fail: "FAIL", inconclusive: "UNKNOWN", infra_error: "INFRA" };
      console.log(`  ${CYAN}Verdict:${NC}    ${mapped[envelope.status] || "UNKNOWN"}`);
      if (envelope.reason) console.log(`  ${CYAN}Reason:${NC}     ${envelope.reason.slice(0, 120)}`);
      if (envelope.fix_scope?.length) console.log(`  ${CYAN}Fix scope:${NC}  ${envelope.fix_scope.join(", ")}`);
      if (envelope.blocking?.length) {
        const first = envelope.blocking[0];
        const hint = typeof first === "object" ? `${first.criterion}: ${first.evidence}` : first;
        console.log(`  ${CYAN}Blocking:${NC}   ${hint.slice(0, 120)}`);
      }
    } catch {}
  }
  console.log("");
  console.log(`  ${YELLOW}Next steps:${NC}`);
  if (phase === "execute" || phase === "plan") {
    console.log(`    cpb status ${project}          # check current state`);
    console.log(`    cpb review ${project}          # review deliverable`);
  } else if (phase === "verify") {
    console.log(`    cpb review ${project}          # review verdict & diff`);
    console.log(`    cpb execute ${project} <id>    # retry with fixes`);
  } else {
    console.log(`    cpb status ${project}          # check current state`);
    console.log(`    cpb doctor                     # diagnose issues`);
  }
  console.log("");
  console.log(`${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}`);
  console.log("");
}

// ─── Timestamp helper ───

function ts() {
  return new Date().toISOString();
}

// ─── Run a bridge script as child process ───

function killChildProcess(proc) {
  try {
    if (proc.detached && process.platform !== "win32") {
      process.kill(-proc.pid, "SIGTERM");
    } else {
      proc.kill("SIGTERM");
    }
  } catch {
    try { proc.kill("SIGTERM"); } catch {}
  }
  setTimeout(() => {
    try {
      if (proc.detached && process.platform !== "win32") {
        process.kill(-proc.pid, "SIGKILL");
      } else {
        proc.kill("SIGKILL");
      }
    } catch {
      try { proc.kill("SIGKILL"); } catch {}
    }
  }, 2_000).unref?.();
}

function runCommand(command, commandArgs, cwd, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const stdoutChunks = [];
    const detached = Boolean(options.signal) && process.platform !== "win32";

    function finish(result) {
      if (settled) return;
      settled = true;
      if (options.signal && proc) {
        options.signal.removeEventListener("abort", onAbort);
      }
      resolve(result);
    }

    let proc;
    const onAbort = () => {
      if (!settled && proc) {
        killChildProcess(proc);
      }
    };
    try {
      proc = spawn(command, commandArgs, {
        cwd,
        env: options.env || process.env,
        detached,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ exitCode: 1, stdout: "", childPid: null, error: err });
      return;
    }
    proc.detached = detached;
    const childPid = proc.pid || null;
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.stdout.on("data", (chunk) => {
      stdoutChunks.push(chunk);
      process.stdout.write(chunk);
    });
    proc.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
    proc.on("error", (err) => {
      finish({ exitCode: 1, stdout: combineChunks(stdoutChunks), childPid, error: err });
    });
    proc.on("close", (code, signal) => {
      finish({
        exitCode: code ?? 1,
        stdout: combineChunks(stdoutChunks),
        childPid,
        signal,
      });
    });
  });
}

function runCommandCapture(command, commandArgs, cwd, options = {}) {
  return new Promise((resolve) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let proc;
    try {
      proc = spawn(command, commandArgs, {
        cwd,
        env: options.env || process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ exitCode: 1, stdout: "", stderr: "", error: err });
      return;
    }
    proc.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    proc.on("error", (err) => {
      resolve({
        exitCode: 1,
        stdout: combineChunks(stdoutChunks),
        stderr: combineChunks(stderrChunks),
        error: err,
      });
    });
    proc.on("close", (code, signal) => {
      resolve({
        exitCode: code ?? 1,
        stdout: combineChunks(stdoutChunks),
        stderr: combineChunks(stderrChunks),
        signal,
      });
    });
  });
}

function combineChunks(chunks) {
  if (chunks.length === 0) return "";
  return Buffer.concat(chunks).toString("utf8");
}

async function writeIfMissing(filePath, content) {
  try {
    await access(filePath);
  } catch {
    await writeFile(filePath, content, "utf8");
  }
}

async function readJsonObject(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sourcePathRebindAllowed() {
  return process.env.CPB_ALLOW_SOURCEPATH_REBIND === "1";
}

async function canonicalSourcePathOrThrow(sourcePath, label) {
  try {
    return await canonicalSourcePath(sourcePath);
  } catch (err) {
    throw new Error(`${label} sourcePath is invalid: ${err.message}`);
  }
}

async function assertHubProjectBoundary(cpbRoot, project, sourcePath) {
  if (!process.env.CPB_HUB_ROOT) return;

  const hubRoot = resolveHubRoot(cpbRoot);
  const registered = await getProject(hubRoot, project);
  if (!registered?.sourcePath) return;

  const registeredSourcePath = await canonicalSourcePathOrThrow(registered.sourcePath, "registered project");
  if (registeredSourcePath !== sourcePath) {
    throw new Error(
      `project/sourcePath mismatch: project '${project}' is registered to ${registeredSourcePath}, not ${sourcePath}`
    );
  }
}

export async function ensureWikiProjectBoundary(cpbRoot, project, sourcePath) {
  if (!sourcePath) return;
  const wikiDir = path.resolve(cpbRoot, "wiki", "projects", project);
  await mkdir(path.join(wikiDir, "inbox"), { recursive: true });
  await mkdir(path.join(wikiDir, "outputs"), { recursive: true });
  const projectJsonPath = path.join(wikiDir, "project.json");
  const existing = await readJsonObject(projectJsonPath);
  if (existing.sourcePath) {
    let existingSourcePath = null;
    try {
      existingSourcePath = await canonicalSourcePath(existing.sourcePath);
    } catch (err) {
      if (!sourcePathRebindAllowed()) {
        throw new Error(
          `project/sourcePath mismatch: existing project '${project}' sourcePath is invalid (${err.message}); set CPB_ALLOW_SOURCEPATH_REBIND=1 to rebind explicitly`
        );
      }
    }
    if (existingSourcePath && existingSourcePath !== sourcePath && !sourcePathRebindAllowed()) {
      throw new Error(
        `project/sourcePath mismatch: existing project '${project}' is bound to ${existingSourcePath}, not ${sourcePath}`
      );
    }
  }
  await assertHubProjectBoundary(cpbRoot, project, sourcePath);
  await writeFile(
    projectJsonPath,
    `${JSON.stringify({ ...existing, name: existing.name || project, sourcePath }, null, 2)}\n`,
    "utf8",
  );
  await writeIfMissing(
    path.join(wikiDir, "context.md"),
    `# ${project}\n\nSource path: ${sourcePath}\n\nThis project was attached through CPB Hub. Expand this context as the project is onboarded.\n`,
  );
  await writeIfMissing(path.join(wikiDir, "tasks.md"), `# ${project} Tasks\n`);
  await writeIfMissing(path.join(wikiDir, "decisions.md"), `# ${project} Decisions\n`);
  await writeIfMissing(path.join(wikiDir, "log.md"), `# ${project} Log\n`);
}

// ─── ID extraction from bridge stdout ───

function extractPlanId(stdout) {
  const match = stdout.match(/^Plan: .*\/plan-(\d+)\.md$/m);
  return match ? match[1] : null;
}

function extractDeliverableId(stdout) {
  if (!stdout) return null;
  const match = stdout.match(/^Deliverable: .*\/deliverable-(\d+)\.md$/m);
  return match ? match[1] : null;
}

// ─── Verdict parsing and retry input helpers ───

const VERDICT_MAP = { pass: "PASS", fail: "FAIL", inconclusive: "UNKNOWN", infra_error: "INFRA_FAILURE" };

export async function parseVerdictResult(verdictPath) {
  try {
    const content = await readFile(verdictPath, "utf8");
    const envelope = parseVerdictEnvelope(content);
    return {
      verdict: VERDICT_MAP[envelope.status] || "UNKNOWN",
      envelope,
      content,
    };
  } catch {
    return null;
  }
}

export async function parseVerdict(verdictPath) {
  const result = await parseVerdictResult(verdictPath);
  return result?.verdict ?? null;
}

export function buildExecuteScriptArgs({ project, planId, jobId, retryInput } = {}) {
  const args = ["execute", "--project", project];
  if (jobId) args.push("--job-id", jobId);
  if (planId) args.push("--plan-id", planId);
  if (retryInput?.shouldRetry && retryInput.previousVerdictPath) {
    args.push("--verdict-file", retryInput.previousVerdictPath);
  }
  return args;
}

export function resolvePlanDecision(workflowDef, { planMode = "auto", parentPlanResult = null } = {}) {
  if (!workflowDef?.phases?.includes("plan")) {
    return {
      requestedPlanMode: planMode,
      planMode: "none",
      runPlan: false,
      reason: "workflow has no plan phase",
    };
  }

  if (!PLAN_MODES.has(planMode)) {
    throw new Error(`invalid planMode: ${planMode}`);
  }
  const normalized = planMode;
  if (normalized === "none") {
    return {
      requestedPlanMode: "none",
      planMode: "none",
      runPlan: false,
      reason: "planMode=none",
    };
  }

  if (normalized === "parent") {
    if (parentPlanResult?.cacheHit) {
      return {
        requestedPlanMode: "parent",
        planMode: "parent",
        runPlan: false,
        planId: parentPlanResult.parentPlanId || parentPlanResult.planId,
        parentJobId: parentPlanResult.parentJobId,
        reason: parentPlanResult.source ? `reused from ${parentPlanResult.source}` : "parent plan reuse",
      };
    }
    return {
      requestedPlanMode: "parent",
      planMode: "full",
      runPlan: true,
      reason: "parent plan not found, fallback to full",
    };
  }

  const effective = normalized === "auto" ? "full" : normalized;
  return {
    requestedPlanMode: normalized,
    planMode: effective,
    runPlan: true,
    reason: "plan phase enabled",
  };
}

function retryInputEventFields(retryInput) {
  if (!retryInput?.shouldRetry) return {};
  return {
    retryCount: retryInput.retryCount,
    previousVerdictId: retryInput.previousVerdictId,
    previousVerdictPath: retryInput.previousVerdictPath,
    failingChecks: retryInput.failingChecks,
    repairScope: retryInput.repairScope,
    retryPrompt: retryInput.prompt,
  };
}

async function parseReviewVerdict(reviewPath) {
  try {
    const content = await readFile(reviewPath, "utf8");
    const lines = content.split(/\r?\n/).slice(0, 20);
    for (const line of lines) {
      const structured = line.match(/^REVIEW:\s*(PASS|FAIL)\b/i);
      if (structured) return structured[1].toUpperCase();
    }
    for (const line of lines) {
      const inline = line.match(/\bREVIEW:\s*(PASS|FAIL)\b/i);
      if (inline) return inline[1].toUpperCase();
    }
    return "UNKNOWN";
  } catch {
    return null;
  }
}

// ─── Phase execution ───

function envDisablesWorktree() {
  const value = process.env.CPB_USE_WORKTREE;
  return typeof value === "string" && ["0", "false", "off", "no"].includes(value.toLowerCase());
}

function projectDisablesWorktree(projectConfig) {
  return projectConfig?.policy?.useWorktree === false
    || projectConfig?.worktree?.enabled === false
    || projectConfig?.worktreeMode === "off";
}

async function currentBaseBranch(sourcePath) {
  const branch = await runCommandCapture("git", ["-C", sourcePath, "symbolic-ref", "--short", "HEAD"], sourcePath);
  if (branch.exitCode === 0 && branch.stdout.trim()) return branch.stdout.trim();

  const head = await runCommandCapture("git", ["-C", sourcePath, "rev-parse", "--short", "HEAD"], sourcePath);
  if (head.exitCode === 0 && head.stdout.trim()) return `detached:${head.stdout.trim()}`;
  return null;
}

async function maybeCreateWorktree(cpbRoot, executorRoot, project, jobId, wikiDir, sourcePathOverride = null, sourceContext = null) {
  const projectJsonPath = path.join(wikiDir, "project.json");
  const projectConfig = await readJsonObject(projectJsonPath);
  if (envDisablesWorktree() || projectDisablesWorktree(projectConfig)) {
    return null;
  }

  let sourcePath = sourcePathOverride || process.env.CPB_PROJECT_PATH_OVERRIDE || null;
  if (!sourcePath) {
    sourcePath = projectConfig.sourcePath || null;
  }
  if (!sourcePath) return null;

  const baseBranch = await currentBaseBranch(sourcePath);
  const worktreesRoot = path.join(process.env.CPB_PROJECT_RUNTIME_ROOT || runtimeDataRoot(cpbRoot), "worktrees");
  const issueBranch = sourceContext?.issueNumber
    ? buildGithubIssueBranchParts({
      issueNumber: sourceContext.issueNumber,
      title: sourceContext.issueTitle || sourceContext.title || jobId,
      jobId,
    })
    : null;
  const result = await runCommand(
    process.execPath,
    [
      path.join(executorRoot, "runtime", "git", "worktree.js"),
      "create",
      "--project",
      sourcePath,
      "--job-id",
      issueBranch?.jobComponent || jobId,
      "--slug",
      issueBranch?.slug || "pipeline",
      "--worktrees-root",
      worktreesRoot,
    ],
    cpbRoot,
    { env: executorEnv(process.env, { cpbRoot, executorRoot }) }
  );
  if (result.exitCode !== 0) {
    throw result.error || new Error("worktree creation failed");
  }

  const created = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  process.env.CPB_PROJECT_PATH_OVERRIDE = created.path;
  process.env.CPB_ACP_CWD = created.path;
  await recordWorktreeCreated(cpbRoot, project, jobId, {
    worktree: created.path,
    branch: created.branch,
    baseBranch,
  });
  return { ...created, baseBranch };
}

async function checkCancelAndRedirect(cpbRoot, project, jobId, phase) {
  const job = await getJob(cpbRoot, project, jobId);
  if (job.cancelRequested) {
    await cancelJob(cpbRoot, project, jobId, { reason: job.cancelReason ?? `cancelled before ${phase}` });
    fail(`Cancelled before ${phase}`);
    return { cancelled: true, redirect: null };
  }
  let redirect = null;
  if (job.redirectEventId && !job.consumedRedirectIds.includes(job.redirectEventId)) {
    redirect = { instructions: job.redirectContext, reason: job.redirectReason, eventId: job.redirectEventId };
  }
  return { cancelled: false, redirect };
}

function parseTeamPolicyInput(teamPolicy, teamPolicyJson) {
  if (teamPolicy && typeof teamPolicy === "object") return teamPolicy;
  const raw = teamPolicyJson || process.env.CPB_TEAM_POLICY_JSON || "";
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid team policy JSON: ${error.message}`);
  }
}

function approvalOperationForPhase(phase) {
  if (phase === "PR") return "PR";
  if (phase === "execute" || String(phase || "").startsWith("fix-") || String(phase || "").startsWith("execute-")) return "write";
  if (phase === "review") return "write";
  if (phase === "verify") return "shell";
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TRANSIENT_ERROR_PATTERNS = ["rate limit", "429", "too many requests", "capacity", "overloaded"];

async function classifyTransientFailure(cpbRoot, project, jobId, phase) {
  try {
    const events = await readEvents(cpbRoot, project, jobId);
    const errorEvent = events.find(e => e.type === "phase_agent_error" && e.phase === phase);
    if (errorEvent) {
      const msg = (errorEvent.error || "").toLowerCase();
      if (TRANSIENT_ERROR_PATTERNS.some(p => msg.includes(p))) {
        return { code: FAILURE_CODES.RECOVERABLE, cause: { message: errorEvent.error } };
      }
    }
  } catch { /* fall through to FATAL */ }
  return { code: FAILURE_CODES.FATAL };
}

async function hasApprovalAfter(cpbRoot, project, jobId, requestedAt) {
  const requestedMs = new Date(requestedAt).getTime();
  const events = await readEvents(cpbRoot, project, jobId);
  return events.some((event) => {
    if (event.type !== "job_approved") return false;
    const approvedMs = new Date(event.ts || 0).getTime();
    return Number.isFinite(approvedMs) && approvedMs >= requestedMs;
  });
}

// ─── Exported API (for Node.js CLI consumption) ───

export async function runPipeline({
  project,
  task,
  maxRetries = 3,
  timeoutMin = 0,
  workflow = "standard",
  planMode = "auto",
  triageMode = null,
  jobIdOverride = null,
  dispatchId: providedDispatchId = null,
  acpProfile = null,
  uiLaneReason = "",
  sourcePath: rawSourcePath = null,
  executorRoot: providedExecutorRoot = null,
  cpbRoot: providedCpbRoot = null,
  teamPolicy = null,
  teamPolicyJson = null,
  agent: cliAgent = null,
  model = null,
  modelEnv = null,
  approvalPollMs = Number(process.env.CPB_APPROVAL_POLL_MS || 2_000),
  approvalTimeoutMs = Number(process.env.CPB_APPROVAL_TIMEOUT_MS || 30 * 60_000),
} = {}) {
  const defaultExecutorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const executorRoot = resolveExecutorRoot({ fallbackRoot: providedExecutorRoot || defaultExecutorRoot });
  const cpbRoot = path.resolve(providedCpbRoot || process.env.CPB_ROOT || defaultExecutorRoot);
  process.env.CPB_ROOT = cpbRoot;
  process.env.CPB_EXECUTOR_ROOT = executorRoot;
  process.env.CPB_WORKFLOW = workflow;
  if (triageMode) process.env.CPB_TRIAGE_MODE = triageMode;

  // ACP lane resolution (issue #62)
  const lane = resolveAcpLane({ profile: acpProfile || process.env.CPB_ACP_LAUNCH_PROFILE, uiLane: acpProfile === "ui", uiLaneReason });
  if (lane.error) {
    throw new Error(`ACP lane error: ${lane.error}`);
  }
  process.env.CPB_ACP_LAUNCH_PROFILE = lane.profile;
  process.env.CPB_ACP_UI_LANE = lane.uiLane ? "1" : "0";
  if (lane.uiLaneReason) process.env.CPB_ACP_UI_LANE_REASON = lane.uiLaneReason;

  let sourcePath = rawSourcePath;
  if (sourcePath) {
    sourcePath = await canonicalSourcePath(sourcePath);
    process.env.CPB_PROJECT_PATH_OVERRIDE = sourcePath;
    process.env.CPB_ACP_CWD = sourcePath;
    await ensureWikiProjectBoundary(cpbRoot, project, sourcePath);
  }

  const hubRoot = process.env.CPB_HUB_ROOT ? resolveHubRoot(cpbRoot) : null;
  let dispatchId = providedDispatchId || null;

  if (dispatchEnabled() && hubRoot && sourcePath) {
    await guardDispatchSourcePath(hubRoot, project, sourcePath);
    if (!dispatchId) {
      const dispatch = await recordDispatch(hubRoot, { projectId: project, sourcePath, sessionId: process.env.CPB_SESSION_ID || null, workerId: process.env.CPB_WORKER_ID || null });
      dispatchId = dispatch ? dispatch.dispatchId : null;
    }
    if (dispatchId) {
      await markDispatchStarted(hubRoot, dispatchId).catch(() => {});
    }
  }

  async function markDispatchDone(ok) {
    if (!dispatchEnabled() || !hubRoot || !dispatchId) return;
    const fn = ok ? markDispatchCompleted : markDispatchFailed;
    await fn(hubRoot, dispatchId).catch(() => {});
  }

  async function enqueueRoutingUpgrade(feedback, phaseName) {
    const sourceQueueEntryId = sourceContext?.queueEntryId || process.env.CPB_QUEUE_ENTRY_ID || null;
    if (!hubRoot || !sourceQueueEntryId) return null;
    const currentRoute = normalizeRoute({
      workflow,
      planMode: planDecision.planMode,
      source: "current_job",
      reason: "current job route",
    });
    const feedbackRoute = normalizeRoute({
      ...feedback.requested,
      source: "executor_feedback",
      reason: feedback.reason,
    }, currentRoute);
    if (isRouteDowngrade(feedbackRoute, currentRoute)) {
      throw new Error(`executor routing feedback cannot downgrade ${currentRoute.workflow}/${currentRoute.planMode} to ${feedbackRoute.workflow}/${feedbackRoute.planMode}`);
    }
    if (
      feedbackRoute.workflow === currentRoute.workflow
      && feedbackRoute.planMode === currentRoute.planMode
      && feedbackRoute.reviewer === currentRoute.reviewer
    ) {
      throw new Error(`executor routing feedback must request a stronger route than ${currentRoute.workflow}/${currentRoute.planMode}`);
    }

    const existingEntries = await listQueue(hubRoot, { projectId: project }).catch(() => []);
    const sourceEntry = existingEntries.find((entry) => entry.id === sourceQueueEntryId) || null;
    const metadata = {
      ...(sourceEntry?.metadata || {}),
      workflow: feedback.requested.workflow,
      planMode: feedback.requested.planMode,
      requestedRoute: feedback.requested,
      routingFeedback: {
        jobId,
        phase: phaseName,
        reason: feedback.reason,
        confidence: feedback.confidence,
        signals: feedback.signals,
      },
      originQueueId: sourceQueueEntryId,
      originJobId: jobId,
      queueDedupeKey: `${sourceEntry?.metadata?.queueDedupeKey || sourceQueueEntryId}:routing-feedback:${jobId}`,
      supersedesQueueEntryId: sourceQueueEntryId,
    };
    const upgraded = await enqueueQueue(hubRoot, {
      projectId: sourceEntry?.projectId || project,
      sourcePath: sourceEntry?.sourcePath || sourcePath,
      sessionId: sourceEntry?.sessionId || process.env.CPB_SESSION_ID || null,
      workerId: null,
      cwd: sourceEntry?.cwd || null,
      executionBoundary: sourceEntry?.executionBoundary || null,
      type: "routing_upgrade",
      priority: sourceEntry?.priority || "P1",
      description: sourceEntry?.description || task,
      metadata,
    });

    await updateEntry(hubRoot, sourceQueueEntryId, {
      metadata: {
        finalDisposition: "superseded.routing_feedback",
        supersededByQueueEntryId: upgraded.id,
        supersededByJobId: jobId,
      },
    }).catch(() => {});
    return upgraded;
  }

  const workflowDef = getWorkflow(workflow);
  let pipelineOk = false;
  const effectiveTeamPolicy = parseTeamPolicyInput(teamPolicy, teamPolicyJson);
  const phaseTotal = workflowDef.phases.length || 0;
  const phaseIndex = (phase) => {
    const idx = workflowDef.phases.indexOf(phase);
    return idx >= 0 ? idx + 1 : "?";
  };

  // Timeout support: set a flag via setTimeout
  let timedOut = false;
  let watchdogTimer = null;

  if (timeoutMin > 0) {
    watchdogTimer = setTimeout(() => {
      timedOut = true;
      fail(`Total timeout (${timeoutMin} min) exceeded`);
    }, timeoutMin * 60_000);
    watchdogTimer.unref?.();
  }

  function checkTimeout() {
    if (timedOut) {
      fail(`Timed out.`);
      return true;
    }
    return false;
  }

  // Resolve index snapshot from worker env or direct project lookup
  let jobIndexSnapshot = null;
  let jobIndexFreshness = null;
  let snapshotFromEnv = false;

  const cpbIndexSnapshotRaw = process.env.CPB_INDEX_SNAPSHOT_JSON;
  if (cpbIndexSnapshotRaw) {
    const envSnapshot = parseEnvSnapshot(cpbIndexSnapshotRaw);
    if (envSnapshot) {
      jobIndexSnapshot = envSnapshot.indexSnapshot;
      jobIndexFreshness = envSnapshot.indexFreshness;
      snapshotFromEnv = true;
    }
  }

  if (!jobIndexSnapshot && hubRoot) {
    const registered = await getProject(hubRoot, project);
    if (registered?.sourcePath && registered.projectRuntimeRoot) {
      const fresh = await ensureIndexFresh(registered);
      const snap = snapshotForJob(fresh);
      if (snap.indexSnapshotId) {
        jobIndexSnapshot = { indexSnapshotId: snap.indexSnapshotId, sourceFingerprint: snap.sourceFingerprint };
        jobIndexFreshness = snap.indexFreshness;
      } else {
        jobIndexSnapshot = null;
        jobIndexFreshness = snap.indexFreshness;
      }
    } else if (registered) {
      // Project registered but missing runtime root — index unavailable
      jobIndexFreshness = {
        available: false,
        indexDirty: true,
        indexStale: false,
        worktreeDirty: false,
        dirtyReasons: ["missing_source_or_runtime_root"],
      };
    }
    // If project not registered in hub, skip freshness check (unmanaged project)
  }

  // Create job
  const baseSourceContext = buildSourceContext();
  const sourceContext = triageMode
    ? {
        ...(baseSourceContext || { type: "cli" }),
        triageMode,
      }
    : baseSourceContext;
  let parentPlanResult = null;
  if (planMode === "parent") {
    parentPlanResult = await resolveParentPlan(cpbRoot, { project, task, sourceContext, dataRoot });
  }
  const planDecision = resolvePlanDecision(workflowDef, { planMode, parentPlanResult });
  process.env.CPB_PLAN_MODE = planDecision.planMode;
  const parentPlanCache = planDecision.requestedPlanMode === "parent" ? parentPlanResult : null;
  if (parentPlanCache) {
    process.env.CPB_PARENT_PLAN_CACHE_JSON = JSON.stringify(parentPlanCache);
  } else {
    delete process.env.CPB_PARENT_PLAN_CACHE_JSON;
  }
  const jobSourceContext = parentPlanCache
    ? {
        ...(sourceContext || {}),
        parentPlan: parentPlanCache,
        parentPlanId: parentPlanCache.parentPlanId || parentPlanCache.reusedPlanId || null,
      }
    : sourceContext;
  const job = await createJob(cpbRoot, {
    project,
    task,
    workflow,
    planMode: planDecision.planMode,
    jobId: jobIdOverride,
    executor: await executorMetadata(executorRoot, { codeVersion: process.env.CPB_VERSION }),
    sourceContext: jobSourceContext,
    queueEntryId: sourceContext?.queueEntryId || process.env.CPB_QUEUE_ENTRY_ID || null,
    indexSnapshot: jobIndexSnapshot,
    indexFreshness: jobIndexFreshness,
    planCache: parentPlanCache,
    teamPolicy: effectiveTeamPolicy,
  });
  const jobId = job.jobId;
  await appendEvent(cpbRoot, project, jobId, {
    type: "plan_decision",
    jobId,
    project,
    workflow,
    planMode: planDecision.planMode,
    runPlan: planDecision.runPlan,
    reason: planDecision.reason,
    parentPlanCache,
    planGroupId: parentPlanCache?.planGroupId || null,
    planCacheKey: parentPlanCache?.planCacheKey || null,
    cacheHit: parentPlanCache?.cacheHit ?? null,
    parentPlanId: parentPlanCache?.parentPlanId || parentPlanCache?.reusedPlanId || null,
    ts: ts(),
  });
  if (parentPlanCache) {
    await appendEvent(cpbRoot, project, jobId, {
      type: "plan_cache_decision",
      jobId,
      project,
      ...parentPlanCache,
      action: parentPlanCache.cacheHit ? "reuse" : "miss",
      ts: ts(),
    });
  }

  // Structured line for project-worker to parse and write back jobId to queue entry
  const queueEntryId = process.env.CPB_QUEUE_ENTRY_ID || null;
  if (queueEntryId) {
    process.stdout.write(`CPB_JOB_CREATED ${JSON.stringify({ jobId, queueEntryId })}\n`);
  }

  async function waitForApprovalIfRequired({ nodeId, phase }) {
    const operation = approvalOperationForPhase(phase);
    if (!operation || !requiresApproval(effectiveTeamPolicy, operation)) return { ok: true };

    const requestedAt = ts();
    await requestApprovalGate(cpbRoot, project, jobId, {
      operation,
      phase,
      channels: effectiveTeamPolicy?.approvals?.[operation]?.channels || [],
      reason: `${operation} approval required before ${phase}`,
      timeoutAt: new Date(Date.now() + approvalTimeoutMs).toISOString(),
      ts: requestedAt,
    });
    await appendEvent(cpbRoot, project, jobId, {
      type: "dag_node_blocked",
      jobId,
      project,
      nodeId,
      phase,
      reason: `${operation} approval required`,
      ts: requestedAt,
    });
    warn(`Waiting for ${operation} approval before ${phase}...`);

    const deadline = Date.now() + approvalTimeoutMs;
    while (Date.now() < deadline) {
      if (await hasApprovalAfter(cpbRoot, project, jobId, requestedAt)) {
        ok(`Approval received for ${phase}`);
        return { ok: true };
      }
      const current = await getJob(cpbRoot, project, jobId);
      if (current.cancelRequested || current.status === "cancelled") {
        return { ok: false, reason: "cancelled while waiting for approval", cancelled: true };
      }
      await sleep(Math.max(100, approvalPollMs));
    }

    await timeoutApprovalGate(cpbRoot, project, jobId, {
      reason: `${operation} approval timed out before ${phase}`,
    });
    return { ok: false, reason: `${operation} approval timed out before ${phase}`, approvalTimedOut: true };
  }

  // Block job when index is unavailable for a direct start (no worker snapshot).
  // Blocked workflow skips this gate — it doesn't execute code.
  if (workflow !== "blocked" && !jobIndexSnapshot && !snapshotFromEnv && hubRoot && jobIndexFreshness && !jobIndexFreshness.available) {
    const { blockJob } = await import("../server/services/job-store.js");
    await blockJob(cpbRoot, project, jobId, { reason: `index_unavailable: direct start blocked — index refresh failed` });
    fail(`Index unavailable for direct start, job ${jobId} blocked`);
    await markDispatchDone(false);
    return 1;
  }

  const meta = buildMeta({
    sourcePath,
    sessionId: process.env.CPB_SESSION_ID || null,
    workerId: process.env.CPB_WORKER_ID || null,
  });

  if (meta.sourcePath) {
    await appendEvent(cpbRoot, project, jobId, executionBoundaryEvent(meta, { jobId, project, ts: ts() }));
  }

  const wikiDir = path.resolve(cpbRoot, "wiki", "projects", project);

  // ─── Agent resolution: CLI --agent > project.json agents > registry default ───
  const projectConfig = await readJsonObject(path.join(wikiDir, "project.json"));
  const projectAgents = projectConfig.agents || null;

  async function resolvePhaseAgent(phase) {
    if (cliAgent) return cliAgent;
    if (projectAgents) {
      const phased = projectAgents.phases?.[phase];
      if (phased) return phased;
      if (projectAgents.default) return projectAgents.default;
    }
    try {
      const { loadRegistry, defaultAgentForRole } = await import("../core/agents/registry.js");
      await loadRegistry();
      const roleMap = { plan: "planner", execute: "executor", verify: "verifier", review: "reviewer", repair: "repairer" };
      return defaultAgentForRole(roleMap[phase] || phase);
    } catch {
      const { legacyAgentForPhase } = await import("../core/agents/registry.js");
      return legacyAgentForPhase(phase);
    }
  }

  async function agentLabelFor(phase) {
    const name = await resolvePhaseAgent(phase);
    try {
      const { loadRegistry, getDescriptor } = await import("../core/agents/registry.js");
      await loadRegistry();
      return getDescriptor(name)?.displayName || name;
    } catch {
      return name;
    }
  }

  await maybeCreateWorktree(cpbRoot, executorRoot, project, jobId, wikiDir, sourcePath, jobSourceContext);
  log(project, `Job ${jobId} started (max ${maxRetries} retries${timeoutMin > 0 ? `, ${timeoutMin}min timeout` : ""}, workflow: ${workflow}, planMode: ${planDecision.planMode})`);

  // Blocked workflow: record and exit without launching agents
  if (workflow === "blocked") {
    await appendEvent(cpbRoot, project, jobId, {
      type: "workflow_selected",
      jobId,
      project,
      workflow,
      default: false,
      reason: "blocked by operator",
      ts: ts(),
    });
    const { blockJob } = await import("../server/services/job-store.js");
    await blockJob(cpbRoot, project, jobId, { reason: "blocked by operator" });
    log(project, `Job ${jobId} blocked. No agents launched.`);
    pipelineOk = true;
    await markDispatchDone(true);
    return 0;
  }

  // Record workflow selection for standard
  if (workflow !== "standard") {
    await appendEvent(cpbRoot, project, jobId, {
      type: "workflow_selected",
      jobId,
      project,
      workflow,
      default: false,
      ts: ts(),
    });
  }

  try {
    let planId = null;
    if (parentPlanCache?.cacheHit && parentPlanCache.reusedPlanId) {
      planId = parentPlanCache.reusedPlanId;
      log(project, `Reusing parent plan ${parentPlanCache.reusedPlanArtifact || `plan-${planId}`} (cache ${parentPlanCache.planCacheKey})`);
      await completePhase(cpbRoot, project, jobId, { phase: "plan", artifact: parentPlanCache.reusedPlanArtifact || `plan-${planId}` });
    }

    if (planDecision.runPlan && !planId) {
      // ─── Phase 1: Plan ───
      {
        const check = await checkCancelAndRedirect(cpbRoot, project, jobId, "plan");
        if (check.cancelled) {
          await failJob(cpbRoot, project, jobId, failure("cancelled before plan", { code: FAILURE_CODES.BLOCKED, phase: "plan" }));
          return 1;
        }
      }
      const planAgentLabel = await agentLabelFor("plan");
      log(project, `Phase ${phaseIndex("plan")}/${phaseTotal}: Plan (${planAgentLabel})`);
      const planAgent = await resolvePhaseAgent("plan");
      const planAgentEnv = planAgent ? { CPB_OVERRIDE_AGENT: planAgent } : {};
      let planModelEnv = {};
      const planProfileName = projectAgents?.phaseProfiles?.plan;
      if (planProfileName) {
        const { resolveModelProfileEnv } = await import("../cli/commands/model-profile.js");
        planModelEnv = await resolveModelProfileEnv(cpbRoot, planProfileName);
        if (Object.keys(planModelEnv).length > 0) {
          log(project, `Phase plan: using model profile '${planProfileName}'`);
        }
      }
      const planResult = await dispatchPhase(cpbRoot, {
        project, jobId, phase: "plan",
        script: `bridges/${bridgeForPhase(workflowDef, "plan")}`,
        scriptArgs: ["plan", "--project", project, "--task", task],
        executorRoot,
        env: { ...executorEnv(process.env, { cpbRoot, executorRoot }), ...planAgentEnv, ...planModelEnv },
        terminalOnFailure: false,
      });

      if (planResult.error) {
        fail(`Plan spawn failed: ${planResult.error.message}`);
        await failJob(cpbRoot, project, jobId, failure(`plan spawn error: ${planResult.error.message}`, {
          code: FAILURE_CODES.RECOVERABLE,
          phase: "plan",
          cause: { message: planResult.error.message },
        }));
        return 1;
      }

      if (checkTimeout()) {
        await failJob(cpbRoot, project, jobId, failure("timed out after plan phase", {
          code: FAILURE_CODES.RECOVERABLE,
          phase: "plan",
        }));
        return 1;
      }

      planId = extractPlanId(planResult.stdout);

      if (!planId) {
        fail("Plan not created. Aborting.");
        await completePhase(cpbRoot, project, jobId, { phase: "plan", artifact: "" });
        const planClass = await classifyTransientFailure(cpbRoot, project, jobId, "plan");
        await failJob(cpbRoot, project, jobId, failure("plan not created", {
          code: planClass.code,
          phase: "plan",
          ...(planClass.cause ? { cause: planClass.cause } : {}),
        }));
        return 1;
      }

      // Validate plan artifact is non-empty before proceeding to execute
      const planArtifactPath = path.resolve(wikiDir, "inbox", `plan-${planId}.md`);
      const planValidation = await validateNonEmptyMarkdownArtifact({
        path: planArtifactPath,
        kind: "plan",
        id: planId,
      });

      if (!planValidation.valid) {
        fail(`Plan artifact invalid: ${planValidation.reason}`);
        await completePhase(cpbRoot, project, jobId, { phase: "plan", artifact: `plan-${planId}` });
        const planFailCause = {
          artifact: `plan-${planId}`,
          artifactPath: planArtifactPath,
          artifactReason: planValidation.reason,
        };
        if (sourceContext) {
          planFailCause.queueEntryId = sourceContext.queueEntryId;
          planFailCause.issueNumber = sourceContext.issueNumber;
          planFailCause.issueUrl = sourceContext.issueUrl;
          planFailCause.failedQueueId = sourceContext.failedQueueId;
          planFailCause.failedJobId = sourceContext.failedJobId;
        }
        await failJob(cpbRoot, project, jobId, failure(
          `plan artifact ${planValidation.reason}: plan-${planId}`,
          {
            code: FAILURE_CODES.PLAN_ARTIFACT_INVALID,
            phase: "plan",
            cause: planFailCause,
          },
        ));
        return 1;
      }

      if (planDecision.planMode === "light" && planValidation.content) {
        const lightCheck = validateLightPlanConstraints({
          content: planValidation.content,
          path: planArtifactPath,
          id: planId,
        });
        if (!lightCheck.valid) {
          const detail = lightCheck.reasons.join("; ");
          await appendEvent(cpbRoot, project, jobId, {
            type: "light_plan_constraint_violation",
            jobId,
            project,
            planId,
            reasons: lightCheck.reasons,
            strict: process.env.CPB_LIGHT_PLAN_STRICT === "1",
            ts: ts(),
          });
          if (process.env.CPB_LIGHT_PLAN_STRICT === "1") {
            fail(`Light plan constraint violations (strict): ${detail}`);
            await failJob(cpbRoot, project, jobId, failure(`light plan constraints violated: ${detail}`, {
              code: FAILURE_CODES.RECOVERABLE,
              phase: "plan",
              cause: { planId, reasons: lightCheck.reasons },
            }));
            return 1;
          }
          warn(`Light plan constraint violations: ${detail}`);
        }
      }

      ok(`plan-${planId}`);
      await completePhase(cpbRoot, project, jobId, { phase: "plan", artifact: `plan-${planId}` });
      if (parentPlanCache) {
        parentPlanCache = await writeParentPlanCache(cpbRoot, {
          ...parentPlanCache,
          project,
          task,
          sourceContext,
          planId,
          planArtifact: `plan-${planId}`,
        });
        await appendEvent(cpbRoot, project, jobId, {
          type: "plan_cache_updated",
          jobId,
          project,
          ...parentPlanCache,
          ts: ts(),
        });
      }

      // Cancel check after plan
      {
        const check = await checkCancelAndRedirect(cpbRoot, project, jobId, "execute");
        if (check.cancelled) {
          await failJob(cpbRoot, project, jobId, failure("cancelled after plan", { code: FAILURE_CODES.BLOCKED, phase: "execute" }));
          return 1;
        }
      }
    } else if (!planDecision.runPlan) {
      log(project, `Skipping Plan phase (${planDecision.reason}, planMode: ${planDecision.planMode})`);
      if (planDecision.planId) {
        planId = planDecision.planId;
        await appendEvent(cpbRoot, project, jobId, {
          type: "parent_plan_reused",
          jobId,
          project,
          parentJobId: planDecision.parentJobId || null,
          planId: planDecision.planId,
          reason: planDecision.reason,
          ts: ts(),
        });
      }
      const check = await checkCancelAndRedirect(cpbRoot, project, jobId, "execute");
      if (check.cancelled) {
        await failJob(cpbRoot, project, jobId, failure("cancelled before execute", { code: FAILURE_CODES.BLOCKED, phase: "execute" }));
        return 1;
      }
    } else {
      const check = await checkCancelAndRedirect(cpbRoot, project, jobId, "execute");
      if (check.cancelled) {
        await failJob(cpbRoot, project, jobId, failure("cancelled before execute", { code: FAILURE_CODES.BLOCKED, phase: "execute" }));
        return 1;
      }
    }

    // ─── DAG-driven phase execution: execute → review? → verify ───
    const dag = normalizeWorkflow(workflow);
    for (const n of dag.nodes) {
      if (n.phase === "plan") n.maxRetries = 1;
      else n.maxRetries = maxRetries;
    }

    const pState = { deliverableId: null, fixCount: 0, reviewAttempt: 0, verifyAttempt: 0, retryInput: null };

    async function checkIssue(did, phaseName) {
      const mismatch = await validateDeliverableIssue(cpbRoot, project, jobId, did, sourceContext?.issueNumber, sourceContext);
      if (!mismatch) return null;
      fail(`Issue mismatch: expected #${mismatch.expectedIssueNumber}, got #${mismatch.actualIssueNumber}`);
      await completePhase(cpbRoot, project, jobId, { phase: phaseName, artifact: `deliverable-${did}` });
      return mismatch;
    }

    async function dispatchRun(scriptPhase, bridgePhase, scriptArgs, envOverrides = {}) {
      const resolvedAgent = await resolvePhaseAgent(bridgePhase);
      const agentEnv = resolvedAgent ? { CPB_OVERRIDE_AGENT: resolvedAgent } : {};
      const mEnv = modelEnv && typeof modelEnv === "object" ? modelEnv : {};
      // Resolve per-phase model profile (overrides global modelEnv)
      let phaseModelEnv = {};
      const phaseProfileName = projectAgents?.phaseProfiles?.[bridgePhase];
      if (phaseProfileName) {
        const { resolveModelProfileEnv } = await import("../cli/commands/model-profile.js");
        phaseModelEnv = await resolveModelProfileEnv(cpbRoot, phaseProfileName);
        if (Object.keys(phaseModelEnv).length > 0) {
          log(project, `Phase ${bridgePhase}: using model profile '${phaseProfileName}'`);
        }
      }
      return dispatchPhase(cpbRoot, {
        project, jobId, phase: scriptPhase,
        script: `bridges/${bridgeForPhase(workflowDef, bridgePhase)}`,
        scriptArgs,
        executorRoot,
        env: { ...executorEnv(process.env, { cpbRoot, executorRoot }), ...agentEnv, ...mEnv, ...phaseModelEnv, ...envOverrides },
        terminalOnFailure: false,
      });
    }

    async function appendDagNodeEvent(type, nodeId, node, ctx = {}, extra = {}) {
      const event = {
        type,
        jobId,
        project,
        nodeId,
        ts: ts(),
        ...extra,
      };
      if (node?.phase !== undefined) event.phase = node.phase;
      if (ctx?.attempt !== undefined) event.attempt = ctx.attempt;
      await appendEvent(cpbRoot, project, jobId, event);
    }

    const dagResult = await executeDag(dag, {
      seedCompleted: dag.nodes.some((node) => node.id === "plan") ? ["plan"] : [],
      shouldStop: () => timedOut,
      onBeforeNode: async (nodeId, ctx) => {
        const dagNode = ctx?.node ?? dag.nodes.find((n) => n.id === nodeId);
        await appendDagNodeEvent("dag_node_started", nodeId, dagNode, ctx);

        if (nodeId === "plan") return true;
        const check = await checkCancelAndRedirect(cpbRoot, project, jobId, nodeId);
        if (check.cancelled) {
          await appendDagNodeEvent("dag_node_cancelled", nodeId, dagNode, ctx, {
            reason: `cancelled before ${nodeId}`,
          });
          await failJob(cpbRoot, project, jobId, failure(`cancelled before ${nodeId}`, { code: FAILURE_CODES.BLOCKED, phase: nodeId }));
          return false;
        }
        const approval = await waitForApprovalIfRequired({
          nodeId,
          phase: dagNode?.phase || nodeId,
        });
        if (!approval.ok) {
          if (!approval.approvalTimedOut) {
            await appendDagNodeEvent("dag_node_cancelled", nodeId, dagNode, ctx, {
              reason: approval.reason,
            });
          }
          return false;
        }
        return true;
      },
      onNodeResult: async (nodeId, result, ctx) => {
        const dagNode = ctx?.node ?? dag.nodes.find((n) => n.id === nodeId);

        if (result.ok) {
          await appendDagNodeEvent("dag_node_completed", nodeId, dagNode, ctx);
        } else if (result.retryable) {
          await appendDagNodeEvent("dag_node_retrying", nodeId, dagNode, {
            ...ctx,
            attempt: Math.min((ctx?.attempt ?? 0) + 1, ctx?.maxAttempts ?? ((ctx?.attempt ?? 0) + 1)),
          }, {
            reason: result.reason ?? null,
            ...retryInputEventFields(result.retryInput),
          });
        } else {
          await appendDagNodeEvent("dag_node_failed", nodeId, dagNode, ctx, {
            error: result.reason ?? null,
            reason: result.reason ?? null,
            ...retryInputEventFields(result.retryInput),
          });
          if (result.reactivate) {
            const targetNode = dag.nodes.find((n) => n.id === result.reactivate);
            await appendDagNodeEvent("dag_node_retrying", result.reactivate, targetNode, {}, {
              reason: `reactivated by ${nodeId}: ${result.reason ?? "retry"}`,
              ...retryInputEventFields(result.retryInput),
            });
          }
        }

        if (!result.ok && !result.retryable && !result.reactivate && !result.jobTerminalHandled) {
          const job = await getJob(cpbRoot, project, jobId);
          if (job && !["completed", "failed", "blocked", "cancelled"].includes(job.status)) {
            await failJob(cpbRoot, project, jobId, failure(result.reason, {
              code: result.failCode || FAILURE_CODES.FATAL,
              phase: result.failPhase || nodeId,
              cause: result.failCause,
              retryable: result.retryable,
            }));
          }
        }
      },
      executor: async (node, ctx) => {
        const { attempt, maxAttempts } = ctx;

        // ─── Execute ───
        if (node.phase === "execute") {
          const isFix = pState.fixCount > 0;
          const phaseName = isFix ? `fix-${pState.fixCount}` : (attempt > 1 ? `execute-retry-${attempt}` : "execute");
          const execAgentLabel = await agentLabelFor("execute");
          log(project, `Phase ${phaseIndex("execute")}/${phaseTotal}: Execute (${execAgentLabel})${isFix ? " fix" : ""} attempt ${isFix ? pState.fixCount : attempt}/${maxAttempts}`);

          const retryInput = isFix ? pState.retryInput : null;
          const retryEnv = retryInput?.shouldRetry
            ? {
                CPB_RETRY_COUNT: String(retryInput.retryCount),
                CPB_PREVIOUS_VERDICT_ID: retryInput.previousVerdictId || "",
                CPB_PREVIOUS_VERDICT_PATH: retryInput.previousVerdictPath || "",
              }
            : {};
          const execResult = await dispatchRun(
            phaseName,
            "execute",
            buildExecuteScriptArgs({ project, planId, jobId, retryInput }),
            retryEnv,
          );
          if (execResult.exitCode === ROUTING_FEEDBACK_EXIT_CODE) {
            const feedbackResult = await readDispatchFeedbackFile(cpbRoot, project, jobId, { phase: phaseName });
            const upgraded = await enqueueRoutingUpgrade(feedbackResult.feedback, phaseName);
            await appendEvent(cpbRoot, project, jobId, {
              ...buildRoutingFeedbackEvent(feedbackResult.feedback, {
                jobId,
                project,
                phase: phaseName,
                upgradedQueueEntryId: upgraded?.id || null,
              }),
              feedbackPath: feedbackResult.path,
              ts: ts(),
            });
            await blockJob(cpbRoot, project, jobId, {
              reason: `routing_feedback_superseded: ${feedbackResult.feedback.reason}`,
            });
            warn(`Executor requested routing upgrade${upgraded?.id ? `; queued ${upgraded.id}` : ""}.`);
            return {
              ok: false,
              reason: "executor requested routing upgrade",
              retryable: false,
              failPhase: phaseName,
              exitCode: ROUTING_FEEDBACK_EXIT_CODE,
              jobTerminalHandled: true,
            };
          }
          const did = extractDeliverableId(execResult.stdout);

          if (did) {
            ok(`deliverable-${did}${isFix ? " (fix)" : ""}`);
            pState.retryInput = null;
            const mismatch = await checkIssue(did, phaseName);
            if (mismatch) {
              return { ok: false, reason: `issue_mismatch: expected #${mismatch.expectedIssueNumber}, got #${mismatch.actualIssueNumber}`, retryable: false, failPhase: phaseName, failCode: FAILURE_CODES.ISSUE_MISMATCH, failCause: mismatch };
            }
            pState.deliverableId = did;
            await completePhase(cpbRoot, project, jobId, { phase: phaseName, artifact: `deliverable-${did}` });
            return { ok: true };
          }

          warn(`No deliverable${isFix ? " from fix" : ""}.`);
          await completePhase(cpbRoot, project, jobId, { phase: phaseName, artifact: "" });

          if (isFix) return { ok: true };
          if (attempt >= maxAttempts) {
            const reason = `execute completed without deliverable after ${maxAttempts} attempts`;
            warn(`${reason}.`);
            return {
              ok: false,
              reason,
              retryable: false,
              failPhase: phaseName,
              failCode: FAILURE_CODES.FATAL,
            };
          }
          return { ok: false, reason: "no deliverable", retryable: true };
        }

        // ─── Review (complex workflow) ───
        if (node.phase === "review") {
          if (!pState.deliverableId) return { ok: true };
          pState.reviewAttempt++;
          const reviewNum = pState.reviewAttempt;
          const phaseName = reviewNum === 1 ? "review" : `review-retry-${reviewNum}`;

          const reviewAgentLabel = await agentLabelFor("review");
          log(project, `Phase ${phaseIndex("review")}/${phaseTotal}: Review (${reviewAgentLabel}) attempt ${reviewNum}/${maxRetries}`);
          const reviewResult = await dispatchRun(phaseName, "review", ["review", "--project", project, "--deliverable-id", pState.deliverableId]);

          if (reviewResult.error) {
            return { ok: false, reason: `review spawn error: ${reviewResult.error.message}`, retryable: true, failPhase: "review" };
          }

          const reviewPath = path.resolve(wikiDir, "outputs", `review-${pState.deliverableId}.md`);
          const reviewVerdict = await parseReviewVerdict(reviewPath);

          if (reviewVerdict === "PASS") {
            ok(`review-${pState.deliverableId}`);
            await completePhase(cpbRoot, project, jobId, { phase: "review", artifact: `review-${pState.deliverableId}` });
            return { ok: true };
          }

          warn(`Review did not pass: ${reviewVerdict ?? "missing"}`);
          await completePhase(cpbRoot, project, jobId, { phase: phaseName, artifact: reviewVerdict === null ? "" : `review-${pState.deliverableId}` });

          if (reviewVerdict === null || reviewNum >= maxRetries) {
            return { ok: false, reason: `review did not pass: ${reviewVerdict ?? "missing"}`, retryable: false, failPhase: "review", failCode: FAILURE_CODES.QUALITY_FAIL };
          }

          pState.fixCount++;
          log(project, `Re-executing (${await agentLabelFor("execute")} review fix)...`);
          return { ok: false, reason: "review failed", retryable: false, reactivate: "execute" };
        }

        // ─── Verify ───
        if (node.phase === "verify") {
          pState.verifyAttempt++;
          const verifyNum = pState.verifyAttempt;
          const phaseName = verifyNum === 1 ? "verify" : `verify-retry-${verifyNum}`;

          const verifyAgentLabel = await agentLabelFor("verify");
          log(project, `Phase ${phaseIndex("verify")}/${phaseTotal}: Verify (${verifyAgentLabel}) attempt ${verifyNum}/${maxRetries}`);
          const verifyArgs = pState.deliverableId
            ? ["verify", "--project", project, "--deliverable-id", pState.deliverableId]
            : ["verify", "--project", project, "--job-id", jobId];
          if (planId) verifyArgs.push("--plan-id", planId);

          await dispatchRun(phaseName, "verify", verifyArgs);

          const verdictId = pState.deliverableId || jobId;
          const verdictPath = path.resolve(wikiDir, "outputs", `verdict-${verdictId}.md`);
          const verdictResult = await parseVerdictResult(verdictPath);
          const verdict = verdictResult?.verdict ?? null;

          if (verdict === null) {
            await completePhase(cpbRoot, project, jobId, { phase: phaseName, artifact: "" });
            if (verifyNum >= maxRetries) {
              return { ok: false, reason: "verification verdict missing after retries", retryable: true, failPhase: "verify" };
            }
            return { ok: false, reason: "no verdict", retryable: true };
          }

          if (verdict === "UNKNOWN" || verdict === "INFRA_FAILURE") {
            await completePhase(cpbRoot, project, jobId, { phase: phaseName, artifact: "" });
            if (verifyNum >= maxRetries) {
              const reason = verdict === "INFRA_FAILURE" ? "verification infra errors after retries" : "verification verdict unclear after retries";
              return { ok: false, reason, retryable: true, failPhase: "verify" };
            }
            return { ok: false, reason: `${verdict}: retry`, retryable: true };
          }

          if (verdict === "PASS") {
            ok("Pipeline complete!");
            pState.retryInput = null;
            await completePhase(cpbRoot, project, jobId, { phase: "verify", artifact: `verdict-${verdictId}` });
            await completeJob(cpbRoot, project, jobId);
            if (process.env.CPB_GITHUB_PR_AFTER_PASS === "1" || process.env.CPB_GITHUB_PR_DRY_RUN === "1") {
              const prApproval = await waitForApprovalIfRequired({ nodeId: "PR", phase: "PR" });
              if (!prApproval.ok) {
                pipelineOk = false;
                return { ok: false, reason: prApproval.reason, retryable: false, failPhase: "PR", failCode: FAILURE_CODES.BLOCKED };
              }
              const prResult = await maybeOpenDraftPrAfterPass(cpbRoot, project, jobId, {
                verdict,
                branchPushed: process.env.CPB_GITHUB_BRANCH_PUSHED === "1",
                dryRun: process.env.CPB_GITHUB_PR_DRY_RUN === "1",
              }).catch((error) => ({ status: "blocked.pr", error: { message: error.message } }));
              if (prResult.status === "dry-run") warn(`Draft PR dry-run: ${prResult.request.head} -> ${prResult.request.base}`);
              if (prResult.status === "blocked.pr") warn(`Draft PR blocked: ${prResult.evidence?.reason || prResult.error?.message || "unknown"}`);
            }
            pipelineOk = true;
            return { ok: true };
          }

          // FAIL or PARTIAL
          warn(`Verdict: ${verdict}. Quality failure ${verifyNum}/${maxRetries}`);
          await completePhase(cpbRoot, project, jobId, { phase: phaseName, artifact: `verdict-${verdictId}` });

          if (verifyNum >= maxRetries) {
            return { ok: false, reason: `pipeline failed after ${maxRetries} quality verification failures`, retryable: false, failPhase: "verify", failCode: FAILURE_CODES.FATAL };
          }

          const retryInput = buildRetryInputFromVerdict(verdictResult.envelope, {
            retryCount: pState.fixCount + 1,
            previousVerdictId: `verdict-${verdictId}`,
            previousVerdictPath: verdictPath,
          });
          pState.fixCount++;
          pState.retryInput = retryInput;
          log(project, `Re-executing (${await agentLabelFor("execute")} fix)...`);
          return { ok: false, reason: "verify failed", retryable: false, reactivate: "execute", retryInput };
        }

        return { ok: false, reason: `unknown phase: ${node.phase}` };
      },
    });

    // Handle DAG result
    if (dagResult.ok && pipelineOk) return 0;

    if (dagResult.reason === "stopped") {
      const phase = dagResult.failedNode || "verify";
      await failJob(cpbRoot, project, jobId, failure(`timed out during ${phase} phase`, {
        code: FAILURE_CODES.RECOVERABLE, phase,
      }));
      return 1;
    }

    if (dagResult.reason === "cancelled") {
      // failJob already called in onBeforeNode
      return 1;
    }

    {
      const failedNode = dagResult.failedNode;
      const failInfo = failedNode ? dagResult.results.get(failedNode) : null;
      const reason = dagResult.reason || failInfo?.reason || "unknown";
      if (failInfo?.exitCode === ROUTING_FEEDBACK_EXIT_CODE) {
        return ROUTING_FEEDBACK_EXIT_CODE;
      }
      const job = await getJob(cpbRoot, project, jobId);
      if (job && !["completed", "failed", "blocked", "cancelled"].includes(job.status)) {
        await failJob(cpbRoot, project, jobId, failure(reason, {
          code: failInfo?.failCode || FAILURE_CODES.FATAL,
          phase: failInfo?.failPhase || failedNode,
          cause: failInfo?.failCause,
          retryable: failInfo?.retryable,
        }));
      }
      if (failedNode === "verify" || failInfo?.failPhase === "verify") {
        const vf = path.join(wikiDir, "outputs", `verdict-${pState.deliverableId || jobId}.md`);
        printFailureSummary(cpbRoot, project, jobId, { phase: "verify", reason, deliverableId: pState.deliverableId, verdictFile: vf });
      }
      return 1;
    }
  } catch (err) {
    fail(`Unhandled error: ${err.message}`);
    try {
      await failJob(cpbRoot, project, jobId, failure(`unhandled: ${err.message}`, {
        code: FAILURE_CODES.FATAL,
        cause: { message: err.message },
      }));
    } catch {
      // Best effort — job may already be in terminal state
    }
    printFailureSummary(cpbRoot, project, jobId, { reason: err.message });
    return 1;
  } finally {
    if (watchdogTimer !== null) {
      clearTimeout(watchdogTimer);
    }
    await markDispatchDone(pipelineOk);
  }
}

// ─── Main (CLI entry) ───

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv);
  } catch (err) {
    console.error(`${err.message}`);
    return 1;
  }
  try {
    return await runPipeline(parsed);
  } catch (err) {
    console.error(err.message);
    return 1;
  }
}
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
