import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  loadRegistry,
  mutateRegistry,
  registerProject,
  saveRegistry,
  updateProject,
  withHubRegistryTestHooks,
} from "../server/services/hub/hub-registry.js";
import { writeProjectIndex } from "../server/services/project-index.js";
import { captureCurrentProcessIdentity } from "../core/runtime/process-tree.js";

async function fixture() {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-registry-"));
  const sourcePath = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-source-"));
  const project = await registerProject(hubRoot, {
    id: "project",
    sourcePath,
    skipCodeGraphGate: true,
  });
  return { hubRoot, sourcePath, projectId: project.id };
}

async function runChild(script: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`registry child failed (${code ?? signal}): ${stderr}`));
    });
  });
}

function deadExactProcessIdentity(pid = 2_147_483_647) {
  const birthId = "dead-registry-owner";
  return {
    pid,
    birthId,
    birthIdPrecision: "exact" as const,
    incarnation: `${pid}:${birthId}`,
    capturedAt: new Date(0).toISOString(),
  };
}

test("registry transactions serialize concurrent read-modify-write operations", async () => {
  const { hubRoot, projectId } = await fixture();

  await Promise.all(Array.from({ length: 24 }, async () => {
    await mutateRegistry(hubRoot, async (registry) => {
      const project = registry.projects[projectId];
      const metadata = project.metadata || {};
      const counter = Number(metadata.concurrentCounter || 0);
      await delay(2);
      project.metadata = { ...metadata, concurrentCounter: counter + 1 };
    });
  }));

  const registry = await loadRegistry(hubRoot);
  assert.equal(registry.projects[projectId].metadata?.concurrentCounter, 24);
  assert.equal(registry.revision, 25);
});

test("registry transactions serialize real competing Node processes", async () => {
  const { hubRoot, projectId } = await fixture();
  const moduleUrl = new URL("../server/services/hub/hub-registry.js", import.meta.url).href;
  const script = `
    import { mutateRegistry } from ${JSON.stringify(moduleUrl)};
    const [hubRoot, projectId, iterationsText] = process.argv.slice(1);
    for (let index = 0; index < Number(iterationsText); index += 1) {
      await mutateRegistry(hubRoot, async (registry) => {
        const project = registry.projects[projectId];
        const metadata = project.metadata || {};
        const counter = Number(metadata.processCounter || 0);
        await new Promise((resolve) => setTimeout(resolve, 2));
        project.metadata = { ...metadata, processCounter: counter + 1 };
      });
    }
  `;

  await Promise.all(Array.from({ length: 4 }, () => runChild(script, [hubRoot, projectId, "8"])));
  const registry = await loadRegistry(hubRoot);
  assert.equal(registry.projects[projectId].metadata?.processCounter, 32);
  assert.equal(registry.revision, 33);
});

test("saveRegistry rejects a stale snapshot instead of losing a committed update", async () => {
  const { hubRoot, projectId } = await fixture();
  const first = await loadRegistry(hubRoot);
  const stale = await loadRegistry(hubRoot);

  first.projects[projectId].metadata = { committed: true };
  await saveRegistry(hubRoot, first);

  stale.projects[projectId].metadata = { staleOverwrite: true };
  await assert.rejects(
    saveRegistry(hubRoot, stale),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "HUB_REGISTRY_CONFLICT");
      return true;
    },
  );

  const registry = await loadRegistry(hubRoot);
  assert.equal(registry.projects[projectId].metadata?.committed, true);
  assert.equal(registry.projects[projectId].metadata?.staleOverwrite, undefined);
});

test("project index persistence participates in the registry transaction", async () => {
  const { hubRoot, projectId } = await fixture();
  let releaseTransaction!: () => void;
  const transactionMayFinish = new Promise<void>((resolve) => {
    releaseTransaction = resolve;
  });
  let transactionStarted!: () => void;
  const transactionIsRunning = new Promise<void>((resolve) => {
    transactionStarted = resolve;
  });

  const metadataUpdate = mutateRegistry(hubRoot, async (registry) => {
    transactionStarted();
    await transactionMayFinish;
    const project = registry.projects[projectId];
    project.metadata = { ...(project.metadata || {}), concurrentMarker: "preserved" };
  });
  await transactionIsRunning;

  let indexSettled = false;
  const indexUpdate = writeProjectIndex(hubRoot, null, projectId, {
    state: "indexed",
    branch: "main",
    gitHead: "1234567890abcdef",
    timestamp: new Date().toISOString(),
  }).finally(() => {
    indexSettled = true;
  });

  await delay(30);
  assert.equal(indexSettled, false, "project index write bypassed the active registry transaction");
  releaseTransaction();
  await Promise.all([metadataUpdate, indexUpdate]);

  const registry = await loadRegistry(hubRoot);
  assert.equal(registry.projects[projectId].metadata?.concurrentMarker, "preserved");
  const projectIndex = registry.projects[projectId].metadata?.projectIndex as { state?: string } | undefined;
  assert.equal(projectIndex?.state, "indexed");
});

