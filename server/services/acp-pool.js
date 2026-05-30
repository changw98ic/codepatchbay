import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpClient, parseToolPolicy, resolveWriteAllowPaths } from "../../runtime/acp-client-core.mjs";
import { applyVariantToEnv, resolveVariantConfig } from "../../runtime/apply-variant.js";
import { saveSessionId, loadSessionId, clearSessionId } from "../../core/agents/session-cache.js";
import { buildAcpPoolEnv, buildChildEnv } from "../../core/policy/child-env.js";
import { buildAgentSandboxLaunch } from "../../core/policy/agent-sandbox.js";

let _registryCache = null;

/**
 * P1-5 fix: Compound key for persistent client isolation.
 * Prevents cross-project/cross-role client reuse.
 */
export function poolClientKey(agent, options = {}) {
  const role = options.role || options.phase || "";
  const projectId = options.projectId || "";
  const workspaceId = options.workspaceId || "";
  const cwd = options.cwd || "";
  const policyHash = options.policyHash || "";
  return [agent, role, projectId, workspaceId, cwd, policyHash].join("::");
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
const DEFAULT_TIMEOUT_MS = Number(process.env.CPB_ACP_POOL_TIMEOUT_MS || 1_800_000);
const CHILD_TERM_GRACE_MS = 500;
const CHILD_KILL_GRACE_MS = 1_500;
const POOL_LIMIT_CONTROL_ENV = new Set([
  "CPB_ACP_POOL_MAX_REQUESTS",
  "CPB_ACP_POOL_MAX_AGE_MS",
  "CPB_ACP_POOL_IDLE_MS",
]);

function resolveHubRootFromEnv(cpbRoot, env = {}) {
  if (env.CPB_HUB_ROOT) return path.resolve(env.CPB_HUB_ROOT);
  const home = os.homedir();
  return home ? path.join(home, ".cpb") : path.join(path.resolve(cpbRoot), ".cpb", "hub");
}

export class RateLimitError extends Error {
  constructor(agent, untilTs, message = "ACP provider is rate limited") {
    super(`${message}: ${agent} until ${new Date(untilTs).toISOString()}`);
    this.name = "RateLimitError";
    this.agent = agent;
    this.untilTs = untilTs;
  }
}

function is429(error) {
  const message = error?.message || String(error || "");
  return /\b429\b|rate.?limit|too many requests/i.test(message);
}

function providerKeyForAgent(agent, env = {}) {
  if (agent !== "claude") return agent;
  const config = resolveVariantConfig(env);
  return config.variant && config.variant !== "none" ? `claude:${config.variant}` : "claude";
}

function variantNameFromProviderKey(providerKey, agent) {
  const prefix = `${agent}:`;
  return providerKey.startsWith(prefix) ? providerKey.slice(prefix.length) : null;
}

function envForAgent(agent, env = {}, variant = null) {
  const next = { ...env };
  if (agent === "claude") {
    if (variant) next.CPB_CLAUDE_VARIANT = variant;
    applyVariantToEnv(next);
  }
  return next;
}

function parseResetTime(message, fallbackMs) {
  const text = String(message || "");
  const iso = text.match(/20\d\d-\d\d-\d\d[T\s]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?/);
  if (iso) {
    const normalized = iso[0].includes("T") ? iso[0] : iso[0].replace(" ", "T");
    const parsed = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
    if (Number.isFinite(parsed)) return parsed;
  }
  const seconds = text.match(/(?:reset|retry|after)[^0-9]*(\d+)\s*(?:s|sec|seconds?)/i);
  if (seconds) return Date.now() + Number(seconds[1]) * 1000;
  return Date.now() + fallbackMs;
}

export function sanitizeProviderReason(message) {
  return String(message || "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(
      /\b([A-Za-z0-9_]*(?:api[_-]?key|auth[_-]?token|token|secret)[A-Za-z0-9_]*)(\s*[:=]\s*)(['"]?)[^\s,'"]+/gi,
      "$1$2$3[REDACTED]",
    )
    .slice(0, 500);
}

function poolLimitForAgentEnv(registry, agent, env = {}) {
  const desc = registry?.getDescriptor(agent);
  return Number(env[`CPB_ACP_POOL_${agent.toUpperCase()}`]) || desc?.poolLimit || 2;
}

async function normalizeLimitsAsync(limits = {}, env = process.env) {
  const registry = await getRegistry();

  // Start with explicit limits from opts
  const result = { ...limits };

  // Fill defaults from registry descriptors
  if (registry) {
    for (const agent of registry.listAgentNames()) {
      if (!(agent in result)) {
        result[agent] = poolLimitForAgentEnv(registry, agent, env);
      }
    }
  }

  // Legacy fallback: always ensure codex and claude
  if (!result.codex) result.codex = Number(env.CPB_ACP_POOL_CODEX || 2);
  if (!result.claude) result.claude = Number(env.CPB_ACP_POOL_CLAUDE || 1);

  // Env overrides for any agent (CPB_ACP_POOL_<NAME>)
  for (const [key, value] of Object.entries(env)) {
    if (POOL_LIMIT_CONTROL_ENV.has(key)) continue;
    const match = key.match(/^CPB_ACP_POOL_(\w+)$/);
    if (match) {
      const agentName = match[1].toLowerCase();
      result[agentName] = Number(value) || 2;
    }
  }

  return result;
}

// Sync fallback for constructor (registry not loaded yet)
function normalizeLimits(limits = {}, env = process.env) {
  const result = {
    codex: Number(limits.codex || env.CPB_ACP_POOL_CODEX || 2),
    claude: Number(limits.claude || env.CPB_ACP_POOL_CLAUDE || 1),
  };
  for (const [key, value] of Object.entries(env)) {
    if (POOL_LIMIT_CONTROL_ENV.has(key)) continue;
    const match = key.match(/^CPB_ACP_POOL_(\w+)$/);
    if (match) {
      const agentName = match[1].toLowerCase();
      if (!(agentName in result)) {
        result[agentName] = Number(value) || 2;
      }
    }
  }
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
    this.backoffMs = Number(opts.backoffMs || this.env.CPB_ACP_RATE_LIMIT_BACKOFF_MS || 60_000);
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
    this.active = new Map();
    this.pending = new Map();
    this.rateLimitState = new Map();
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
    this.createdAt = Date.now();
  }

  async init() {
    const registry = await getRegistry();
    if (registry) {
      this.limits = await normalizeLimitsAsync(this.limits, this.env);
    }
    return this;
  }

  async start() {
    await this.init();
    return this.status();
  }

  async stop() {
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
        limit: this.limits[agent] || 1,
        active: this.active.get(agent) || 0,
        queued: this.pending.get(agent)?.length || 0,
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
        rateLimitedUntil: this.rateLimitState.get(this.providerKey(agent))?.untilTs || null,
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
      pools,
    };
  }

  #usesProviderProcessReuse() {
    return Boolean(this.persistentProcesses && !this.runner);
  }

  _nextId(agent) {
    return `${agent}-${Date.now()}-${++this._seq}`;
  }

  acquire(agent) {
    const limit = Math.max(1, this.limits[agent] || 1);
    const active = this.active.get(agent) || 0;
    if (active < limit) {
      const requestId = this._nextId(agent);
      this.active.set(agent, active + 1);
      this.liveRequests.set(requestId, { agent, startedAt: Date.now() });
      return Promise.resolve({ agent, requestId, release: () => this.release(agent, requestId) });
    }
    return new Promise((resolve, reject) => {
      const queue = this.pending.get(agent) || [];
      queue.push({ resolve, reject });
      this.pending.set(agent, queue);
    });
  }

  release(agent, requestId) {
    const active = Math.max(0, (this.active.get(agent) || 1) - 1);
    this.active.set(agent, active);
    if (requestId) this.liveRequests.delete(requestId);
    const queue = this.pending.get(agent) || [];
    const next = queue.shift();
    if (!next) return;
    const nextId = this._nextId(agent);
    this.active.set(agent, (this.active.get(agent) || 0) + 1);
    this.liveRequests.set(nextId, { agent, startedAt: Date.now() });
    next.resolve({ agent, requestId: nextId, release: () => this.release(agent, nextId) });
  }

  rateLimitFile() {
    return path.join(this.hubRoot, "providers", "rate-limits.json");
  }

  providerKey(agent) {
    return providerKeyForAgent(agent, this.env);
  }

  async readDurableRateLimits() {
    try {
      return JSON.parse(await readFile(this.rateLimitFile(), "utf8"));
    } catch {
      return {};
    }
  }

  async writeDurableRateLimit(agent, state) {
    const filePath = this.rateLimitFile();
    const current = await this.readDurableRateLimits();
    const providerKey = this.providerKey(agent);
    current[providerKey] = {
      agent,
      providerKey,
      variant: variantNameFromProviderKey(providerKey, agent),
      untilTs: new Date(state.untilTs).toISOString(),
      reason: sanitizeProviderReason(state.message),
      updatedAt: new Date().toISOString(),
    };
    await mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    await rename(tmp, filePath);
  }

  async refreshRateLimit(agent) {
    const durable = await this.readDurableRateLimits();
    const providerKey = this.providerKey(agent);
    const item = durable?.[providerKey];
    if (!item) return;
    const untilTs = Date.parse(item.untilTs);
    if (Number.isFinite(untilTs)) {
      this.rateLimitState.set(providerKey, { untilTs, message: item.reason || "durable provider backoff" });
    }
  }

  async noteRateLimit(agent, error) {
    const untilTs = parseResetTime(error?.message || String(error || ""), this.backoffMs);
    const state = { untilTs, message: error?.message || String(error || "") };
    const providerKey = this.providerKey(agent);
    this.rateLimitState.set(providerKey, state);
    await this.writeDurableRateLimit(agent, state);
    return untilTs;
  }

  async assertNotRateLimited(agent) {
    const providerKey = this.providerKey(agent);
    await this.refreshRateLimit(agent);
    const state = this.rateLimitState.get(providerKey);
    if (state && Date.now() < state.untilTs) {
      throw new RateLimitError(providerKey, state.untilTs);
    }
    if (state) this.rateLimitState.delete(providerKey);
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
      return this.#run(agent, prompt, cwd, timeoutMs);
    }
    if (!this.runner) await this.assertNotRateLimited(agent);
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
      this.requestCount.set(agent, (this.requestCount.get(agent) || 0) + 1);
      lifecycle.requestCount += 1;
      lifecycle.lastUsedAt = Date.now();
      lifecycle.recycleReason = null;
      return output;
    } catch (error) {
      this.errorCount.set(agent, (this.errorCount.get(agent) || 0) + 1);
      if (is429(error)) {
        await this.#recycleSession(agent, "rate_limit");
        const untilTs = await this.noteRateLimit(agent, error);
        throw new RateLimitError(agent, untilTs, error.message);
      }
      await this.#recycleSession(agent, "error");
      throw error;
    } finally {
      session.release();
    }
  }

  #run(agent, prompt, cwd, timeoutMs, options = {}) {
    if (this.runner) return this.runner({ agent, prompt, cwd, timeoutMs });
    if (this.env.CPB_ACP_CLIENT) return this.#runOneShot(agent, prompt, cwd, timeoutMs, options);
    if (this.persistentProcesses) return this.#runPersistent(agent, prompt, cwd, timeoutMs, options);
    return this.#runOneShot(agent, prompt, cwd, timeoutMs, options);
  }

  #runOneShot(agent, prompt, cwd, timeoutMs, options = {}) {
    const customClient = this.env.CPB_ACP_CLIENT;
    const clientPath = customClient || path.join(__dirname, "..", "bridges", "acp-client.mjs");
    const command = customClient ? clientPath : process.execPath;
    const args = customClient ? ["--agent", agent, "--cwd", cwd] : [clientPath, "--agent", agent, "--cwd", cwd];
    return new Promise((resolve, reject) => {
      const env = buildChildEnv(
        envForAgent(agent, this.env, options.variant),
        { CPB_ROOT: this.cpbRoot, CPB_ACP_CPB_ROOT: this.cpbRoot },
        { agent },
      );
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
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        terminateChild(child).finally(() => {
          reject(new Error(`${agent} timed out after ${timeoutMs}ms`));
        });
      }, timeoutMs);
      timer.unref();
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`${agent} exited ${code}: ${stderr.slice(-1000)}`));
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  #runPersistent(agent, prompt, cwd, timeoutMs, options = {}) {
    const key = poolClientKey(agent, options);
    const prior = this.persistentChains.get(key) || Promise.resolve();
    const run = prior
      .catch(() => null)
      .then(() => this.#runPersistentNow(key, agent, prompt, cwd, timeoutMs));
    this.persistentChains.set(key, run.catch(() => null));
    return run;
  }

  async #runPersistentNow(key, agent, prompt, cwd, timeoutMs) {
    const persistent = await this.#getPersistentClient(key, agent, cwd);
    const client = persistent.client;
    const previousOutputSink = client.outputSink;
    const previousErrorSink = client.errorSink;
    let stdout = "";
    let stderr = "";
    let timer;

    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        void this.#closePersistentClient(key);
        reject(new Error(`${agent} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
    });

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

  async #getPersistentClient(key, agent, cwd) {
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

    const client = new AcpClient({
      agent,
      cwd,
      writeAllowPaths: resolveWriteAllowPaths(cwd, this.env),
      terminalPolicy: this.env.CPB_ACP_TERMINAL === "deny" ? "deny" : "allow",
      toolPolicy: await this.#getToolPolicy(),
      outputSink: () => {},
      errorSink: () => {},
      env: buildChildEnv(
        envForAgent(agent, this.env),
        { CPB_ROOT: this.cpbRoot, CPB_ACP_CPB_ROOT: this.cpbRoot },
        { agent },
      ),
      resumeSessionId,
    });
    const meta = {
      client,
      agent,
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
