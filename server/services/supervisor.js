import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { isLeaseStale, readLease } from "./lease-manager.js";
import { cancelJob, completeJob as completeJobStore } from "./job-store.js";
import { getWorkflow, nextPhase, bridgeForPhase as workflowBridgeForPhase } from "./workflow-definition.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "cancelled"]);
const STALE_GRACE_COUNT = parseInt(process.env.CPB_STALE_GRACE_COUNT, 10) || 3;
const staleTracker = new Map();

function hasArtifact(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function artifactId(value, prefix) {
  if (!hasArtifact(value)) return "";
  const base = path.basename(value, ".md");
  return base.startsWith(`${prefix}-`) ? base.slice(prefix.length + 1) : value;
}

async function fileExists(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export function nextPhaseFor(state) {
  if (!state || TERMINAL_STATUSES.has(state.status)) {
    return "";
  }

  if (state.cancelRequested) {
    return "";
  }

  const workflow = getWorkflow(state.workflow);

  // Blocked workflow has no phases
  if (workflow.phases.length === 0) {
    return "";
  }

  // Determine current phase from artifacts
  const artifacts = state.artifacts ?? {};
  for (const phase of workflow.phases) {
    if (!hasArtifact(artifacts[phase])) {
      return phase;
    }
  }
  return "complete";
}

export async function recoverJobs(cpbRoot, { now } = {}) {
  const { listJobs } = await import("./job-store.js");
  const jobs = await listJobs(cpbRoot);
  const recoverable = [];
  const activeJobIds = new Set();

  for (const job of jobs) {
    activeJobIds.add(job.jobId);

    // Cancel-requested jobs with no active lease should be terminated first
    if (job.cancelRequested) {
      if (job.leaseId) {
        const lease = await readLease(cpbRoot, job.leaseId);
        if (lease !== null && !isLeaseStale(lease, now)) {
          continue;
        }
      }
      staleTracker.delete(job.jobId);
      await cancelJob(cpbRoot, job.project, job.jobId, {
        reason: job.cancelReason ?? "cancelled during recovery",
      });
      continue;
    }

    if (nextPhaseFor(job) === "") {
      staleTracker.delete(job.jobId);
      continue;
    }

    let leaseIsStale = false;
    if (job.leaseId) {
      const lease = await readLease(cpbRoot, job.leaseId);
      if (lease !== null && !isLeaseStale(lease, now)) {
        staleTracker.delete(job.jobId);
        continue;
      }
      leaseIsStale = true;
    }

    if (!leaseIsStale && nextPhaseFor(job) === "complete") {
      staleTracker.delete(job.jobId);
      recoverable.push(job);
      continue;
    }

    // Fallback: if no lease or lease is stale, check lastActivityAt
    if (!leaseIsStale && job.lastActivityAt) {
      const nowMs = now instanceof Date ? now.getTime() : Date.now();
      const activityAge = nowMs - new Date(job.lastActivityAt).getTime();
      if (activityAge < (parseInt(process.env.CPB_ACTIVITY_STALE_MS, 10) || 300_000)) {
        staleTracker.delete(job.jobId);
        continue;
      }
    }

    const entry = staleTracker.get(job.jobId);
    if (entry) {
      entry.count += 1;
    } else {
      staleTracker.set(job.jobId, { count: 1, firstStaleAt: Date.now() });
    }

    const current = staleTracker.get(job.jobId);
    if (current.count < STALE_GRACE_COUNT) {
      continue;
    }

    staleTracker.delete(job.jobId);
    recoverable.push(job);
  }

  for (const id of staleTracker.keys()) {
    if (!activeJobIds.has(id)) {
      staleTracker.delete(id);
    }
  }

  return recoverable;
}

export function getStaleTrackerSnapshot() {
  return Object.fromEntries(staleTracker);
}

/**
 * Resolve the bridge script and extra arguments for a given phase.
 * Returns { script, args } or null if the phase is "complete" (no script needed).
 */
export function bridgeForPhase(phase, project, job) {
  const bridgesDir = "bridges";

  // Use hardcoded mapping for known phases (preserves existing arg logic)
  switch (phase) {
    case "plan":
      return {
        script: path.join(bridgesDir, "codex-plan.sh"),
        args: [project, job.task ?? ""],
      };
    case "execute": {
      const planId = artifactId(job.artifacts?.plan, "plan");
      return {
        script: path.join(bridgesDir, "claude-execute.sh"),
        args: [project, planId],
      };
    }
    case "verify": {
      const deliverableId = artifactId(job.artifacts?.execute, "deliverable");
      return {
        script: path.join(bridgesDir, "codex-verify.sh"),
        args: [project, deliverableId],
      };
    }
    case "review": {
      const deliverableId = artifactId(job.artifacts?.execute, "deliverable");
      return {
        script: path.join(bridgesDir, "reviewer-review.sh"),
        args: [project, deliverableId],
      };
    }
    case "complete":
      return null;
    default: {
      // Unknown phase: try workflow definition
      const workflow = getWorkflow(job.workflow);
      const bridge = workflowBridgeForPhase(workflow, phase);
      if (bridge) return { script: path.join(bridgesDir, bridge), args: [project] };
      return null;
    }
  }
}

/**
 * Spawn a child process and return { exitCode, signal }.
 */
function runChild(command, args, cwd) {
  return new Promise((resolve) => {
    let settled = false;

    function finish(result) {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ exitCode: 1, error: err });
      return;
    }

    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", (err) => finish({ exitCode: 1, error: err }));
    child.on("close", (code, signal) =>
      finish({ exitCode: code ?? 1, signal })
    );
  });
}

