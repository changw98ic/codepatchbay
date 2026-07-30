import { recordValue, type LooseRecord } from "../../shared/types.js";
import { getCapability, listAgents } from "./registry.js";
import {
  normalizeProviderConfig,
  providerKeyForDescriptor,
  providerVariantFromKey,
} from "./provider-config.js";
import { configuredProviderForKey } from "./provider-catalog.js";

const MIN_SAMPLES = 12;
const MIN_CONFIDENCE = 0.6;
const MIN_BASELINE_SAMPLES = 8;
const MIN_BASELINE_CONFIDENCE = 0.3;
const MIN_SCORE = 0.65;
const MIN_MARGIN = 0.08;

const CATEGORY_PATTERNS: Array<[string, RegExp]> = [
  ["security", /\b(?:security|vulnerab|cve-|auth(?:entication|orization)?|permission|secret|token)\b/i],
  ["docs", /\b(?:docs?|documentation|readme|changelog|typo)\b/i],
  ["test", /\b(?:tests?|testing|specs?|flaky|coverage)\b/i],
  ["frontend", /\b(?:frontend|react|vue|svelte|css|html|browser|ui|ux)\b/i],
  ["infra", /\b(?:infra|docker|kubernetes|terraform|deploy|ci|workflow|build pipeline)\b/i],
  ["research", /\b(?:research|investigate|analy[sz]e|compare|benchmark)\b/i],
  ["review", /\b(?:review|audit|critique)\b/i],
  ["bugfix", /\b(?:bug|fix|broken|regression|error|failure|incorrect|crash)\b/i],
  ["backend", /\b(?:backend|api|server|database|migration|queue|worker|runtime|cli)\b/i],
];

type OutcomeMetrics = LooseRecord & {
  agent?: string;
  providerKey?: string | null;
  providerFamily?: string | null;
  sampleSize?: number;
  successes?: number;
  retries?: number;
  timeouts?: number;
  verifierRuns?: number;
  verifierPasses?: number;
  evidenceCoverage?: number;
  scopeConfidence?: number;
  scope?: string;
  failureKinds?: LooseRecord;
};

type CandidateScore = {
  agent: string;
  providerKey: string | null;
  providerFamily: string;
  sampleSize: number;
  value: number;
  confidence: number;
  eligible: boolean;
  scope: string | null;
  components: {
    successRate: number;
    verifierPassRate: number;
    retryRate: number;
    timeoutRate: number;
    successLowerBound: number;
    verifierLowerBound: number;
    evidenceCoverage: number;
    scopeConfidence: number;
  };
  failureKinds: LooseRecord;
  reasons: string[];
};

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function ratio(numerator: number, denominator: number, fallback = 0): number {
  return denominator > 0 ? clamp01(numerator / denominator) : fallback;
}

function wilsonLowerBound(successes: number, total: number, z = 1.281551565545): number {
  if (total <= 0) return 0;
  const p = ratio(successes, total);
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return clamp01((centre - spread) / denominator);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function agentName(value: unknown): string | null {
  if (typeof value === "string") return text(value);
  const record = recordValue(value);
  return text(record.agent) || text(record.name);
}

export function normalizeAllowedAgentNames(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(agentName).filter((name): name is string => Boolean(name)))];
}

export function resolveAllowedAgentNames(...contexts: unknown[]): string[] | null {
  for (const context of contexts) {
    const source = recordValue(context);
    const policy = recordValue(source.agentPolicy);
    if (!Object.prototype.hasOwnProperty.call(policy, "allowedAgents")) continue;
    return normalizeAllowedAgentNames(policy.allowedAgents) || [];
  }
  return null;
}

/**
 * Registry-declared tie-break priority for an agent, or null when the registry
 * is not yet loaded or the agent is unknown. Callers fall back to the
 * deterministic literal/regex heuristic in every null case, so behavior is
 * preserved in unit tests that never load the registry.
 */
function registryTieBreakPriority(agent: string): number | null {
  try {
    return getCapability(agent)?.tieBreakPriority ?? null;
  } catch {
    // Registry not loaded — fall through to the deterministic tie-break below.
    return null;
  }
}

function rankPolicyCandidates(candidates: CandidateScore[]): CandidateScore | null {
  return [...candidates].sort((a, b) => {
    if (b.eligible !== a.eligible) return Number(b.eligible) - Number(a.eligible);
    if (b.value !== a.value) return b.value - a.value;
    const pa = registryTieBreakPriority(a.agent);
    const pb = registryTieBreakPriority(b.agent);
    if (pa !== null && pb !== null && pa !== pb) return pa - pb;
    // Deterministic fallback when the registry cannot rank the pair. The
    // descriptor's tieBreakPriority is authoritative whenever available;
    // unknown agents use stable lexical ordering rather than a provider name.
    return a.agent.localeCompare(b.agent);
  })[0] || null;
}

