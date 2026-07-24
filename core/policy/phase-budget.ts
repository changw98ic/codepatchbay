import { recordValue, type LooseRecord } from "../contracts/types.js";
import { resolveAllowedAgentNames } from "../agents/outcome-routing.js";
import { resolveHighAssurancePolicy } from "./high-assurance.js";

type EnvMap = Record<string, string | undefined>;
type RiskLevel = "low" | "medium" | "high" | "critical";

type PhaseBudget = {
  toolCallBudget: number;
  toolEventBudget: number;
  idleTimeoutMs: number;
  noEditToolLimit?: number;
  noEditIdleTimeoutMs?: number;
};

type RiskBudgetProfile = {
  verificationDepth: string;
  evidenceRequirements: string[];
  phases: Record<string, PhaseBudget>;
};

type RiskClassification = {
  riskLevel: RiskLevel;
  domains: string[];
  reason: string;
};

export const DEFAULT_AGENT_PHASE_TIMEOUT_MS = 30 * 60 * 1000;

export function resolveAgentPhaseTimeoutMs({
  timeoutMin,
  env = process.env,
}: {
  timeoutMin?: number | null;
  env?: Record<string, string | undefined>;
} = {}) {
  if (typeof timeoutMin === "number" && Number.isFinite(timeoutMin) && timeoutMin > 0) {
    return timeoutMin * 60_000;
  }
  const configured = Number(env.CPB_ACP_PHASE_TIMEOUT_MS || env.CPB_ACP_POOL_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_AGENT_PHASE_TIMEOUT_MS;
}

const RISK_PROFILES: Record<RiskLevel, RiskBudgetProfile> = {
  low: {
    verificationDepth: "standard",
    evidenceRequirements: ["agent_regression_test", "canonical_command"],
    phases: {
      prepare_task: { toolCallBudget: 20, toolEventBudget: 80, idleTimeoutMs: 90_000 },
      plan: { toolCallBudget: 20, toolEventBudget: 80, idleTimeoutMs: 90_000 },
      execute: { toolCallBudget: 40, toolEventBudget: 160, idleTimeoutMs: 90_000, noEditToolLimit: 0, noEditIdleTimeoutMs: 0 },
      review: { toolCallBudget: 20, toolEventBudget: 80, idleTimeoutMs: 90_000 },
      verify: { toolCallBudget: 20, toolEventBudget: 80, idleTimeoutMs: 90_000 },
      adversarial_verify: { toolCallBudget: 20, toolEventBudget: 80, idleTimeoutMs: 90_000 },
      remediate: { toolCallBudget: 35, toolEventBudget: 140, idleTimeoutMs: 90_000 },
    },
  },
  medium: {
    verificationDepth: "standard",
    evidenceRequirements: ["agent_regression_test", "canonical_command", "real_path_trace"],
    phases: {
      prepare_task: { toolCallBudget: 40, toolEventBudget: 160, idleTimeoutMs: 120_000 },
      plan: { toolCallBudget: 40, toolEventBudget: 160, idleTimeoutMs: 120_000 },
      execute: { toolCallBudget: 70, toolEventBudget: 280, idleTimeoutMs: 120_000, noEditToolLimit: 0, noEditIdleTimeoutMs: 0 },
      review: { toolCallBudget: 30, toolEventBudget: 120, idleTimeoutMs: 120_000 },
      verify: { toolCallBudget: 30, toolEventBudget: 120, idleTimeoutMs: 120_000 },
      adversarial_verify: { toolCallBudget: 30, toolEventBudget: 120, idleTimeoutMs: 120_000 },
      remediate: { toolCallBudget: 60, toolEventBudget: 240, idleTimeoutMs: 120_000 },
    },
  },
  high: {
    verificationDepth: "strict",
    evidenceRequirements: ["agent_regression_test", "canonical_command", "real_path_trace", "adversarial_verdict"],
    phases: {
      prepare_task: { toolCallBudget: 60, toolEventBudget: 240, idleTimeoutMs: 150_000 },
      plan: { toolCallBudget: 60, toolEventBudget: 240, idleTimeoutMs: 150_000 },
      execute: { toolCallBudget: 100, toolEventBudget: 400, idleTimeoutMs: 150_000, noEditToolLimit: 0, noEditIdleTimeoutMs: 0 },
      review: { toolCallBudget: 35, toolEventBudget: 140, idleTimeoutMs: 150_000 },
      verify: { toolCallBudget: 45, toolEventBudget: 180, idleTimeoutMs: 150_000 },
      adversarial_verify: { toolCallBudget: 35, toolEventBudget: 140, idleTimeoutMs: 150_000 },
      remediate: { toolCallBudget: 90, toolEventBudget: 360, idleTimeoutMs: 150_000 },
    },
  },
  critical: {
    verificationDepth: "paranoid",
    evidenceRequirements: ["agent_regression_test", "canonical_command", "external_oracle", "real_path_trace", "adversarial_verdict"],
    phases: {
      prepare_task: { toolCallBudget: 80, toolEventBudget: 320, idleTimeoutMs: 180_000 },
      plan: { toolCallBudget: 80, toolEventBudget: 320, idleTimeoutMs: 180_000 },
      execute: { toolCallBudget: 120, toolEventBudget: 480, idleTimeoutMs: 180_000, noEditToolLimit: 0, noEditIdleTimeoutMs: 0 },
      review: { toolCallBudget: 45, toolEventBudget: 180, idleTimeoutMs: 180_000 },
      verify: { toolCallBudget: 60, toolEventBudget: 240, idleTimeoutMs: 180_000 },
      adversarial_verify: { toolCallBudget: 45, toolEventBudget: 180, idleTimeoutMs: 180_000 },
      remediate: { toolCallBudget: 110, toolEventBudget: 440, idleTimeoutMs: 180_000 },
    },
  },
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringValues);
  return [];
}