/**
 * Recover a single job: determine the next phase and either spawn
 * job-runner.mjs or mark the job complete.
 *
 * Returns { jobId, project, phase, exitCode } on success or error.
 */
export async function recoverOneJob(cpbRoot, job) {
  const phase = nextPhaseFor(job);
  if (phase === "") {
    return { jobId: job.jobId, project: job.project, phase: "skipped", exitCode: 0 };
  }

  // "complete" phase: no bridge script, just mark done.
  if (phase === "complete") {
    await completeJobStore(cpbRoot, job.project, job.jobId);
    return { jobId: job.jobId, project: job.project, phase: "complete", exitCode: 0 };
  }

  const bridge = bridgeForPhase(phase, job.project, job);
  if (!bridge) {
    return { jobId: job.jobId, project: job.project, phase, exitCode: 1, error: "no bridge for phase" };
  }

  const jobRunner = path.resolve(cpbRoot, "bridges", "job-runner.mjs");
  if (!await fileExists(jobRunner)) {
    return {
      jobId: job.jobId,
      project: job.project,
      phase,
      exitCode: 1,
      error: `job runner not found: ${jobRunner}`,
    };
  }

  const runnerArgs = [
    jobRunner,
    "--cpb-root", cpbRoot,
    "--project", job.project,
    "--job-id", job.jobId,
    "--phase", phase,
    "--script", path.resolve(cpbRoot, bridge.script),
    "--",
    ...bridge.args,
  ];

  const result = await runChild("node", runnerArgs, cpbRoot);

  return {
    jobId: job.jobId,
    project: job.project,
    phase,
    exitCode: result.exitCode,
    error: result.error?.message ?? null,
  };
}

/**
 * Full recovery cycle: find recoverable jobs and run them
 * with a concurrency limit.
 *
 * Returns an array of recovery results.
 */
export async function recoverAndRun(cpbRoot, { now, maxConcurrent = 1 } = {}) {
  const jobs = await recoverJobs(cpbRoot, { now });
  const results = [];

  // Process in batches of maxConcurrent.
  for (let i = 0; i < jobs.length; i += maxConcurrent) {
    const batch = jobs.slice(i, i + maxConcurrent);
    const batchResults = await Promise.all(
      batch.map((job) =>
        recoverOneJob(cpbRoot, job).catch((err) => ({
          jobId: job.jobId,
          project: job.project,
          phase: nextPhaseFor(job),
          exitCode: 1,
          error: err.message,
        }))
      )
    );
    results.push(...batchResults);
  }

  return results;
}
