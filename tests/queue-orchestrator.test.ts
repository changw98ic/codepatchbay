import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, rename, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  claimEligible,
  enqueue,
  listQueue,
  queueStatus,
  updateEntry,
  withQueueLockTestHooks,
} from "../server/services/hub/hub-queue.js";
import { HubOrchestrator, normalizedSourceContext } from "../server/orchestrator/hub-orchestrator.js";
import { hubConcurrencyEnv, resolveHubConcurrencyLimits } from "../server/services/infra.js";
import { registerProject } from "../server/services/hub/hub-registry.js";
import { captureProcessIdentity } from "../core/runtime/process-tree.js";
import { tempRoot, oldIso, readJson, writeJson } from "./helpers.js";

// Mock assignmentStore: always returns null (no active assignment)
const noAssignmentStore = { getAssignment: async () => null };
const execFileAsync = promisify(execFile);

test("normalizedSourceContext carries the durable scheduler decision into the assignment", () => {
  const schedulerDecision = {
    mode: "smart",
    rank: 2,
    score: 71,
    reasons: ["evidence-backed-fresh-attempt"],
    retryStrategy: "fresh_attempt",
    failureFingerprint: "sha256:failure",
  };

  const context = normalizedSourceContext({
    id: "queue-1",
    metadata: { schedulerDecision },
  });

  assert.equal(context.queueEntryId, "queue-1");
  assert.deepEqual(context.schedulerDecision, schedulerDecision);
});

function highConfidenceCapabilityMetadata() {
  const projectCapabilityMap = {
    confidence: "high",
    coreModules: ["server/orchestrator/scheduler.js"],
    testSurfaces: ["tests/queue-orchestrator.test.js"],
  };
  return {
    capabilityMapConfidence: "high",
    project_capability_map: projectCapabilityMap,
  };
}

async function sourceWithCodeGraphIndexButNoLiveState(prefix) {
  const sourcePath = await tempRoot(prefix);
  await mkdir(path.join(sourcePath, ".codegraph"), { recursive: true });
  await writeFile(path.join(sourcePath, ".codegraph", "codegraph.db"), Buffer.alloc(2048, 1));
  return sourcePath;
}

async function sourceWithLiveCodeGraphState(prefix) {
  const sourcePath = await sourceWithCodeGraphIndexButNoLiveState(prefix);
  const processIdentity = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(processIdentity, "expected current process identity");
  await writeJson(path.join(sourcePath, ".codegraph", "daemon.pid"), {
    pid: process.pid,
    processIdentity,
    codebaseRoot: sourcePath,
    source: "test",
  });
  return sourcePath;
}

async function registerReadyProject(hubRoot, id, prefix) {
  const sourcePath = await sourceWithLiveCodeGraphState(prefix);
  await registerProject(hubRoot, {
    id,
    sourcePath,
    skipCodeGraphGate: true,
    metadata: highConfidenceCapabilityMetadata(),
  });
  return sourcePath;
}

function workerIdentity(pid, birthId) {
  return {
    pid,
    birthId,
    incarnation: `${pid}:${birthId}`,
    capturedAt: "2026-07-20T00:00:00.000Z",
    birthIdPrecision: "exact",
  };
}

function queueLockDir(hubRoot) {
  return path.join(hubRoot, "queue", "queue.json.lock");
}

async function writeQueueLockOwner(lockDir, owner) {
  await mkdir(lockDir, { recursive: true });
  await writeFile(path.join(lockDir, "lock.json"), `${JSON.stringify(owner, null, 2)}\n`, "utf8");
}

function queueOwnerRecord(lockDir, ownerToken, identity = captureProcessIdentity(process.pid, { strict: true })) {
  assert.ok(identity, "expected process identity");
  const processIdentity = { ...identity, birthIdPrecision: "exact" };
  return {
    format: "cpb-hub-queue-lock/v1",
    ownerToken,
    lockPath: path.resolve(lockDir),
    ownerPid: processIdentity.pid,
    host: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity,
  };
}

async function ageQueueLock(lockDir) {
  const old = new Date(0);
  await utimes(lockDir, old, old);
}

async function assertOnlyCtimeChanged(filePath: string, before: Awaited<ReturnType<typeof lstat>>) {
  const after = await lstat(filePath);

  assert.equal(String(after.dev), String(before.dev));
  assert.equal(String(after.ino), String(before.ino));
  assert.equal(String(after.size), String(before.size));
  assert.equal(String(after.mode), String(before.mode));
  assert.equal(String(after.mtimeMs), String(before.mtimeMs));
  assert.equal(String(after.birthtimeMs), String(before.birthtimeMs));
  assert.notEqual(String(after.ctimeMs), String(before.ctimeMs));
}

async function mutateOnlyCtime(filePath: string) {
  const before = await lstat(filePath);
  const permissions = before.mode & 0o7777;
  await chmod(filePath, permissions ^ 0o040);
  await chmod(filePath, permissions);
  await assertOnlyCtimeChanged(filePath, before);
}

async function rewriteSameSizeWithRestoredMtime(filePath: string, mutate: (content: string) => string) {
  const before = await lstat(filePath);
  const original = await readFile(filePath, "utf8");
  const mutated = mutate(original);
  const timestampReference = `${filePath}.timestamp-reference`;
  assert.notEqual(mutated, original);
  assert.equal(Buffer.byteLength(mutated), Buffer.byteLength(original));
  await writeFile(timestampReference, "", "utf8");
  try {
    await execFileAsync("touch", ["-r", filePath, timestampReference]);
    await writeFile(filePath, mutated, "utf8");
    await execFileAsync("touch", ["-r", timestampReference, filePath]);
  } finally {
    await unlink(timestampReference).catch(() => undefined);
  }
  await assertOnlyCtimeChanged(filePath, before);
}

test("enqueue dedupes pending entries and requires UI lane reason", async () => {
  const hubRoot = await tempRoot("cpb-queue");
  const first = await enqueue(hubRoot, {
    projectId: "proj",
    description: "same task",
    metadata: { queueDedupeKey: "same-origin" },
  });
  const second = await enqueue(hubRoot, {
    projectId: "proj",
    description: "same task",
    metadata: { queueDedupeKey: "same-origin" },
  });

  assert.equal(second.id, first.id);
  assert.equal((await listQueue(hubRoot)).length, 1);

  await assert.rejects(
    enqueue(hubRoot, {
      projectId: "proj",
      description: "ui task",
      metadata: { acpProfile: "ui" },
    }),
    /ui profile requires a non-empty uiLaneReason/,
  );
});

test("local queue lock recovers a stale predecessor after PID reuse", async () => {
  const hubRoot = await tempRoot("cpb-queue-lock-pid-reuse");
  const lockDir = queueLockDir(hubRoot);
  const current = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(current, "expected current process identity");
  const predecessorBirthId = `${current.birthId}-predecessor`;
  await writeQueueLockOwner(lockDir, queueOwnerRecord(lockDir, "predecessor", {
    ...current,
    birthId: predecessorBirthId,
    incarnation: `${current.pid}:${predecessorBirthId}`,
  }));
  await ageQueueLock(lockDir);

  const entry = await enqueue(hubRoot, { projectId: "proj", description: "after stale lock" });

  assert.equal(entry.status, "pending");
  assert.equal((await listQueue(hubRoot)).length, 1);
  await assert.rejects(readFile(path.join(lockDir, "lock.json"), "utf8"), { code: "ENOENT" });
});

test("local queue lock owner publish reports committed ambiguity after rename", async () => {
  const hubRoot = await tempRoot("cpb-queue-lock-owner-fsync");
  const lockDir = queueLockDir(hubRoot);
  const ownerFile = path.join(lockDir, "lock.json");
  const failureCause = Object.assign(new Error("simulated lock owner directory sync failure"), { code: "EIO" });

  await withQueueLockTestHooks({
    syncDirectory: async (directory) => {
      if (directory === lockDir) throw failureCause;
    },
  }, async () => {
    await assert.rejects(
      enqueue(hubRoot, { projectId: "proj", description: "ambiguous lock owner publish" }),
      (error: unknown) => {
        const actual = error as {
          code?: unknown;
          cause?: unknown;
          committed?: unknown;
          committedPath?: unknown;
          recoveryPaths?: { ownerFile?: unknown; lockDir?: unknown };
        };
        assert.equal(actual.code, "HUB_QUEUE_LOCK_OWNER_COMMITTED_AMBIGUOUS");
        assert.equal(actual.cause, failureCause);
        assert.equal(actual.committed, true);
        assert.equal(actual.committedPath, ownerFile);
        assert.deepEqual(actual.recoveryPaths, { ownerFile, lockDir });
        return true;
      },
    );
  });

  const owner = JSON.parse(await readFile(ownerFile, "utf8"));
  assert.equal(owner.lockPath, lockDir);
  assert.deepEqual(await readdir(lockDir), ["lock.json"]);
});

