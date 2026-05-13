import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { isLeaseStale, readLease } from "./lease-manager.js";
import { completeJob as completeJobStore } from "./job-store.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "cancelled"]);

function hasArtifact(value) {
  return typeof value === "string" && value.trim().length > 0;
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

  const artifacts = state.artifacts ?? {};
  if (!hasArtifact(artifacts.plan)) {
    return "plan";
  }
  if (!hasArtifact(artifacts.execute)) {
    return "execute";
  }
  if (!hasArtifact(artifacts.verify)) {
    return "verify";
  }
  return "complete";
}

export async function recoverJobs(flowRoot, { now } = {}) {
  const { listJobs } = await import("./job-store.js");
  const jobs = await listJobs(flowRoot);
  const recoverable = [];

  for (const job of jobs) {
    if (nextPhaseFor(job) === "") {
      continue;
    }

    if (job.leaseId) {
      const lease = await readLease(flowRoot, job.leaseId);
      if (lease !== null && !isLeaseStale(lease, now)) {
        continue;
      }
    }

    recoverable.push(job);
  }

  return recoverable;
}

/**
 * Resolve the bridge script and extra arguments for a given phase.
 * Returns { script, args } or null if the phase is "complete" (no script needed).
 */
export function bridgeForPhase(phase, project, job) {
  const bridgesDir = "bridges";

  switch (phase) {
    case "plan":
      return {
        script: path.join(bridgesDir, "codex-plan.sh"),
        args: [project, job.task ?? ""],
      };
    case "execute": {
      const planId = job.artifacts?.plan ?? "";
      return {
        script: path.join(bridgesDir, "claude-execute.sh"),
        args: [project, planId],
      };
    }
    case "verify": {
      const deliverableId = job.artifacts?.execute ?? "";
      return {
        script: path.join(bridgesDir, "codex-verify.sh"),
        args: [project, deliverableId],
      };
    }
    case "complete":
      return null;
    default:
      return null;
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
export async function recoverOneJob(flowRoot, job) {
  const phase = nextPhaseFor(job);
  if (phase === "") {
    return { jobId: job.jobId, project: job.project, phase: "skipped", exitCode: 0 };
  }

  // "complete" phase: no bridge script, just mark done.
  if (phase === "complete") {
    await completeJobStore(flowRoot, job.project, job.jobId);
    return { jobId: job.jobId, project: job.project, phase: "complete", exitCode: 0 };
  }

  const bridge = bridgeForPhase(phase, job.project, job);
  if (!bridge) {
    return { jobId: job.jobId, project: job.project, phase, exitCode: 1, error: "no bridge for phase" };
  }

  const jobRunner = path.resolve(flowRoot, "bridges", "job-runner.mjs");
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
    "--flow-root", flowRoot,
    "--project", job.project,
    "--job-id", job.jobId,
    "--phase", phase,
    "--script", path.resolve(flowRoot, bridge.script),
    "--",
    ...bridge.args,
  ];

  const result = await runChild("node", runnerArgs, flowRoot);

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
export async function recoverAndRun(flowRoot, { now, maxConcurrent = 1 } = {}) {
  const jobs = await recoverJobs(flowRoot, { now });
  const results = [];

  // Process in batches of maxConcurrent.
  for (let i = 0; i < jobs.length; i += maxConcurrent) {
    const batch = jobs.slice(i, i + maxConcurrent);
    const batchResults = await Promise.all(
      batch.map((job) =>
        recoverOneJob(flowRoot, job).catch((err) => ({
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
