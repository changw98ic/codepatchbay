import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ProcessIdentity, ProcessTreeSystem } from "../core/runtime/process-tree.js";
import { LeaderLock, readLeaderStatus, withLeaderLockTestHooks } from "../server/orchestrator/leader-lock.js";
import { tempRoot } from "./helpers.js";

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

function psResult(stdout: string, status = 0) {
  return { stdout, status } as ReturnType<ProcessTreeSystem["spawnSync"]>;
}

function nestedErrorCodes(error: unknown): string[] {
  const codes: string[] = [];
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    codes.push(error.code);
  }
  if (error instanceof AggregateError) {
    for (const nested of error.errors) codes.push(...nestedErrorCodes(nested));
  }
  if (error && typeof error === "object" && "cause" in error) {
    codes.push(...nestedErrorCodes(error.cause));
  }
  return codes;
}

function leaderLockErrorForTest(message: string) {
  return Object.assign(new Error(message), { code: "TEST_INJECTED_LEADER_LOCK_FAILURE" });
}

function recoveryFenceSupported() {
  return ["darwin", "freebsd", "openbsd", "linux"].includes(process.platform);
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

async function installReplacementLeader(lock: LeaderLock, suffix: string) {
  const quarantine = path.join(path.dirname(lock.lockDir), `test-old-${suffix}`);
  await rename(lock.lockDir, quarantine);
  await mkdir(lock.lockDir);
  const replacement = {
    hubId: `replacement-${suffix}`,
    host: "replacement-host",
    pid: 999_999,
    processIdentity: fakeIdentity(999_999, `replacement-${suffix}`),
    epoch: lock.getEpoch() + 1,
    lockToken: `replacement-token-${suffix}`,
    initializing: false,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  await writeFile(lock.leaderFile, `${JSON.stringify(replacement)}\n`, "utf8");
  return replacement;
}

async function installCanonicalLeader(lock: LeaderLock, suffix: string, overrides: Record<string, unknown> = {}) {
  await mkdir(lock.lockDir, { recursive: true });
  const replacement = {
    hubId: `canonical-${suffix}`,
    host: "replacement-host",
    pid: 999_998,
    processIdentity: fakeIdentity(999_998, `canonical-${suffix}`),
    epoch: lock.getEpoch() + 1,
    lockToken: `canonical-token-${suffix}`,
    initializing: false,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
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

  assert.equal(await lock.release(), false);
  assert.deepEqual(await readLeader(lock), replacement);
});

test("LeaderLock refuses current-owner operations when exact process identity changes", async () => {
  const hubRoot = await tempRoot("cpb-leader-current-exact-identity");
  const lock = new LeaderLock(hubRoot);
  const leader = await lock.acquire();
  await writeFile(lock.leaderFile, `${JSON.stringify({
    ...leader,
    pid: 987_654,
    processIdentity: fakeIdentity(987_654, "same-token-successor"),
    heartbeatAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })}\n`, "utf8");

  assert.equal(await lock.renew(), false);
  assert.equal(await lock.release(), false);
  assert.equal(await lock.stillHeld(), false);
  const preserved = await readLeader(lock);
  assert.equal(preserved.pid, 987_654);
  assert.equal(preserved.lockToken, leader.lockToken);
});

test("LeaderLock recovers an incomplete lock only after its exact process incarnation is dead", async () => {
  const hubRoot = await tempRoot("cpb-leader-incomplete-stale");
  const lock = new LeaderLock(hubRoot);
  await installIncompleteOwner(lock, "dead");
  lock._isProcessIdentityAlive = () => false;

  const leader = await lock.acquire();
  assert.equal(leader.hubId, lock.getHubId());
  assert.equal((await readLeader(lock)).epoch, lock.getEpoch());
});

test("LeaderLock refuses to steal an incomplete lock without an identity receipt", async () => {
  const hubRoot = await tempRoot("cpb-leader-incomplete-fresh");
  const lock = new LeaderLock(hubRoot);
  await mkdir(lock.lockDir, { recursive: true });

  await assert.rejects(lock.acquire(), /process-identity acquisition receipt/);
  assert.equal((await stat(lock.lockDir)).isDirectory(), true);
});

test("LeaderLock fails closed on persisted coarse leader identity", async () => {
  const hubRoot = await tempRoot("cpb-leader-coarse-state");
  const lock = new LeaderLock(hubRoot);
  const pid = 999_123;
  await mkdir(lock.lockDir, { recursive: true });
  await writeFile(lock.leaderFile, `${JSON.stringify({
    hubId: "coarse-leader",
    host: os.hostname(),
    pid,
    processIdentity: {
      ...fakeIdentity(pid, "coarse"),
      birthIdPrecision: "coarse",
    },
    epoch: 1,
    lockToken: "coarse-token",
    initializing: false,
    ready: false,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  })}\n`, "utf8");

  await assert.rejects(lock.acquire(), { code: "HUB_LEADER_STATE_INVALID" });
  assert.equal((await stat(lock.lockDir)).isDirectory(), true);
});

test("LeaderLock fails closed on persisted acquisition receipt without exact precision", async () => {
  const hubRoot = await tempRoot("cpb-leader-coarse-acquisition");
  const lock = new LeaderLock(hubRoot);
  const receipt = await installIncompleteOwner(lock, "coarse-receipt");
  await writeFile(lock.acquisitionFile, `${JSON.stringify({
    ...receipt,
    processIdentity: {
      ...receipt.processIdentity,
      birthIdPrecision: "coarse",
    },
  })}\n`, "utf8");

  await assert.rejects(lock.acquire(), { code: "HUB_LEADER_ACQUISITION_INVALID" });
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

test("LeaderLock recovery fence never signals a helper without an exact spawn identity", async (t) => {
  if (!recoveryFenceSupported()) {
    t.skip(`recovery fences are unavailable on ${process.platform}`);
    return;
  }
  const hubRoot = await tempRoot("cpb-leader-fence-no-identity");
  const directKill = t.mock.method(ChildProcess.prototype, "kill", () => true);
  const signals: Array<NodeJS.Signals | 0 | undefined> = [];
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => psResult("")) as ProcessTreeSystem["spawnSync"],
    captureIdentity: () => null,
    kill: ((_pid: number, signal?: NodeJS.Signals | 0) => {
      signals.push(signal);
      return true;
    }) as ProcessTreeSystem["kill"],
  };
  const lock = new LeaderLock(hubRoot);
  lock._recoveryFenceRuntime = {
    processTreeSystem: system,
    helperCloseDelayMs: 80,
    closeGraceMs: 1,
    termGraceMs: 0,
    forceVerifyMs: 500,
  };
  let operationRan = false;

  await assert.rejects(
    lock._withRecoveryFence(async () => {
      operationRan = true;
    }),
    (error: unknown) => {
      assert.ok(nestedErrorCodes(error).includes("HUB_LEADER_RECOVERY_FENCE_UNVERIFIED"));
      return true;
    },
  );

  assert.equal(operationRan, false, "an unowned helper must not authorize the fenced operation");
  assert.equal(directKill.mock.callCount(), 0, "identity failure must not invoke ChildProcess.kill");
  assert.deepEqual(signals, [], "identity failure must not invoke process-tree signaling");
});

test("LeaderLock recovery fence rejects missing precision without signaling the helper", async (t) => {
  if (!recoveryFenceSupported()) {
    t.skip(`recovery fences are unavailable on ${process.platform}`);
    return;
  }
  const hubRoot = await tempRoot("cpb-leader-fence-missing-precision");
  const directKill = t.mock.method(ChildProcess.prototype, "kill", () => true);
  const signals: Array<NodeJS.Signals | 0 | undefined> = [];
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => psResult("")) as ProcessTreeSystem["spawnSync"],
    captureIdentity: (pid) => {
      const identity = fakeIdentity(pid, "missing-precision");
      delete identity.birthIdPrecision;
      return identity;
    },
    kill: ((_pid: number, signal?: NodeJS.Signals | 0) => {
      signals.push(signal);
      return true;
    }) as ProcessTreeSystem["kill"],
  };
  const lock = new LeaderLock(hubRoot);
  lock._recoveryFenceRuntime = {
    processTreeSystem: system,
    helperCloseDelayMs: 80,
    closeGraceMs: 1,
    termGraceMs: 0,
    forceVerifyMs: 500,
  };

  await assert.rejects(
    lock._withRecoveryFence(async () => undefined),
    (error: unknown) => {
      assert.ok(nestedErrorCodes(error).includes("HUB_LEADER_RECOVERY_FENCE_UNVERIFIED"));
      return true;
    },
  );

  assert.equal(directKill.mock.callCount(), 0, "missing precision must not invoke ChildProcess.kill");
  assert.deepEqual(signals, [], "missing precision must not invoke process-tree signaling");
});

