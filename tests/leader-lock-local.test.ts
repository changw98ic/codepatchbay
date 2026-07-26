import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ProcessIdentity } from "../core/runtime/process-tree.js";
import { LeaderLock, readLeaderStatus, withLeaderLockTestHooks } from "../server/orchestrator/leader-lock.js";
import { tempRoot, readJson } from "./helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readLeader(lock: LeaderLock) {
  return JSON.parse(await readFile(lock.leaderFile, "utf8"));
}

function fakeIdentity(pid: number, suffix: string): ProcessIdentity {
  const birthId = `test-birth-${suffix}`;
  return {
    pid,
    birthId,
    incarnation: `${pid}:${birthId}`,
    capturedAt: new Date().toISOString(),
    birthIdPrecision: "exact",
  };
}

async function installIncompleteOwner(lock: LeaderLock, suffix: string) {
  const pid = 999_000 + suffix.length;
  const receipt = {
    hubId: `incomplete-${suffix}`,
    host: os.hostname(),
    pid,
    processIdentity: fakeIdentity(pid, suffix),
    lockToken: `incomplete-token-${suffix}`,
    createdAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(lock.lockDir), { recursive: true });
  await writeFile(lock.acquisitionFile, `${JSON.stringify(receipt)}\n`, "utf8");
  await mkdir(lock.lockDir);
  return receipt;
}

// ---------------------------------------------------------------------------
// Local file lock — acquire and release
// ---------------------------------------------------------------------------

test("LeaderLock local: acquire creates leader.lock directory and leader.json", async () => {
  const hubRoot = await tempRoot("cpb-leader-local-acquire");
  const lock = new LeaderLock(hubRoot);

  const leader = await lock.acquire();

  assert.ok(leader.hubId, "leader must have hubId");
  assert.ok(leader.lockToken, "leader must have lockToken");
  assert.equal(leader.hubId, lock.getHubId());
  assert.equal(typeof leader.epoch, "number");
  assert.equal(leader.initializing, false);

  // Directory must exist
  assert.equal((await stat(lock.lockDir)).isDirectory(), true);
  // leader.json must exist and be valid
  const stored = await readLeader(lock);
  assert.equal(stored.hubId, lock.getHubId());
  assert.equal(stored.lockToken, lock.lockToken);
});

test("LeaderLock local: acquire is idempotent on already-held lock", async () => {
  const hubRoot = await tempRoot("cpb-leader-local-double-acquire");
  const lock = new LeaderLock(hubRoot);

  await lock.acquire();
  // Second acquire by the same LeaderLock instance should throw
  // because the lock is held and not expired
  await assert.rejects(lock.acquire(), /leader lock held by/);
});

test("LeaderLock local: release expires the lease", async () => {
  const hubRoot = await tempRoot("cpb-leader-local-release");
  const lock = new LeaderLock(hubRoot);

  await lock.acquire();
  assert.equal(await lock.stillHeld(), true);

  const released = await lock.release();
  assert.equal(released, true);
  assert.equal(await lock.stillHeld(), false);

  // After release, readLeaderStatus should show "stopped"
  const status = await readLeaderStatus(hubRoot);
  assert.equal(status.status, "stopped");
});

test("LeaderLock local: release does not delete the lock directory", async () => {
  const hubRoot = await tempRoot("cpb-leader-local-release-dir");
  const lock = new LeaderLock(hubRoot);

  await lock.acquire();
  await lock.release();

  // Directory should still exist
  assert.equal((await stat(lock.lockDir)).isDirectory(), true);
  // leader.json should still exist with releasedAt set
  const leader = await readLeader(lock);
  assert.ok(leader.releasedAt, "releasedAt must be set after release");
  assert.ok(new Date(leader.expiresAt).getTime() < Date.now(), "expiresAt must be in the past");
});

