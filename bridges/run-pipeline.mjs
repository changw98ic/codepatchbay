#!/usr/bin/env node
// run-pipeline.mjs — Full automated pipeline using job-store as single source of truth
// Usage: node bridges/run-pipeline.mjs --project <name> --task "<desc>" [--source-path <repo>] [--max-retries N] [--timeout-min M]

import { access, mkdir, readFile, realpath, stat, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeDataPath } from "../server/services/runtime-root.js";
import { appendEvent } from "../server/services/runtime-events.js";
import { getProject, resolveHubRoot } from "../server/services/hub-registry.js";
import {
  completeJob,
  completePhase,
  createJob,
  cancelJob,
  consumeRedirect,
  FAILURE_CODES,
  failJob,
  getJob,
  startPhase,
} from "../server/services/job-store.js";
import {
  acquireLease,
  releaseLease,
  renewLease,
} from "../server/services/lease-manager.js";
import { bridgeForPhase, getWorkflow } from "../server/services/workflow-definition.js";
import {
  dispatchEnabled,
  guardSourcePath as guardDispatchSourcePath,
  lookupDispatch,
  markDispatchCompleted,
  markDispatchFailed,
  markDispatchStarted,
  recordDispatch,
} from "../server/services/worker-dispatch.js";

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
    throw new Error("Usage: node bridges/run-pipeline.mjs --project <name> --task \"<desc>\" [--source-path <repo>] [--max-retries N] [--timeout-min M] [--workflow standard|blocked]");
  }

  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(project)) {
    throw new Error(`Invalid project name: '${project}' (alphanumeric + hyphens only)`);
  }

  const maxRetries = Math.max(1, parseInt(options.get("--max-retries") || "3", 10) || 3);
  const timeoutMin = Math.max(0, parseInt(options.get("--timeout-min") || "0", 10) || 0);
  const workflow = options.get("--workflow") || "standard";

  const jobIdOverride = options.get("--job-id") || null;
  const dispatchId = options.get("--dispatch-id") || null;
  const sourcePath = options.get("--source-path") ? path.resolve(options.get("--source-path")) : null;

  return { project, task, maxRetries, timeoutMin, workflow, jobIdOverride, dispatchId, sourcePath };
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
      const verdict = content.match(/^VERDICT:\s*(\S+)/m)?.[1] || "unknown";
      const firstEvidence = content.split("\n").filter(l => l.trim() && !l.startsWith("VERDICT:")).slice(0, 3).join(" | ");
      console.log(`  ${CYAN}Verdict:${NC}    ${verdict}`);
      if (firstEvidence) console.log(`  ${CYAN}Evidence:${NC}   ${firstEvidence.slice(0, 120)}`);
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
        env: process.env,
        detached,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ exitCode: 1, stdout: "", error: err });
      return;
    }
    proc.detached = detached;
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
      finish({ exitCode: 1, stdout: combineChunks(stdoutChunks), error: err });
    });
    proc.on("close", (code, signal) => {
      finish({
        exitCode: code ?? 1,
        stdout: combineChunks(stdoutChunks),
        signal,
      });
    });
  });
}