test("a legacy same-host registry owner fails closed without losing evidence", async () => {
  const { hubRoot, projectId } = await fixture();
  const lockDir = path.join(hubRoot, "projects.json.lock");
  const lockFile = path.join(lockDir, "lock.json");
  const legacyOwner = `${JSON.stringify({
    format: "cpb-hub-registry-lock/v1",
    ownerToken: "live-owner",
    ownerPid: process.pid,
    ownerHost: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
  })}\n`;
  await mkdir(lockDir);
  await writeFile(lockFile, legacyOwner);

  await assert.rejects(
    updateProject(hubRoot, projectId, { name: "must-not-commit" }),
    { code: "HUB_REGISTRY_LOCK_UNSAFE" },
  );
  assert.equal(await readFile(lockFile, "utf8"), legacyOwner);
  assert.notEqual((await loadRegistry(hubRoot)).projects[projectId].name, "must-not-commit");
});

test("new registry locks persist the current process incarnation", async () => {
  const { hubRoot, projectId } = await fixture();
  const currentIdentity = captureCurrentProcessIdentity();
  assert.ok(currentIdentity);
  let observedOwner: Record<string, unknown> | null = null;

  await withHubRegistryTestHooks({
    async beforeLockReleaseRemove(lockDir) {
      observedOwner = JSON.parse(await readFile(path.join(lockDir, "lock.json"), "utf8"));
    },
  }, () => updateProject(hubRoot, projectId, { name: "identity-bound" }));

  assert.equal(observedOwner?.format, "cpb-hub-registry-lock/v2");
  assert.equal(
    (observedOwner?.processIdentity as { incarnation?: string } | undefined)?.incarnation,
    currentIdentity.incarnation,
  );
  assert.equal(
    (observedOwner?.processIdentity as { birthIdPrecision?: string } | undefined)?.birthIdPrecision,
    "exact",
  );
  const siblings = await readdir(hubRoot);
  const released = siblings.filter((entry) => entry.startsWith("projects.json.lock.released-"));
  assert.ok(released.length > 0, "released registry locks remain quarantined as recovery evidence");
  const releasedOwners = await Promise.all(released.map(async (entry) => (
    JSON.parse(await readFile(path.join(hubRoot, entry, "lock.json"), "utf8"))
  )));
  assert.equal(releasedOwners.some((owner) => owner.ownerToken === observedOwner?.ownerToken), true);
});

test("a stale legacy lock owned by a dead same-host process is not auto-recovered", async () => {
  const { hubRoot, projectId } = await fixture();
  const lockDir = path.join(hubRoot, "projects.json.lock");
  const lockFile = path.join(lockDir, "lock.json");
  const legacyOwner = `${JSON.stringify({
    format: "cpb-hub-registry-lock/v1",
    ownerToken: "dead-owner",
    ownerPid: 2_147_483_647,
    ownerHost: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
  })}\n`;
  await mkdir(lockDir);
  await writeFile(lockFile, legacyOwner);
  const old = new Date(0);
  await utimes(lockDir, old, old);

  await assert.rejects(
    updateProject(hubRoot, projectId, { name: "must-not-recover" }),
    { code: "HUB_REGISTRY_LOCK_UNSAFE" },
  );
  assert.equal(await readFile(lockFile, "utf8"), legacyOwner);
  assert.notEqual((await loadRegistry(hubRoot)).projects[projectId].name, "must-not-recover");
});