function contextSearchText(ctx: LooseRecord = {}, riskMap: LooseRecord = {}) {
  const sourceContext = recordValue(ctx.sourceContext);
  const requirementClassification = recordValue(sourceContext.requirementClassification || ctx.requirementClassification);
  return [
    ctx.task,
    sourceContext.task,
    sourceContext.title,
    sourceContext.body,
    sourceContext.issueTitle,
    sourceContext.issueBody,
    sourceContext.command,
    ctx.workflow,
    ctx.planMode,
    riskMap.domains,
    riskMap.highRiskFiles,
    riskMap.safetyBoundaries,
    requirementClassification,
  ].flatMap(stringValues).join("\n").toLowerCase();
}

function inferredDomains(searchText: string): string[] {
  const domains = new Set<string>();
  const rules: Array<[string, RegExp]> = [
    ["security", /\b(security|auth|permission|secret|token|credential|password|csrf|xss|cve|privilege)\b/],
    ["data_integrity", /\b(data loss|delete data|destructive|rollback|restore|backup|corrupt|production data)\b/],
    ["payments", /\b(payment|billing|invoice|checkout)\b/],
    ["database", /\b(database|db|migration|schema|sql|transaction)\b/],
    ["user_interface", /\b(user-facing|customer|ui|ux|frontend|react|browser|e2e|screen|button|form)\b/],
    ["api", /\b(api|http|webhook|endpoint|request|response|sdk)\b/],
    ["cli", /\b(cli|command-line|terminal command)\b/],
    ["integration", /\b(integration|oauth|slack|github|external service|third-party)\b/],
    ["scheduler", /\b(scheduler|orchestrator|queue|dispatch|dag|worker)\b/],
    ["concurrency", /\b(concurrency|concurrent|parallel|race|lock|lease)\b/],
    ["provider_pool", /\b(provider|quota|rate.?limit|acp|pool|handoff)\b/],
    ["worktree", /\b(worktree|git|merge|branch|finalizer)\b/],
    ["event_store", /\b(event store|event-store|jsonl|checkpoint|materialize)\b/],
    ["subprocess", /\b(subprocess|spawn|shell|process lifecycle)\b/],
  ];
  for (const [domain, pattern] of rules) {
    if (pattern.test(searchText)) domains.add(domain);
  }
  return [...domains];
}

