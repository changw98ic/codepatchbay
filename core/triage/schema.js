export const WORKFLOWS = new Set(["direct", "standard", "complex", "sdd-standard", "blocked"]);
export const PLAN_MODES = new Set(["none", "light", "full", "parent"]);

const WORKFLOW_RANK = {
  direct: 0,
  standard: 1,
  "sdd-standard": 2,
  complex: 3,
  blocked: 4,
};

const PLAN_MODE_RANK = {
  none: 0,
  light: 1,
  parent: 2,
  full: 3,
};

const WORKFLOW_DEFAULT_PLAN_MODE = {
  direct: "none",
  standard: "light",
  "sdd-standard": "parent",
  complex: "full",
  blocked: "none",
};

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const SAFE_DEFAULT_ROUTE = Object.freeze({
  category: "unknown",
  workflow: "standard",
  planMode: "light",
  reviewer: false,
  reason: "safe default route",
  source: "policy",
});

function cleanString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

export function defaultPlanModeForWorkflow(workflow) {
  return WORKFLOW_DEFAULT_PLAN_MODE[workflow] || "light";
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

export function normalizeRoute(route = {}, defaults = {}) {
  const fallbackWorkflow = defaults.workflow && WORKFLOWS.has(defaults.workflow)
    ? defaults.workflow
    : "standard";
  const workflow = WORKFLOWS.has(route?.workflow) ? route.workflow : fallbackWorkflow;
  const fallbackPlanMode = defaults.planMode && PLAN_MODES.has(defaults.planMode)
    ? defaults.planMode
    : defaultPlanModeForWorkflow(workflow);
  const planMode = PLAN_MODES.has(route?.planMode) ? route.planMode : fallbackPlanMode;

  return {
    category: cleanString(route?.category) || defaults.category || workflow,
    workflow,
    planMode,
    reviewer: Boolean(route?.reviewer || workflow === "complex" || defaults.reviewer),
    reason: cleanString(route?.reason) || defaults.reason || "route policy",
    source: cleanString(route?.source) || defaults.source || "rules",
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

export function isRouteDowngrade(candidate, current) {
  return routeStrength(candidate) < routeStrength(current);
}

export function normalizeProtectedScopes(scopes = []) {
  const byScope = new Map();
  for (const scope of scopes || []) {
    const name = cleanString(scope?.scope || scope);
    if (!name) continue;
    const existing = byScope.get(name) || {
      scope: name,
      reason: cleanString(scope?.reason) || "protected scope",
      signals: [],
    };
    const signals = Array.isArray(scope?.signals) ? scope.signals : [];
    for (const signal of signals) {
      const text = cleanString(signal);
      if (text && !existing.signals.includes(text)) existing.signals.push(text);
    }
    byScope.set(name, existing);
  }
  return [...byScope.values()];
}

function actualDiffProtected(actualDiffRisk) {
  return Boolean(actualDiffRisk?.protected || actualDiffRisk?.risk === "protected");
}

function strongerRoute(a, b) {
  return routeStrength(b) >= routeStrength(a) ? b : a;
}

export function mergeRoutePolicy({
  ruleRoute,
  requestedRoute,
  acpRoute = null,
  actorTrust,
  protectedScopes = [],
  actualDiffRisk = null,
  reasons = [],
} = {}) {
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

  for (const candidate of [rule, requested, acp].filter(Boolean)) {
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
