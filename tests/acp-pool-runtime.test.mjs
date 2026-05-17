import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import {
  getManagedAcpPool,
  resetManagedAcpPoolsForTests,
} from "../server/services/acp-pool-runtime.js";

afterEach(() => {
  resetManagedAcpPoolsForTests();
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met");
}

test("managed ACP pool is a singleton per Hub process root", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-managed-pool-cpb-"));
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-managed-pool-hub-"));

  const first = getManagedAcpPool({ cpbRoot, hubRoot, limits: { codex: 1 } });
  const second = getManagedAcpPool({ cpbRoot, hubRoot, limits: { codex: 2 } });

  assert.equal(first, second);
  assert.equal(first.status().poolSingleton, true);
  assert.equal(first.status().providerProcessReuse, true);
  assert.equal(first.status().pools.codex.mode, "pool-admission-singleton");
  assert.equal(first.status().pools.codex.poolSingleton, true);
  assert.equal(first.status().pools.codex.providerProcessReuse, true);
  assert.equal(first.status().pools.codex.transport, "persistent-acp-agent-process");
  assert.ok(first.status().pools.codex.capabilities.includes("pool-singleton"));
  assert.ok(first.status().pools.codex.capabilities.includes("provider-process-reuse"));
});

test("managed ACP pool exposes live active and queued counts", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-managed-live-cpb-"));
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-managed-live-hub-"));
  const releases = [];
  const started = [];
  const pool = getManagedAcpPool({
    cpbRoot,
    hubRoot,
    limits: { codex: 1 },
    runner: async () => {
      started.push(Date.now());
      await new Promise((resolve) => {
        releases.push(resolve);
      });
      return "ok";
    },
  });

  const first = pool.execute("codex", "first");
  const second = pool.execute("codex", "second");
  await waitFor(() => (
    pool.status().pools.codex.active === 1
    && pool.status().pools.codex.queued === 1
    && releases.length === 1
  ));

  let status = pool.status().pools.codex;
  assert.equal(status.active, 1);
  assert.equal(status.queued, 1);

  releases.shift()();
  assert.equal(await first, "ok");
  await waitFor(() => releases.length === 1);

  status = pool.status().pools.codex;
  assert.equal(status.active, 1);
  assert.equal(status.queued, 0);

  releases.shift()();
  assert.equal(await second, "ok");
  assert.equal(pool.status().pools.codex.active, 0);
  assert.equal(pool.status().pools.codex.requestCount, 2);
});
