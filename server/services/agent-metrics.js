import * as agentRegistry from "../../core/agents/registry.js";
import { listJobs } from "./job-store.js";

const TERMINAL_STATES = new Set(["completed", "failed", "blocked", "cancelled"]);

function classifyJobsByAgent(allJobs) {
  const byAgent = new Map();
  for (const j of allJobs) {
    const agent = j.executor || "unknown";
    if (!byAgent.has(agent)) byAgent.set(agent, []);
    byAgent.get(agent).push(j);
  }
  return byAgent;
}

function buildJobStats(jobs) {
  const completed = jobs.filter((j) => j.status === "completed");
  const failed = jobs.filter((j) => j.status === "failed");
  const running = jobs.filter((j) => !TERMINAL_STATES.has(j.status));
  const durations = completed
    .filter((j) => j.createdAt && j.updatedAt)
    .map((j) => j.updatedAt - j.createdAt);
  const avgDurationMs = durations.length > 0
    ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length)
    : null;

  // Phase breakdown
  const phases = {};
  for (const j of jobs) {
    for (const p of j.completedPhases || []) {
      if (!phases[p]) phases[p] = { completed: 0, failed: 0 };
      phases[p].completed++;
    }
    if (j.failurePhase) {
      if (!phases[j.failurePhase]) phases[j.failurePhase] = { completed: 0, failed: 0 };
      phases[j.failurePhase].failed++;
    }
  }

  // Failure codes
  const failureCodes = {};
  for (const j of failed) {
    if (j.failureCode) failureCodes[j.failureCode] = (failureCodes[j.failureCode] || 0) + 1;
  }

  return {
    total: jobs.length,
    running: running.length,
    completed: completed.length,
    failed: failed.length,
    blocked: jobs.filter((j) => j.status === "blocked").length,
    successRate: jobs.length > 0 ? Math.round((completed.length / jobs.length) * 100) : null,
    avgDurationMs,
    phases,
    failureCodes,
  };
}

export async function collectAgentMetrics(cpbRoot) {
  let descriptors = [];
  try {
    await agentRegistry.loadRegistry();
    descriptors = agentRegistry.listAgents();
  } catch {
    return { agents: [], timestamp: new Date().toISOString() };
  }

  const allJobs = await listJobs(cpbRoot).catch(() => []);
  const jobsByAgent = classifyJobsByAgent(allJobs);

  // Collect all known agent names: from registry + from jobs
  const allNames = new Set([
    ...descriptors.map((d) => d.name),
    ...jobsByAgent.keys(),
  ]);

  const result = [];
  for (const name of allNames) {
    const desc = agentRegistry.getDescriptor(name);
    const jobs = jobsByAgent.get(name) || [];
    const stats = buildJobStats(jobs);

    // Pool status
    let poolInfo = null;
    try {
      const { getManagedAcpPool } = await import("../../runtime/acp-pool.js");
      const pool = getManagedAcpPool({ cpbRoot, hubRoot: undefined });
      const status = await pool.statusAsync();
      const entry = status.pools?.[name];
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
          descriptor: entry.descriptor || null,
        };
      }
    } catch {}

    result.push({
      name,
      displayName: desc?.displayName || name,
      stability: desc?.stability || (name === "unknown" ? "unknown" : "unregistered"),
      capabilities: desc?.capabilities || [],
      defaultRoles: desc?.defaultRoles || [],
      command: desc?.command || null,
      envPrefix: desc?.envPrefix || null,
      pool: poolInfo,
      jobs: stats,
    });
  }

  return { agents: result, timestamp: new Date().toISOString() };
}

export async function getAgentDetail(cpbRoot, agentName) {
  const metrics = await collectAgentMetrics(cpbRoot);
  return metrics.agents.find((a) => a.name === agentName) || null;
}

export async function getAgentJobs(cpbRoot, agentName, opts = {}) {
  const limit = opts.limit ?? 50;
  const allJobs = await listJobs(cpbRoot).catch(() => []);
  return allJobs
    .filter((j) => (j.executor || "unknown") === agentName)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, limit)
    .map((j) => ({
      jobId: j.jobId,
      project: j.project,
      task: j.task,
      status: j.status,
      phase: j.phase,
      executor: j.executor,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      workflow: j.workflow,
      completedPhases: j.completedPhases || [],
      failureCode: j.failureCode,
      failurePhase: j.failurePhase,
    }));
}
