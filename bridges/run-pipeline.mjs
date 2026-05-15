#!/usr/bin/env node
// run-pipeline.mjs — Full automated pipeline using job-store as single source of truth
// Usage: node bridges/run-pipeline.mjs --project <name> --task "<desc>" [--max-retries N] [--timeout-min M]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeDataPath } from "../server/services/runtime-root.js";
import { appendEvent } from "../server/services/event-store.js";
import {
  completeJob,
  completePhase,
  createJob,
  cancelJob,
  consumeRedirect,
  failJob,
  getJob,
  startPhase,
} from "../server/services/job-store.js";
import {
  acquireLease,
  releaseLease,
  renewLease,
} from "../server/services/lease-manager.js";

// ─── Helpers ───

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── CLI arg parsing ───

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = new Map();
  const flags = new Set();

  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (!name.startsWith("--")) {
      throw new Error(`unexpected argument: ${name}`);
    }
    // Boolean flags (no value)
    if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
      flags.add(name);
      continue;
    }
    options.set(name, args[i + 1]);
    i++;
  }

  const project = options.get("--project");
  const task = options.get("--task");

  if (!project || !task) {
    throw new Error("Usage: node bridges/run-pipeline.mjs --project <name> --task \"<desc>\" [--max-retries N] [--timeout-min M] [--workflow standard|blocked] [--skip-plan --plan-id <id>]");
  }

  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(project)) {
    throw new Error(`Invalid project name: '${project}' (alphanumeric + hyphens only)`);
  }

  const maxRetries = Math.max(1, parseInt(options.get("--max-retries") || "3", 10) || 3);
  const timeoutMin = Math.max(0, parseInt(options.get("--timeout-min") || "0", 10) || 0);
  const workflow = options.get("--workflow") || "standard";
  const skipPlan = flags.has("--skip-plan");
  const planId = options.get("--plan-id") || "";

  if (skipPlan && !planId) {
    throw new Error("--skip-plan requires --plan-id <id>");
  }

  return { project, task, maxRetries, timeoutMin, workflow, skipPlan, planId };
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

// ─── Timestamp helper ───

function ts() {
  return new Date().toISOString();
}

// ─── Run a bridge script as child process ───

