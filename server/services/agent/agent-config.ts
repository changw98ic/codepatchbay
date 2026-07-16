// ── agent-config ──
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { LooseRecord } from "../../../core/contracts/types.js";

type AgentConfigRecord = LooseRecord & {
  scheduler?: AgentConfigRecord;
  mode?: string;
  concurrency?: AgentConfigRecord;
  acpPool?: AgentConfigRecord;
  agents?: AgentConfigRecord;
  agent?: string | null;
  variant?: unknown;
  default?: unknown;
  phases?: LooseRecord;
  variants?: LooseRecord;
  phaseProfiles?: LooseRecord;
  profile?: unknown;
};

type AgentJobRecord = LooseRecord & {
  agent?: string;
  executor?: string | AgentConfigRecord;
  completedPhases?: string[];
  phase?: string;
  workflow?: string;
  status?: string;
  createdAt?: string | number;
  updatedAt?: string | number;
  retryCount?: number;
  failurePhase?: string;
  failureCode?: string;
  blockedReason?: string;
  error?: unknown;
  jobId?: string;
  project?: string;
  task?: string;
};

type AgentMetricRecord = LooseRecord & {
  name?: string;
  displayName?: string;
  stability?: string;
  capabilities?: unknown[];
  defaultRoles?: string[];
  command?: string;
  envPrefix?: string;
  pool?: unknown;
  jobs?: AgentConfigRecord;
  performance?: AgentConfigRecord;
  quality?: AgentConfigRecord;
  score?: unknown;
  avgDurationMs?: number | null;
  totalRequests?: number;
  pass?: number;
  total?: number;
  install?: Record<string, AgentMetricRecord>;
  id?: string;
  sourceUrl?: string;
  label?: string;
  notes?: unknown[];
  generatedAt?: string;
  tools?: Record<string, AgentConfigRecord>;
  installed?: boolean;
  status?: string;
  version?: string;
  error?: unknown;
  vendor?: string;
  binary?: string;
  recommended?: boolean;
  tier?: string | null;
  roles?: string[];
  auth?: AgentConfigRecord;
  adapter?: unknown;
  methods?: string[];
  statusCommand?: string;
  connectCommand?: string;
};

type AgentSetupOptions = {
  setupSnapshot?: AgentMetricRecord;
  catalog?: AgentMetricRecord[];
};

/**
 * Agent config service -- reads hub-level and project-level agent/variant config.
 *
 * Merge priority: queue metadata > project config > hub config > hardcoded fallback
 */

const HUB_CONFIG_FILE = "config.json";

async function readJson(filePath: string): Promise<AgentConfigRecord> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

async function writeJson(filePath: string, data: AgentConfigRecord) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function normalizeHubConfig(data: unknown): AgentConfigRecord {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const removedHubTotalKey = ["maxActive", "Total"].join("");
  const next: AgentConfigRecord = { ...data };
  if (next.concurrency && typeof next.concurrency === "object" && !Array.isArray(next.concurrency)) {
    next.concurrency = { ...next.concurrency };
    delete next.concurrency[removedHubTotalKey];
    if (Object.keys(next.concurrency).length === 0) delete next.concurrency;
  }
  if (next.acpPool && typeof next.acpPool === "object" && !Array.isArray(next.acpPool)) {
    next.acpPool = { ...next.acpPool };
    delete next.acpPool.total;
    if (Object.keys(next.acpPool).length === 0) delete next.acpPool;
  }
  if (next.scheduler && typeof next.scheduler === "object" && !Array.isArray(next.scheduler)) {
    next.scheduler = { ...next.scheduler };
  } else {
    delete next.scheduler;
  }
  return next;
}

const VALID_SCHEDULER_MODES = new Set(["default", "smart"]);

export function isValidSchedulerMode(mode: string) {
  return VALID_SCHEDULER_MODES.has(mode);
}

