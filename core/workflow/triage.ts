// @ts-nocheck
import { triageByRules } from "../triage/rules.js";

export function classifyRoute(input = {}) {
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
