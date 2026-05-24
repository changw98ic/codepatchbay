import * as agentRegistry from "../../core/agents/registry.js";
import { listJobs } from "./job-store.js";
import { getWorkflow, roleForPhase } from "../../core/workflow/definition.js";
import { scoreAgentMetrics } from "../../core/agents/scoring.js";
import { getAgentPerformance, getAgentQuality } from "./performance-tracker.js";

const TERMINAL_STATES = new Set(["completed", "failed", "blocked", "cancelled"]);

function resolveAgentForJob(j) {
  if (j.agent && typeof j.agent === "string") {
    return j.agent;
  }
  if (j.executor && typeof j.executor === "string") {
    return j.executor;
  }
  if (j.executor && typeof j.executor === "object" && j.executor.packageName) {
    return j.executor.packageName;
  }

  // Use the job's actual last phase for accurate attribution
  const phases = j.completedPhases || [];
  const lastPhase = phases.length > 0 ? phases[phases.length - 1] : (j.phase || "execute");
  try {
    const wf = getWorkflow(j.workflow || "standard");
    const role = roleForPhase(wf, lastPhase) || "executor";
    const agent = agentRegistry.defaultAgentForRole(role);
    if (agent) return agent;
  } catch {}
  return "unknown";
}

function classifyJobsByAgent(allJobs) {
  const byAgent = new Map();
  for (const j of allJobs) {
    const agent = resolveAgentForJob(j);
    if (!byAgent.has(agent)) byAgent.set(agent, []);
    byAgent.get(agent).push(j);
  }
  return byAgent;
}

function buildJobStats(jobs) {
  const completed = jobs.filter((j) => j.status === "completed");
  const failed = jobs.filter((j) => j.status === "failed");
  const cancelled = jobs.filter((j) => j.status === "cancelled");
  const running = jobs.filter((j) => !TERMINAL_STATES.has(j.status));
  const durations = completed
    .filter((j) => j.createdAt && j.updatedAt)
    .map((j) => j.updatedAt - j.createdAt);
  const totalDurationMs = durations.reduce((s, d) => s + d, 0);
  const avgDurationMs = durations.length > 0
    ? Math.round(totalDurationMs / durations.length)
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

  const retryCount = jobs.reduce((sum, j) => sum + Math.max(0, Number(j.retryCount) || 0), 0);
  const timeoutCount = jobs.filter((j) => {
    const evidence = `${j.failureCode || ""} ${j.blockedReason || ""} ${j.error || ""}`.toLowerCase();
    return evidence.includes("timeout") || evidence.includes("timed out");
  }).length;
  const userRejectionCount = jobs.filter((j) => {
    const evidence = `${j.failureCode || ""} ${j.blockedReason || ""} ${j.error || ""}`.toLowerCase();
    return evidence.includes("user_rejected")
      || evidence.includes("human_rejected")
      || evidence.includes("approval_denied")
      || evidence.includes("rejected by user");
  }).length;

  return {
    total: jobs.length,
    running: running.length,
    completed: completed.length,
    failed: failed.length,
    blocked: jobs.filter((j) => j.status === "blocked").length,
    cancelled: cancelled.length,
    successRate: jobs.length > 0 ? Math.round((completed.length / jobs.length) * 100) : null,
    avgDurationMs,
    totalDurationMs,
    retryCount,
    timeoutCount,
    userRejectionCount,
    phases,
    failureCodes,
  };
}

function buildScoreInput(stats, performance, quality) {
  const performanceDuration = performance.avgDurationMs && performance.totalRequests
    ? performance.avgDurationMs * performance.totalRequests
    : 0;
  return {
    totalJobs: stats.total,
    successes: stats.completed,
    failures: stats.failed + stats.blocked + (stats.cancelled || 0),
    totalDurationMs: stats.totalDurationMs || performanceDuration,
    retries: stats.retryCount || 0,
    verifierPasses: quality.pass || 0,
    verifierRuns: quality.total || 0,
    timeouts: stats.timeoutCount || 0,
    userRejections: stats.userRejectionCount || 0,
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
    const performance = await getAgentPerformance(cpbRoot, name).catch(() => ({
      agent: name,
      entries: 0,
      totalRequests: 0,
      totalErrors: 0,
      avgDurationMs: null,
      phases: {},
    }));
    const quality = await getAgentQuality(cpbRoot, name).catch(() => ({
      agent: name,
      total: 0,
      pass: 0,
      fail: 0,
      passRate: null,
    }));
    const score = scoreAgentMetrics(buildScoreInput(stats, performance, quality));

    // Pool status
    let poolInfo = null;
    try {
      const { getManagedAcpPool } = await import("./acp-pool.js");
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
      performance,
      quality,
      score,
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
    .filter((j) => resolveAgentForJob(j) === agentName)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, limit)
    .map((j) => ({
      jobId: j.jobId,
      project: j.project,
      task: j.task,
      status: j.status,
      phase: j.phase,
      executor: typeof j.executor === "string" ? j.executor : (j.executor?.packageName || "unknown"),
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      workflow: j.workflow,
      completedPhases: j.completedPhases || [],
      failureCode: j.failureCode,
      failurePhase: j.failurePhase,
    }));
}
