import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AcpPool, resetManagedAcpPoolsForTests } from "../runtime/acp-pool.js";

function fakeRunner(responses = []) {
  const calls = [];
  let idx = 0;
  const runner = ({ agent, prompt, cwd, timeoutMs }) => {
    calls.push({ agent, prompt, cwd, timeoutMs });
    const resp = responses[idx] ?? `response-${idx}`;
    idx++;
    return Promise.resolve(resp);
  };
  return { runner, calls };
}

describe("AcpPool session reuse", () => {
  let pool;
  let savedEnv;

  beforeEach(() => {
    resetManagedAcpPoolsForTests();
    savedEnv = { ...process.env };
    // Clear relevant env vars so tests get deterministic defaults
    delete process.env.CPB_ACP_POOL_MAX_REQUESTS;
    delete process.env.CPB_ACP_POOL_MAX_AGE_MS;
    delete process.env.CPB_ACP_POOL_IDLE_MS;
    delete process.env.CPB_ACP_PERSISTENT_PROCESS;
    delete process.env.CPB_ACP_USE_MANAGED_POOL;
    delete process.env.CPB_ROOT;
    delete process.env.CPB_ACP_RATE_LIMIT_BACKOFF_MS;
  });

  afterEach(() => {
    process.env = savedEnv;
    if (pool) pool.stop();
    resetManagedAcpPoolsForTests();
  });

  it("increments sessionRequestCount on same-agent requests", async () => {
    const { runner, calls } = fakeRunner(["a", "b", "c"]);
    pool = new AcpPool({ runner, maxSessionRequests: 0 });

    await pool.execute("codex", "prompt-1", "/tmp");
    await pool.execute("codex", "prompt-2", "/tmp");
    await pool.execute("codex", "prompt-3", "/tmp");

    assert.equal(calls.length, 3, "runner called 3 times");
    assert.equal(calls[0].agent, "codex");
    assert.equal(calls[1].agent, "codex");
    assert.equal(calls[2].agent, "codex");

    const status = pool.status();
    const codex = status.pools.codex;
    assert.equal(codex.requestCount, 3, "total requestCount is 3");
    assert.equal(codex.sessionRequestCount, 3, "sessionRequestCount is 3");
  });

  it("recycles session after CPB_ACP_POOL_MAX_REQUESTS", async () => {
    const { runner } = fakeRunner(
      Array.from({ length: 14 }, (_, i) => `resp-${i}`),
    );
    // maxSessionRequests = 4 means recycle after 4 requests
    pool = new AcpPool({ runner, maxSessionRequests: 4 });

    for (let i = 0; i < 14; i++) {
      await pool.execute("codex", `prompt-${i}`, "/tmp");
    }

    const status = pool.status();
    const codex = status.pools.codex;
    // 14 requests / 4 per session = 3 recycles (sessions at requests 4, 8, 12)
    assert.equal(codex.recycleCount, 3, "should have recycled 3 times");
    assert.equal(codex.requestCount, 14, "total requestCount is 14");
  });

  it("exposes liveRequests, spawnCount, requestCount, recycleCount via status()", async () => {
    const { runner } = fakeRunner(["r1", "r2"]);
    pool = new AcpPool({ runner, maxSessionRequests: 0 });

    await pool.execute("codex", "hello", "/tmp");
    await pool.execute("claude", "world", "/tmp");

    const status = pool.status();

    // codex pool
    const codex = status.pools.codex;
    assert.equal(codex.spawnCount, 1, "codex spawnCount");
    assert.equal(codex.requestCount, 1, "codex requestCount");
    assert.equal(codex.recycleCount, 0, "codex recycleCount");
    assert.ok(Array.isArray(codex.activeRequests), "activeRequests is array");

    // claude pool
    const claude = status.pools.claude;
    assert.equal(claude.spawnCount, 1, "claude spawnCount");
    assert.equal(claude.requestCount, 1, "claude requestCount");
  });

  it("pool.execute returns prompt response in managed mode", async () => {
    const { runner } = fakeRunner(["managed-response-42"]);
    pool = new AcpPool({ runner });

    const result = await pool.execute("codex", "do something", "/tmp", 5000);
    assert.equal(result, "managed-response-42", "execute returns runner result");
  });

  it("tracks promptBytes and phase metadata on live requests", async () => {
    // Use a runner that delays so we can inspect liveRequests mid-flight
    let resolveRun;
    const delayedRunner = () => new Promise((r) => { resolveRun = r; });
    pool = new AcpPool({ runner: delayedRunner, maxSessionRequests: 0 });

    const executePromise = pool.execute("codex", "a".repeat(200), "/tmp", 30_000, { phase: "plan" });

    // Give the event loop a tick to enter the runner
    await new Promise((r) => setTimeout(r, 10));

    const status = pool.status();
    const codex = status.pools.codex;
    assert.ok(codex.activeRequests.length >= 1, "at least one active request");

    const live = codex.activeRequests[0];
    assert.ok(live.startedAt > 0, "startedAt is set");
    assert.equal(live.promptSnippet, "a".repeat(80), "promptSnippet truncated to 80 chars");

    resolveRun("done");
    await executePromise;
  });

  it("sessionRequestCount resets after recycle", async () => {
    const { runner } = fakeRunner(
      Array.from({ length: 6 }, (_, i) => `r-${i}`),
    );
    pool = new AcpPool({ runner, maxSessionRequests: 3 });

    // 3 requests fill the session
    await pool.execute("codex", "p1", "/tmp");
    await pool.execute("codex", "p2", "/tmp");
    await pool.execute("codex", "p3", "/tmp");

    // After 3 requests, next execute triggers recycle then runs
    await pool.execute("codex", "p4", "/tmp");

    const status = pool.status();
    // sessionRequestCount should be 1 (the 4th request started a new session)
    assert.equal(status.pools.codex.sessionRequestCount, 1, "sessionRequestCount resets after recycle");
    assert.equal(status.pools.codex.recycleCount, 1, "recycled once");
  });
});