test("local queue write reports committed ambiguity after rename", async () => {
  const hubRoot = await tempRoot("cpb-queue-write-fsync");
  const queueDir = path.join(hubRoot, "queue");
  const canonical = path.join(queueDir, "queue.json");
  const failureCause = Object.assign(new Error("simulated queue directory sync failure"), { code: "EIO" });
  let queueDirectorySyncs = 0;

  await withQueueLockTestHooks({
    syncDirectory: async (directory) => {
      if (directory === queueDir && ++queueDirectorySyncs === 2) throw failureCause;
    },
  }, async () => {
    await assert.rejects(
      enqueue(hubRoot, { projectId: "proj", description: "ambiguous queue publish" }),
      (error: unknown) => {
        const actual = error as {
          code?: unknown;
          cause?: unknown;
          committed?: unknown;
          committedPath?: unknown;
          recoveryPaths?: { canonical?: unknown };
        };
        assert.equal(actual.code, "HUB_QUEUE_WRITE_COMMITTED_AMBIGUOUS");
        assert.equal(actual.cause, failureCause);
        assert.equal(actual.committed, true);
        assert.equal(actual.committedPath, canonical);
        assert.deepEqual(actual.recoveryPaths, { canonical });
        return true;
      },
    );
  });

  const persisted = JSON.parse(await readFile(canonical, "utf8"));
  assert.equal(persisted.entries.length, 1);
  assert.equal(persisted.entries[0].description, "ambiguous queue publish");
  assert.deepEqual((await readdir(queueDir)).filter((entry) => entry.includes(".tmp-")), []);
});

test("local queue write rejects symlink canonical queue state", async () => {
  const hubRoot = await tempRoot("cpb-queue-canonical-symlink");
  const queueDir = path.join(hubRoot, "queue");
  const outside = await tempRoot("cpb-queue-canonical-symlink-target");
  const target = path.join(outside, "queue.json");
  await mkdir(queueDir, { recursive: true });
  await writeFile(target, "{\"version\":1,\"entries\":[]}\n", "utf8");
  await symlink(target, path.join(queueDir, "queue.json"));

  await assert.rejects(
    enqueue(hubRoot, { projectId: "proj", description: "must not follow queue symlink" }),
    { code: "HUB_QUEUE_UNSAFE" },
  );
  assert.equal(await readFile(target, "utf8"), "{\"version\":1,\"entries\":[]}\n");
});

test("local queue lock owner publish preserves a replaced temp generation", async () => {
  const hubRoot = await tempRoot("cpb-queue-owner-temp-successor");
  let successorTemp = "";
  await withQueueLockTestHooks({
    beforeOwnerRename: async ({ tmp }) => {
      await rename(tmp, `${tmp}.saved`);
      await writeFile(tmp, "successor temp\n", "utf8");
      successorTemp = tmp;
    },
  }, async () => {
    await assert.rejects(
      enqueue(hubRoot, { projectId: "proj", description: "owner temp successor" }),
      { code: "HUB_QUEUE_LOCK_ACQUIRE_CLEANUP_FAILED" },
    );
  });
  assert.equal(await readFile(successorTemp, "utf8"), "successor temp\n");
});

test("local queue write preserves a replaced temp generation", async () => {
  const hubRoot = await tempRoot("cpb-queue-write-temp-successor");
  let successorTemp = "";
  await withQueueLockTestHooks({
    beforeQueueRename: async ({ tmp }) => {
      await rename(tmp, `${tmp}.saved`);
      await writeFile(tmp, "successor queue temp\n", "utf8");
      successorTemp = tmp;
    },
  }, async () => {
    await assert.rejects(
      enqueue(hubRoot, { projectId: "proj", description: "queue temp successor" }),
      { code: "HUB_QUEUE_WRITE_CLEANUP_PRESERVED" },
    );
  });
  assert.equal(await readFile(successorTemp, "utf8"), "successor queue temp\n");
});

test("local queue temp publication rejects a same-inode same-size rewrite with restored mtime", async () => {
  const hubRoot = await tempRoot("cpb-queue-write-temp-ctime");
  let mutatedTemp = "";

  await withQueueLockTestHooks({
    beforeQueueRename: async ({ tmp }) => {
      await rewriteSameSizeWithRestoredMtime(tmp, (original) => original.replace(
        "temp publication ctime",
        "temp publication xtime",
      ));
      mutatedTemp = tmp;
    },
  }, async () => {
    await assert.rejects(
      enqueue(hubRoot, { projectId: "proj", description: "temp publication ctime" }),
      (error: unknown) => {
        const actual = error as { code?: unknown; primaryError?: { code?: unknown } };
        assert.equal(actual.code, "HUB_QUEUE_WRITE_CLEANUP_PRESERVED");
        assert.equal(actual.primaryError?.code, "HUB_QUEUE_WRITE_TMP_CHANGED");
        return true;
      },
    );
  });

  assert.match(await readFile(mutatedTemp, "utf8"), /temp publication xtime/);
});

test("local queue write cleanup preserves a symlink temp successor and its target", async () => {
  const hubRoot = await tempRoot("cpb-queue-write-temp-symlink-successor");
  const outside = await tempRoot("cpb-queue-write-temp-symlink-target");
  const sentinel = path.join(outside, "sentinel.txt");
  await writeFile(sentinel, "preserve target\n", "utf8");
  let successorTemp = "";

  await withQueueLockTestHooks({
    beforeQueueRename: async ({ tmp }) => {
      await rename(tmp, `${tmp}.saved`);
      await symlink(sentinel, tmp);
      successorTemp = tmp;
    },
  }, async () => {
    await assert.rejects(
      enqueue(hubRoot, { projectId: "proj", description: "queue temp symlink successor" }),
      { code: "HUB_QUEUE_WRITE_CLEANUP_PRESERVED" },
    );
  });

  assert.equal((await lstat(successorTemp)).isSymbolicLink(), true);
  assert.equal(await readFile(sentinel, "utf8"), "preserve target\n");
});

test("local queue lock cleanup preserves quarantine when extra recovery evidence appears", async () => {
  const hubRoot = await tempRoot("cpb-queue-lock-extra-evidence");
  const lockDir = queueLockDir(hubRoot);
  let quarantineDir = "";
  let preservedQuarantineDir = "";

  await withQueueLockTestHooks({
    afterQuarantineRename: async (context) => {
      if (context.kind !== "released") return;
      quarantineDir = context.quarantineDir;
    },
    beforeIsolatedCleanup: async (context) => {
      if (!context.isDirectory || context.originalPath !== quarantineDir) return;
      await writeFile(path.join(context.isolatedPath, "evidence.txt"), "preserve evidence\n", "utf8");
    },
  }, async () => {
    await assert.rejects(
      enqueue(hubRoot, { projectId: "proj", description: "release with extra evidence" }),
      (error: unknown) => {
        const actual = error as { code?: unknown; recoveryPaths?: { quarantineDir?: unknown; originalQuarantineDir?: unknown; lockDir?: unknown } };
        assert.equal(actual.code, "HUB_QUEUE_LOCK_QUARANTINE_CLEANUP_PRESERVED");
        assert.equal(actual.recoveryPaths?.originalQuarantineDir, quarantineDir);
        assert.equal(actual.recoveryPaths?.lockDir, lockDir);
        assert.equal(typeof actual.recoveryPaths?.quarantineDir, "string");
        preservedQuarantineDir = String(actual.recoveryPaths?.quarantineDir);
        return true;
      },
    );
  });

  assert.ok(quarantineDir);
  assert.notEqual(preservedQuarantineDir, quarantineDir);
  assert.equal(await readFile(path.join(preservedQuarantineDir, "evidence.txt"), "utf8"), "preserve evidence\n");
  assert.deepEqual((await readdir(lockDir).catch((err) => {
    assert.equal(err.code, "ENOENT");
    return [];
  })), []);
});

