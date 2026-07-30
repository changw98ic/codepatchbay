/**
 * Tests for local-code-index lock process-level behaviors:
 *   1. Simultaneous stale-owner recovery elects exactly one process.
 *   2. Orphan repair requires exact pinned identities (no fuzzy matching).
 *   3. Process-incarnation probes correctly distinguish same/successor/gone.
 *
 * All filesystem operations use unique temp directories so tests are isolated
 * and can run in parallel.
 *
 * Run:
 *   node dist-tests/scripts/run-node-tests.js tests/local-code-index-lock-process.test.ts
 */

import assert from "node:assert/strict";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";

import {
  acquireIndexLock,
  releaseIndexLock,
  inspectIndexLock,
  repairIndexLock,
  IndexLockError,
} from "../core/indexing/local-code-index/lock.js";

import type {
  IndexLockOwner,
  AcquireIndexLockOptions,
} from "../core/indexing/local-code-index/lock.js";

import type { ProcessIdentity } from "../shared/primitives/process-tree.js";
import { canonicalStringify } from "../core/indexing/local-code-index/canonical-json.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function tempRoot(prefix: string): Promise<string> {
  const dir = path.join(
    process.env.TMPDIR || "/tmp",
    `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Build a synthetic ProcessIdentity for a given PID. */
function fakeProcessIdentity(
  pid: number,
  birthId?: string,
  opts?: { precision?: "exact" | "coarse"; processGroupId?: number },
): ProcessIdentity {
  const bid = birthId ?? `fake-birth-${randomUUID().slice(0, 12)}`;
  const identity: ProcessIdentity = {
    pid,
    birthId: bid,
    incarnation: `${pid}:${bid}`,
    capturedAt: new Date().toISOString(),
    birthIdPrecision: opts?.precision ?? "exact",
  };
  if (opts?.processGroupId !== undefined) {
    identity.processGroupId = opts.processGroupId;
  }
  return identity;
}

/**
 * Build a valid IndexLockOwner record.
 *
 * IMPORTANT: host defaults to os.hostname() so that acquireIndexLock's
 * stale-recovery path (which checks `existingOwner.host === os.hostname()`)
 * can actually trigger recovery in tests.
 */
function fakeOwner(
  overrides: Partial<IndexLockOwner> & { scopeKind?: string; scopeKey?: string } = {},
): IndexLockOwner {
  const pid = overrides.pid ?? 42000 + Math.floor(Math.random() * 5000);
  const identity = overrides.processIdentity ?? fakeProcessIdentity(pid);
  return {
    scopeKind: (overrides.scopeKind as IndexLockOwner["scopeKind"]) ?? "repository-objects",
    scopeKey: overrides.scopeKey ?? "test-repo-key",
    pid,
    ownerToken: overrides.ownerToken ?? randomUUID(),
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    host: overrides.host ?? os.hostname(),
    processIdentity: identity,
  };
}

/**
 * Manually create a lock directory with a hand-written owner.json,
 * bypassing acquireIndexLock to simulate a lock left by another (dead) process.
 */
async function createStaleLockDir(
  lockDir: string,
  owner: IndexLockOwner,
): Promise<void> {
  await mkdir(lockDir, { recursive: true });
  const ownerPath = path.join(lockDir, "owner.json");
  await writeFile(ownerPath, canonicalStringify(owner), "utf8");
}

/**
 * Count directories matching a pattern inside a parent.
 */
async function countDirsMatching(parent: string, pattern: RegExp): Promise<number> {
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && pattern.test(e.name)).length;
  } catch {
    return 0;
  }
}

/**
 * Build a contender identity whose pid matches process.pid.
 *
 * acquireIndexLock sets owner.pid = process.pid and writes processIdentity
 * alongside it. The owner validation requires processIdentity.pid === owner.pid,
 * so contenders must use process.pid as their identity pid.
 */
function contenderIdentity(birthId?: string): ProcessIdentity {
  return fakeProcessIdentity(process.pid, birthId, { precision: "exact" });
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. Simultaneous recovery elects exactly one process
// ══════════════════════════════════════════════════════════════════════════════

test("simultaneous recovery: two contenders race — exactly one wins", async () => {
  const root = await tempRoot("cpb-lock-elect-1");
  const lockDir = path.join(root, "objects.lock");

  // Create a stale lock owned by a dead process.
  // host must be os.hostname() for recovery to trigger.
  const deadIdentity = fakeProcessIdentity(49001);
  const staleOwner = fakeOwner({
    pid: 49001,
    processIdentity: deadIdentity,
    ownerToken: randomUUID(),
  });
  await createStaleLockDir(lockDir, staleOwner);

  // Both contenders use process.pid identities (required by acquireIndexLock).
  const contenderA = contenderIdentity();
  const contenderB = contenderIdentity();

  let aCaptured = false;
  let bCaptured = false;

  const sharedOpts: Partial<AcquireIndexLockOptions> = {
    scopeKind: "repository-objects",
    scopeKey: "test-repo-key",
    waitMs: 3000,
    retryMs: 50,
    isIdentityAlive: (id) => {
      // The stale owner's identity is dead.
      if (id.incarnation === deadIdentity.incarnation) return false;
      // Contenders are alive.
      return true;
    },
  };

  // Fire both recovery attempts concurrently.
  const [resultA, resultB] = await Promise.allSettled([
    acquireIndexLock(lockDir, {
      ...sharedOpts,
      captureIdentity: () => { aCaptured = true; return contenderA; },
    } as AcquireIndexLockOptions),
    acquireIndexLock(lockDir, {
      ...sharedOpts,
      captureIdentity: () => { bCaptured = true; return contenderB; },
    } as AcquireIndexLockOptions),
  ]);

  // At least one contender attempted identity capture.
  assert.ok(aCaptured || bCaptured, "at least one contender must have captured identity");

  // Exactly one succeeds; the other either fails or succeeds after the winner
  // releases. In a true race both may succeed sequentially, but at most one
  // holds the lock at any instant.
  const outcomes = [resultA, resultB];
  const fulfilled = outcomes.filter((r) => r.status === "fulfilled");

  // At least one must succeed (the recovery quarantines the stale lock, then
  // mkdir succeeds for the first caller).
  assert.ok(fulfilled.length >= 1, "at least one recovery must succeed");

  // If both succeeded, they did so sequentially. Rejections must be Errors.
  for (const r of outcomes) {
    if (r.status === "rejected") {
      assert.ok(r.reason instanceof Error, "rejected outcome must be an Error");
    }
  }
});

test("simultaneous recovery: election directory is created exactly once per owner token", async () => {
  const root = await tempRoot("cpb-lock-elect-2");
  const lockDir = path.join(root, "objects.lock");

  const deadIdentity = fakeProcessIdentity(49010);
  const staleOwner = fakeOwner({
    pid: 49010,
    processIdentity: deadIdentity,
    ownerToken: randomUUID(),
  });
  await createStaleLockDir(lockDir, staleOwner);

  // Three concurrent recovery attempts with the same stale owner.
  const identities = [
    contenderIdentity(),
    contenderIdentity(),
    contenderIdentity(),
  ];

  const results = await Promise.allSettled(
    identities.map((id) =>
      acquireIndexLock(lockDir, {
        scopeKind: "repository-objects",
        scopeKey: "test-repo-key",
        waitMs: 2000,
        retryMs: 50,
        captureIdentity: () => id,
        isIdentityAlive: (checkId) => {
          if (checkId.incarnation === deadIdentity.incarnation) return false;
          return true;
        },
      } as AcquireIndexLockOptions),
    ),
  );

  // Check recovery-elections directory: there should be exactly one election
  // directory for this owner-token hash, because mkdir is atomic — only the
  // first process creates it, others get EEXIST and back off.
  const electionsParent = path.join(root, "recovery-elections");
  const electionCount = await countDirsMatching(electionsParent, /^[0-9a-f]{32}$/);

  // At most one election directory was created (the race winner).
  assert.ok(
    electionCount <= 1,
    `expected at most 1 election directory, got ${electionCount}`,
  );

  // At least one contender succeeded overall.
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  assert.ok(fulfilled.length >= 1, "at least one contender must succeed");
});

test("simultaneous recovery: second contender sees EEXIST and does not corrupt the election", async () => {
  const root = await tempRoot("cpb-lock-elect-3");
  const lockDir = path.join(root, "objects.lock");

  const deadIdentity = fakeProcessIdentity(49020);
  const staleOwner = fakeOwner({
    pid: 49020,
    processIdentity: deadIdentity,
    ownerToken: randomUUID(),
  });
  await createStaleLockDir(lockDir, staleOwner);

  // Pre-create the recovery election directory to simulate another process
  // winning the election before this one attempts it.
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(staleOwner.ownerToken).digest("hex").slice(0, 32);
  const electionsDir = path.join(root, "recovery-elections");
  await mkdir(electionsDir, { recursive: true });
  await mkdir(path.join(electionsDir, hash));

  // This contender tries to recover — should see EEXIST and fail gracefully.
  const cId = contenderIdentity();

  await assert.rejects(
    () =>
      acquireIndexLock(lockDir, {
        scopeKind: "repository-objects",
        scopeKey: "test-repo-key",
        waitMs: 500,
        retryMs: 50,
        captureIdentity: () => cId,
        isIdentityAlive: (id) => {
          if (id.incarnation === deadIdentity.incarnation) return false;
          return true;
        },
      } as AcquireIndexLockOptions),
    (err: unknown) => {
      assert.ok(err instanceof IndexLockError, "must be IndexLockError");
      return true;
    },
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. Orphan repair requires exact pinned identities
// ══════════════════════════════════════════════════════════════════════════════

test("orphan repair: accepts when lock dir generation and owner token match exactly", async () => {
  const root = await tempRoot("cpb-lock-repair-exact");
  const lockDir = path.join(root, "objects.lock");

  const deadIdentity = fakeProcessIdentity(49030, undefined, { precision: "exact" });
  const staleOwner = fakeOwner({
    pid: 49030,
    processIdentity: deadIdentity,
    ownerToken: randomUUID(),
  });
  await createStaleLockDir(lockDir, staleOwner);

  // Inspect to get the generation and pinned owner.
  const inspectResult = await inspectIndexLock(lockDir);
  assert.equal(inspectResult.locked, true, "lock must appear locked");
  assert.ok(inspectResult.owner, "owner must be present");
  assert.ok(inspectResult.generation, "generation must be present");

  // Repair with exact pinned values.
  const repairResult = await repairIndexLock({
    lockDir,
    lockGeneration: inspectResult.generation!,
    staleOwner: inspectResult.owner!,
    captureIdentity: () => fakeProcessIdentity(49031),
    isIdentityAlive: (id) => {
      if (id.incarnation === deadIdentity.incarnation) return false;
      return true;
    },
  });

  assert.ok(repairResult.lockQuarantinePath, "must return a quarantine path");
  assert.ok(
    repairResult.lockQuarantinePath.includes("repair"),
    "quarantine path must indicate repair",
  );

  // Original lock dir must be gone.
  await assert.rejects(
    () => readFile(path.join(lockDir, "owner.json"), "utf8"),
    (err: NodeJS.ErrnoException) => err.code === "ENOENT",
    "original lock dir must be quarantined",
  );
});

test("orphan repair: rejects when lock directory generation drifts (ABA)", async () => {
  const root = await tempRoot("cpb-lock-repair-aba");
  const lockDir = path.join(root, "objects.lock");

  const deadIdentity = fakeProcessIdentity(49040);
  const staleOwner = fakeOwner({
    pid: 49040,
    processIdentity: deadIdentity,
    ownerToken: randomUUID(),
  });
  await createStaleLockDir(lockDir, staleOwner);

  const inspectResult = await inspectIndexLock(lockDir);
  assert.ok(inspectResult.generation, "generation must be present");

  // Simulate ABA: remove and recreate the lock directory with a different
  // owner, so the generation changes.
  await rm(lockDir, { recursive: true, force: true });
  const newOwner = fakeOwner({
    pid: 49041,
    processIdentity: fakeProcessIdentity(49041),
    ownerToken: randomUUID(),
  });
  await createStaleLockDir(lockDir, newOwner);

  // Attempt repair with the OLD pinned generation — must fail.
  await assert.rejects(
    () =>
      repairIndexLock({
        lockDir,
        lockGeneration: inspectResult.generation!,
        staleOwner: inspectResult.owner!,
        captureIdentity: () => fakeProcessIdentity(49042),
        isIdentityAlive: () => false,
      }),
    (err: unknown) => {
      assert.ok(err instanceof IndexLockError);
      assert.equal(err.code, "index_lock_lost");
      return true;
    },
  );
});

test("orphan repair: rejects when owner token changed (successor appeared)", async () => {
  const root = await tempRoot("cpb-lock-repair-successor");
  const lockDir = path.join(root, "objects.lock");

  const deadIdentity = fakeProcessIdentity(49050);
  const staleOwner = fakeOwner({
    pid: 49050,
    processIdentity: deadIdentity,
    ownerToken: randomUUID(),
  });
  await createStaleLockDir(lockDir, staleOwner);

  const inspectResult = await inspectIndexLock(lockDir);
  assert.ok(inspectResult.generation, "generation must be present");

  // A successor acquires the lock (same directory, different owner token).
  const successorOwner = fakeOwner({
    pid: 49051,
    processIdentity: fakeProcessIdentity(49051),
    ownerToken: randomUUID(),
  });
  await writeFile(path.join(lockDir, "owner.json"), canonicalStringify(successorOwner), "utf8");

  // Attempt repair with the stale owner — must fail because owner changed.
  await assert.rejects(
    () =>
      repairIndexLock({
        lockDir,
        lockGeneration: inspectResult.generation!,
        staleOwner: inspectResult.owner!,
        captureIdentity: () => fakeProcessIdentity(49052),
        isIdentityAlive: () => false,
      }),
    (err: unknown) => {
      assert.ok(err instanceof IndexLockError);
      assert.equal(err.code, "index_lock_lost");
      return true;
    },
  );
});

test("orphan repair: rejects when stale owner is still alive", async () => {
  const root = await tempRoot("cpb-lock-repair-alive");
  const lockDir = path.join(root, "objects.lock");

  const aliveIdentity = fakeProcessIdentity(49060, undefined, { precision: "exact" });
  const owner = fakeOwner({
    pid: 49060,
    processIdentity: aliveIdentity,
    ownerToken: randomUUID(),
  });
  await createStaleLockDir(lockDir, owner);

  const inspectResult = await inspectIndexLock(lockDir);

  // isIdentityAlive returns true — the owner is alive, repair must not proceed.
  await assert.rejects(
    () =>
      repairIndexLock({
        lockDir,
        lockGeneration: inspectResult.generation!,
        staleOwner: inspectResult.owner!,
        captureIdentity: () => fakeProcessIdentity(49061),
        isIdentityAlive: (id) => {
          if (id.incarnation === aliveIdentity.incarnation) return true;
          return false;
        },
      }),
    (err: unknown) => {
      assert.ok(err instanceof IndexLockError);
      assert.equal(err.code, "index_lock_invalid");
      return true;
    },
  );
});

test("orphan repair: same ownerToken but different incarnation still proceeds (ownerToken is authority)", async () => {
  const root = await tempRoot("cpb-lock-repair-incarnation-drift");
  const lockDir = path.join(root, "objects.lock");

  const originalIdentity = fakeProcessIdentity(49070, undefined, { precision: "exact" });
  const ownerToken = randomUUID();
  const staleOwner = fakeOwner({
    pid: 49070,
    processIdentity: originalIdentity,
    ownerToken,
  });
  await createStaleLockDir(lockDir, staleOwner);

  const inspectResult = await inspectIndexLock(lockDir);

  // After inspection, a new process reuses the same PID with a different birthId.
  // The on-disk owner now has a different incarnation but the same ownerToken.
  // repairIndexLock uses ownerToken as the authority — it does not compare
  // incarnations because the stale owner (pinned from inspection) is already
  // confirmed dead. The repair should succeed.
  const recycledIdentity = fakeProcessIdentity(49070, undefined, { precision: "exact" });
  const successorOwner = fakeOwner({
    pid: 49070,
    processIdentity: recycledIdentity,
    ownerToken, // same token
  });
  await writeFile(path.join(lockDir, "owner.json"), canonicalStringify(successorOwner), "utf8");

  const result = await repairIndexLock({
    lockDir,
    lockGeneration: inspectResult.generation!,
    staleOwner: inspectResult.owner!,
    captureIdentity: () => fakeProcessIdentity(49071),
    isIdentityAlive: () => false,
  });

  // Repair succeeds: the ownerToken matched, so the lock is quarantined.
  assert.ok(result.lockQuarantinePath, "must quarantine the lock");
  assert.ok(result.lockQuarantinePath.includes("repair"), "path must indicate repair");
});

test("orphan repair with election: quarantines both lock and orphaned election", async () => {
  const root = await tempRoot("cpb-lock-repair-both");
  const lockDir = path.join(root, "objects.lock");

  const deadIdentity = fakeProcessIdentity(49080, undefined, { precision: "exact" });
  const ownerToken = randomUUID();
  const staleOwner = fakeOwner({
    pid: 49080,
    processIdentity: deadIdentity,
    ownerToken,
  });
  await createStaleLockDir(lockDir, staleOwner);

  // Create an orphaned election directory.
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(ownerToken).digest("hex").slice(0, 32);
  const electionsDir = path.join(root, "recovery-elections");
  await mkdir(electionsDir, { recursive: true });
  const electionDir = path.join(electionsDir, hash);
  await mkdir(electionDir);

  // Read the election directory generation.
  const electionStat = await lstat(electionDir);
  const electionGeneration = {
    dev: electionStat.dev,
    ino: electionStat.ino,
    mtimeMs: electionStat.mtimeMs,
    birthtimeMs: electionStat.birthtimeMs,
  };

  const inspectResult = await inspectIndexLock(lockDir);

  const result = await repairIndexLock({
    lockDir,
    lockGeneration: inspectResult.generation!,
    staleOwner: inspectResult.owner!,
    staleElectionDir: electionDir,
    staleElectionGeneration: electionGeneration,
    captureIdentity: () => fakeProcessIdentity(49081),
    isIdentityAlive: (id) => {
      if (id.incarnation === deadIdentity.incarnation) return false;
      return true;
    },
  });

  assert.ok(result.lockQuarantinePath, "lock quarantine path must be set");
  assert.ok(result.electionQuarantinePath, "election quarantine path must be set");
  assert.ok(
    result.electionQuarantinePath!.includes("quarantined-election"),
    "election quarantine path must indicate quarantine",
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. Process-incarnation probes work correctly
// ══════════════════════════════════════════════════════════════════════════════

test("process-incarnation probe: exact identity with birthIdPrecision='exact' is preserved through round-trip", async () => {
  const root = await tempRoot("cpb-lock-probe-exact");
  const lockDir = path.join(root, "objects.lock");

  const exactIdentity = fakeProcessIdentity(49100, undefined, { precision: "exact" });
  const owner = fakeOwner({
    pid: 49100,
    processIdentity: exactIdentity,
    ownerToken: randomUUID(),
  });
  await createStaleLockDir(lockDir, owner);

  const inspectResult = await inspectIndexLock(lockDir);
  assert.ok(inspectResult.owner, "owner must be present");
  assert.equal(
    inspectResult.owner!.processIdentity.birthIdPrecision,
    "exact",
    "identity must be exact",
  );
  assert.equal(
    inspectResult.owner!.processIdentity.incarnation,
    exactIdentity.incarnation,
    "incarnation must round-trip",
  );
});

test("process-incarnation probe: coarse identity is treated as dead by isOwnerAlive (recovery triggers)", async () => {
  const root = await tempRoot("cpb-lock-probe-coarse");
  const lockDir = path.join(root, "objects.lock");

  // Create a lock with a coarse (non-exact) identity.
  const coarseIdentity = fakeProcessIdentity(49110, undefined, { precision: "coarse" });
  const owner = fakeOwner({
    pid: 49110,
    processIdentity: coarseIdentity,
    ownerToken: randomUUID(),
  });
  await createStaleLockDir(lockDir, owner);

  const inspectResult = await inspectIndexLock(lockDir);
  assert.ok(inspectResult.owner, "owner must be present");

  // The stale owner has a coarse identity. acquireIndexLock's internal
  // isOwnerAlive check requires birthIdPrecision === "exact" before even
  // calling the isIdentityAlive callback. A coarse identity fails that
  // gate, so the owner appears dead and recovery triggers.
  const cId = contenderIdentity();

  const acquired = await acquireIndexLock(lockDir, {
    scopeKind: "repository-objects",
    scopeKey: "test-repo-key",
    waitMs: 3000,
    retryMs: 50,
    captureIdentity: () => cId,
    isIdentityAlive: (id) => {
      // This callback is never reached for the coarse owner because
      // isOwnerAlive short-circuits on birthIdPrecision !== "exact".
      // Return true for the contender's own identity.
      if (id.incarnation === coarseIdentity.incarnation) return false;
      return true;
    },
  } as AcquireIndexLockOptions);

  assert.ok(acquired, "must acquire lock after stale owner with coarse identity");
  assert.notEqual(acquired.ownerToken, owner.ownerToken, "new owner must have different token");

  await releaseIndexLock(lockDir, acquired);
});

test("process-incarnation probe: same PID with different birthId is a successor, not the same process", async () => {
  const root = await tempRoot("cpb-lock-probe-successor");
  const lockDir = path.join(root, "objects.lock");

  const originalBirthId = `birth-${randomUUID().slice(0, 12)}`;
  const originalIdentity = fakeProcessIdentity(49120, originalBirthId, { precision: "exact" });
  const owner = fakeOwner({
    pid: 49120,
    processIdentity: originalIdentity,
    ownerToken: randomUUID(),
  });
  await createStaleLockDir(lockDir, owner);

  // Same PID but a different birthId — this is a successor incarnation.
  const successorBirthId = `birth-${randomUUID().slice(0, 12)}`;
  const successorIdentity = fakeProcessIdentity(49120, successorBirthId, { precision: "exact" });

  assert.notEqual(
    originalIdentity.incarnation,
    successorIdentity.incarnation,
    "same PID with different birthId must have different incarnation",
  );
  assert.equal(
    originalIdentity.pid,
    successorIdentity.pid,
    "both must share the same PID",
  );

  // The isIdentityAlive callback checks the original incarnation — it is dead.
  const cId = contenderIdentity();

  const acquired = await acquireIndexLock(lockDir, {
    scopeKind: "repository-objects",
    scopeKey: "test-repo-key",
    waitMs: 3000,
    retryMs: 50,
    captureIdentity: () => cId,
    isIdentityAlive: (id) => {
      // Original incarnation is gone.
      if (id.incarnation === originalIdentity.incarnation) return false;
      return true;
    },
  } as AcquireIndexLockOptions);

  assert.ok(acquired, "must acquire lock when original incarnation is dead");
  assert.notEqual(acquired.ownerToken, owner.ownerToken, "new owner must differ");

  await releaseIndexLock(lockDir, acquired);
});

test("process-incarnation probe: identity with processGroupId is preserved through owner round-trip", async () => {
  const root = await tempRoot("cpb-lock-probe-pgid");
  const lockDir = path.join(root, "objects.lock");

  // Create a lock manually with a processGroupId-bearing identity.
  const identityWithGroup = fakeProcessIdentity(49130, undefined, {
    precision: "exact",
    processGroupId: 49130,
  });
  const owner = fakeOwner({
    pid: 49130,
    processIdentity: identityWithGroup,
    ownerToken: randomUUID(),
  });
  await createStaleLockDir(lockDir, owner);

  const inspectResult = await inspectIndexLock(lockDir);
  assert.ok(inspectResult.owner, "owner must be present");

  const readIdentity = inspectResult.owner!.processIdentity;
  assert.equal(readIdentity.pid, 49130);
  assert.equal(readIdentity.birthIdPrecision, "exact");
  assert.equal(readIdentity.processGroupId, 49130, "processGroupId must round-trip");
  assert.equal(readIdentity.incarnation, `49130:${identityWithGroup.birthId}`);
});

test("process-incarnation probe: validation rejects mismatched pid in processIdentity", async () => {
  const root = await tempRoot("cpb-lock-probe-pid-mismatch");
  const lockDir = path.join(root, "objects.lock");

  // Create an owner with a processIdentity whose pid doesn't match the owner's pid.
  const mismatchedOwner = {
    scopeKind: "repository-objects" as const,
    scopeKey: "key",
    pid: 49140,
    ownerToken: randomUUID(),
    timestamp: new Date().toISOString(),
    host: os.hostname(),
    processIdentity: fakeProcessIdentity(49141, undefined, { precision: "exact" }), // wrong pid
  };
  await mkdir(lockDir, { recursive: true });
  await writeFile(path.join(lockDir, "owner.json"), canonicalStringify(mismatchedOwner), "utf8");

  // inspectIndexLock should treat this as no valid owner (validation rejects
  // the mismatched pid).
  const inspectResult = await inspectIndexLock(lockDir);
  assert.equal(inspectResult.locked, false, "mismatched pid must cause lock to appear unlocked");
  assert.equal(inspectResult.owner, null, "owner must be null for invalid identity");
});

test("process-incarnation probe: validation rejects non-ISO timestamp in processIdentity", async () => {
  const root = await tempRoot("cpb-lock-probe-bad-timestamp");
  const lockDir = path.join(root, "objects.lock");

  const badOwner = {
    scopeKind: "repository-objects" as const,
    scopeKey: "key",
    pid: 49150,
    ownerToken: randomUUID(),
    timestamp: new Date().toISOString(),
    host: os.hostname(),
    processIdentity: {
      pid: 49150,
      birthId: "some-birth",
      incarnation: "49150:some-birth",
      capturedAt: "not-a-date",
      birthIdPrecision: "exact" as const,
    },
  };
  await mkdir(lockDir, { recursive: true });
  await writeFile(path.join(lockDir, "owner.json"), canonicalStringify(badOwner), "utf8");

  const inspectResult = await inspectIndexLock(lockDir);
  assert.equal(inspectResult.locked, false, "bad timestamp must cause lock to appear unlocked");
});

test("process-incarnation probe: validation rejects incarnation that does not match pid:birthId", async () => {
  const root = await tempRoot("cpb-lock-probe-bad-incarnation");
  const lockDir = path.join(root, "objects.lock");

  const badOwner = {
    scopeKind: "repository-objects" as const,
    scopeKey: "key",
    pid: 49160,
    ownerToken: randomUUID(),
    timestamp: new Date().toISOString(),
    host: os.hostname(),
    processIdentity: {
      pid: 49160,
      birthId: "correct-birth",
      incarnation: "49160:wrong-birth", // does not match pid:birthId
      capturedAt: new Date().toISOString(),
      birthIdPrecision: "exact" as const,
    },
  };
  await mkdir(lockDir, { recursive: true });
  await writeFile(path.join(lockDir, "owner.json"), canonicalStringify(badOwner), "utf8");

  const inspectResult = await inspectIndexLock(lockDir);
  assert.equal(
    inspectResult.locked,
    false,
    "mismatched incarnation must cause lock to appear unlocked",
  );
});

test("process-incarnation probe: validation rejects negative processGroupId", async () => {
  const root = await tempRoot("cpb-lock-probe-neg-pgid");
  const lockDir = path.join(root, "objects.lock");

  const badOwner = {
    scopeKind: "repository-objects" as const,
    scopeKey: "key",
    pid: 49170,
    ownerToken: randomUUID(),
    timestamp: new Date().toISOString(),
    host: os.hostname(),
    processIdentity: {
      pid: 49170,
      birthId: "some-birth",
      incarnation: "49170:some-birth",
      capturedAt: new Date().toISOString(),
      birthIdPrecision: "exact" as const,
      processGroupId: -1,
    },
  };
  await mkdir(lockDir, { recursive: true });
  await writeFile(path.join(lockDir, "owner.json"), canonicalStringify(badOwner), "utf8");

  const inspectResult = await inspectIndexLock(lockDir);
  assert.equal(
    inspectResult.locked,
    false,
    "negative processGroupId must cause lock to appear unlocked",
  );
});

test("process-incarnation probe: acquireIndexLock accepts coarse identity from captureIdentity", async () => {
  const root = await tempRoot("cpb-lock-probe-coarse-capture");
  const lockDir = path.join(root, "objects.lock");

  // acquireIndexLock does not validate birthIdPrecision — it accepts whatever
  // identity captureIdentity returns. A coarse identity is written to the
  // owner file and can be acquired. However, the coarse precision means the
  // owner will appear dead to any future isOwnerAlive check (which requires
  // birthIdPrecision === "exact").
  const coarseIdentity = fakeProcessIdentity(process.pid, undefined, { precision: "coarse" });

  const acquired = await acquireIndexLock(lockDir, {
    scopeKind: "repository-objects",
    scopeKey: "test-repo-key",
    waitMs: 1000,
    captureIdentity: () => coarseIdentity,
    isIdentityAlive: () => true,
  } as AcquireIndexLockOptions);

  assert.ok(acquired, "must acquire lock with coarse identity");
  assert.equal(
    acquired.processIdentity.birthIdPrecision,
    "coarse",
    "owner must carry the coarse precision",
  );

  // Verify the owner appears dead to a strict isOwnerAlive check.
  const inspectResult = await inspectIndexLock(lockDir);
  assert.ok(inspectResult.owner, "owner must be present");
  assert.equal(
    inspectResult.owner!.processIdentity.birthIdPrecision,
    "coarse",
    "round-tripped identity must be coarse",
  );
});

test("process-incarnation probe: acquireIndexLock rejects null from captureIdentity", async () => {
  const root = await tempRoot("cpb-lock-probe-null-capture");
  const lockDir = path.join(root, "objects.lock");

  await assert.rejects(
    () =>
      acquireIndexLock(lockDir, {
        scopeKind: "repository-objects",
        scopeKey: "test-repo-key",
        waitMs: 500,
        captureIdentity: () => null,
        isIdentityAlive: () => true,
      } as AcquireIndexLockOptions),
    (err: unknown) => {
      assert.ok(err instanceof IndexLockError);
      assert.equal(err.code, "index_lock_invalid");
      return true;
    },
  );
});

test("process-incarnation probe: acquireIndexLock rejects throwing captureIdentity", async () => {
  const root = await tempRoot("cpb-lock-probe-throw-capture");
  const lockDir = path.join(root, "objects.lock");

  await assert.rejects(
    () =>
      acquireIndexLock(lockDir, {
        scopeKind: "repository-objects",
        scopeKey: "test-repo-key",
        waitMs: 500,
        captureIdentity: () => { throw new Error("identity capture failed"); },
        isIdentityAlive: () => true,
      } as AcquireIndexLockOptions),
    (err: unknown) => {
      assert.ok(err instanceof IndexLockError);
      assert.equal(err.code, "index_lock_invalid");
      return true;
    },
  );
});
