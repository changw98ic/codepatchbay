import { defaultPlanModeForWorkflow } from "../triage/schema.js";
import { getWorkflow, isWorkflowName } from "../workflow/definition.js";

type PlanModeResult = { phases: string[]; warning?: string };
type SemanticPhasesResult = {
  phases: string[];
  resolvedPlanMode: string;
  source: "phase_policy";
  warning?: string;
};
type PhasePolicyValidationResult = { valid: true } | { valid: false; reason: string };

/**
 * Filter workflow phases by planMode semantics.
 *
 * @param {string[]} phases - Full phase list from the workflow definition.
 * @param {string}   planMode - One of: full, light, none, parent.
 * @returns {{ phases: string[], warning?: string }}
 */
function applyPlanMode(phases: string[], planMode: string, workflowName: string): PlanModeResult {
  if (workflowName === "direct" && planMode === "none") {
    return {
      phases: phases.filter((p) => p === "execute"),
      warning: 'planMode "none" is an escape hatch — do not use for normal durable mutating jobs',
    };
  }

  switch (planMode) {
    case "full":
      return { phases };
    case "light":
      return { phases: phases.filter((p) => p !== "plan" && p !== "review") };
    case "none":
      return {
        phases: phases.filter((p) => p !== "plan" && p !== "review"),
        warning: 'planMode "none" is an escape hatch — do not use for normal durable mutating jobs',
      };
    case "parent":
      return { phases: phases.filter((p) => p === "plan") };
    default:
      return { phases };
  }
}

/**
 * Resolve the canonical phase list for a workflow + planMode combination.
 *
 * @param {{ workflow?: string, planMode?: string, taskType?: string }} opts
 * @returns {{ phases: string[], resolvedPlanMode: string, source: "phase_policy", warning?: string }}
 */
export function resolveSemanticPhases({ workflow = "standard", planMode = "auto" }: { workflow?: string; planMode?: string; taskType?: string } = {}): SemanticPhasesResult {
  const workflowName = isWorkflowName(workflow) ? workflow : "standard";
  const wf = getWorkflow(workflowName);
  const resolvedPlanMode = planMode === "auto"
    ? defaultPlanModeForWorkflow(workflowName)
    : planMode || "full";
  const result = applyPlanMode(wf.phases, resolvedPlanMode, workflowName);
  return {
    phases: result.phases,
    resolvedPlanMode,
    source: "phase_policy",
    ...(result.warning && { warning: result.warning }),
  };
}

/**
 * Validate that a resolved phase list is legal for a mutating durable job.
 *
 * Rules:
 *  - `light`/`full` MUST include `verify`.
 *  - `none` and `parent` must not be used for normal completion in a mutating context.
 *
 * @param {string[]} phases          - Resolved phase list.
 * @param {string}   resolvedPlanMode - The plan mode that produced the phase list.
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validatePhasePolicy(phases: string[], resolvedPlanMode: string): PhasePolicyValidationResult {
  if (resolvedPlanMode === "none") {
    return { valid: false, reason: 'planMode "none" is an escape hatch — not allowed for mutating durable jobs' };
  }
  if (resolvedPlanMode === "parent") {
    return { valid: false, reason: 'planMode "parent" produces no execution phases — not allowed for mutating durable jobs' };
  }
  if (!phases.includes("verify")) {
    return { valid: false, reason: `planMode "${resolvedPlanMode}" resolved without verify phase — verify is required for mutating jobs` };
  }
  return { valid: true };
}