test("local queue lock cleanup preserves a whole-directory same-owner ABA successor", async () => {
  const hubRoot = await tempRoot("cpb-queue-lock-isolated-directory-aba");
  const lockDir = queueLockDir(hubRoot);
  const current = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(current);
  const predecessorBirthId = `${current.birthId}-predecessor`;
  const predecessor = queueOwnerRecord(lockDir, "isolated-directory-aba", {
    ...current,
    birthId: predecessorBirthId,
    incarnation: `${current.pid}:${predecessorBirthId}`,
  });
  await writeQueueLockOwner(lockDir, predecessor);
  await ageQueueLock(lockDir);
  const ownerRaw = await readFile(path.join(lockDir, "lock.json"), "utf8");

  let quarantineDir = "";
  let isolatedDir = "";
  let displacedDir = "";
  await withQueueLockTestHooks({
    afterQuarantineRename: async (context) => {
      if (context.kind !== "stale") return;
      quarantineDir = context.quarantineDir;
    },
    beforeIsolatedCleanup: async (context) => {
      if (!context.isDirectory || context.originalPath !== quarantineDir) return;
      isolatedDir = context.isolatedPath;
      displacedDir = `${isolatedDir}.predecessor`;
      await rename(isolatedDir, displacedDir);
      await mkdir(isolatedDir);
      await writeFile(path.join(isolatedDir, "lock.json"), ownerRaw, "utf8");
    },
  }, async () => {
    await assert.rejects(
      enqueue(hubRoot, { projectId: "proj", description: "isolated directory ABA" }),
      (error: unknown) => {
        const actual = error as {
          code?: unknown;
          committed?: unknown;
          recoveryPaths?: { quarantineDir?: unknown; originalQuarantineDir?: unknown; lockDir?: unknown };
        };
        assert.equal(actual.code, "HUB_QUEUE_LOCK_QUARANTINE_CLEANUP_PRESERVED");
        assert.equal(actual.committed, false);
        assert.equal(actual.recoveryPaths?.quarantineDir, isolatedDir);
        assert.equal(actual.recoveryPaths?.originalQuarantineDir, quarantineDir);
        assert.equal(actual.recoveryPaths?.lockDir, lockDir);
        return true;
      },
    );
  });

  assert.ok(isolatedDir);
  assert.ok(displacedDir);
  assert.equal((await lstat(isolatedDir)).isDirectory(), true);
  assert.equal((await lstat(displacedDir)).isDirectory(), true);
  assert.equal(await readFile(path.join(isolatedDir, "lock.json"), "utf8"), ownerRaw);
  assert.equal(await readFile(path.join(displacedDir, "lock.json"), "utf8"), ownerRaw);
  await assert.rejects(lstat(lockDir), { code: "ENOENT" });
  assert.equal((await listQueue(hubRoot)).length, 0);
});

test("local queue lock cleanup preserves an isolated directory ctime-only mutation", async () => {
  const hubRoot = await tempRoot("cpb-queue-lock-isolated-directory-ctime");
  const lockDir = queueLockDir(hubRoot);
  const current = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(current);
  const predecessorBirthId = `${current.birthId}-predecessor`;
  const predecessor = queueOwnerRecord(lockDir, "isolated-directory-ctime", {
    ...current,
    birthId: predecessorBirthId,
    incarnation: `${current.pid}:${predecessorBirthId}`,
  });
  await writeQueueLockOwner(lockDir, predecessor);
  await ageQueueLock(lockDir);
  const ownerRaw = await readFile(path.join(lockDir, "lock.json"), "utf8");

  let quarantineDir = "";
  let isolatedDir = "";
  await withQueueLockTestHooks({
    afterQuarantineRename: async (context) => {
      if (context.kind !== "stale") return;
      quarantineDir = context.quarantineDir;
    },
    beforeIsolatedCleanup: async (context) => {
      if (!context.isDirectory || context.originalPath !== quarantineDir) return;
      isolatedDir = context.isolatedPath;
      await mutateOnlyCtime(isolatedDir);
    },
  }, async () => {
    await assert.rejects(
      enqueue(hubRoot, { projectId: "proj", description: "isolated directory ctime" }),
      (error: unknown) => {
        const actual = error as {
          code?: unknown;
          committed?: unknown;
          recoveryPaths?: { quarantineDir?: unknown; originalQuarantineDir?: unknown; lockDir?: unknown };
        };
        assert.equal(actual.code, "HUB_QUEUE_LOCK_QUARANTINE_CLEANUP_PRESERVED");
        assert.equal(actual.committed, false);
        assert.equal(actual.recoveryPaths?.quarantineDir, isolatedDir);
        assert.equal(actual.recoveryPaths?.originalQuarantineDir, quarantineDir);
        assert.equal(actual.recoveryPaths?.lockDir, lockDir);
        return true;
      },
    );
  });

  assert.ok(isolatedDir);
  assert.equal((await lstat(isolatedDir)).isDirectory(), true);
  assert.equal(await readFile(path.join(isolatedDir, "lock.json"), "utf8"), ownerRaw);
  await assert.rejects(lstat(lockDir), { code: "ENOENT" });
  assert.equal((await listQueue(hubRoot)).length, 0);
});

test("local queue quarantine cleanup rejects a same-inode same-size mutation with stable mtime", async () => {
  const hubRoot = await tempRoot("cpb-queue-lock-quarantine-ctime");
  let quarantineDir = "";

  await withQueueLockTestHooks({
    beforeQuarantineCleanup: async (context) => {
      if (context.kind !== "released") return;
      quarantineDir = context.quarantineDir;
      await mutateOnlyCtime(quarantineDir);
    },
  }, async () => {
    await assert.rejects(
      enqueue(hubRoot, { projectId: "proj", description: "quarantine cleanup ctime" }),
      (error: unknown) => {
        const actual = error as { code?: unknown; recoveryPaths?: { quarantineDir?: unknown } };
        assert.equal(actual.code, "HUB_QUEUE_LOCK_QUARANTINE_CLEANUP_PRESERVED");
        assert.equal(actual.recoveryPaths?.quarantineDir, quarantineDir);
        return true;
      },
    );
  });

  assert.ok(quarantineDir);
  assert.equal((await lstat(quarantineDir)).isDirectory(), true);
  assert.match(await readFile(path.join(quarantineDir, "lock.json"), "utf8"), /cpb-hub-queue-lock\/v1/);
});

test("local queue quarantine cleanup preserves owner evidence mutated after validation", async () => {
  const hubRoot = await tempRoot("cpb-queue-lock-cleanup-owner-mutation");
  const lockDir = queueLockDir(hubRoot);
  const current = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(current);
  const predecessorBirthId = `${current.birthId}-predecessor`;
  const predecessor = queueOwnerRecord(lockDir, "cleanup-owner", {
    ...current,
    birthId: predecessorBirthId,
    incarnation: `${current.pid}:${predecessorBirthId}`,
  });
  await writeQueueLockOwner(lockDir, predecessor);
  await ageQueueLock(lockDir);

  let quarantineDir = "";
  let mutatedRaw = "";
  await withQueueLockTestHooks({
    beforeQuarantineCleanup: async (context) => {
      if (context.kind !== "stale") return;
      quarantineDir = context.quarantineDir;
      mutatedRaw = `${JSON.stringify({
        ...predecessor,
        acquiredAt: "1971-01-01T00:00:00.000Z",
      }, null, 2)}\n`;
      await writeFile(path.join(quarantineDir, "lock.json"), mutatedRaw, "utf8");
    },
  }, async () => {
    await assert.rejects(
      enqueue(hubRoot, { projectId: "proj", description: "cleanup owner mutation" }),
      (error: unknown) => {
        const actual = error as { code?: unknown; committed?: unknown; recoveryPaths?: { quarantineDir?: unknown; lockDir?: unknown } };
        assert.equal(actual.code, "HUB_QUEUE_LOCK_QUARANTINE_CLEANUP_PRESERVED");
        assert.equal(actual.committed, false);
        assert.equal(actual.recoveryPaths?.quarantineDir, quarantineDir);
        assert.equal(actual.recoveryPaths?.lockDir, lockDir);
        return true;
      },
    );
  });

  assert.ok(quarantineDir);
  assert.equal((await lstat(quarantineDir)).isDirectory(), true);
  assert.equal(await readFile(path.join(quarantineDir, "lock.json"), "utf8"), mutatedRaw);
  await assert.rejects(lstat(lockDir), { code: "ENOENT" });
  assert.equal((await listQueue(hubRoot)).length, 0);
});

