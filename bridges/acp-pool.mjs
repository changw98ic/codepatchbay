#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

export class AcpPool {
  constructor(opts = {}) {
    this.cpbRoot = path.resolve(opts.cpbRoot || process.env.CPB_ROOT || path.join(__dirname, ".."));
    this.hubRoot = path.resolve(opts.hubRoot || resolveHubRoot(this.cpbRoot));
    this.limits = normalizeLimits(opts.limits || opts);
    this.runner = opts.runner || null;
    this.backoffMs = Number(opts.backoffMs || process.env.CPB_ACP_RATE_LIMIT_BACKOFF_MS || 60_000);
    this.active = new Map();
    this.pending = new Map();
    this.rateLimitState = new Map();
    this.requestCount = new Map();
    this.errorCount = new Map();
    this.lastSpawnAt = new Map();
    this.recycleCount = new Map();
    this.liveRequests = new Map();
    this._seq = 0;
    this.createdAt = Date.now();
  }

  async start() {
    return this.status();
  }

  async stop() {
    for (const queue of this.pending.values()) {
      while (queue.length) {
        const item = queue.shift();
        item.reject(new Error("ACP pool stopped"));
      }
    }
    this.pending.clear();
    this.liveRequests.clear();
  }

  status() {
    const agents = [...new Set([...Object.keys(this.limits), ...this.active.keys(), ...this.pending.keys()])];
    const allLive = [...this.liveRequests.entries()]
      .map(([id, v]) => ({ requestId: id, startedAt: v.startedAt, promptSnippet: v.promptSnippet || null }));
    const pools = {};
    for (const agent of agents) {
      pools[agent] = {
        limit: this.limits[agent] || 1,
        active: this.active.get(agent) || 0,
        queued: this.pending.get(agent)?.length || 0,
        activeRequests: allLive.filter((r) => r.requestId.startsWith(`${agent}-`)),
        requestCount: this.requestCount.get(agent) || 0,
        errorCount: this.errorCount.get(agent) || 0,
        recycleCount: this.recycleCount.get(agent) || 0,
        lastSpawnAt: this.lastSpawnAt.get(agent) || null,
        rateLimitedUntil: this.rateLimitState.get(agent)?.untilTs || null,
        mode: "bounded-one-shot",
        capabilities: ["rate-limit-backoff", "concurrency-bound", "durable-state", "live-requests"],
      };
    }
    return { createdAt: this.createdAt, pools };
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

  async execute(agent, prompt, cwd = this.cpbRoot, timeoutMs = DEFAULT_TIMEOUT_MS, options = {}) {
    if (options.bypass) {
      return this.#run(agent, prompt, cwd, timeoutMs);
    }
    await this.assertNotRateLimited(agent);
    const session = await this.acquire(agent);
    if (session.requestId) {
      const entry = this.liveRequests.get(session.requestId);
      if (entry) entry.promptSnippet = String(prompt).slice(0, 120);
    }
    this.lastSpawnAt.set(agent, Date.now());
    this.recycleCount.set(agent, (this.recycleCount.get(agent) || 0) + 1);
    try {
      const output = await this.#run(agent, prompt, cwd, timeoutMs);
      this.requestCount.set(agent, (this.requestCount.get(agent) || 0) + 1);
      return output;
    } catch (error) {
      this.errorCount.set(agent, (this.errorCount.get(agent) || 0) + 1);
      if (is429(error)) {
        const untilTs = await this.noteRateLimit(agent, error);
        throw new RateLimitError(agent, untilTs, error.message);
      }
      throw error;
    } finally {
      session.release();
    }
  }

  #run(agent, prompt, cwd, timeoutMs) {
    if (this.runner) return this.runner({ agent, prompt, cwd, timeoutMs });
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
}
