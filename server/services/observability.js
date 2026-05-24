import { sanitizeProviderReason, getManagedAcpPool } from "./acp-pool.js";
import { hubStatus, listProjects, workerStatus } from "./hub-registry.js";
import { listQueue, queueStatus } from "./hub-queue.js";
import { knowledgePolicySummary } from "./knowledge-policy.js";
import { listDispatches } from "./dispatch-state.js";
import { redactSecrets } from "./secret-policy.js";
import { buildChainSnapshot, analyzeChainSnapshot } from "./observer.js";

export function redactDiagnostics(value, key = "") {
  return redactSecrets(value, key);
}

export async function buildObservabilitySummary({ cpbRoot, hubRoot, acpPool } = {}) {
  const pool = acpPool || getManagedAcpPool({ cpbRoot, hubRoot });
  const now = Date.now();

  const [hub, projects, queue, acpStatus, rateLimits, dispatches] = await Promise.all([
    hubStatus(hubRoot),
    listProjects(hubRoot),
    queueStatus(hubRoot),
    pool.status(),
    pool.readDurableRateLimits(),
    listDispatches(hubRoot),
  ]);

  const workerDetails = projects.map((p) => {
    const derived = workerStatus(p);
    const lastSeen = p.worker?.lastSeenAt;
    const ageMs = lastSeen ? now - new Date(lastSeen).getTime() : null;
    return {
      id: p.id,
      name: p.name,
      status: derived,
      workerId: p.worker?.workerId || null,
      lastSeenAt: lastSeen || null,
      ageMs,
      capabilities: p.worker?.capabilities || [],
    };
  });

  const pools = {};
  const acpPoolSummary = {
    sessionAges: [],
    requestCounts: {},
    recycleCounts: {},
    promptByteTotals: {},
  };

  for (const [agent, state] of Object.entries(acpStatus.pools || {})) {
    const spawnAge = state.lastSpawnAt ? now - new Date(state.lastSpawnAt).getTime() : null;
    pools[agent] = {
      active: state.active ?? 0,
      limit: state.limit ?? 1,
      queued: state.queued ?? 0,
      requestCount: state.requestCount ?? 0,
      errorCount: state.errorCount ?? 0,
      recycleCount: state.recycleCount ?? 0,
      lastRecycleReason: state.lastRecycleReason || null,
      lastSpawnAt: state.lastSpawnAt || null,
      processAgeMs: spawnAge,
      rateLimitedUntil: state.rateLimitedUntil || null,
      mode: state.mode || "bounded-one-shot",
      transport: state.transport || "request-scoped-child-process",
      providerProcessReuse: state.providerProcessReuse ?? false,
      activeRequests: Array.isArray(state.activeRequests) ? state.activeRequests.length : 0,
    };

    // Extended pool metadata
    if (state.sessionAgeMs != null) {
      acpPoolSummary.sessionAges.push({ agent, ageMs: state.sessionAgeMs });
    }
    acpPoolSummary.requestCounts[agent] = state.requestCount ?? 0;
    acpPoolSummary.recycleCounts[agent] = state.recycleCount ?? 0;

    const activeRequests = Array.isArray(state.activeRequests) ? state.activeRequests : [];
    acpPoolSummary.promptByteTotals[agent] = activeRequests.reduce(
      (sum, r) => sum + (r.promptBytes || 0), 0,
    );
  }

  const dispatchSummary = { total: 0, completed: 0, failed: 0, running: 0, assigned: 0, pending: 0 };
  for (const d of dispatches) {
    dispatchSummary.total++;
    if (dispatchSummary[d.status] !== undefined) dispatchSummary[d.status]++;
  }

  // Observer aggregate: scan in-progress queue entries for chain health
  let observerBlockedChains = 0;
  let observerStaleProcesses = 0;
  let observerDuplicateReviews = 0;
  try {
    const queueEntries = await listQueue(hubRoot, { status: "in_progress" });
    for (const entry of queueEntries) {
      if (!entry.projectId) continue;
      try {
        const snapshot = await buildChainSnapshot({
          cpbRoot,
          hubRoot,
          project: entry.projectId,
          jobId: entry.metadata?.originJobId || entry.id,
        });
        const analysis = analyzeChainSnapshot(snapshot);
        if (analysis.recommendation === "blocked") observerBlockedChains++;
        if (analysis.recommendation === "stale_process") observerStaleProcesses++;
        if (analysis.recommendation === "dedupe") observerDuplicateReviews++;
      } catch {}
    }
  } catch {}

  const projectRuntimeRoots = projects.reduce((acc, p) => {
    if (p.projectRuntimeRoot) acc[p.id] = p.projectRuntimeRoot;
    return acc;
  }, {});

  return {
    generatedAt: new Date().toISOString(),
    roots: {
      executorRoot: cpbRoot || undefined,
      hubRoot: hubRoot || undefined,
      projectRuntimeRoots,
    },
    workers: {
      online: hub.workersOnline,
      stale: hub.workersStale,
      offline: hub.workersOffline,
      details: workerDetails,
    },
    queue,
    pools,
    acpPool: acpPoolSummary,
    rateLimits,
    dispatchSummary,
    observerBlockedChains,
    observerStaleProcesses,
    observerDuplicateReviews,
  };
}

export async function buildDiagnosticBundle({ cpbRoot, hubRoot, acpPool } = {}) {
  const pool = acpPool || getManagedAcpPool({ cpbRoot, hubRoot });
  const [hub, projects, queue, queueEntries, rateLimits] = await Promise.all([
    hubStatus(hubRoot),
    listProjects(hubRoot),
    queueStatus(hubRoot),
    listQueue(hubRoot),
    pool.readDurableRateLimits(),
  ]);

  return redactDiagnostics({
    generatedAt: new Date().toISOString(),
    runtime: {
      backend: "js",
      cpbRoot,
      hubRoot,
    },
    hub,
    projects: projects.map((project) => ({
      ...project,
      workerDerivedStatus: workerStatus(project),
    })),
    queue,
    queueEntries,
    acp: {
      ...pool.status(),
      rateLimits,
    },
    knowledgePolicy: knowledgePolicySummary(),
  });
}