test("local queue lock test hooks are scoped to the async caller", async () => {
  const failingHubRoot = await tempRoot("cpb-queue-hooks-failing");
  const passingHubRoot = await tempRoot("cpb-queue-hooks-passing");
  let failingTemp = "";

  const failing = withQueueLockTestHooks({
    beforeQueueRename: async ({ tmp }) => {
      await rename(tmp, `${tmp}.saved`);
      await writeFile(tmp, "scoped successor\n", "utf8");
      failingTemp = tmp;
    },
  }, async () => assert.rejects(
    enqueue(failingHubRoot, { projectId: "proj", description: "scoped failing hook" }),
    { code: "HUB_QUEUE_WRITE_CLEANUP_PRESERVED" },
  ));

  const passing = enqueue(passingHubRoot, { projectId: "proj", description: "no hook leakage" });
  await Promise.all([failing, passing]);

  assert.equal(await readFile(failingTemp, "utf8"), "scoped successor\n");
  assert.equal((await listQueue(passingHubRoot))[0].description, "no hook leakage");
});

test("local queue lock preserves an empty successor created during quarantine", async () => {
  const hubRoot = await tempRoot("cpb-queue-lock-empty-successor");
  const lockDir = queueLockDir(hubRoot);
  const current = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(current);
  const predecessorBirthId = `${current.birthId}-predecessor`;
  await writeQueueLockOwner(lockDir, queueOwnerRecord(lockDir, "predecessor", {
    ...current,
    birthId: predecessorBirthId,
    incarnation: `${current.pid}:${predecessorBirthId}`,
  }));
  await ageQueueLock(lockDir);

  await withQueueLockTestHooks({
    afterQuarantineRename: async ({ lockDir: originalLockDir }) => {
      await mkdir(originalLockDir);
    },
  }, async () => {
    await assert.rejects(
      enqueue(hubRoot, { projectId: "proj", description: "after empty successor" }),
      { code: "HUB_QUEUE_LOCK_SUCCESSOR_PRESERVED" },
    );
  });

  await assert.rejects(readFile(path.join(lockDir, "lock.json"), "utf8"), { code: "ENOENT" });
  const siblings = await readdir(path.dirname(lockDir));
  assert.equal(siblings.some((entry) => entry.startsWith(`${path.basename(lockDir)}.stale-`)), true);
});

test("local queue lock preserves a same-token successor created during quarantine", async () => {
  const hubRoot = await tempRoot("cpb-queue-lock-same-token-successor");
  const lockDir = queueLockDir(hubRoot);
  const current = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(current);
  const predecessorBirthId = `${current.birthId}-predecessor`;
  await writeQueueLockOwner(lockDir, queueOwnerRecord(lockDir, "same-token-owner", {
    ...current,
    birthId: predecessorBirthId,
    incarnation: `${current.pid}:${predecessorBirthId}`,
  }));
  await ageQueueLock(lockDir);
  let quarantineDir = "";

  await withQueueLockTestHooks({
    afterQuarantineRename: async (context) => {
      quarantineDir = context.quarantineDir;
      await writeQueueLockOwner(context.lockDir, queueOwnerRecord(context.lockDir, "same-token-owner", current));
    },
  }, async () => {
    await assert.rejects(
      enqueue(hubRoot, { projectId: "proj", description: "after same-token successor" }),
      (error: unknown) => {
        const actual = error as { code?: unknown; committed?: unknown; recoveryPaths?: { quarantineDir?: unknown; lockDir?: unknown } };
        assert.equal(actual.code, "HUB_QUEUE_LOCK_SUCCESSOR_PRESERVED");
        assert.equal(actual.committed, false);
        assert.equal(actual.recoveryPaths?.quarantineDir, quarantineDir);
        assert.equal(actual.recoveryPaths?.lockDir, lockDir);
        return true;
      },
    );
  });

  const successor = JSON.parse(await readFile(path.join(lockDir, "lock.json"), "utf8"));
  assert.equal(successor.ownerToken, "same-token-owner");
  assert.equal(successor.processIdentity.incarnation, current.incarnation);
  assert.equal(JSON.parse(await readFile(path.join(quarantineDir, "lock.json"), "utf8")).processIdentity.birthId, predecessorBirthId);
});

test("local queue lock preserves quarantine when ownership changes during recovery", async () => {
  const hubRoot = await tempRoot("cpb-queue-lock-restore-fsync");
  const lockDir = queueLockDir(hubRoot);
  const current = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(current);
  const predecessorBirthId = `${current.birthId}-predecessor`;
  const predecessor = queueOwnerRecord(lockDir, "predecessor", {
    ...current,
    birthId: predecessorBirthId,
    incarnation: `${current.pid}:${predecessorBirthId}`,
  });
  await writeQueueLockOwner(lockDir, predecessor);
  await ageQueueLock(lockDir);

  let quarantineDir = "";
  await withQueueLockTestHooks({
    afterQuarantineRename: async (context) => {
      quarantineDir = context.quarantineDir;
      await writeFile(path.join(context.quarantineDir, "lock.json"), `${JSON.stringify({
        ...predecessor,
        ownerToken: "changed-during-quarantine",
      }, null, 2)}\n`, "utf8");
    },
  }, async () => {
    await assert.rejects(
      enqueue(hubRoot, { projectId: "proj", description: "after ambiguous restore" }),
      (err) => {
        const actual = err as { code?: unknown; committed?: unknown; recoveryPaths?: { lockDir?: unknown; quarantineDir?: unknown } };
        assert.equal(actual.code, "HUB_QUEUE_LOCK_RESTORE_FAILED");
        assert.equal(actual.committed, false);
        assert.equal(actual.recoveryPaths?.lockDir, lockDir);
        assert.equal(actual.recoveryPaths?.quarantineDir, quarantineDir);
        return true;
      },
    );
  });

  assert.ok(quarantineDir);
  await assert.rejects(readFile(path.join(lockDir, "lock.json"), "utf8"), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readFile(path.join(quarantineDir, "lock.json"), "utf8")), {
    ...predecessor,
    ownerToken: "changed-during-quarantine",
  });
  const siblings = await readdir(path.dirname(lockDir));
  assert.equal(siblings.includes(path.basename(quarantineDir)), true);
  assert.equal((await listQueue(hubRoot)).length, 0);
});

test("local queue lock preserves quarantine when owner evidence mutates without identity change", async () => {
  const hubRoot = await tempRoot("cpb-queue-lock-owner-raw-mutation");
  const lockDir = queueLockDir(hubRoot);
  const current = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(current);
  const predecessorBirthId = `${current.birthId}-predecessor`;
  const predecessor = queueOwnerRecord(lockDir, "same-owner-token", {
    ...current,
    birthId: predecessorBirthId,
    incarnation: `${current.pid}:${predecessorBirthId}`,
  });
  await writeQueueLockOwner(lockDir, predecessor);
  await ageQueueLock(lockDir);

  let quarantineDir = "";
  await withQueueLockTestHooks({
    afterQuarantineRename: async (context) => {
      quarantineDir = context.quarantineDir;
      await writeFile(path.join(context.quarantineDir, "lock.json"), `${JSON.stringify({
        ...predecessor,
        acquiredAt: "1971-01-01T00:00:00.000Z",
      }, null, 2)}\n`, "utf8");
    },
  }, async () => {
    await assert.rejects(
      enqueue(hubRoot, { projectId: "proj", description: "after owner evidence mutation" }),
      (err) => {
        const actual = err as { code?: unknown; committed?: unknown; recoveryPaths?: { lockDir?: unknown; quarantineDir?: unknown } };
        assert.equal(actual.code, "HUB_QUEUE_LOCK_RESTORE_FAILED");
        assert.equal(actual.committed, false);
        assert.equal(actual.recoveryPaths?.lockDir, lockDir);
        assert.equal(actual.recoveryPaths?.quarantineDir, quarantineDir);
        return true;
      },
    );
  });

  assert.ok(quarantineDir);
  await assert.rejects(readFile(path.join(lockDir, "lock.json"), "utf8"), { code: "ENOENT" });
  const preserved = JSON.parse(await readFile(path.join(quarantineDir, "lock.json"), "utf8"));
  assert.equal(preserved.ownerToken, predecessor.ownerToken);
  assert.equal(preserved.processIdentity.incarnation, predecessor.processIdentity.incarnation);
  assert.equal(preserved.acquiredAt, "1971-01-01T00:00:00.000Z");
  assert.equal((await listQueue(hubRoot)).length, 0);
});

