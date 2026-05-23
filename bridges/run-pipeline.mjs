#!/usr/bin/env node
// run-pipeline.mjs — Full automated pipeline using job-store as single source of truth
// Usage: node bridges/run-pipeline.mjs --project <name> --task "<desc>" [--source-path <repo>] [--max-retries N] [--timeout-min M]

import { access, mkdir, readFile, realpath, stat, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeDataPath } from "../server/services/runtime-root.js";
import { appendEvent } from "../server/services/event-store.js";
import { getProject, resolveHubRoot } from "../server/services/hub-registry.js";
import { ensureIndexFresh, parseEnvSnapshot, snapshotForJob } from "../server/services/index-freshness.js";
import { parseVerdictEnvelope } from "../core/workflow/verdict.js";
import {
  completeJob,
  completePhase,
  createJob,
  cancelJob,
  consumeRedirect,
  FAILURE_CODES,
  failJob,
  getJob,
} from "../server/services/job-store.js";
import { bridgeForPhase, getWorkflow, isWorkflowName } from "../core/workflow/definition.js";
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
import {
  validateNonEmptyMarkdownArtifact,
  resolveDeliverableIssue,
  validateIssueMatch,
} from "../server/services/artifact-integrity.js";

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
    throw new Error("Usage: node bridges/run-pipeline.mjs --project <name> --task \"<desc>\" [--source-path <repo>] [--max-retries N] [--timeout-min M] [--workflow standard|complex|blocked|accelerated]");
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

  const jobIdOverride = options.get("--job-id") || null;
  const dispatchId = options.get("--dispatch-id") || null;
  const sourcePath = options.get("--source-path") ? path.resolve(options.get("--source-path")) : null;
  const acpProfile = options.get("--acp-profile") || null;
  const uiLaneReason = options.get("--ui-lane-reason") || "";

  return { project, task, maxRetries, timeoutMin, workflow, jobIdOverride, dispatchId, sourcePath, acpProfile, uiLaneReason };
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
  const match = stdout.match(/^Deliverable: .*\/deliverable-(\d+)\.md$/m);
  return match ? match[1] : null;
}

// ─── Verdict parsing from verdict file ───

