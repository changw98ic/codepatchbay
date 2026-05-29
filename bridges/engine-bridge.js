/**
 * Engine Bridge — thin CLI wrapper around core/engine/run-job.js.
 *
 * Wires server infrastructure (job-store, event-store, acp-pool,
 * hub-registry) into the pure core engine via dependency injection.
 * Handles sourcePath resolution, retry loop, and console output.
 */

import { runJob } from "../core/engine/run-job.js";
import { runSinglePhase as _runSinglePhase } from "../core/engine/run-single-phase.js";
import { createJob, completePhase, completeJob, failJob } from "../server/services/job-store.js";
import { appendEvent } from "../server/services/event-store.js";
import { getManagedAcpPool } from "../server/services/acp-pool.js";
import { resolveHubRoot, getProject } from "../server/services/hub-registry.js";

const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const YELLOW = "\x1b[1;33m";
const CYAN = "\x1b[0;36m";
const NC = "\x1b[0m";

/**
 * Build the services object for DI injection.
 */
function services(cpbRoot) {
  return {
    createJob,
    completePhase,
    completeJob,
    failJob,
    appendEvent,
    getPool: () => getManagedAcpPool({ cpbRoot }),
  };
}

/**
 * Resolve sourcePath from hub registry.
 */
async function resolveSourcePath(cpbRoot, project) {
  try {
    const hubRoot = resolveHubRoot(cpbRoot);
    const registered = await getProject(hubRoot, project);
    return { sourcePath: registered?.sourcePath || null, hubRoot };
  } catch {
    return { sourcePath: null, hubRoot: null };
  }
}

/**
 * @param {object} opts
 * @returns {Promise<number>} exit code
 */
export async function runPipeline(opts) {
  const {
    project,
    task,
    maxRetries = 3,
    planMode = "full",
    workflow = "standard",
    agent,
    modelEnv,
    cpbRoot,
    sourcePath: explicitSourcePath,
    timeoutMin,
    jobId: jobIdOverride,
  } = opts;

  // 1. Resolve sourcePath from hub registry
  const { sourcePath, hubRoot } = await resolveSourcePath(
    cpbRoot, project, explicitSourcePath
  );
  const finalSourcePath = explicitSourcePath || sourcePath;

  // 2. Retry loop
  let lastResult;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      console.log(`${YELLOW}Retry ${attempt + 1}/${maxRetries}${NC}`);
    }

    lastResult = await runJob({
      cpbRoot,
      hubRoot,
      project,
      task,
      workflow,
      planMode,
      sourcePath: finalSourcePath,
      env: { ...process.env, ...(modelEnv || {}) },
      agent,
      maxRetries,
      timeoutMin,
      jobId: attempt === 0 ? jobIdOverride : undefined,
      // Injected services
      ...services(cpbRoot),
    });

    if (lastResult.status === "completed") {
      console.log(`${GREEN}✓ Job ${lastResult.jobId} completed${NC}`);
      for (const pr of lastResult.phaseResults || []) {
        const icon = pr.status === "passed" ? GREEN + "✓" : RED + "✗";
        const artifact = pr.artifact?.name || "";
        console.log(`  ${icon} ${pr.phase}${NC}${artifact ? ` → ${artifact}` : ""}`);
      }
      return 0;
    }

    // Failure path
    const f = lastResult.failure || {};
    const retryable = f.retryable && attempt < maxRetries - 1;

    console.error(
      `${RED}✗ Job ${lastResult.jobId} failed at ${f.phase || "?"}: ${f.reason}${NC}`
    );

    if (!retryable) {
      console.error(JSON.stringify(lastResult, null, 2));
      return lastResult.exitCode || 1;
    }

    console.error(`${CYAN}  Retriable (${f.kind}), retrying...${NC}`);
  }

  return lastResult?.exitCode || 1;
}

/**
 * Run a single phase — injects services and resolves sourcePath.
 *
 * @param {string} phase
 * @param {object} opts
 * @returns {Promise<number>} exit code
 */
export async function runSinglePhase(phase, opts) {
  const { cpbRoot, project } = opts;

  // Resolve sourcePath
  const { sourcePath } = await resolveSourcePath(cpbRoot, project);

  return _runSinglePhase(phase, {
    ...opts,
    sourcePath: opts.sourcePath || sourcePath,
    // Injected services
    ...services(cpbRoot),
  });
}
