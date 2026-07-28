import { recordValue, type LooseRecord } from "../../../core/contracts/types.js";

export type AgentStatRow = { agent: string; successes: number; retries: number; byRole?: LooseRecord };
export type AgentStatsSummary = { agents: AgentStatRow[]; usageRollup: LooseRecord };

function finiteNumber(value: unknown): number {
  return Number.isFinite(value as number) ? (value as number) : 0;
}

export function summarizeAgentStats({ routingMetrics, usageRollup }: {
  routingMetrics: unknown[];
  usageRollup: LooseRecord;
}): AgentStatsSummary {
  const byAgent = new Map<string, AgentStatRow>();
  for (const entry of Array.isArray(routingMetrics) ? routingMetrics : []) {
    const r = recordValue(entry);
    const agent = String(r.agent ?? r.providerKey ?? "unknown");
    const row = byAgent.get(agent) ?? { agent, successes: 0, retries: 0, byRole: {} };
    row.successes += finiteNumber(r.successes);
    row.retries += finiteNumber(r.retries);
    if (r.role) {
      const roleKey = String(r.role);
      const roleRow = (row.byRole![roleKey] ??= { successes: 0, retries: 0 }) as { successes: number; retries: number };
      roleRow.successes += finiteNumber(r.successes);
      roleRow.retries += finiteNumber(r.retries);
    }
    byAgent.set(agent, row);
  }
  return { agents: [...byAgent.values()], usageRollup };
}

export function formatAgentStatsHuman(summary: AgentStatsSummary): string {
  if (!summary.agents.length) return "";
  return summary.agents
    .map((row) => {
      const total = row.successes + row.retries;
      const rate = total > 0 ? `${Math.round((row.successes / total) * 100)}%` : "n/a";
      return `${row.agent}\tsuccesses=${row.successes}\tretries=${row.retries}\tsuccess_rate=${rate}`;
    })
    .join("\n") + "\n";
}