function runBridge(script, scriptArgs, cwd) {
  return new Promise((resolve) => {
    let settled = false;
    const stdoutChunks = [];

    function finish(result) {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    let proc;
    try {
      const useBash = script.endsWith(".sh");
      proc = spawn(useBash ? "bash" : script, useBash ? [script, ...scriptArgs] : scriptArgs, {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ exitCode: 1, stdout: "", error: err });
      return;
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

function combineChunks(chunks) {
  if (chunks.length === 0) return "";
  return Buffer.concat(chunks).toString("utf8");
}

function runCapture(command, args, cwd) {
  return new Promise((resolve) => {
    const stdoutChunks = [];
    let proc;
    try {
      proc = spawn(command, args, {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (err) {
      resolve({ exitCode: 1, stdout: "", error: err });
      return;
    }

    proc.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    proc.on("error", (err) => resolve({ exitCode: 1, stdout: combineChunks(stdoutChunks), error: err }));
    proc.on("close", (code, signal) => {
      resolve({ exitCode: code ?? 1, stdout: combineChunks(stdoutChunks), signal });
    });
  });
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
  let result = { exitCode: 1, stdout: "" };

  try {
    lease = await acquireLease(cpbRoot, { leaseId, jobId, phase, ttlMs });

    await startPhase(cpbRoot, project, jobId, { phase, leaseId });

    heartbeat = setInterval(() => {
      renewLease(cpbRoot, leaseId, { ttlMs, ownerToken: lease.ownerToken }).catch((err) => {
        console.error(`failed to renew lease ${leaseId}: ${err.message}`);
      });
    }, renewEveryMs);
    heartbeat.unref?.();

    result = await runBridge(script, scriptArgs, cpbRoot);
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

// ─── Phase execution ───

async function generateDiffArtifact(cpbRoot, project, jobId, wikiDir) {
  const projectJsonPath = path.join(wikiDir, "project.json");
  let sourcePath;
  try {
    const raw = await readFile(projectJsonPath, "utf8");
    sourcePath = JSON.parse(raw).sourcePath;
  } catch {
    return null;
  }
  if (!sourcePath) return null;

  const artifactsDir = runtimeDataPath(cpbRoot, path.join("artifacts", project, jobId));
  await mkdir(artifactsDir, { recursive: true });
  const diffPath = path.join(artifactsDir, "diff-execute.patch");

  try {
    const repo = await runCapture("git", ["rev-parse", "--is-inside-work-tree"], sourcePath);
    if (repo.exitCode !== 0) return null;

    const result = await runCapture("git", ["diff", "HEAD"], sourcePath);
    if (result.exitCode === 0 && result.stdout.trim().length > 0) {
      await writeFile(diffPath, result.stdout, "utf8");
      return diffPath;
    }
  } catch {
    // Non-git project or no changes
  }
  return null;
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

  const { project, task, maxRetries, timeoutMin, workflow, skipPlan, planId: skipPlanId } = parsed;
  const cpbRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
  const job = await createJob(cpbRoot, { project, task, workflow });
  const jobId = job.jobId;

  const wikiDir = path.resolve(cpbRoot, "wiki", "projects", project);
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

  let planId;

  try {
    if (skipPlan) {
      // ─── Plan already done externally (research → plan → user confirm) ───
      planId = skipPlanId;
      ok(`plan-${planId} (external)`);
      await completePhase(cpbRoot, project, jobId, { phase: "plan", artifact: `plan-${planId}` });
    } else {
      // ─── Phase 1: Plan ───
      {
        const check = await checkCancelAndRedirect(cpbRoot, project, jobId, "plan");
        if (check.cancelled) {
          await failJob(cpbRoot, project, jobId, { reason: "cancelled before plan" });
          return 1;
        }
      }
      log(project, "Phase 1/3: Plan (Codex)");
      const planResult = await runPhaseWithLease(
        cpbRoot, project, jobId, "plan",
        "bridges/codex-plan.sh",
        [project, task]
      );

      if (planResult.error) {
        fail(`Plan spawn failed: ${planResult.error.message}`);
        await failJob(cpbRoot, project, jobId, { reason: `plan spawn error: ${planResult.error.message}` });
        return 1;
      }

      if (checkTimeout()) {
        await failJob(cpbRoot, project, jobId, { reason: "timed out after plan phase" });
        return 1;
      }

      planId = extractPlanId(planResult.stdout);

      if (!planId) {
        fail("Plan not created. Aborting.");
        await completePhase(cpbRoot, project, jobId, { phase: "plan", artifact: "" });
        await failJob(cpbRoot, project, jobId, { reason: "plan not created" });
        return 1;
      }

      ok(`plan-${planId}`);
      await completePhase(cpbRoot, project, jobId, { phase: "plan", artifact: `plan-${planId}` });
    }

    // Cancel check before execute
    {
      const check = await checkCancelAndRedirect(cpbRoot, project, jobId, "execute");
      if (check.cancelled) {
        await failJob(cpbRoot, project, jobId, { reason: "cancelled after plan" });
        return 1;
      }
    }

    // ─── Phase 2: Execute (+ retry) ───
    let deliverableId = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (checkTimeout()) {
        await failJob(cpbRoot, project, jobId, { reason: "timed out during execute phase" });
        return 1;
      }

      log(project, skipPlan ? `Phase 1/2: Execute (Claude) attempt ${attempt}/${maxRetries}` : `Phase 2/3: Execute (Claude) attempt ${attempt}/${maxRetries}`);
      const execResult = await runPhaseWithLease(
        cpbRoot, project, jobId,
        `execute${attempt > 1 ? `-retry-${attempt}` : ""}`,
        "bridges/claude-execute.sh",
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

      // Exponential backoff: 1s, 2s, 4s, ... capped at 30s
      if (attempt < maxRetries) {
        const backoffMs = Math.min(30_000, 1000 * Math.pow(2, attempt - 1));
        warn(`No deliverable. Retry ${attempt}/${maxRetries} in ${backoffMs / 1000}s...`);
        await sleep(backoffMs);
      } else {
        warn(`No deliverable. Retry ${attempt}/${maxRetries}`);
      }
      await completePhase(cpbRoot, project, jobId, {
        phase: `execute-retry-${attempt}`,
        artifact: "",
      });
    }

    if (!deliverableId) {
      fail(`Execute failed after ${maxRetries} attempts.`);
      await failJob(cpbRoot, project, jobId, { reason: `execute failed after ${maxRetries} attempts` });
      return 1;
    }

    // Cancel check after execute
    {
      const check = await checkCancelAndRedirect(cpbRoot, project, jobId, "verify");
      if (check.cancelled) {
        await failJob(cpbRoot, project, jobId, { reason: "cancelled after execute" });
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
        await failJob(cpbRoot, project, jobId, { reason: "timed out during verify phase" });
        return 1;
      }

      log(project, skipPlan ? `Phase 2/2: Verify (Codex) attempt ${cycle}/${maxRetries}` : `Phase 3/3: Verify (Codex) attempt ${cycle}/${maxRetries}`);

      const verifyPhaseName = cycle === 1 ? "verify" : `verify-retry-${cycle}`;
      const verifyArgs = diffArtifactPath
        ? [project, deliverableId, diffArtifactPath]
        : [project, deliverableId];
      await runPhaseWithLease(
        cpbRoot, project, jobId, verifyPhaseName,
        "bridges/codex-verify.sh",
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
          "bridges/claude-execute.sh",
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
    await failJob(cpbRoot, project, jobId, { reason: `pipeline failed after ${maxRetries} verify cycles` });
    return 1;
  } catch (err) {
    fail(`Unhandled error: ${err.message}`);
    try {
      await failJob(cpbRoot, project, jobId, { reason: `unhandled: ${err.message}` });
    } catch {
      // Best effort — job may already be in terminal state
    }
    return 1;
  } finally {
    if (watchdogTimer !== null) {
      clearTimeout(watchdogTimer);
    }
  }
}

process.exitCode = await main();
