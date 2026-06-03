import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpClient, parseToolPolicy, resolveAcpAuditFile, resolveWriteAllowPaths } from "../../runtime/acp-client-core.mjs";
import { applyVariantToEnv, resolveVariantConfig } from "../../runtime/apply-variant.js";
import { saveSessionId, loadSessionId, clearSessionId } from "../../core/agents/session-cache.js";
import { buildAcpPoolEnv, buildChildEnv } from "../../core/policy/child-env.js";
import { buildAgentSandboxLaunch } from "../../core/policy/agent-sandbox.js";
import {
  ProviderQuotaError,
  assertProviderAvailable,
  classifyQuotaFailure,
} from "./provider-quota.js";
import { getProviderAdapter } from "./provider-adapters.js";

let _registryCache = null;

/**
 * Compound key for persistent client isolation.
 * Job id is intentionally excluded so a long-lived worker/orchestrator can
 * reuse the same ACP process across sequential jobs for the same project role.
 */
export function poolClientKey(agent, options = {}) {
  const role = options.role || options.phase || "";
  const projectId = options.projectId || "";
  const workspaceId = options.workspaceId || "";
  const cwd = options.cwd || "";
  const policyHash = options.policyHash || "";
  const variant = options.variant || "";
  return [agent, role, projectId, workspaceId, cwd, policyHash, variant].join("::");
}

async function getRegistry() {
  if (_registryCache) return _registryCache;
  try {
    const mod = await import("../../core/agents/registry.js");
    await mod.loadRegistry();
    _registryCache = mod;
  } catch {
    _registryCache = null;
  }
  return _registryCache;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT_MS = Number(process.env.CPB_ACP_POOL_TIMEOUT_MS || 0);
const CHILD_TERM_GRACE_MS = 500;
const CHILD_KILL_GRACE_MS = 1_500;
const DEFAULT_PROVIDER_CONNECTION_LIMIT = 3;
const CONNECTION_LOCK_TTL_MS = 30_000;
const CONNECTION_POLL_MS = 50;
const DEFAULT_POOL_WAIT_TIMEOUT_MS = Number(process.env.CPB_ACP_POOL_WAIT_TIMEOUT_MS || 300_000);
const POOL_WAIT_WARN_INTERVAL_MS = 30_000;

function resolveHubRootFromEnv(cpbRoot, env = {}) {
  if (env.CPB_HUB_ROOT) return path.resolve(env.CPB_HUB_ROOT);
  const home = os.homedir();
  return home ? path.join(home, ".cpb") : path.join(path.resolve(cpbRoot), ".cpb", "hub");
}

function emptyUsageRollup() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    toolCalls: 0,
    functionCalls: 0,
    events: 0,
    tokenSource: null,
  };
}

function addUsageRollup(target, usage = {}) {
  for (const key of [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
    "costUsd",
    "toolCalls",
    "functionCalls",
    "events",
  ]) {
    const value = Number(usage[key]);
    if (Number.isFinite(value)) target[key] += value;
  }
  target.tokenSource = usage.tokenSource || target.tokenSource || "acp_audit";
}

function finalizeUsageRollup(rollup, { tokenEvents = 0, toolCalls = 0, source = "acp_audit" } = {}) {
  if (toolCalls > 0 && rollup.toolCalls === 0) rollup.toolCalls = toolCalls;
  if (rollup.events <= 0 && tokenEvents <= 0) {
    return toolCalls > 0
      ? { ...rollup, tokenSource: "acp_not_reported", toolCalls }
      : null;
  }
  rollup.events = Math.max(rollup.events, tokenEvents);
  rollup.tokenSource = rollup.tokenSource ? `${source}:${rollup.tokenSource}` : source;
  return rollup;
}

function auditEventMatches(event, { phase = null, role = null } = {}) {
  if (phase && event.phase !== phase) return false;
  if (role && event.role !== role) return false;
  return true;
}

export async function readAcpUsageFromAudit(auditFile, filter = {}) {
  if (!auditFile) return null;
  let raw;
  try {
    raw = await readFile(auditFile, "utf8");
  } catch {
    return null;
  }

  const promptRollup = emptyUsageRollup();
  const tokenRollup = emptyUsageRollup();
  let promptEvents = 0;
  let tokenEvents = 0;
  let toolCalls = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!auditEventMatches(event, filter)) continue;
    if (event.event === "tool_call") toolCalls += 1;
    if (event.event === "prompt_usage" && event.usage) {
      addUsageRollup(promptRollup, event.usage);
      promptEvents += 1;
    } else if (event.event === "token_usage" && event.usage) {
      addUsageRollup(tokenRollup, event.usage);
      tokenEvents += 1;
    }
  }

  if (promptEvents > 0) {
    return finalizeUsageRollup(promptRollup, {
      tokenEvents: promptEvents,
      toolCalls,
      source: "acp_audit_prompt_usage",
    });
  }
  return finalizeUsageRollup(tokenRollup, {
    tokenEvents,
    toolCalls,
    source: "acp_audit_token_usage",
  });
}

export class RateLimitError extends Error {
  constructor(agent, untilTs, message = "ACP provider is rate limited") {
    super(`${message}: ${agent} until ${new Date(untilTs).toISOString()}`);
    this.name = "RateLimitError";
    this.agent = agent;
    this.untilTs = untilTs;
  }
}

/**
 * Structured ACP execution error with partial stdout/stderr for handoff bundles.
 */
