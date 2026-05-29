/**
 * Engine.runJob — single entry point for job execution.
 *
 * P0-5 fix: delegates to runPipeline internally so both Hub worker and CLI
 * share one execution path. When the Engine is fully implemented, this
 * delegation can be replaced with the native phase-based state machine.
 */

/**
 * @param {object} ctx
 * @param {string} ctx.cpbRoot
 * @param {string} ctx.hubRoot
 * @param {string} ctx.project
 * @param {string} ctx.task
 * @param {string} ctx.jobId
 * @param {string} ctx.workflow
 * @param {string} ctx.planMode
 * @param {string} [ctx.sourcePath]
 * @param {object} [ctx.sourceContext]
 * @param {object} [ctx.pool]
 * @param {number} [ctx.maxRetries]
 * @param {number} [ctx.timeoutMin]
 * @returns {Promise<{status: string, jobId: string, exitCode: number}>}
 */
export async function runJob(ctx) {
  const { runPipeline } = await import("../../bridges/run-pipeline.mjs");

  // Set env vars expected by runPipeline
  process.env.CPB_ROOT = ctx.cpbRoot;
  if (ctx.hubRoot) process.env.CPB_HUB_ROOT = ctx.hubRoot;
  if (ctx.sourcePath) process.env.CPB_PROJECT_PATH_OVERRIDE = ctx.sourcePath;
  if (ctx.sourceContext) {
    process.env.CPB_SOURCE_CONTEXT_JSON = JSON.stringify(ctx.sourceContext);
  }

  const exitCode = await runPipeline({
    project: ctx.project,
    task: ctx.task,
    workflow: ctx.workflow || "standard",
    planMode: ctx.planMode || "full",
    sourcePath: ctx.sourcePath || null,
    cpbRoot: ctx.cpbRoot,
    jobIdOverride: ctx.jobId,
    maxRetries: ctx.maxRetries || 3,
    timeoutMin: ctx.timeoutMin || 60,
  });

  return {
    status: exitCode === 0 ? "completed" : "failed",
    jobId: ctx.jobId,
    exitCode,
  };
}
