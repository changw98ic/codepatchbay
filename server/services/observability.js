import { sanitizeProviderReason } from "../../bridges/acp-pool.mjs";
import { getManagedAcpPool } from "./acp-pool-runtime.js";
import { hubStatus, listProjects, workerStatus } from "./hub-registry.js";
import { listQueue, queueStatus } from "./hub-queue.js";
import { knowledgePolicySummary } from "./knowledge-policy.js";
import { shouldUseRustRuntime } from "./runtime-cli.js";
import { listDispatches } from "./dispatch-state.js";

const SENSITIVE_KEY = /authorization|cookie|api[_-]?key|auth[_-]?token|token|secret|webhook/i;
const WEBHOOK_URL = /https?:\/\/[^\s"']*(?:webhook|hook|bot)[^\s"']*/gi;

function redactString(value, key = "") {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  return sanitizeProviderReason(String(value))
    .replace(WEBHOOK_URL, "[REDACTED_URL]")
    .replace(/([?&](?:token|secret|key|signature)=)[^&\s"']+/gi, "$1[REDACTED]");
}

export function redactDiagnostics(value, key = "") {
  if (typeof value === "string") return redactString(value, key);
  if (Array.isArray(value)) return value.map((item) => redactDiagnostics(item));
  if (!value || typeof value !== "object") return value;

  const redacted = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(entryKey)) {
      redacted[entryKey] = "[REDACTED]";
    } else {
      redacted[entryKey] = redactDiagnostics(entryValue, entryKey);
    }
  }
  return redacted;
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
  for (const [agent, state] of Object.entries(acpStatus.pools || {})) {
    const spawnAge = state.lastSpawnAt ? now - new Date(state.lastSpawnAt).getTime() : null;
    pools[agent] = {
      active: state.active ?? 0,
      limit: state.limit ?? 1,
      queued: state.queued ?? 0,
      requestCount: state.requestCount ?? 0,
      errorCount: state.errorCount ?? 0,
      recycleCount: state.recycleCount ?? 0,
      lastSpawnAt: state.lastSpawnAt || null,
      processAgeMs: spawnAge,
      rateLimitedUntil: state.rateLimitedUntil || null,
      mode: state.mode || "bounded-one-shot",
      transport: state.transport || "request-scoped-child-process",
      providerProcessReuse: state.providerProcessReuse ?? false,
      activeRequests: Array.isArray(state.activeRequests) ? state.activeRequests.length : 0,
    };
  }

  const dispatchSummary = { total: 0, completed: 0, failed: 0, running: 0, assigned: 0, pending: 0 };
  for (const d of dispatches) {
    dispatchSummary.total++;
    if (dispatchSummary[d.status] !== undefined) dispatchSummary[d.status]++;
  }

  return {
    generatedAt: new Date().toISOString(),
    workers: {
      online: hub.workersOnline,
      stale: hub.workersStale,
      offline: hub.workersOffline,
      details: workerDetails,
    },
    queue,
    pools,
    rateLimits,
    dispatchSummary,
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
      backend: shouldUseRustRuntime() ? "rust" : "js",
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
