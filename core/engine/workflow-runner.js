import { defaultPlanModeForWorkflow } from "../triage/schema.js";
import { getWorkflow, isWorkflowName } from "../workflow/definition.js";

function phasesForPlanMode(phases, planMode) {
  switch (planMode) {
    case "full":
      return phases;
    case "light":
      return phases.filter((phase) => phase !== "review" && phase !== "verify");
    case "none":
      return phases.filter((phase) => phase !== "plan" && phase !== "review");
    case "parent":
      return phases.filter((phase) => phase === "plan");
    default:
      return phases;
  }
}

export function resolvePhases(workflow = "standard", planMode = "full") {
  const workflowName = isWorkflowName(workflow) ? workflow : "standard";
  const wf = getWorkflow(workflowName);
  const resolvedPlanMode = planMode === "auto"
    ? defaultPlanModeForWorkflow(workflowName)
    : planMode || "full";
  return phasesForPlanMode(wf.phases, resolvedPlanMode);
}