export async function parseVerdict(verdictPath) {
  try {
    const content = await readFile(verdictPath, "utf8");
    const envelope = parseVerdictEnvelope(content);
    const mapped = { pass: "PASS", fail: "FAIL", inconclusive: "UNKNOWN", infra_error: "INFRA_FAILURE" };
    return mapped[envelope.status] || "UNKNOWN";
  } catch {
    return null;
  }
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

async function maybeCreateWorktree(cpbRoot, executorRoot, project, jobId, wikiDir, sourcePathOverride = null) {
  if (process.env.CPB_USE_WORKTREE !== "1") {
    return null;
  }

  const projectJsonPath = path.join(wikiDir, "project.json");
  let sourcePath = sourcePathOverride || process.env.CPB_PROJECT_PATH_OVERRIDE || null;
  if (!sourcePath) {
    try {
      const raw = await readFile(projectJsonPath, "utf8");
      sourcePath = JSON.parse(raw).sourcePath;
    } catch {
      return null;
    }
  }
  if (!sourcePath) return null;

  const worktreesRoot = runtimeDataPath(cpbRoot, "worktrees");
  const result = await runCommand(
    process.execPath,
    [
      path.join(executorRoot, "runtime", "git", "worktree.js"),
      "create",
      "--project",
      sourcePath,
      "--job-id",
      jobId,
      "--slug",
      "pipeline",
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
  await appendEvent(cpbRoot, project, jobId, {
    type: "worktree_created",
    jobId,
    project,
    worktree: created.path,
    branch: created.branch,
    ts: ts(),
  });
  return created;
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

// ─── Exported API (for Node.js CLI consumption) ───

export async function runPipeline({
  project,
  task,
  maxRetries = 3,
  timeoutMin = 0,
  workflow = "standard",
  jobIdOverride = null,
  dispatchId: providedDispatchId = null,
  acpProfile = null,
  uiLaneReason = "",
  sourcePath: rawSourcePath = null,
  executorRoot: providedExecutorRoot = null,
  cpbRoot: providedCpbRoot = null,
} = {}) {
  const defaultExecutorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const executorRoot = resolveExecutorRoot({ fallbackRoot: providedExecutorRoot || defaultExecutorRoot });
  const cpbRoot = path.resolve(providedCpbRoot || process.env.CPB_ROOT || defaultExecutorRoot);
  process.env.CPB_ROOT = cpbRoot;
  process.env.CPB_EXECUTOR_ROOT = executorRoot;
  process.env.CPB_WORKFLOW = workflow;

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

  let pipelineOk = false;
  const workflowDef = getWorkflow(workflow);
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
  const sourceContext = buildSourceContext();
  const job = await createJob(cpbRoot, {
    project,
    task,
    workflow,
    jobId: jobIdOverride,
    executor: await executorMetadata(executorRoot, { codeVersion: process.env.CPB_VERSION }),
    sourceContext,
    indexSnapshot: jobIndexSnapshot,
    indexFreshness: jobIndexFreshness,
  });
  const jobId = job.jobId;

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
  await maybeCreateWorktree(cpbRoot, executorRoot, project, jobId, wikiDir, sourcePath);
  log(project, `Job ${jobId} started (max ${maxRetries} retries${timeoutMin > 0 ? `, ${timeoutMin}min timeout` : ""}, workflow: ${workflow})`);

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
    // ─── Phase 1: Plan ───
    {
      const check = await checkCancelAndRedirect(cpbRoot, project, jobId, "plan");
      if (check.cancelled) {
        await failJob(cpbRoot, project, jobId, failure("cancelled before plan", { code: FAILURE_CODES.BLOCKED, phase: "plan" }));
        return 1;
      }
    }
    log(project, `Phase ${phaseIndex("plan")}/${phaseTotal}: Plan (Codex)`);
    const planResult = await dispatchPhase(cpbRoot, {
      project, jobId, phase: "plan",
      script: `bridges/${bridgeForPhase(workflowDef, "plan")}`,
      scriptArgs: ["plan", "--project", project, "--task", task],
      executorRoot,
      env: executorEnv(process.env, { cpbRoot, executorRoot }),
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

    const planId = extractPlanId(planResult.stdout);

    if (!planId) {
      fail("Plan not created. Aborting.");
      await completePhase(cpbRoot, project, jobId, { phase: "plan", artifact: "" });
      await failJob(cpbRoot, project, jobId, failure("plan not created", {
        code: FAILURE_CODES.FATAL,
        phase: "plan",
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

    ok(`plan-${planId}`);
    await completePhase(cpbRoot, project, jobId, { phase: "plan", artifact: `plan-${planId}` });

    // Cancel check after plan
    {
      const check = await checkCancelAndRedirect(cpbRoot, project, jobId, "execute");
      if (check.cancelled) {
        await failJob(cpbRoot, project, jobId, failure("cancelled after plan", { code: FAILURE_CODES.BLOCKED, phase: "execute" }));
        return 1;
      }
    }

    // ─── Phase 2: Execute (+ retry) ───
    let deliverableId = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (checkTimeout()) {
        await failJob(cpbRoot, project, jobId, failure("timed out during execute phase", {
          code: FAILURE_CODES.RECOVERABLE,
          phase: "execute",
        }));
        return 1;
      }

      log(project, `Phase ${phaseIndex("execute")}/${phaseTotal}: Execute (Claude) attempt ${attempt}/${maxRetries}`);
      const execResult = await dispatchPhase(cpbRoot, {
        project, jobId,
        phase: `execute${attempt > 1 ? `-retry-${attempt}` : ""}`,
        script: `bridges/${bridgeForPhase(workflowDef, "execute")}`,
        scriptArgs: ["execute", "--project", project, "--plan-id", planId],
        executorRoot,
        env: executorEnv(process.env, { cpbRoot, executorRoot }),
        terminalOnFailure: false,
      });

      deliverableId = extractDeliverableId(execResult.stdout);

      if (deliverableId) {
        ok(`deliverable-${deliverableId}`);
        const issueMismatch = await validateDeliverableIssue(
          cpbRoot, project, jobId, deliverableId, sourceContext?.issueNumber, sourceContext
        );
        if (issueMismatch) {
          fail(`Issue mismatch: expected #${issueMismatch.expectedIssueNumber}, got #${issueMismatch.actualIssueNumber}`);
          await completePhase(cpbRoot, project, jobId, { phase: "execute", artifact: `deliverable-${deliverableId}` });
          await failJob(cpbRoot, project, jobId, failure(
            `issue_mismatch: expected #${issueMismatch.expectedIssueNumber}, got #${issueMismatch.actualIssueNumber}`,
            { code: FAILURE_CODES.ISSUE_MISMATCH, phase: "execute", cause: issueMismatch },
          ));
          return 1;
        }
        await completePhase(cpbRoot, project, jobId, {
          phase: "execute",
          artifact: `deliverable-${deliverableId}`,
        });
        break;
      }

      warn(`No deliverable. Retry ${attempt}/${maxRetries}`);
      await completePhase(cpbRoot, project, jobId, {
        phase: `execute-retry-${attempt}`,
        artifact: "",
      });
    }

    if (!deliverableId) {
      warn(`Execute completed without deliverable after ${maxRetries} attempts. Proceeding to verify by job state.`);
      await completePhase(cpbRoot, project, jobId, {
        phase: "execute",
        artifact: "",
      });
    }

    if (deliverableId && workflowDef.phases.includes("review")) {
      let reviewPassed = false;
      let lastReviewVerdict = null;

      for (let reviewCycle = 1; reviewCycle <= maxRetries; reviewCycle++) {
        if (checkTimeout()) {
          await failJob(cpbRoot, project, jobId, failure("timed out during review phase", {
            code: FAILURE_CODES.RECOVERABLE,
            phase: "review",
          }));
          return 1;
        }

        const reviewPhaseName = reviewCycle === 1 ? "review" : `review-retry-${reviewCycle}`;
        log(project, `Phase ${phaseIndex("review")}/${phaseTotal}: Review (Codex) attempt ${reviewCycle}/${maxRetries}`);
        const reviewResult = await dispatchPhase(cpbRoot, {
          project, jobId, phase: reviewPhaseName,
          script: `bridges/${bridgeForPhase(workflowDef, "review")}`,
          scriptArgs: ["review", "--project", project, "--deliverable-id", deliverableId],
          executorRoot,
          env: executorEnv(process.env, { cpbRoot, executorRoot }),
          terminalOnFailure: false,
        });

        if (reviewResult.error) {
          fail(`Review spawn failed: ${reviewResult.error.message}`);
          await failJob(cpbRoot, project, jobId, failure(`review spawn error: ${reviewResult.error.message}`, {
            code: FAILURE_CODES.RECOVERABLE,
            phase: "review",
            cause: { message: reviewResult.error.message },
          }));
          return 1;
        }

        const reviewPath = path.resolve(wikiDir, "outputs", `review-${deliverableId}.md`);
        const reviewVerdict = await parseReviewVerdict(reviewPath);
        lastReviewVerdict = reviewVerdict;

        if (reviewVerdict === "PASS") {
          ok(`review-${deliverableId}`);
          await completePhase(cpbRoot, project, jobId, {
            phase: "review",
            artifact: `review-${deliverableId}`,
          });
          reviewPassed = true;
          break;
        }

        warn(`Review did not pass: ${reviewVerdict ?? "missing"}`);
        await completePhase(cpbRoot, project, jobId, {
          phase: reviewPhaseName,
          artifact: reviewVerdict === null ? "" : `review-${deliverableId}`,
        });

        if (reviewVerdict === null || reviewCycle >= maxRetries) {
          break;
        }

        log(project, "Re-executing (Claude review fix)...");
        const fixPhaseName = `review-fix-${reviewCycle}`;
        const fixResult = await dispatchPhase(cpbRoot, {
          project, jobId, phase: fixPhaseName,
          script: `bridges/${bridgeForPhase(workflowDef, "execute")}`,
          scriptArgs: ["execute", "--project", project, "--plan-id", planId],
          executorRoot,
          env: executorEnv(process.env, { cpbRoot, executorRoot }),
          terminalOnFailure: false,
        });

        const newDeliverableId = extractDeliverableId(fixResult.stdout);
        if (newDeliverableId) {
          deliverableId = newDeliverableId;
          ok(`deliverable-${deliverableId} (review fix)`);
          const reviewMismatch = await validateDeliverableIssue(
            cpbRoot, project, jobId, deliverableId, sourceContext?.issueNumber, sourceContext
          );
          if (reviewMismatch) {
            fail(`Issue mismatch in review fix: expected #${reviewMismatch.expectedIssueNumber}, got #${reviewMismatch.actualIssueNumber}`);
            await completePhase(cpbRoot, project, jobId, { phase: fixPhaseName, artifact: `deliverable-${deliverableId}` });
            await failJob(cpbRoot, project, jobId, failure(
              `issue_mismatch: expected #${reviewMismatch.expectedIssueNumber}, got #${reviewMismatch.actualIssueNumber}`,
              { code: FAILURE_CODES.ISSUE_MISMATCH, phase: "execute", cause: reviewMismatch },
            ));
            return 1;
          }
          await completePhase(cpbRoot, project, jobId, {
            phase: fixPhaseName,
            artifact: `deliverable-${deliverableId}`,
          });
        } else {
          warn("Review fix produced no deliverable.");
          await completePhase(cpbRoot, project, jobId, {
            phase: fixPhaseName,
            artifact: "",
          });
        }
      }

      if (!reviewPassed) {
        await failJob(cpbRoot, project, jobId, failure(`review did not pass: ${lastReviewVerdict ?? "missing"}`, {
          code: FAILURE_CODES.QUALITY_FAIL,
          phase: "review",
          retryable: false,
        }));
        return 1;
      }

      const check = await checkCancelAndRedirect(cpbRoot, project, jobId, "verify");
      if (check.cancelled) {
        await failJob(cpbRoot, project, jobId, failure("cancelled after review", { code: FAILURE_CODES.BLOCKED, phase: "verify" }));
        return 1;
      }
    }

    // Cancel check after execute
    {
      const check = await checkCancelAndRedirect(cpbRoot, project, jobId, "verify");
      if (check.cancelled) {
        await failJob(cpbRoot, project, jobId, failure("cancelled after execute", { code: FAILURE_CODES.BLOCKED, phase: "verify" }));
        return 1;
      }
    }

    // ─── Phase 3: Verify (+ fix loop) ───
    let verifyAttempt = 0;
    let verdictRetryCount = 0;
    let qualityFailureCount = 0;

    while (qualityFailureCount < maxRetries) {
      if (checkTimeout()) {
        await failJob(cpbRoot, project, jobId, failure("timed out during verify phase", {
          code: FAILURE_CODES.RECOVERABLE,
          phase: "verify",
        }));
        return 1;
      }

      verifyAttempt += 1;
      log(project, `Phase ${phaseIndex("verify")}/${phaseTotal}: Verify (Codex) attempt ${verifyAttempt}`);

      const verifyPhaseName = verifyAttempt === 1 ? "verify" : `verify-retry-${verifyAttempt}`;
      const verifyArgs = deliverableId ? ["verify", "--project", project, "--deliverable-id", deliverableId] : ["verify", "--project", project, "--job-id", jobId];
      if (planId) verifyArgs.push("--plan-id", planId);
      await dispatchPhase(cpbRoot, {
        project, jobId, phase: verifyPhaseName,
        script: `bridges/${bridgeForPhase(workflowDef, "verify")}`,
        scriptArgs: verifyArgs,
        executorRoot,
        env: executorEnv(process.env, { cpbRoot, executorRoot }),
        terminalOnFailure: false,
      });

      const verdictId = deliverableId || jobId;
      const verdictPath = path.resolve(wikiDir, "outputs", `verdict-${verdictId}.md`);
      const verdict = await parseVerdict(verdictPath);

      if (verdict === null) {
        verdictRetryCount += 1;
        warn(`No verdict file. Verification retry ${verdictRetryCount}/${maxRetries}`);
        await completePhase(cpbRoot, project, jobId, { phase: verifyPhaseName, artifact: "" });
        if (verdictRetryCount >= maxRetries) {
          await failJob(cpbRoot, project, jobId, failure("verification verdict missing after retries", {
            code: FAILURE_CODES.RECOVERABLE,
            phase: "verify",
            retryable: true,
          }));
          printFailureSummary(cpbRoot, project, jobId, {
            phase: "verify",
            reason: "verification verdict missing after retries",
            deliverableId,
            verdictFile: verdictPath,
          });
          return 1;
        }
        continue;
      }

      if (verdict === "UNKNOWN" || verdict === "INFRA_FAILURE") {
        verdictRetryCount += 1;
        const label = verdict === "INFRA_FAILURE" ? "infra error" : "unclear verdict";
        warn(`${label}: ${verdict}. Verification retry ${verdictRetryCount}/${maxRetries}`);
        await completePhase(cpbRoot, project, jobId, { phase: verifyPhaseName, artifact: "" });
        if (verdictRetryCount >= maxRetries) {
          const reason = verdict === "INFRA_FAILURE"
            ? "verification infra errors after retries"
            : "verification verdict unclear after retries";
          await failJob(cpbRoot, project, jobId, failure(reason, {
            code: FAILURE_CODES.RECOVERABLE,
            phase: "verify",
            retryable: true,
          }));
          printFailureSummary(cpbRoot, project, jobId, {
            phase: "verify",
            reason,
            deliverableId,
            verdictFile: verdictPath,
          });
          return 1;
        }
        continue;
      }

      if (verdict === "PASS") {
        ok("Pipeline complete!");
        await completePhase(cpbRoot, project, jobId, {
          phase: "verify",
          artifact: `verdict-${verdictId}`,
        });
        await completeJob(cpbRoot, project, jobId);
        pipelineOk = true;
        return 0;
      }

      // FAIL or PARTIAL — fix loop
      qualityFailureCount += 1;
      warn(`Verdict: ${verdict}. Quality failure ${qualityFailureCount}/${maxRetries}`);

      await completePhase(cpbRoot, project, jobId, {
        phase: verifyPhaseName,
        artifact: `verdict-${verdictId}`,
      });

      if (qualityFailureCount < maxRetries) {
        log(project, "Re-executing (Claude fix)...");
        const fixPhaseName = `fix-${qualityFailureCount}`;
        const fixResult = await dispatchPhase(cpbRoot, {
          project, jobId, phase: fixPhaseName,
          script: `bridges/${bridgeForPhase(workflowDef, "execute")}`,
          scriptArgs: ["execute", "--project", project, "--plan-id", planId],
          executorRoot,
          env: executorEnv(process.env, { cpbRoot, executorRoot }),
          terminalOnFailure: false,
        });

        const newDeliverableId = extractDeliverableId(fixResult.stdout);
        if (newDeliverableId) {
          deliverableId = newDeliverableId;
          ok(`deliverable-${deliverableId} (fix)`);
          const fixMismatch = await validateDeliverableIssue(
            cpbRoot, project, jobId, deliverableId, sourceContext?.issueNumber, sourceContext
          );
          if (fixMismatch) {
            fail(`Issue mismatch in fix: expected #${fixMismatch.expectedIssueNumber}, got #${fixMismatch.actualIssueNumber}`);
            await completePhase(cpbRoot, project, jobId, { phase: fixPhaseName, artifact: `deliverable-${deliverableId}` });
            await failJob(cpbRoot, project, jobId, failure(
              `issue_mismatch: expected #${fixMismatch.expectedIssueNumber}, got #${fixMismatch.actualIssueNumber}`,
              { code: FAILURE_CODES.ISSUE_MISMATCH, phase: "execute", cause: fixMismatch },
            ));
            return 1;
          }
          await completePhase(cpbRoot, project, jobId, {
            phase: fixPhaseName,
            artifact: `deliverable-${deliverableId}`,
          });

          if (workflowDef.phases.includes("review")) {
            let reviewPassed = false;
            let lastReviewVerdict = null;

            for (let reviewCycle = 1; reviewCycle <= maxRetries; reviewCycle++) {
              if (checkTimeout()) {
                await failJob(cpbRoot, project, jobId, failure("timed out during post-verify review phase", {
                  code: FAILURE_CODES.RECOVERABLE,
                  phase: "review",
                }));
                return 1;
              }

              const reviewPhaseName = `post-verify-review-${qualityFailureCount}-${reviewCycle}`;
              log(project, `Phase ${phaseIndex("review")}/${phaseTotal}: Review after verify fix attempt ${reviewCycle}/${maxRetries}`);
              const reviewResult = await dispatchPhase(cpbRoot, {
                project, jobId, phase: reviewPhaseName,
                script: `bridges/${bridgeForPhase(workflowDef, "review")}`,
                scriptArgs: ["review", "--project", project, "--deliverable-id", deliverableId],
                executorRoot,
                env: executorEnv(process.env, { cpbRoot, executorRoot }),
                terminalOnFailure: false,
              });

              if (reviewResult.error) {
                fail(`Review spawn failed: ${reviewResult.error.message}`);
                await failJob(cpbRoot, project, jobId, failure(`post-verify review spawn error: ${reviewResult.error.message}`, {
                  code: FAILURE_CODES.RECOVERABLE,
                  phase: "review",
                  cause: { message: reviewResult.error.message },
                }));
                return 1;
              }

              const reviewPath = path.resolve(wikiDir, "outputs", `review-${deliverableId}.md`);
              const reviewVerdict = await parseReviewVerdict(reviewPath);
              lastReviewVerdict = reviewVerdict;

              if (reviewVerdict === "PASS") {
                ok(`review-${deliverableId} (post-verify fix)`);
                await completePhase(cpbRoot, project, jobId, {
                  phase: reviewPhaseName,
                  artifact: `review-${deliverableId}`,
                });
                reviewPassed = true;
                break;
              }

              warn(`Post-verify review did not pass: ${reviewVerdict ?? "missing"}`);
              await completePhase(cpbRoot, project, jobId, {
                phase: reviewPhaseName,
                artifact: reviewVerdict === null ? "" : `review-${deliverableId}`,
              });

              if (reviewVerdict === null || reviewCycle >= maxRetries) {
                break;
              }

              log(project, "Re-executing (Claude post-verify review fix)...");
              const reviewFixPhaseName = `post-verify-review-fix-${qualityFailureCount}-${reviewCycle}`;
              const reviewFixResult = await dispatchPhase(cpbRoot, {
                project, jobId, phase: reviewFixPhaseName,
                script: `bridges/${bridgeForPhase(workflowDef, "execute")}`,
                scriptArgs: ["execute", "--project", project, "--plan-id", planId],
                executorRoot,
                env: executorEnv(process.env, { cpbRoot, executorRoot }),
                terminalOnFailure: false,
              });

              const reviewedDeliverableId = extractDeliverableId(reviewFixResult.stdout);
              if (reviewedDeliverableId) {
                deliverableId = reviewedDeliverableId;
                ok(`deliverable-${deliverableId} (post-verify review fix)`);
                const postVerifyMismatch = await validateDeliverableIssue(
                  cpbRoot, project, jobId, deliverableId, sourceContext?.issueNumber, sourceContext
                );
                if (postVerifyMismatch) {
                  fail(`Issue mismatch in post-verify fix: expected #${postVerifyMismatch.expectedIssueNumber}, got #${postVerifyMismatch.actualIssueNumber}`);
                  await completePhase(cpbRoot, project, jobId, { phase: reviewFixPhaseName, artifact: `deliverable-${deliverableId}` });
                  await failJob(cpbRoot, project, jobId, failure(
                    `issue_mismatch: expected #${postVerifyMismatch.expectedIssueNumber}, got #${postVerifyMismatch.actualIssueNumber}`,
                    { code: FAILURE_CODES.ISSUE_MISMATCH, phase: "execute", cause: postVerifyMismatch },
                  ));
                  return 1;
                }
                await completePhase(cpbRoot, project, jobId, {
                  phase: reviewFixPhaseName,
                  artifact: `deliverable-${deliverableId}`,
                });
              } else {
                warn("Post-verify review fix produced no deliverable.");
                await completePhase(cpbRoot, project, jobId, {
                  phase: reviewFixPhaseName,
                  artifact: "",
                });
              }
            }

            if (!reviewPassed) {
              await failJob(cpbRoot, project, jobId, failure(`post-verify review did not pass: ${lastReviewVerdict ?? "missing"}`, {
                code: FAILURE_CODES.QUALITY_FAIL,
                phase: "review",
                retryable: false,
              }));
              return 1;
            }
          }
        } else {
          warn("Fix produced no deliverable.");
          await completePhase(cpbRoot, project, jobId, {
            phase: fixPhaseName,
            artifact: "",
          });
        }
      }
    }

    fail(`Pipeline failed after ${maxRetries} quality verification failures.`);
    await failJob(cpbRoot, project, jobId, failure(`pipeline failed after ${maxRetries} quality verification failures`, {
      code: FAILURE_CODES.FATAL,
      phase: "verify",
    }));
    const vf = path.join(wikiDir, "outputs", `verdict-${deliverableId || jobId}.md`);
    printFailureSummary(cpbRoot, project, jobId, { phase: "verify", reason: `failed after ${maxRetries} quality verification failures`, deliverableId, verdictFile: vf });
    return 1;
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

if (realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