export function providerFamilyFor(agent: unknown, providerKey: unknown = null): string {
  // An execution provider key may identify a variant that is not the same as
  // the public agent descriptor (for example claude + claude:glm). Resolve an
  // exact registry provider-key match before falling back to the base agent.
  const key = (text(providerKey) || "").toLowerCase();
  if (key) {
    const configured = configuredProviderForKey(text(providerKey));
    const configuredFamily = configured ? text(configured.config.family) || text(configured.config.providerFamily) : null;
    if (configuredFamily) return configuredFamily;
    try {
      const descriptors = listAgents();
      // Prefer an exact configured identity. Multiple descriptors may use the
      // same key template (for example `vendor:${variant}`), so a generic
      // template match must never let the first descriptor claim another
      // descriptor's canonical variant.
      for (const descriptor of descriptors) {
        const name = typeof descriptor?.name === "string" ? descriptor.name : "";
        if (!name) continue;
        if (providerKeyForDescriptor(name, descriptor).toLowerCase() !== key) continue;
        const family = getCapability(name)?.providerFamily;
        if (family) return family;
      }
      for (const descriptor of listAgents()) {
        const name = typeof descriptor?.name === "string" ? descriptor.name : "";
        if (!name) continue;
        const configuredVariant = providerVariantFromKey(name, descriptor, key);
        const config = normalizeProviderConfig(name, descriptor);
        const canonicalVariant = config.variant?.toLowerCase() || "";
        if (!config.keyTemplate || !configuredVariant || (
          configuredVariant.toLowerCase() !== canonicalVariant
          && !config.variantAliases.includes(configuredVariant.toLowerCase())
        )) continue;
        const family = getCapability(name)?.providerFamily;
        if (family) return family;
      }
    } catch {
      // Registry not loaded — use the stable provider-key heuristic below.
    }
  }

  // Known provider-key variants must take precedence over the base descriptor
  // family even when no separate descriptor advertises the exact key.
  if (key === "claude:glm" || key.startsWith("glm:") || key.startsWith("zhipu:")) return "glm";
  if (key.startsWith("claude:mimo") || key.startsWith("mimo:") || key.startsWith("xiaomi:")) return "mimo";

  const resolved = agentName(agent);
  if (resolved) {
    try {
      const family = getCapability(resolved)?.providerFamily;
      if (family) return family;
    } catch {
      // Registry not loaded — fall through to the regex heuristic below.
    }
  }
  // Regex heuristic over providerKey / agent name (registry-not-loaded path).
  const name = (agentName(agent) || "unknown").toLowerCase();
  if (key === "claude:glm" || key.startsWith("glm:") || key.startsWith("zhipu:") || name === "claude-glm" || name.startsWith("glm-")) return "glm";
  if (key.startsWith("claude:") || key.startsWith("anthropic:") || key === "anthropic" || name === "claude" || name.startsWith("claude-")) return "claude";
  if (key.startsWith("codex:") || key.startsWith("openai:") || key === "openai" || name === "codex" || name.startsWith("codex-") || name === "openai") return "codex";
  if (key.includes(":")) return key.split(":", 1)[0] || name;
  return key || name;
}

export function classifyRoutingTaskCategory(task: unknown, sourceContext: unknown = {}): string {
  const source = recordValue(sourceContext);
  const routingDecision = recordValue(source.routingDecision || source.routing);
  const explicit = text(source.taskCategory)
    || text(source.routingCategory)
    || text(source.category)
    || text(routingDecision.category);
  if (explicit) return explicit.toLowerCase();
  const taskText = String(task || "");
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(taskText)) return category;
  }
  return "unknown";
}