function classifyRiskLevel(value: unknown, ctx: LooseRecord = {}, riskMap: LooseRecord = {}): RiskClassification {
  const raw = text(value).toLowerCase();
  if (raw === "low" || raw === "medium" || raw === "high" || raw === "critical") {
    return { riskLevel: raw, domains: [], reason: "explicit_risk_level" };
  }

  const searchText = contextSearchText(ctx, riskMap);
  const domains = inferredDomains(searchText);
  if (/\b(security|auth|permission|secret|token|credential|password|cve|data loss|delete data|destructive|production data|payment|billing)\b/.test(searchText)) {
    return { riskLevel: "critical", domains, reason: "critical_product_surface" };
  }
  if (domains.some((domain) => [
    "database",
    "user_interface",
    "api",
    "cli",
    "integration",
    "scheduler",
    "concurrency",
    "provider_pool",
    "worktree",
    "event_store",
    "subprocess",
  ].includes(domain))) {
    return { riskLevel: "high", domains, reason: "high_product_surface" };
  }
  if (text(ctx.workflow) === "complex") return { riskLevel: "high", domains, reason: "workflow_complex" };
  const planMode = text(ctx.planMode);
  if (planMode === "light" || planMode === "none" || text(ctx.workflow) === "direct") return { riskLevel: "low", domains, reason: "light_or_direct_route" };
  if (/\b(doc|docs|readme|comment|copy|typo|spelling|markdown)\b/.test(searchText) && domains.length === 0) {
    return { riskLevel: "low", domains, reason: "docs_only" };
  }
  return { riskLevel: "medium", domains, reason: "default_standard_task" };
}

function riskMapFromContext(ctx: LooseRecord = {}) {
  const sourceContext = recordValue(ctx.sourceContext);
  return recordValue(sourceContext.riskMap || ctx.riskMap);
}

function domainsFromRiskMap(riskMap: LooseRecord) {
  return Array.isArray(riskMap.domains)
    ? riskMap.domains.filter((domain): domain is string => typeof domain === "string" && domain.trim().length > 0)
    : [];
}

export function derivePhaseBudgetPolicy(ctx: LooseRecord = {}) {
  const riskMap = riskMapFromContext(ctx);
  const classification = classifyRiskLevel(riskMap.riskLevel, ctx, riskMap);
  const riskLevel = classification.riskLevel;
  const profile = RISK_PROFILES[riskLevel];
  const verificationDepth = text(riskMap.verificationDepth) || profile.verificationDepth;
  const domains = domainsFromRiskMap(riskMap);
  const policyDomains = domains.length > 0 ? domains : classification.domains;
  const assurancePolicy = resolveHighAssurancePolicy(ctx);
  const phases = Object.fromEntries(Object.entries(profile.phases).map(([phase, budget]) => [phase, { ...budget }]));
  if (assurancePolicy.enabled) {
    phases.execute = {
      ...phases.execute,
      idleTimeoutMs: Math.max(phases.execute.idleTimeoutMs, 360_000),
    };
  }
  return {
    schemaVersion: 1,
    source: "task_risk_policy",
    riskLevel,
    domains: policyDomains,
    verificationDepth,
    adversarialRequired: riskMap.adversarialRequired === true || riskLevel === "high" || riskLevel === "critical",
    evidenceRequirements: profile.evidenceRequirements,
    phases,
    reasons: [
      `riskLevel=${riskLevel}`,
      `riskSignal=${classification.reason}`,
      `verificationDepth=${verificationDepth}`,
      ...(assurancePolicy.enabled ? ["assurance=high_quality_time_budget"] : []),
      policyDomains.length ? `domains=${policyDomains.join(",")}` : "domains=general",
    ],
  };
}