test("registry lock reads do not bind a predecessor owner to a successor pathname", async () => {
  const { hubRoot, projectId } = await fixture();
  const lockDir = path.join(hubRoot, "projects.json.lock");
  const lockFile = path.join(lockDir, "lock.json");
  const predecessorFile = path.join(lockDir, "lock.predecessor.json");
  const deadIdentity = deadExactProcessIdentity();
  const successorIdentity = captureCurrentProcessIdentity();
  assert.ok(successorIdentity);
  const predecessor = `${JSON.stringify({
    format: "cpb-hub-registry-lock/v2",
    ownerToken: "dead-predecessor-owner",
    ownerPid: deadIdentity.pid,
    ownerHost: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: deadIdentity,
  })}\n`;
  const successor = `${JSON.stringify({
    format: "cpb-hub-registry-lock/v2",
    ownerToken: "live-successor-owner",
    ownerPid: process.pid,
    ownerHost: os.hostname(),
    acquiredAt: new Date().toISOString(),
    processIdentity: successorIdentity,
  })}\n`;
  await mkdir(lockDir);
  await writeFile(lockFile, predecessor);
  const epoch = new Date(0);
  await utimes(lockDir, epoch, epoch);
  let replaced = false;

  await withHubRegistryTestHooks({
    async afterBoundedFileHandleRead(filePath) {
      if (filePath !== lockFile || replaced) return;
      replaced = true;
      await rename(lockFile, predecessorFile);
      await writeFile(lockFile, successor);
    },
  }, async () => {
    await assert.rejects(
      updateProject(hubRoot, projectId, { name: "must-not-bind-predecessor" }),
      { code: "HUB_REGISTRY_LOCK_UNSAFE" },
    );
  });

  assert.equal(replaced, true);
  assert.equal(await readFile(predecessorFile, "utf8"), predecessor);
  assert.equal(await readFile(lockFile, "utf8"), successor);
  const siblings = await readdir(path.dirname(lockDir));
  assert.equal(siblings.some((entry) => entry.startsWith(`${path.basename(lockDir)}.stale-`)), false);
  assert.notEqual((await loadRegistry(hubRoot)).projects[projectId].name, "must-not-bind-predecessor");
});

test("registry lock preserves an empty successor created during quarantine", async () => {
  const { hubRoot, projectId } = await fixture();
  const lockDir = path.join(hubRoot, "projects.json.lock");
  const deadIdentity = deadExactProcessIdentity();
  await mkdir(lockDir);
  await writeFile(path.join(lockDir, "lock.json"), `${JSON.stringify({
    format: "cpb-hub-registry-lock/v2",
    ownerToken: "dead-owner",
    ownerPid: deadIdentity.pid,
    ownerHost: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: deadIdentity,
  })}\n`);
  const old = new Date(0);
  await utimes(lockDir, old, old);

  await withHubRegistryTestHooks({
    async afterRegistryLockQuarantineRename({ lockDir: originalLockDir }) {
      await mkdir(originalLockDir);
    },
  }, async () => {
    await assert.rejects(
      updateProject(hubRoot, projectId, { name: "must-not-commit-over-successor" }),
      { code: "HUB_REGISTRY_LOCK_SUCCESSOR_PRESERVED" },
    );
  });

  await assert.rejects(readFile(path.join(lockDir, "lock.json"), "utf8"), { code: "ENOENT" });
  const siblings = await readdir(path.dirname(lockDir));
  assert.equal(siblings.some((entry) => entry.startsWith(`${path.basename(lockDir)}.stale-`)), true);
});

test("registry lock preserves a same-token successor created during quarantine", async () => {
  const { hubRoot, projectId } = await fixture();
  const lockDir = path.join(hubRoot, "projects.json.lock");
  const deadIdentity = deadExactProcessIdentity();
  const currentIdentity = captureCurrentProcessIdentity();
  assert.ok(currentIdentity);
  const predecessor = {
    format: "cpb-hub-registry-lock/v2",
    ownerToken: "same-token-owner",
    ownerPid: deadIdentity.pid,
    ownerHost: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: deadIdentity,
  };
  await mkdir(lockDir);
  await writeFile(path.join(lockDir, "lock.json"), `${JSON.stringify(predecessor)}\n`);
  const old = new Date(0);
  await utimes(lockDir, old, old);
  let quarantineDir = "";

  await withHubRegistryTestHooks({
    async afterRegistryLockQuarantineRename(context) {
      quarantineDir = context.quarantineDir;
      await mkdir(context.lockDir);
      await writeFile(path.join(context.lockDir, "lock.json"), `${JSON.stringify({
        ...predecessor,
        ownerPid: process.pid,
        acquiredAt: new Date().toISOString(),
        processIdentity: currentIdentity,
      })}\n`);
    },
  }, async () => {
    await assert.rejects(
      updateProject(hubRoot, projectId, { name: "must-not-overwrite-same-token-successor" }),
      (error: unknown) => {
        const actual = error as { code?: unknown; committed?: unknown; recoveryPaths?: { quarantineDir?: unknown; lockDir?: unknown } };
        assert.equal(actual.code, "HUB_REGISTRY_LOCK_SUCCESSOR_PRESERVED");
        assert.equal(actual.committed, true);
        assert.equal(actual.recoveryPaths?.quarantineDir, quarantineDir);
        assert.equal(actual.recoveryPaths?.lockDir, lockDir);
        return true;
      },
    );
  });

  const successor = JSON.parse(await readFile(path.join(lockDir, "lock.json"), "utf8"));
  assert.equal(successor.ownerToken, "same-token-owner");
  assert.equal(successor.ownerPid, process.pid);
  assert.equal(JSON.parse(await readFile(path.join(quarantineDir, "lock.json"), "utf8")).ownerPid, deadIdentity.pid);
});

