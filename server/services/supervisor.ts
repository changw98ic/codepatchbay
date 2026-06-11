// @ts-nocheck
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { isLeaseStale, readLease } from "./lease-manager.js";
import { cancelJob, completeJob as completeJobStore } from "./job-store.js";
import { getWorkflow, nextPhase, bridgeForPhase as workflowBridgeForPhase } from "./workflow-definition.js";
import { executorEnv, resolveExecutorRoot } from "./executor-root.js";
import { buildChildEnv } from "./secret-policy.js";
import { recoverAsNewJob } from "./job-recovery.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "cancelled"]);
const STALE_GRACE_COUNT = parseInt(process.env.CPB_STALE_GRACE_COUNT, 10) || 3;
const staleTracker = new Map();

function hasArtifact(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasCompletedPhase(state, phase) {
  return state.completedPhases?.includes(phase) || hasArtifact(state.artifacts?.[phase]);
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
    if (!hasCompletedPhase(state, phase)) {
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
        script: path.join(bridgesDir, "planner.sh"),
        args: [project, job.task ?? ""],
      };
    case "execute": {
      const planId = artifactId(job.artifacts?.plan, "plan");
      return {
        script: path.join(bridgesDir, "executor.sh"),
        args: [project, planId],
      };
    }
    case "verify": {
      const deliverableId = artifactId(job.artifacts?.execute, "deliverable");
      return {
        script: path.join(bridgesDir, "verifier.sh"),
        args: deliverableId ? [project, deliverableId] : [project, "--job-id", job.jobId],
      };
    }
    case "review": {
      const deliverableId = artifactId(job.artifacts?.execute, "deliverable");
      return {
        script: path.join(bridgesDir, "reviewer.sh"),
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
function runChild(command, args, cwd, { env = process.env } = {}) {
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
        env: buildChildEnv(env),
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
 * job-runner.js or mark the job complete.
 *
 * Returns { jobId, project, phase, exitCode } on success or error.
 */
export async function recoverOneJob(cpbRoot, job, { executorRoot, useCurrentExecutor = false } = {}) {
  const callerRoot = resolveExecutorRoot({ fallbackRoot: executorRoot || cpbRoot });
  const resolvedExecutorRoot = useCurrentExecutor
    ? callerRoot
    : (job.executor?.root && job.executor.root !== callerRoot ? job.executor.root : callerRoot);
  const phase = nextPhaseFor(job);
  if (phase === "") {
    return { jobId: job.jobId, project: job.project, phase: "skipped", exitCode: 0 };
  }

  // "complete" phase: no bridge script, just mark done.
  if (phase === "complete") {
    await completeJobStore(cpbRoot, job.project, job.jobId);
    return { jobId: job.jobId, project: job.project, phase: "complete", exitCode: 0 };
  }

  // Create a fresh recovery job with lineage; original terminal record stays auditable
  let recoveryJob = job;
  const TERMINAL_SET = new Set(["failed", "blocked", "cancelled"]);
  if (TERMINAL_SET.has(job.status)) {
    try {
      recoveryJob = await recoverAsNewJob(cpbRoot, job.project, job.jobId, {
        reason: `supervisor recovery: ${job.status} job needs phase ${phase}`,
        trigger: "supervisor",
        useCurrentExecutor,
        currentExecutor: useCurrentExecutor ? { root: callerRoot } : null,
      });
    } catch (err) {
      // If recovery job creation fails, proceed with original job (best-effort)
      recoveryJob = job;
    }
  }

  const bridge = bridgeForPhase(phase, recoveryJob.project, recoveryJob);
  if (!bridge) {
    return { jobId: recoveryJob.jobId, project: recoveryJob.project, phase, exitCode: 1, error: "no bridge for phase" };
  }

  const jobRunner = path.resolve(resolvedExecutorRoot, "bridges", "job-runner.js");
  if (!await fileExists(jobRunner)) {
    return {
      jobId: recoveryJob.jobId,
      project: recoveryJob.project,
      phase,
      exitCode: 1,
      error: `job runner not found: ${jobRunner}`,
    };
  }

  const runnerArgs = [
    jobRunner,
    "--cpb-root", cpbRoot,
    "--project", recoveryJob.project,
    "--job-id", recoveryJob.jobId,
    "--phase", phase,
    "--script", path.resolve(resolvedExecutorRoot, bridge.script),
    "--",
    ...bridge.args,
  ];

  const result = await runChild("node", runnerArgs, cpbRoot, {
    env: executorEnv(process.env, {
      cpbRoot,
      executorRoot: resolvedExecutorRoot,
    }),
  });

  return {
    jobId: recoveryJob.jobId,
    project: recoveryJob.project,
    phase,
    exitCode: result.exitCode,
    error: result.error?.message ?? null,
    recoveredFrom: recoveryJob.jobId !== job.jobId ? job.jobId : null,
  };
}

/**
 * Full recovery cycle: find recoverable jobs and run them
 * with a concurrency limit.
 *
 * Returns an array of recovery results.
 */
export async function recoverAndRun(cpbRoot, { now, maxConcurrent = 1, executorRoot, useCurrentExecutor = false } = {}) {
  const jobs = await recoverJobs(cpbRoot, { now });
  const resolvedExecutorRoot = resolveExecutorRoot({ fallbackRoot: executorRoot || cpbRoot });
  const results = [];

  // Process in batches of maxConcurrent.
  for (let i = 0; i < jobs.length; i += maxConcurrent) {
    const batch = jobs.slice(i, i + maxConcurrent);
    const batchResults = await Promise.all(
      batch.map((job) =>
        recoverOneJob(cpbRoot, job, { executorRoot: resolvedExecutorRoot, useCurrentExecutor }).catch((err) => ({
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
