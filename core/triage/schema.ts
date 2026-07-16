import type { LooseRecord } from "../../shared/types.js";
export const WORKFLOWS = new Set(["direct", "standard", "complex", "blocked"]);
export const PLAN_MODES = new Set(["none", "light", "full", "parent"]);

const WORKFLOW_RANK: Record<string, number> = {
  direct: 0,
  standard: 1,
  complex: 2,
  blocked: 3,
};

const PLAN_MODE_RANK: Record<string, number> = {
  none: 0,
  light: 1,
  parent: 2,
  full: 3,
};

const WORKFLOW_DEFAULT_PLAN_MODE: Record<string, string> = {
  direct: "none",
  standard: "full",
  complex: "full",
  blocked: "none",
};

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const SAFE_DEFAULT_ROUTE = Object.freeze({
  category: "unknown",
  workflow: "standard",
  planMode: "full",
  reviewer: false,
  reason: "safe default route",
  source: "policy",
});

function cleanString(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

export function defaultPlanModeForWorkflow(workflow: string) {
  return WORKFLOW_DEFAULT_PLAN_MODE[workflow] || "light";
}

export function scopesContainCritical(protectedScopes: (string | LooseRecord)[] = []) {
  return (protectedScopes || []).some((scope) => typeof scope === "object" && scope !== null && scope.severity === "critical");
}

export function normalizeActorTrust({
  actor = null,
  actorName = null,
  trustedActors = [],
  authorAssociation = null,
} = {}) {
  const name = cleanString(actor) || cleanString(actorName);
  const trustedSet = new Set((trustedActors || [])
    .map((candidate) => String(candidate ?? "").trim().toLowerCase())
    .filter(Boolean));
  const association = String(authorAssociation || "").trim().toUpperCase();

  if (name && trustedSet.has(name.toLowerCase())) {
    return { actor: name, level: "trusted", trusted: true, reason: "trusted actor list" };
  }
  if (TRUSTED_ASSOCIATIONS.has(association)) {
    return { actor: name, level: "trusted", trusted: true, reason: `author association ${association}` };
  }
  if (name && (/\[bot\]$/i.test(name) || /bot$/i.test(name))) {
    return { actor: name, level: "bot", trusted: false, reason: "bot actor" };
  }
  return { actor: name, level: "unknown", trusted: false, reason: "no trust signal" };
}

type NormalizedRoute = {
  category: string;
  workflow: string;
  planMode: string;
  reviewer: boolean;
  reason: string;
  source: string;
};

export function normalizeRoute(route: LooseRecord = {}, defaults: LooseRecord = {}): NormalizedRoute {
  const routeWorkflow = typeof route.workflow === "string" ? route.workflow : undefined;
  const defaultsWorkflow = typeof defaults.workflow === "string" ? defaults.workflow : undefined;
  const routePlanMode = typeof route.planMode === "string" ? route.planMode : undefined;
  const defaultsPlanMode = typeof defaults.planMode === "string" ? defaults.planMode : undefined;
  const defaultsCategory = typeof defaults.category === "string" ? defaults.category : undefined;
  const defaultsReason = typeof defaults.reason === "string" ? defaults.reason : undefined;
  const defaultsSource = typeof defaults.source === "string" ? defaults.source : undefined;

  const fallbackWorkflow = defaultsWorkflow && WORKFLOWS.has(defaultsWorkflow)
    ? defaultsWorkflow
    : "standard";
  const workflow: string = routeWorkflow && WORKFLOWS.has(routeWorkflow) ? routeWorkflow : fallbackWorkflow;
  const fallbackPlanMode = defaultsPlanMode && PLAN_MODES.has(defaultsPlanMode)
    ? defaultsPlanMode
    : defaultPlanModeForWorkflow(workflow);
  const planMode: string = routePlanMode && PLAN_MODES.has(routePlanMode) ? routePlanMode : fallbackPlanMode;

  return {
    category: cleanString(route?.category) || defaultsCategory || workflow,
    workflow,
    planMode,
    reviewer: Boolean(route?.reviewer || workflow === "complex" || defaults.reviewer),
    reason: cleanString(route?.reason) || defaultsReason || "route policy",
    source: cleanString(route?.source) || defaultsSource || "rules",
  };
}

export function routeStrength(route = {}) {
  const normalized = normalizeRoute(route);
  return Math.max(
    WORKFLOW_RANK[normalized.workflow] ?? WORKFLOW_RANK.standard,
    PLAN_MODE_RANK[normalized.planMode] ?? PLAN_MODE_RANK.light,
    normalized.reviewer ? WORKFLOW_RANK.complex : 0,
  );
}

export function isRouteDowngrade(candidate: NormalizedRoute, current: NormalizedRoute) {
  return routeStrength(candidate) < routeStrength(current);
}

export function normalizeProtectedScopes(scopes: LooseRecord[] = []) {
  const byScope = new Map();
  for (const scope of scopes || []) {
    const name = cleanString(scope?.scope || scope);
    if (!name) continue;
    const existing = byScope.get(name) || {
      scope: name,
      severity: scope?.severity || "standard",
      reason: cleanString(scope?.reason) || "protected scope",
      signals: [],
    };
    if (scope?.severity === "critical" || existing.severity === "critical") {
      existing.severity = "critical";
    }
    const signals = Array.isArray(scope?.signals) ? scope.signals : [];
    for (const signal of signals) {
      const text = cleanString(signal);
      if (text && !existing.signals.includes(text)) existing.signals.push(text);
    }
    byScope.set(name, existing);
  }
  return [...byScope.values()];
}

function actualDiffProtected(actualDiffRisk: LooseRecord) {
  return Boolean(actualDiffRisk?.protected || actualDiffRisk?.risk === "protected");
}

function strongerRoute(a: NormalizedRoute, b: NormalizedRoute): NormalizedRoute {
  return routeStrength(b) >= routeStrength(a) ? b : a;
}

interface MergeRoutePolicyInput {
  ruleRoute?: LooseRecord;
  requestedRoute?: LooseRecord;
  acpRoute?: LooseRecord | null;
  actorTrust?: LooseRecord;
  protectedScopes?: LooseRecord[];
  actualDiffRisk?: LooseRecord | null;
  reasons?: string[];
}

export function mergeRoutePolicy({
  ruleRoute,
  requestedRoute,
  acpRoute = null,
  actorTrust,
  protectedScopes = [],
  actualDiffRisk = null,
  reasons = [],
}: MergeRoutePolicyInput = {}) {
  const base = normalizeRoute(SAFE_DEFAULT_ROUTE);
  const rule = normalizeRoute(ruleRoute || base, {
    ...base,
    source: ruleRoute?.source || "rules",
  });
  const requested = normalizeRoute(requestedRoute || rule, {
    ...rule,
    source: requestedRoute?.source || rule.source || "rules",
  });
  const acp = acpRoute ? normalizeRoute(acpRoute, { ...rule, source: "acp" }) : null;
  const trust = actorTrust || normalizeActorTrust();
  const scopes = normalizeProtectedScopes(protectedScopes);
  const diffRisk = actualDiffRisk || { protected: false, files: [], reason: "no changed-file risk signal" };
  const downgradeAllowed = Boolean(trust.trusted && scopes.length === 0 && !actualDiffProtected(diffRisk));

  let effective = base;
  const policyReasons = [base.reason, ...(reasons || [])].filter(Boolean);

  const candidates: NormalizedRoute[] = [rule, requested, acp].filter((candidate): candidate is NormalizedRoute => Boolean(candidate));
  for (const candidate of candidates) {
    if (!isRouteDowngrade(candidate, effective)) {
      effective = strongerRoute(effective, candidate);
      if (candidate.reason) policyReasons.push(candidate.reason);
      continue;
    }
    if (downgradeAllowed) {
      effective = candidate;
      policyReasons.push(`trusted downgrade accepted: ${candidate.reason}`);
    } else {
      policyReasons.push(`downgrade blocked from ${candidate.source}`);
    }
  }

  if (scopes.length > 0 || actualDiffProtected(diffRisk)) {
    effective = normalizeRoute({
      category: "protected",
      workflow: "complex",
      planMode: "full",
      reviewer: true,
      source: "policy",
      reason: scopes.length > 0 ? "protected scope forced upgrade" : "changed-file risk forced upgrade",
    });
    policyReasons.push(effective.reason);
  }

  return {
    schemaVersion: 1,
    baseRoute: base,
    ruleRoute: rule,
    requestedRoute: requested,
    acpRoute: acp,
    effectiveRoute: effective,
    actorTrust: trust,
    downgradeAllowed,
    protectedScopes: scopes,
    actualDiffRisk: diffRisk,
    reasons: [...new Set(policyReasons.filter(Boolean))],
  };
}