test("registry lock preserves quarantine when ownership changes during recovery", async () => {
  const { hubRoot, projectId } = await fixture();
  const lockDir = path.join(hubRoot, "projects.json.lock");
  const lockFile = path.join(lockDir, "lock.json");
  const deadIdentity = deadExactProcessIdentity();
  const predecessor = {
    format: "cpb-hub-registry-lock/v2",
    ownerToken: "dead-owner",
    ownerPid: deadIdentity.pid,
    ownerHost: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: deadIdentity,
  };
  await mkdir(lockDir);
  await writeFile(lockFile, `${JSON.stringify(predecessor)}\n`);
  const old = new Date(0);
  await utimes(lockDir, old, old);

  let quarantineDir = "";
  await withHubRegistryTestHooks({
    async afterRegistryLockQuarantineRename(context) {
      quarantineDir = context.quarantineDir;
      await writeFile(path.join(context.quarantineDir, "lock.json"), `${JSON.stringify({
        ...predecessor,
        ownerToken: "changed-during-quarantine",
      })}\n`);
    },
  }, async () => {
    await assert.rejects(
      updateProject(hubRoot, projectId, { name: "must-not-commit-after-quarantine-change" }),
      (err) => {
        const actual = err as { code?: unknown; committed?: unknown; recoveryPaths?: { lockDir?: unknown; quarantineDir?: unknown } };
        assert.equal(actual.code, "HUB_REGISTRY_LOCK_RESTORE_FAILED");
        assert.equal(actual.committed, true);
        assert.equal(actual.recoveryPaths?.lockDir, lockDir);
        assert.equal(actual.recoveryPaths?.quarantineDir, quarantineDir);
        return true;
      },
    );
  });

  assert.ok(quarantineDir);
  await assert.rejects(readFile(lockFile, "utf8"), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readFile(path.join(quarantineDir, "lock.json"), "utf8")), {
    ...predecessor,
    ownerToken: "changed-during-quarantine",
  });
  const siblings = await readdir(path.dirname(lockDir));
  assert.equal(siblings.includes(path.basename(quarantineDir)), true);
  assert.notEqual((await loadRegistry(hubRoot)).projects[projectId].name, "must-not-commit-after-quarantine-change");
});

test("registry lock exact owner comparison includes timestamp and release marker fields", async () => {
  const { hubRoot, projectId } = await fixture();
  const lockDir = path.join(hubRoot, "projects.json.lock");
  const deadIdentity = deadExactProcessIdentity();
  const predecessor = {
    format: "cpb-hub-registry-lock/v2",
    ownerToken: "dead-owner",
    ownerPid: deadIdentity.pid,
    ownerHost: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: deadIdentity,
  };
  await mkdir(lockDir);
  await writeFile(path.join(lockDir, "lock.json"), `${JSON.stringify(predecessor)}\n`);
  const old = new Date(0);
  await utimes(lockDir, old, old);

  let quarantineDir = "";
  await withHubRegistryTestHooks({
    async afterRegistryLockQuarantineRename(context) {
      quarantineDir = context.quarantineDir;
      await writeFile(path.join(context.quarantineDir, "lock.json"), `${JSON.stringify({
        ...predecessor,
        acquiredAt: new Date(1).toISOString(),
        releaseFailedAt: new Date(2).toISOString(),
      })}\n`);
    },
  }, async () => {
    await assert.rejects(
      updateProject(hubRoot, projectId, { name: "must-not-commit-after-owner-record-change" }),
      (err) => {
        const actual = err as { code?: unknown; committed?: unknown; committedPath?: unknown; recoveryPaths?: { lockDir?: unknown; quarantineDir?: unknown } };
        assert.equal(actual.code, "HUB_REGISTRY_LOCK_RESTORE_FAILED");
        assert.equal(actual.committed, true);
        assert.equal(actual.committedPath, quarantineDir);
        assert.equal(actual.recoveryPaths?.lockDir, lockDir);
        assert.equal(actual.recoveryPaths?.quarantineDir, quarantineDir);
        return true;
      },
    );
  });

  assert.deepEqual(JSON.parse(await readFile(path.join(quarantineDir, "lock.json"), "utf8")), {
    ...predecessor,
    acquiredAt: new Date(1).toISOString(),
    releaseFailedAt: new Date(2).toISOString(),
  });
  assert.notEqual((await loadRegistry(hubRoot)).projects[projectId].name, "must-not-commit-after-owner-record-change");
});

