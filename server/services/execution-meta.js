/**
 * Execution boundary metadata normalization.
 * Ensures sessionId, workerId, sourcePath, cwd, executionBoundary are
 * explicit (null when absent) across queue entries, dispatches, and
 * pipeline events.
 */

/**
 * Normalize execution metadata. Missing optional fields become explicit
 * null rather than silently empty strings. cwd defaults to sourcePath.
 */
export function buildMeta(input = {}) {
  return {
    projectId: input.projectId || null,
    sourcePath: input.sourcePath || null,
    sessionId: input.sessionId || null,
    workerId: input.workerId || null,
    cwd: input.cwd || input.sourcePath || null,
    executionBoundary: input.executionBoundary || "source",
  };
}

/**
 * Build an execution_boundary event from normalized meta.
 */
export function executionBoundaryEvent(meta, { jobId, project, ts }) {
  return {
    type: "execution_boundary",
    jobId,
    project,
    sourcePath: meta.sourcePath,
    cwd: meta.cwd,
    sessionId: meta.sessionId,
    workerId: meta.workerId,
    ts,
  };
}
