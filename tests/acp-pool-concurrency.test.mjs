import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AcpPool } from "../server/services/acp-pool.js";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRunner(gate, starts) {
  return async ({ agent, prompt }) => {
    starts.push({ agent, prompt });
    await gate.promise;
    return `${agent}:${prompt}`;
  };
}

function poolOpts(root, runner, extraEnv = {}) {
  return {
    cpbRoot: root,
    hubRoot: path.join(root, "hub"),
    runner,
    env: {
      CPB_ROOT: root,
      CPB_HUB_ROOT: path.join(root, "hub"),
      CPB_ACP_POOL_CLAUDE: "10",
      CPB_ACP_POOL_CODEX: "10",
      CPB_ACP_POOL_BROWSER_AGENT: "10",
      ...extraEnv,
    },
  };
}

describe("AcpPool cross-process-style concurrency leases", () => {
  it("enforces a global ACP connection limit across pool instances", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cpb-acp-total-limit-"));
    const gate = deferred();
    const starts = [];
    const runner = makeRunner(gate, starts);
    const env = { CPB_ACP_POOL_TOTAL: "2", CPB_ACP_POOL_PROVIDER_MAX: "3" };

    const pools = [
      new AcpPool(poolOpts(root, runner, env)),
      new AcpPool(poolOpts(root, runner, env)),
      new AcpPool(poolOpts(root, runner, env)),
    ];

    try {
      const p1 = pools[0].execute("claude", "one");
      const p2 = pools[1].execute("codex", "two");
      await waitForStarts(starts, 2);

      const p3 = pools[2].execute("browser-agent", "three");
      await sleep(80);
      assert.equal(starts.length, 2);

      gate.resolve();
      await Promise.all([p1, p2, p3]);
      assert.equal(starts.length, 3);
    } finally {
      await Promise.all(pools.map((pool) => pool.stop()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces a per-provider ACP connection limit of three by default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cpb-acp-provider-limit-"));
    const gate = deferred();
    const starts = [];
    const runner = makeRunner(gate, starts);
    const env = { CPB_ACP_POOL_TOTAL: "10" };
    const pools = Array.from({ length: 4 }, () => new AcpPool(poolOpts(root, runner, env)));

    try {
      const running = pools.slice(0, 3).map((pool, i) =>
        pool.execute("claude", `run-${i}`, root, 0, { variant: "mimo" }),
      );
      await waitForStarts(starts, 3);

      const fourth = pools[3].execute("claude", "run-3", root, 0, { variant: "mimo" });
      await sleep(80);
      assert.equal(starts.length, 3);

      gate.resolve();
      await Promise.all([...running, fourth]);
      assert.equal(starts.length, 4);
    } finally {
      await Promise.all(pools.map((pool) => pool.stop()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("waits for a contended connection lease lock instead of failing the task", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cpb-acp-lock-wait-"));
    const gate = deferred();
    const starts = [];
    const runner = makeRunner(gate, starts);
    const pool = new AcpPool(poolOpts(root, runner, {
      CPB_ACP_POOL_TOTAL: "1",
      CPB_ACP_POOL_CONNECTION_POLL_MS: "20",
    }));
    const lockDir = path.join(root, "hub", "providers", "acp-leases", ".lock");

    try {
      await mkdir(lockDir, { recursive: true });
      setTimeout(() => {
        rm(lockDir, { recursive: true, force: true }).catch(() => null);
      }, 1200).unref();

      const execution = pool.execute("claude", "wait-for-lock", root, 0);
      await sleep(100);
      assert.equal(starts.length, 0);

      await waitForStarts(starts, 1, 200);
      gate.resolve();
      const result = await execution;
      assert.equal(result.output, "claude:wait-for-lock");
    } finally {
      gate.resolve();
      await pool.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function waitForStarts(starts, count, attempts = 50) {
  for (let i = 0; i < attempts; i += 1) {
    if (starts.length >= count) return;
    await sleep(10);
  }
  assert.equal(starts.length, count);
}