test("LeaderLock recovery fence never signals a successor after helper PID reuse", async (t) => {
  if (!recoveryFenceSupported()) {
    t.skip(`recovery fences are unavailable on ${process.platform}`);
    return;
  }
  const hubRoot = await tempRoot("cpb-leader-fence-pid-reuse");
  const directKill = t.mock.method(ChildProcess.prototype, "kill", () => true);
  const signals: Array<NodeJS.Signals | 0 | undefined> = [];
  let captureCount = 0;
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => psResult("")) as ProcessTreeSystem["spawnSync"],
    captureIdentity: (pid) => fakeIdentity(pid, captureCount++ === 0 ? "original" : "successor"),
    kill: ((_pid: number, signal?: NodeJS.Signals | 0) => {
      signals.push(signal);
      return true;
    }) as ProcessTreeSystem["kill"],
  };
  const lock = new LeaderLock(hubRoot);
  lock._recoveryFenceRuntime = {
    processTreeSystem: system,
    helperCloseDelayMs: 80,
    closeGraceMs: 1,
    termGraceMs: 0,
    forceVerifyMs: 500,
  };

  await assert.rejects(
    lock._withRecoveryFence(async () => undefined),
    (error: unknown) => {
      assert.ok(nestedErrorCodes(error).includes("PROCESS_IDENTITY_MISMATCH"));
      return true;
    },
  );

  assert.ok(captureCount >= 2, "cleanup must revalidate the stored spawn identity");
  assert.equal(directKill.mock.callCount(), 0, "PID reuse must not invoke ChildProcess.kill");
  assert.equal(
    signals.some((signal) => signal !== 0),
    false,
    "PID reuse must not send a terminating signal through killTree",
  );
});

