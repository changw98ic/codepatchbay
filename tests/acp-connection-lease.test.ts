import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { captureProcessIdentity, type ProcessIdentity } from "../core/runtime/process-tree.js";
import { AcpPool } from "../server/services/acp/acp-pool.js";

function identity(pid: number, birthId: string): ProcessIdentity {
  return {
    pid,
    birthId,
    incarnation: `${pid}:${birthId}`,
    capturedAt: "2026-07-21T00:00:00.000Z",
    birthIdPrecision: "exact",
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-acp-connection-lease-"));
  const hubRoot = path.join(root, "hub");
  const leaseRoot = path.join(root, "leases");
  const leaseDir = path.join(leaseRoot, "providers", "acp-leases");
  await mkdir(leaseDir, { recursive: true });
  const pool = new AcpPool({ hubRoot, leaseRoot, cpbRoot: root, runner: async () => "ok" });
  return { root, leaseDir, pool };
}

async function writeLease(leaseDir: string, name: string, value: Record<string, unknown>) {
  const filePath = path.join(leaseDir, `${name}.json`);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

async function writeConnectionLock(
  lockDir: string,
  value: {
    ownerToken: string;
    generation: string;
    pid: number;
    processIdentity: ProcessIdentity | Record<string, unknown>;
  },
) {
  await mkdir(lockDir, { recursive: false });
  const ownerPath = path.join(lockDir, "owner.json");
  const ownerBase = {
    format: "cpb-acp-connection-lock/v1",
    binding: "bound",
    ownerToken: value.ownerToken,
    generation: value.generation,
    pid: value.pid,
    host: os.hostname(),
    acquiredAt: new Date().toISOString(),
    processIdentity: value.processIdentity,
  };
  const initial = await lstat(lockDir);
  await writeFile(ownerPath, `${JSON.stringify({
    ...ownerBase,
    identity: {
      dev: initial.dev,
      ino: initial.ino,
      size: initial.size,
      mtimeMs: initial.mtimeMs,
      ctimeMs: initial.ctimeMs,
      birthtimeMs: initial.birthtimeMs,
    },
  }, null, 2)}\n`, "utf8");
  const info = await lstat(lockDir);
  await writeFile(ownerPath, `${JSON.stringify({
    ...ownerBase,
    identity: {
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
      birthtimeMs: info.birthtimeMs,
    },
  }, null, 2)}\n`, "utf8");
}

async function readLockOwner(lockDir: string) {
  return JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")) as Record<string, unknown>;
}

function assertGenerationMatchesStat(
  generation: Record<string, unknown> | undefined,
  info: Awaited<ReturnType<typeof lstat>>,
) {
  assert.ok(generation);
  assert.equal(info.isFile(), true);
  assert.equal(info.isSymbolicLink(), false);
  for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs", "birthtimeMs"] as const) {
    assert.equal(generation[field], info[field], `generation ${field} must match lstat`);
  }
}

function assertConnectionLockSyncTarget(leaseDir: string, directory: string, phase: string) {
  if (phase === "release-isolation" || phase === "recover-isolation") {
    assert.equal(path.dirname(directory), leaseDir);
    assert.match(
      path.basename(directory),
      phase === "release-isolation" ? /^\.lock\.released-/ : /^\.lock\.stale-/,
    );
    return;
  }
  assert.equal(directory, leaseDir);
}

test("ACP connection lease status counts only current process incarnations", async () => {
  const { leaseDir, pool } = await fixture();
  const captured = captureProcessIdentity(process.pid, { strict: true });
  const processIdentity = captured ? { ...captured, birthIdPrecision: "exact" as const } : null;
  assert.ok(processIdentity);
  await writeLease(leaseDir, "live", {
    leaseId: "live",
    ownerToken: "live-token",
    generation: "live-generation",
    pid: process.pid,
    processIdentity,
    providerKey: "codex",
    acquiredAt: new Date().toISOString(),
  });

  assert.deepEqual(await pool.connectionLeaseStatus(), {
    total: 1,
    providers: { codex: 1 },
  });
});

test("ACP connection lease status removes only a dead exact lease generation", async () => {
  const { leaseDir, pool } = await fixture();
  const deadLease = await writeLease(leaseDir, "dead", {
    leaseId: "dead",
    ownerToken: "dead-token",
    generation: "dead-generation",
    pid: 999_999,
    processIdentity: identity(999_999, "dead"),
    providerKey: "codex",
    acquiredAt: new Date().toISOString(),
  });

  assert.deepEqual(await pool.connectionLeaseStatus(), { total: 0, providers: {} });
  await assert.rejects(readFile(deadLease, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("ACP connection lease status treats PID reuse as stale by process incarnation", async () => {
  const { leaseDir, pool } = await fixture();
  const reusedPidLease = await writeLease(leaseDir, "reused-pid", {
    leaseId: "reused-pid",
    ownerToken: "reused-token",
    generation: "reused-generation",
    pid: process.pid,
    processIdentity: identity(process.pid, "not-this-process"),
    providerKey: "codex",
    acquiredAt: new Date().toISOString(),
  });

  assert.deepEqual(await pool.connectionLeaseStatus(), { total: 0, providers: {} });
  await assert.rejects(readFile(reusedPidLease, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("ACP connection lease status fails closed on missing process identity", async () => {
  const { leaseDir, pool } = await fixture();
  await writeLease(leaseDir, "legacy", {
    leaseId: "legacy",
    ownerToken: "legacy-token",
    generation: "legacy-generation",
    pid: process.pid,
    providerKey: "codex",
    acquiredAt: new Date().toISOString(),
  });

  await assert.rejects(
    pool.connectionLeaseStatus(),
    (error: NodeJS.ErrnoException) => error.code === "ACP_POOL_STATE_UNVERIFIED",
  );
});

test("ACP connection lease status fails closed on persisted coarse process identity", async () => {
  const { leaseDir, pool } = await fixture();
  await writeLease(leaseDir, "coarse", {
    leaseId: "coarse",
    ownerToken: "coarse-token",
    generation: "coarse-generation",
    pid: process.pid,
    processIdentity: {
      ...identity(process.pid, "coarse"),
      birthIdPrecision: "coarse",
    },
    providerKey: "codex",
    acquiredAt: new Date().toISOString(),
  });

  await assert.rejects(
    pool.connectionLeaseStatus(),
    (error: NodeJS.ErrnoException) => error.code === "ACP_POOL_STATE_UNVERIFIED",
  );
});

test("ACP connection lease status fails closed on corrupt or symlinked lease files", async () => {
  const { root, leaseDir, pool } = await fixture();
  await writeFile(path.join(leaseDir, "corrupt.json"), "{\"leaseId\":\"corrupt\"\n", "utf8");
  await assert.rejects(
    pool.connectionLeaseStatus(),
    (error: NodeJS.ErrnoException) => error.code === "ACP_POOL_STATE_UNVERIFIED",
  );

  const symlinkRoot = path.join(root, "symlink");
  const symlinkLeaseDir = path.join(symlinkRoot, "providers", "acp-leases");
  await mkdir(symlinkLeaseDir, { recursive: true });
  const target = path.join(root, "outside.json");
  await writeFile(target, "{}\n", "utf8");
  await symlink(target, path.join(symlinkLeaseDir, "lease.json"));
  const symlinkPool = new AcpPool({ hubRoot: path.join(root, "hub2"), leaseRoot: symlinkRoot, cpbRoot: root });
  await assert.rejects(
    symlinkPool.connectionLeaseStatus(),
    (error: NodeJS.ErrnoException) => error.code === "ACP_POOL_STATE_UNSAFE",
  );
});

test("ACP connection lease status fails closed when a lease file grows during bounded read", async () => {
  const { root, leaseDir } = await fixture();
  const leasePath = await writeLease(leaseDir, "growing", {
    leaseId: "growing",
    ownerToken: "growing-token",
    generation: "growing-generation",
    providerKey: "codex",
    pid: process.pid,
    processIdentity: identity(process.pid, "growing"),
  });
  let grew = false;
  const growingPool = new AcpPool({
    hubRoot: path.join(root, "hub-growing"),
    leaseRoot: path.join(root, "leases"),
    cpbRoot: root,
    connectionLockFsHooks: {
      boundedRead: {
        afterChunk: async ({ filePath }) => {
          if (grew || filePath !== leasePath) return;
          grew = true;
          await writeFile(filePath, `${JSON.stringify({
            leaseId: "growing",
            ownerToken: "growing-token",
            generation: "growing-generation",
            providerKey: "codex",
            pid: process.pid,
            processIdentity: identity(process.pid, "growing"),
            padding: "x".repeat(1024 * 1024),
          })}\n`, "utf8");
        },
      },
    },
  });

  await assert.rejects(
    growingPool.connectionLeaseStatus(),
    (error: NodeJS.ErrnoException) => error.code === "ACP_POOL_STATE_UNVERIFIED",
  );
  assert.equal(grew, true);
});

test("ACP connection lease bounded-read hooks are scoped to each async lock", async () => {
  const first = await fixture();
  const second = await fixture();
  await writeLease(first.leaseDir, "first-live", {
    leaseId: "first-live",
    ownerToken: "first-token",
    generation: "first-generation",
    providerKey: "codex",
    pid: process.pid,
    processIdentity: captureProcessIdentity(process.pid, { strict: true }),
    acquiredAt: new Date().toISOString(),
  });
  await writeLease(second.leaseDir, "second-live", {
    leaseId: "second-live",
    ownerToken: "second-token",
    generation: "second-generation",
    providerKey: "codex",
    pid: process.pid,
    processIdentity: captureProcessIdentity(process.pid, { strict: true }),
    acquiredAt: new Date().toISOString(),
  });
  const seen: string[] = [];
  let releaseFirstRead: (() => void) | undefined;
  const firstReadGate = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
  let firstPaused = false;
  const firstPool = new AcpPool({
    hubRoot: path.join(first.root, "hub-scoped-hooks-first"),
    leaseRoot: path.join(first.root, "leases"),
    cpbRoot: first.root,
    connectionLockFsHooks: {
      boundedRead: {
        afterOpen: async ({ filePath }) => {
          seen.push(`first:${path.basename(filePath)}`);
          if (!firstPaused && filePath.endsWith("first-live.json")) {
            firstPaused = true;
            await firstReadGate;
          }
        },
      },
    },
  });
  const secondPool = new AcpPool({
    hubRoot: path.join(second.root, "hub-scoped-hooks-second"),
    leaseRoot: path.join(second.root, "leases"),
    cpbRoot: second.root,
    connectionLockFsHooks: {
      boundedRead: {
        afterOpen: ({ filePath }) => {
          seen.push(`second:${path.basename(filePath)}`);
        },
      },
    },
  });

  const firstStatus = firstPool.connectionLeaseStatus();
  while (!firstPaused) await new Promise((resolve) => setTimeout(resolve, 1));
  const secondStatus = secondPool.connectionLeaseStatus();
  releaseFirstRead?.();

  assert.deepEqual(await Promise.all([firstStatus, secondStatus]), [
    { total: 1, providers: { codex: 1 } },
    { total: 1, providers: { codex: 1 } },
  ]);
  assert.ok(seen.includes("first:first-live.json"));
  assert.ok(seen.includes("second:second-live.json"));
  assert.equal(
    seen.some((entry) => entry === "first:second-live.json" || entry === "second:first-live.json"),
    false,
  );
});

test("ACP connection lock owner fails closed when the owner path generation changes after read", async () => {
  const { root, leaseDir } = await fixture();
  const lockDir = path.join(leaseDir, ".lock");
  const ownerPath = path.join(lockDir, "owner.json");
  await writeConnectionLock(lockDir, {
    ownerToken: "dead-token",
    generation: "dead-generation",
    pid: 999_999,
    processIdentity: identity(999_999, "dead"),
  });
  let swapped = false;
  const pool = new AcpPool({
    hubRoot: path.join(root, "hub-owner-swap"),
    leaseRoot: path.join(root, "leases"),
    cpbRoot: root,
    connectionLockFsHooks: {
      boundedRead: {
        beforePathGenerationCheck: async ({ filePath }) => {
          if (swapped || filePath !== ownerPath) return;
          swapped = true;
          const replacement = path.join(lockDir, "owner-replacement.json");
          await writeFile(replacement, await readFile(filePath, "utf8"), "utf8");
          await rename(replacement, filePath);
        },
      },
    },
  });

  await assert.rejects(
    pool.connectionLeaseStatus(),
    (error: NodeJS.ErrnoException) => error.code === "ACP_POOL_STATE_UNVERIFIED",
  );
  assert.equal(swapped, true);
});

test("ACP connection lock acquisition retries when the canonical generation moves during owner read", async () => {
  const { root, leaseDir } = await fixture();
  const lockDir = path.join(leaseDir, ".lock");
  const ownerPath = path.join(lockDir, "owner.json");
  const movedDir = path.join(leaseDir, ".lock.concurrent-release");
  await writeConnectionLock(lockDir, {
    ownerToken: "moving-token",
    generation: "moving-generation",
    pid: 999_999,
    processIdentity: identity(999_999, "moving-dead-owner"),
  });
  let moved = false;
  const pool = new AcpPool({
    hubRoot: path.join(root, "hub-owner-move"),
    leaseRoot: path.join(root, "leases"),
    cpbRoot: root,
    connectionLockFsHooks: {
      boundedRead: {
        beforePathGenerationCheck: async ({ filePath }) => {
          if (moved || filePath !== ownerPath) return;
          moved = true;
          await rename(lockDir, movedDir);
        },
      },
    },
  });

  assert.deepEqual(await pool.connectionLeaseStatus(), { total: 0, providers: {} });
  assert.equal(moved, true);
  assert.equal((await readLockOwner(movedDir)).generation, "moving-generation");
  await assert.rejects(lstat(lockDir), { code: "ENOENT" });
});

test("ACP connection lock contenders wait for a pending owner generation to become fully bound", async () => {
  const { root, leaseDir } = await fixture();
  const ownerPath = path.join(leaseDir, ".lock", "owner.json");
  let releaseOwnerPublish: (() => void) | undefined;
  let ownerPublishObserved: (() => void) | undefined;
  let pendingReadObserved: (() => void) | undefined;
  const ownerPublishGate = new Promise<void>((resolve) => { releaseOwnerPublish = resolve; });
  const ownerPublished = new Promise<void>((resolve) => { ownerPublishObserved = resolve; });
  const pendingRead = new Promise<void>((resolve) => { pendingReadObserved = resolve; });
  let gateFirstOwner = true;
  const pool = new AcpPool({
    hubRoot: path.join(root, "hub-pending-owner"),
    leaseRoot: path.join(root, "leases"),
    cpbRoot: root,
    connectionLockFsHooks: {
      durableWriteFault: async ({ operation, stage }) => {
        if (!gateFirstOwner || operation !== "connection-owner" || stage !== "after-publish") return;
        ownerPublishObserved?.();
        await ownerPublishGate;
        gateFirstOwner = false;
      },
      boundedRead: {
        afterOpen: ({ filePath }) => {
          if (gateFirstOwner && filePath === ownerPath) pendingReadObserved?.();
        },
      },
    },
  });

  const first = pool.connectionLeaseStatus();
  await ownerPublished;
  const second = pool.connectionLeaseStatus();
  try {
    await pendingRead;
  } finally {
    releaseOwnerPublish?.();
  }
  assert.deepEqual(await Promise.all([first, second]), [
    { total: 0, providers: {} },
    { total: 0, providers: {} },
  ]);
  assert.equal(
    (await readdir(leaseDir)).filter((entry) => entry.startsWith(".lock.released-")).length,
    2,
  );
});

test("ACP connection lock release fails closed when its directory mutates after owner read", async () => {
  const { root, leaseDir } = await fixture();
  const lockDir = path.join(leaseDir, ".lock");
  let mutated = false;
  const pool = new AcpPool({
    hubRoot: path.join(root, "hub-release-directory-generation-race"),
    leaseRoot: path.join(root, "leases"),
    cpbRoot: root,
    connectionLockFsHooks: {
      beforeMove: async ({ phase }) => {
        if (mutated || phase !== "release") return;
        mutated = true;
        await writeFile(path.join(lockDir, "concurrent-evidence"), "preserve me\n", "utf8");
      },
    },
  });

  await assert.rejects(
    pool.connectionLeaseStatus(),
    (error: NodeJS.ErrnoException) => error.code === "ACP_POOL_STATE_UNVERIFIED",
  );
  assert.equal(mutated, true);
  assert.equal(await readFile(path.join(lockDir, "concurrent-evidence"), "utf8"), "preserve me\n");
  assert.equal(typeof (await readLockOwner(lockDir)).ownerToken, "string");
  assert.deepEqual(
    (await readdir(leaseDir)).filter((entry) => entry.startsWith(".lock.released-")),
    [],
  );
});

test("ACP connection lock recovery fails closed when persisted owner mutates after owner read", async () => {
  const { root, leaseDir } = await fixture();
  const lockDir = path.join(leaseDir, ".lock");
  const ownerPath = path.join(lockDir, "owner.json");
  await writeConnectionLock(lockDir, {
    ownerToken: "dead-token",
    generation: "dead-generation",
    pid: 999_999,
    processIdentity: identity(999_999, "dead"),
  });
  let mutated = false;
  const pool = new AcpPool({
    hubRoot: path.join(root, "hub-recovery-owner-race"),
    leaseRoot: path.join(root, "leases"),
    cpbRoot: root,
    connectionLockFsHooks: {
      beforeMove: async ({ phase }) => {
        if (mutated || phase !== "recover") return;
        mutated = true;
        const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
        owner.acquiredAt = "2026-07-21T00:00:02.000Z";
        await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
      },
    },
  });

  await assert.rejects(
    pool.connectionLeaseStatus(),
    (error: NodeJS.ErrnoException) => error.code === "ACP_POOL_STATE_UNVERIFIED",
  );
  assert.equal(mutated, true);
  assert.equal((await readLockOwner(lockDir)).acquiredAt, "2026-07-21T00:00:02.000Z");
  assert.deepEqual(
    (await readdir(leaseDir)).filter((entry) => entry.startsWith(".lock.stale-")),
    [],
  );
});

test("ACP connection lease status fails closed on a symlinked lease directory", async () => {
  const { root } = await fixture();
  const outside = path.join(root, "outside-leases");
  await mkdir(outside, { recursive: true });
  const symlinkRoot = path.join(root, "symlink-root");
  await mkdir(path.join(symlinkRoot, "providers"), { recursive: true });
  await symlink(outside, path.join(symlinkRoot, "providers", "acp-leases"));
  const pool = new AcpPool({ hubRoot: path.join(root, "hub-symlink-dir"), leaseRoot: symlinkRoot, cpbRoot: root });

  await assert.rejects(
    pool.connectionLeaseStatus(),
    (error: NodeJS.ErrnoException) => error.code === "ACP_POOL_STATE_UNSAFE",
  );
});

test("ACP connection lock recovery preserves quarantine when owner validation fails", async () => {
  const { root, leaseDir } = await fixture();
  const lockDir = path.join(leaseDir, ".lock");
  await writeConnectionLock(lockDir, {
    ownerToken: "dead-token",
    generation: "dead-generation",
    pid: 999_999,
    processIdentity: identity(999_999, "dead"),
  });

  const pool = new AcpPool({
    hubRoot: path.join(root, "hub-recovery-validation"),
    leaseRoot: path.join(root, "leases"),
    cpbRoot: root,
    connectionLockFsHooks: {
      afterMove: async ({ phase, movedDir }) => {
        if (phase !== "recover") return;
        const ownerPath = path.join(movedDir, "owner.json");
        const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
        owner.generation = "changed-after-move";
        await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
      },
    },
  });

  let failure: unknown;
  await pool.connectionLeaseStatus().catch((error: unknown) => { failure = error; });

  const preserved = failure as Error & {
    code?: string;
    committed?: boolean;
    renameCommitted?: boolean;
    removalCommitted?: boolean;
    quarantinePreserved?: boolean;
    successorPreserved?: boolean;
    residualPath?: string;
    recoveryPaths?: { canonical: string; moved: string };
  };
  assert.equal(preserved.code, "ACP_POOL_STATE_UNVERIFIED");
  assert.equal(preserved.committed, true);
  assert.equal(preserved.renameCommitted, true);
  assert.equal(preserved.removalCommitted, false);
  assert.equal(preserved.quarantinePreserved, true);
  assert.equal(preserved.successorPreserved, false);
  assert.equal(preserved.recoveryPaths?.canonical, lockDir);
  assert.equal(preserved.recoveryPaths?.moved, preserved.residualPath);
  assert.equal((await readLockOwner(preserved.residualPath!)).generation, "changed-after-move");
  await assert.rejects(readFile(path.join(lockDir, "owner.json")), { code: "ENOENT" });
  assert.deepEqual(
    (await readdir(leaseDir)).filter((entry) => entry.startsWith(".lock.stale-")),
    [path.basename(preserved.residualPath!)],
  );
});

test("ACP connection lock recovery preserves quarantine when exact process metadata changes", async () => {
  const { root, leaseDir } = await fixture();
  const lockDir = path.join(leaseDir, ".lock");
  await writeConnectionLock(lockDir, {
    ownerToken: "dead-token",
    generation: "dead-generation",
    pid: 999_999,
    processIdentity: identity(999_999, "dead"),
  });

  const changedCapturedAt = "2026-07-21T00:00:01.000Z";
  const pool = new AcpPool({
    hubRoot: path.join(root, "hub-recovery-process-metadata"),
    leaseRoot: path.join(root, "leases"),
    cpbRoot: root,
    connectionLockFsHooks: {
      afterMove: async ({ phase, movedDir }) => {
        if (phase !== "recover") return;
        const ownerPath = path.join(movedDir, "owner.json");
        const owner = JSON.parse(await readFile(ownerPath, "utf8")) as {
          processIdentity: Record<string, unknown>;
        };
        owner.processIdentity.capturedAt = changedCapturedAt;
        await writeFile(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
      },
    },
  });

  let failure: unknown;
  await pool.connectionLeaseStatus().catch((error: unknown) => { failure = error; });

  const preserved = failure as Error & {
    code?: string;
    quarantinePreserved?: boolean;
    residualPath?: string;
    recoveryPaths?: { canonical: string; moved: string };
  };
  assert.equal(preserved.code, "ACP_POOL_STATE_UNVERIFIED");
  assert.equal(preserved.quarantinePreserved, true);
  assert.equal(preserved.recoveryPaths?.canonical, lockDir);
  assert.equal(preserved.recoveryPaths?.moved, preserved.residualPath);
  const movedOwner = await readLockOwner(preserved.residualPath!);
  assert.equal(
    (movedOwner.processIdentity as Record<string, unknown>).capturedAt,
    changedCapturedAt,
  );
  await assert.rejects(lstat(lockDir), { code: "ENOENT" });
});

test("ACP connection lock recovery preserves replacement quarantine when directory inode validation fails", async () => {
  const { root, leaseDir } = await fixture();
  const lockDir = path.join(leaseDir, ".lock");
  await writeConnectionLock(lockDir, {
    ownerToken: "dead-token",
    generation: "dead-generation",
    pid: 999_999,
    processIdentity: identity(999_999, "dead"),
  });

  const pool = new AcpPool({
    hubRoot: path.join(root, "hub-recovery-inode"),
    leaseRoot: path.join(root, "leases"),
    cpbRoot: root,
    connectionLockFsHooks: {
      afterMove: async ({ phase, movedDir }) => {
        if (phase !== "recover") return;
        await rm(movedDir, { recursive: true, force: false });
        await writeConnectionLock(movedDir, {
          ownerToken: "dead-token",
          generation: "dead-generation",
          pid: 999_999,
          processIdentity: identity(999_999, "dead"),
        });
      },
    },
  });

  let failure: unknown;
  await pool.connectionLeaseStatus().catch((error: unknown) => { failure = error; });

  const preserved = failure as Error & {
    code?: string;
    quarantinePreserved?: boolean;
    successorPreserved?: boolean;
    residualPath?: string;
    recoveryPaths?: { canonical: string; moved: string };
  };
  assert.equal(preserved.code, "ACP_POOL_STATE_UNVERIFIED");
  assert.equal(preserved.quarantinePreserved, true);
  assert.equal(preserved.successorPreserved, false);
  assert.equal(preserved.recoveryPaths?.canonical, lockDir);
  assert.equal(preserved.recoveryPaths?.moved, preserved.residualPath);
  assert.equal((await readLockOwner(preserved.residualPath!)).generation, "dead-generation");
  await assert.rejects(readFile(path.join(lockDir, "owner.json")), { code: "ENOENT" });
  assert.deepEqual(
    (await readdir(leaseDir)).filter((entry) => entry.startsWith(".lock.stale-")),
    [path.basename(preserved.residualPath!)],
  );
});

test("ACP incomplete connection lock recovery preserves a replacement quarantine generation", async () => {
  const { root, leaseDir } = await fixture();
  const lockDir = path.join(leaseDir, ".lock");
  await mkdir(lockDir);
  await utimes(lockDir, new Date(0), new Date(0));
  const pool = new AcpPool({
    hubRoot: path.join(root, "hub-incomplete-generation"),
    leaseRoot: path.join(root, "leases"),
    cpbRoot: root,
    connectionLockFsHooks: {
      afterMove: async ({ phase, movedDir }) => {
        if (phase !== "recover") return;
        await rm(movedDir, { recursive: true, force: false });
        await mkdir(movedDir);
      },
    },
  });

  let failure: unknown;
  await pool.connectionLeaseStatus().catch((error: unknown) => { failure = error; });

  const preserved = failure as Error & {
    code?: string;
    quarantinePreserved?: boolean;
    residualPath?: string;
    recoveryPaths?: { canonical: string; moved: string };
  };
  assert.equal(preserved.code, "ACP_POOL_STATE_UNVERIFIED");
  assert.equal(preserved.quarantinePreserved, true);
  assert.equal(preserved.recoveryPaths?.canonical, lockDir);
  assert.equal(preserved.recoveryPaths?.moved, preserved.residualPath);
  assert.deepEqual(await readdir(preserved.residualPath!), []);
  await assert.rejects(lstat(lockDir), { code: "ENOENT" });
});

test("ACP connection lock release preserves a successor when cleanup fails", async () => {
  const { root, leaseDir } = await fixture();
  const lockDir = path.join(leaseDir, ".lock");
  const successorGeneration = "successor-generation";
  const current = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(current);
  const processIdentity = { ...current, birthIdPrecision: "exact" as const };
  const pool = new AcpPool({
    hubRoot: path.join(root, "hub-release-successor"),
    leaseRoot: path.join(root, "leases"),
    cpbRoot: root,
    connectionLockFsHooks: {
      afterMove: async ({ phase }) => {
        if (phase !== "release") return;
        await writeConnectionLock(lockDir, {
          ownerToken: "successor-token",
          generation: successorGeneration,
          pid: process.pid,
          processIdentity,
        });
        throw Object.assign(new Error("synthetic release validation failure"), { code: "EIO" });
      },
    },
  });

  await assert.rejects(
    pool.connectionLeaseStatus(),
    (error: Error & {
      quarantinePreserved?: boolean;
      successorPreserved?: boolean;
      residualPath?: string;
      successorGeneration?: string;
    }) => {
      assert.equal((error as NodeJS.ErrnoException).code, "ACP_POOL_STATE_UNVERIFIED");
      assert.equal(error.quarantinePreserved, true);
      assert.equal(error.successorPreserved, true);
      assert.equal(error.successorGeneration, successorGeneration);
      assert.ok(error.residualPath?.includes(".lock.released-"));
      return true;
    },
  );
  assert.equal((await readLockOwner(lockDir)).generation, successorGeneration);
  assert.equal((await readdir(leaseDir)).filter((entry) => entry.startsWith(".lock.released-")).length, 1);
});

test("ACP connection lock release preserves an ownerless successor directory when cleanup fails", async () => {
  const { root, leaseDir } = await fixture();
  const lockDir = path.join(leaseDir, ".lock");
  const pool = new AcpPool({
    hubRoot: path.join(root, "hub-release-ownerless-successor"),
    leaseRoot: path.join(root, "leases"),
    cpbRoot: root,
    connectionLockFsHooks: {
      afterMove: async ({ phase }) => {
        if (phase !== "release") return;
        await mkdir(lockDir);
        throw Object.assign(new Error("synthetic release validation failure"), { code: "EIO" });
      },
    },
  });

  await assert.rejects(
    pool.connectionLeaseStatus(),
    (error: Error & {
      quarantinePreserved?: boolean;
      successorPreserved?: boolean;
      residualPath?: string;
      successorGeneration?: string;
    }) => {
      assert.equal((error as NodeJS.ErrnoException).code, "ACP_POOL_STATE_UNVERIFIED");
      assert.equal(error.quarantinePreserved, true);
      assert.equal(error.successorPreserved, true);
      assert.equal(error.successorGeneration, undefined);
      assert.ok(error.residualPath?.includes(".lock.released-"));
      return true;
    },
  );
  assert.deepEqual(await readdir(lockDir), []);
  assert.equal((await readdir(leaseDir)).filter((entry) => entry.startsWith(".lock.released-")).length, 1);
});

test("ACP connection lock release preserves the pinned predecessor evidence when a successor acquires", async () => {
  const { root, leaseDir } = await fixture();
  const lockDir = path.join(leaseDir, ".lock");
  const current = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(current);
  const successorGeneration = "concurrent-successor";
  const pool = new AcpPool({
    hubRoot: path.join(root, "hub-release-concurrent-successor"),
    leaseRoot: path.join(root, "leases"),
    cpbRoot: root,
    connectionLockFsHooks: {
      afterMove: async ({ phase }) => {
        if (phase !== "release") return;
        await writeConnectionLock(lockDir, {
          ownerToken: "concurrent-successor-token",
          generation: successorGeneration,
          pid: process.pid,
          processIdentity: { ...current, birthIdPrecision: "exact" },
        });
      },
    },
  });

  assert.deepEqual(await pool.connectionLeaseStatus(), { total: 0, providers: {} });
  assert.equal((await readLockOwner(lockDir)).generation, successorGeneration);
  const released = (await readdir(leaseDir)).filter((entry) => entry.startsWith(".lock.released-"));
  assert.equal(released.length, 1);
  assert.equal(typeof (await readLockOwner(path.join(leaseDir, released[0]))).ownerToken, "string");
});

test("ACP connection lock owner publish reports committed ambiguity for unsupported directory fsync", async () => {
  for (const syncCode of ["EINVAL", "EISDIR"] as const) {
    const { root, leaseDir } = await fixture();
    const failureCause = Object.assign(
      new Error(`synthetic ${syncCode} after owner publish`),
      { code: syncCode },
    );
    const pool = new AcpPool({
      hubRoot: path.join(root, `hub-owner-publish-${syncCode.toLowerCase()}`),
      leaseRoot: path.join(root, "leases"),
      cpbRoot: root,
      connectionLockFsHooks: {
        syncDirectory: (directory, phase) => {
          assertConnectionLockSyncTarget(leaseDir, directory, phase);
          if (phase === "acquire-publish") throw failureCause;
        },
      },
    });

    await assert.rejects(
      pool.connectionLeaseStatus(),
      (error: Error & {
        code?: string;
        committed?: boolean;
        phase?: string;
        path?: string;
        committedPath?: string;
        recoveryPaths?: { committed: string; parent: string };
      }) => {
        assert.equal(error.code, "ACP_DURABLE_JSON_COMMITTED_DURABILITY_AMBIGUOUS");
        assert.equal(error.cause, failureCause);
        assert.equal(error.committed, true);
        assert.equal(error.phase, "connection-owner-publish");
        assert.equal(error.committedPath, path.join(leaseDir, ".lock", "owner.json"));
        assert.equal(error.path, error.committedPath);
        assert.equal(error.recoveryPaths?.committed, error.committedPath);
        assert.equal(error.recoveryPaths?.parent, path.join(leaseDir, ".lock"));
        return true;
      },
    );
    assert.equal(typeof (await readLockOwner(path.join(leaseDir, ".lock"))).ownerToken, "string");
  }
});

test("ACP connection lease publish reports committed state after rename fault", async () => {
  const { root, leaseDir } = await fixture();
  const failureCause = Object.assign(new Error("synthetic lease publish durability failure"), { code: "ENOTSUP" });
  const pool = new AcpPool({
    hubRoot: path.join(root, "hub-lease-publish"),
    leaseRoot: path.join(root, "leases"),
    cpbRoot: root,
    runner: async () => "unused",
    connectionLockFsHooks: {
      durableWriteFault: ({ operation, stage }) => {
        if (operation === "connection-lease" && stage === "after-publish") throw failureCause;
      },
    },
  });

  await assert.rejects(
    pool.execute("codex", "prompt", process.cwd(), 0, {
      bypass: true,
      providerKey: "codex",
    }),
    (error: Error & {
      code?: string;
      committed?: boolean;
      phase?: string;
      committedPath?: string;
      recoveryPaths?: { committed: string; parent: string };
    }) => {
      assert.equal(error.code, "ACP_DURABLE_JSON_COMMITTED_DURABILITY_AMBIGUOUS");
      assert.equal(error.cause, failureCause);
      assert.equal(error.committed, true);
      assert.equal(error.phase, "connection-lease-publish");
      assert.equal(error.recoveryPaths?.committed, error.committedPath);
      assert.equal(error.recoveryPaths?.parent, leaseDir);
      return true;
    },
  );
  const leaseFiles = (await readdir(leaseDir)).filter((entry) => entry.endsWith(".json"));
  assert.equal(leaseFiles.length, 1);
  assert.equal(typeof JSON.parse(await readFile(path.join(leaseDir, leaseFiles[0]), "utf8")).ownerToken, "string");
});

test("ACP durable owner write aggregates primary, close, and temp retirement failures", async () => {
  const { root, leaseDir } = await fixture();
  const primaryError = Object.assign(new Error("synthetic owner write failure"), { code: "EWRITE" });
  const closeError = new Error("synthetic fallback close failure");
  const cleanupError = new Error("synthetic temp retirement failure");
  const pool = new AcpPool({
    hubRoot: path.join(root, "hub-owner-write-aggregate"),
    leaseRoot: path.join(root, "leases"),
    cpbRoot: root,
    connectionLockFsHooks: {
      durableWriteFault: ({ operation, stage }) => {
        if (operation !== "connection-owner") return;
        if (stage === "after-open") throw primaryError;
        if (stage === "after-fallback-close") throw closeError;
        if (stage === "before-temp-cleanup") throw cleanupError;
      },
    },
  });

  let preserved: (AggregateError & {
    tempPath?: string;
    tempEvidencePath?: string;
    tempAuthorityPreserved?: boolean;
    tempAuthorityVerified?: boolean;
    evidenceIdentity?: Record<string, unknown>;
    recoveryPaths?: { target: string; evidence?: string; parent: string };
  }) | null = null;
  await assert.rejects(
    pool.connectionLeaseStatus(),
    (error: Error & {
      code?: string;
      committed?: boolean;
      tempPath?: string;
      tempEvidencePath?: string;
      tempAuthorityPreserved?: boolean;
      tempAuthorityVerified?: boolean;
      evidenceIdentity?: Record<string, unknown>;
      recoveryPaths?: { target: string; evidence?: string; parent: string };
      primaryError?: unknown;
      closeErrors?: unknown[];
      cleanupError?: unknown;
    }) => {
      assert.ok(error instanceof AggregateError);
      const aggregate = error as AggregateError & {
        code?: string;
        primaryCode?: string | null;
        committed?: boolean;
        tempPath?: string;
        tempEvidencePath?: string;
        tempAuthorityPreserved?: boolean;
        tempAuthorityVerified?: boolean;
        evidenceIdentity?: Record<string, unknown>;
        recoveryPaths?: { target: string; evidence?: string; parent: string };
        primaryError?: unknown;
        closeErrors?: unknown[];
        cleanupError?: unknown;
      };
      assert.equal(aggregate.code, "ACP_DURABLE_JSON_WRITE_FAILED");
      assert.equal(aggregate.primaryCode, "EWRITE");
      assert.equal(aggregate.committed, false);
      assert.equal(aggregate.primaryError, primaryError);
      assert.deepEqual(aggregate.closeErrors, [closeError]);
      assert.equal(aggregate.cleanupError, cleanupError);
      assert.deepEqual(aggregate.errors, [primaryError, closeError, cleanupError]);
      assert.equal(aggregate.tempAuthorityPreserved, true);
      assert.equal(aggregate.tempAuthorityVerified, true);
      assert.ok(aggregate.tempEvidencePath?.includes(".tmp-"));
      assert.ok(aggregate.tempEvidencePath?.includes(".failed-"));
      assert.equal(aggregate.recoveryPaths?.evidence, aggregate.tempEvidencePath);
      assert.equal(aggregate.recoveryPaths?.target, path.join(leaseDir, ".lock", "owner.json"));
      preserved = aggregate;
      return true;
    },
  );
  assert.ok(preserved?.tempEvidencePath);
  assertGenerationMatchesStat(preserved.evidenceIdentity, await lstat(preserved.tempEvidencePath));
  await assert.rejects(lstat(preserved.tempPath!), { code: "ENOENT" });
});

test("ACP durable write preserves a successor replacing a validated temp pathname", async () => {
  const { root, leaseDir } = await fixture();
  const primaryError = Object.assign(new Error("synthetic owner write failure"), { code: "EWRITE" });
  let successorPath = "";
  let successorInjected = false;
  const pool = new AcpPool({
    hubRoot: path.join(root, "hub-owner-write-successor"),
    leaseRoot: path.join(root, "leases"),
    cpbRoot: root,
    connectionLockFsHooks: {
      durableWriteFault: (async ({ operation, stage, tempPath }: {
        operation: string;
        stage: string;
        tempPath: string;
      }) => {
        if (operation !== "connection-owner") return;
        if (stage === "after-open") throw primaryError;
        if (stage !== "after-temp-validation") return;
        const successorTemp = `${tempPath}.successor`;
        await writeFile(successorTemp, `${JSON.stringify({ successorMarker: true })}\n`, "utf8");
        await rename(successorTemp, tempPath);
        successorPath = tempPath;
        successorInjected = true;
      }) as never,
    },
  });

  let preserved: {
    code?: string;
    residualPath?: string;
    residualIdentity?: Record<string, unknown>;
    tempAuthorityPreserved?: boolean;
    tempAuthorityVerified?: boolean;
  } | null = null;
  await assert.rejects(
    pool.connectionLeaseStatus(),
    (error: Error & {
      code?: string;
      residualPath?: string;
      residualIdentity?: Record<string, unknown>;
      tempAuthorityPreserved?: boolean;
      tempAuthorityVerified?: boolean;
    }) => {
      assert.equal(error.code, "ACP_DURABLE_JSON_WRITE_FAILED");
      assert.equal(error.residualPath, successorPath);
      assert.equal(error.tempAuthorityPreserved, false);
      assert.equal(error.tempAuthorityVerified, false);
      preserved = error;
      return true;
    },
  );

  assert.equal(successorInjected, true);
  assert.ok(preserved?.residualPath);
  assertGenerationMatchesStat(preserved.residualIdentity, await lstat(preserved.residualPath));
  assert.equal(JSON.parse(await readFile(preserved.residualPath, "utf8")).successorMarker, true);
  assert.equal(path.dirname(preserved.residualPath), path.join(leaseDir, ".lock"));
});

test("ACP connection lock release rename reports committed durability ambiguity", async () => {
  const { root, leaseDir } = await fixture();
  const pool = new AcpPool({
    hubRoot: path.join(root, "hub-release-rename-fsync"),
    leaseRoot: path.join(root, "leases"),
    cpbRoot: root,
    connectionLockFsHooks: {
      syncDirectory: (directory, phase) => {
        assertConnectionLockSyncTarget(leaseDir, directory, phase);
        if (phase === "release-rename") {
          throw Object.assign(new Error("directory fsync unsupported after lock rename"), { code: "EINVAL" });
        }
      },
    },
  });

  await assert.rejects(
    pool.connectionLeaseStatus(),
    (error: Error & {
      code?: string;
      committed?: boolean;
      renameCommitted?: boolean;
      removalCommitted?: boolean;
      phase?: string;
      committedPath?: string;
      recoveryPaths?: { canonical: string; moved: string };
    }) => {
      assert.equal(error.code, "ACP_CONNECTION_LOCK_RENAME_COMMITTED_DURABILITY_AMBIGUOUS");
      assert.equal(error.committed, true);
      assert.equal(error.renameCommitted, true);
      assert.equal(error.removalCommitted, false);
      assert.equal((error as { canonicalRemovalCommitted?: boolean }).canonicalRemovalCommitted, true);
      assert.equal(error.phase, "release-rename");
      assert.equal((error as { durabilityVerified?: boolean }).durabilityVerified, false);
      assert.equal((error as { isolationDirectoryDurable?: boolean }).isolationDirectoryDurable, true);
      assert.equal((error as { parentDirectoryDurable?: boolean }).parentDirectoryDurable, false);
      assert.equal(error.recoveryPaths?.canonical, path.join(leaseDir, ".lock"));
      assert.equal(error.recoveryPaths?.moved, error.committedPath);
      return true;
    },
  );
  const released = (await readdir(leaseDir)).filter((entry) => entry.startsWith(".lock.released-"));
  assert.equal(released.length, 1);
  assert.equal(typeof (await readLockOwner(path.join(leaseDir, released[0]))).ownerToken, "string");
});

test("ACP connection lock release aggregates post-rename sync and close failures", async () => {
  const { root, leaseDir } = await fixture();
  const syncError = Object.assign(new Error("synthetic released-directory fsync failure"), { code: "EIO" });
  const closeError = Object.assign(new Error("synthetic released-directory close failure"), { code: "ECLOSE" });
  const pool = new AcpPool({
    hubRoot: path.join(root, "hub-release-sync-close"),
    leaseRoot: path.join(root, "leases"),
    cpbRoot: root,
    connectionLockFsHooks: {
      directorySyncFault: ({ phase, stage }) => {
        if (phase !== "release-isolation") return;
        if (stage === "before-sync") throw syncError;
        if (stage === "after-primary-close") throw closeError;
      },
    },
  });

  await assert.rejects(
    pool.connectionLeaseStatus(),
    (error: Error & {
      code?: string;
      committed?: boolean;
      renameCommitted?: boolean;
      canonicalRemovalCommitted?: boolean;
      durabilityVerified?: boolean;
      isolationDirectoryDurable?: boolean;
      parentDirectoryDurable?: boolean;
      phase?: string;
      committedPath?: string;
      residualPath?: string;
    }) => {
      assert.equal(error.code, "ACP_CONNECTION_LOCK_RENAME_COMMITTED_DURABILITY_AMBIGUOUS");
      assert.equal(error.committed, true);
      assert.equal(error.renameCommitted, true);
      assert.equal(error.canonicalRemovalCommitted, true);
      assert.equal(error.durabilityVerified, false);
      assert.equal(error.isolationDirectoryDurable, false);
      assert.equal(error.parentDirectoryDurable, true);
      assert.equal(error.phase, "release-isolation");
      assert.equal(error.committedPath, error.residualPath);
      assert.ok(error.cause instanceof AggregateError);
      const directoryFailure = error.cause as AggregateError & {
        primaryError?: unknown;
        closeErrors?: unknown[];
      };
      assert.deepEqual(directoryFailure.errors, [syncError, closeError]);
      assert.equal(directoryFailure.primaryError, syncError);
      assert.deepEqual(directoryFailure.closeErrors, [closeError]);
      return true;
    },
  );
  const released = (await readdir(leaseDir)).filter((entry) => entry.startsWith(".lock.released-"));
  assert.equal(released.length, 1);
  assert.equal(typeof (await readLockOwner(path.join(leaseDir, released[0]))).ownerToken, "string");
});

test("ACP connection lock release preserves a concurrent successor while syncing its parent", async () => {
  const { root, leaseDir } = await fixture();
  const lockDir = path.join(leaseDir, ".lock");
  const current = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(current);
  const successorGeneration = "directory-sync-successor";
  let successorInjected = false;
  const pool = new AcpPool({
    hubRoot: path.join(root, "hub-release-parent-successor"),
    leaseRoot: path.join(root, "leases"),
    cpbRoot: root,
    connectionLockFsHooks: {
      directorySyncFault: async ({ phase, stage }) => {
        if (successorInjected || phase !== "release-rename" || stage !== "after-open") return;
        successorInjected = true;
        await writeConnectionLock(lockDir, {
          ownerToken: "directory-sync-successor-token",
          generation: successorGeneration,
          pid: process.pid,
          processIdentity: { ...current, birthIdPrecision: "exact" },
        });
      },
    },
  });

  assert.deepEqual(await pool.connectionLeaseStatus(), { total: 0, providers: {} });
  assert.equal(successorInjected, true);
  assert.equal((await readLockOwner(lockDir)).generation, successorGeneration);
  const released = (await readdir(leaseDir)).filter((entry) => entry.startsWith(".lock.released-"));
  assert.equal(released.length, 1);
  assert.equal(typeof (await readLockOwner(path.join(leaseDir, released[0]))).ownerToken, "string");
});

test("ACP connection lock aggregates a callback failure with committed release ambiguity", async () => {
  const { root, leaseDir } = await fixture();
  const malformedLease = path.join(leaseDir, "malformed.json");
  await writeFile(malformedLease, "{\"leaseId\":\n", "utf8");
  const releaseSyncError = Object.assign(new Error("synthetic parent sync failure during release"), { code: "EIO" });
  const pool = new AcpPool({
    hubRoot: path.join(root, "hub-primary-release-aggregate"),
    leaseRoot: path.join(root, "leases"),
    cpbRoot: root,
    connectionLockFsHooks: {
      directorySyncFault: ({ phase, stage }) => {
        if (phase === "release-rename" && stage === "before-sync") throw releaseSyncError;
      },
    },
  });

  await assert.rejects(
    pool.connectionLeaseStatus(),
    (error: AggregateError & {
      code?: string;
      primaryCode?: string | null;
      releaseCode?: string | null;
      primaryError?: unknown;
      releaseError?: unknown;
      committed?: boolean;
      renameCommitted?: boolean;
      recoveryPaths?: { canonical: string; moved: string };
    }) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.code, "ACP_CONNECTION_LOCK_OPERATION_AND_RELEASE_FAILED");
      assert.equal(error.primaryCode, "ACP_POOL_STATE_UNVERIFIED");
      assert.equal(error.releaseCode, "ACP_CONNECTION_LOCK_RENAME_COMMITTED_DURABILITY_AMBIGUOUS");
      assert.deepEqual(error.errors, [error.primaryError, error.releaseError]);
      assert.equal(error.committed, true);
      assert.equal(error.renameCommitted, true);
      assert.equal(error.recoveryPaths?.canonical, path.join(leaseDir, ".lock"));
      assert.match((error.primaryError as Error).message, /not valid JSON/);
      assert.equal((error.releaseError as Error).cause, releaseSyncError);
      return true;
    },
  );
  assert.equal(await readFile(malformedLease, "utf8"), "{\"leaseId\":\n");
  assert.equal((await readdir(leaseDir)).filter((entry) => entry.startsWith(".lock.released-")).length, 1);
});

test("ACP connection lock parent fsync remains stable under finite concurrent reuse", async () => {
  const { leaseDir, pool } = await fixture();
  const results = await Promise.all(
    Array.from({ length: 12 }, () => pool.connectionLeaseStatus()),
  );
  assert.deepEqual(results, Array.from({ length: 12 }, () => ({ total: 0, providers: {} })));
  assert.equal((await readdir(leaseDir)).filter((entry) => entry.startsWith(".lock.released-")).length, 12);
  await assert.rejects(lstat(path.join(leaseDir, ".lock")), { code: "ENOENT" });
});

test("ACP connection lock release preserves durable evidence without a path-based remove phase", async () => {
  const { root, leaseDir } = await fixture();
  const phases: string[] = [];
  const pool = new AcpPool({
    hubRoot: path.join(root, "hub-release-fsync"),
    leaseRoot: path.join(root, "leases"),
    cpbRoot: root,
    connectionLockFsHooks: {
      syncDirectory: (directory, phase) => {
        assertConnectionLockSyncTarget(leaseDir, directory, phase);
        phases.push(phase);
      },
    },
  });

  assert.deepEqual(await pool.connectionLeaseStatus(), { total: 0, providers: {} });
  assert.equal(phases.includes("release-isolation"), true);
  assert.equal(phases.includes("release-rename"), true);
  assert.equal(phases.includes("release-remove"), false);
  const released = (await readdir(leaseDir)).filter((entry) => entry.startsWith(".lock.released-"));
  assert.equal(released.length, 1);
  assert.equal(typeof (await readLockOwner(path.join(leaseDir, released[0]))).ownerToken, "string");
});

test("ACP connection lock recovery preserves stale evidence without a path-based remove phase", async () => {
  const { root, leaseDir } = await fixture();
  const lockDir = path.join(leaseDir, ".lock");
  await writeConnectionLock(lockDir, {
    ownerToken: "dead-token",
    generation: "dead-generation",
    pid: 999_999,
    processIdentity: identity(999_999, "dead"),
  });
  const phases: string[] = [];
  const pool = new AcpPool({
    hubRoot: path.join(root, "hub-recovery-fsync"),
    leaseRoot: path.join(root, "leases"),
    cpbRoot: root,
    connectionLockFsHooks: {
      syncDirectory: (directory, phase) => {
        assertConnectionLockSyncTarget(leaseDir, directory, phase);
        phases.push(phase);
      },
    },
  });

  assert.deepEqual(await pool.connectionLeaseStatus(), { total: 0, providers: {} });
  assert.equal(phases.includes("recover-isolation"), true);
  assert.equal(phases.includes("recover-rename"), true);
  assert.equal(phases.includes("recover-remove"), false);
  const stale = (await readdir(leaseDir)).filter((entry) => entry.startsWith(".lock.stale-"));
  assert.equal(stale.length, 1);
  assert.equal((await readLockOwner(path.join(leaseDir, stale[0]))).generation, "dead-generation");
  await assert.rejects(lstat(lockDir), { code: "ENOENT" });
});

test("ACP connection lock owner fails closed on unsafe pid and process group identity fields", async () => {
  for (const mode of ["unsafe-pid", "unsafe-group"] as const) {
    const { leaseDir, pool } = await fixture();
    const lockDir = path.join(leaseDir, ".lock");
    const current = captureProcessIdentity(process.pid, { strict: true });
    assert.ok(current);
    const processIdentity = {
      ...current,
      birthIdPrecision: "exact" as const,
      ...(mode === "unsafe-pid" ? {
        pid: Number.MAX_SAFE_INTEGER + 1,
        incarnation: `${Number.MAX_SAFE_INTEGER + 1}:${current.birthId}`,
      } : {
        processGroupId: Number.MAX_SAFE_INTEGER + 1,
      }),
    };
    await writeConnectionLock(lockDir, {
      ownerToken: `${mode}-token`,
      generation: `${mode}-generation`,
      pid: mode === "unsafe-pid" ? Number.MAX_SAFE_INTEGER + 1 : process.pid,
      processIdentity,
    });

    await assert.rejects(
      pool.connectionLeaseStatus(),
      (error: NodeJS.ErrnoException) => {
        assert.equal(error.code, "ACP_POOL_STATE_UNVERIFIED");
        return true;
      },
    );
    assert.equal((await readLockOwner(lockDir)).generation, `${mode}-generation`);
  }
});

test("ACP connection lease acquisition publishes and retires exact verified lease evidence", async () => {
  const { leaseDir, pool } = await fixture();
  const result = await pool.execute("codex", "prompt", process.cwd(), 0, {
    bypass: true,
    providerKey: "codex",
  });

  assert.deepEqual(result, {
    output: "ok",
    providerKey: null,
    agent: "codex",
    variant: null,
  });
  assert.deepEqual(
    (await readdir(leaseDir)).filter((entry) => entry.endsWith(".json")),
    [],
  );
  const retiredLeases = (await readdir(leaseDir)).filter((entry) => entry.includes(".json.released-"));
  assert.equal(retiredLeases.length, 1);
  const retiredLeasePath = path.join(leaseDir, retiredLeases[0]);
  const retiredLeaseInfo = await lstat(retiredLeasePath);
  assert.equal(retiredLeaseInfo.isFile(), true);
  assert.equal(retiredLeaseInfo.isSymbolicLink(), false);
  assert.equal(JSON.parse(await readFile(retiredLeasePath, "utf8")).providerKey, "codex");
  const released = (await readdir(leaseDir)).filter((entry) => entry.startsWith(".lock.released-"));
  assert.ok(released.length >= 1);
  for (const entry of released) {
    const releasedDir = path.join(leaseDir, entry);
    const releasedInfo = await lstat(releasedDir);
    const persistedIdentity = (await readLockOwner(releasedDir)).identity as Record<string, unknown>;
    for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs", "birthtimeMs"]) {
      assert.equal(typeof persistedIdentity[field], "number", `missing persisted ${field}`);
    }
    assert.equal(persistedIdentity.dev, releasedInfo.dev);
    assert.equal(persistedIdentity.ino, releasedInfo.ino);
    assert.equal(persistedIdentity.size, releasedInfo.size);
    assert.equal(persistedIdentity.mtimeMs, releasedInfo.mtimeMs);
    assert.equal(persistedIdentity.birthtimeMs, releasedInfo.birthtimeMs);
  }
});

test("ACP connection lease retirement fsync ambiguity reports existing verified evidence", async () => {
  const { root, leaseDir, pool } = await fixture();
  const syncError = Object.assign(new Error("synthetic lease release fsync failure"), { code: "EINVAL" });
  const failingPool = new AcpPool({
    hubRoot: path.join(root, "hub-lease-release-fsync"),
    leaseRoot: path.join(root, "leases"),
    cpbRoot: root,
    runner: async () => "ok",
    connectionLockFsHooks: {
      syncDirectory: (directory, phase) => {
        assertConnectionLockSyncTarget(leaseDir, directory, phase);
        if (phase === "lease-release-rename") throw syncError;
      },
    },
  });

  let ambiguity: {
    evidencePath?: string;
    residualPath?: string;
    evidenceIdentity?: Record<string, unknown>;
  } | null = null;
  await assert.rejects(
    failingPool.execute("codex", "prompt", process.cwd(), 0, {
      bypass: true,
      providerKey: "codex",
    }),
    (error: Error & {
      code?: string;
      committed?: boolean;
      releaseCommitted?: boolean;
      retirementCommitted?: boolean;
      renameCommitted?: boolean;
      phase?: string;
      committedPath?: string;
      evidencePath?: string;
      residualPath?: string;
      evidenceIdentity?: Record<string, unknown>;
      recoveryPaths?: { canonical: string; evidence: string };
    }) => {
      assert.equal(error.code, "ACP_CONNECTION_LEASE_RENAME_COMMITTED_DURABILITY_AMBIGUOUS");
      assert.equal(error.committed, true);
      assert.equal(error.releaseCommitted, true);
      assert.equal(error.retirementCommitted, true);
      assert.equal(error.renameCommitted, true);
      assert.equal(error.phase, "lease-release-rename");
      assert.ok(error.residualPath?.includes(".json.released-"));
      assert.equal(error.committedPath, error.residualPath);
      assert.equal(error.evidencePath, error.residualPath);
      assert.equal(error.recoveryPaths?.evidence, error.residualPath);
      ambiguity = error;
      return true;
    },
  );

  assert.ok(ambiguity?.residualPath);
  assertGenerationMatchesStat(ambiguity.evidenceIdentity, await lstat(ambiguity.residualPath));
  const entries = await readdir(leaseDir);
  assert.deepEqual(entries.filter((entry) => entry.endsWith(".json")), []);
  const retired = entries.filter((entry) => entry.includes(".json.released-"));
  assert.equal(retired.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(leaseDir, retired[0]), "utf8")).providerKey, "codex");
  assert.equal(await pool.connectionLeaseStatus().then((status) => status.total), 0);
});

test("ACP connection lease release preserves a successor replacing retired evidence during durability sync", async () => {
  const { root, leaseDir } = await fixture();
  let successorPath = "";
  let displacedEvidencePath = "";
  const hostilePool = new AcpPool({
    hubRoot: path.join(root, "hub-lease-release-successor"),
    leaseRoot: path.join(root, "leases"),
    cpbRoot: root,
    runner: async () => "ok",
    connectionLockFsHooks: {
      syncDirectory: async (directory, phase) => {
        if (phase !== "lease-release-rename" || successorPath) return;
        assert.equal(directory, leaseDir);
        const retired = (await readdir(directory)).filter((entry) => entry.includes(".json.released-"));
        assert.equal(retired.length, 1);
        successorPath = path.join(directory, retired[0]);
        displacedEvidencePath = `${successorPath}.original`;
        const successor = {
          ...JSON.parse(await readFile(successorPath, "utf8")) as Record<string, unknown>,
          successorMarker: true,
        };
        await rename(successorPath, displacedEvidencePath);
        await writeFile(successorPath, `${JSON.stringify(successor, null, 2)}\n`, "utf8");
      },
    },
  });

  await assert.rejects(
    hostilePool.execute("codex", "prompt", process.cwd(), 0, {
      bypass: true,
      providerKey: "codex",
    }),
    (error: NodeJS.ErrnoException & {
      authorityVerified?: boolean;
      candidatePath?: string;
      residualPath?: string;
    }) => {
      assert.equal(error.code, "ACP_POOL_STATE_UNVERIFIED");
      assert.equal(error.authorityVerified, false);
      assert.equal(error.candidatePath, successorPath);
      assert.equal(error.residualPath, undefined);
      return true;
    },
  );

  assert.ok(successorPath);
  assert.equal(JSON.parse(await readFile(successorPath, "utf8")).successorMarker, true);
  assert.equal(JSON.parse(await readFile(displacedEvidencePath, "utf8")).providerKey, "codex");
});

test("ACP connection lease release retains descriptor identity across a post-read path replacement", async () => {
  const { root, leaseDir } = await fixture();
  let leaseReads = 0;
  let replaced = false;
  let replacementPath = "";
  const hostilePool = new AcpPool({
    hubRoot: path.join(root, "hub-lease-read-successor"),
    leaseRoot: path.join(root, "leases"),
    cpbRoot: root,
    runner: async () => "ok",
    connectionLockFsHooks: {
      boundedRead: {
        afterVerifiedRead: async ({ filePath }: { filePath: string }) => {
          if (path.dirname(filePath) !== leaseDir || !filePath.endsWith(".json")) return;
          leaseReads += 1;
          if (leaseReads !== 2) return;
          const successor = {
            ...JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>,
            successorMarker: true,
          };
          replacementPath = filePath;
          const successorTemp = `${filePath}.successor`;
          await writeFile(successorTemp, `${JSON.stringify(successor, null, 2)}\n`, "utf8");
          await rename(successorTemp, filePath);
          replaced = true;
        },
      },
    },
  });

  await assert.rejects(
    hostilePool.execute("codex", "prompt", process.cwd(), 0, {
      bypass: true,
      providerKey: "codex",
    }),
    (error: NodeJS.ErrnoException & {
      authorityVerified?: boolean;
      candidatePath?: string;
      residualPath?: string;
    }) => {
      assert.equal(error.code, "ACP_POOL_STATE_UNVERIFIED");
      assert.equal(error.authorityVerified, false);
      assert.equal(error.residualPath, undefined);
      assert.ok(error.candidatePath?.includes(".json.released-"));
      replacementPath = error.candidatePath || replacementPath;
      return true;
    },
  );

  assert.equal(replaced, true);
  assert.equal(JSON.parse(await readFile(replacementPath, "utf8")).successorMarker, true);
});
