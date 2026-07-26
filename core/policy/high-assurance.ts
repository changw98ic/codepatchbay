import { recordValue, type LooseRecord } from "../contracts/types.js";

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

export function resolveHighAssurancePolicy(ctx: LooseRecord = {}): HighAssurancePolicy {
  const assurance = assuranceRecord(ctx);
  const mode = assuranceMode(ctx, assurance);
  const planning = recordValue(assurance.planning);
  const execution = recordValue(assurance.execution);
  const verification = recordValue(assurance.verification);
  const rawCandidates = Array.isArray(planning.candidates) ? planning.candidates : [];
  // Ordinary agents/routing configuration must not silently redefine the
  // quality-first role split.  High-assurance overrides live only inside the
  // explicit assurance policy.
  const candidateA = normalizeAgent(rawCandidates[0] || planning.candidateA, "codex");
  const candidateB = normalizeAgent(rawCandidates[1] || planning.candidateB, "claude-glm");

  return {
    enabled: mode === "high",
    mode,
    planning: {
      candidates: [candidateA, candidateB],
      arbiter: normalizeAgent(planning.arbiter, "codex"),
      critiqueRounds: boundedCritiqueRounds(planning.critiqueRounds),
    },
    execution: {
      agent: normalizeAgent(execution.agent, "claude-glm"),
      required: execution.required !== false,
    },
    verification: {
      agent: normalizeAgent(verification.agent, "codex"),
      required: verification.required !== false,
      blind: verification.blind !== false,
      independent: verification.independent !== false,
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
