import { recordValue, type LooseRecord } from "../contracts/types.js";
import {
  defaultAgentForRole,
  getCapability,
  listAgents,
  providerRegistryEnabled,
} from "../agents/registry.js";

export type AssuranceAgent = string | {
  agent: string;
  variant?: string | null;
};

export type HighAssurancePolicy = {
  enabled: boolean;
  mode: "standard" | "high";
  planning: {
    candidates: [AssuranceAgent, AssuranceAgent];
    arbiter: AssuranceAgent;
    critiqueRounds: number;
  };
  execution: {
    agent: AssuranceAgent;
    required: boolean;
  };
  verification: {
    agent: AssuranceAgent;
    required: boolean;
    blind: boolean;
    independent: boolean;
  };
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeAgent(value: unknown, fallback: AssuranceAgent): AssuranceAgent {
  if (typeof value === "string" && value.trim()) return value.trim();
  const entry = recordValue(value);
  const agent = text(entry.agent) || text(entry.name);
  if (!agent) return fallback;
  const variant = text(entry.variant);
  return variant ? { agent, variant } : agent;
}

function assuranceRecord(ctx: LooseRecord): LooseRecord {
  const source = recordValue(ctx.sourceContext);
  return recordValue(ctx.assurance || source.assurance || recordValue(ctx.job).assurance);
}

function assuranceMode(ctx: LooseRecord, assurance: LooseRecord): "standard" | "high" {
  const hasExplicitEnv = ctx.env !== undefined && ctx.env !== null;
  const envMode = hasExplicitEnv
    ? text(recordValue(ctx.env).CPB_ASSURANCE_MODE)
    : text(process.env.CPB_ASSURANCE_MODE);
  const raw = text(assurance.mode)
    || text(ctx.assuranceMode)
    || envMode
    || "standard";
  return /^(?:high|high[_-]assurance|quality[_-]first)$/i.test(raw) ? "high" : "standard";
}

function boundedCritiqueRounds(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.max(1, Math.min(2, Math.floor(numeric)));
}

/**
 * Resolve a high-assurance fallback agent via the provider-capability registry
 * (B2c): the lowest-`tieBreakPriority` agent that owns `role`. The explicit
 * `legacy` literal survives both the `CPB_PROVIDER_REGISTRY=0` kill switch and
 * the "registry not loaded" case (e.g. unit tests that never call
 * `loadRegistry`), so callers see no behavior change unless the registry is
 * actually driving resolution.
 */
function registryRoleFallback(role: string, legacy: string): string {
  if (!providerRegistryEnabled()) return legacy;
  try {
    return defaultAgentForRole(role);
  } catch {
    return legacy;
  }
}

/**
 * Pure fail-closed predicate (B2c): whether at least one registered verifier
 * family differs from the execution agent's family. Extracted as a pure
 * function over family lists so the independence guarantee is unit-testable
 * without manipulating the global descriptor registry.
 */
export function hasDistinctFamilyVerifier(
  verifierFamilies: Array<string | null>,
  executionFamily: string | null,
): boolean {
  return verifierFamilies.some((family) => family !== executionFamily);
}

/**
 * Registry-backed projection of `hasDistinctFamilyVerifier`. Returns true
 * (no enforcement) when the kill switch is off or the registry is not loaded,
 * matching the pre-B2c behavior where no such check existed.
 */
function registryHasIndependentVerifier(executionAgentName: string): boolean {
  if (!providerRegistryEnabled()) return true;
  try {
    const execFamily = getCapability(executionAgentName)?.providerFamily ?? null;
    const verifierFamilies = listAgents()
      .filter((d) => Array.isArray(d.defaultRoles) && d.defaultRoles.includes("verifier"))
      .map((d) => getCapability(d.name)?.providerFamily ?? null);
    return hasDistinctFamilyVerifier(verifierFamilies, execFamily);
  } catch {
    // Registry not loaded — cannot enforce independence; legacy path allowed it.
    return true;
  }
}

export function resolveHighAssurancePolicy(ctx: LooseRecord = {}): HighAssurancePolicy {
  const assurance = assuranceRecord(ctx);
  const mode = assuranceMode(ctx, assurance);
  const planning = recordValue(assurance.planning);
  const execution = recordValue(assurance.execution);
  const verification = recordValue(assurance.verification);
  const rawCandidates = Array.isArray(planning.candidates) ? planning.candidates : [];
  // Ordinary agents/routing configuration must not silently redefine the
  // quality-first role split.  High-assurance overrides live only inside the
  // explicit assurance policy. The fallback literals are resolved through the
  // provider-capability registry (B2c): codex wins planner/verifier (priority
  // 10) and claude wins executor (priority 20). CPB_PROVIDER_REGISTRY=0 keeps
  // the legacy "codex"/"claude-glm" literals.
  const candidateA = normalizeAgent(rawCandidates[0] || planning.candidateA, registryRoleFallback("planner", "codex"));
  const candidateB = normalizeAgent(rawCandidates[1] || planning.candidateB, registryRoleFallback("executor", "claude-glm"));
  const arbiter = normalizeAgent(planning.arbiter, registryRoleFallback("planner", "codex"));
  const executionAgent = normalizeAgent(execution.agent, registryRoleFallback("executor", "claude-glm"));
  const verificationAgent = normalizeAgent(verification.agent, registryRoleFallback("verifier", "codex"));
  const verificationIndependent = verification.independent !== false;

  // Fail-closed (B2c): high mode with independent verification must not enter
  // when the registry cannot supply a verifier whose providerFamily differs
  // from the execution agent's family.
  if (mode === "high" && verificationIndependent) {
    if (!registryHasIndependentVerifier(assuranceAgentName(executionAgent))) {
      throw new Error(
        "high-assurance verification.independent requires a verifier from a provider family distinct from execution.agent; none registered",
      );
    }
  }

  return {
    enabled: mode === "high",
    mode,
    planning: {
      candidates: [candidateA, candidateB],
      arbiter,
      critiqueRounds: boundedCritiqueRounds(planning.critiqueRounds),
    },
    execution: {
      agent: executionAgent,
      required: execution.required !== false,
    },
    verification: {
      agent: verificationAgent,
      required: verification.required !== false,
      blind: verification.blind !== false,
      independent: verificationIndependent,
    },
  };
}

export function assuranceAgentName(value: AssuranceAgent): string {
  return typeof value === "string" ? value : value.agent;
}

export function assuranceAgentVariant(value: AssuranceAgent): string | null {
  return typeof value === "string" ? null : text(value.variant);
}

export function highAssuranceAgentPolicyViolations(
  policy: HighAssurancePolicy,
  allowedAgents: string[] | null,
): string[] {
  if (allowedAgents === null) return [];
  const allowed = new Set(allowedAgents);
  const configured: Array<[string, AssuranceAgent]> = [
    ["planning.candidateA", policy.planning.candidates[0]],
    ["planning.candidateB", policy.planning.candidates[1]],
    ["planning.arbiter", policy.planning.arbiter],
    ["execution.agent", policy.execution.agent],
    ["verification.agent", policy.verification.agent],
  ];
  return configured
    .filter(([, agent]) => !allowed.has(assuranceAgentName(agent)))
    .map(([role, agent]) => `${role}:${assuranceAgentName(agent)}`);
}

export function highAssuranceAgentForRole(
  policy: HighAssurancePolicy,
  role: string,
): { selectedAgent: AssuranceAgent; required: boolean } | null {
  if (!policy.enabled) return null;
  if (role === "executor" || role === "remediator") {
    return { selectedAgent: policy.execution.agent, required: policy.execution.required };
  }
  if (role === "verifier" || role === "adversarial_verifier") {
    return { selectedAgent: policy.verification.agent, required: policy.verification.required };
  }
  return null;
}