export class AcpExecutionError extends Error {
  constructor(message, {
    agent,
    providerKey,
    stdout = "",
    stderr = "",
    exitCode = null,
    signal = null,
    phase = null,
    role = null,
    quota = null,
  } = {}) {
    super(message);
    this.name = "AcpExecutionError";
    this.agent = agent;
    this.providerKey = providerKey || agent;
    this.partialStdout = String(stdout || "").slice(-4000);
    this.partialStderr = String(stderr || "").slice(-4000);
    this.exitCode = exitCode;
    this.signal = signal;
    this.phase = phase;
    this.role = role;
    this.quota = quota; // ProviderQuotaError if this was a quota failure
  }
}

export class PoolExhaustedError extends Error {
  constructor(agent, providerKey, elapsedMs, message) {
    super(message || `ACP pool exhausted: ${agent}/${providerKey} waited ${Math.round(elapsedMs / 1000)}s`);
    this.name = "PoolExhaustedError";
    this.code = "POOL_EXHAUSTED";
    this.agent = agent;
    this.providerKey = providerKey;
    this.elapsedMs = elapsedMs;
  }
}

function agentEnvName(agent) {
  return String(agent || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

export function providerKeyForAgent(agent, env = {}, variant = null) {
  if (variant) return `${agent}:${variant}`;

  if (agent === "claude") {
    const config = resolveVariantConfig(env);
    return config.variant && config.variant !== "none"
      ? `claude:${config.variant}`
      : "claude";
  }

  return agent;
}

function variantNameFromProviderKey(providerKey, agent) {
  const prefix = `${agent}:`;
  return providerKey.startsWith(prefix) ? providerKey.slice(prefix.length) : null;
}

export function envForAgent(agent, env = {}, variant = null) {
  const next = { ...env };

  if (variant) {
    next.CPB_ACP_AGENT_VARIANT = variant;
    next[`CPB_ACP_${agentEnvName(agent)}_VARIANT`] = variant;
  }

  if (agent === "claude") {
    if (variant) next.CPB_CLAUDE_VARIANT = variant;
    applyVariantToEnv(next);
  }

  return next;
}

function acpMetadataEnv(options = {}) {
  const meta = {};
  if (options.projectId) meta.CPB_ACP_PROJECT = options.projectId;
  if (options.jobId) meta.CPB_ACP_JOB_ID = options.jobId;
  if (options.phase) meta.CPB_ACP_PHASE = options.phase;
  if (options.role) meta.CPB_ACP_ROLE = options.role;
  return meta;
}

// Re-export from provider-quota (redaction unified there)
export { sanitizeProviderReason } from "./provider-quota.js";

async function normalizeLimitsAsync(limits = {}) {
  const registry = await getRegistry();

  const result = { ...limits };

  if (registry) {
    for (const agent of registry.listAgentNames()) {
      if (!(agent in result)) {
        result[agent] = registry.getDescriptor(agent)?.poolLimit || 1;
      }
    }
  }

  return result;
}

// Sync fallback for constructor (registry not loaded yet)
function normalizeLimits(limits = {}) {
  const result = { ...limits };
  if (!result.codex) result.codex = 1;
  if (!result.claude) result.claude = 1;
  return result;
}

function numericOption(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function booleanOption(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

function positiveIntOption(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function providerEnvKey(providerKey) {
  return String(providerKey || "unknown").toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signalChild(child, signal) {
  if (!child?.pid) return;
  try {
    if (child.detached && process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try { child.kill(signal); } catch {}
  }
}

function terminateChild(child) {
  return new Promise((resolve) => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      child.removeListener("close", finish);
      resolve();
    };
    const termTimer = setTimeout(() => signalChild(child, "SIGTERM"), 0);
    const killTimer = setTimeout(() => {
      signalChild(child, "SIGKILL");
      setTimeout(finish, CHILD_KILL_GRACE_MS).unref();
    }, CHILD_TERM_GRACE_MS);
    termTimer.unref();
    killTimer.unref();
    child.once("close", finish);
  });
}

export class AcpPool {
  constructor(opts = {}) {
    const parentEnv = opts.env || process.env;
    this.cpbRoot = path.resolve(opts.cpbRoot || parentEnv.CPB_ROOT || path.join(__dirname, ".."));
    this.hubRoot = path.resolve(opts.hubRoot || resolveHubRootFromEnv(this.cpbRoot, parentEnv));
    this.env = buildAcpPoolEnv(parentEnv, {
      CPB_ROOT: this.cpbRoot,
      CPB_ACP_CPB_ROOT: this.cpbRoot,
      CPB_HUB_ROOT: this.hubRoot,
    });
    this.limits = normalizeLimits(opts.limits || opts, this.env);
    this.runner = opts.runner || null;
    this.persistentProcesses = !this.runner && booleanOption(
      opts.persistentProcesses ?? this.env.CPB_ACP_PERSISTENT_PROCESS,
      false,
    );
    this.maxSessionRequests = Math.max(
      0,
      numericOption(opts.maxSessionRequests ?? this.env.CPB_ACP_POOL_MAX_REQUESTS, 0),
    );
    this.maxSessionAgeMs = Math.max(
      0,
      numericOption(opts.maxSessionAgeMs ?? this.env.CPB_ACP_POOL_MAX_AGE_MS, 0),
    );
    this.sessionIdleMs = Math.max(
      0,
      numericOption(opts.sessionIdleMs ?? this.env.CPB_ACP_POOL_IDLE_MS, 0),
    );
    this.providerConnectionLimit = positiveIntOption(
      opts.providerConnectionLimit ?? this.env.CPB_ACP_POOL_PROVIDER_MAX,
      DEFAULT_PROVIDER_CONNECTION_LIMIT,
    );
    this.providerConnectionLimits = opts.providerConnectionLimits || {};
    this.connectionPollMs = positiveIntOption(
      opts.connectionPollMs ?? this.env.CPB_ACP_POOL_CONNECTION_POLL_MS,
      CONNECTION_POLL_MS,
    );
    this.active = new Map();
    this.pending = new Map();
    this.requestCount = new Map();
    this.errorCount = new Map();
    this.lastSpawnAt = new Map();
    this.spawnCount = new Map();
    this.recycleCount = new Map();
    this.liveRequests = new Map();
    this.sessions = new Map();
    this.persistentClients = new Map();
    this.persistentChains = new Map();
    this.lastRecycleReason = new Map();
    this.toolPolicyPromise = null;
    this._seq = 0;
    this.stopped = false;
    this.createdAt = Date.now();
  }

  async init() {
    const registry = await getRegistry();
    if (registry) {
      this.limits = await normalizeLimitsAsync(this.limits);
    }
    return this;
  }

  async start() {
    await this.init();
    return this.status();
  }

  async stop() {
    this.stopped = true;
    await Promise.all([...this.persistentClients.keys()].map((agent) => this.#closePersistentClient(agent)));
    for (const queue of this.pending.values()) {
      while (queue.length) {
        const item = queue.shift();
        item.reject(new Error("ACP pool stopped"));
      }
    }
    this.pending.clear();
    this.liveRequests.clear();
    this.sessions.clear();
    this.persistentChains.clear();
  }

  async statusAsync() {
    const registry = await getRegistry();
    const base = this.status();
    for (const [agent, pool] of Object.entries(base.pools)) {
      const desc = registry?.getDescriptor(agent);
      if (desc) {
        pool.descriptor = {
          displayName: desc.displayName || agent,
          stability: desc.stability || "unknown",
          agentCapabilities: desc.capabilities || [],
          defaultRoles: desc.defaultRoles || [],
          command: desc.command,
          envPrefix: desc.envPrefix,
        };
      }
    }
    return base;
  }

  status() {
    const providerProcessReuse = this.#usesProviderProcessReuse();
    const agents = [...new Set([
      ...Object.keys(this.limits),
      ...this.active.keys(),
      ...this.pending.keys(),
      ...this.sessions.keys(),
      ...this.persistentClients.keys(),
    ])];
    const allLive = [...this.liveRequests.entries()]
      .map(([id, v]) => ({
        requestId: id,
        startedAt: v.startedAt,
        promptSnippet: v.promptSnippet || null,
        promptBytes: v.promptBytes || 0,
        phase: v.phase || null,
      }));
    const now = Date.now();
    const pools = {};
    for (const agent of agents) {
      const session = this.sessions.get(agent);
      const persistent = this.persistentClients.get(agent);
      const capabilities = [
        "rate-limit-backoff",
        "concurrency-bound",
        "durable-state",
        "live-requests",
        "session-recycle-policy",
      ];
      if (providerProcessReuse) capabilities.push("provider-process-reuse");
      pools[agent] = {
        providerKey: this.providerKey(agent),
        limit: this.#providerConnectionLimit(this.providerKey(agent)),
        active: this.active.get(agent) || 0,
        queued: this.pending.get(`provider:${this.providerKey(agent)}`)?.length || 0,
        activeRequests: allLive.filter((r) => r.requestId.startsWith(`${agent}-`)),
        requestCount: this.requestCount.get(agent) || 0,
        sessionRequestCount: session?.requestCount || 0,
        errorCount: this.errorCount.get(agent) || 0,
        spawnCount: this.spawnCount.get(agent) || 0,
        recycleCount: this.recycleCount.get(agent) || 0,
        lastSpawnAt: this.lastSpawnAt.get(agent) || null,
        sessionStartedAt: session?.startedAt || null,
        sessionAgeMs: session?.startedAt ? Math.max(0, now - session.startedAt) : null,
        lastRecycleAt: session?.recycledAt || null,
        recycleReason: session?.recycleReason || null,
        lastRecycleReason: this.lastRecycleReason.get(agent) || null,
        sessionId: session?.sessionId || null,
        rateLimitedUntil: null, // now managed by provider-quota service
        mode: this.runner
          ? "managed-reusable"
          : this.env.CPB_ACP_CLIENT
            ? "custom-client-one-shot"
            : providerProcessReuse
              ? "persistent-provider-process"
              : "bounded-one-shot",
        transport: this.runner
          ? "injected-runner-function"
          : this.env.CPB_ACP_CLIENT
            ? "custom-client-child-process"
            : providerProcessReuse
              ? "persistent-acp-agent-process"
              : "request-scoped-child-process",
        providerProcessReuse,
        providerProcessPid: persistent?.client?.child?.pid || null,
        providerProcessStartedAt: persistent?.startedAt || null,
        providerProcessRequestCount: persistent?.requestCount || 0,
        providerProcessHealthy: persistent ? !persistent.client.closed : null,
        capabilities,
      };
    }
    return {
      createdAt: this.createdAt,
      providerProcessReuse,
      connectionLimits: {
        providerDefault: this.providerConnectionLimit,
      },
      pools,
    };
  }

  #usesProviderProcessReuse() {
    return Boolean(this.persistentProcesses && !this.runner);
  }

  _nextId(agent) {
    return `${agent}-${Date.now()}-${++this._seq}`;
  }

  acquire(agent, options = {}) {
    const providerKey = this.providerKey(agent, options.variant);
    const limit = this.#providerConnectionLimit(providerKey);
    // Count all agents sharing the same provider key
    const active = this.#providerActiveCount(providerKey);
    if (active < limit) {
      const requestId = this._nextId(agent);
      this.active.set(agent, (this.active.get(agent) || 0) + 1);
      this.liveRequests.set(requestId, { agent, startedAt: Date.now(), providerKey });
      return Promise.resolve({ agent, requestId, release: () => this.release(agent, requestId) });
    }
    const timeoutMs = numericOption(options.waitTimeoutMs, DEFAULT_POOL_WAIT_TIMEOUT_MS);
    const start = Date.now();
    let warnTimer = null;
    return new Promise((resolve, reject) => {
      // Queue under provider key (not agent name) so cross-agent waits are shared
      const queueKey = `provider:${providerKey}`;
      const queue = this.pending.get(queueKey) || [];
      const entry = { resolve, reject, agent };
      queue.push(entry);
      this.pending.set(queueKey, queue);

      // 30-second warn log
      warnTimer = setInterval(() => {
        const elapsed = Date.now() - start;
        const currentActive = this.#providerActiveCount(providerKey);
        process.stderr.write(
          `[acp-pool] warn: ACP pool wait: ${agent}/${providerKey} waiting ${Math.round(elapsed / 1000)}s for provider slot (${currentActive}/${limit})\n`,
        );
      }, POOL_WAIT_WARN_INTERVAL_MS);
      warnTimer.unref();

      // Timeout
      if (timeoutMs > 0) {
        const timer = setTimeout(() => {
          clearInterval(warnTimer);
          const idx = queue.indexOf(entry);
          if (idx !== -1) queue.splice(idx, 1);
          const elapsed = Date.now() - start;
          reject(new PoolExhaustedError(agent, providerKey, elapsed));
        }, timeoutMs);
        timer.unref();
        entry._timer = timer;
      }
    });
  }

  /**
   * Count active sessions across all agents that share the same provider key.
   * This is the in-process gate; the file-based lease in #run() handles cross-process.
   */
  #providerActiveCount(providerKey) {
    let count = 0;
    for (const [agent, active] of this.active.entries()) {
      if (this.providerKey(agent) === providerKey) count += active;
    }
    return count;
  }

  release(agent, requestId) {
    const active = Math.max(0, (this.active.get(agent) || 1) - 1);
    this.active.set(agent, active);
    if (requestId) this.liveRequests.delete(requestId);
    // Drain from provider-keyed queue (cross-agent sharing)
    const providerKey = this.providerKey(agent);
    const queueKey = `provider:${providerKey}`;
    const queue = this.pending.get(queueKey) || [];
    const next = queue.shift();
    if (!next) return;
    if (next._timer) clearTimeout(next._timer);
    const nextAgent = next.agent || agent;
    const nextId = this._nextId(nextAgent);
    this.active.set(nextAgent, (this.active.get(nextAgent) || 0) + 1);
    this.liveRequests.set(nextId, { agent: nextAgent, startedAt: Date.now() });
    next.resolve({ agent: nextAgent, requestId: nextId, release: () => this.release(nextAgent, nextId) });
  }

  providerKey(agent, variant = null) {
    return providerKeyForAgent(agent, this.env, variant);
  }

  #connectionLeasesDir() {
    return path.join(this.hubRoot, "providers", "acp-leases");
  }

  #connectionLockDir() {
    return path.join(this.#connectionLeasesDir(), ".lock");
  }

  #providerConnectionLimit(providerKey) {
    const specific = this.providerConnectionLimits[providerKey]
      ?? this.env[`CPB_ACP_POOL_PROVIDER_${providerEnvKey(providerKey)}_MAX`];
    return positiveIntOption(specific, this.providerConnectionLimit);
  }

  async #connectionLockIsStale(lockDir) {
    try {
      const info = await stat(lockDir);
      return Date.now() - info.mtimeMs >= CONNECTION_LOCK_TTL_MS;
    } catch {
      return false;
    }
  }

  async #withConnectionLock(callback) {
    const dir = this.#connectionLeasesDir();
    const lockDir = this.#connectionLockDir();
    await mkdir(dir, { recursive: true });

    let acquired = false;
    while (!this.stopped) {
      try {
        await mkdir(lockDir);
        acquired = true;
        break;
      } catch (err) {
        if (!err || err.code !== "EEXIST") throw err;
        if (await this.#connectionLockIsStale(lockDir)) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
        await sleep(10);
      }
    }

    if (!acquired) throw new Error("ACP pool stopped");
    try {
      return await callback();
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  }

  #leaseAlive(lease) {
    if (!lease?.pid) return false;
    try {
      process.kill(Number(lease.pid), 0);
      return true;
    } catch {
      return false;
    }
  }

  async #listLiveConnectionLeasesLocked() {
    const dir = this.#connectionLeasesDir();
    const leases = [];
    let files = [];
    try {
      files = await readdir(dir);
    } catch {
      return leases;
    }

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = path.join(dir, file);
      try {
        const lease = JSON.parse(await readFile(filePath, "utf8"));
        if (this.#leaseAlive(lease)) {
          leases.push({ ...lease, filePath });
        } else {
          await rm(filePath, { force: true });
        }
      } catch {
        await rm(filePath, { force: true }).catch(() => null);
      }
    }
    return leases;
  }

  async #tryAcquireConnectionLease(agent, providerKey, options = {}) {
    return this.#withConnectionLock(async () => {
      const leases = await this.#listLiveConnectionLeasesLocked();
      const providerLimit = this.#providerConnectionLimit(providerKey);
      const providerCount = leases.filter((lease) => lease.providerKey === providerKey).length;
      if (providerCount >= providerLimit) {
        return null;
      }

      const lease = {
        leaseId: `${Date.now()}-${process.pid}-${++this._seq}`,
        pid: process.pid,
        agent,
        providerKey,
        phase: options.phase || null,
        role: options.role || null,
        acquiredAt: new Date().toISOString(),
      };
      const filePath = path.join(this.#connectionLeasesDir(), `${lease.leaseId}.json`);
      await writeFile(filePath, `${JSON.stringify(lease, null, 2)}\n`, "utf8");
      return { ...lease, filePath };
    });
  }

  async #acquireConnectionLease(agent, providerKey, options = {}) {
    const timeoutMs = numericOption(options.waitTimeoutMs, DEFAULT_POOL_WAIT_TIMEOUT_MS);
    const start = Date.now();
    let lastWarnAt = start;
    while (!this.stopped) {
      const lease = await this.#tryAcquireConnectionLease(agent, providerKey, options);
      if (lease) return lease;
      const elapsed = Date.now() - start;
      if (timeoutMs > 0 && elapsed >= timeoutMs) {
        throw new PoolExhaustedError(agent, providerKey, elapsed);
      }
      if (elapsed - (lastWarnAt - start) >= POOL_WAIT_WARN_INTERVAL_MS) {
        const providerLimit = this.#providerConnectionLimit(providerKey);
        const providerCount = await this.#countProviderLeases(providerKey);
        process.stderr.write(
          `[acp-pool] warn: ${agent}/${providerKey} waiting ${Math.round(elapsed / 1000)}s for provider slot (${providerCount}/${providerLimit})\n`,
        );
        lastWarnAt = Date.now();
      }
      await sleep(this.connectionPollMs);
    }
    throw new Error("ACP pool stopped");
  }

  async #countProviderLeases(providerKey) {
    try {
      const leases = await this.#withConnectionLock(() => this.#listLiveConnectionLeasesLocked());
      return leases.filter((l) => l.providerKey === providerKey).length;
    } catch {
      return -1;
    }
  }

  async #releaseConnectionLease(lease) {
    if (!lease?.filePath) return;
    await rm(lease.filePath, { force: true }).catch(() => null);
  }

  #executionEnv(agent, options = {}) {
    return buildChildEnv(
      envForAgent(agent, this.env, options.variant),
      {
        CPB_ROOT: this.cpbRoot,
        CPB_ACP_CPB_ROOT: this.cpbRoot,
        CPB_HUB_ROOT: this.hubRoot,
        ...acpMetadataEnv(options),
      },
      { agent },
    );
  }

  /**
   * Return all known agent/provider keys from registry + config.
   * Used by hub status to display providers with 0 active leases.
   */
  /**
   * Return the effective connection limit for a provider key.
   * Matches the internal #providerConnectionLimit() resolver.
   */
  getProviderLimit(providerKey) {
    return this.#providerConnectionLimit(providerKey);
  }

  async getKnownProviderKeys() {
    const keys = new Set(Object.keys(this.limits || {}));
    for (const k of Object.keys(this.providerConnectionLimits || {})) keys.add(k);
    try {
      const registry = await getRegistry();
      if (registry) {
        for (const name of registry.listAgentNames()) keys.add(name);
      }
    } catch {}
    // Ensure codex and claude are always present (sync fallback)
    keys.add("codex");
    keys.add("claude");
    return [...keys];
  }

  async connectionLeaseStatus() {
    const dir = this.#connectionLeasesDir();
    const counts = {};
    let files = [];
    try {
      files = await readdir(dir);
    } catch {
      return { total: 0, providers: {} };
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const lease = JSON.parse(await readFile(path.join(dir, file), "utf8"));
        if (!this.#leaseAlive(lease)) {
          await rm(path.join(dir, file), { force: true }).catch(() => null);
          continue;
        }
        const key = lease.providerKey || "unknown";
        counts[key] = (counts[key] || 0) + 1;
      } catch {}
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return { total, providers: counts };
  }

  /**
   * Read provider quotas from the new provider-quota system.
   * Replaces the old readDurableRateLimits().
   */
  async readProviderQuotas() {
    const { readProviderQuotas } = await import("./provider-quota.js");
    return readProviderQuotas(this.hubRoot);
  }

  /**
   * Backward-compatible alias for hub routes that still call readDurableRateLimits.
   */
  async readDurableRateLimits() {
    return this.readProviderQuotas();
  }

  #newSession(agent, recycleReason = null, recycledAt = null) {
    const now = Date.now();
    const session = {
      agent,
      startedAt: now,
      lastUsedAt: null,
      requestCount: 0,
      recycleReason,
      recycledAt,
      sessionId: null,
    };
    this.sessions.set(agent, session);
    this.lastSpawnAt.set(agent, now);
    return session;
  }

  #sessionRecycleReason(session) {
    if (!session) return null;
    if (this.maxSessionRequests > 0 && session.requestCount >= this.maxSessionRequests) {
      return "max_requests";
    }
    if (this.maxSessionAgeMs > 0 && Date.now() - session.startedAt >= this.maxSessionAgeMs) {
      return "max_age";
    }
    if (this.sessionIdleMs > 0 && session.lastUsedAt && Date.now() - session.lastUsedAt >= this.sessionIdleMs) {
      return "idle_timeout";
    }
    return null;
  }

  async #recycleSession(agent, reason) {
    this.recycleCount.set(agent, (this.recycleCount.get(agent) || 0) + 1);
    this.lastRecycleReason.set(agent, reason);
    // Save sessionId before closing if agent uses cached lifecycle
    const session = this.sessions.get(agent);
    if (session?.sessionId) {
      const reg = await getRegistry();
      const desc = reg?.getDescriptor(agent);
      if (desc?.lifecycle === "cached") {
        await saveSessionId(this.cpbRoot, agent, session.sessionId).catch(() => null);
      }
    }
    await this.#closePersistentClient(agent);
    return this.#newSession(agent, reason, Date.now());
  }

  async #prepareSession(agent) {
    let session = this.sessions.get(agent);
    if (!session) return this.#newSession(agent);

    const reason = this.#sessionRecycleReason(session);
    if (reason) session = await this.#recycleSession(agent, reason);
    return session;
  }

  #noteSpawn(agent) {
    this.spawnCount.set(agent, (this.spawnCount.get(agent) || 0) + 1);
    if (!this.runner) this.lastSpawnAt.set(agent, Date.now());
  }

  async execute(agent, prompt, cwd = this.cpbRoot, timeoutMs = DEFAULT_TIMEOUT_MS, options = {}) {
    if (options.bypass) {
      const output = await this.#run(agent, prompt, cwd, timeoutMs);
      return { output, providerKey: null, agent, variant: null };
    }
    const providerKey = this.providerKey(agent, options.variant);
    const acpAuditFile = resolveAcpAuditFile(this.#executionEnv(agent, options));

    // Pre-flight quota gate (replaces old assertNotRateLimited)
    if (!this.runner) {
      await assertProviderAvailable(this.hubRoot, {
        providerKey,
        agent,
        variant: options.variant,
        phase: options.phase,
        role: options.role,
      });
    }

    const session = await this.acquire(agent);
    const lifecycle = await this.#prepareSession(agent);
    if (session.requestId) {
      const entry = this.liveRequests.get(session.requestId);
      if (entry) {
        const promptText = String(prompt);
        entry.promptSnippet = promptText.slice(0, 80);
        entry.promptBytes = Buffer.byteLength(promptText, "utf8");
        if (options.phase) entry.phase = options.phase;
      }
    }
    try {
      if (this.runner || !this.persistentProcesses) this.#noteSpawn(agent);
      const output = await this.#run(agent, prompt, cwd, timeoutMs, options);
      const usage = await readAcpUsageFromAudit(acpAuditFile, {
        phase: options.phase || null,
        role: options.role || null,
      });
      this.requestCount.set(agent, (this.requestCount.get(agent) || 0) + 1);
      lifecycle.requestCount += 1;
      lifecycle.lastUsedAt = Date.now();
      lifecycle.recycleReason = null;
      return { output, providerKey, agent, variant: options.variant || null, acpAuditFile, usage };
    } catch (error) {
      const usage = await readAcpUsageFromAudit(acpAuditFile, {
        phase: options.phase || null,
        role: options.role || null,
      });
      if (usage) error.usage = usage;
      if (acpAuditFile) error.acpAuditFile = acpAuditFile;
      this.errorCount.set(agent, (this.errorCount.get(agent) || 0) + 1);

      // Classify via provider-quota (replaces old is429 + noteRateLimit)
      const adapter = getProviderAdapter(providerKey);
      const quotaResult = await classifyQuotaFailure({
        providerKey,
        agent,
        variant: options.variant,
        error,
        stdout: "",
        stderr: error?.message || "",
        adapter,
      });

      if (quotaResult.isQuota) {
        await this.#recycleSession(agent, "rate_limit");
        // Route through delegate client (fail closed — delegate error propagates)
        const { delegateMarkProviderUnavailable } = await import("./quota-delegate-client.js");
        await delegateMarkProviderUnavailable(this.hubRoot, {
          providerKey,
          agent,
          variant: options.variant,
          status: quotaResult.status,
          nextEligibleAt: quotaResult.nextEligibleAt,
          source: quotaResult.source || "acp-pool-classifier",
          confidence: quotaResult.confidence,
          reason: quotaResult.reason,
        });
        const quotaError = new ProviderQuotaError(quotaResult.reason, {
          providerKey,
          agent,
          variant: options.variant,
          status: quotaResult.status,
          nextEligibleAt: quotaResult.nextEligibleAt,
          source: "acp-pool-classifier",
          confidence: quotaResult.confidence,
          reason: quotaResult.reason,
          phase: options.phase,
          role: options.role,
        });
        quotaError.usage = usage || null;
        quotaError.acpAuditFile = acpAuditFile;
        throw quotaError;
      }

      await this.#recycleSession(agent, "error");
      throw error;
    } finally {
      session.release();
    }
  }

  async #run(agent, prompt, cwd, timeoutMs, options = {}) {
    if (this.runner) {
      const lease = await this.#acquireConnectionLease(agent, this.providerKey(agent, options.variant), options);
      try {
        return await this.runner({ agent, prompt, cwd, timeoutMs });
      } finally {
        await this.#releaseConnectionLease(lease);
      }
    }
    if (this.env.CPB_ACP_CLIENT) return this.#runOneShot(agent, prompt, cwd, timeoutMs, options);
    if (this.persistentProcesses || agent === "browser-agent") return this.#runPersistent(agent, prompt, cwd, timeoutMs, options);
    return this.#runOneShot(agent, prompt, cwd, timeoutMs, options);
  }

  async #runOneShot(agent, prompt, cwd, timeoutMs, options = {}) {
    const lease = await this.#acquireConnectionLease(agent, this.providerKey(agent, options.variant), options);
    const customClient = this.env.CPB_ACP_CLIENT;
    const clientPath = customClient || path.join(__dirname, "..", "..", "bridges", "acp-client.mjs");
    const command = customClient ? clientPath : process.execPath;
    const args = customClient ? ["--agent", agent, "--cwd", cwd] : [clientPath, "--agent", agent, "--cwd", cwd];
    try {
      return await new Promise((resolve, reject) => {
        const env = this.#executionEnv(agent, options);
        const launch = buildAgentSandboxLaunch(command, args, { env, cwd: this.cpbRoot });
        const child = spawn(launch.command, launch.args, {
          cwd: this.cpbRoot,
          env,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timer = timeoutMs > 0
          ? setTimeout(() => {
            if (settled) return;
            settled = true;
            terminateChild(child).finally(() => {
              reject(new Error(`${agent} timed out after ${timeoutMs}ms`));
            });
          }, timeoutMs)
          : null;
        if (timer) timer.unref();
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (code === 0) resolve(stdout.trim());
          else reject(new Error(`${agent} exited ${code}: ${stderr.slice(-1000)}`));
        });
        child.stdin.write(prompt);
        child.stdin.end();
      });
    } finally {
      await this.#releaseConnectionLease(lease);
    }
  }

  #runPersistent(agent, prompt, cwd, timeoutMs, options = {}) {
    const key = poolClientKey(agent, options);
    const prior = this.persistentChains.get(key) || Promise.resolve();
    const providerKey = this.providerKey(agent, options.variant);
    const waitTimeout = numericOption(this.env.CPB_ACP_POOL_WAIT_TIMEOUT_MS, DEFAULT_POOL_WAIT_TIMEOUT_MS);
    const warnInterval = POOL_WAIT_WARN_INTERVAL_MS;

    // Wrap prior promise with timeout + warn so a stuck predecessor doesn't block forever
    const timedPrior = new Promise((resolve, reject) => {
      let elapsed = 0;
      const warnTimer = setInterval(() => {
        elapsed += warnInterval;
        if (waitTimeout > 0 && elapsed >= waitTimeout) {
          clearInterval(warnTimer);
          reject(new PoolExhaustedError(agent, providerKey, elapsed, `persistent chain wait timeout: ${agent}/${providerKey} waited ${Math.round(elapsed / 1000)}s for prior call to complete`));
        } else {
          const ts = new Date().toISOString();
          process.stderr.write(`${ts} [warn] [acp-pool] persistent chain wait: ${agent} waiting ${Math.round(elapsed / 1000)}s for prior call to complete\n`);
        }
      }, warnInterval);
      prior.then(() => { clearInterval(warnTimer); resolve(); }, () => { clearInterval(warnTimer); resolve(); });
    });

    const run = timedPrior
      .then(() => this.#runPersistentNow(key, agent, prompt, cwd, timeoutMs, options));
    this.persistentChains.set(key, run.catch(() => null));
    return run;
  }

  async #runPersistentNow(key, agent, prompt, cwd, timeoutMs, options = {}) {
    const persistent = await this.#getPersistentClient(key, agent, cwd, options);
    const client = persistent.client;
    const executionEnv = this.#executionEnv(agent, options);
    client.setAuditContext(executionEnv, {
      cwd,
      writeAllowPaths: resolveWriteAllowPaths(cwd, executionEnv),
    });
    const previousOutputSink = client.outputSink;
    const previousErrorSink = client.errorSink;
    let stdout = "";
    let stderr = "";
    let timer;

    const timeout = timeoutMs > 0
      ? new Promise((_, reject) => {
          timer = setTimeout(() => {
            void this.#closePersistentClient(key);
            reject(new Error(`${agent} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          timer.unref();
        })
      : new Promise(() => {}); // never resolves — no timeout

    client.outputSink = (chunk) => { stdout += chunk?.toString ? chunk.toString() : String(chunk); };
    client.errorSink = (chunk) => { stderr += chunk?.toString ? chunk.toString() : String(chunk); };

    try {
      const sessionId = await Promise.race([client.promptOnce(prompt, cwd), timeout]);
      persistent.requestCount += 1;
      persistent.lastUsedAt = Date.now();
      // Capture sessionId for cached lifecycle
      if (sessionId) {
        const session = this.sessions.get(agent);
        if (session) session.sessionId = sessionId;
      }
      return stdout.trim();
    } catch (error) {
      await this.#closePersistentClient(key);
      if (stderr && !String(error.message || "").includes(stderr.slice(-120))) {
        throw new Error(`${error.message}: ${stderr.slice(-1000)}`);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      client.outputSink = previousOutputSink;
      client.errorSink = previousErrorSink;
    }
  }

  async #getPersistentClient(key, agent, cwd, options = {}) {
    const existing = this.persistentClients.get(key);
    if (existing && !existing.client.closed) return existing;
    if (existing) this.persistentClients.delete(key);

    // Load cached sessionId for cached lifecycle agents
    let resumeSessionId = null;
    const reg = await getRegistry();
    const desc = reg?.getDescriptor(agent);
    if (desc?.lifecycle === "cached") {
      const cached = await loadSessionId(this.cpbRoot, agent).catch(() => null);
      if (cached?.sessionId) resumeSessionId = cached.sessionId;
    }

    const variant = options.variant || null;
    const providerKey = this.providerKey(agent, variant);
    const lease = await this.#acquireConnectionLease(agent, providerKey);
    const client = new AcpClient({
      agent,
      cwd,
      writeAllowPaths: resolveWriteAllowPaths(cwd, this.env),
      terminalPolicy: this.env.CPB_ACP_TERMINAL === "deny" ? "deny" : "allow",
      toolPolicy: await this.#getToolPolicy(),
      outputSink: () => {},
      errorSink: () => {},
      env: this.#executionEnv(agent, options),
      resumeSessionId,
      reuseSession: true,
    });
    const meta = {
      client,
      agent,
      providerKey,
      connectionLease: lease,
      startedAt: Date.now(),
      requestCount: 0,
      lastUsedAt: null,
    };
    this.persistentClients.set(key, meta);
    this.#noteSpawn(agent);

    try {
      await client.start();
      return meta;
    } catch (error) {
      this.persistentClients.delete(key);
      await client.close().catch(() => null);
      await this.#releaseConnectionLease(lease);
      throw error;
    }
  }

  #getToolPolicy() {
    if (!this.toolPolicyPromise) this.toolPolicyPromise = parseToolPolicy(this.env);
    return this.toolPolicyPromise;
  }

  async #closePersistentClient(keyOrAgent) {
    // Support both compound key (agent::role::projectId) and bare agent name
    const matchingKeys = [...this.persistentClients.keys()].filter(k =>
      k === keyOrAgent || k.startsWith(`${keyOrAgent}::`)
    );

    for (const key of matchingKeys) {
      const persistent = this.persistentClients.get(key);
      if (!persistent) continue;
      const agent = persistent.agent;
      // Save sessionId for cached lifecycle before closing
      const session = this.sessions.get(agent);
      if (session?.sessionId) {
        const reg = await getRegistry();
        const desc = reg?.getDescriptor(agent);
        if (desc?.lifecycle === "cached") {
          await saveSessionId(this.cpbRoot, agent, session.sessionId).catch(() => null);
        }
      }
      this.persistentClients.delete(key);
      await persistent.client.close().catch(() => null);
      await this.#releaseConnectionLease(persistent.connectionLease);
    }
  }
}

// ─── Singleton management (from server/services/acp-pool-runtime.js) ───

const runtimes = new Map();
const managedViews = new Map();

function managedStatus(pool) {
  const status = pool.status();
  return {
    ...status,
    mode: "managed-shared",
    poolSingleton: true,
    pools: Object.fromEntries(Object.entries(status.pools).map(([agent, state]) => [
      agent,
      {
        ...state,
        mode: "pool-admission-singleton",
        poolSingleton: true,
        capabilities: [...new Set([...(state.capabilities || []), "pool-singleton"])],
      },
    ])),
  };
}

function managedView(pool) {
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === "status") return () => managedStatus(target);
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function resolvePoolRoots(hubRoot, cpbRoot, env = process.env) {
  const resolvedCpbRoot = path.resolve(cpbRoot || env.CPB_ROOT || path.join(__dirname, ".."));
  const resolvedHubRoot = path.resolve(hubRoot || resolveHubRootFromEnv(resolvedCpbRoot, env));
  return {
    cpbRoot: resolvedCpbRoot,
    hubRoot: resolvedHubRoot,
    key: `${resolvedHubRoot}\0${resolvedCpbRoot}`,
  };
}

export function getPoolRuntime(hubRoot, cpbRoot, opts = {}) {
  const env = opts.env || process.env;
  const roots = resolvePoolRoots(hubRoot, cpbRoot, env);
  if (!runtimes.has(roots.key)) {
    const persistentProcesses = opts.persistentProcesses ?? (
      opts.runner ? false : env.CPB_ACP_PERSISTENT_PROCESS !== "0"
    );
    runtimes.set(roots.key, new AcpPool({ ...opts, env, cpbRoot: roots.cpbRoot, hubRoot: roots.hubRoot, persistentProcesses }));
  }
  return runtimes.get(roots.key);
}

export function getManagedAcpPool({ cpbRoot, hubRoot, ...opts } = {}) {
  const roots = resolvePoolRoots(hubRoot, cpbRoot, opts.env || process.env);
  const pool = getPoolRuntime(roots.hubRoot, roots.cpbRoot, opts);
  if (!managedViews.has(roots.key)) {
    managedViews.set(roots.key, managedView(pool));
  }
  return managedViews.get(roots.key);
}

export function resetPoolRuntime(hubRootOrObj) {
  let key;
  if (typeof hubRootOrObj === "string") {
    key = hubRootOrObj;
  } else if (hubRootOrObj) {
    key = resolvePoolRoots(hubRootOrObj.hubRoot, hubRootOrObj.cpbRoot).key;
  }
  const pool = runtimes.get(key);
  if (pool) {
    pool.stop();
    runtimes.delete(key);
    managedViews.delete(key);
  }
}

export function resetAllPoolRuntimes() {
  for (const pool of runtimes.values()) pool.stop();
  runtimes.clear();
  managedViews.clear();
}

export const resetManagedAcpPoolsForTests = resetAllPoolRuntimes;