function phaseEnvSuffix(phase: string) {
  return phase.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function hasEnv(env: EnvMap, key: string) {
  return env[key] !== undefined && env[key] !== "";
}

function setDefault(env: EnvMap, key: string, value: unknown) {
  if (!hasEnv(env, key)) env[key] = String(value);
}

function setPhaseBudgetDefault(env: EnvMap, phase: string, keyBase: string, value: unknown) {
  const phaseKey = `${keyBase}_${phaseEnvSuffix(phase)}`;
  if (hasEnv(env, phaseKey) || hasEnv(env, keyBase)) return;
  env[phaseKey] = String(value);
}

// A zero ACP budget means unlimited. The derived policy records zero for the
// execute no-edit guards too, so projections and runtime enforcement agree.
// Operators can still opt into those guards through explicit env overrides.
// Keep mutation and repository-discovery phases unconstrained by an artificial
// work ceiling, but bound the closed adversarial judgment over an already-
// frozen candidate/evidence snapshot.
const UNLIMITED_TOOL_BUDGET = 0;

export function buildRiskBudgetAcpEnv(ctx: unknown = {}, phase: string, baseEnv: EnvMap = {}): NodeJS.ProcessEnv {
  const context = recordValue(ctx);
  const env = { ...baseEnv } as NodeJS.ProcessEnv;
  const policy = derivePhaseBudgetPolicy(context);
  const phasePolicy = recordValue(recordValue(policy.phases)[phase]);
  const allowedAgents = resolveAllowedAgentNames(context.sourceContext, context);

  setDefault(env, "CPB_TASK_RISK_LEVEL", policy.riskLevel);
  setDefault(env, "CPB_TASK_VERIFICATION_DEPTH", policy.verificationDepth);
  setDefault(env, "CPB_TASK_EVIDENCE_REQUIREMENTS_JSON", JSON.stringify(policy.evidenceRequirements));
  setDefault(env, "CPB_TASK_PHASE_BUDGET_POLICY_JSON", JSON.stringify(policy));
  if (allowedAgents !== null) setDefault(env, "CPB_ALLOWED_AGENTS_JSON", JSON.stringify(allowedAgents));

  if (typeof phasePolicy.toolCallBudget === "number") {
    setPhaseBudgetDefault(
      env,
      phase,
      "CPB_ACP_TOOL_CALL_BUDGET",
      phase === "adversarial_verify" ? phasePolicy.toolCallBudget : UNLIMITED_TOOL_BUDGET,
    );
  }
  if (typeof phasePolicy.toolEventBudget === "number") {
    setPhaseBudgetDefault(
      env,
      phase,
      "CPB_ACP_TOOL_EVENT_BUDGET",
      phase === "adversarial_verify" ? phasePolicy.toolEventBudget : UNLIMITED_TOOL_BUDGET,
    );
  }
  if (typeof phasePolicy.idleTimeoutMs === "number" && !hasEnv(env, "CPB_ACP_IDLE_TIMEOUT_MS") && !hasEnv(env, "CPB_ACP_TIMEOUT_MS")) {
    env.CPB_ACP_IDLE_TIMEOUT_MS = String(phasePolicy.idleTimeoutMs);
  }
  if (phase === "execute") {
    if (typeof phasePolicy.noEditToolLimit === "number" && !hasEnv(env, "CPB_ACP_EXECUTE_NO_EDIT_TOOL_LIMIT")) {
      env.CPB_ACP_EXECUTE_NO_EDIT_TOOL_LIMIT = String(UNLIMITED_TOOL_BUDGET);
    }
    if (typeof phasePolicy.noEditIdleTimeoutMs === "number" && !hasEnv(env, "CPB_ACP_EXECUTE_NO_EDIT_IDLE_TIMEOUT_MS")) {
      env.CPB_ACP_EXECUTE_NO_EDIT_IDLE_TIMEOUT_MS = String(UNLIMITED_TOOL_BUDGET);
    }
  }

  return env;
}