test("registry lock quarantine detects post-validation replacement and preserves evidence", async () => {
  const { hubRoot, projectId } = await fixture();
  const lockDir = path.join(hubRoot, "projects.json.lock");
  const deadIdentity = deadExactProcessIdentity();
  const predecessor = {
    format: "cpb-hub-registry-lock/v2",
    ownerToken: "dead-owner",
    ownerPid: deadIdentity.pid,
    ownerHost: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: deadIdentity,
  };
  await mkdir(lockDir);
  await writeFile(path.join(lockDir, "lock.json"), `${JSON.stringify(predecessor)}\n`);
  const old = new Date(0);
  await utimes(lockDir, old, old);

  let quarantineDir = "";
  let preservedQuarantine = "";
  await withHubRegistryTestHooks({
    async beforeRegistryLockQuarantineFinalCheck(context) {
      quarantineDir = context.quarantineDir;
      preservedQuarantine = `${context.quarantineDir}.preserved`;
      await rename(context.quarantineDir, preservedQuarantine);
      await mkdir(context.quarantineDir);
      await writeFile(path.join(context.quarantineDir, "lock.json"), `${JSON.stringify({
        ...predecessor,
        ownerToken: "replacement-owner",
      })}\n`);
    },
  }, async () => {
    await assert.rejects(
      updateProject(hubRoot, projectId, { name: "must-not-commit-after-final-replacement" }),
      (err) => {
        const actual = err as { code?: unknown; committed?: unknown; committedPath?: unknown; recoveryPaths?: { lockDir?: unknown; quarantineDir?: unknown } };
        assert.equal(actual.code, "HUB_REGISTRY_LOCK_RESTORE_FAILED");
        assert.equal(actual.committed, true);
        assert.equal(actual.committedPath, quarantineDir);
        assert.equal(actual.recoveryPaths?.lockDir, lockDir);
        assert.equal(actual.recoveryPaths?.quarantineDir, quarantineDir);
        return true;
      },
    );
  });

  assert.deepEqual(JSON.parse(await readFile(path.join(preservedQuarantine, "lock.json"), "utf8")), predecessor);
  assert.equal(JSON.parse(await readFile(path.join(quarantineDir, "lock.json"), "utf8")).ownerToken, "replacement-owner");
  assert.notEqual((await loadRegistry(hubRoot)).projects[projectId].name, "must-not-commit-after-final-replacement");
});

test("a v2 registry lock is recovered when the PID belongs to a successor incarnation", async () => {
  const { hubRoot, projectId } = await fixture();
  const lockDir = path.join(hubRoot, "projects.json.lock");
  const currentIdentity = captureCurrentProcessIdentity();
  assert.ok(currentIdentity);
  const predecessorBirthId = `${currentIdentity.birthId}-predecessor`;
  await mkdir(lockDir);
  await writeFile(path.join(lockDir, "lock.json"), `${JSON.stringify({
    format: "cpb-hub-registry-lock/v2",
    ownerToken: "reused-pid-owner",
    ownerPid: process.pid,
    ownerHost: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: {
      ...currentIdentity,
      birthIdPrecision: "exact",
      birthId: predecessorBirthId,
      incarnation: `${process.pid}:${predecessorBirthId}`,
    },
  })}\n`);
  const old = new Date(0);
  await utimes(lockDir, old, old);

  const updated = await updateProject(hubRoot, projectId, { name: "pid-reuse-recovered" });
  assert.equal(updated?.name, "pid-reuse-recovered");
  const siblings = await readdir(hubRoot);
  assert.equal(siblings.some((entry) => entry.startsWith(`${path.basename(lockDir)}.stale-`)), true);
});

test("a v2 registry lock with persisted coarse identity fails closed", async () => {
  const { hubRoot, projectId } = await fixture();
  const lockDir = path.join(hubRoot, "projects.json.lock");
  const currentIdentity = captureCurrentProcessIdentity();
  assert.ok(currentIdentity);
  await mkdir(lockDir);
  await writeFile(path.join(lockDir, "lock.json"), `${JSON.stringify({
    format: "cpb-hub-registry-lock/v2",
    ownerToken: "coarse-owner",
    ownerPid: process.pid,
    ownerHost: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: {
      ...currentIdentity,
      birthIdPrecision: "coarse",
    },
  })}\n`);
  const old = new Date(0);
  await utimes(lockDir, old, old);

  await assert.rejects(
    updateProject(hubRoot, projectId, { name: "must-not-force" }),
    { code: "HUB_REGISTRY_LOCK_UNSAFE" },
  );
});

