/**
 * bridges/run-pipeline.mjs — thin CLI entry point.
 *
 * All orchestration lives in core/engine/run-job.js.
 * Old 67KB implementation backed up as run-pipeline.mjs.old.
 */

export { runPipeline } from "./engine-bridge.js";

// Legacy re-exports for test compatibility.
// Tests importing resolvePlanDecision should migrate to
// core/engine/workflow-runner.js (resolvePhases).
export { resolvePhases as resolvePlanDecision } from "../core/engine/workflow-runner.js";

export function buildExecuteScriptArgs({ project, planId, jobId } = {}) {
  const args = ["execute", "--project", project];
  if (jobId) args.push("--job-id", jobId);
  if (planId) args.push("--plan-id", planId);
  return args;
}