test("local queue lock does not force through a timed-out live owner", async () => {
  const hubRoot = await tempRoot("cpb-queue-lock-live-owner");
  const lockDir = queueLockDir(hubRoot);
  await writeQueueLockOwner(lockDir, queueOwnerRecord(lockDir, "live-owner"));
  await ageQueueLock(lockDir);

  await assert.rejects(
    enqueue(hubRoot, { projectId: "proj", description: "blocked by live owner" }),
    /queue lock busy/,
  );

  const owner = JSON.parse(await readFile(path.join(lockDir, "lock.json"), "utf8"));
  assert.equal(owner.ownerToken, "live-owner");
});

test("local queue lock fails closed on persisted coarse owner identity", async () => {
  const hubRoot = await tempRoot("cpb-queue-lock-coarse-owner");
  const lockDir = queueLockDir(hubRoot);
  const owner = queueOwnerRecord(lockDir, "coarse-owner");
  await writeQueueLockOwner(lockDir, {
    ...owner,
    processIdentity: {
      ...owner.processIdentity,
      birthIdPrecision: "coarse",
    },
  });
  await ageQueueLock(lockDir);

  await assert.rejects(
    enqueue(hubRoot, { projectId: "proj", description: "coarse owner" }),
    { code: "HUB_QUEUE_LOCK_UNSAFE" },
  );
});

test("local queue lock fails closed on unsafe symlink and malformed owner", async () => {
  const symlinkHubRoot = await tempRoot("cpb-queue-lock-symlink");
  const external = await tempRoot("cpb-queue-lock-target");
  const sentinel = path.join(external, "sentinel.txt");
  await writeFile(sentinel, "preserve\n", "utf8");
  await mkdir(path.dirname(queueLockDir(symlinkHubRoot)), { recursive: true });
  await symlink(external, queueLockDir(symlinkHubRoot));

  await assert.rejects(
    enqueue(symlinkHubRoot, { projectId: "proj", description: "unsafe symlink" }),
    { code: "HUB_QUEUE_LOCK_UNSAFE" },
  );
  assert.equal(await readFile(sentinel, "utf8"), "preserve\n");

  const malformedHubRoot = await tempRoot("cpb-queue-lock-malformed");
  const malformedLockDir = queueLockDir(malformedHubRoot);
  await mkdir(malformedLockDir, { recursive: true });
  await writeFile(path.join(malformedLockDir, "lock.json"), "{not json\n", "utf8");
  await ageQueueLock(malformedLockDir);

  await assert.rejects(
    enqueue(malformedHubRoot, { projectId: "proj", description: "malformed lock" }),
    { code: "HUB_QUEUE_LOCK_UNSAFE" },
  );
  assert.equal(await readFile(path.join(malformedLockDir, "lock.json"), "utf8"), "{not json\n");
});

test("claimEligible reports provider slot exhaustion without mutating pending queue", async () => {
  const hubRoot = await tempRoot("cpb-queue-provider");
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "blocked by provider slots" });

  const result = await claimEligible(hubRoot, {
    workerId: "w-provider",
    providerSlotsAvailable: false,
    assignmentStore: noAssignmentStore,
  });

  assert.equal(result.entry, null);
  assert.equal(result.reason, "provider-slots-exhausted");
  assert.equal((await listQueue(hubRoot))[0].id, entry.id);
  assert.equal((await listQueue(hubRoot))[0].status, "pending");
});

test("queueStatus separates historical failed entries from failed targets still needing retry", async () => {
  const hubRoot = await tempRoot("cpb-queue-failed-targets");
  const original = await enqueue(hubRoot, { projectId: "proj", description: "original failed job" });
  await updateEntry(hubRoot, original.id, { status: "failed" });
  const failedRetry = await enqueue(hubRoot, {
    projectId: "proj",
    description: `Retry job job-${original.id}`,
    type: "cli_retry",
    metadata: { retryJobId: `job-${original.id}` },
  });
  await updateEntry(hubRoot, failedRetry.id, { status: "failed" });
  await enqueue(hubRoot, {
    projectId: "proj",
    description: `Retry job job-${original.id}`,
    type: "cli_retry",
    metadata: { retryJobId: `job-${original.id}` },
  });
  const unretried = await enqueue(hubRoot, { projectId: "proj", description: "unretried failed job" });
  await updateEntry(hubRoot, unretried.id, { status: "failed" });
  const retried = await enqueue(hubRoot, { projectId: "proj", description: "retried failed job" });
  await updateEntry(hubRoot, retried.id, { status: "failed" });
  const completedRetry = await enqueue(hubRoot, {
    projectId: "proj",
    description: `Retry job job-${retried.id}`,
    type: "cli_retry",
    metadata: { retryJobId: `job-${retried.id}` },
  });
  await updateEntry(hubRoot, completedRetry.id, { status: "completed" });

  const status = await queueStatus(hubRoot);

  assert.equal(status.failed, 4);
  assert.equal(status.failedEntries, 4);
  assert.equal(status.failedTargets, 3);
  assert.equal(status.retryingFailedTargets, 1);
  assert.equal(status.retriedFailedTargets, 1);
  assert.equal(status.unretriedFailedTargets, 1);
  assert.equal(status.projects.proj.failedEntries, 4);
  assert.equal(status.projects.proj.failedTargets, 3);
  assert.equal(status.projects.proj.retryingFailedTargets, 1);
  assert.equal(status.projects.proj.retriedFailedTargets, 1);
  assert.equal(status.projects.proj.unretriedFailedTargets, 1);
});

test("claimEligible recovers stale in_progress entries and reclaims them", async () => {
  const hubRoot = await tempRoot("cpb-queue-stale");
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "stale claim" });
  await updateEntry(hubRoot, entry.id, {
    status: "in_progress",
    claimedBy: "w-old",
    workerId: "w-old",
    claimedAt: oldIso(),
  });

  const result = await claimEligible(hubRoot, {
    workerId: "w-new",
    claimTimeoutMs: 1,
    assignmentStore: noAssignmentStore,
  });

  assert.equal(result.entry.id, entry.id);
  assert.deepEqual(result.recovered, [entry.id]);
  assert.equal(result.entry.claimedBy, "w-new");
  assert.equal((await listQueue(hubRoot))[0].status, "in_progress");
});

test("claimEligible enforces per-project concurrency without any Hub-wide active cap", async () => {
  const hubRoot = await tempRoot("cpb-queue-concurrency");
  const removedHubTotalOption = ["maxActive", "Total"].join("");
  const active = await enqueue(hubRoot, { projectId: "proj-a", description: "active" });
  await claimEligible(hubRoot, { workerId: "w-active", assignmentStore: noAssignmentStore });
  await enqueue(hubRoot, { projectId: "proj-a", description: "same project pending" });
  await enqueue(hubRoot, { projectId: "proj-b", description: "other project pending" });

  const sameProject = await claimEligible(hubRoot, {
    workerId: "w-same",
    maxActivePerProject: 1,
    [removedHubTotalOption]: 99,
    projectId: "proj-a",
    assignmentStore: noAssignmentStore,
  });
  assert.equal(sameProject.entry, null);
  assert.equal(sameProject.reason, "all-projects-busy");
  assert.deepEqual(sameProject.skippedBusy, ["proj-a"]);

  const otherProject = await claimEligible(hubRoot, {
    workerId: "w-global",
    maxActivePerProject: 1,
    [removedHubTotalOption]: 1,
    assignmentStore: noAssignmentStore,
  });
  assert.equal(otherProject.entry.projectId, "proj-b");

  assert.equal((await listQueue(hubRoot)).find((entry) => entry.id === active.id).status, "in_progress");
});