test("a v2 registry lock missing an exact process identity fails closed without losing evidence", async () => {
  const { hubRoot, projectId } = await fixture();
  const lockDir = path.join(hubRoot, "projects.json.lock");
  const lockFile = path.join(lockDir, "lock.json");
  const ownerWithoutIdentity = `${JSON.stringify({
    format: "cpb-hub-registry-lock/v2",
    ownerToken: "identity-missing-owner",
    ownerPid: 2_147_483_647,
    ownerHost: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
  })}\n`;
  await mkdir(lockDir);
  await writeFile(lockFile, ownerWithoutIdentity);
  const old = new Date(0);
  await utimes(lockDir, old, old);

  await assert.rejects(
    updateProject(hubRoot, projectId, { name: "must-not-force" }),
    { code: "HUB_REGISTRY_LOCK_UNSAFE" },
  );
  assert.equal(await readFile(lockFile, "utf8"), ownerWithoutIdentity);
  assert.notEqual((await loadRegistry(hubRoot)).projects[projectId].name, "must-not-force");
});

test("registry stale recovery holds a kernel fence against a third contender", async () => {
  const { hubRoot, projectId } = await fixture();
  const lockDir = path.join(hubRoot, "projects.json.lock");
  const deadIdentity = deadExactProcessIdentity();
  await mkdir(lockDir);
  await writeFile(path.join(lockDir, "lock.json"), `${JSON.stringify({
    format: "cpb-hub-registry-lock/v2",
    ownerToken: "dead-predecessor",
    ownerPid: deadIdentity.pid,
    ownerHost: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: deadIdentity,
  })}\n`);
  const old = new Date(0);
  await utimes(lockDir, old, old);

  let observedResolve!: () => void;
  const observed = new Promise<void>((resolve) => { observedResolve = resolve; });
  let resumeResolve!: () => void;
  const resume = new Promise<void>((resolve) => { resumeResolve = resolve; });
  let activeCallbacks = 0;
  let maxActiveCallbacks = 0;
  const mutation = async (name: string) => {
    activeCallbacks += 1;
    maxActiveCallbacks = Math.max(maxActiveCallbacks, activeCallbacks);
    await delay(20);
    activeCallbacks -= 1;
    return { name };
  };

  const first = withHubRegistryTestHooks({
    async afterRegistryLockRecoveryObserved() {
      observedResolve();
      await resume;
    },
  }, () => mutateRegistry(hubRoot, async (registry) => {
    const result = await mutation("first");
    registry.projects[projectId].name = result.name;
  }));
  await observed;
  let secondEntered = false;
  const second = mutateRegistry(hubRoot, async (registry) => {
    secondEntered = true;
    const result = await mutation("second");
    registry.projects[projectId].name = result.name;
  });
  await delay(50);
  assert.equal(secondEntered, false, "third contender bypassed the registry recovery fence");
  resumeResolve();
  await Promise.all([first, second]);
  assert.equal(maxActiveCallbacks, 1);
});

test("malformed registry lock metadata fails closed without quarantine", async () => {
  const { hubRoot, projectId } = await fixture();
  const lockDir = path.join(hubRoot, "projects.json.lock");
  const lockFile = path.join(lockDir, "lock.json");
  await mkdir(lockDir);
  await writeFile(lockFile, "{not-json\n");
  const old = new Date(0);
  await utimes(lockDir, old, old);

  await assert.rejects(
    updateProject(hubRoot, projectId, { name: "must-not-commit" }),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "HUB_REGISTRY_LOCK_UNSAFE");
      return true;
    },
  );
  assert.equal(await readFile(lockFile, "utf8"), "{not-json\n");
});

test("a symbolic-link registry lock is rejected without touching its target", async () => {
  const { hubRoot, projectId } = await fixture();
  const external = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-lock-target-"));
  const sentinel = path.join(external, "sentinel.txt");
  await writeFile(sentinel, "preserve\n");
  await symlink(external, path.join(hubRoot, "projects.json.lock"));

  await assert.rejects(
    updateProject(hubRoot, projectId, { name: "must-not-commit" }),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "HUB_REGISTRY_LOCK_UNSAFE");
      return true;
    },
  );
  assert.equal(await readFile(sentinel, "utf8"), "preserve\n");
});

