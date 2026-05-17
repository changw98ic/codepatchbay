import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AcpPool, RateLimitError, sanitizeProviderReason } from "../bridges/acp-pool.mjs";

async function waitFor(predicate, { timeoutMs = 1_000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail("condition was not met before timeout");
}

test("ACP pool defaults durable state to the global Hub root", async () => {
  const previousHubRoot = process.env.CPB_HUB_ROOT;
  delete process.env.CPB_HUB_ROOT;
  try {
    const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-acp-local-root-"));
    const pool = new AcpPool({ cpbRoot });

    assert.equal(pool.hubRoot, path.join(homedir(), ".cpb"));
    assert.equal(pool.rateLimitFile(), path.join(homedir(), ".cpb", "providers", "rate-limits.json"));
  } finally {
    if (previousHubRoot === undefined) delete process.env.CPB_HUB_ROOT;
    else process.env.CPB_HUB_ROOT = previousHubRoot;
  }
});

test("ACP pool bounds concurrent executions per agent", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-acp-pool-bound-"));
  let active = 0;
  let maxActive = 0;
  const pool = new AcpPool({
    hubRoot,
    limits: { codex: 1 },
    runner: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return "ok";
    },
  });

  const results = await Promise.all([
    pool.execute("codex", "a"),
    pool.execute("codex", "b"),
  ]);

  assert.deepEqual(results, ["ok", "ok"]);
  assert.equal(maxActive, 1);
  assert.equal(pool.status().pools.codex.requestCount, 2);
});

test("ACP pool records 429 backoff and rejects blind retries", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-acp-pool-429-"));
  const pool = new AcpPool({
    hubRoot,
    limits: { codex: 1 },
    backoffMs: 60_000,
    runner: async () => {
      throw new Error("429 rate limit: retry after 60 seconds");
    },
  });

  await assert.rejects(() => pool.execute("codex", "a"), RateLimitError);
  await assert.rejects(() => pool.execute("codex", "b"), RateLimitError);
  assert.ok(pool.status().pools.codex.rateLimitedUntil > Date.now());
});

test("ACP pool persists provider backoff across pool instances", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-acp-pool-"));

  const first = new AcpPool({
    hubRoot,
    limits: { codex: 1 },
    backoffMs: 60_000,
    runner: async () => {
      throw new Error("429 rate limit: retry after 60 seconds");
    },
  });
  await assert.rejects(() => first.execute("codex", "a"), RateLimitError);

  let called = false;
  const second = new AcpPool({
    hubRoot,
    limits: { codex: 1 },
    runner: async () => {
      called = true;
      return "should-not-run";
    },
  });
  await assert.rejects(() => second.execute("codex", "b"), RateLimitError);
  assert.equal(called, false);
});

test("ACP pool status exposes lifecycle metrics per agent", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-acp-lifecycle-"));
  const pool = new AcpPool({
    hubRoot,
    limits: { codex: 2, claude: 1 },
    runner: async ({ agent }) => `result-${agent}`,
  });

  await pool.execute("codex", "a");
  await pool.execute("codex", "b");
  await pool.execute("claude", "c");

  const s = pool.status();
  const codex = s.pools.codex;
  const claude = s.pools.claude;

  // occupancy and queue depth
  assert.equal(codex.limit, 2);
  assert.equal(codex.active, 0);
  assert.equal(codex.queued, 0);

  // request counts (successful only)
  assert.equal(codex.requestCount, 2);
  assert.equal(claude.requestCount, 1);

  // recycle count — one-shot mode: each spawn is a recycle
  assert.equal(codex.recycleCount, 2);
  assert.equal(claude.recycleCount, 1);

  // last spawn timestamp
  assert.ok(Number.isFinite(codex.lastSpawnAt));
  assert.ok(codex.lastSpawnAt > 0);
  assert.ok(Number.isFinite(claude.lastSpawnAt));

  // error count
  assert.equal(codex.errorCount, 0);
  assert.equal(claude.errorCount, 0);

  // capabilities
  assert.ok(Array.isArray(codex.capabilities));
  assert.ok(codex.capabilities.includes("rate-limit-backoff"));
  assert.ok(codex.capabilities.includes("concurrency-bound"));
  assert.ok(codex.capabilities.includes("durable-state"));
  assert.ok(codex.capabilities.includes("live-requests"));

  // activeRequests is empty when idle
  assert.ok(Array.isArray(codex.activeRequests));
  assert.equal(codex.activeRequests.length, 0);

  // mode
  assert.equal(codex.mode, "bounded-one-shot");

  // pool-level createdAt
  assert.ok(Number.isFinite(s.createdAt));
  assert.ok(s.createdAt <= Date.now());
});

test("ACP pool tracks error count per agent on non-429 failures", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-acp-errors-"));
  let callCount = 0;
  const pool = new AcpPool({
    hubRoot,
    limits: { codex: 1 },
    runner: async () => {
      callCount++;
      if (callCount <= 2) throw new Error("temporary failure");
      return "ok";
    },
  });

  await assert.rejects(() => pool.execute("codex", "a"), { message: /temporary failure/ });
  await assert.rejects(() => pool.execute("codex", "b"), { message: /temporary failure/ });
  await pool.execute("codex", "c");

  const s = pool.status();
  assert.equal(s.pools.codex.errorCount, 2);
  assert.equal(s.pools.codex.requestCount, 1);
  assert.equal(s.pools.codex.recycleCount, 3);
});