test("Hub concurrency config never emits Hub-wide or ACP total caps", async () => {
  const hubRoot = await tempRoot("cpb-queue-concurrency-env");
  const removedHubTotalOption = ["maxActive", "Total"].join("");
  const removedAcpPoolTotalOption = ["acpPool", "Total"].join("");
  const removedHubTotalEnv = ["CPB_HUB_MAX_ACTIVE", "TOTAL"].join("_");
  const removedPoolTotalEnv = ["CPB_ACP_POOL", "TOTAL"].join("_");
  await import("node:fs/promises").then(({ mkdir, writeFile }) => Promise.all([
    mkdir(hubRoot, { recursive: true }),
    writeFile(
      path.join(hubRoot, "config.json"),
      JSON.stringify({
        concurrency: {
          maxActivePerProject: 4,
          [removedHubTotalOption]: 1,
        },
        acpPool: {
          total: 1,
          providerMax: 5,
        },
      }, null, 2) + "\n",
      "utf8",
    ),
  ]));

  const limits = await resolveHubConcurrencyLimits(hubRoot, {
    [removedHubTotalOption]: 1,
    [removedAcpPoolTotalOption]: 1,
    acpProviderMax: 6,
  });
  const env = hubConcurrencyEnv(limits);

  assert.deepEqual(limits, {
    maxActivePerProject: 4,
    acpProviderMax: 5,
  });
  assert.equal(Object.hasOwn(env, removedHubTotalEnv), false);
  assert.equal(Object.hasOwn(env, removedPoolTotalEnv), false);
  assert.deepEqual(env, {
    CPB_HUB_MAX_ACTIVE_PER_PROJECT: "4",
    CPB_ACP_POOL_PROVIDER_MAX: "5",
  });
});

test("claimEligible applies issue-link and index-unavailable gates", async () => {
  const hubRoot = await tempRoot("cpb-queue-gates");
  const unlinked = await enqueue(hubRoot, { projectId: "proj", description: "missing issue" });
  const linked = await enqueue(hubRoot, {
    projectId: "proj",
    description: "has issue",
    metadata: { issueNumber: 12 },
  });

  const issueGate = await claimEligible(hubRoot, {
    workerId: "w-linked",
    requireIssueLink: true,
    assignmentStore: noAssignmentStore,
  });
  assert.equal(issueGate.entry.id, linked.id);
  assert.equal((await listQueue(hubRoot)).find((entry) => entry.id === unlinked.id).status, "pending");

  const indexHubRoot = await tempRoot("cpb-queue-index");
  const staleIndex = await enqueue(indexHubRoot, { projectId: "indexed", description: "needs index" });
  const indexGate = await claimEligible(indexHubRoot, {
    workerId: "w-index",
    assignmentStore: noAssignmentStore,
    getProjectFn: async (_hubRoot, projectId) => (
      projectId === "indexed"
        ? { id: projectId, sourcePath: null, projectRuntimeRoot: null }
        : null
    ),
  });
  assert.equal(indexGate.entry, null);

  const gated = (await listQueue(indexHubRoot)).find((entry) => entry.id === staleIndex.id);
  assert.equal(gated.status, "codegraph_unavailable");
  assert.equal(gated.metadata.indexFreshness.available, false);
  assert.deepEqual(gated.metadata.indexFreshness.dirtyReasons, ["missing_source_or_runtime_root"]);
});

test("claimEligible blocks registered projects without high-confidence capability maps", async () => {
  const hubRoot = await tempRoot("cpb-queue-capability-map");
  const sourcePath = await tempRoot("cpb-queue-capability-source");
  const projectRuntimeRoot = await tempRoot("cpb-queue-capability-runtime");
  const pending = await enqueue(hubRoot, {
    projectId: "flow",
    description: "needs Project Capability Map",
  });

  const result = await claimEligible(hubRoot, {
    workerId: "w-capability-map",
    assignmentStore: noAssignmentStore,
    getProjectFn: async (_hubRoot, projectId) => (
      projectId === "flow"
        ? { id: "flow", sourcePath, projectRuntimeRoot, metadata: {} }
        : null
    ),
  });

  assert.equal(result.entry, null);
  const gated = (await listQueue(hubRoot)).find((entry) => entry.id === pending.id);
  assert.equal(gated.status, "codegraph_unavailable");
  assert.equal(gated.metadata.capabilityMap.available, false);
  assert.equal(gated.metadata.capabilityMap.reason, "missing_project_capability_map");
});

test("claimEligible blocks high-confidence projects when live CodeGraph readiness is missing", async () => {
  const hubRoot = await tempRoot("cpb-queue-live-codegraph");
  const sourcePath = await sourceWithCodeGraphIndexButNoLiveState("cpb-queue-live-codegraph-source");
  const projectRuntimeRoot = await tempRoot("cpb-queue-live-codegraph-runtime");
  const pending = await enqueue(hubRoot, {
    projectId: "flow",
    sourcePath,
    description: "needs live CodeGraph",
  });

  const result = await claimEligible(hubRoot, {
    workerId: "w-live-codegraph",
    assignmentStore: noAssignmentStore,
    getProjectFn: async (_hubRoot, projectId) => (
      projectId === "flow"
        ? {
          id: "flow",
          sourcePath,
          projectRuntimeRoot,
          metadata: highConfidenceCapabilityMetadata(),
        }
        : null
    ),
  });

  assert.equal(result.entry, null);
  const gated = (await listQueue(hubRoot)).find((entry) => entry.id === pending.id);
  assert.equal(gated.status, "codegraph_unavailable");
  assert.equal(gated.metadata.codegraphReadiness.available, false);
  assert.equal(gated.metadata.codegraphReadiness.reason, "missing_codegraph_state");
  assert.deepEqual(gated.metadata.indexFreshness.dirtyReasons, ["missing_codegraph_state"]);
});

test("codegraph unavailable counters and recovery accept legacy index_unavailable rows", async () => {
  const hubRoot = await tempRoot("cpb-queue-codegraph-legacy");
  const current = await enqueue(hubRoot, { projectId: "proj", description: "current codegraph gate" });
  await updateEntry(hubRoot, current.id, {
    status: "codegraph_unavailable",
    updatedAt: oldIso(),
    metadata: { indexFreshness: { available: false } },
  });
  const legacy = await enqueue(hubRoot, { projectId: "proj", description: "legacy index gate" });
  await updateEntry(hubRoot, legacy.id, {
    status: "index_unavailable",
    updatedAt: oldIso(),
    metadata: { indexFreshness: { available: false } },
  });

  const status = await queueStatus(hubRoot);
  assert.equal(status.indexUnavailable, 2);
  assert.equal(status.codegraphUnavailable, 2);
  assert.equal(status.projects.proj.indexUnavailable, 2);
  assert.equal(status.projects.proj.codegraphUnavailable, 2);

  const first = await claimEligible(hubRoot, {
    workerId: "w-legacy",
    indexUnavailableRetryMs: 1,
    assignmentStore: noAssignmentStore,
  });

  assert.equal(first.entry.id, current.id);
  assert.deepEqual(first.recovered, [current.id, legacy.id]);
  const recovered = await listQueue(hubRoot);
  assert.equal(recovered.find((entry) => entry.id === current.id).status, "in_progress");
  assert.equal(recovered.find((entry) => entry.id === legacy.id).status, "pending");
  assert.equal(recovered.find((entry) => entry.id === legacy.id).metadata.indexFreshness, undefined);
});

test("HubOrchestrator.tick stops on leader lock loss", async () => {
  const hubRoot = await tempRoot("cpb-orch-leader");
  const cpbRoot = await tempRoot("cpb-orch-cpb");
  const orchestrator = new HubOrchestrator(hubRoot, cpbRoot, { executorRoot: process.cwd() });
  let released = false;
  orchestrator.running = true;
  orchestrator.leaderLock = {
    stillHeld: async () => false,
    release: async () => { released = true; },
  } as any;

  const result = await orchestrator.tick();

  assert.deepEqual(result, { stopped: true, reason: "leader lock lost" });
  assert.equal(orchestrator.running, false);
  assert.equal(released, true);
});

test("HubOrchestrator.start releases leadership when initialization fails", async () => {
  const hubRoot = await tempRoot("cpb-orch-start-cleanup");
  const cpbRoot = await tempRoot("cpb-orch-start-cleanup-root");
  const orchestrator = new HubOrchestrator(hubRoot, cpbRoot, { executorRoot: process.cwd() });
  let released = 0;
  orchestrator.leaderLock = {
    acquire: async () => ({ epoch: 1 }),
    startRenewal: () => {},
    release: async () => { released += 1; return true; },
  } as any;
  orchestrator.assignmentStore = {
    init: async () => { throw new Error("assignment init failed"); },
  } as any;

  await assert.rejects(orchestrator.start(), /assignment init failed/);
  assert.equal(released, 1);
  assert.equal(orchestrator.running, false);
});

