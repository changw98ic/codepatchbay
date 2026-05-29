/**
 * bridges/run-pipeline.mjs — CLI entry point for pipeline execution.
 *
 * All orchestration lives in core/engine/run-job.js.
 * Old 67KB implementation backed up as run-pipeline.mjs.old.
 */

import { runPipeline } from "./engine-bridge.js";
import { resolveModelProfileEnv } from "../cli/commands/model-profile.js";

export { runPipeline };
export { resolvePhases as resolvePlanDecision } from "../core/engine/workflow-runner.js";

export function buildExecuteScriptArgs({ project, planId, jobId } = {}) {
  const args = ["execute", "--project", project];
  if (jobId) args.push("--job-id", jobId);
  if (planId) args.push("--plan-id", planId);
  return args;
}

// CLI entry point when spawned as `node run-pipeline.mjs --project ... --task ...`
if (process.argv[1] && process.argv[1].includes("run-pipeline.mjs")) {
  const argv = process.argv.slice(2);
  let project = "", task = "", planMode = "auto", workflow = "standard", agent = "", jobId = "", timeoutMin = "0", maxRetries = "3", acpProfile = "", uiLaneReason = "";
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--project": project = argv[++i]; break;
      case "--task": task = argv[++i]; break;
      case "--plan-mode": planMode = argv[++i]; break;
      case "--workflow": workflow = argv[++i]; break;
      case "--agent": agent = argv[++i]; break;
      case "--job-id": jobId = argv[++i]; break;
      case "--timeout-min": timeoutMin = argv[++i]; break;
      case "--max-retries": maxRetries = argv[++i]; break;
      case "--acp-profile": acpProfile = argv[++i]; break;
      case "--ui-lane-reason": uiLaneReason = argv[++i]; break;
    }
  }

  if (!project || !task) {
    console.error("Usage: run-pipeline.mjs --project <name> --task <desc> [options]");
    process.exit(1);
  }

  const cpbRoot = process.env.CPB_ROOT || process.cwd();
  let modelEnv = {};
  if (acpProfile) {
    try {
      modelEnv = await resolveModelProfileEnv(cpbRoot, acpProfile);
    } catch { /* profile not found, proceed without */ }
  }

  const code = await runPipeline({
    project, task, maxRetries: parseInt(maxRetries, 10),
    planMode, workflow, agent: agent || undefined,
    jobId: jobId || undefined,
    timeoutMin: parseFloat(timeoutMin) || 0,
    modelEnv, cpbRoot,
  });
  process.exit(Number.isInteger(code) ? code : 0);
}
