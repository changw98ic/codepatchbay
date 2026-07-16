import { recordValue, type LooseRecord } from "../../shared/types.js";
import {
  mergeRoutePolicy,
  normalizeActorTrust,
  normalizeProtectedScopes,
  normalizeRoute,
} from "./schema.js";

const DOC_KEYWORDS = [
  /\bdocs?\b/i,
  /\bdocumentation\b/i,
  /\breadme\b/i,
  /\btypos?\b/i,
  /\bchangelog\b/i,
];

const TEST_KEYWORDS = [
  /\btests?\b/i,
  /\btesting\b/i,
  /\bspecs?\b/i,
  /\bci\b/i,
];

const IMPLEMENTATION_VERBS = [
  /\bimplement\b/i,
  /\bbuild\b/i,
  /\bcreate\b/i,
  /\badd\b/i,
  /\bdevelop\b/i,
  /\bcomplete\b/i,
  /\bextend\b/i,
  /\brefactor\b/i,
];

const COMPLEX_IMPLEMENTATION_OBJECTS = [
  /\bapis?\b/i,
  /\bcli\b/i,
  /\bfinali[sz]er\b/i,
  /\breview bundle\b/i,
  /\blocal-only\b/i,
  /\bworkbench\b/i,
  /\bmulti-project\b/i,
  /\bproject-scoped\b/i,
  /\bqueue\b/i,
  /\bworker\b/i,
  /\borchestrator\b/i,
  /\bfrontend\b/i,
  /\bbackend\b/i,
  /\bintegration\b/i,
  /\bend-to-end\b/i,
  /\bfull[- ]?link\b/i,
  /\bphase \d+\b/i,
];

const PROTECTED_RULES = [
  {
    scope: "security",
    severity: "standard",
    patterns: [/\bsecurity\b/i, /\bvulnerab/i, /\bcve-\d+/i, /\bsecrets?\b/i, /\btoken\b/i, /\bpasswords?\b/i],
    filePatterns: [/security/i, /secret/i, /token/i, /password/i],
  },
  {
    scope: "auth",
    severity: "critical",
    patterns: [/\bauth(?:n|z|entication|orization)?\b/i, /\blogin\b/i, /\boauth\b/i, /\bsession\b/i],
    filePatterns: [/auth/i, /login/i, /oauth/i, /session/i],
  },
  {
    scope: "db",
    severity: "standard",
    patterns: [/\bdb\b/i, /\bdatabase\b/i, /\bmigrations?\b/i, /\bschema\b/i, /\bsql\b/i],
    filePatterns: [/db/i, /database/i, /migration/i, /schema/i, /\.sql$/i],
  },
  {
    scope: "payment",
    severity: "critical",
    patterns: [/\bpayments?\b/i, /\bbilling\b/i, /\bstripe\b/i],
    filePatterns: [/payment/i, /billing/i, /stripe/i],
  },
];

function hasName(value: unknown): value is { name: unknown } {
  return typeof value === "object" && value !== null && "name" in value;
}

function normalizeLabels(labels: unknown = []) {
  return Array.isArray(labels)
    ? labels
      .map((label) => (typeof label === "string" ? label : hasName(label) ? label.name : undefined))
      .filter(Boolean)
      .map((label) => String(label).trim().toLowerCase())
    : [];
}

function textInput(input: LooseRecord = {}) {
  return [
    ...normalizeLabels(input.labels),
    input.title,
    input.body,
    input.task,
    input.commandText,
  ].filter(Boolean).join(" ");
}

function includesLabel(labels: unknown, expected: string) {
  return normalizeLabels(labels).includes(expected);
}

function matchesAny(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

function isComplexImplementationTask(text: string) {
  return matchesAny(text, IMPLEMENTATION_VERBS) && matchesAny(text, COMPLEX_IMPLEMENTATION_OBJECTS);
}

function changedFiles(input: LooseRecord = {}) {
  if (Array.isArray(input.changedFiles)) return input.changedFiles;
  if (Array.isArray(input.files)) return input.files;
  if (Array.isArray(input.paths)) return input.paths;
  return [];
}

export function detectProtectedScopes(input: LooseRecord = {}) {
  const text = textInput(input);
  const files = changedFiles(input).map((file) => String(file || ""));
  const scopes = [];

  for (const rule of PROTECTED_RULES) {
    const textMatch = rule.patterns.find((pattern) => pattern.test(text));
    const fileMatch = files.find((file) => rule.filePatterns.some((pattern) => pattern.test(file)));
    if (!textMatch && !fileMatch) continue;
    scopes.push({
      scope: rule.scope,
      severity: rule.severity || "standard",
      reason: fileMatch ? `protected file path: ${fileMatch}` : `protected keyword: ${rule.scope}`,
      signals: [textMatch?.source || null, fileMatch || null].filter(Boolean),
    });
  }

  return normalizeProtectedScopes(scopes);
}

export function actualDiffRiskGuard(input: LooseRecord = {}) {
  const files = changedFiles(input);
  const protectedScopes = detectProtectedScopes({ files });
  return {
    protectedScopes,
    actualDiffRisk: {
      protected: protectedScopes.length > 0,
      files,
      reason: protectedScopes.length > 0
        ? "changed files touch protected scopes"
        : "no changed-file protected scope match",
    },
  };
}

export function classifyIssueRules(input: LooseRecord = {}) {
  const requestedRoute = recordValue(input.requestedRoute);
  const labels = normalizeLabels(input.labels);
  const text = textInput(input);
  const reasons = [];
  let route;

  if (isComplexImplementationTask(text)) {
    route = {
      category: "implementation",
      workflow: "standard",
      planMode: "full",
      reason: "complex implementation signal",
      source: "rules",
    };
  } else if (matchesAny(text, DOC_KEYWORDS)) {
    route = {
      category: "docs",
      workflow: "direct",
      planMode: "light",
      reason: "docs keyword",
      source: "rules",
    };
  } else if (matchesAny(text, TEST_KEYWORDS)) {
    route = {
      category: "test",
      workflow: "direct",
      planMode: "light",
      reason: "test keyword",
      source: "rules",
    };
  } else {
    route = {
      category: "unknown",
      workflow: "standard",
      planMode: "light",
      reason: "default unknown route",
      source: "rules",
    };
  }

  reasons.push(route.reason);
  const protectedScopes = detectProtectedScopes(input);
  if (protectedScopes.length > 0) reasons.push("protected scope detected");
  const diffGuard = actualDiffRiskGuard({ files: changedFiles(input) });

  return {
    ruleRoute: normalizeRoute(route),
    requestedRoute: normalizeRoute(requestedRoute || route, {
      ...route,
      source: requestedRoute.source || route.source,
    }),
    protectedScopes: normalizeProtectedScopes([
      ...protectedScopes,
      ...diffGuard.protectedScopes,
    ]),
    actualDiffRisk: diffGuard.actualDiffRisk,
    actorTrust: normalizeActorTrust(input),
    reasons,
  };
}

export function triageByRules(input: LooseRecord = {}) {
  const rules = classifyIssueRules(input);
  return mergeRoutePolicy({
    ...rules,
    requestedRoute: recordValue(input.requestedRoute) || rules.requestedRoute,
    reasons: rules.reasons,
  });
}