test("LeaderLock kernel recovery fence serializes a predecessor, recoverer, and successor contender", async () => {
  const hubRoot = await tempRoot("cpb-leader-three-party-fence");
  const predecessor = new LeaderLock(hubRoot);
  await predecessor.acquire();
  await predecessor.release();

  const recoverer = new LeaderLock(hubRoot);
  const originalQuarantine = recoverer._quarantineCurrentLock.bind(recoverer);
  let enteredResolve!: () => void;
  let resumeResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const resume = new Promise<void>((resolve) => { resumeResolve = resolve; });
  recoverer._quarantineCurrentLock = async (...args) => {
    enteredResolve();
    await resume;
    return originalQuarantine(...args);
  };

  const recovering = recoverer.acquire();
  await entered;
  const successor = new LeaderLock(hubRoot);
  try {
    await assert.rejects(successor.acquire(), /recovery fence is held/);
  } finally {
    resumeResolve();
  }
  const acquired = await recovering;
  assert.equal((await readLeader(recoverer)).lockToken, acquired.lockToken);
  assert.equal(await recoverer.stillHeld(), true);
});

test("LeaderLock quarantine refuses when generation changes after owner validation", async () => {
  const hubRoot = await tempRoot("cpb-leader-quarantine-aba");
  const predecessor = new LeaderLock(hubRoot);
  await predecessor.acquire();
  await predecessor.release();

  const recoverer = new LeaderLock(hubRoot);
  const originalReadReceipt = recoverer._readAcquisitionReceipt.bind(recoverer);
  let replacement: Awaited<ReturnType<typeof installReplacementLeader>> | undefined;
  recoverer._readAcquisitionReceipt = async (...args) => {
    if (!replacement) replacement = await installReplacementLeader(recoverer, "quarantine-aba");
    return originalReadReceipt(...args);
  };

  await assert.rejects(recoverer.acquire(), /directory generation changed/);
  assert.deepEqual(await readLeader(recoverer), replacement);
  assert.equal((await stat(recoverer.lockDir)).isDirectory(), true);
});

