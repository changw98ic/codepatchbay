#!/usr/bin/env node
// run-pipeline.mjs — Full automated pipeline using job-store as single source of truth
// Usage: node bridges/run-pipeline.mjs --project <name> --task "<desc>" [--max-retries N] [--timeout-min M]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeDataPath } from "../server/services/runtime-root.js";
import {
  completeJob,
  completePhase,
  createJob,
  failJob,
  startPhase,
} from "../server/services/job-store.js";
import {
  acquireLease,
  releaseLease,
  renewLease,
} from "../server/services/lease-manager.js";

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
    throw new Error("Usage: node bridges/run-pipeline.mjs --project <name> --task \"<desc>\" [--max-retries N] [--timeout-min M]");
  }

  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(project)) {
    throw new Error(`Invalid project name: '${project}' (alphanumeric + hyphens only)`);
  }

  const maxRetries = Math.max(1, parseInt(options.get("--max-retries") || "3", 10) || 3);
  const timeoutMin = Math.max(0, parseInt(options.get("--timeout-min") || "0", 10) || 0);

  return { project, task, maxRetries, timeoutMin };
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
      proc = spawn("bash", [script, ...scriptArgs], {
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

// ─── Lease + heartbeat wrapper for a phase ───

async function runPhaseWithLease(flowRoot, project, jobId, phase, script, scriptArgs) {
  const leaseId = `lease-${jobId}-${phase}`;
  const ttlMs = parseInt(process.env.FLOW_LEASE_TTL_MS || "120000", 10) || 120_000;
  const renewEveryMs = parseInt(
    process.env.FLOW_LEASE_RENEW_INTERVAL_MS || String(Math.max(5_000, Math.floor(ttlMs / 3))),
    10
  ) || Math.max(5_000, Math.floor(ttlMs / 3));

  let lease = null;
  let heartbeat = null;
  let result = { exitCode: 1, stdout: "" };

  try {
    lease = await acquireLease(flowRoot, { leaseId, jobId, phase, ttlMs });

    await startPhase(flowRoot, project, jobId, { phase, leaseId });

    heartbeat = setInterval(() => {
      renewLease(flowRoot, leaseId, { ttlMs, ownerToken: lease.ownerToken }).catch((err) => {
        console.error(`failed to renew lease ${leaseId}: ${err.message}`);
      });
    }, renewEveryMs);
    heartbeat.unref?.();

    result = await runBridge(script, scriptArgs, flowRoot);
  } catch (err) {
    result = { exitCode: 1, stdout: "", error: err };
  } finally {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
    }
    if (lease !== null) {
      try {
        await releaseLease(flowRoot, leaseId, { ownerToken: lease.ownerToken });
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

// ─── Compatibility state for status/UI readers ───

function pipelineStateFile(flowRoot, project) {
  return runtimeDataPath(flowRoot, "state", `pipeline-${project}.json`);
}

async function readPipelineState(flowRoot, project) {
  try {
    return JSON.parse(await readFile(pipelineStateFile(flowRoot, project), "utf8"));
  } catch {
    return {};
  }
}

async function initPipelineState(flowRoot, { project, task, maxRetries, jobId }) {
  const file = pipelineStateFile(flowRoot, project);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify(
      {
        project,
        task,
        jobId,
        started: ts(),
        phase: "plan",
        retryCount: 0,
        maxRetries: Number(maxRetries),
        status: "running",
      },
      null,
      2
    ),
    "utf8"
  );
}

async function writePipelineState(flowRoot, project, patch) {
  const file = pipelineStateFile(flowRoot, project);
  const current = await readPipelineState(flowRoot, project);
  const next = {
    ...current,
    ...patch,
    updated: ts(),
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(next, null, 2), "utf8");
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

  const { project, task, maxRetries, timeoutMin } = parsed;
  const flowRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  // Timeout support: set a flag via setTimeout
  let timedOut = false;
  let watchdogTimer = null;

  if (timeoutMin > 0) {
    watchdogTimer = setTimeout(() => {
      timedOut = true;
      void writePipelineState(flowRoot, project, { status: "timeout" }).catch((err) => {
        console.error(`failed to write timeout state: ${err.message}`);
      });
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
  const job = await createJob(flowRoot, { project, task, workflow: "standard" });
  const jobId = job.jobId;
  await initPipelineState(flowRoot, { project, task, maxRetries, jobId });

  const wikiDir = path.resolve(flowRoot, "wiki", "projects", project);
  log(project, `Job ${jobId} started (max ${maxRetries} retries${timeoutMin > 0 ? `, ${timeoutMin}min timeout` : ""})`);

  try {
    // ─── Phase 1: Plan ───
    log(project, "Phase 1/3: Plan (Codex)");
    const planResult = await runPhaseWithLease(
      flowRoot, project, jobId, "plan",
      "bridges/codex-plan.sh",
      [project, task]
    );

    if (planResult.error) {
      fail(`Plan spawn failed: ${planResult.error.message}`);
      await writePipelineState(flowRoot, project, { status: "failed" });
      await failJob(flowRoot, project, jobId, { reason: `plan spawn error: ${planResult.error.message}` });
      return 1;
    }

    if (checkTimeout()) {
      await writePipelineState(flowRoot, project, { status: "timeout" });
      await failJob(flowRoot, project, jobId, { reason: "timed out after plan phase" });
      return 1;
    }

    const planId = extractPlanId(planResult.stdout);

    if (!planId) {
      fail("Plan not created. Aborting.");
      await writePipelineState(flowRoot, project, { status: "failed" });
      await completePhase(flowRoot, project, jobId, { phase: "plan", artifact: "" });
      await failJob(flowRoot, project, jobId, { reason: "plan not created" });
      return 1;
    }

    ok(`plan-${planId}`);
    await completePhase(flowRoot, project, jobId, { phase: "plan", artifact: `plan-${planId}` });
    await writePipelineState(flowRoot, project, { phase: "execute" });

    // ─── Phase 2: Execute (+ retry) ───
    let deliverableId = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (checkTimeout()) {
        await writePipelineState(flowRoot, project, { status: "timeout" });
        await failJob(flowRoot, project, jobId, { reason: "timed out during execute phase" });
        return 1;
      }

      log(project, `Phase 2/3: Execute (Claude) attempt ${attempt}/${maxRetries}`);
      await writePipelineState(flowRoot, project, {
        phase: "execute",
        retryCount: attempt - 1,
      });
      const execResult = await runPhaseWithLease(
        flowRoot, project, jobId,
        `execute${attempt > 1 ? `-retry-${attempt}` : ""}`,
        "bridges/claude-execute.sh",
        [project, planId]
      );

      deliverableId = extractDeliverableId(execResult.stdout);

      if (deliverableId) {
        ok(`deliverable-${deliverableId}`);
        await completePhase(flowRoot, project, jobId, {
          phase: "execute",
          artifact: `deliverable-${deliverableId}`,
        });
        break;
      }

      warn(`No deliverable. Retry ${attempt}/${maxRetries}`);
      await completePhase(flowRoot, project, jobId, {
        phase: `execute-retry-${attempt}`,
        artifact: "",
      });
    }

    if (!deliverableId) {
      fail(`Execute failed after ${maxRetries} attempts.`);
      await writePipelineState(flowRoot, project, { status: "failed" });
      await failJob(flowRoot, project, jobId, { reason: `execute failed after ${maxRetries} attempts` });
      return 1;
    }
    await writePipelineState(flowRoot, project, { phase: "verify" });

    // ─── Phase 3: Verify (+ fix loop) ───
    for (let cycle = 1; cycle <= maxRetries; cycle++) {
      if (checkTimeout()) {
        await writePipelineState(flowRoot, project, { status: "timeout" });
        await failJob(flowRoot, project, jobId, { reason: "timed out during verify phase" });
        return 1;
      }

      log(project, `Phase 3/3: Verify (Codex) attempt ${cycle}/${maxRetries}`);
      await writePipelineState(flowRoot, project, {
        phase: "verify",
        retryCount: cycle - 1,
      });

      const verifyPhaseName = cycle === 1 ? "verify" : `verify-retry-${cycle}`;
      await runPhaseWithLease(
        flowRoot, project, jobId, verifyPhaseName,
        "bridges/codex-verify.sh",
        [project, deliverableId]
      );

      const verdictPath = path.resolve(wikiDir, "outputs", `verdict-${deliverableId}.md`);
      const verdict = await parseVerdict(verdictPath);

      if (verdict === null) {
        warn(`No verdict file. Retry ${cycle}/${maxRetries}`);
        await completePhase(flowRoot, project, jobId, { phase: verifyPhaseName, artifact: "" });
        continue;
      }

      if (verdict === "UNKNOWN") {
        warn(`Unclear verdict: ${verdict}`);
        await completePhase(flowRoot, project, jobId, { phase: verifyPhaseName, artifact: "" });
        continue;
      }

      if (verdict === "PASS") {
        ok("Pipeline complete!");
        await writePipelineState(flowRoot, project, {
          phase: "verify",
          status: "completed",
        });
        await completePhase(flowRoot, project, jobId, {
          phase: "verify",
          artifact: `verdict-${deliverableId}`,
        });
        await completeJob(flowRoot, project, jobId);
        return 0;
      }

      // FAIL or PARTIAL — fix loop
      warn(`Verdict: ${verdict}. Fix attempt ${cycle}/${maxRetries}`);

      await completePhase(flowRoot, project, jobId, {
        phase: verifyPhaseName,
        artifact: `verdict-${deliverableId}`,
      });

      if (cycle < maxRetries) {
        log(project, "Re-executing (Claude fix)...");
        const fixPhaseName = `fix-${cycle}`;
        await writePipelineState(flowRoot, project, {
          phase: "execute",
          retryCount: cycle,
        });
        const fixResult = await runPhaseWithLease(
          flowRoot, project, jobId, fixPhaseName,
          "bridges/claude-execute.sh",
          [project, planId, verdictPath]
        );

        const newDeliverableId = extractDeliverableId(fixResult.stdout);
        if (newDeliverableId) {
          deliverableId = newDeliverableId;
          ok(`deliverable-${deliverableId} (fix)`);
          await completePhase(flowRoot, project, jobId, {
            phase: fixPhaseName,
            artifact: `deliverable-${deliverableId}`,
          });
        } else {
          warn("Fix produced no deliverable.");
          await completePhase(flowRoot, project, jobId, {
            phase: fixPhaseName,
            artifact: "",
          });
        }
      }
    }

    fail(`Pipeline failed after ${maxRetries} cycles.`);
    await writePipelineState(flowRoot, project, { status: "failed" });
    await failJob(flowRoot, project, jobId, { reason: `pipeline failed after ${maxRetries} verify cycles` });
    return 1;
  } catch (err) {
    fail(`Unhandled error: ${err.message}`);
    await writePipelineState(flowRoot, project, { status: "failed" });
    try {
      await failJob(flowRoot, project, jobId, { reason: `unhandled: ${err.message}` });
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
