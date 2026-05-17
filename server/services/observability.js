import { sanitizeProviderReason } from "../../bridges/acp-pool.mjs";
import { getManagedAcpPool } from "./acp-pool-runtime.js";
import { hubStatus, listProjects, workerStatus } from "./hub-registry.js";
import { listQueue, queueStatus } from "./hub-queue.js";
import { knowledgePolicySummary } from "./knowledge-policy.js";
import { shouldUseRustRuntime } from "./runtime-cli.js";

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