test("LeaderLock quarantine preserves an empty successor inserted after rename", async () => {
  const hubRoot = await tempRoot("cpb-leader-quarantine-empty-successor");
  const predecessor = new LeaderLock(hubRoot);
  await predecessor.acquire();
  await predecessor.release();

  const recoverer = new LeaderLock(hubRoot);
  const originalReadLeaderAt = recoverer._readLeaderAt.bind(recoverer);
  let inserted = false;
  recoverer._readLeaderAt = async (...args) => {
    if (!inserted && String(args[0]).startsWith(recoverer.quarantineDir)) {
      inserted = true;
      await mkdir(recoverer.lockDir);
    }
    return originalReadLeaderAt(...args);
  };

  let quarantineDir = "";
  await assert.rejects(
    recoverer.acquire(),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      const actual = error as AggregateError & {
        code?: unknown;
        committed?: unknown;
        quarantinePreserved?: unknown;
        successorPreserved?: unknown;
        recoveryPaths?: { quarantineDir?: unknown; lockDir?: unknown };
      };
      assert.equal(actual.code, "HUB_LEADER_SUCCESSOR_PRESERVED");
      assert.equal(actual.committed, true);
      assert.equal(actual.quarantinePreserved, true);
      assert.equal(actual.successorPreserved, true);
      assert.equal(actual.recoveryPaths?.lockDir, recoverer.lockDir);
      quarantineDir = String(actual.recoveryPaths?.quarantineDir || "");
      return quarantineDir.length > 0;
    },
  );

  assert.deepEqual(await readdir(recoverer.lockDir), []);
  assert.equal((await readdir(quarantineDir)).includes("leader.json"), true);
});

test("LeaderLock quarantine preserves a same-owner successor inserted after rename", async () => {
  const hubRoot = await tempRoot("cpb-leader-quarantine-same-owner-successor");
  const predecessor = new LeaderLock(hubRoot);
  const original = await predecessor.acquire();
  await predecessor.release();

  const recoverer = new LeaderLock(hubRoot);
  const originalReadLeaderAt = recoverer._readLeaderAt.bind(recoverer);
  let replacement: Record<string, unknown> | undefined;
  recoverer._readLeaderAt = async (...args) => {
    if (!replacement && String(args[0]).startsWith(recoverer.quarantineDir)) {
      replacement = await installCanonicalLeader(recoverer, "same-owner", {
        hubId: original.hubId,
        pid: original.pid,
        processIdentity: original.processIdentity,
        lockToken: original.lockToken,
        epoch: original.epoch,
      });
    }
    return originalReadLeaderAt(...args);
  };

  let quarantineDir = "";
  await assert.rejects(
    recoverer.acquire(),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      const actual = error as AggregateError & {
        code?: unknown;
        committed?: unknown;
        quarantinePreserved?: unknown;
        successorPreserved?: unknown;
        recoveryPaths?: { quarantineDir?: unknown; lockDir?: unknown };
      };
      assert.equal(actual.code, "HUB_LEADER_SUCCESSOR_PRESERVED");
      assert.equal(actual.committed, true);
      assert.equal(actual.quarantinePreserved, true);
      assert.equal(actual.successorPreserved, true);
      quarantineDir = String(actual.recoveryPaths?.quarantineDir || "");
      return quarantineDir.length > 0;
    },
  );

  assert.deepEqual(await readLeader(recoverer), replacement);
  assert.equal((await readdir(quarantineDir)).includes("leader.json"), true);
});

