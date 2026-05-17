#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpClient, parseToolPolicy, resolveWriteAllowPaths } from "./acp-client.mjs";
import { resolveHubRoot } from "../server/services/hub-registry.js";
import { getRateLimit, setRateLimit, shouldUseRustRuntime } from "../server/services/runtime-cli.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT_MS = 300_000;

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

function normalizeLimits(limits = {}) {
  return {
    codex: Number(limits.codex || process.env.CPB_ACP_POOL_CODEX || 2),
    claude: Number(limits.claude || process.env.CPB_ACP_POOL_CLAUDE || 1),
  };
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

export class AcpPool {
  constructor(opts = {}) {
    this.cpbRoot = path.resolve(opts.cpbRoot || process.env.CPB_ROOT || path.join(__dirname, ".."));
    this.hubRoot = path.resolve(opts.hubRoot || resolveHubRoot(this.cpbRoot));
    this.limits = normalizeLimits(opts.limits || opts);
    this.runner = opts.runner || null;
    this.persistentProcesses = !this.runner && booleanOption(
      opts.persistentProcesses ?? process.env.CPB_ACP_PERSISTENT_PROCESS,
      false,
    );
    this.backoffMs = Number(opts.backoffMs || process.env.CPB_ACP_RATE_LIMIT_BACKOFF_MS || 60_000);
    this.maxSessionRequests = Math.max(
      0,
      numericOption(opts.maxSessionRequests ?? process.env.CPB_ACP_POOL_MAX_REQUESTS, 0),
    );
    this.maxSessionAgeMs = Math.max(
      0,
      numericOption(opts.maxSessionAgeMs ?? process.env.CPB_ACP_POOL_MAX_AGE_MS, 0),
    );
    this.sessionIdleMs = Math.max(
      0,
      numericOption(opts.sessionIdleMs ?? process.env.CPB_ACP_POOL_IDLE_MS, 0),
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
    this.toolPolicyPromise = null;
    this._seq = 0;
    this.createdAt = Date.now();
  }

  async start() {
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
      .map(([id, v]) => ({ requestId: id, startedAt: v.startedAt, promptSnippet: v.promptSnippet || null }));
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
        rateLimitedUntil: this.rateLimitState.get(agent)?.untilTs || null,
        mode: this.runner ? "managed-reusable" : providerProcessReuse ? "persistent-provider-process" : "bounded-one-shot",
        transport: this.runner
          ? "injected-runner-function"
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

  async readDurableRateLimits() {
    if (shouldUseRustRuntime()) {
      try {
        return await getRateLimit(this.hubRoot);
      } catch {
        // Fall through to JSON storage. A missing local Rust binary should not
        // make ACP pool status unusable.
      }
    }
    try {
      return JSON.parse(await readFile(this.rateLimitFile(), "utf8"));
    } catch {
      return {};
    }
  }

  async writeDurableRateLimit(agent, state) {
    if (shouldUseRustRuntime()) {
      try {
        await setRateLimit(this.hubRoot, {
          agent,
          untilTs: new Date(state.untilTs).toISOString(),
          reason: sanitizeProviderReason(state.message),
        });
        return;
      } catch {
        // Fall through to JSON storage.
      }
    }
    const filePath = this.rateLimitFile();
    const current = await this.readDurableRateLimits();
    current[agent] = {
      agent,
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
    const item = durable?.[agent];
    if (!item) return;
    const untilTs = Date.parse(item.untilTs);
    if (Number.isFinite(untilTs)) {
      this.rateLimitState.set(agent, { untilTs, message: item.reason || "durable provider backoff" });
    }
  }

  async noteRateLimit(agent, error) {
    const untilTs = parseResetTime(error?.message || String(error || ""), this.backoffMs);
    const state = { untilTs, message: error?.message || String(error || "") };
    this.rateLimitState.set(agent, state);
    await this.writeDurableRateLimit(agent, state);
    return untilTs;
  }

  async assertNotRateLimited(agent) {
    await this.refreshRateLimit(agent);
    const state = this.rateLimitState.get(agent);
    if (state && Date.now() < state.untilTs) {
      throw new RateLimitError(agent, state.untilTs);
    }
    if (state) this.rateLimitState.delete(agent);
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
    await this.assertNotRateLimited(agent);
    const session = await this.acquire(agent);
    const lifecycle = await this.#prepareSession(agent);
    if (session.requestId) {
      const entry = this.liveRequests.get(session.requestId);
      if (entry) entry.promptSnippet = String(prompt).slice(0, 120);
    }
    try {
      if (this.runner || !this.persistentProcesses) this.#noteSpawn(agent);
      const output = await this.#run(agent, prompt, cwd, timeoutMs);
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

  #run(agent, prompt, cwd, timeoutMs) {
    if (this.runner) return this.runner({ agent, prompt, cwd, timeoutMs });
    if (this.persistentProcesses) return this.#runPersistent(agent, prompt, cwd, timeoutMs);
    return this.#runOneShot(agent, prompt, cwd, timeoutMs);
  }

  #runOneShot(agent, prompt, cwd, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, "acp-client.mjs"), "--agent", agent, "--cwd", cwd], {
        cwd: this.cpbRoot,
        env: { ...process.env, CPB_ROOT: this.cpbRoot },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`${agent} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
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

  #runPersistent(agent, prompt, cwd, timeoutMs) {
    const prior = this.persistentChains.get(agent) || Promise.resolve();
    const run = prior
      .catch(() => null)
      .then(() => this.#runPersistentNow(agent, prompt, cwd, timeoutMs));
    this.persistentChains.set(agent, run.catch(() => null));
    return run;
  }

  async #runPersistentNow(agent, prompt, cwd, timeoutMs) {
    const persistent = await this.#getPersistentClient(agent, cwd);
    const client = persistent.client;
    const previousOutputSink = client.outputSink;
    const previousErrorSink = client.errorSink;
    let stdout = "";
    let stderr = "";
    let timer;

    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        void this.#closePersistentClient(agent);
        reject(new Error(`${agent} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
    });

    client.outputSink = (chunk) => { stdout += chunk?.toString ? chunk.toString() : String(chunk); };
    client.errorSink = (chunk) => { stderr += chunk?.toString ? chunk.toString() : String(chunk); };

    try {
      await Promise.race([client.promptOnce(prompt, cwd), timeout]);
      persistent.requestCount += 1;
      persistent.lastUsedAt = Date.now();
      return stdout.trim();
    } catch (error) {
      await this.#closePersistentClient(agent);
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

  async #getPersistentClient(agent, cwd) {
    const existing = this.persistentClients.get(agent);
    if (existing && !existing.client.closed) return existing;
    if (existing) this.persistentClients.delete(agent);

    const client = new AcpClient({
      agent,
      cwd,
      writeAllowPaths: resolveWriteAllowPaths(cwd),
      terminalPolicy: process.env.CPB_ACP_TERMINAL === "deny" ? "deny" : "allow",
      toolPolicy: await this.#getToolPolicy(),
      outputSink: () => {},
      errorSink: () => {},
      env: { ...process.env, CPB_ROOT: this.cpbRoot },
    });
    const meta = {
      client,
      startedAt: Date.now(),
      requestCount: 0,
      lastUsedAt: null,
    };
    this.persistentClients.set(agent, meta);
    this.#noteSpawn(agent);

    try {
      await client.start();
      return meta;
    } catch (error) {
      this.persistentClients.delete(agent);
      await client.close().catch(() => null);
      throw error;
    }
  }

  #getToolPolicy() {
    if (!this.toolPolicyPromise) this.toolPolicyPromise = parseToolPolicy();
    return this.toolPolicyPromise;
  }

  async #closePersistentClient(agent) {
    const persistent = this.persistentClients.get(agent);
    if (!persistent) return;
    this.persistentClients.delete(agent);
    await persistent.client.close().catch(() => null);
  }
}
