/**
 * Execution boundary metadata normalization.
 * Ensures sessionId, workerId, sourcePath, cwd, executionBoundary are
 * explicit (null when absent) across queue entries, dispatches, and
 * pipeline events.
 */

export const REQUIRED_EXECUTION_BOUNDARY = "worktree";

/**
 * Normalize execution metadata. Missing optional fields become explicit
 * null rather than silently empty strings.
 */
export function buildMeta(input: Record<string, any> = {}) {
  return {
    projectId: input.projectId || null,
    sourcePath: input.sourcePath || null,
    sessionId: input.sessionId || null,
    workerId: input.workerId || null,
    cwd: input.cwd || input.sourcePath || null,
    executionBoundary: REQUIRED_EXECUTION_BOUNDARY,
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
    executionBoundary: REQUIRED_EXECUTION_BOUNDARY,
    sessionId: meta.sessionId,
    workerId: meta.workerId,
    ts,
  };
}