export function scoreOutcomeMetrics(agent: string, rawMetrics: unknown, role: string): CandidateScore {
  const metrics = recordValue(rawMetrics) as OutcomeMetrics;
  const sampleSize = Math.max(0, Math.floor(finite(metrics.sampleSize)));
  const successes = Math.max(0, finite(metrics.successes));
  const retries = Math.max(0, finite(metrics.retries));
  const timeouts = Math.max(0, finite(metrics.timeouts));
  const verifierRuns = Math.max(0, finite(metrics.verifierRuns));
  const verifierPasses = Math.max(0, finite(metrics.verifierPasses));
  const successRate = ratio(successes, sampleSize, 0.5);
  const retryRate = ratio(retries, sampleSize);
  const timeoutRate = ratio(timeouts, sampleSize);
  const verifierPassRate = ratio(verifierPasses, verifierRuns, role === "executor" ? 0 : successRate);
  const evidenceCoverage = clamp01(
    finite(metrics.evidenceCoverage, role === "executor" ? ratio(verifierRuns, sampleSize) : 1),
  );
  const scopeConfidence = clamp01(finite(metrics.scopeConfidence, 1));
  const successLowerBound = wilsonLowerBound(successes, sampleSize);
  const verifierLowerBound = role === "executor"
    ? wilsonLowerBound(verifierPasses, verifierRuns)
    : successLowerBound;
  const value = clamp01(
    successLowerBound * 0.45
    + verifierLowerBound * 0.35
    + (1 - retryRate) * 0.1
    + (1 - timeoutRate) * 0.1,
  );
  const confidence = clamp01(Math.min(1, sampleSize / 20) * evidenceCoverage * scopeConfidence);
  const reasons: string[] = [];
  if (sampleSize < MIN_SAMPLES) reasons.push(`sample_size:${sampleSize}<${MIN_SAMPLES}`);
  if (confidence < MIN_CONFIDENCE) reasons.push(`confidence:${confidence.toFixed(3)}<${MIN_CONFIDENCE}`);
  if (role === "executor" && verifierRuns < Math.ceil(MIN_SAMPLES * 0.6)) {
    reasons.push(`verifier_runs:${verifierRuns}<${Math.ceil(MIN_SAMPLES * 0.6)}`);
  }
  if (value < MIN_SCORE) reasons.push(`score:${value.toFixed(3)}<${MIN_SCORE}`);

  return {
    agent,
    providerKey: text(metrics.providerKey),
    providerFamily: text(metrics.providerFamily) || providerFamilyFor(agent, metrics.providerKey),
    sampleSize,
    value,
    confidence,
    eligible: reasons.length === 0,
    scope: text(metrics.scope),
    components: {
      successRate,
      verifierPassRate,
      retryRate,
      timeoutRate,
      successLowerBound,
      verifierLowerBound,
      evidenceCoverage,
      scopeConfidence,
    },
    failureKinds: recordValue(metrics.failureKinds),
    reasons,
  };
}