test("a symbolic-link registry file is rejected without modifying its target", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-registry-link-"));
  const external = path.join(await mkdtemp(path.join(os.tmpdir(), "cpb-hub-registry-target-")), "target.json");
  const original = `${JSON.stringify({ version: 1, revision: 0, projects: {} })}\n`;
  await writeFile(external, original);
  await symlink(external, path.join(hubRoot, "projects.json"));

  await assert.rejects(
    loadRegistry(hubRoot),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "HUB_REGISTRY_UNSAFE");
      return true;
    },
  );
  await assert.rejects(
    saveRegistry(hubRoot, { projects: {} }),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "HUB_REGISTRY_UNSAFE");
      return true;
    },
  );
  assert.equal(await readFile(external, "utf8"), original);
});

test("bounded registry reads reject an in-place generation change between preflight and open", async () => {
  const { hubRoot } = await fixture();
  const registryFile = path.join(hubRoot, "projects.json");
  let changed = false;

  await withHubRegistryTestHooks({
    async afterBoundedFilePreflight(filePath) {
      if (filePath !== registryFile || changed) return;
      changed = true;
      const epoch = new Date(0);
      await utimes(registryFile, epoch, epoch);
    },
  }, async () => {
    await assert.rejects(loadRegistry(hubRoot), { code: "HUB_REGISTRY_UNSAFE" });
  });
  assert.equal(changed, true);
});

test("bounded registry reads reject a successor pathname installed after handle read", async () => {
  const { hubRoot } = await fixture();
  const registryFile = path.join(hubRoot, "projects.json");
  const predecessorFile = `${registryFile}.predecessor`;
  const predecessor = await readFile(registryFile, "utf8");
  const successorRecord = JSON.parse(predecessor) as { revision: number; mutationId?: string | null };
  successorRecord.revision += 100;
  successorRecord.mutationId = "successor-generation";
  const successor = `${JSON.stringify(successorRecord, null, 2)}\n`;
  let replaced = false;

  await withHubRegistryTestHooks({
    async afterBoundedFileHandleRead(filePath) {
      if (filePath !== registryFile || replaced) return;
      replaced = true;
      await rename(registryFile, predecessorFile);
      await writeFile(registryFile, successor);
    },
  }, async () => {
    await assert.rejects(loadRegistry(hubRoot), { code: "HUB_REGISTRY_UNSAFE" });
  });
  assert.equal(replaced, true);
  assert.equal(await readFile(predecessorFile, "utf8"), predecessor);
  assert.equal(await readFile(registryFile, "utf8"), successor);
});

test("bounded registry reads retain the unsafe domain error for a symlink successor pathname", async () => {
  const { hubRoot } = await fixture();
  const registryFile = path.join(hubRoot, "projects.json");
  const predecessorFile = `${registryFile}.predecessor`;
  const externalFile = path.join(await mkdtemp(path.join(os.tmpdir(), "cpb-registry-successor-target-")), "target.json");
  const sentinel = "external successor must remain untouched\n";
  await writeFile(externalFile, sentinel);
  let replaced = false;

  await withHubRegistryTestHooks({
    async afterBoundedFileHandleRead(filePath) {
      if (filePath !== registryFile || replaced) return;
      replaced = true;
      await rename(registryFile, predecessorFile);
      await symlink(externalFile, registryFile);
    },
  }, async () => {
    await assert.rejects(loadRegistry(hubRoot), { code: "HUB_REGISTRY_UNSAFE" });
  });
  assert.equal(replaced, true);
  assert.equal(await readFile(externalFile, "utf8"), sentinel);
});

test("bounded registry reads retain the too-large domain error for an oversized successor pathname", async () => {
  const { hubRoot } = await fixture();
  const registryFile = path.join(hubRoot, "projects.json");
  const predecessorFile = `${registryFile}.predecessor`;
  let replaced = false;

  await withHubRegistryTestHooks({
    async afterBoundedFileHandleRead(filePath) {
      if (filePath !== registryFile || replaced) return;
      replaced = true;
      await rename(registryFile, predecessorFile);
      const successor = await open(registryFile, "w");
      await successor.truncate(16 * 1024 * 1024 + 1);
      await successor.close();
    },
  }, async () => {
    await assert.rejects(loadRegistry(hubRoot), { code: "HUB_REGISTRY_TOO_LARGE" });
  });
  assert.equal(replaced, true);
});