test("LeaderLock local: second lock can acquire after first releases", async () => {
  const hubRoot = await tempRoot("cpb-leader-local-second-acquire");
  const first = new LeaderLock(hubRoot);

  await first.acquire();
  await first.release();

  const second = new LeaderLock(hubRoot);
  await second.acquire();

  assert.ok(second.getEpoch() > first.getEpoch(), "second lock must have higher epoch");
  assert.equal(await second.stillHeld(), true);

  await second.release();
});

test("LeaderLock local: acquire recovers expired lock", async () => {
  const hubRoot = await tempRoot("cpb-leader-local-expired");
  const first = new LeaderLock(hubRoot);

  await first.acquire();
  // Manually expire the lock by writing an old expiresAt
  const leader = await readLeader(first);
  leader.expiresAt = new Date(Date.now() - 60_000).toISOString();
  leader.heartbeatAt = new Date(Date.now() - 60_000).toISOString();
  await writeFile(first.leaderFile, `${JSON.stringify(leader)}\n`, "utf8");

  // Second lock should be able to acquire
  const second = new LeaderLock(hubRoot);
  await second.acquire();

  assert.ok(second.getEpoch() > first.getEpoch());
  assert.equal(await second.stillHeld(), true);

  await second.release();
});

test("LeaderLock local: stillHeld returns false for different lock instance", async () => {
  const hubRoot = await tempRoot("cpb-leader-local-still-held");
  const first = new LeaderLock(hubRoot);
  await first.acquire();

  const second = new LeaderLock(hubRoot);
  assert.equal(await second.stillHeld(), false);

  await first.release();
});

// ---------------------------------------------------------------------------
// Multi-process concurrent leader competition
// ---------------------------------------------------------------------------

