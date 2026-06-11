import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "./event-store.js";

const PERFORMANCE_DIR = "performance";

function requireDataRoot(dataRoot, label = "performance tracker") {
  if (!dataRoot || typeof dataRoot !== "string" || !dataRoot.trim()) {
    throw new Error(`dataRoot is required for ${label}`);
  }
  return path.resolve(dataRoot);
}

function perfDir(dataRoot) {
  return path.join(requireDataRoot(dataRoot), PERFORMANCE_DIR);
}

function agentKey(agent, role, phase) {
  return `${agent}:${role}:${phase}`;
}

/**
 * Record a performance entry from a completed job phase.
 * Writes a performance_recorded event and appends to agent metrics file.
 */
export async function recordPerformance(cpbRoot, project, jobId, entry) {
  const { agent, role, phase, status, durationMs, error, ts } = entry;
  const dataRoot = requireDataRoot(entry.dataRoot);
  if (!agent || !phase) return;

  // Append performance event to job event log
  try {
    await appendEvent(cpbRoot, project, jobId, {
      type: "performance_recorded",
      agent,
      role: role || null,
      phase,
      status,
      durationMs: durationMs || null,
      error: error || null,
      ts: ts || new Date().toISOString(),
    }, { dataRoot, includeLegacyFallback: false });
  } catch {}

  // Update agent metrics file
  const dir = perfDir(dataRoot);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${agent}.jsonl`);

  const line = JSON.stringify({
    ts: ts || new Date().toISOString(),
    project,
    jobId,
    role: role || null,
    phase,
    status,
    durationMs: durationMs || null,
    error: error || null,
  });

  await appendLine(file, line);
}

/**
 * Get aggregated performance metrics for an agent.
 */
export async function getAgentPerformance(cpbRoot, agent, { dataRoot }: Record<string, any> = {}) {
  const dir = perfDir(dataRoot);
  const file = path.join(dir, `${agent}.jsonl`);

  let lines;
  try {
    const raw = await readFile(file, "utf8");
    lines = raw.split("\n").filter((l) => l.trim());
  } catch {
    return { agent, entries: 0, totalRequests: 0, totalErrors: 0, avgDurationMs: null, phases: {} };
  }

  const entries = lines.map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  const totalRequests = entries.length;
  const totalErrors = entries.filter((e) => e.status === "failed").length;
  const durations = entries.map((e) => e.durationMs).filter((d) => d && d > 0);
  const avgDurationMs = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;

  const phases = {};
  for (const e of entries) {
    if (!phases[e.phase]) phases[e.phase] = { count: 0, failures: 0 };
    phases[e.phase].count++;
    if (e.status === "failed") phases[e.phase].failures++;
  }

  return { agent, entries: totalRequests, totalRequests, totalErrors, avgDurationMs, phases };
}

/**
 * Record a quality score for an agent based on verifier verdict.
 */
export async function recordQualityScore(cpbRoot, project, jobId, { agent, phase, verdict, ts, dataRoot }) {
  dataRoot = requireDataRoot(dataRoot);
  try {
    await appendEvent(cpbRoot, project, jobId, {
      type: "agent_quality_scored",
      agent,
      phase,
      verdict,
      ts: ts || new Date().toISOString(),
    }, { dataRoot, includeLegacyFallback: false });
  } catch {}

  const dir = perfDir(dataRoot);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${agent}-quality.jsonl`);

  await appendLine(file, JSON.stringify({
    ts: ts || new Date().toISOString(),
    project,
    jobId,
    phase,
    verdict,
  }));
}

/**
 * Get quality metrics for an agent.
 */
export async function getAgentQuality(cpbRoot, agent, { dataRoot }: Record<string, any> = {}) {
  const dir = perfDir(dataRoot);
  const file = path.join(dir, `${agent}-quality.jsonl`);

  let lines;
  try {
    const raw = await readFile(file, "utf8");
    lines = raw.split("\n").filter((l) => l.trim());
  } catch {
    return { agent, total: 0, pass: 0, fail: 0, passRate: null };
  }

  const entries = lines.map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  const pass = entries.filter((e) => e.verdict === "PASS").length;
  const fail = entries.filter((e) => e.verdict === "FAIL").length;
  const total = entries.length;

  return {
    agent,
    total,
    pass,
    fail,
    passRate: total > 0 ? Math.round((pass / total) * 100) : null,
  };
}

async function appendLine(file, line) {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(file, line + "\n", "utf8");
}
