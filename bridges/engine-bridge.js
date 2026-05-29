/**
 * Engine Bridge — thin CLI wrapper around core/engine/run-job.js.
 *
 * Wires server infrastructure (job-store, event-store, acp-pool,
 * hub-registry) into the pure core engine via dependency injection.
 */

import { runJob } from "../core/engine/run-job.js";
import { createJob, completePhase, completeJob, failJob } from "../server/services/job-store.js";
import { appendEvent } from "../server/services/event-store.js";
import { getManagedAcpPool } from "../server/services/acp-pool.js";
import { resolveHubRoot, getProject } from "../server/services/hub-registry.js";

/**
 * Build the services object for DI injection.
 */
export function buildServices(cpbRoot) {
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
 * Run a single job with service injection (no retry loop).
 * For callers (e.g. managed-worker) that handle retries externally.
 */
export async function runJobWithServices(opts) {
  const { cpbRoot, project, sourcePath: explicitSourcePath, hubRoot: explicitHubRoot } = opts;
  const { sourcePath: resolvedSourcePath, hubRoot: resolvedHubRoot } = await resolveSourcePath(cpbRoot, project);
  return runJob({
    ...opts,
    hubRoot: explicitHubRoot || resolvedHubRoot,
    sourcePath: explicitSourcePath || resolvedSourcePath,
    ...buildServices(cpbRoot),
  });
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