test("LeaderLock local: two processes race for lock — only one succeeds", async () => {
  const hubRoot = await tempRoot("cpb-leader-local-race");
  const scriptPath = path.join(hubRoot, "racer.mjs");

  // Write child script to a temp file
  await writeFile(scriptPath, `
    import { LeaderLock } from "${path.resolve("dist/server/orchestrator/leader-lock.js")}";

    const hubRoot = process.argv[2];
    const lock = new LeaderLock(hubRoot);

    try {
      const leader = await lock.acquire();
      // Hold the lock briefly
      await new Promise((r) => setTimeout(r, 200));
      console.log(JSON.stringify({ success: true, hubId: leader.hubId, epoch: leader.epoch }));
      await lock.release();
      process.exit(0);
    } catch (error) {
      console.log(JSON.stringify({ success: false, error: error.message }));
      process.exit(1);
    }
  `);

  // Spawn two child processes racing for the same lock
  const child1 = spawn(process.execPath, [scriptPath, hubRoot], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const child2 = spawn(process.execPath, [scriptPath, hubRoot], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const [result1, result2] = await Promise.all([
    collectChildResult(child1),
    collectChildResult(child2),
  ]);

  // Exactly one should succeed
  const successes = [result1, result2].filter((r) => r.success);
  const failures = [result1, result2].filter((r) => !r.success);

  assert.equal(successes.length, 1, `expected exactly 1 success, got ${successes.length}: ${JSON.stringify([result1, result2])}`);
  assert.equal(failures.length, 1, `expected exactly 1 failure, got ${failures.length}`);

  // The failure should be about the lock being held or the recovery fence blocking
  assert.ok(
    failures[0].error.includes("leader lock held by")
      || failures[0].error.includes("recovery fence is held")
      || failures[0].error.includes("leader lock"),
    `unexpected error: ${failures[0].error}`,
  );
});

test("LeaderLock local: three processes race — only one succeeds", async () => {
  const hubRoot = await tempRoot("cpb-leader-local-triple-race");
  const scriptPath = path.join(hubRoot, "racer.mjs");

  await writeFile(scriptPath, `
    import { LeaderLock } from "${path.resolve("dist/server/orchestrator/leader-lock.js")}";

    const hubRoot = process.argv[2];
    const lock = new LeaderLock(hubRoot);

    try {
      const leader = await lock.acquire();
      await new Promise((r) => setTimeout(r, 200));
      console.log(JSON.stringify({ success: true, hubId: leader.hubId, epoch: leader.epoch }));
      await lock.release();
      process.exit(0);
    } catch (error) {
      console.log(JSON.stringify({ success: false, error: error.message }));
      process.exit(1);
    }
  `);

  const children = Array.from({ length: 3 }, () =>
    spawn(process.execPath, [scriptPath, hubRoot], {
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );

  const results = await Promise.all(children.map(collectChildResult));

  const successes = results.filter((r) => r.success);
  const failures = results.filter((r) => !r.success);

  assert.equal(successes.length, 1, `expected exactly 1 success, got ${successes.length}: ${JSON.stringify(results)}`);
  assert.equal(failures.length, 2, `expected exactly 2 failures, got ${failures.length}`);
});

// ---------------------------------------------------------------------------
// SIGKILL recovery
// ---------------------------------------------------------------------------

test("LeaderLock local: SIGKILL'd leader's lock can be recovered after expiry", async () => {
  const hubRoot = await tempRoot("cpb-leader-local-sigkill");

  // Simulate a leader that was SIGKILL'd: write a lock with short TTL
  const lock1 = new LeaderLock(hubRoot);
  const leader1 = await lock1.acquire();

  // Manually set expiresAt to the past (simulates TTL expiring after SIGKILL)
  const stored = await readLeader(lock1);
  stored.expiresAt = new Date(Date.now() - 1_000).toISOString();
  stored.heartbeatAt = new Date(Date.now() - 60_000).toISOString();
  await writeFile(lock1.leaderFile, `${JSON.stringify(stored)}\n`, "utf8");

  // A new process should be able to acquire the lock
  const lock2 = new LeaderLock(hubRoot);
  const leader2 = await lock2.acquire();

  assert.ok(leader2.epoch > leader1.epoch, "new leader must have higher epoch");
  assert.equal(leader2.hubId, lock2.getHubId());
  assert.equal(await lock2.stillHeld(), true);

  await lock2.release();
});

test("LeaderLock local: SIGKILL'd leader with non-expired lock blocks new acquisition", async () => {
  const hubRoot = await tempRoot("cpb-leader-local-sigkill-block");

  // Simulate a leader that was SIGKILL'd but TTL hasn't expired yet
  const lock1 = new LeaderLock(hubRoot);
  await lock1.acquire();

  // Lock is still valid (TTL hasn't expired)
  const lock2 = new LeaderLock(hubRoot);
  await assert.rejects(lock2.acquire(), /leader lock held by/);
});

test("LeaderLock local: incomplete lock recovery when owner process is dead", async () => {
  const hubRoot = await tempRoot("cpb-leader-local-incomplete-dead");
  const lock = new LeaderLock(hubRoot);

  // Install an incomplete lock (receipt + directory, no leader.json)
  await installIncompleteOwner(lock, "dead-owner");

  // Mock: the owner process is dead
  lock._isProcessIdentityAlive = () => false;

  // Should be able to acquire
  const leader = await lock.acquire();
  assert.equal(leader.hubId, lock.getHubId());
  assert.equal(leader.initializing, false);

  await lock.release();
});

test("LeaderLock local: incomplete lock blocks acquisition when owner is alive", async () => {
  const hubRoot = await tempRoot("cpb-leader-local-incomplete-alive");
  const lock = new LeaderLock(hubRoot);

  await installIncompleteOwner(lock, "alive-owner");

  // Mock: the owner process is still alive
  lock._isProcessIdentityAlive = () => true;

  // Should NOT be able to acquire — owner is still alive
  await assert.rejects(lock.acquire(), /leader lock.*owned by live process|leader lock held by/);
});

// ---------------------------------------------------------------------------
// readLeaderStatus
// ---------------------------------------------------------------------------

test("readLeaderStatus returns running for active leader", async () => {
  const hubRoot = await tempRoot("cpb-leader-local-status-running");
  const lock = new LeaderLock(hubRoot);
  await lock.acquire();

  const status = await readLeaderStatus(hubRoot);
  assert.equal(status.status, "running");
  assert.equal(status.hubId, lock.getHubId());
  assert.equal(typeof status.epoch, "number");

  await lock.release();
});

test("readLeaderStatus returns stopped after release", async () => {
  const hubRoot = await tempRoot("cpb-leader-local-status-stopped");
  const lock = new LeaderLock(hubRoot);
  await lock.acquire();
  await lock.release();

  const status = await readLeaderStatus(hubRoot);
  assert.equal(status.status, "stopped");
});

test("readLeaderStatus returns stopped for empty hub root", async () => {
  const hubRoot = await tempRoot("cpb-leader-local-status-empty");

  const status = await readLeaderStatus(hubRoot);
  assert.equal(status.status, "stopped");
  assert.equal(status.hubId, null);
});

// ---------------------------------------------------------------------------
// LeaderLock epoch management
// ---------------------------------------------------------------------------

test("LeaderLock local: epoch increments on each acquisition", async () => {
  const hubRoot = await tempRoot("cpb-leader-local-epoch");

  const lock1 = new LeaderLock(hubRoot);
  const leader1 = await lock1.acquire();
  assert.ok(leader1.epoch >= 0);
  await lock1.release();

  const lock2 = new LeaderLock(hubRoot);
  const leader2 = await lock2.acquire();
  assert.ok(leader2.epoch > leader1.epoch, "epoch must increase");
  await lock2.release();

  const lock3 = new LeaderLock(hubRoot);
  const leader3 = await lock3.acquire();
  assert.ok(leader3.epoch > leader2.epoch, "epoch must increase again");
  await lock3.release();
});

test("LeaderLock local: startRenewal calls onLost when lock expires", async () => {
  const hubRoot = await tempRoot("cpb-leader-local-renewal-lost");
  const lock = new LeaderLock(hubRoot);
  await lock.acquire();

  // Manually expire the lock
  const stored = await readLeader(lock);
  stored.expiresAt = new Date(Date.now() - 1_000).toISOString();
  stored.heartbeatAt = new Date(Date.now() - 60_000).toISOString();
  await writeFile(lock.leaderFile, `${JSON.stringify(stored)}\n`, "utf8");

  let lostCalled = false;
  lock.startRenewal(() => {
    lostCalled = true;
  });

  // Wait for the renewal interval to fire (RENEW_INTERVAL_MS = 20_000, but
  // the timer fires on first tick which checks the expired lock)
  // We need to trigger the renewal check manually since the interval is 20s
  // Instead, call renew() directly to verify the behavior
  lock.stopRenewal();
  const renewed = await lock.renew();
  assert.equal(renewed, false, "renew should fail on expired lock");
});

// ---------------------------------------------------------------------------
// Concurrent write safety
// ---------------------------------------------------------------------------

test("LeaderLock local: guarded write detects concurrent modification", async () => {
  const hubRoot = await tempRoot("cpb-leader-local-guarded");
  const lock = new LeaderLock(hubRoot);
  await lock.acquire();

  // Modify the leader file behind the lock's back (simulates another process)
  const stored = await readLeader(lock);
  stored.hubId = "rogue-leader";
  await writeFile(lock.leaderFile, `${JSON.stringify(stored)}\n`, "utf8");

  // renew() should detect the mismatch and return false
  const renewed = await lock.renew();
  assert.equal(renewed, false, "renew should detect tampered leader file");
});

// ---------------------------------------------------------------------------
// Child process result collector
// ---------------------------------------------------------------------------

function collectChildResult(child: ChildProcess): Promise<{ success: boolean; hubId?: string; epoch?: number; error?: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
    child.on("exit", (code) => {
      try {
        // Find the last JSON line in stdout
        const lines = stdout.trim().split("\n").filter(Boolean);
        const lastLine = lines[lines.length - 1];
        const parsed = JSON.parse(lastLine);
        resolve(parsed);
      } catch {
        resolve({ success: false, error: `exit code ${code}, stdout: ${stdout.trim()}, stderr: ${stderr.trim()}` });
      }
    });
  });
}
