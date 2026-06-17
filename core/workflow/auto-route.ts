import { triageByRules } from "../triage/rules.js";

const AUTO_TRIAGE_MODES = new Set(["auto", "rules", "", null, undefined]);
const LOCAL_TRUSTED_ACTORS = Object.freeze(["api", "cli", "ui"]);

function clean(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function classifyRoute(input = {}) {
  const decision = triageByRules(input);
  const effective = {
    workflow: decision.effectiveRoute.workflow,
    planMode: decision.effectiveRoute.planMode,
  };
  const protectedUpgrade = decision.protectedScopes.length > 0 || Boolean(decision.actualDiffRisk?.protected);

  return {
    ...decision,
    requested: protectedUpgrade ? decision.effectiveRoute : decision.requestedRoute,
    effective,
    workflow: effective.workflow,
    planMode: effective.planMode,
    protectedUpgrade,
    protectedKeywords: decision.protectedScopes.map((scope) => scope.scope),
  };
}

export function resolveTaskRoute({
  task,
  workflow = "standard",
  planMode = "auto",
  triageMode = "auto",
  workflowExplicit = false,
  planModeExplicit = false,
  actor = "api",
  labels = [],
  files = [],
  paths = [],
  title = null,
  body = null,
  commandText = null,
  trustedActors = LOCAL_TRUSTED_ACTORS,
}: Record<string, any> = {}) {
  const requestedWorkflow = clean(workflow, "standard");
  const requestedPlanMode = clean(planMode, "auto");
  const normalizedTriage = triageMode == null ? "auto" : String(triageMode).trim().toLowerCase();

  const shouldTriage =
    AUTO_TRIAGE_MODES.has(normalizedTriage) &&
    !workflowExplicit &&
    (!planModeExplicit || requestedPlanMode === "auto");

  if (!shouldTriage) {
    return {
      workflow: requestedWorkflow,
      planMode: requestedPlanMode,
      triageMode: normalizedTriage || "none",
      triageApplied: false,
      decision: null,
    };
  }

  const decision = classifyRoute({
    task,
    title,
    body,
    commandText,
    labels,
    files,
    paths,
    actor,
    trustedActors,
  });
  const ruleCategory = decision.ruleRoute?.category || decision.effectiveRoute?.category;
  if (ruleCategory === "unknown" && !decision.protectedUpgrade) {
    return {
      workflow: requestedWorkflow,
      planMode: requestedPlanMode,
      triageMode: normalizedTriage || "auto",
      triageApplied: false,
      decision,
    };
  }

  return {
    workflow: decision.workflow,
    planMode: decision.planMode,
    triageMode: normalizedTriage || "auto",
    triageApplied: true,
    decision,
  };
}