test("LeaderLock incomplete recovery fails closed on EPERM and preserves the exact owner", async () => {
  const hubRoot = await tempRoot("cpb-leader-incomplete-eperm");
  const lock = new LeaderLock(hubRoot);
  const receipt = await installIncompleteOwner(lock, "eperm");
  lock._isProcessIdentityAlive = () => {
    throw Object.assign(new Error("permission denied"), { code: "EPERM" });
  };

  await assert.rejects(lock.acquire(), (error: unknown) => (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "EPERM"
  ));
  assert.equal((await stat(lock.lockDir)).isDirectory(), true);
  assert.deepEqual(JSON.parse(await readFile(lock.acquisitionFile, "utf8")), receipt);
});

test("LeaderLock rejects symlink leader state without modifying its target", async () => {
  const hubRoot = await tempRoot("cpb-leader-symlink-state");
  const lock = new LeaderLock(hubRoot);
  const target = path.join(hubRoot, "outside-leader.json");
  const sentinel = "outside-state\n";
  await mkdir(lock.lockDir, { recursive: true });
  await writeFile(target, sentinel, "utf8");
  await symlink(target, lock.leaderFile);

  await assert.rejects(lock.acquire(), /unsafe leader state symlink/);
  await assert.rejects(readLeaderStatus(hubRoot), /unsafe leader state symlink/);
  assert.equal(await readFile(target, "utf8"), sentinel);
});

test("LeaderLock rejects corrupt leader state and preserves the lock directory", async () => {
  const hubRoot = await tempRoot("cpb-leader-corrupt-state");
  const lock = new LeaderLock(hubRoot);
  await mkdir(lock.lockDir, { recursive: true });
  await writeFile(lock.leaderFile, "{not-json\n", "utf8");

  await assert.rejects(lock.acquire(), SyntaxError);
  assert.equal((await stat(lock.lockDir)).isDirectory(), true);
  assert.equal(await readFile(lock.leaderFile, "utf8"), "{not-json\n");
});

test("LeaderLock rejects oversized acquisition state and preserves recovery evidence", async () => {
  const hubRoot = await tempRoot("cpb-leader-oversized-acquisition");
  const lock = new LeaderLock(hubRoot);
  await mkdir(lock.lockDir, { recursive: true });
  const oversized = `${"x".repeat(64 * 1024 + 1)}\n`;
  await writeFile(lock.acquisitionFile, oversized, "utf8");

  await assert.rejects(lock.acquire(), { code: "HUB_LEADER_STATE_TOO_LARGE" });
  assert.equal((await stat(lock.lockDir)).isDirectory(), true);
  assert.equal(await readFile(lock.acquisitionFile, "utf8"), oversized);
});

test("LeaderLock rejects symlink epoch state without modifying its target", async () => {
  const hubRoot = await tempRoot("cpb-leader-symlink-epoch");
  const lock = new LeaderLock(hubRoot);
  const target = path.join(hubRoot, "outside-epoch.json");
  const sentinel = JSON.stringify({ epoch: 41, updatedAt: new Date().toISOString() });
  await mkdir(path.dirname(lock.epochFile), { recursive: true });
  await writeFile(target, `${sentinel}\n`, "utf8");
  await symlink(target, lock.epochFile);

  await assert.rejects(lock.acquire(), { code: "HUB_LEADER_STATE_UNSAFE" });
  assert.equal(await readFile(target, "utf8"), `${sentinel}\n`);
});

