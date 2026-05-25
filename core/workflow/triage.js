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

const PROTECTED_KEYWORDS = [
  /\bsecurity\b/i,
  /\bauth(?:n|z|entication|orization)?\b/i,
  /\blogin\b/i,
  /\boauth\b/i,
  /\btoken\b/i,
  /\bsecrets?\b/i,
  /\bpasswords?\b/i,
  /\bdb\b/i,
  /\bdatabase\b/i,
  /\bmigrations?\b/i,
  /\bpayments?\b/i,
  /\bbilling\b/i,
  /\bstripe\b/i,
];

function normalizeLabels(labels = []) {
  return Array.isArray(labels)
    ? labels
      .map((label) => (typeof label === "string" ? label : label?.name))
      .filter(Boolean)
      .map((label) => String(label).trim().toLowerCase())
    : [];
}

function haystack({ labels = [], title = "", body = "" } = {}) {
  return [...normalizeLabels(labels), title, body].filter(Boolean).join(" ");
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function includesLabel(labels, expected) {
  const normalized = normalizeLabels(labels);
  return normalized.includes(expected);
}

function actorTrust({ actor = null, trustedActors = [], authorAssociation = null } = {}) {
  const actorName = String(actor || "").trim();
  const trustedSet = new Set((trustedActors || []).map((name) => String(name).trim().toLowerCase()));
  const association = String(authorAssociation || "").trim().toUpperCase();

  if (actorName && trustedSet.has(actorName.toLowerCase())) {
    return { actor: actorName, level: "trusted", trusted: true, reason: "trusted actor list" };
  }
  if (["OWNER", "MEMBER", "COLLABORATOR"].includes(association)) {
    return { actor: actorName || null, level: "trusted", trusted: true, reason: `author association ${association}` };
  }
  if (/\[bot\]$/i.test(actorName) || /bot$/i.test(actorName)) {
    return { actor: actorName, level: "bot", trusted: false, reason: "bot actor" };
  }
  return { actor: actorName || null, level: "unknown", trusted: false, reason: "no trust signal" };
}

function routeForInput(input) {
  const labels = normalizeLabels(input.labels);
  const text = haystack(input);

  if (includesLabel(labels, "sdd")) {
    return {
      category: "sdd",
      workflow: "sdd-standard",
      planMode: "parent",
      reason: "sdd label",
    };
  }

  if (matchesAny(text, DOC_KEYWORDS)) {
    return {
      category: "docs",
      workflow: "direct",
      planMode: "none",
      reason: "docs keyword",
    };
  }

  if (matchesAny(text, TEST_KEYWORDS)) {
    return {
      category: "test",
      workflow: "direct",
      planMode: "none",
      reason: "test keyword",
    };
  }

  return {
    category: "unknown",
    workflow: "standard",
    planMode: "light",
    reason: "default unknown route",
  };
}

export function classifyRoute(input = {}) {
  const text = haystack(input);
  const requestedBase = routeForInput(input);
  const trust = actorTrust(input);
  const protectedMatches = PROTECTED_KEYWORDS
    .filter((pattern) => pattern.test(text))
    .map((pattern) => pattern.source.replace(/\\b/g, "").replace(/\(\?:.*$/, ""));
  const protectedUpgrade = protectedMatches.length > 0;

  const requested = protectedUpgrade
    ? {
        category: "protected",
        workflow: "complex",
        planMode: "full",
        reviewer: true,
        reason: "protected keyword",
      }
    : requestedBase;

  return {
    requested,
    effective: {
      workflow: requested.workflow,
      planMode: requested.planMode,
    },
    protectedUpgrade,
    protectedKeywords: protectedMatches,
    actorTrust: trust,
    reasons: [requestedBase.reason, protectedUpgrade ? "forced protected upgrade" : null].filter(Boolean),
  };
}