test("HubOrchestrator publishes readiness only after every initialization stage", async () => {
  const hubRoot = await tempRoot("cpb-orch-ready-order");
  const cpbRoot = await tempRoot("cpb-orch-ready-order-root");
  const orchestrator = new HubOrchestrator(hubRoot, cpbRoot, { executorRoot: process.cwd() });
  const order = [];
  orchestrator.leaderLock = {
    acquire: async () => { order.push("lease"); return { epoch: 1, ready: false }; },
    startRenewal: () => { order.push("renewal"); },
    markReady: async () => { order.push("ready"); return true; },
    release: async () => true,
  } as any;
  orchestrator.assignmentStore = { init: async () => { order.push("assignments"); } } as any;
  orchestrator.workerStore = { init: async () => { order.push("workers"); } } as any;
  orchestrator._startSupervisor = async () => { order.push("supervisor"); return null; };
  orchestrator.reconciler = { recoverRuntime: async () => { order.push("recovery"); } } as any;
  orchestrator.reconcileQueueVsAssignments = async () => { order.push("reconciliation"); };
  orchestrator._scheduleTick = () => { order.push("tick"); };
  orchestrator._scheduleJanitor = () => { order.push("janitor"); };

  await orchestrator.start();
  await orchestrator.stop();

  assert.deepEqual(order, [
    "lease",
    "renewal",
    "assignments",
    "workers",
    "supervisor",
    "recovery",
    "reconciliation",
    "ready",
    "tick",
    "janitor",
  ]);
});

test("HubOrchestrator supervisor initialization failure prevents readiness and releases leadership", async () => {
  const hubRoot = await tempRoot("cpb-orch-supervisor-failure");
  const cpbRoot = await tempRoot("cpb-orch-supervisor-failure-root");
  const orchestrator = new HubOrchestrator(hubRoot, cpbRoot, { executorRoot: process.cwd() });
  let readyCalls = 0;
  let releaseCalls = 0;
  orchestrator.leaderLock = {
    acquire: async () => ({ epoch: 1, ready: false }),
    startRenewal: () => {},
    markReady: async () => { readyCalls += 1; return true; },
    release: async () => { releaseCalls += 1; return true; },
  } as any;
  orchestrator.assignmentStore = { init: async () => {} } as any;
  orchestrator.workerStore = { init: async () => {} } as any;
  orchestrator._startSupervisor = async () => {
    throw new Error("resident supervisor failed");
  };

  await assert.rejects(orchestrator.start(), /resident supervisor failed/);
  assert.equal(readyCalls, 0);
  assert.equal(releaseCalls, 1);
  assert.equal(orchestrator.running, false);
});

test("startup reconciliation preserves a successor worker incarnation", async () => {
  const hubRoot = await tempRoot("cpb-orch-worker-successor");
  const cpbRoot = await tempRoot("cpb-orch-worker-successor-root");
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "successor race" });
  await updateEntry(hubRoot, entry.id, { status: "in_progress" });
  const assignment = {
    assignmentId: `a-${entry.id}`,
    workerId: "worker-successor",
    status: "running",
    activeAttempt: 1,
  };
  const original = workerIdentity(46001, "original");
  const successor = workerIdentity(46002, "successor");
  let workerReads = 0;
  let syntheticFailures = 0;
  let workerUpdates = 0;
  const orchestrator = new HubOrchestrator(hubRoot, cpbRoot, { executorRoot: process.cwd() });
  orchestrator.assignmentStore = {
    getAssignment: async () => assignment,
    writeSyntheticFailure: async () => { syntheticFailures += 1; },
  } as any;
  orchestrator.workerStore = {
    getWorker: async () => {
      workerReads += 1;
      return workerReads === 1
        ? { workerId: assignment.workerId, pid: original.pid, processIdentity: original, incarnationToken: "old", host: "local" }
        : { workerId: assignment.workerId, pid: successor.pid, processIdentity: successor, incarnationToken: "new", host: "local" };
    },
    updateWorkerIf: async () => { workerUpdates += 1; },
  } as any;
  orchestrator._isProcessIdentityAlive = () => false;

  await orchestrator.reconcileQueueVsAssignments();

  assert.equal(syntheticFailures, 0);
  assert.equal(workerUpdates, 0);
  assert.equal((await listQueue(hubRoot)).find((candidate) => candidate.id === entry.id).status, "in_progress");
});

test("startup reconciliation fails closed on an unverified worker liveness probe", async () => {
  const hubRoot = await tempRoot("cpb-orch-worker-eperm");
  const cpbRoot = await tempRoot("cpb-orch-worker-eperm-root");
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "eperm probe" });
  await updateEntry(hubRoot, entry.id, { status: "in_progress" });
  const processIdentity = workerIdentity(47001, "eperm");
  const assignment = {
    assignmentId: `a-${entry.id}`,
    workerId: "worker-eperm",
    status: "running",
    activeAttempt: 1,
  };
  let syntheticFailures = 0;
  const orchestrator = new HubOrchestrator(hubRoot, cpbRoot, { executorRoot: process.cwd() });
  orchestrator.assignmentStore = {
    getAssignment: async () => assignment,
    writeSyntheticFailure: async () => { syntheticFailures += 1; },
  } as any;
  orchestrator.workerStore = {
    getWorker: async () => ({
      workerId: assignment.workerId,
      pid: processIdentity.pid,
      processIdentity,
      incarnationToken: "eperm-token",
      host: "local",
    }),
  } as any;
  orchestrator._isProcessIdentityAlive = () => {
    throw Object.assign(new Error("permission denied"), { code: "EPERM" });
  };

  await assert.rejects(orchestrator.reconcileQueueVsAssignments(), { code: "EPERM" });
  assert.equal(syntheticFailures, 0);
  assert.equal((await listQueue(hubRoot)).find((candidate) => candidate.id === entry.id).status, "in_progress");
});

test("HubOrchestrator scheduler applies provider capacity per provider", async () => {
  const hubRoot = await tempRoot("cpb-orch-provider-capacity");
  const cpbRoot = await tempRoot("cpb-orch-provider-capacity-cpb");
  await writeJson(path.join(hubRoot, "config.json"), {
    scheduler: { mode: "default" },
    acpPool: { providerMax: 1 },
  });
  await registerReadyProject(hubRoot, "proj-a", "cpb-orch-provider-a-source");
  await registerReadyProject(hubRoot, "proj-b", "cpb-orch-provider-b-source");
  await registerReadyProject(hubRoot, "proj-c", "cpb-orch-provider-c-source");
  const activeCodex = await enqueue(hubRoot, {
    projectId: "proj-a",
    description: "active codex",
    metadata: { agents: { executor: { agent: "codex" } } },
  });
  await updateEntry(hubRoot, activeCodex.id, {
    status: "in_progress",
    claimedBy: "w-codex",
    claimedAt: new Date().toISOString(),
  });
  await enqueue(hubRoot, {
    projectId: "proj-b",
    description: "pending codex",
    priority: "P0",
    metadata: { agents: { executor: { agent: "codex" } } },
  });
  const pendingClaude = await enqueue(hubRoot, {
    projectId: "proj-c",
    description: "pending claude",
    priority: "P1",
    metadata: { agents: { executor: { agent: "claude" } } },
  });

  const orchestrator = new HubOrchestrator(hubRoot, cpbRoot, { executorRoot: process.cwd() });
  await orchestrator.assignmentStore.init();
  await orchestrator.workerStore.init();

  const candidates = await orchestrator.scheduler.nextCandidates(10);

  assert.deepEqual(candidates.map((entry) => entry.id), [pendingClaude.id]);
});

test("HubOrchestrator scheduler gates missing project capability maps before dispatch", async () => {
  const hubRoot = await tempRoot("cpb-orch-capability-gate");
  const cpbRoot = await tempRoot("cpb-orch-capability-gate-cpb");
  const sourcePath = await tempRoot("cpb-orch-capability-source");
  await registerProject(hubRoot, { id: "flow", sourcePath, skipCodeGraphGate: true });
  const entry = await enqueue(hubRoot, {
    projectId: "flow",
    sourcePath,
    description: "must not dispatch without capability maps",
  });

  const orchestrator = new HubOrchestrator(hubRoot, cpbRoot, { executorRoot: process.cwd() });
  await orchestrator.assignmentStore.init();
  await orchestrator.workerStore.init();
  await orchestrator.workerStore.registerWorker("w-capability", {
    projectId: "flow",
    status: "ready",
  });
  orchestrator.running = true;
  orchestrator.leaderLock = {
    stillHeld: async () => true,
    getEpoch: () => 7,
    release: async () => {},
  } as any;
  orchestrator.reconciler = { reconcileAssignments: async () => {} } as any;

  const result = await orchestrator.tick();

  assert.deepEqual(result, { idle: true });
  assert.equal(await orchestrator.assignmentStore.getAssignment(`a-${entry.id}`), null);
  const gated = (await listQueue(hubRoot)).find((candidate) => candidate.id === entry.id);
  assert.equal(gated.status, "codegraph_unavailable");
  assert.equal(gated.metadata.capabilityMap.available, false);
  assert.equal(gated.metadata.capabilityMap.reason, "missing_project_capability_map");
});