export function readSchedulerConfig(hubConfig: AgentConfigRecord) {
  const scheduler = hubConfig?.scheduler;
  if (!scheduler || typeof scheduler !== "object") return { mode: "default" };
  const mode = VALID_SCHEDULER_MODES.has(scheduler.mode) ? scheduler.mode : "default";
  return { mode };
}

// -- Hub config (~/.cpb/config.json) --

export async function readHubConfig(hubRoot: string) {
  return normalizeHubConfig(await readJson(path.join(hubRoot, HUB_CONFIG_FILE)));
}

export async function writeHubConfig(hubRoot: string, data: AgentConfigRecord) {
  await writeJson(path.join(hubRoot, HUB_CONFIG_FILE), normalizeHubConfig(data));
}

// -- Project config (wiki/projects/{id}/project.json -> agents) --

function projectConfigPath(root: string, project: string) {
  return path.join(root, "wiki", "projects", project, "project.json");
}

function uniqueRoots(roots: (string | null | undefined)[]) {
  const seen = new Set();
  const result = [];
  for (const root of roots) {
    if (!root) continue;
    const resolved = path.resolve(root);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

export async function readProjectJson(cpbRoot: string, project: string) {
  return readJson(projectConfigPath(cpbRoot, project));
}

export async function readProjectJsonFromRoots(roots: (string | null | undefined)[], project: string) {
  for (const root of uniqueRoots(roots)) {
    const data = await readProjectJson(root, project);
    if (data && Object.keys(data).length > 0) return data;
  }
  return {};
}

export async function writeProjectJson(cpbRoot: string, project: string, data: AgentConfigRecord) {
  await writeJson(projectConfigPath(cpbRoot, project), data);
}

export async function readProjectConfig(cpbRoot: string, project: string) {
  const data = await readProjectJson(cpbRoot, project);
  return data.agents || null;
}

export async function readProjectConfigFromRoots(roots: (string | null | undefined)[], project: string) {
  for (const root of uniqueRoots(roots)) {
    const agents = await readProjectConfig(root, project);
    if (agents && Object.keys(agents).length > 0) return agents;
  }
  return null;
}

export async function writeProjectAgents(cpbRoot: string, project: string, agents: AgentConfigRecord | null) {
  const data = await readProjectJson(cpbRoot, project);
  if (agents && Object.keys(agents).length > 0) {
    data.agents = agents;
  } else {
    delete data.agents;
  }
  await writeProjectJson(cpbRoot, project, data);
}

// -- Merge: resolve effective agents config --

function isStringRecord(value: unknown): value is LooseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentConfigRecord(value: unknown): value is AgentConfigRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metricRecord(value: unknown): AgentMetricRecord {
  const record: AgentMetricRecord = {};
  if (isStringRecord(value)) Object.assign(record, value);
  return record;
}

function numberValue(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function timestampMs(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeAgentSpec(raw: unknown) {
  if (!raw) return null;
  if (isStringRecord(raw)) {
    const obj = raw;
    if (obj.agent === null && obj.variant) {
      return { agent: null, variant: obj.variant };
    }
    const agentStr = String(obj.agent || "");
    if (agentStr.includes(":")) {
      const [agent, variant] = agentStr.split(":", 2);
      return { agent, variant: variant || obj.variant || null };
    }
    return { agent: agentStr || "claude", variant: obj.variant || null };
  }
  const colonIdx = String(raw).indexOf(":");
  if (colonIdx >= 0) {
    return { agent: String(raw).slice(0, colonIdx), variant: String(raw).slice(colonIdx + 1) || null };
  }
  return { agent: String(raw), variant: null };
}

function resolveFromConfig(config: AgentConfigRecord | null | undefined): AgentConfigRecord {
  if (!config) return {};
  const result: AgentConfigRecord = {};
  const defaultSpec = normalizeAgentSpec(config.default);
  if (defaultSpec) result.default = defaultSpec;

  if (config.phases) {
    for (const [phase, raw] of Object.entries(config.phases)) {
      const spec = normalizeAgentSpec(raw);
      if (spec) {
        if (config.variants?.[phase] && !spec.variant) {
          spec.variant = config.variants[phase];
        }
        result[phase] = spec;
      }
    }
  }

  if (config.variants) {
    for (const [phase, variant] of Object.entries(config.variants)) {
      if (variant && !result[phase]) {
        result[phase] = { agent: null, variant };
      }
    }
  }

  if (config.phaseProfiles) {
    for (const [phase, profile] of Object.entries(config.phaseProfiles)) {
      const spec = result[phase];
      if (isAgentConfigRecord(spec) && profile) {
        spec.profile = profile;
      }
    }
  }

  return result;
}

const PHASE_TO_ROLE = {
  plan: "planner",
  execute: "executor",
  verify: "verifier",
  review: "reviewer",
  remediate: "remediator",
};

/**
 * Merge agents config from hub config, project config, and metadata.
 * Returns { planner, executor, verifier, reviewer } objects with { agent, variant }.
 * Later sources override earlier ones.
 */
export function mergeAgentConfig(hubAgents: AgentConfigRecord | null | undefined, projectAgents: AgentConfigRecord | null | undefined, metadataAgents: AgentConfigRecord | null | undefined) {
  const merged: AgentConfigRecord = {};

  function applyResolved(resolved: AgentConfigRecord, overrideDefault: boolean) {
    if (isAgentConfigRecord(resolved.default)) {
      for (const role of ["planner", "executor", "verifier", "reviewer"]) {
        if (overrideDefault || !merged[role]) merged[role] = { ...resolved.default };
      }
    }
    for (const [phase, rawSpec] of Object.entries(resolved)) {
      if (phase === "default") continue;
      if (!isAgentConfigRecord(rawSpec)) continue;
      const spec = rawSpec;
      const role = PHASE_TO_ROLE[phase] || phase;
      const existing = merged[role];
      if (spec.agent === null && isAgentConfigRecord(existing)) {
        merged[role] = { ...existing, variant: spec.variant };
      } else {
        merged[role] = { ...spec };
      }
    }
  }

  applyResolved(resolveFromConfig(hubAgents), true);
  applyResolved(resolveFromConfig(projectAgents), false);

  if (metadataAgents) {
    if (typeof metadataAgents === "object" && !metadataAgents.agent) {
      for (const [key, raw] of Object.entries(metadataAgents)) {
        if (key === "default") continue;
          const spec = normalizeAgentSpec(raw);
          if (spec) {
            const role = PHASE_TO_ROLE[key] || key;
            const existing = merged[role];
            if (spec.agent === null && isAgentConfigRecord(existing)) {
              merged[role] = { ...existing, variant: spec.variant };
            } else {
              merged[role] = spec;
            }
        }
      }
    } else {
      const metaSpec = normalizeAgentSpec(metadataAgents);
      if (metaSpec) {
        for (const role of ["planner", "executor", "verifier", "reviewer"]) {
          merged[role] = { ...metaSpec };
        }
      }
    }
  }

  return merged;
}

/**
 * Build the `agents` object for queue entry metadata from config.
 * Called at enqueue time.
 */
export async function resolveAgentsForEntry(hubRoot: string, cpbRoot: string, project: string, metadata: AgentConfigRecord = {}) {
  const metadataRecord: AgentConfigRecord = metadata;
  const hubConfig = await readHubConfig(hubRoot);
  const projectAgents = await readProjectConfigFromRoots(
    [hubRoot, process.env.CPB_ROOT, cpbRoot],
    project,
  );

  const merged = mergeAgentConfig(
    hubConfig.agents,
    projectAgents,
    metadataRecord.agents || null,
  );

  if (Object.keys(merged).length === 0 && !metadataRecord.agent) return metadata;

  return {
    ...metadata,
    agents: Object.keys(merged).length > 0 ? merged : undefined,
    agent: metadataRecord.agent || undefined,
  };
}

// ── agent-metrics ──
import * as agentRegistry from "../../../core/agents/registry.js";
import { listJobs } from "../job/job-store.js";
import { getWorkflow, roleForPhase } from "../../../core/workflow/definition.js";
import { scoreAgentMetrics } from "../../../core/agents/scoring.js";
import { getAgentPerformance, getAgentQuality } from "../observability/observability.js";

const TERMINAL_STATES = new Set(["completed", "failed", "blocked", "cancelled"]);

function resolveAgentForJob(j: AgentJobRecord) {
  if (j.agent && typeof j.agent === "string") {
    return j.agent;
  }
  if (j.executor && typeof j.executor === "string") {
    return j.executor;
  }
  if (j.executor && typeof j.executor === "object" && j.executor.packageName) {
    return j.executor.packageName;
  }

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

function classifyJobsByAgent(allJobs: AgentJobRecord[]) {
  const byAgent = new Map();
  for (const j of allJobs) {
    const agent = resolveAgentForJob(j);
    if (!byAgent.has(agent)) byAgent.set(agent, []);
    byAgent.get(agent).push(j);
  }
  return byAgent;
}

function buildJobStats(jobs: AgentJobRecord[]) {
  const completed = jobs.filter((j) => j.status === "completed");
  const failed = jobs.filter((j) => j.status === "failed");
  const cancelled = jobs.filter((j) => j.status === "cancelled");
  const running = jobs.filter((j) => !TERMINAL_STATES.has(j.status));
  const durations = completed
    .map((j) => {
      const createdAt = timestampMs(j.createdAt);
      const updatedAt = timestampMs(j.updatedAt);
      return createdAt !== null && updatedAt !== null ? Math.max(0, updatedAt - createdAt) : null;
    })
    .filter((duration): duration is number => duration !== null);
  const totalDurationMs = durations.reduce((s, d) => s + d, 0);
  const avgDurationMs = durations.length > 0
    ? Math.round(totalDurationMs / durations.length)
    : null;

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

  const failureCodes = {};
  for (const j of failed) {
    if (j.failureCode) failureCodes[j.failureCode] = (failureCodes[j.failureCode] || 0) + 1;
  }

  const retryCount = jobs.reduce((sum: number, j: AgentJobRecord) => sum + Math.max(0, Number(j.retryCount) || 0), 0);
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

function buildScoreInput(stats: AgentConfigRecord, performance: AgentConfigRecord, quality: AgentConfigRecord) {
  const avgDurationMs = numberValue(performance.avgDurationMs);
  const totalRequests = numberValue(performance.totalRequests);
  const performanceDuration = avgDurationMs && totalRequests
    ? avgDurationMs * totalRequests
    : 0;
  return {
    totalJobs: stats.total,
    successes: stats.completed,
    failures: numberValue(stats.failed) + numberValue(stats.blocked) + numberValue(stats.cancelled),
    totalDurationMs: numberValue(stats.totalDurationMs, performanceDuration),
    retries: numberValue(stats.retryCount),
    verifierPasses: numberValue(quality.pass),
    verifierRuns: numberValue(quality.total),
    timeouts: numberValue(stats.timeoutCount),
    userRejections: numberValue(stats.userRejectionCount),
  };
}

export async function collectAgentMetrics(cpbRoot: string, _options: AgentConfigRecord = {}) {
  let descriptors = [];
  try {
    await agentRegistry.loadRegistry(undefined);
    descriptors = agentRegistry.listAgents();
  } catch {
    return { agents: [], timestamp: new Date().toISOString() };
  }

  const allJobs: AgentJobRecord[] = await listJobs(cpbRoot).catch(() => []);
  const jobsByAgent = classifyJobsByAgent(allJobs);

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

    let poolInfo = null;
    try {
      const { getManagedAcpPool } = await import("../acp/acp-pool.js");
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

export async function getAgentDetail(cpbRoot: string, agentName: string) {
  const metrics = await collectAgentMetrics(cpbRoot);
  return metrics.agents.find((a: AgentMetricRecord) => a.name === agentName) || null;
}

export async function getAgentJobs(cpbRoot: string, agentName: string, opts: AgentConfigRecord = {}) {
  const limit = Math.max(0, numberValue(opts.limit, 50));
  const allJobs: AgentJobRecord[] = await listJobs(cpbRoot).catch(() => []);
  return allJobs
    .filter((j: AgentJobRecord) => resolveAgentForJob(j) === agentName)
    .sort((a: AgentJobRecord, b: AgentJobRecord) => (timestampMs(b.createdAt) || 0) - (timestampMs(a.createdAt) || 0))
    .slice(0, limit)
    .map((j: AgentJobRecord) => ({
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

// ── agent-setup-readiness ──
import { listSetupAgents } from "../../../core/setup/agent-catalog.js";
import { detectSetupEnvironment } from "../../../core/setup/detect.js";

function installMethods(agent: AgentMetricRecord) {
  return Object.keys(agent.install || {});
}

function preferredMethod(agent: AgentMetricRecord, setupSnapshot: AgentMetricRecord = {}) {
  const tools = metricRecord(setupSnapshot.tools);
  const brew = metricRecord(tools.brew);
  const npm = metricRecord(tools.npm);
  const methods = installMethods(agent);
  if (methods.includes("brew") && brew.installed) return "brew";
  if (methods.includes("npm") && npm.installed) return "npm";
  return methods[0] || "manual";
}

function splitSimpleCommand(command: string) {
  const parts = String(command || "").trim().split(/\s+/).filter(Boolean);
  return { command: parts[0] || "", args: parts.slice(1) };
}

function buildNonExecutingPlan(agent: AgentMetricRecord, method: string) {
  const install = agent.install?.[method] || null;
  if (!install) return null;
  const installCommand = String(install.command || "");
  const shell = /[|&;<>()]/.test(installCommand);
  const parsed = shell
    ? { command: "sh", args: ["-lc", installCommand] }
    : splitSimpleCommand(installCommand);

  return {
    method,
    label: install.label || method,
    safePlanCommand: `cpb agents install ${agent.id} --method ${method}`,
    command: parsed.command,
    args: parsed.args,
    displayCommand: installCommand,
    sourceUrl: install.sourceUrl || agent.sourceUrl || null,
    notes: install.notes || [],
    requiresExplicitConfirmation: true,
    executed: false,
    shell,
  };
}

export function buildAgentSetupReadiness({
  setupSnapshot = {},
  catalog,
}: AgentSetupOptions = {}) {
  const snapshot = metricRecord(setupSnapshot);
  const setupAgents = metricRecord(snapshot.agents);
  const agents = (catalog || listSetupAgents()).map((agentValue: unknown) => {
    const agent = metricRecord(agentValue);
    const agentId = String(agent.id || "");
    const probe = metricRecord(setupAgents[agentId] || { installed: false, status: "missing" });
    const installed = Boolean(probe.installed);
    const method = preferredMethod(agent, snapshot);
    const plan = installed ? null : buildNonExecutingPlan(agent, method);

    return {
      id: agentId,
      displayName: agent.displayName,
      vendor: agent.vendor,
      binary: agent.binary,
      recommended: Boolean(agent.recommended),
      tier: agent.tier ?? null,
      roles: agent.roles || [],
      capabilities: agent.capabilities || [],
      installed,
      status: probe.status || (installed ? "installed" : "missing"),
      version: probe.version || null,
      error: probe.error || null,
      installMethods: installMethods(agent),
      install: plan,
      auth: {
        methods: agent.auth?.methods || [],
        statusCommand: agent.auth?.statusCommand || null,
        connectCommand: agent.auth?.connectCommand || null,
      },
      adapter: agent.adapter || null,
      sourceUrl: agent.sourceUrl || null,
    };
  });

  return {
    agents,
    timestamp: snapshot.generatedAt || new Date().toISOString(),
  };
}

export async function collectAgentSetupReadiness({
  detect = detectSetupEnvironment,
  catalog,
}: { detect?: () => Promise<unknown>; catalog?: AgentMetricRecord[] } = {}) {
  const setupSnapshot = metricRecord(await detect());
  return buildAgentSetupReadiness({ setupSnapshot, catalog });
}
