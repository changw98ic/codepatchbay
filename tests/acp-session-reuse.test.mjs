import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AcpPool, resetManagedAcpPoolsForTests } from "../server/services/acp-pool.js";

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
  let tempDirs = [];

  beforeEach(() => {
    resetManagedAcpPoolsForTests();
    savedEnv = { ...process.env };
    // Clear relevant env vars so tests get deterministic defaults
    delete process.env.CPB_ACP_POOL_MAX_REQUESTS;
    delete process.env.CPB_ACP_POOL_MAX_AGE_MS;
    delete process.env.CPB_ACP_POOL_IDLE_MS;
    delete process.env.CPB_ACP_PERSISTENT_PROCESS;
    delete process.env.CPB_ACP_USE_MANAGED_POOL;
    delete process.env.CPB_ACP_CLIENT;
    delete process.env.CPB_ROOT;
    delete process.env.CPB_ACP_RATE_LIMIT_BACKOFF_MS;
  });

  afterEach(() => {
    process.env = savedEnv;
    if (pool) pool.stop();
    resetManagedAcpPoolsForTests();
    for (const dir of tempDirs) rm(dir, { recursive: true, force: true }).catch(() => {});
    tempDirs = [];
  });

  async function tempDir(prefix) {
    const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function isPidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === "EPERM";
    }
  }

  async function waitForPid(file, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const pid = Number(await readFile(file, "utf8"));
        if (pid) return pid;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`pid file not written: ${file}`);
  }

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

  it("does not treat ACP pool control env as agent names", async () => {
    process.env.CPB_ACP_POOL_MAX_REQUESTS = "3";
    process.env.CPB_ACP_POOL_IDLE_MS = "5000";
    const { runner } = fakeRunner(["ok"]);
    pool = new AcpPool({ runner });

    await pool.execute("codex", "prompt", "/tmp");

    const status = pool.status();
    assert.equal(status.pools.max_requests, undefined);
    assert.equal(status.pools.idle_ms, undefined);
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

  it("hard-stops a timed-out one-shot ACP client that ignores SIGTERM", async () => {
    const root = await tempDir("cpb-acp-timeout-");
    const pidFile = path.join(root, "client.pid");
    const clientPath = path.join(root, "ignore-sigterm-client.sh");
    await writeFile(clientPath, `#!/bin/sh
echo $$ > "$CPB_ROOT/client.pid"
trap "" TERM
while true; do sleep 1; done
`);
    await chmod(clientPath, 0o755);

    process.env.CPB_ACP_CLIENT = clientPath;
    pool = new AcpPool({ cpbRoot: root, hubRoot: root, persistentProcesses: false });

    const executePromise = pool.execute("codex", "prompt", root, 10_000);
    const rejection = assert.rejects(executePromise, /timed out/);
    const pid = await waitForPid(pidFile, 8_000);
    await rejection;

    await new Promise((resolve) => setTimeout(resolve, 900));
    try {
      assert.equal(isPidAlive(pid), false, `timed-out ACP client pid ${pid} should be gone`);
    } finally {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  });

  it("managed ACP pools are keyed by resolved cpbRoot and hubRoot", async () => {
    const rootA = await mkdtemp(path.join(os.tmpdir(), "cpb-pool-a-"));
    const rootB = await mkdtemp(path.join(os.tmpdir(), "cpb-pool-b-"));

    resetManagedAcpPoolsForTests();
    const { getManagedAcpPool } = await import("../server/services/acp-pool.js");

    const poolA = getManagedAcpPool({ cpbRoot: rootA, persistentProcesses: false });
    const poolB = getManagedAcpPool({ cpbRoot: rootB, persistentProcesses: false });

    assert.notEqual(poolA, poolB);
    assert.equal(poolA.cpbRoot, path.resolve(rootA));
    assert.equal(poolB.cpbRoot, path.resolve(rootB));
    resetManagedAcpPoolsForTests();

    await rm(rootA, { recursive: true, force: true }).catch(() => {});
    await rm(rootB, { recursive: true, force: true }).catch(() => {});
  });

  it("applies Claude provider variant env before launching ACP children", async () => {
    const root = await tempDir("cpb-acp-variant-env-");
    const clientPath = path.join(root, "variant-client.sh");
    await writeFile(clientPath, `#!/bin/sh
env | sort > "$CPB_ROOT/variant-env.txt"
cat >/dev/null
printf ok
`);
    await chmod(clientPath, 0o755);

    pool = new AcpPool({
      cpbRoot: root,
      hubRoot: root,
      persistentProcesses: false,
      env: {
        PATH: process.env.PATH,
        CPB_ACP_CLIENT: clientPath,
        CPB_CLAUDE_VARIANT: "kimi-k2.6",
        OLLAMA_CLOUD_URL: "https://ollama.example/v1",
        OLLAMA_CLOUD_KEY: "kimi-secret",
      },
    });

    assert.equal(await pool.execute("claude", "prompt", root, 5000), "ok");

    const envText = await readFile(path.join(root, "variant-env.txt"), "utf8");
    assert.match(envText, /^CPB_ACTIVE_CLAUDE_VARIANT=kimi-k2\.6$/m);
    assert.match(envText, /^ANTHROPIC_BASE_URL=https:\/\/ollama\.example\/v1$/m);
    assert.match(envText, /^ANTHROPIC_AUTH_TOKEN=kimi-secret$/m);
    assert.match(envText, /^ANTHROPIC_MODEL=kimi-k2\.6$/m);
  });

  it("scopes Claude durable rate limits by provider variant", async () => {
    const root = await tempDir("cpb-acp-variant-ratelimit-");
    const clientPath = path.join(root, "variant-client.sh");
    await writeFile(clientPath, `#!/bin/sh
cat >/dev/null
printf ok
`);
    await chmod(clientPath, 0o755);

    const rateLimitDir = path.join(root, "providers");
    await mkdir(rateLimitDir, { recursive: true });
    const future = new Date(Date.now() + 60_000).toISOString();
    await writeFile(path.join(rateLimitDir, "rate-limits.json"), `${JSON.stringify({
      claude: { agent: "claude", untilTs: future, reason: "official Anthropic backoff" },
    }, null, 2)}\n`);

    pool = new AcpPool({
      cpbRoot: root,
      hubRoot: root,
      persistentProcesses: false,
      env: {
        PATH: process.env.PATH,
        CPB_ACP_CLIENT: clientPath,
        CPB_CLAUDE_VARIANT: "kimi-k2.6",
        OLLAMA_CLOUD_URL: "https://ollama.example/v1",
        OLLAMA_CLOUD_KEY: "kimi-secret",
      },
    });

    assert.equal(await pool.execute("claude", "prompt", root, 5000), "ok");

    await pool.noteRateLimit("claude", new Error("429 retry after 1 seconds"));
    const limits = JSON.parse(await readFile(path.join(rateLimitDir, "rate-limits.json"), "utf8"));
    assert.ok(limits.claude, "existing default Claude backoff remains present");
    assert.ok(limits["claude:kimi-k2.6"], "variant backoff is written under provider-specific key");
    assert.equal(limits["claude:kimi-k2.6"].agent, "claude");
    assert.equal(limits["claude:kimi-k2.6"].providerKey, "claude:kimi-k2.6");
  });
});