test("LeaderLock acquisition receipt cleanup preserves successor receipts after quarantine", async () => {
  const hubRoot = await tempRoot("cpb-leader-acquisition-cleanup-successor");
  const lock = new LeaderLock(hubRoot);
  const receipt = await installIncompleteOwner(lock, "cleanup-successor");
  const successor = {
    ...receipt,
    hubId: "successor-cleanup",
    pid: 987_321,
    processIdentity: fakeIdentity(987_321, "successor-cleanup"),
    lockToken: "successor-token-cleanup",
  };
  const originalReadReceipt = lock._readAcquisitionReceipt.bind(lock);
  let inserted = false;
  lock._readAcquisitionReceipt = async (...args) => {
    if (!inserted && args[0] && String(args[0]).startsWith(lock.quarantineDir)) {
      inserted = true;
      await writeFile(lock.acquisitionFile, `${JSON.stringify(successor)}\n`, "utf8");
      throw leaderLockErrorForTest("moved receipt read failed after successor appeared");
    }
    return originalReadReceipt(...args);
  };

  await assert.rejects(lock._removeAcquisitionReceipt(receipt), { code: "HUB_LEADER_ACQUISITION_RESTORE_BLOCKED" });
  assert.deepEqual(JSON.parse(await readFile(lock.acquisitionFile, "utf8")), successor);
  assert.equal((await readdir(lock.quarantineDir)).some((entry) => entry.startsWith("acquisition-")), true);
});

test("LeaderLock acquisition receipt cleanup preserves quarantined receipt evidence", async () => {
  const hubRoot = await tempRoot("cpb-leader-acquisition-cleanup-preserve");
  const lock = new LeaderLock(hubRoot);
  const receipt = await installIncompleteOwner(lock, "cleanup-preserve");

  assert.equal(await lock._removeAcquisitionReceipt(receipt), true);

  const entries = await readdir(lock.quarantineDir);
  const preserved = entries.find((entry) => entry.startsWith("acquisition-") && entry.endsWith(".json"));
  assert.ok(preserved, "the retired acquisition receipt remains as recovery evidence");
  assert.deepEqual(
    JSON.parse(await readFile(path.join(lock.quarantineDir, preserved), "utf8")),
    receipt,
  );
});

test("LeaderLock directory durability refuses non-strict directory open flags", async () => {
  const hubRoot = await tempRoot("cpb-leader-strict-directory-open");
  const lock = new LeaderLock(hubRoot);

  await assert.rejects(
    withLeaderLockTestHooks({
      resolveDirectoryOpenFlags: () => fsConstants.O_RDONLY,
    }, () => lock.acquire()),
    (error: unknown) => {
      assert.ok(nestedErrorCodes(error).includes("HUB_LEADER_DIRECTORY_UNSAFE"));
      return true;
    },
  );
});

test("LeaderLock guarded write preserves a successor inserted after owner validation", async () => {
  const hubRoot = await tempRoot("cpb-leader-guarded-publish-successor");
  const lock = new LeaderLock(hubRoot);
  await lock.acquire();
  let replacement: Awaited<ReturnType<typeof installReplacementLeader>> | undefined;

  const renewed = await withLeaderLockTestHooks({
    afterLeaderOwnerValidated: async ({ phase }) => {
      if (phase === "guarded-write" && !replacement) {
        replacement = await installReplacementLeader(lock, "guarded-publish");
      }
    },
  }, () => lock.renew());

  assert.equal(renewed, false);
  assert.deepEqual(await readLeader(lock), replacement);
  assert.equal(
    (await readdir(lock.quarantineDir)).some((entry) => entry.startsWith("leader-temp-")),
    true,
    "the abandoned temp publication remains quarantined as recovery evidence",
  );
});