export function selectOutcomeAwareAgent({
  preferredAgent,
  candidateAgents = [],
  allowedAgents = null,
  metrics = {},
  role,
  locked = false,
  excludedProviderFamily = null,
}: {
  preferredAgent: unknown;
  candidateAgents?: unknown[];
  allowedAgents?: unknown;
  metrics?: unknown;
  role: string;
  locked?: boolean;
  excludedProviderFamily?: string | null;
}) {
  const preferred = agentName(preferredAgent);
  const metricMap = recordValue(recordValue(metrics).agents || metrics);
  const normalizedAllowedAgents = normalizeAllowedAgentNames(allowedAgents);
  const allowedSet = normalizedAllowedAgents === null ? null : new Set(normalizedAllowedAgents);
  const names = [...new Set([
    preferred,
    ...candidateAgents.map(agentName),
    ...(normalizedAllowedAgents || []),
    ...Object.keys(metricMap),
  ].filter((value): value is string => Boolean(value)))]
    .filter((name) => allowedSet === null || allowedSet.has(name));
  const candidates = names.map((name) => scoreOutcomeMetrics(name, metricMap[name], role));
  const baseline = candidates.find((candidate) => candidate.agent === preferred) || null;
  const excludedFamily = text(excludedProviderFamily)?.toLowerCase() || null;
  const independentCandidates = excludedFamily
    ? candidates.filter((candidate) => candidate.providerFamily !== excludedFamily)
    : candidates;
  const preferredAllowed = preferred !== null && (allowedSet === null || allowedSet.has(preferred));
  const preferredFamily = baseline?.providerFamily || providerFamilyFor(preferred);

  if (!preferredAllowed) {
    if (locked) {
      return {
        preferredAgent: preferred,
        selectedAgent: null,
        applied: false,
        independenceApplied: false,
        independenceConflict: false,
        agentPolicyApplied: false,
        agentPolicyConflict: true,
        allowedAgents: normalizedAllowedAgents,
        excludedProviderFamily: excludedFamily,
        reason: `required agent ${preferred || "unknown"} is outside allowed agent policy`,
        candidates,
        thresholds: routingThresholds(),
      };
    }
    const selected = rankPolicyCandidates(independentCandidates);
    return {
      preferredAgent: preferred,
      selectedAgent: selected?.agent || null,
      applied: Boolean(selected),
      independenceApplied: Boolean(selected && excludedFamily),
      independenceConflict: Boolean(excludedFamily && !selected),
      agentPolicyApplied: Boolean(selected),
      agentPolicyConflict: !selected,
      allowedAgents: normalizedAllowedAgents,
      excludedProviderFamily: excludedFamily,
      reason: selected
        ? `allowed agent policy selected ${selected.agent} over ${preferred || "unknown"}`
        : `allowed agent policy has no eligible candidate for ${preferred || "unknown"}`,
      candidates,
      thresholds: routingThresholds(),
    };
  }

  if (excludedFamily && preferredFamily === excludedFamily) {
    const selected = rankPolicyCandidates(independentCandidates);
    return {
      preferredAgent: preferred,
      selectedAgent: selected?.agent || preferred,
      applied: Boolean(selected),
      independenceApplied: Boolean(selected),
      independenceConflict: !selected,
      agentPolicyApplied: false,
      agentPolicyConflict: false,
      allowedAgents: normalizedAllowedAgents,
      excludedProviderFamily: excludedFamily,
      reason: selected
        ? `independent verifier required: excluded provider family ${excludedFamily}`
        : `independent verifier unavailable: no candidate outside provider family ${excludedFamily}`,
      candidates,
      thresholds: routingThresholds(),
    };
  }

  if (excludedFamily && preferred) {
    return {
      preferredAgent: preferred,
      selectedAgent: preferred,
      applied: false,
      independenceApplied: true,
      independenceConflict: false,
      agentPolicyApplied: false,
      agentPolicyConflict: false,
      allowedAgents: normalizedAllowedAgents,
      excludedProviderFamily: excludedFamily,
      reason: `configured verifier is already outside provider family ${excludedFamily}`,
      candidates,
      thresholds: routingThresholds(),
    };
  }

  if (locked) {
    return {
      preferredAgent: preferred,
      selectedAgent: preferred,
      applied: false,
      independenceApplied: false,
      independenceConflict: false,
      agentPolicyApplied: false,
      agentPolicyConflict: false,
      allowedAgents: normalizedAllowedAgents,
      excludedProviderFamily: excludedFamily,
      reason: "required dynamic agent is locked",
      candidates,
      thresholds: routingThresholds(),
    };
  }

  if (!baseline || baseline.sampleSize < MIN_BASELINE_SAMPLES || baseline.confidence < MIN_BASELINE_CONFIDENCE) {
    return {
      preferredAgent: preferred,
      selectedAgent: preferred,
      applied: false,
      independenceApplied: false,
      independenceConflict: false,
      agentPolicyApplied: false,
      agentPolicyConflict: false,
      allowedAgents: normalizedAllowedAgents,
      excludedProviderFamily: excludedFamily,
      reason: "insufficient baseline evidence; preserve configured agent",
      candidates,
      thresholds: routingThresholds(),
    };
  }

  const best = independentCandidates
    .filter((candidate) => candidate.agent !== preferred && candidate.eligible)
    .sort((a, b) => b.value - a.value || b.confidence - a.confidence)[0] || null;
  if (!best || best.value < baseline.value + MIN_MARGIN) {
    return {
      preferredAgent: preferred,
      selectedAgent: preferred,
      applied: false,
      independenceApplied: false,
      independenceConflict: false,
      agentPolicyApplied: false,
      agentPolicyConflict: false,
      allowedAgents: normalizedAllowedAgents,
      excludedProviderFamily: excludedFamily,
      reason: best
        ? `candidate margin ${(best.value - baseline.value).toFixed(3)} below ${MIN_MARGIN}`
        : "no eligible outcome candidate",
      candidates,
      thresholds: routingThresholds(),
    };
  }

  return {
    preferredAgent: preferred,
    selectedAgent: best.agent,
    applied: true,
    independenceApplied: false,
    independenceConflict: false,
    agentPolicyApplied: false,
    agentPolicyConflict: false,
    allowedAgents: normalizedAllowedAgents,
    excludedProviderFamily: excludedFamily,
    reason: `outcome evidence selected ${best.agent} over ${preferred}`,
    candidates,
    thresholds: routingThresholds(),
  };
}

function routingThresholds() {
  return {
    minSamples: MIN_SAMPLES,
    minConfidence: MIN_CONFIDENCE,
    minBaselineSamples: MIN_BASELINE_SAMPLES,
    minBaselineConfidence: MIN_BASELINE_CONFIDENCE,
    minScore: MIN_SCORE,
    minMargin: MIN_MARGIN,
  };
}
