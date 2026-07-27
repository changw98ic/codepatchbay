/**
 * Bookkeeping holder for RunJobState mutable progress fields.
 *
 * Per plan §四 阶段3 ("消除对 ctx._currentPhase 等共享可变字段的直接写入，改由
 * bookkeeping holder 负责…不做一次性全量重命名"), the three mutable bookkeeping
 * fields on RunJobState (`_jobId`, `_attemptId`, `_currentPhase`) have their
 * WRITES centralized here so mutation has a single chokepoint.
 *
 * READS stay direct (`ctx._currentPhase`, `ctx._jobId`, `ctx._attemptId`) — there
 * is intentionally NO full rename to accessor getters, in order to keep the diff
 * small and avoid touching the many read sites across the engine. Only the five
 * direct writes are routed through these setters.
 */

import type { RunJobState } from "./run-job-ports.js";

/**
 * Record the resolved job id on the run context. Called once the job has been
 * created (and once at run entry with the "unknown" placeholder).
 */
export function setJobId(ctx: RunJobState, jobId: string): void {
  ctx._jobId = jobId;
}

/**
 * Record the active attempt id on the run context. `undefined` clears it.
 */
export function setAttemptId(ctx: RunJobState, attemptId: string | undefined): void {
  ctx._attemptId = attemptId;
}

/**
 * Record the currently executing phase on the run context. `null` marks the
 * pre-DAG / between-phases state.
 */
export function setCurrentPhase(ctx: RunJobState, phase: string | null): void {
  ctx._currentPhase = phase;
}
