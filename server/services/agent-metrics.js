import * as agentRegistry from "../../core/agents/registry.js";
import { listJobs } from "./job-store.js";

export async function collectAgentMetrics(cpbRoot) {
  let agents = [];
  try {
    await agentRegistry.loadRegistry();
    agents = agentRegistry.listAgents();
  } catch {
    return { agents: [], timestamp: new Date().toISOString() };
  }

  const allJobs = await listJobs(cpbRoot).catch(() => []);
  const terminalStates = new Set(["completed", "failed", "blocked", "cancelled"]);

  const result = [];
  for (const desc of agents) {
    const roleMap = {
      planner: "plan", executor: "execute", verifier: "verify", reviewer: "review", repairer: "repair",
    };
    const phases = (desc.defaultRoles || []).map((r) => roleMap[r] || r);
    const phaseSet = new Set(phases);

    // Count jobs that match this agent's phases
    const matchingJobs = allJobs.filter((j) => {
      if (phaseSet.size === 0) return false;
      return phaseSet.has(j.phase) || (j.completedPhases || []).some((p) => phaseSet.has(p));
    });

    const completed = matchingJobs.filter((j) => j.status === "completed");
    const failed = matchingJobs.filter((j) => j.status === "failed");
    const running = matchingJobs.filter((j) => !terminalStates.has(j.status));

    // Pool status
    let poolInfo = null;
    try {
      const { getManagedAcpPool } = await import("../../runtime/acp-pool.js");
      const pool = getManagedAcpPool({ cpbRoot, hubRoot: undefined });
      const status = pool.status();
      const entry = status.pools?.[desc.name];
      if (entry) {
        poolInfo = {
          limit: entry.limit,
          active: entry.active,
          queued: entry.queued,
          requestCount: entry.requestCount,
          errorCount: entry.errorCount,
          lastSpawnAt: entry.lastSpawnAt,
          rateLimitedUntil: entry.rateLimitedUntil,
          mode: entry.mode,
        };
      }
    } catch {}

    result.push({
      name: desc.name,
      displayName: desc.displayName || desc.name,
      stability: desc.stability || "unknown",
      capabilities: desc.capabilities || [],
      defaultRoles: desc.defaultRoles || [],
      command: desc.command,
      envPrefix: desc.envPrefix,
      pool: poolInfo,
      jobs: {
        total: matchingJobs.length,
        running: running.length,
        completed: completed.length,
        failed: failed.length,
        successRate: matchingJobs.length > 0
          ? Math.round((completed.length / matchingJobs.length) * 100)
          : null,
      },
      phases,
    });
  }

  return { agents: result, timestamp: new Date().toISOString() };
}

export async function getAgentDetail(cpbRoot, agentName) {
  const metrics = await collectAgentMetrics(cpbRoot);
  return metrics.agents.find((a) => a.name === agentName) || null;
}

export async function getAgentJobs(cpbRoot, agentName) {
  let desc;
  try {
    await agentRegistry.loadRegistry();
    desc = agentRegistry.getDescriptor(agentName);
  } catch {
    return [];
  }
  if (!desc) return [];

  const roleMap = {
    planner: "plan", executor: "execute", verifier: "verify", reviewer: "review", repairer: "repair",
  };
  const phases = new Set((desc.defaultRoles || []).map((r) => roleMap[r] || r));

  const allJobs = await listJobs(cpbRoot).catch(() => []);
  return allJobs
    .filter((j) => phases.has(j.phase) || (j.completedPhases || []).some((p) => phases.has(p)))
    .map((j) => ({
      jobId: j.jobId,
      project: j.project,
      task: j.task,
      status: j.status,
      phase: j.phase,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      workflow: j.workflow,
    }));
}
