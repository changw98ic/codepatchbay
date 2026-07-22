import type { LooseRecord } from "../../shared/types.js";
import { buildRiskBudgetAcpEnv, derivePhaseBudgetPolicy } from "../policy/phase-budget.js";
import { resolveHighAssurancePolicy } from "../policy/high-assurance.js";

function recordValue(value: unknown): LooseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as LooseRecord
    : {};
}

export function buildPhaseAcpEnv(ctx: LooseRecord, phase: string): NodeJS.ProcessEnv {
  const env = buildRiskBudgetAcpEnv(ctx, phase, { ...recordValue(ctx.env) } as NodeJS.ProcessEnv);
  if (phase === "plan" && resolveHighAssurancePolicy(ctx).enabled) {
    // Tournament planning is static and read-only. Denying terminal creation
    // prevents dynamic probes from opening a non-TTY process that a planner
    // later tries to poll through a closed stdin session. Evidence depth is
    // still risk-derived, while tool/token work ceilings remain unlimited.
    env.CPB_ACP_TERMINAL = "deny";
  }
  return env;
}

export { derivePhaseBudgetPolicy };