test("ACP pool 429 on one provider does not block another", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-acp-isolation-"));
  const pool = new AcpPool({
    hubRoot,
    limits: { codex: 1, claude: 1 },
    backoffMs: 60_000,
    runner: async ({ agent }) => {
      if (agent === "codex") throw new Error("429 rate limit: retry after 60 seconds");
      return `result-${agent}`;
    },
  });

  await assert.rejects(() => pool.execute("codex", "a"), RateLimitError);

  const result = await pool.execute("claude", "b");
  assert.equal(result, "result-claude");

  const s = pool.status();
  assert.ok(s.pools.codex.rateLimitedUntil > Date.now());
  assert.equal(s.pools.claude.rateLimitedUntil, null);
  assert.equal(s.pools.claude.requestCount, 1);
  assert.equal(s.pools.claude.errorCount, 0);
});

test("ACP pool bypass skips rate limit and pool queuing without affecting metrics", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-acp-bypass-"));
  let callIdx = 0;
  const pool = new AcpPool({
    hubRoot,
    limits: { codex: 1 },
    backoffMs: 60_000,
    runner: async ({ agent }) => {
      callIdx++;
      if (agent === "codex" && callIdx === 1) throw new Error("429 rate limit: retry after 60 seconds");
      return "ok";
    },
  });

  await assert.rejects(() => pool.execute("codex", "a"), RateLimitError);

  const result = await pool.execute("codex", "b", pool.cpbRoot, 30_000, { bypass: true });
  assert.equal(result, "ok");

  const s = pool.status();
  assert.equal(s.pools.codex.requestCount, 0);
  assert.equal(s.pools.codex.recycleCount, 1); // first 429 call counted
  assert.equal(s.pools.codex.errorCount, 1); // first 429 call counted, bypass added nothing
  assert.ok(s.pools.codex.rateLimitedUntil > Date.now());
});

test("ACP pool recycleCount tracks 429-triggered spawns correctly", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-acp-recycle-"));
  const pool = new AcpPool({
    hubRoot,
    limits: { codex: 1 },
    backoffMs: 60_000,
    runner: async () => {
      throw new Error("429 rate limit: retry after 60 seconds");
    },
  });

  await assert.rejects(() => pool.execute("codex", "a"), RateLimitError);

  const s = pool.status();
  assert.equal(s.pools.codex.recycleCount, 1);
  assert.equal(s.pools.codex.errorCount, 1);
  assert.equal(s.pools.codex.requestCount, 0);
});

test("ACP pool redacts provider secrets before durable rate-limit writes", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-acp-redact-"));
  const pool = new AcpPool({
    hubRoot,
    limits: { claude: 1 },
    backoffMs: 60_000,
    runner: async () => {
      throw new Error("429 Authorization: Bearer sk-secret ANTHROPIC_AUTH_TOKEN=topsecret retry after 60 seconds");
    },
  });

  await assert.rejects(() => pool.execute("claude", "a"), RateLimitError);

  const limits = await pool.readDurableRateLimits();
  assert.match(limits.claude.reason, /Bearer \[REDACTED\]/);
  assert.match(limits.claude.reason, /ANTHROPIC_AUTH_TOKEN=\[REDACTED\]/);
  assert.doesNotMatch(limits.claude.reason, /sk-secret|topsecret/);
  assert.equal(
    sanitizeProviderReason("api_key='abc123' token=def456"),
    "api_key='[REDACTED]' token=[REDACTED]",
  );
});

test("ACP pool tracks active requests with live request IDs and prompt snippets", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-acp-live-"));
  let resolveRun;
  const pool = new AcpPool({
    hubRoot,
    limits: { codex: 1 },
    runner: async () => new Promise((resolve) => { resolveRun = resolve; }),
  });

  const execPromise = pool.execute("codex", "test prompt content for visibility");
  await new Promise((r) => setTimeout(r, 10));

  const s = pool.status();
  assert.equal(s.pools.codex.active, 1);
  assert.equal(s.pools.codex.activeRequests.length, 1);
  const req = s.pools.codex.activeRequests[0];
  assert.ok(req.requestId.startsWith("codex-"));
  assert.ok(Number.isFinite(req.startedAt));
  assert.equal(req.promptSnippet, "test prompt content for visibility");
  assert.ok(s.pools.codex.capabilities.includes("live-requests"));

  resolveRun("ok");
  await execPromise;

  const after = pool.status();
  assert.equal(after.pools.codex.active, 0);
  assert.equal(after.pools.codex.activeRequests.length, 0);
});

test("ACP pool activeRequests reflects queued requests promoted on release", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-acp-queue-live-"));
  const resolvers = [];
  const pool = new AcpPool({
    hubRoot,
    limits: { codex: 1 },
    runner: async () => new Promise((resolve) => { resolvers.push(resolve); }),
  });

  const first = pool.execute("codex", "first");
  const second = pool.execute("codex", "second");
  try {
    await waitFor(() => resolvers.length === 1);

    assert.equal(pool.status().pools.codex.active, 1);
    assert.equal(pool.status().pools.codex.queued, 1);

    resolvers[0]("ok-1");
    await first;
    await waitFor(() => resolvers.length === 2);

    assert.equal(pool.status().pools.codex.active, 1);
    assert.equal(pool.status().pools.codex.activeRequests.length, 1);

    resolvers[1]("ok-2");
    await second;

    assert.equal(pool.status().pools.codex.active, 0);
    assert.equal(pool.status().pools.codex.activeRequests.length, 0);
  } finally {
    for (const resolve of resolvers) resolve("cleanup");
  }
});