function runBridge(script, scriptArgs, cwd, options = {}) {
  return runCommand("bash", [script, ...scriptArgs], cwd, options);
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

// ─── Lease + heartbeat wrapper for a phase ───

async function runPhaseWithLease(cpbRoot, project, jobId, phase, script, scriptArgs) {
  const leaseId = `lease-${jobId}-${phase}`;
  // Phase lease TTL: how long a lease is valid before considered stale.
  // Separate from the lock TTL (DEFAULT_LOCK_TTL_MS in lease-manager.js) which controls lock contention timeout.
  const ttlMs = parseInt(process.env.CPB_LEASE_TTL_MS || "120000", 10) || 120_000;
  const renewEveryMs = parseInt(
    process.env.CPB_LEASE_RENEW_INTERVAL_MS || String(Math.max(5_000, Math.floor(ttlMs / 3))),
    10
  ) || Math.max(5_000, Math.floor(ttlMs / 3));

  let lease = null;
  let heartbeat = null;
  let leaseLostError = null;
  const abortController = new AbortController();
  let result = { exitCode: 1, stdout: "" };

  try {
    lease = await acquireLease(cpbRoot, { leaseId, jobId, phase, ttlMs });

    await startPhase(cpbRoot, project, jobId, { phase, leaseId });

    heartbeat = setInterval(() => {
      renewLease(cpbRoot, leaseId, { ttlMs, ownerToken: lease.ownerToken }).catch((err) => {
        leaseLostError = err;
        console.error(`failed to renew lease ${leaseId}: ${err.message}`);
        abortController.abort();
      });
    }, renewEveryMs);
    heartbeat.unref?.();

    result = await runBridge(script, scriptArgs, cpbRoot, { signal: abortController.signal });
    if (leaseLostError) {
      result = {
        ...result,
        exitCode: 1,
        error: new Error(`lease ownership lost for ${leaseId}: ${leaseLostError.message}`),
      };
    }
  } catch (err) {
    result = { exitCode: 1, stdout: "", error: err };
  } finally {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
    }
    if (lease !== null) {
      try {
        await releaseLease(cpbRoot, leaseId, { ownerToken: lease.ownerToken });
      } catch (err) {
        console.error(`failed to release lease ${leaseId}: ${err.message}`);
      }
    }
  }

  return result;
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

async function parseVerdict(verdictPath) {
  try {
    const content = await readFile(verdictPath, "utf8");
    const lines = content.split(/\r?\n/).slice(0, 5);
    for (const line of lines) {
      const structured = line.match(/^VERDICT:\s*(PASS|FAIL|PARTIAL)\b/i);
      if (structured) return structured[1].toUpperCase();
    }
    for (const line of lines) {
      const legacy = line.match(/^\s*(PASS|FAIL|PARTIAL)\b/i);
      if (legacy) return legacy[1].toUpperCase();
    }
    return "UNKNOWN";
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

async function generateDiffArtifact(cpbRoot, project, jobId, wikiDir) {
  const projectJsonPath = path.join(wikiDir, "project.json");
  let sourcePath = process.env.CPB_PROJECT_PATH_OVERRIDE || null;
  if (!sourcePath) {
    try {
      const raw = await readFile(projectJsonPath, "utf8");
      sourcePath = JSON.parse(raw).sourcePath;
    } catch {
      return null;
    }
  }
  if (!sourcePath) return null;

  try {
    await access(path.join(sourcePath, ".git"));
  } catch {
    return null;
  }

  const artifactsDir = runtimeDataPath(cpbRoot, path.join("artifacts", project, jobId));
  await mkdir(artifactsDir, { recursive: true });
  const diffPath = path.join(artifactsDir, "diff-execute.patch");

  try {
    // Include untracked files in diff via intent-to-add (no content staged)
    await runCommand("git", ["add", "-N", "."], sourcePath).catch(() => {});
    const result = await runCommand("git", ["diff", "HEAD"], sourcePath);
    if (result.exitCode === 0 && result.stdout.trim().length > 0) {
      await writeFile(diffPath, result.stdout, "utf8");
      return diffPath;
    }
  } catch {
    // Non-git project or no changes
  }
  return null;
}

async function maybeCreateWorktree(cpbRoot, project, jobId, wikiDir, sourcePathOverride = null) {
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
      "bridges/worktree-manager.mjs",
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
    cpbRoot
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

// ─── Main pipeline ───

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv);
  } catch (err) {
    console.error(`${err.message}`);
    return 1;
  }

  const { project, task, maxRetries, timeoutMin, workflow, jobIdOverride, dispatchId: providedDispatchId } = parsed;
  let { sourcePath } = parsed;
  const defaultCpbRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cpbRoot = path.resolve(process.env.CPB_ROOT || defaultCpbRoot);
  if (sourcePath) {
    try {
      sourcePath = await canonicalSourcePath(sourcePath);
    } catch (err) {
      console.error(err.message);
      return 1;
    }
    process.env.CPB_PROJECT_PATH_OVERRIDE = sourcePath;
    process.env.CPB_ACP_CWD = sourcePath;
    await ensureWikiProjectBoundary(cpbRoot, project, sourcePath);
  }

  const hubRoot = process.env.CPB_HUB_ROOT ? resolveHubRoot(cpbRoot) : null;
  let dispatchId = providedDispatchId || null;

  if (dispatchEnabled() && hubRoot && sourcePath) {
    await guardDispatchSourcePath(hubRoot, project, sourcePath);
    if (!dispatchId) {
      const dispatch = await recordDispatch(hubRoot, { projectId: project, sourcePath });
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

  // Create job
  const job = await createJob(cpbRoot, { project, task, workflow, jobId: jobIdOverride });
  const jobId = job.jobId;
  if (sourcePath) {
    await appendEvent(cpbRoot, project, jobId, {
      type: "execution_boundary",
      jobId,
      project,
      sourcePath,
      cwd: sourcePath,
      ts: ts(),
    });
  }

  const wikiDir = path.resolve(cpbRoot, "wiki", "projects", project);
  await maybeCreateWorktree(cpbRoot, project, jobId, wikiDir, sourcePath);
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
    const planResult = await runPhaseWithLease(
      cpbRoot, project, jobId, "plan",
      `bridges/${bridgeForPhase(workflowDef, "plan")}`,
      [project, task]
    );

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
      const execResult = await runPhaseWithLease(
        cpbRoot, project, jobId,
        `execute${attempt > 1 ? `-retry-${attempt}` : ""}`,
        `bridges/${bridgeForPhase(workflowDef, "execute")}`,
        [project, planId]
      );

      deliverableId = extractDeliverableId(execResult.stdout);

      if (deliverableId) {
        ok(`deliverable-${deliverableId}`);
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
      fail(`Execute failed after ${maxRetries} attempts.`);
      await failJob(cpbRoot, project, jobId, failure(`execute failed after ${maxRetries} attempts`, {
        code: FAILURE_CODES.FATAL,
        phase: "execute",
      }));
      return 1;
    }

    if (workflowDef.phases.includes("review")) {
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
        const reviewResult = await runPhaseWithLease(
          cpbRoot, project, jobId, reviewPhaseName,
          `bridges/${bridgeForPhase(workflowDef, "review")}`,
          [project, deliverableId]
        );

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
        const fixResult = await runPhaseWithLease(
          cpbRoot, project, jobId, fixPhaseName,
          `bridges/${bridgeForPhase(workflowDef, "execute")}`,
          [project, planId, reviewPath]
        );

        const newDeliverableId = extractDeliverableId(fixResult.stdout);
        if (newDeliverableId) {
          deliverableId = newDeliverableId;
          ok(`deliverable-${deliverableId} (review fix)`);
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
    const diffArtifactPath = await generateDiffArtifact(cpbRoot, project, jobId, wikiDir);
    if (diffArtifactPath) {
      log(project, `Diff artifact generated: ${diffArtifactPath}`);
    }

    for (let cycle = 1; cycle <= maxRetries; cycle++) {
      if (checkTimeout()) {
        await failJob(cpbRoot, project, jobId, failure("timed out during verify phase", {
          code: FAILURE_CODES.RECOVERABLE,
          phase: "verify",
        }));
        return 1;
      }

      log(project, `Phase ${phaseIndex("verify")}/${phaseTotal}: Verify (Codex) attempt ${cycle}/${maxRetries}`);

      const verifyPhaseName = cycle === 1 ? "verify" : `verify-retry-${cycle}`;
      const verifyArgs = diffArtifactPath
        ? [project, deliverableId, diffArtifactPath]
        : [project, deliverableId];
      await runPhaseWithLease(
        cpbRoot, project, jobId, verifyPhaseName,
        `bridges/${bridgeForPhase(workflowDef, "verify")}`,
        verifyArgs
      );

      const verdictPath = path.resolve(wikiDir, "outputs", `verdict-${deliverableId}.md`);
      const verdict = await parseVerdict(verdictPath);

      if (verdict === null) {
        warn(`No verdict file. Retry ${cycle}/${maxRetries}`);
        await completePhase(cpbRoot, project, jobId, { phase: verifyPhaseName, artifact: "" });
        continue;
      }

      if (verdict === "UNKNOWN") {
        warn(`Unclear verdict: ${verdict}`);
        await completePhase(cpbRoot, project, jobId, { phase: verifyPhaseName, artifact: "" });
        continue;
      }

      if (verdict === "PASS") {
        ok("Pipeline complete!");
        await completePhase(cpbRoot, project, jobId, {
          phase: "verify",
          artifact: `verdict-${deliverableId}`,
        });
        await completeJob(cpbRoot, project, jobId);
        pipelineOk = true;
        return 0;
      }

      // FAIL or PARTIAL — fix loop
      warn(`Verdict: ${verdict}. Fix attempt ${cycle}/${maxRetries}`);

      await completePhase(cpbRoot, project, jobId, {
        phase: verifyPhaseName,
        artifact: `verdict-${deliverableId}`,
      });

      if (cycle < maxRetries) {
        log(project, "Re-executing (Claude fix)...");
        const fixPhaseName = `fix-${cycle}`;
        const fixResult = await runPhaseWithLease(
          cpbRoot, project, jobId, fixPhaseName,
          `bridges/${bridgeForPhase(workflowDef, "execute")}`,
          [project, planId, verdictPath]
        );

        const newDeliverableId = extractDeliverableId(fixResult.stdout);
        if (newDeliverableId) {
          deliverableId = newDeliverableId;
          ok(`deliverable-${deliverableId} (fix)`);
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

              const reviewPhaseName = `post-verify-review-${cycle}-${reviewCycle}`;
              log(project, `Phase ${phaseIndex("review")}/${phaseTotal}: Review after verify fix attempt ${reviewCycle}/${maxRetries}`);
              const reviewResult = await runPhaseWithLease(
                cpbRoot, project, jobId, reviewPhaseName,
                `bridges/${bridgeForPhase(workflowDef, "review")}`,
                [project, deliverableId]
              );

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
              const reviewFixPhaseName = `post-verify-review-fix-${cycle}-${reviewCycle}`;
              const reviewFixResult = await runPhaseWithLease(
                cpbRoot, project, jobId, reviewFixPhaseName,
                `bridges/${bridgeForPhase(workflowDef, "execute")}`,
                [project, planId, reviewPath]
              );

              const reviewedDeliverableId = extractDeliverableId(reviewFixResult.stdout);
              if (reviewedDeliverableId) {
                deliverableId = reviewedDeliverableId;
                ok(`deliverable-${deliverableId} (post-verify review fix)`);
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

    fail(`Pipeline failed after ${maxRetries} cycles.`);
    await failJob(cpbRoot, project, jobId, failure(`pipeline failed after ${maxRetries} verify cycles`, {
      code: FAILURE_CODES.FATAL,
      phase: "verify",
    }));
    const vf = deliverableId ? path.join(wikiDir, "outputs", `verdict-${deliverableId}.md`) : undefined;
    printFailureSummary(cpbRoot, project, jobId, { phase: "verify", reason: `failed after ${maxRetries} cycles`, deliverableId, verdictFile: vf });
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

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