test("LeaderLock guarded write preserves temporary publication after injected failure", async () => {
  const hubRoot = await tempRoot("cpb-leader-temp-preserve");
  const lock = new LeaderLock(hubRoot);
  const leader = await lock.acquire();

  await assert.rejects(
    withLeaderLockTestHooks({
      afterLeaderTempWritten: () => {
        throw leaderLockErrorForTest("abort after temp write");
      },
    }, () => lock._writeLeaderGuarded({
      ...leader,
      heartbeatAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, true)),
    { code: "TEST_INJECTED_LEADER_LOCK_FAILURE" },
  );

  assert.equal(
    (await readdir(lock.quarantineDir)).some((entry) => entry.startsWith("leader-temp-")),
    true,
  );
  assert.equal((await readLeader(lock)).lockToken, leader.lockToken);
});

test("LeaderLock release surfaces state-read and guarded-write errors", async () => {
  const readHubRoot = await tempRoot("cpb-leader-release-read-error");
  const readFailure = new LeaderLock(readHubRoot);
  await readFailure.acquire();
  readFailure._readLeader = async () => {
    throw Object.assign(new Error("permission denied"), { code: "EPERM" });
  };
  await assert.rejects(readFailure.release(), (error: unknown) => (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "EPERM"
  ));

  const writeHubRoot = await tempRoot("cpb-leader-release-write-error");
  const writeFailure = new LeaderLock(writeHubRoot);
  await writeFailure.acquire();
  writeFailure._writeLeaderGuarded = async () => {
    throw Object.assign(new Error("guard write failed"), { code: "EIO" });
  };
  await assert.rejects(writeFailure.release(), (error: unknown) => (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "EIO"
  ));
});

test("LeaderLock markReady exposes readiness bound to the local process incarnation and lock token", async () => {
  const hubRoot = await tempRoot("cpb-leader-status-identity");
  const lock = new LeaderLock(hubRoot);
  const leader = await lock.acquire();

  const acquiredStatus = await readLeaderStatus(hubRoot);
  assert.equal(acquiredStatus.status, "running");
  assert.equal(acquiredStatus.ready, false);
  assert.equal(await lock.markReady(), true);

  const status = await readLeaderStatus(hubRoot);
  assert.equal(status.ready, true);
  assert.ok(status.readyAt);
  assert.equal(status.hubId, leader.hubId);
  assert.equal(status.lockToken, leader.lockToken);
  assert.deepEqual(status.processIdentity, leader.processIdentity);
});

test("LeaderLock release and successor acquisition invalidate an old readiness receipt", async () => {
  const hubRoot = await tempRoot("cpb-leader-ready-successor");
  const predecessor = new LeaderLock(hubRoot);
  await predecessor.acquire();
  assert.equal(await predecessor.markReady(), true);
  assert.equal((await readLeaderStatus(hubRoot)).ready, true);
  await predecessor.release();
  assert.equal((await readLeaderStatus(hubRoot)).ready, false);

  const successor = new LeaderLock(hubRoot);
  await successor.acquire();
  assert.equal((await readLeaderStatus(hubRoot)).ready, false);
  assert.equal(await successor.markReady(), true);
  const successorStatus = await readLeaderStatus(hubRoot);
  assert.equal(successorStatus.ready, true);
  assert.equal(successorStatus.lockToken, successor.lockToken);

  assert.equal(await predecessor.markReady(), false);
  const preserved = await readLeaderStatus(hubRoot);
  assert.equal(preserved.ready, true);
  assert.equal(preserved.lockToken, successor.lockToken);
});

test("LeaderLock Redis readiness receipt is generation-bound and carries ProcessIdentity", async () => {
  const hubRoot = await tempRoot("cpb-leader-ready-redis");
  const first = new LeaderLock(hubRoot);
  const successor = new LeaderLock(hubRoot);
  first.epoch = 11;
  successor.epoch = 12;
  const statusFor = (lock: LeaderLock) => ({
    alive: true,
    hubId: lock.hubId,
    lockToken: lock.lockToken,
    host: os.hostname(),
    pid: process.pid,
    epoch: lock.epoch,
  });
  let current = statusFor(first);
  const backend = { readLeader: async () => current } as never;
  first._redisBackend = backend;
  successor._redisBackend = backend;

  assert.equal(await first.markReady(), true);
  const firstReceipt = await first._readReadyReceipt();
  assert.ok(firstReceipt?.processIdentity);
  assert.equal(firstReceipt?.epoch, first.epoch);

  current = statusFor(successor);
  assert.equal(await successor.markReady(), true);
  const successorReceipt = await successor._readReadyReceipt();
  assert.ok(successorReceipt?.processIdentity);
  assert.equal(successorReceipt?.epoch, successor.epoch);
  assert.notEqual(successorReceipt?.lockToken, firstReceipt?.lockToken);

  assert.equal(await first.markReady(), false);
  assert.deepEqual(await successor._readReadyReceipt(), successorReceipt);
});