test("HubOrchestrator scheduler gates missing live CodeGraph readiness before dispatch", async () => {
  const hubRoot = await tempRoot("cpb-orch-live-codegraph");
  const cpbRoot = await tempRoot("cpb-orch-live-codegraph-cpb");
  const sourcePath = await sourceWithCodeGraphIndexButNoLiveState("cpb-orch-live-codegraph-source");
  await registerProject(hubRoot, {
    id: "flow",
    sourcePath,
    skipCodeGraphGate: true,
    metadata: highConfidenceCapabilityMetadata(),
  });
  const entry = await enqueue(hubRoot, {
    projectId: "flow",
    sourcePath,
    description: "must not dispatch without live CodeGraph",
  });

  const orchestrator = new HubOrchestrator(hubRoot, cpbRoot, { executorRoot: process.cwd() });
  await orchestrator.assignmentStore.init();
  await orchestrator.workerStore.init();
  await orchestrator.workerStore.registerWorker("w-live-codegraph", {
    projectId: "flow",
    status: "ready",
  });
  orchestrator.running = true;
  orchestrator.leaderLock = {
    stillHeld: async () => true,
    getEpoch: () => 9,
    release: async () => {},
  } as any;
  orchestrator.reconciler = { reconcileAssignments: async () => {} } as any;

  const result = await orchestrator.tick();

  assert.deepEqual(result, { idle: true });
  assert.equal(await orchestrator.assignmentStore.getAssignment(`a-${entry.id}`), null);
  const gated = (await listQueue(hubRoot)).find((candidate) => candidate.id === entry.id);
  assert.equal(gated.status, "codegraph_unavailable");
  assert.equal(gated.metadata.codegraphReadiness.available, false);
  assert.equal(gated.metadata.codegraphReadiness.reason, "missing_codegraph_state");
});

test("HubOrchestrator scheduler does not oversubscribe one provider in a single tick", async () => {
  const hubRoot = await tempRoot("cpb-orch-provider-same-tick");
  const cpbRoot = await tempRoot("cpb-orch-provider-same-tick-cpb");
  await writeJson(path.join(hubRoot, "config.json"), {
    scheduler: { mode: "default" },
    acpPool: { providerMax: 1 },
  });
  const sourcePath = await registerReadyProject(hubRoot, "flow", "cpb-orch-provider-same-tick-source");
  const first = await enqueue(hubRoot, {
    projectId: "flow",
    sourcePath,
    description: "first codex task",
    metadata: {
      agents: { executor: { agent: "codex" } },
    },
  });
  const second = await enqueue(hubRoot, {
    projectId: "flow",
    sourcePath,
    description: "second codex task",
    metadata: {
      agents: { executor: { agent: "codex" } },
    },
  });

  const orchestrator = new HubOrchestrator(hubRoot, cpbRoot, { executorRoot: process.cwd() });
  await orchestrator.assignmentStore.init();
  await orchestrator.workerStore.init();
  await orchestrator.workerStore.registerWorker("w-one", { projectId: "flow", status: "ready" });
  await orchestrator.workerStore.registerWorker("w-two", { projectId: "flow", status: "ready" });
  orchestrator.running = true;
  orchestrator.leaderLock = {
    stillHeld: async () => true,
    getEpoch: () => 8,
    release: async () => {},
  } as any;
  orchestrator.reconciler = { reconcileAssignments: async () => {} } as any;

  const result = await orchestrator.tick();
  const entries = await listQueue(hubRoot);
  const scheduled = entries.filter((entry) => entry.status === "scheduled");
  const pending = entries.filter((entry) => entry.status === "pending");

  assert.equal(result.dispatched.length, 1);
  assert.equal(scheduled.length, 1);
  assert.equal(pending.length, 1);
  assert.deepEqual(new Set(entries.map((entry) => entry.id)), new Set([first.id, second.id]));
});

test("HubOrchestrator.tick writes inbox then keeps queue, assignment, and worker state aligned", async () => {
  const hubRoot = await tempRoot("cpb-orch-tick");
  const cpbRoot = await tempRoot("cpb-orch-cpb");
  const sourcePath = await tempRoot("cpb-source");
  const entry = await enqueue(hubRoot, {
    projectId: "proj",
    sourcePath,
    description: "dispatch me",
    metadata: { workflow: "complex", planMode: "full", issueNumber: 7 },
  });

  const orchestrator = new HubOrchestrator(hubRoot, cpbRoot, { executorRoot: process.cwd() });
  await orchestrator.assignmentStore.init();
  await orchestrator.workerStore.init();
  const worker = await orchestrator.workerStore.registerWorker("w-dispatch", {
    projectId: "proj",
    status: "ready",
  });
  orchestrator.running = true;
  orchestrator.leaderLock = {
    stillHeld: async () => true,
    getEpoch: () => 42,
    release: async () => {},
  } as any;
  orchestrator.scheduler = {
    nextCandidates: async () => [entry],
    nextCandidate: async () => entry,
    findIdleWorker: async () => worker,
  } as any;
  orchestrator.workerSupervisor = {
    ensureWorkerFor: async () => worker,
  } as any;
  orchestrator.reconciler = { reconcileAssignments: async () => {} } as any;

  const result = await orchestrator.tick();

  assert.equal(result.scheduled, true);
  const queueEntry = (await listQueue(hubRoot))[0];
  assert.equal(queueEntry.status, "scheduled");
  assert.equal(queueEntry.claimedBy, "w-dispatch");

  const assignment = await orchestrator.assignmentStore.getAssignment(`a-${entry.id}`);
  assert.equal(assignment.status, "assigned");
  assert.equal(assignment.activeAttempt, 1);
  assert.equal(assignment.sourceContext.queueEntryId, entry.id);

  const inbox = await orchestrator.workerStore.readInbox("w-dispatch");
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].assignmentId, `a-${entry.id}`);
  assert.equal(inbox[0].attempt, 1);
  assert.equal(typeof inbox[0].attemptToken, "string");
  assert.equal(inbox[0].orchestratorEpoch, 42);

  const updatedWorker = await orchestrator.workerStore.getWorker("w-dispatch");
  assert.equal(updatedWorker.status, "assigned");
  assert.equal(updatedWorker.currentAssignmentId, `a-${entry.id}`);

  const projectJson = path.join(hubRoot, "queue", "queue.json");
  const persisted = await readJson(projectJson);
  assert.equal(persisted.entries[0].status, "scheduled");
});

test("HubOrchestrator does not dispatch a stale candidate changed before reservation", async () => {
  const hubRoot = await tempRoot("cpb-orch-dispatch-cas");
  const cpbRoot = await tempRoot("cpb-orch-dispatch-cas-root");
  const entry = await enqueue(hubRoot, {
    projectId: "proj",
    description: "cancel before reservation",
  });
  const orchestrator = new HubOrchestrator(hubRoot, cpbRoot, { executorRoot: process.cwd() });
  await orchestrator.assignmentStore.init();
  await orchestrator.workerStore.init();
  orchestrator.running = true;
  orchestrator.leaderLock = {
    stillHeld: async () => true,
    getEpoch: () => 43,
    release: async () => {},
  } as any;
  orchestrator.scheduler = {
    nextCandidates: async () => {
      await updateEntry(hubRoot, entry.id, { status: "cancelled" });
      return [entry];
    },
  } as any;
  orchestrator.reconciler = { reconcileAssignments: async () => {} } as any;

  const result = await orchestrator.tick();
  const current = (await listQueue(hubRoot)).find((candidate) => candidate.id === entry.id);

  assert.deepEqual(result, { idle: true });
  assert.equal(current.status, "cancelled");
  assert.equal(await orchestrator.assignmentStore.getAssignment(`a-${entry.id}`), null);
});
