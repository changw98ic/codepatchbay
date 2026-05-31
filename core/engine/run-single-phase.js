/**
 * runSinglePhase — run exactly one phase outside of a full pipeline.
 *
 * Used by `cpb plan`, `cpb execute`, `cpb verify`, `cpb repair`,
 * `cpb review` CLI commands.  Creates a job, runs the phase,
 * writes events, and returns an exit code.
 *
 * All infrastructure services injected via opts.services — no server/ imports.
 */

import { runPhase } from "./run-phase.js";
import { phasePassed } from "../contracts/phase-result.js";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

function ts() {
  return new Date().toISOString();
}

/**
 * Resolve the latest artifact of a given kind for a project.
 */
async function findLatestArtifact(cpbRoot, project, kind) {
  const kindDir = path.join(
    cpbRoot, "wiki", "projects", project,
    kind === "plan" ? "inbox" : "outputs"
  );
  try {
    const files = await readdir(kindDir);
    const matches = files
      .filter((f) => f.startsWith(`${kind}-`) && f.endsWith(".md"))
      .sort();
    if (matches.length === 0) return null;
    const latest = matches[matches.length - 1];
    const id = latest.replace(`${kind}-`, "").replace(".md", "");
    return { kind, id, name: `${kind}-${id}`, path: path.join(kindDir, latest) };
  } catch {
    return null;
  }
}

/**
 * Load artifact content by explicit ID.
 */
async function loadArtifact(cpbRoot, project, kind, id) {
  const kindDir = kind === "plan" ? "inbox" : "outputs";
  const filePath = path.join(
    cpbRoot, "wiki", "projects", project, kindDir, `${kind}-${id}.md`
  );
  try {
    const content = await readFile(filePath, "utf8");
    return { kind, id, name: `${kind}-${id}`, path: filePath, content };
  } catch {
    return null;
  }
}

/**
 * Build previousResults from explicit artifact IDs.
 */
async function buildPreviousResults(cpbRoot, project, { planId, deliverableId }) {
  const results = [];

  if (planId) {
    const artifact = await loadArtifact(cpbRoot, project, "plan", planId);
    if (artifact) {
      results.push({ status: "passed", phase: "plan", artifact });
    }
  }

  if (deliverableId) {
    const artifact = await loadArtifact(cpbRoot, project, "deliverable", deliverableId);
    if (artifact) {
      results.push({ status: "passed", phase: "execute", artifact });
    }
  }

  return results;
}

/**
 * @param {string} phase - plan | execute | verify | repair | review
 * @param {object} opts
 * @param {string} opts.cpbRoot
 * @param {string} opts.project
 * @param {string} [opts.task]
 * @param {string} [opts.planId]
 * @param {string} [opts.deliverableId]
 * @param {string} [opts.jobId]
 * @param {string} [opts.agent]
 * @param {string} [opts.sourcePath]
 * @param {Function} opts.createJob
 * @param {Function} opts.completeJob
 * @param {Function} opts.failJob
 * @param {Function} opts.appendEvent
 * @param {Function} opts.getPool
 * @returns {Promise<number>} exit code
 */
export async function runSinglePhase(phase, opts) {
  const {
    cpbRoot,
    project,
    task,
    planId,
    deliverableId,
    jobId: jobIdOverride,
    agent,
    sourcePath,
    // Injected services
    createJob,
    completeJob,
    failJob,
    appendEvent,
    getPool,
  } = opts;

  if (!cpbRoot) {
    console.error("runSinglePhase: cpbRoot is required");
    return 1;
  }

  // Create job
  const job = await createJob(cpbRoot, {
    project,
    task: task || `${phase} (manual)`,
    workflow: "manual",
    planMode: phase === "plan" ? "full" : "none",
    jobId: jobIdOverride,
  });
  const jobId = job.jobId;

  await appendEvent(cpbRoot, project, jobId, {
    type: "job_started",
    jobId,
    project,
    phase,
    ts: ts(),
  });

  // Get pool
  const pool = getPool();

  // Build previousResults from explicit IDs
  const previousResults = await buildPreviousResults(cpbRoot, project, {
    planId,
    deliverableId,
  });

  // For execute/verify without explicit ID, try to find latest artifact
  if (phase === "execute" && !planId) {
    const planArtifact = await findLatestArtifact(cpbRoot, project, "plan");
    if (planArtifact) {
      previousResults.push({ status: "passed", phase: "plan", artifact: planArtifact });
    }
  }
  if (phase === "verify" && !deliverableId) {
    const delivArtifact = await findLatestArtifact(cpbRoot, project, "deliverable");
    if (delivArtifact) {
      previousResults.push({ status: "passed", phase: "execute", artifact: delivArtifact });
    }
  }

  await appendEvent(cpbRoot, project, jobId, {
    type: "phase_started",
    jobId,
    project,
    phase,
    ts: ts(),
  });

  // Run the phase
  const envTimeout = Number(process.env.CPB_ACP_POOL_TIMEOUT_MS) || 0;

  const result = await runPhase({
    phase,
    project,
    task: task || `${phase} (manual)`,
    jobId,
    job,
    cpbRoot,
    sourcePath,
    pool,
    state: {},
    previousResults,
    agent,
    timeouts: {
      plan: envTimeout,
      execute: envTimeout,
      verify: envTimeout,
      review: envTimeout,
      repair: envTimeout,
    },
  });

  await appendEvent(cpbRoot, project, jobId, {
    type: "phase_result",
    jobId,
    project,
    phase,
    status: result.status,
    artifact: result.artifact?.name || null,
    failure: result.failure
      ? { kind: result.failure.kind, reason: result.failure.reason }
      : null,
    ts: ts(),
  });

  if (phasePassed(result)) {
    await completeJob(cpbRoot, project, jobId);
    console.log(`✓ ${phase} passed${result.artifact ? ` → ${result.artifact.name}` : ""}`);
    return 0;
  }

  const f = result.failure || {};
  await failJob(cpbRoot, project, jobId, {
    reason: f.reason || `${phase} failed`,
    code: f.kind || "fatal",
    phase,
    cause: f,
  });

  console.error(`✗ ${phase} failed: ${f.reason || "unknown"}`);
  return 1;
}
