import assert from "node:assert/strict";
import { mkdir, readFile, rename, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { LeaderLock, readLeaderStatus } from "../server/orchestrator/leader-lock.js";
import { tempRoot } from "./helpers.js";

async function readLeader(lock: LeaderLock) {
  return JSON.parse(await readFile(lock.leaderFile, "utf8"));
}

async function installReplacementLeader(lock: LeaderLock, suffix: string) {
  const quarantine = path.join(path.dirname(lock.lockDir), `test-old-${suffix}`);
  await rename(lock.lockDir, quarantine);
  await mkdir(lock.lockDir);
  const replacement = {
    hubId: `replacement-${suffix}`,
    host: "replacement-host",
    pid: 999_999,
    epoch: lock.getEpoch() + 1,
    lockToken: `replacement-token-${suffix}`,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  await writeFile(lock.leaderFile, `${JSON.stringify(replacement)}\n`, "utf8");
  return replacement;
}

test("LeaderLock renew cannot overwrite a replacement leader after identity validation", async () => {
  const hubRoot = await tempRoot("cpb-leader-renew-race");
  const lock = new LeaderLock(hubRoot);
  await lock.acquire();

  const originalRead = lock._readLeader.bind(lock);
  let reads = 0;
  let replacement;
  lock._readLeader = async () => {
    reads += 1;
    if (reads === 2) {
      replacement = await installReplacementLeader(lock, "renew");
    }
    return originalRead();
  };

  assert.equal(await lock.renew(), false);
  assert.deepEqual(await readLeader(lock), replacement);
});

test("LeaderLock release cannot delete or expire a replacement leader", async () => {
  const hubRoot = await tempRoot("cpb-leader-release-race");
  const lock = new LeaderLock(hubRoot);
  await lock.acquire();

  const originalRead = lock._readLeader.bind(lock);
  let reads = 0;
  let replacement;
  lock._readLeader = async () => {
    reads += 1;
    if (reads === 2) {
      replacement = await installReplacementLeader(lock, "release");
    }
    return originalRead();
  };

  await lock.release();
  assert.deepEqual(await readLeader(lock), replacement);
});

test("LeaderLock recovers an abandoned incomplete lock after its TTL", async () => {
  const hubRoot = await tempRoot("cpb-leader-incomplete-stale");
  const lock = new LeaderLock(hubRoot);
  await mkdir(lock.lockDir, { recursive: true });
  const stale = new Date(Date.now() - 120_000);
  await utimes(lock.lockDir, stale, stale);

  const leader = await lock.acquire();
  assert.equal(leader.hubId, lock.getHubId());
  assert.equal((await readLeader(lock)).epoch, lock.getEpoch());
});

test("LeaderLock refuses to steal a fresh incomplete lock", async () => {
  const hubRoot = await tempRoot("cpb-leader-incomplete-fresh");
  const lock = new LeaderLock(hubRoot);
  await mkdir(lock.lockDir, { recursive: true });

  await assert.rejects(lock.acquire(), /initializing|contention/);
  assert.equal((await stat(lock.lockDir)).isDirectory(), true);
});

test("LeaderLock release expires its lease without deleting the lock path", async () => {
  const hubRoot = await tempRoot("cpb-leader-release");
  const first = new LeaderLock(hubRoot);
  await first.acquire();
  await first.release();

  assert.equal((await stat(first.lockDir)).isDirectory(), true);
  assert.equal(await first.stillHeld(), false);
  assert.equal((await readLeaderStatus(hubRoot)).status, "stopped");

  const second = new LeaderLock(hubRoot);
  await second.acquire();
  assert.ok(second.getEpoch() > first.getEpoch());
});

test("LeaderLock acquisition failure expires provisional ownership for immediate recovery", async () => {
  const hubRoot = await tempRoot("cpb-leader-initialization-failure");
  const failing = new LeaderLock(hubRoot);
  failing._incrementEpoch = async () => {
    throw new Error("injected epoch failure");
  };

  await assert.rejects(failing.acquire(), /injected epoch failure/);
  const failedLeader = await readLeader(failing);
  assert.equal(failedLeader.initializing, false);
  assert.ok(failedLeader.initializationFailedAt);
  assert.ok(Date.parse(failedLeader.expiresAt) < Date.now());
  assert.equal((await readLeaderStatus(hubRoot)).status, "stopped");

  const recovered = new LeaderLock(hubRoot);
  await recovered.acquire();
  assert.equal(await recovered.stillHeld(), true);
});

test("only one concurrent LeaderLock acquisition succeeds", async () => {
  const hubRoot = await tempRoot("cpb-leader-concurrent-acquire");
  const first = new LeaderLock(hubRoot);
  const second = new LeaderLock(hubRoot);
  const settled = await Promise.allSettled([first.acquire(), second.acquire()]);

  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(settled.filter((result) => result.status === "rejected").length, 1);
});