test("registry writes preserve failed temp generations instead of unlinking by pathname", async () => {
  const { hubRoot, projectId } = await fixture();
  const registryFile = path.join(hubRoot, "projects.json");
  let tempPath = "";

  await withHubRegistryTestHooks({
    beforeAtomicRename(context) {
      if (context.filePath !== registryFile || tempPath) return;
      tempPath = context.tmpPath;
      throw Object.assign(new Error("abort before registry publish"), { code: "EINJECTED" });
    },
  }, async () => {
    await assert.rejects(
      updateProject(hubRoot, projectId, { name: "must-not-publish" }),
      { code: "EINJECTED" },
    );
  });

  assert.ok(tempPath);
  assert.equal((await lstat(tempPath)).isFile(), true, "failed temp generation remains as recovery evidence");
  const preserved = JSON.parse(await readFile(tempPath, "utf8")) as { projects?: Record<string, { name?: string }> };
  assert.equal(preserved.projects?.[projectId]?.name, "must-not-publish");
  assert.notEqual((await loadRegistry(hubRoot)).projects[projectId].name, "must-not-publish");
});

test("registry directory sync rejects a symlinked parent after commit and preserves recovery evidence", async () => {
  const { hubRoot, projectId } = await fixture();
  const registryFile = path.join(hubRoot, "projects.json");
  const preservedHubRoot = `${hubRoot}.preserved`;
  const externalHubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-registry-external-"));
  const externalSentinel = path.join(externalHubRoot, "sentinel.txt");
  await writeFile(externalSentinel, "external must remain untouched\n");
  let replacedParent = false;

  await withHubRegistryTestHooks({
    async afterAtomicRename(filePath) {
      if (filePath !== registryFile || replacedParent) return;
      replacedParent = true;
      await rename(hubRoot, preservedHubRoot);
      await symlink(externalHubRoot, hubRoot);
    },
  }, async () => {
    await assert.rejects(
      updateProject(hubRoot, projectId, { name: "committed-before-symlinked-parent" }),
      (error: unknown) => {
        const actual = error as { code?: unknown; committed?: unknown; mutationId?: unknown; outcome?: { status?: unknown } };
        assert.equal(actual.code, "HUB_REGISTRY_COMMIT_UNKNOWN");
        assert.equal(actual.committed, false);
        assert.equal(typeof actual.mutationId, "string");
        assert.equal(actual.outcome?.status, "unknown");
        return true;
      },
    );
  });

  assert.equal(replacedParent, true);
  assert.equal((await lstat(hubRoot)).isSymbolicLink(), true);
  assert.equal(await readFile(externalSentinel, "utf8"), "external must remain untouched\n");
  const preservedRegistry = JSON.parse(await readFile(path.join(preservedHubRoot, "projects.json"), "utf8")) as {
    projects?: Record<string, { name?: string }>;
  };
  assert.equal(preservedRegistry.projects?.[projectId]?.name, "committed-before-symlinked-parent");
});

test("oversized registry and lock metadata files fail closed with bounded errors", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-registry-large-"));
  const registryHandle = await open(path.join(hubRoot, "projects.json"), "w");
  await registryHandle.truncate(16 * 1024 * 1024 + 1);
  await registryHandle.close();
  await assert.rejects(
    loadRegistry(hubRoot),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "HUB_REGISTRY_TOO_LARGE");
      return true;
    },
  );

  await rm(path.join(hubRoot, "projects.json"));
  const sourcePath = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-large-source-"));
  const project = await registerProject(hubRoot, { id: "project", sourcePath, skipCodeGraphGate: true });
  const lockDir = path.join(hubRoot, "projects.json.lock");
  await mkdir(lockDir);
  const lockHandle = await open(path.join(lockDir, "lock.json"), "w");
  await lockHandle.truncate(16 * 1024 + 1);
  await lockHandle.close();
  await assert.rejects(
    updateProject(hubRoot, project.id, { name: "must-not-commit" }),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "HUB_REGISTRY_LOCK_TOO_LARGE");
      return true;
    },
  );
});

test("a transaction that loses its lock token cannot commit or remove the successor lock", async () => {
  const { hubRoot, projectId } = await fixture();
  const lockDir = path.join(hubRoot, "projects.json.lock");

  await assert.rejects(
    mutateRegistry(hubRoot, async (registry) => {
      const lockPath = path.join(lockDir, "lock.json");
      const lock = JSON.parse(await readFile(lockPath, "utf8"));
      await writeFile(lockPath, `${JSON.stringify({
        ...lock,
        ownerToken: "successor-owner",
        ownerPid: process.pid,
        ownerHost: os.hostname(),
      })}\n`);
      registry.projects[projectId].name = "must-not-commit";
    }),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "HUB_REGISTRY_LOCK_LOST");
      return true;
    },
  );

  const successor = JSON.parse(await readFile(path.join(lockDir, "lock.json"), "utf8"));
  assert.equal(successor.ownerToken, "successor-owner");
  const registry = await loadRegistry(hubRoot);
  assert.notEqual(registry.projects[projectId].name, "must-not-commit");
  await rm(lockDir, { recursive: true, force: true });
});
