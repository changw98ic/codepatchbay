import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { access, chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { startHubServer } from "../server/index.js";
import {
  _internalCleanupRedisSnapshotArtifactForTests,
  _internalReadRedisRollbackSnapshotForTests,
  createHubBackup,
  recoverInterruptedHubRestore,
  restoreHubBackup,
  verifyHubBackup,
  withHubBackupTestHooksForTests,
} from "../server/services/hub/hub-backup.js";
import { saveRegistry } from "../server/services/hub/hub-registry.js";
import {
  hubMaintenanceLockPath,
  hubRestoreJournalPath,
  writeJsonDurableAtomic,
} from "../shared/hub-maintenance.js";
import { captureProcessIdentity } from "../core/runtime/process-tree.js";
import { tempRoot } from "./helpers.js";

async function createDirectoryFromHostileProcess(directory: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", [
      "const fs = require('node:fs');",
      "fs.mkdirSync(process.argv[1], { recursive: false, mode: 0o700 });",
      "fs.writeFileSync(require('node:path').join(process.argv[1], 'hostile-marker'), 'hostile\\n');",
    ].join(""), directory], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`hostile child failed: ${code ?? signal}`));
    });
  });
}

async function createDirectorySymlinkFromHostileProcess(target: string, linkPath: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", [
      "const fs = require('node:fs');",
      "fs.symlinkSync(process.argv[1], process.argv[2], 'dir');",
    ].join(""), target, linkPath], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`hostile symlink child failed: ${code ?? signal}`));
    });
  });
}

async function setupHubFixture(prefix: string) {
  const root = await tempRoot(prefix);
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const projectRuntimeRoot = path.join(hubRoot, "projects", "flow");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(projectRuntimeRoot, { recursive: true });
  await saveRegistry(hubRoot, {
    version: 1,
    updatedAt: new Date().toISOString(),
    projects: {
      flow: {
        id: "flow",
        name: "flow",
        sourcePath: cpbRoot,
        projectRuntimeRoot,
        enabled: true,
      },
    },
  });
  await mkdir(path.join(hubRoot, "queue"), { recursive: true });
  await writeFile(path.join(hubRoot, "queue", "queue.json"), "original-queue\n", "utf8");
  await mkdir(path.join(projectRuntimeRoot, "jobs", "job-1"), { recursive: true });
  await writeFile(path.join(projectRuntimeRoot, "jobs", "job-1", "events.jsonl"), "{\"type\":\"job_created\"}\n", "utf8");
  return { root, cpbRoot, hubRoot, projectRuntimeRoot, allowUnsignedDev: true };
}

function verifyUnsignedHubBackup(input: string) {
  return verifyHubBackup(input, { allowUnsignedDev: true });
}

function backupStageArtifacts(hubRoot: string, output: string) {
  const resolvedHubRoot = path.resolve(hubRoot);
  const resolvedOutput = path.resolve(output);
  const digest = createHash("sha256")
    .update(`${resolvedHubRoot}\0${resolvedOutput}`)
    .digest("hex")
    .slice(0, 16);
  const stage = path.join(path.dirname(resolvedOutput), `.${path.basename(resolvedOutput)}.cpb-stage-${digest}`);
  return { stage, owner: `${stage}.owner.json` };
}

function backupStageOwner(fixture: Awaited<ReturnType<typeof setupHubFixture>>, output: string) {
  const paths = backupStageArtifacts(fixture.hubRoot, output);
  let stageGeneration: {
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    birthtimeMs: number;
  } | null = null;
  return {
    format: "cpb-hub-backup-stage/v2",
    operationToken: randomUUID(),
    get stageGeneration() {
      if (stageGeneration) return stageGeneration;
      const info = lstatSync(paths.stage, { throwIfNoEntry: false }) || lstatSync(output);
      stageGeneration = {
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
        birthtimeMs: info.birthtimeMs,
      };
      return stageGeneration;
    },
    hubRoot: path.resolve(fixture.hubRoot),
    output: path.resolve(output),
    createdAt: new Date(0).toISOString(),
  };
}

test("Hub backup creation and verification require signatures by default", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-signing-default");
  const output = path.join(fixture.root, "backup");
  await assert.rejects(
    createHubBackup({ cpbRoot: fixture.cpbRoot, hubRoot: fixture.hubRoot, output }),
    /BACKUP_SIGNING_KEY is required/,
  );
  await createHubBackup({ ...fixture, output });
  await assert.rejects(verifyHubBackup(output), /signature is required but missing/);
  await assert.doesNotReject(verifyHubBackup(output, { allowUnsignedDev: true }));
});

test("Hub backup captures control-plane and project runtime data with checksums", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-create");
  const output = path.join(fixture.root, "backup");
  const created = await createHubBackup({ ...fixture, output });
  const verified = await verifyUnsignedHubBackup(output);

  assert.equal(created.manifest.snapshotId, verified.manifest.snapshotId);
  assert.equal(verified.manifest.roots.length, 1);
  assert.equal(verified.manifest.roots[0].id, "hub");
  assert.ok(verified.manifest.entries.some((entry) => entry.path === "queue/queue.json"));
  assert.ok(verified.manifest.entries.some((entry) => entry.path === "projects/flow/jobs/job-1/events.jsonl"));
  assert.ok(verified.manifest.fileCount >= 3);
  assert.ok(verified.manifest.totalBytes > 0);
});

test("Hub backup fsync rejects same-path file replacement before descriptor open", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-fsync-replacement");
  const output = path.join(fixture.root, "backup");
  let replaced = false;

  await withHubBackupTestHooksForTests({
    beforeFileFsyncOpen: async ({ filePath }) => {
      if (replaced || !filePath.endsWith("manifest.sha256")) return;
      replaced = true;
      const raw = await readFile(filePath, "utf8");
      await rename(filePath, `${filePath}.predecessor`);
      await writeFile(filePath, raw, "utf8");
    },
  }, async () => {
    await assert.rejects(
      createHubBackup({ ...fixture, output }),
      { code: "BOUNDED_FILE_CHANGED" },
    );
  });

  assert.equal(replaced, true);
  await assert.rejects(access(output), { code: "ENOENT" });
  const stage = backupStageArtifacts(fixture.hubRoot, output);
  await assert.rejects(access(stage.stage), { code: "ENOENT" });
  await assert.rejects(access(stage.owner), { code: "ENOENT" });
});

test("Hub backup test hooks are scoped to the wrapped async operation", async () => {
  const fixtureA = await setupHubFixture("cpb-hub-backup-hook-scope-a");
  const fixtureB = await setupHubFixture("cpb-hub-backup-hook-scope-b");
  const outputA = path.join(fixtureA.root, "backup");
  const outputB = path.join(fixtureB.root, "backup");
  await createHubBackup({ ...fixtureA, output: outputA });
  await createHubBackup({ ...fixtureB, output: outputB });
  const scopedFailure = Object.assign(new Error("scoped backup manifest hook"), { code: "SCOPED_HOOK" });

  await Promise.all([
    withHubBackupTestHooksForTests({
      readHooks: {
        "backup-manifest": {
          afterOpen: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            throw scopedFailure;
          },
        },
      },
    }, async () => {
      await assert.rejects(verifyUnsignedHubBackup(outputA), scopedFailure);
    }),
    verifyUnsignedHubBackup(outputB),
  ]);

  await verifyUnsignedHubBackup(outputA);
  await verifyUnsignedHubBackup(outputB);
});

test("Hub backup reports committed metadata when maintenance release fails after publication", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-post-commit-release");
  const output = path.join(fixture.root, "backup");
  const lockPath = hubMaintenanceLockPath(fixture.hubRoot);

  await withHubBackupTestHooksForTests({
    syncDirectory: async ({ operation }) => {
      if (operation === "backup-publish") await rm(lockPath, { recursive: true, force: true });
    },
  }, async () => {
    await assert.rejects(
      createHubBackup({ ...fixture, output }),
      (error: Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string;
        recoveryPaths?: { output?: string; maintenance?: string };
        attemptedPaths?: { output?: string; maintenance?: string };
      }) => {
        assert.equal(error.code, "HUB_BACKUP_COMMITTED_AMBIGUOUS");
        assert.equal(error.committed, true);
        assert.equal(error.committedPath, output);
        assert.deepEqual(error.recoveryPaths, { output });
        assert.equal(error.attemptedPaths?.maintenance, lockPath);
        return true;
      },
    );
  });

  await verifyUnsignedHubBackup(output);
});

test("Hub backup reports committed metadata when owner cleanup fails after publication", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-post-commit-owner");
  const output = path.join(fixture.root, "backup");
  const ownerPath = backupStageArtifacts(fixture.hubRoot, output).owner;
  const ownerReadFailure = Object.assign(new Error("simulated published owner read failure"), { code: "EIO" });
  let ownerReads = 0;

  await withHubBackupTestHooksForTests({
    readHooks: {
      "backup-stage-owner": {
        afterOpen: async () => {
          ownerReads += 1;
          let outputPublished = false;
          try {
            await access(output);
            outputPublished = true;
          } catch {
            outputPublished = false;
          }
          if (outputPublished) throw ownerReadFailure;
        },
      },
    },
  }, async () => {
    await assert.rejects(
      createHubBackup({ ...fixture, output }),
      (error: Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string;
        recoveryPaths?: { output?: string; owner?: string };
        attemptedPaths?: { output?: string; owner?: string };
      }) => {
        assert.equal(error.code, "HUB_BACKUP_COMMITTED_AMBIGUOUS");
        assert.equal(error.committed, true);
        assert.equal(error.committedPath, output);
        assert.deepEqual(error.recoveryPaths, { output });
        assert.equal(error.attemptedPaths?.owner, ownerPath);
        return true;
      },
    );
  });

  assert.ok(ownerReads >= 3);
  await verifyUnsignedHubBackup(output);
});

test("Hub backup rejects insufficient target space before creating a stage", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-space-preflight");
  const output = path.join(fixture.root, "backup");
  const stage = backupStageArtifacts(fixture.hubRoot, output);

  await assert.rejects(
    createHubBackup({
      ...fixture,
      output,
      minimumFreeBytes: Number.MAX_SAFE_INTEGER,
    }),
    (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, "HUB_BACKUP_INSUFFICIENT_SPACE");
      assert.match(error.message, /insufficient disk space for Hub backup/);
      return true;
    },
  );

  assert.equal(await readFile(path.join(fixture.hubRoot, "queue", "queue.json"), "utf8"), "original-queue\n");
  await assert.rejects(access(output));
  await assert.rejects(access(stage.stage));
  await assert.rejects(access(stage.owner));
  await assert.rejects(access(hubMaintenanceLockPath(fixture.hubRoot)));
});

test("Hub backup creates its stage exclusively and never follows a hostile stage symlink", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-stage-exclusive");
  const output = path.join(fixture.root, "backup");
  const paths = backupStageArtifacts(fixture.hubRoot, output);
  const external = path.join(fixture.root, "external-stage");
  await mkdir(external);
  await writeFile(path.join(external, "marker"), "preserve\n", "utf8");

  await withHubBackupTestHooksForTests({
    beforeBackupStageCreate: async ({ stagePath }) => {
      await createDirectorySymlinkFromHostileProcess(external, stagePath);
    },
  }, async () => {
    await assert.rejects(createHubBackup({ ...fixture, output }), { code: "EEXIST" });
  });

  assert.equal((await lstat(paths.stage)).isSymbolicLink(), true);
  assert.equal(await readFile(path.join(external, "marker"), "utf8"), "preserve\n");
  await assert.rejects(access(paths.owner), { code: "ENOENT" });
});

test("Hub backup safely reclaims an owned stage left by an interrupted process", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-owned-stage");
  const output = path.join(fixture.root, "backup");
  const stage = backupStageArtifacts(fixture.hubRoot, output);
  await mkdir(stage.stage, { recursive: true });
  await writeFile(path.join(stage.stage, "partial.txt"), "partial\n", "utf8");
  await writeJsonDurableAtomic(stage.owner, backupStageOwner(fixture, output));

  const created = await createHubBackup({ ...fixture, output });

  assert.equal(created.output, output);
  await assert.rejects(access(stage.stage));
  await assert.rejects(access(stage.owner));
  assert.equal((await verifyUnsignedHubBackup(output)).manifest.snapshotId, created.manifest.snapshotId);
});

test("Hub backup clears a valid owner marker left after the output was published", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-published-owner");
  const output = path.join(fixture.root, "backup");
  await createHubBackup({ ...fixture, output });
  const stage = backupStageArtifacts(fixture.hubRoot, output);
  await writeJsonDurableAtomic(stage.owner, backupStageOwner(fixture, output));

  await assert.rejects(createHubBackup({ ...fixture, output }), /backup output already exists/);

  await assert.rejects(access(stage.owner));
  await assert.rejects(access(stage.stage));
  await verifyUnsignedHubBackup(output);
});

test("Hub backup never overwrites an output created by a hostile process at the publication boundary", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-external-no-clobber");
  const output = path.join(fixture.root, "backup");
  let publicationSource = "";

  await withHubBackupTestHooksForTests({
    beforeDirectoryNoClobberPublish: async ({ destinationPath }) => {
      if (destinationPath === output) await createDirectoryFromHostileProcess(output);
    },
  }, async () => {
    await assert.rejects(
      createHubBackup({ ...fixture, output }),
      (error: Error & {
        code?: string;
        committed?: boolean;
        successorPreserved?: boolean;
        recoveryPaths?: Record<string, string>;
        attemptedPaths?: Record<string, string>;
      }) => {
        assert.equal(error.code, "HUB_BACKUP_SUCCESSOR_PRESERVED");
        assert.equal(error.committed, false);
        assert.equal(error.successorPreserved, true);
        publicationSource = error.recoveryPaths?.publicationSource || "";
        assert.ok(publicationSource);
        assert.equal(error.attemptedPaths?.destination, output);
        return true;
      },
    );
  });

  assert.equal(await readFile(path.join(output, "hostile-marker"), "utf8"), "hostile\n");
  await access(path.join(publicationSource, "manifest.json"));
});

test("Hub backup stage owner reads reject symlinks and oversized metadata", async () => {
  for (const variant of ["symlink", "oversize"] as const) {
    const fixture = await setupHubFixture(`cpb-hub-backup-stage-owner-${variant}`);
    const output = path.join(fixture.root, "backup");
    const stage = backupStageArtifacts(fixture.hubRoot, output);
    await mkdir(stage.stage, { recursive: true });
    await writeFile(path.join(stage.stage, "must-survive.txt"), "successor\n", "utf8");
    if (variant === "symlink") {
      const externalOwner = path.join(fixture.root, "external-owner.json");
      await writeFile(externalOwner, `${JSON.stringify(backupStageOwner(fixture, output))}\n`, "utf8");
      await symlink(externalOwner, stage.owner);
    } else {
      await writeFile(stage.owner, "{", "utf8");
      await truncate(stage.owner, 64 * 1024 + 1);
    }

    await assert.rejects(
      createHubBackup({ ...fixture, output }),
      { code: variant === "symlink" ? "BOUNDED_FILE_UNSAFE" : "BOUNDED_FILE_TOO_LARGE" },
    );
    assert.equal(await readFile(path.join(stage.stage, "must-survive.txt"), "utf8"), "successor\n");
  }
});

test("Hub backup preserves a same-record stage owner successor after the pinned read", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-stage-owner-successor");
  const output = path.join(fixture.root, "backup");
  const stage = backupStageArtifacts(fixture.hubRoot, output);
  const owner = backupStageOwner(fixture, output);
  await mkdir(stage.stage, { recursive: true });
  await writeFile(path.join(stage.stage, "must-survive.txt"), "successor\n", "utf8");
  await writeJsonDurableAtomic(stage.owner, owner);

  await withHubBackupTestHooksForTests({
    beforeOwnedStageRemoval: async ({ ownerPath }) => {
      await rename(ownerPath, `${ownerPath}.predecessor`);
      await writeJsonDurableAtomic(ownerPath, owner);
    },
  }, async () => {
    await assert.rejects(
      createHubBackup({ ...fixture, output }),
      { code: "HUB_BACKUP_AUTHORITY_CHANGED" },
    );
  });

  assert.equal(await readFile(path.join(stage.stage, "must-survive.txt"), "utf8"), "successor\n");
  assert.deepEqual(JSON.parse(await readFile(stage.owner, "utf8")), owner);
});

test("Hub backup preserves a same-owner stage successor installed just before isolation", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-stage-pre-isolation-successor");
  const output = path.join(fixture.root, "backup");
  const stage = backupStageArtifacts(fixture.hubRoot, output);
  const displaced = `${stage.stage}.predecessor`;
  const owner = backupStageOwner(fixture, output);
  let quarantinePath = "";
  await mkdir(stage.stage, { recursive: true });
  await writeFile(path.join(stage.stage, "must-survive.txt"), "predecessor\n", "utf8");
  await writeJsonDurableAtomic(stage.owner, owner);

  await withHubBackupTestHooksForTests({
    beforeOwnedStageIsolation: async ({ stagePath, quarantinePath: observedQuarantine }) => {
      quarantinePath = observedQuarantine;
      await rename(stagePath, displaced);
      await mkdir(stagePath, { recursive: true });
      await writeFile(path.join(stagePath, "must-survive.txt"), "successor\n", "utf8");
    },
  }, async () => {
    await assert.rejects(
      createHubBackup({ ...fixture, output }),
      (error: Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string | null;
        recoveryPaths?: Record<string, string>;
        attemptedPaths?: Record<string, string>;
      }) => {
        assert.equal(error.code, "HUB_BACKUP_AUTHORITY_CHANGED");
        assert.equal(error.committed, false);
        assert.equal(error.committedPath, null);
        assert.equal(error.recoveryPaths?.owner, stage.owner);
        assert.equal(error.recoveryPaths?.stage, undefined);
        assert.equal(error.attemptedPaths?.stage, stage.stage);
        assert.equal(error.attemptedPaths?.parent, path.dirname(stage.stage));
        assert.equal(error.attemptedPaths?.quarantine, quarantinePath);
        return true;
      },
    );
  });

  assert.equal(await readFile(path.join(stage.stage, "must-survive.txt"), "utf8"), "successor\n");
  assert.equal(await readFile(path.join(displaced, "must-survive.txt"), "utf8"), "predecessor\n");
  assert.deepEqual(JSON.parse(await readFile(stage.owner, "utf8")), owner);
  await assert.rejects(access(quarantinePath), { code: "ENOENT" });
});

test("Hub backup stage isolation never replaces a precreated quarantine directory", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-stage-quarantine-conflict");
  const output = path.join(fixture.root, "backup");
  const stage = backupStageArtifacts(fixture.hubRoot, output);
  const owner = backupStageOwner(fixture, output);
  let quarantinePath = "";
  let hostileGeneration: { dev: number | bigint; ino: number | bigint } | null = null;
  await mkdir(stage.stage, { recursive: true });
  await writeFile(path.join(stage.stage, "must-survive.txt"), "predecessor\n", "utf8");
  await writeJsonDurableAtomic(stage.owner, owner);

  await withHubBackupTestHooksForTests({
    beforeOwnedStageIsolation: async ({ quarantinePath: observedQuarantine }) => {
      quarantinePath = observedQuarantine;
      await mkdir(quarantinePath);
      await writeFile(path.join(quarantinePath, "hostile.txt"), "hostile\n", "utf8");
      const info = await lstat(quarantinePath);
      hostileGeneration = { dev: info.dev, ino: info.ino };
    },
  }, async () => {
    await assert.rejects(
      createHubBackup({ ...fixture, output }),
      (error: Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string | null;
        successorPreserved?: boolean;
        recoveryPaths?: Record<string, string>;
        attemptedPaths?: Record<string, string>;
      }) => {
        assert.equal(error.code, "HUB_BACKUP_STAGE_QUARANTINE_CONFLICT");
        assert.equal(error.committed, false);
        assert.equal(error.committedPath, null);
        assert.equal(error.successorPreserved, true);
        assert.equal(error.recoveryPaths?.stage, stage.stage);
        assert.equal(error.recoveryPaths?.owner, stage.owner);
        assert.equal(error.recoveryPaths?.quarantine, undefined);
        assert.equal(error.attemptedPaths?.quarantine, quarantinePath);
        assert.equal(error.attemptedPaths?.parent, path.dirname(stage.stage));
        return true;
      },
    );
  });

  const hostileAfter = await lstat(quarantinePath);
  assert.deepEqual({ dev: hostileAfter.dev, ino: hostileAfter.ino }, hostileGeneration);
  assert.equal(await readFile(path.join(quarantinePath, "hostile.txt"), "utf8"), "hostile\n");
  assert.equal(await readFile(path.join(stage.stage, "must-survive.txt"), "utf8"), "predecessor\n");
  assert.deepEqual(JSON.parse(await readFile(stage.owner, "utf8")), owner);
  await assert.rejects(access(output), { code: "ENOENT" });
});

test("Hub backup stage isolation rejects a replaced parent while preserving both directory trees", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-stage-parent-replacement");
  const outputParent = path.join(fixture.root, "backup-output");
  const displacedParent = `${outputParent}.predecessor`;
  const output = path.join(outputParent, "backup");
  await mkdir(outputParent);
  const stage = backupStageArtifacts(fixture.hubRoot, output);
  const owner = backupStageOwner(fixture, output);
  let quarantinePath = "";
  await mkdir(stage.stage, { recursive: true });
  await writeFile(path.join(stage.stage, "must-survive.txt"), "predecessor\n", "utf8");
  await writeJsonDurableAtomic(stage.owner, owner);

  await withHubBackupTestHooksForTests({
    beforeOwnedStageIsolation: async ({ stagePath, quarantinePath: observedQuarantine }) => {
      quarantinePath = observedQuarantine;
      await rename(outputParent, displacedParent);
      await mkdir(outputParent);
      await mkdir(stagePath);
      await writeFile(path.join(stagePath, "must-survive.txt"), "successor\n", "utf8");
    },
  }, async () => {
    await assert.rejects(
      createHubBackup({ ...fixture, output }),
      (error: Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string | null;
        recoveryPaths?: Record<string, string>;
        attemptedPaths?: Record<string, string>;
      }) => {
        assert.equal(error.code, "HUB_BACKUP_AUTHORITY_CHANGED");
        assert.equal(error.committed, false);
        assert.equal(error.committedPath, null);
        assert.deepEqual(error.recoveryPaths, {});
        assert.equal(error.attemptedPaths?.stage, stage.stage);
        assert.equal(error.attemptedPaths?.owner, stage.owner);
        assert.equal(error.attemptedPaths?.parent, outputParent);
        assert.equal(error.attemptedPaths?.quarantine, quarantinePath);
        return true;
      },
    );
  });

  assert.equal(await readFile(path.join(stage.stage, "must-survive.txt"), "utf8"), "successor\n");
  const displacedStage = path.join(displacedParent, path.basename(stage.stage));
  const displacedOwner = path.join(displacedParent, path.basename(stage.owner));
  assert.equal(await readFile(path.join(displacedStage, "must-survive.txt"), "utf8"), "predecessor\n");
  assert.deepEqual(JSON.parse(await readFile(displacedOwner, "utf8")), owner);
  await assert.rejects(access(quarantinePath), { code: "ENOENT" });
  await assert.rejects(access(output), { code: "ENOENT" });
});

test("Hub backup reports committed recovery when a stage successor appears after isolation", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-stage-post-isolation-successor");
  const output = path.join(fixture.root, "backup");
  const stage = backupStageArtifacts(fixture.hubRoot, output);
  const owner = backupStageOwner(fixture, output);
  let quarantinePath = "";
  await mkdir(stage.stage, { recursive: true });
  await writeFile(path.join(stage.stage, "must-survive.txt"), "predecessor\n", "utf8");
  await writeJsonDurableAtomic(stage.owner, owner);

  await withHubBackupTestHooksForTests({
    afterOwnedStageIsolation: async ({ stagePath, quarantinePath: observedQuarantine }) => {
      quarantinePath = observedQuarantine;
      await mkdir(stagePath, { recursive: true });
      await writeFile(path.join(stagePath, "must-survive.txt"), "successor\n", "utf8");
    },
  }, async () => {
    await assert.rejects(
      createHubBackup({ ...fixture, output }),
      (error: Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string;
        quarantinePreserved?: boolean;
        successorPreserved?: boolean;
        recoveryPaths?: { stage?: string; owner?: string; quarantine?: string };
        attemptedPaths?: { stage?: string };
      }) => {
        assert.equal(error.code, "HUB_BACKUP_STAGE_REMOVE_COMMITTED_AMBIGUOUS");
        assert.equal(error.committed, true);
        assert.equal(error.committedPath, quarantinePath);
        assert.equal(error.quarantinePreserved, true);
        assert.equal(error.successorPreserved, true);
        assert.equal(error.recoveryPaths?.stage, undefined);
        assert.equal(error.recoveryPaths?.owner, stage.owner);
        assert.equal(error.recoveryPaths?.quarantine, quarantinePath);
        assert.equal(error.attemptedPaths?.stage, stage.stage);
        return true;
      },
    );
  });

  assert.equal(await readFile(path.join(stage.stage, "must-survive.txt"), "utf8"), "successor\n");
  assert.equal(await readFile(path.join(quarantinePath, "must-survive.txt"), "utf8"), "predecessor\n");
  assert.deepEqual(JSON.parse(await readFile(stage.owner, "utf8")), owner);
});

test("Hub backup never reports a replaced quarantine path as recovery evidence", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-stage-quarantine-replacement");
  const output = path.join(fixture.root, "backup");
  const stage = backupStageArtifacts(fixture.hubRoot, output);
  const owner = backupStageOwner(fixture, output);
  let quarantinePath = "";
  let displacedQuarantine = "";
  await mkdir(stage.stage, { recursive: true });
  await writeFile(path.join(stage.stage, "must-survive.txt"), "predecessor\n", "utf8");
  await writeJsonDurableAtomic(stage.owner, owner);

  await withHubBackupTestHooksForTests({
    afterOwnedStageIsolation: async ({ quarantinePath: observedQuarantine }) => {
      quarantinePath = observedQuarantine;
      displacedQuarantine = `${quarantinePath}.predecessor`;
      await rename(quarantinePath, displacedQuarantine);
      await mkdir(quarantinePath);
      await writeFile(path.join(quarantinePath, "hostile.txt"), "hostile\n", "utf8");
    },
  }, async () => {
    await assert.rejects(
      createHubBackup({ ...fixture, output }),
      (error: Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string;
        quarantinePreserved?: boolean;
        successorPreserved?: boolean;
        recoveryPaths?: Record<string, string>;
        attemptedPaths?: Record<string, string>;
      }) => {
        assert.equal(error.code, "HUB_BACKUP_STAGE_REMOVE_COMMITTED_AMBIGUOUS");
        assert.equal(error.committed, true);
        assert.equal(error.committedPath, quarantinePath);
        assert.equal(error.quarantinePreserved, false);
        assert.equal(error.successorPreserved, true);
        assert.equal(error.recoveryPaths?.quarantine, undefined);
        assert.equal(error.attemptedPaths?.quarantine, quarantinePath);
        assert.equal(error.attemptedPaths?.stage, stage.stage);
        return true;
      },
    );
  });

  assert.equal(await readFile(path.join(displacedQuarantine, "must-survive.txt"), "utf8"), "predecessor\n");
  assert.equal(await readFile(path.join(quarantinePath, "hostile.txt"), "utf8"), "hostile\n");
  assert.deepEqual(JSON.parse(await readFile(stage.owner, "utf8")), owner);
});

test("Hub backup stage isolation leaves read-only modes and data unchanged", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-read-only-stage-isolation");
  const output = path.join(fixture.root, "backup");
  const stage = backupStageArtifacts(fixture.hubRoot, output);
  const owner = backupStageOwner(fixture, output);
  const nested = path.join(stage.stage, "nested");
  const payload = path.join(nested, "must-survive.txt");
  let quarantinePath = "";
  await mkdir(nested, { recursive: true });
  await writeFile(payload, "read-only-predecessor\n", "utf8");
  await chmod(payload, 0o400);
  await chmod(nested, 0o500);
  await chmod(stage.stage, 0o500);
  await writeJsonDurableAtomic(stage.owner, owner);

  await withHubBackupTestHooksForTests({
    afterOwnedStageIsolation: async ({ quarantinePath: observedQuarantine }) => {
      quarantinePath = observedQuarantine;
      throw Object.assign(new Error("stop after read-only isolation"), { code: "EIO" });
    },
  }, async () => {
    await assert.rejects(
      createHubBackup({ ...fixture, output }),
      (error: Error & { committed?: boolean; recoveryPaths?: Record<string, string> }) => {
        assert.equal(error.committed, true);
        assert.equal(error.recoveryPaths?.quarantine, quarantinePath);
        return true;
      },
    );
  });

  assert.equal((await lstat(quarantinePath)).mode & 0o777, 0o500);
  assert.equal((await lstat(path.join(quarantinePath, "nested"))).mode & 0o777, 0o500);
  const isolatedPayload = path.join(quarantinePath, "nested", "must-survive.txt");
  assert.equal((await lstat(isolatedPayload)).mode & 0o777, 0o400);
  assert.equal(await readFile(isolatedPayload, "utf8"), "read-only-predecessor\n");
  await chmod(isolatedPayload, 0o600);
  await chmod(path.join(quarantinePath, "nested"), 0o700);
  await chmod(quarantinePath, 0o700);
});

test("Hub backup reports committed stage evidence when the owner is replaced afterward", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-owner-aba-after-stage");
  const output = path.join(fixture.root, "backup");
  const stage = backupStageArtifacts(fixture.hubRoot, output);
  const owner = backupStageOwner(fixture, output);
  const displacedOwner = `${stage.owner}.predecessor`;
  let quarantinePath = "";
  await mkdir(stage.stage, { recursive: true });
  await writeFile(path.join(stage.stage, "must-survive.txt"), "predecessor\n", "utf8");
  await writeJsonDurableAtomic(stage.owner, owner);

  await withHubBackupTestHooksForTests({
    beforeOwnedStageOwnerCleanup: async ({ ownerPath, quarantinePath: observedQuarantine }) => {
      quarantinePath = observedQuarantine;
      await rename(ownerPath, displacedOwner);
      await writeJsonDurableAtomic(ownerPath, owner);
    },
  }, async () => {
    await assert.rejects(
      createHubBackup({ ...fixture, output }),
      (error: Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string;
        quarantinePreserved?: boolean;
        successorPreserved?: boolean;
        recoveryPaths?: Record<string, string>;
        attemptedPaths?: Record<string, string>;
      }) => {
        assert.equal(error.code, "HUB_BACKUP_STAGE_REMOVE_COMMITTED_AMBIGUOUS");
        assert.equal(error.committed, true);
        assert.equal(error.committedPath, quarantinePath);
        assert.equal(error.quarantinePreserved, true);
        assert.equal(error.successorPreserved, true);
        assert.equal(error.recoveryPaths?.quarantine, quarantinePath);
        assert.equal(error.recoveryPaths?.owner, undefined);
        assert.equal(error.attemptedPaths?.owner, stage.owner);
        assert.equal(error.attemptedPaths?.stage, stage.stage);
        return true;
      },
    );
  });

  assert.equal(await readFile(path.join(quarantinePath, "must-survive.txt"), "utf8"), "predecessor\n");
  assert.deepEqual(JSON.parse(await readFile(stage.owner, "utf8")), owner);
  assert.deepEqual(JSON.parse(await readFile(displacedOwner, "utf8")), owner);
});

test("Hub backup refuses to delete a deterministic stage without its ownership marker", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-unowned-stage");
  const output = path.join(fixture.root, "backup");
  const stage = backupStageArtifacts(fixture.hubRoot, output);
  await mkdir(stage.stage, { recursive: true });
  await writeFile(path.join(stage.stage, "must-survive.txt"), "user-data\n", "utf8");

  await assert.rejects(
    createHubBackup({ ...fixture, output }),
    /refuses to remove an unowned stage directory/,
  );

  assert.equal(await readFile(path.join(stage.stage, "must-survive.txt"), "utf8"), "user-data\n");
  await assert.rejects(access(output));
  await assert.rejects(access(hubMaintenanceLockPath(fixture.hubRoot)));
});

test("Hub backup verification rejects changed data before restore mutates the target", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-corrupt");
  const output = path.join(fixture.root, "backup");
  const created = await createHubBackup({ ...fixture, output });
  const queueEntry = created.manifest.entries.find((entry) => entry.path === "queue/queue.json");
  assert.ok(queueEntry);
  await writeFile(path.join(output, "data", "roots", queueEntry.rootId, queueEntry.path), "tampered\n", "utf8");
  await writeFile(path.join(fixture.hubRoot, "queue", "queue.json"), "current-target\n", "utf8");

  await assert.rejects(verifyUnsignedHubBackup(output), /size mismatch|checksum mismatch/);
  await assert.rejects(
    restoreHubBackup({ ...fixture, input: output, force: true }),
    /size mismatch|checksum mismatch/,
  );
  assert.equal(await readFile(path.join(fixture.hubRoot, "queue", "queue.json"), "utf8"), "current-target\n");
});

test("Hub backup verification rejects changed file permissions", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-mode");
  const output = path.join(fixture.root, "backup");
  const created = await createHubBackup({ ...fixture, output });
  const queueEntry = created.manifest.entries.find((entry) => entry.path === "queue/queue.json");
  assert.ok(queueEntry);
  const backupFile = path.join(output, "data", "roots", queueEntry.rootId, queueEntry.path);
  await chmod(backupFile, queueEntry.mode ^ 0o100);

  await assert.rejects(verifyUnsignedHubBackup(output), /mode mismatch/);
});

test("signed Hub backups require the matching HMAC key and support signature-required policy", async () => {
  const signedFixture = await setupHubFixture("cpb-hub-backup-signed");
  const signedOutput = path.join(signedFixture.root, "signed-backup");
  const signingKey = "hub-backup-signing-key-with-at-least-32-bytes";
  await createHubBackup({ ...signedFixture, output: signedOutput, signingKey });

  await assert.rejects(verifyHubBackup(signedOutput), /requires CPB_HUB_BACKUP_SIGNING_KEY/);
  await assert.rejects(
    verifyHubBackup(signedOutput, { signingKey: "wrong-hub-backup-signing-key-at-least-32-bytes" }),
    /signature mismatch/,
  );
  assert.equal((await verifyHubBackup(signedOutput, { signingKey, requireSignature: true })).manifest.roots.length, 1);
  await rm(path.join(signedOutput, "manifest.hmac-sha256"));
  await assert.rejects(verifyHubBackup(signedOutput, { signingKey }), /signature is required but missing/);

  const unsignedFixture = await setupHubFixture("cpb-hub-backup-unsigned-required");
  const unsignedOutput = path.join(unsignedFixture.root, "unsigned-backup");
  await createHubBackup({ ...unsignedFixture, output: unsignedOutput });
  await assert.rejects(
    verifyHubBackup(unsignedOutput, { requireSignature: true }),
    /signature is required but missing/,
  );
});

test("Hub restore requires force, atomically replaces the Hub root, and retains rollback data", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-restore");
  const output = path.join(fixture.root, "backup");
  await createHubBackup({ ...fixture, output });
  await writeFile(path.join(fixture.hubRoot, "queue", "queue.json"), "mutated-queue\n", "utf8");
  await writeFile(path.join(fixture.hubRoot, "post-backup-extra.txt"), "extra\n", "utf8");

  await assert.rejects(
    restoreHubBackup({ ...fixture, input: output }),
    /rerun with --force/,
  );
  const restored = await restoreHubBackup({ ...fixture, input: output, force: true });

  assert.equal(await readFile(path.join(fixture.hubRoot, "queue", "queue.json"), "utf8"), "original-queue\n");
  await assert.rejects(access(path.join(fixture.hubRoot, "post-backup-extra.txt")));
  assert.equal(restored.restoredRoots.length, 1);
  assert.ok(restored.restoredRoots[0].rollbackPath);
  assert.equal(
    await readFile(path.join(String(restored.restoredRoots[0].rollbackPath), "queue", "queue.json"), "utf8"),
    "mutated-queue\n",
  );
  await assert.rejects(access(hubRestoreJournalPath(fixture.hubRoot)));
  await assert.rejects(access(hubMaintenanceLockPath(fixture.hubRoot)));
});

test("Hub restore reports committed metadata when maintenance release fails after publication", async () => {
  const fixture = await setupHubFixture("cpb-hub-restore-post-commit-release");
  const output = path.join(fixture.root, "backup");
  const lockPath = hubMaintenanceLockPath(fixture.hubRoot);
  await createHubBackup({ ...fixture, output });
  await writeFile(path.join(fixture.hubRoot, "queue", "queue.json"), "mutated-queue\n", "utf8");
  let recoveryPaths: Record<string, string> = {};

  await withHubBackupTestHooksForTests({
    syncDirectory: async ({ operation }) => {
      if (operation === "restore-stage-publish") await rm(lockPath, { recursive: true, force: true });
    },
  }, async () => {
    await assert.rejects(
      restoreHubBackup({ ...fixture, input: output, force: true }),
      (error: Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string;
        recoveryPaths?: Record<string, string>;
        attemptedPaths?: { maintenance?: string; journal?: string };
      }) => {
        assert.equal(error.code, "HUB_RESTORE_COMMITTED_AMBIGUOUS");
        assert.equal(error.committed, true);
        assert.equal(error.committedPath, fixture.hubRoot);
        assert.equal(error.recoveryPaths?.canonical, fixture.hubRoot);
        assert.equal(error.recoveryPaths?.maintenance, undefined);
        assert.equal(error.recoveryPaths?.journal, undefined);
        assert.equal(error.attemptedPaths?.maintenance, lockPath);
        recoveryPaths = error.recoveryPaths || {};
        return true;
      },
    );
  });

  for (const recoveryPath of Object.values(recoveryPaths)) {
    const info = await lstat(recoveryPath);
    assert.equal(info.isSymbolicLink(), false);
  }
  assert.equal(await readFile(path.join(fixture.hubRoot, "queue", "queue.json"), "utf8"), "original-queue\n");
});

test("Hub restore reports a rolled-back outcome after target-move durability failure", async () => {
  const fixture = await setupHubFixture("cpb-hub-restore-target-move-rolled-back");
  const output = path.join(fixture.root, "backup");
  const journalPath = hubRestoreJournalPath(fixture.hubRoot);
  await createHubBackup({ ...fixture, output });
  await writeFile(path.join(fixture.hubRoot, "queue", "queue.json"), "current-target\n", "utf8");
  const syncFailure = Object.assign(new Error("simulated restore target-move sync failure"), { code: "EIO" });
  let observedRecoveryPaths: Record<string, string> = {};
  let attemptedPaths: { stage?: string; rollback?: string } = {};

  await withHubBackupTestHooksForTests({
    syncDirectory: async ({ operation }) => {
      if (operation === "restore-target-move") throw syncFailure;
    },
  }, async () => {
    await assert.rejects(
      restoreHubBackup({ ...fixture, input: output, force: true }),
      (error: Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string | null;
        recoveryPaths?: Record<string, string>;
        attemptedPaths?: { canonical?: string; stage?: string; rollback?: string; journal?: string };
      }) => {
        assert.equal(error.code, "HUB_RESTORE_FAILED_ROLLED_BACK");
        assert.equal(error.committed, false);
        assert.equal(error.committedPath, null);
        assert.deepEqual(error.recoveryPaths, { canonical: fixture.hubRoot });
        assert.equal(error.attemptedPaths?.journal, journalPath);
        assert.ok(error.attemptedPaths?.stage);
        assert.ok(error.attemptedPaths?.rollback);
        observedRecoveryPaths = error.recoveryPaths || {};
        attemptedPaths = error.attemptedPaths || {};
        return true;
      },
    );
  });

  for (const recoveryPath of Object.values(observedRecoveryPaths)) {
    const info = await lstat(recoveryPath);
    assert.equal(info.isSymbolicLink(), false);
  }
  await assert.rejects(access(String(attemptedPaths.stage)), { code: "ENOENT" });
  await assert.rejects(access(String(attemptedPaths.rollback)), { code: "ENOENT" });
  await assert.rejects(access(journalPath), { code: "ENOENT" });
  assert.equal(await readFile(path.join(fixture.hubRoot, "queue", "queue.json"), "utf8"), "current-target\n");
});

test("Hub restore rejects insufficient target space before journaling or moving the target", async () => {
  const fixture = await setupHubFixture("cpb-hub-restore-space-preflight");
  const output = path.join(fixture.root, "backup");
  await createHubBackup({ ...fixture, output });
  await writeFile(path.join(fixture.hubRoot, "queue", "queue.json"), "current-target\n", "utf8");

  await assert.rejects(
    restoreHubBackup({
      ...fixture,
      input: output,
      force: true,
      minimumFreeBytes: Number.MAX_SAFE_INTEGER,
    }),
    (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, "HUB_BACKUP_INSUFFICIENT_SPACE");
      assert.match(error.message, /insufficient disk space for Hub restore/);
      return true;
    },
  );

  assert.equal(await readFile(path.join(fixture.hubRoot, "queue", "queue.json"), "utf8"), "current-target\n");
  await assert.rejects(access(hubRestoreJournalPath(fixture.hubRoot)));
  assert.equal(
    (await readdir(fixture.root)).some((name) => name.startsWith(`.${path.basename(fixture.hubRoot)}.restore-stage-`)),
    false,
  );
  await assert.rejects(access(hubMaintenanceLockPath(fixture.hubRoot)));
});

function restoreJournalFixture({
  fixture,
  output,
  snapshotId,
  stagePath,
  rollbackPath,
  phase,
  signatureRequired = false,
  maintenanceToken = randomUUID(),
}: {
  fixture: Awaited<ReturnType<typeof setupHubFixture>>;
  output: string;
  snapshotId: string;
  stagePath: string;
  rollbackPath: string | null;
  phase: "staged" | "target_moved" | "committed";
  signatureRequired?: boolean;
  maintenanceToken?: string | null;
}) {
  const now = new Date().toISOString();
  return {
    format: "cpb-hub-restore/v1",
    operationToken: randomUUID(),
    snapshotId,
    input: output,
    hubRoot: fixture.hubRoot,
    targetPath: fixture.hubRoot,
    stagePath,
    get stageGeneration() {
      const info = lstatSync(stagePath, { throwIfNoEntry: false })
        || lstatSync(fixture.hubRoot, { throwIfNoEntry: false });
      return info ? {
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
        birthtimeMs: info.birthtimeMs,
      } : null;
    },
    rollbackPath,
    get rollbackGeneration() {
      const info = rollbackPath ? lstatSync(rollbackPath, { throwIfNoEntry: false }) : undefined;
      return info ? {
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
        birthtimeMs: info.birthtimeMs,
      } : null;
    },
    targetExisted: rollbackPath !== null,
    signatureRequired,
    maintenanceToken,
    phase,
    createdAt: now,
    updatedAt: now,
  };
}

test("interrupted restore recovery rolls back a moved target through a signed exact restore owner", async () => {
  const fixture = await setupHubFixture("cpb-hub-restore-recover-rollback");
  const output = path.join(fixture.root, "backup");
  const signingKey = "hub-restore-recovery-signing-key-at-least-32-bytes";
  const created = await createHubBackup({ ...fixture, output, signingKey });
  await writeFile(path.join(fixture.hubRoot, "queue", "queue.json"), "pre-restore-current\n", "utf8");
  const stagePath = path.join(fixture.root, `.${path.basename(fixture.hubRoot)}.restore-stage-test-rollback`);
  const rollbackPath = `${fixture.hubRoot}.pre-restore-test-rollback`;
  await mkdir(stagePath, { recursive: true });
  await rename(fixture.hubRoot, rollbackPath);
  await writeJsonDurableAtomic(
    hubRestoreJournalPath(fixture.hubRoot),
    restoreJournalFixture({
      fixture,
      output,
      snapshotId: created.manifest.snapshotId,
      stagePath,
      rollbackPath,
      phase: "target_moved",
      signatureRequired: true,
      maintenanceToken: "crashed-restore-token",
    }),
  );
  const lockPath = hubMaintenanceLockPath(fixture.hubRoot);
  await mkdir(lockPath, { recursive: true });
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
    format: "cpb-hub-maintenance/v2",
    ownerToken: "crashed-restore-token",
    operation: "Hub restore",
    hubRoot: fixture.hubRoot,
    pid: 999_999_999,
    host: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: {
      pid: 999_999_999,
      birthId: "dead-exact-restore-owner",
      incarnation: "999999999:dead-exact-restore-owner",
      capturedAt: new Date(0).toISOString(),
      birthIdPrecision: "exact",
    },
  })}\n`, "utf8");

  const recovered = await recoverInterruptedHubRestore({ hubRoot: fixture.hubRoot, signingKey });

  assert.equal(recovered.recovered, true);
  assert.equal(recovered.outcome, "rolled_back");
  assert.equal(await readFile(path.join(fixture.hubRoot, "queue", "queue.json"), "utf8"), "pre-restore-current\n");
  await assert.rejects(access(stagePath));
  await assert.rejects(access(hubRestoreJournalPath(fixture.hubRoot)));
  await assert.rejects(access(lockPath));
});

test("interrupted restore recovery does not reclaim a legacy owner even with a signed matching journal token", async () => {
  const fixture = await setupHubFixture("cpb-hub-restore-recover-legacy-signed");
  const output = path.join(fixture.root, "backup");
  const signingKey = "hub-restore-legacy-failclosed-key-at-least-32-bytes";
  const created = await createHubBackup({ ...fixture, output, signingKey });
  const stagePath = path.join(fixture.root, `.${path.basename(fixture.hubRoot)}.restore-stage-test-signed-legacy`);
  const rollbackPath = `${fixture.hubRoot}.pre-restore-test-signed-legacy`;
  await mkdir(stagePath, { recursive: true });
  await rename(fixture.hubRoot, rollbackPath);
  await writeJsonDurableAtomic(
    hubRestoreJournalPath(fixture.hubRoot),
    restoreJournalFixture({
      fixture,
      output,
      snapshotId: created.manifest.snapshotId,
      stagePath,
      rollbackPath,
      phase: "target_moved",
      signatureRequired: true,
      maintenanceToken: "legacy-signed-restore-token",
    }),
  );
  const lockPath = hubMaintenanceLockPath(fixture.hubRoot);
  await mkdir(lockPath, { recursive: true });
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
    format: "cpb-hub-maintenance/v1",
    ownerToken: "legacy-signed-restore-token",
    operation: "Hub restore",
    hubRoot: fixture.hubRoot,
    pid: 999_999_999,
    host: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
  })}\n`, "utf8");

  await assert.rejects(
    recoverInterruptedHubRestore({ hubRoot: fixture.hubRoot, signingKey }),
    /already held/,
  );
  await access(path.join(lockPath, "owner.json"));
  await access(hubRestoreJournalPath(fixture.hubRoot));
});

test("interrupted restore recovery does not reclaim a legacy owner with a forged journal token", async () => {
  const fixture = await setupHubFixture("cpb-hub-restore-recover-legacy-forged-token");
  const output = path.join(fixture.root, "backup");
  const signingKey = "hub-restore-forged-token-key-at-least-32-bytes";
  const created = await createHubBackup({ ...fixture, output, signingKey });
  const stagePath = path.join(fixture.root, `.${path.basename(fixture.hubRoot)}.restore-stage-test-forged`);
  const rollbackPath = `${fixture.hubRoot}.pre-restore-test-forged`;
  await mkdir(stagePath, { recursive: true });
  await rename(fixture.hubRoot, rollbackPath);
  await writeJsonDurableAtomic(
    hubRestoreJournalPath(fixture.hubRoot),
    restoreJournalFixture({
      fixture,
      output,
      snapshotId: created.manifest.snapshotId,
      stagePath,
      rollbackPath,
      phase: "target_moved",
      signatureRequired: true,
      maintenanceToken: "journal-restore-token",
    }),
  );
  const lockPath = hubMaintenanceLockPath(fixture.hubRoot);
  await mkdir(lockPath, { recursive: true });
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
    format: "cpb-hub-maintenance/v1",
    ownerToken: "different-restore-token",
    operation: "Hub restore",
    hubRoot: fixture.hubRoot,
    pid: 999_999_999,
    host: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
  })}\n`, "utf8");

  await assert.rejects(
    recoverInterruptedHubRestore({ hubRoot: fixture.hubRoot, signingKey }),
    /already held/,
  );
  await access(path.join(lockPath, "owner.json"));
  await access(hubRestoreJournalPath(fixture.hubRoot));
});

test("interrupted restore recovery verifies and accepts a committed target", async () => {
  const fixture = await setupHubFixture("cpb-hub-restore-recover-commit");
  const output = path.join(fixture.root, "backup");
  const created = await createHubBackup({ ...fixture, output });
  await writeFile(path.join(fixture.hubRoot, "queue", "queue.json"), "pre-restore-current\n", "utf8");
  const stagePath = path.join(fixture.root, `.${path.basename(fixture.hubRoot)}.restore-stage-test-commit`);
  const rollbackPath = `${fixture.hubRoot}.pre-restore-test-commit`;
  await cp(path.join(output, "data", "roots", "hub"), stagePath, { recursive: true, preserveTimestamps: true });
  await rename(fixture.hubRoot, rollbackPath);
  await rename(stagePath, fixture.hubRoot);
  await writeJsonDurableAtomic(
    hubRestoreJournalPath(fixture.hubRoot),
    restoreJournalFixture({ fixture, output, snapshotId: created.manifest.snapshotId, stagePath, rollbackPath, phase: "target_moved" }),
  );

  const recovered = await recoverInterruptedHubRestore({ hubRoot: fixture.hubRoot });

  assert.equal(recovered.recovered, true);
  assert.equal(recovered.outcome, "committed");
  assert.equal(await readFile(path.join(fixture.hubRoot, "queue", "queue.json"), "utf8"), "original-queue\n");
  assert.equal(await readFile(path.join(rollbackPath, "queue", "queue.json"), "utf8"), "pre-restore-current\n");
  await assert.rejects(access(hubRestoreJournalPath(fixture.hubRoot)));
});

test("interrupted restore recovery reports committed metadata when finalization fails", async () => {
  const fixture = await setupHubFixture("cpb-hub-restore-recover-finalize-failure");
  const output = path.join(fixture.root, "backup");
  const created = await createHubBackup({ ...fixture, output });
  const stagePath = path.join(fixture.root, `.${path.basename(fixture.hubRoot)}.restore-stage-finalize-failure`);
  const rollbackPath = `${fixture.hubRoot}.pre-restore-finalize-failure`;
  const journalPath = hubRestoreJournalPath(fixture.hubRoot);
  await cp(path.join(output, "data", "roots", "hub"), stagePath, { recursive: true, preserveTimestamps: true });
  await rename(fixture.hubRoot, rollbackPath);
  await rename(stagePath, fixture.hubRoot);
  await writeJsonDurableAtomic(
    journalPath,
    restoreJournalFixture({
      fixture,
      output,
      snapshotId: created.manifest.snapshotId,
      stagePath,
      rollbackPath,
      phase: "target_moved",
    }),
  );
  const finalizationFailure = Object.assign(new Error("simulated Redis restore finalization failure"), { code: "EIO" });
  let recoveryPaths: Record<string, string> = {};

  await withHubBackupTestHooksForTests({
    beforeFinishRedisRestoreRecovery: async () => {
      throw finalizationFailure;
    },
  }, async () => {
    await assert.rejects(
      recoverInterruptedHubRestore({ hubRoot: fixture.hubRoot }),
      (error: Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string;
        recoveryPaths?: Record<string, string>;
        attemptedPaths?: { journal?: string; stage?: string };
      }) => {
        assert.equal(error.code, "HUB_RESTORE_COMMITTED_AMBIGUOUS");
        assert.equal(error.committed, true);
        assert.equal(error.committedPath, fixture.hubRoot);
        assert.deepEqual(error.recoveryPaths, { canonical: fixture.hubRoot, rollback: rollbackPath });
        assert.equal(error.attemptedPaths?.journal, journalPath);
        assert.equal(error.attemptedPaths?.stage, stagePath);
        recoveryPaths = error.recoveryPaths || {};
        return true;
      },
    );
  });

  for (const recoveryPath of Object.values(recoveryPaths)) {
    const info = await lstat(recoveryPath);
    assert.equal(info.isSymbolicLink(), false);
  }
  assert.equal(await readFile(path.join(fixture.hubRoot, "queue", "queue.json"), "utf8"), "original-queue\n");
});

test("automatic restore recovery stays explicitly rolled back when Redis finalization then fails", async () => {
  const fixture = await setupHubFixture("cpb-hub-restore-rollback-finalize-failure");
  const output = path.join(fixture.root, "backup");
  await createHubBackup({ ...fixture, output });
  await writeFile(path.join(fixture.hubRoot, "queue", "queue.json"), "pre-restore-current\n", "utf8");
  const publicationFailure = Object.assign(new Error("simulated restore publication durability failure"), { code: "EIO" });
  const finalizationFailure = Object.assign(new Error("simulated rolled-back Redis finalization failure"), { code: "EIO" });
  let publicationFaulted = false;

  await withHubBackupTestHooksForTests({
    syncDirectory: async ({ operation }) => {
      if (operation !== "restore-stage-publish" || publicationFaulted) return;
      publicationFaulted = true;
      await rm(fixture.hubRoot, { recursive: true, force: true });
      throw publicationFailure;
    },
    beforeFinishRedisRestoreRecovery: async () => {
      throw finalizationFailure;
    },
  }, async () => {
    await assert.rejects(
      restoreHubBackup({ ...fixture, input: output, force: true }),
      (error: AggregateError & {
        code?: string;
        committed?: boolean;
        committedPath?: string | null;
        recoveryOutcome?: string;
        primaryError?: Error & { code?: string };
        recoveryError?: Error & { code?: string };
        recoveryPaths?: Record<string, string>;
        attemptedPaths?: Record<string, string>;
      }) => {
        assert.equal(error.code, "HUB_RESTORE_RECOVERY_CLEANUP_FAILED");
        assert.equal(error.committed, false);
        assert.equal(error.committedPath, null);
        assert.equal(error.recoveryOutcome, "rolled_back");
        assert.equal(error.primaryError?.code, "HUB_RESTORE_STAGE_PUBLISH_COMMITTED_AMBIGUOUS");
        assert.equal(error.recoveryError?.code, "HUB_RESTORE_RECOVERY_CLEANUP_FAILED");
        assert.deepEqual(error.recoveryPaths, { canonical: fixture.hubRoot });
        assert.equal(error.attemptedPaths?.journal, hubRestoreJournalPath(fixture.hubRoot));
        assert.ok(error.attemptedPaths?.stage);
        assert.ok(error.attemptedPaths?.rollback);
        return true;
      },
    );
  });

  assert.equal(publicationFaulted, true);
  assert.equal(await readFile(path.join(fixture.hubRoot, "queue", "queue.json"), "utf8"), "pre-restore-current\n");
  await assert.rejects(access(hubRestoreJournalPath(fixture.hubRoot)), { code: "ENOENT" });
});

test("interrupted restore recovery preserves an invalid canonical successor and rollback root", async () => {
  const fixture = await setupHubFixture("cpb-hub-restore-recover-invalid-commit");
  const output = path.join(fixture.root, "backup");
  const created = await createHubBackup({ ...fixture, output });
  await writeFile(path.join(fixture.hubRoot, "queue", "queue.json"), "pre-restore-current\n", "utf8");
  const stagePath = path.join(fixture.root, `.${path.basename(fixture.hubRoot)}.restore-stage-test-invalid`);
  const rollbackPath = `${fixture.hubRoot}.pre-restore-test-invalid`;
  await cp(path.join(output, "data", "roots", "hub"), stagePath, { recursive: true, preserveTimestamps: true });
  await rename(fixture.hubRoot, rollbackPath);
  await rename(stagePath, fixture.hubRoot);
  await writeFile(path.join(fixture.hubRoot, "queue", "queue.json"), "corrupt-replacement\n", "utf8");
  await writeJsonDurableAtomic(
    hubRestoreJournalPath(fixture.hubRoot),
    restoreJournalFixture({ fixture, output, snapshotId: created.manifest.snapshotId, stagePath, rollbackPath, phase: "target_moved" }),
  );

  await assert.rejects(
    recoverInterruptedHubRestore({ hubRoot: fixture.hubRoot }),
    (error: Error & {
      code?: string;
      committed?: boolean;
      successorPreserved?: boolean;
      recoveryPaths?: { canonical?: string; rollback?: string };
    }) => {
      assert.equal(error.code, "HUB_RESTORE_SUCCESSOR_PRESERVED");
      assert.equal(error.committed, false);
      assert.equal(error.successorPreserved, true);
      assert.deepEqual(error.recoveryPaths, { canonical: fixture.hubRoot, rollback: rollbackPath });
      return true;
    },
  );
  assert.equal(await readFile(path.join(fixture.hubRoot, "queue", "queue.json"), "utf8"), "corrupt-replacement\n");
  assert.equal(await readFile(path.join(rollbackPath, "queue", "queue.json"), "utf8"), "pre-restore-current\n");
  await access(hubRestoreJournalPath(fixture.hubRoot));
});

test("staged interrupted restore leaves the current target unchanged and removes the stage", async () => {
  const fixture = await setupHubFixture("cpb-hub-restore-recover-staged");
  const output = path.join(fixture.root, "backup");
  const created = await createHubBackup({ ...fixture, output });
  const stagePath = path.join(fixture.root, `.${path.basename(fixture.hubRoot)}.restore-stage-test-staged`);
  const rollbackPath = `${fixture.hubRoot}.pre-restore-test-staged`;
  await mkdir(stagePath, { recursive: true });
  await writeJsonDurableAtomic(
    hubRestoreJournalPath(fixture.hubRoot),
    restoreJournalFixture({ fixture, output, snapshotId: created.manifest.snapshotId, stagePath, rollbackPath, phase: "staged" }),
  );

  const recovered = await recoverInterruptedHubRestore({ hubRoot: fixture.hubRoot });

  assert.equal(recovered.recovered, true);
  assert.equal(recovered.outcome, "rolled_back");
  assert.equal(await readFile(path.join(fixture.hubRoot, "queue", "queue.json"), "utf8"), "original-queue\n");
  await assert.rejects(access(stagePath));
});

test("restore journal reads reject symlinks and oversized metadata without mutating recovery paths", async () => {
  for (const variant of ["symlink", "oversize"] as const) {
    const fixture = await setupHubFixture(`cpb-hub-restore-journal-${variant}`);
    const output = path.join(fixture.root, "backup");
    const created = await createHubBackup({ ...fixture, output });
    const stagePath = path.join(fixture.root, `.${path.basename(fixture.hubRoot)}.restore-stage-${variant}`);
    const rollbackPath = `${fixture.hubRoot}.pre-restore-${variant}`;
    const journalPath = hubRestoreJournalPath(fixture.hubRoot);
    await mkdir(stagePath, { recursive: true });
    const journal = restoreJournalFixture({
      fixture,
      output,
      snapshotId: created.manifest.snapshotId,
      stagePath,
      rollbackPath,
      phase: "staged",
    });
    if (variant === "symlink") {
      const externalJournal = path.join(fixture.root, "external-restore.json");
      await writeJsonDurableAtomic(externalJournal, journal);
      await symlink(externalJournal, journalPath);
    } else {
      await writeFile(journalPath, "{", "utf8");
      await truncate(journalPath, 1024 * 1024 + 1);
    }

    await assert.rejects(
      recoverInterruptedHubRestore({ hubRoot: fixture.hubRoot }),
      { code: variant === "symlink" ? "BOUNDED_FILE_UNSAFE" : "BOUNDED_FILE_TOO_LARGE" },
    );
    await access(stagePath);
    await access(journalPath);
  }
});

test("Redis rollback snapshot reads are bounded, no-follow, and generation pinned", async () => {
  const root = await tempRoot("cpb-hub-redis-rollback-reader");
  const snapshot = {
    format: "cpb-hub-redis-logical-snapshot/v1",
    backendIdentityFingerprint: "a".repeat(64),
    capturedAt: new Date(0).toISOString(),
    hashFields: [],
    jobStreams: [],
    sha256: "b".repeat(64),
  };
  const raw = `${JSON.stringify(snapshot)}\n`;

  const external = path.join(root, "external.json");
  const symlinkPath = path.join(root, "rollback-symlink.json");
  await writeFile(external, raw, { encoding: "utf8", mode: 0o600 });
  await symlink(external, symlinkPath);
  await assert.rejects(
    _internalReadRedisRollbackSnapshotForTests(symlinkPath, snapshot.sha256),
    { code: "BOUNDED_FILE_UNSAFE" },
  );

  const oversized = path.join(root, "rollback-oversized.json");
  await writeFile(oversized, "{", { encoding: "utf8", mode: 0o600 });
  await truncate(oversized, 300 * 1024 * 1024 + 1);
  await assert.rejects(
    _internalReadRedisRollbackSnapshotForTests(oversized, snapshot.sha256),
    { code: "BOUNDED_FILE_TOO_LARGE" },
  );

  const replacedPath = path.join(root, "rollback-replaced.json");
  await writeFile(replacedPath, raw, { encoding: "utf8", mode: 0o600 });
  let replaced = false;
  await withHubBackupTestHooksForTests({
    readHooks: {
      "redis-rollback": {
        afterOpen: async ({ filePath }) => {
          if (replaced) return;
          replaced = true;
          await rename(filePath, `${filePath}.predecessor`);
          await writeFile(filePath, raw, { encoding: "utf8", mode: 0o600 });
        },
      },
    },
  }, async () => {
    await assert.rejects(
      _internalReadRedisRollbackSnapshotForTests(replacedPath, snapshot.sha256),
      { code: "BOUNDED_FILE_CHANGED" },
    );
  });
});

test("Redis backup snapshot cleanup isolates owned artifacts and preserves after-repin successors", async () => {
  const ordinaryRoot = await tempRoot("cpb-hub-redis-artifact-cleanup");
  const ordinaryPath = path.join(ordinaryRoot, `.cpb-redis-logical-snapshot-${randomUUID()}.json`);
  await writeFile(ordinaryPath, "ordinary\n", { encoding: "utf8", mode: 0o600 });

  await _internalCleanupRedisSnapshotArtifactForTests(ordinaryPath);

  await assert.rejects(access(ordinaryPath), { code: "ENOENT" });
  const isolatedNames = await readdir(ordinaryRoot);
  assert.equal(isolatedNames.length, 1);
  assert.equal(isolatedNames[0].startsWith(".removed-"), true);
  const isolatedPath = path.join(ordinaryRoot, isolatedNames[0]);
  const isolatedInfo = await lstat(isolatedPath);
  assert.equal(isolatedInfo.isFile(), true);
  assert.equal(isolatedInfo.isSymbolicLink(), false);
  assert.equal(await readFile(isolatedPath, "utf8"), "ordinary\n");

  for (const variant of ["regular", "symlink"] as const) {
    const root = await tempRoot(`cpb-hub-redis-artifact-${variant}`);
    const artifactPath = path.join(root, `.cpb-redis-logical-snapshot-${randomUUID()}.json`);
    const predecessorPath = `${artifactPath}.predecessor`;
    const externalPath = path.join(root, "external.json");
    await writeFile(artifactPath, "predecessor\n", { encoding: "utf8", mode: 0o600 });
    await writeFile(externalPath, "external\n", { encoding: "utf8", mode: 0o600 });

    await withHubBackupTestHooksForTests({
      afterRedisSnapshotRepin: async ({ filePath }) => {
        await rename(filePath, predecessorPath);
        if (variant === "regular") {
          await writeFile(filePath, "successor\n", { encoding: "utf8", mode: 0o600 });
        } else {
          await symlink(externalPath, filePath);
        }
      },
    }, async () => {
      await assert.rejects(
        _internalCleanupRedisSnapshotArtifactForTests(artifactPath),
        { code: variant === "regular" ? "HUB_BACKUP_AUTHORITY_CHANGED" : "DURABLE_REMOVE_UNSAFE" },
      );
    });

    assert.equal(await readFile(predecessorPath, "utf8"), "predecessor\n");
    if (variant === "regular") {
      assert.equal(await readFile(artifactPath, "utf8"), "successor\n");
    } else {
      assert.equal((await lstat(artifactPath)).isSymbolicLink(), true);
      assert.equal(await readFile(externalPath, "utf8"), "external\n");
    }
  }
});

test("Redis snapshot cleanup preserves successors installed at the final isolation boundary", async () => {
  for (const variant of ["regular", "symlink"] as const) {
    const root = await tempRoot(`cpb-hub-redis-artifact-final-${variant}`);
    const artifactPath = path.join(root, `.cpb-redis-logical-snapshot-${randomUUID()}.json`);
    const predecessorPath = `${artifactPath}.predecessor`;
    const externalPath = path.join(root, "external.json");
    let quarantinePath = "";
    await writeFile(artifactPath, "predecessor\n", { encoding: "utf8", mode: 0o600 });
    await writeFile(externalPath, "external\n", { encoding: "utf8", mode: 0o600 });

    await withHubBackupTestHooksForTests({
      beforeRedisSnapshotFinalIsolation: async (context) => {
        quarantinePath = context.quarantinePath;
        await rename(context.filePath, predecessorPath);
        if (variant === "regular") {
          await writeFile(context.filePath, "successor\n", { encoding: "utf8", mode: 0o600 });
        } else {
          await symlink(externalPath, context.filePath);
        }
      },
    }, async () => {
      await assert.rejects(
        _internalCleanupRedisSnapshotArtifactForTests(artifactPath),
        { code: "DURABLE_REMOVE_RACE" },
      );
    });

    assert.equal(await readFile(predecessorPath, "utf8"), "predecessor\n");
    if (variant === "regular") assert.equal(await readFile(artifactPath, "utf8"), "successor\n");
    else assert.equal((await lstat(artifactPath)).isSymbolicLink(), true);
    await assert.rejects(access(quarantinePath), { code: "ENOENT" });
  }
});

test("stale Redis snapshot cleanup preserves regular and symlink successors after repinning", async () => {
  for (const variant of ["regular", "symlink"] as const) {
    const hubRoot = await tempRoot(`cpb-hub-stale-redis-artifact-${variant}`);
    const artifactPath = path.join(hubRoot, `.cpb-redis-logical-snapshot-${randomUUID()}.json`);
    const predecessorPath = `${artifactPath}.predecessor`;
    const externalPath = path.join(hubRoot, "external.json");
    await writeFile(artifactPath, "predecessor\n", { encoding: "utf8", mode: 0o600 });
    await writeFile(externalPath, "external\n", { encoding: "utf8", mode: 0o600 });

    await withHubBackupTestHooksForTests({
      afterRedisSnapshotRepin: async ({ filePath }) => {
        await rename(filePath, predecessorPath);
        if (variant === "regular") {
          await writeFile(filePath, "successor\n", { encoding: "utf8", mode: 0o600 });
        } else {
          await symlink(externalPath, filePath);
        }
      },
    }, async () => {
      await assert.rejects(
        recoverInterruptedHubRestore({ hubRoot }),
        { code: variant === "regular" ? "HUB_BACKUP_AUTHORITY_CHANGED" : "DURABLE_REMOVE_UNSAFE" },
      );
    });

    assert.equal(await readFile(predecessorPath, "utf8"), "predecessor\n");
    if (variant === "regular") {
      assert.equal(await readFile(artifactPath, "utf8"), "successor\n");
    } else {
      assert.equal((await lstat(artifactPath)).isSymbolicLink(), true);
      assert.equal(await readFile(externalPath, "utf8"), "external\n");
    }
  }
});

test("restore journal pinned read rejects a same-content path replacement", async () => {
  const fixture = await setupHubFixture("cpb-hub-restore-journal-pinned-replacement");
  const output = path.join(fixture.root, "backup");
  const created = await createHubBackup({ ...fixture, output });
  const stagePath = path.join(fixture.root, `.${path.basename(fixture.hubRoot)}.restore-stage-pinned-replacement`);
  const rollbackPath = `${fixture.hubRoot}.pre-restore-pinned-replacement`;
  const journalPath = hubRestoreJournalPath(fixture.hubRoot);
  await mkdir(stagePath, { recursive: true });
  await writeJsonDurableAtomic(journalPath, restoreJournalFixture({
    fixture,
    output,
    snapshotId: created.manifest.snapshotId,
    stagePath,
    rollbackPath,
    phase: "staged",
  }));
  const raw = await readFile(journalPath, "utf8");
  let replaced = false;

  await withHubBackupTestHooksForTests({
    readHooks: {
      "restore-journal": {
        afterOpen: async ({ filePath }) => {
          if (replaced) return;
          replaced = true;
          await rename(filePath, `${filePath}.predecessor`);
          await writeFile(filePath, raw, "utf8");
        },
      },
    },
  }, async () => {
    await assert.rejects(
      recoverInterruptedHubRestore({ hubRoot: fixture.hubRoot }),
      { code: "BOUNDED_FILE_CHANGED" },
    );
  });

  await access(stagePath);
  assert.equal(await readFile(journalPath, "utf8"), raw);
});

test("restore stage cleanup rejects a same-token restore journal ABA successor", async () => {
  const fixture = await setupHubFixture("cpb-hub-restore-journal-aba");
  const output = path.join(fixture.root, "backup");
  const created = await createHubBackup({ ...fixture, output });
  const stagePath = path.join(fixture.root, `.${path.basename(fixture.hubRoot)}.restore-stage-journal-aba`);
  const rollbackPath = `${fixture.hubRoot}.pre-restore-journal-aba`;
  const journalPath = hubRestoreJournalPath(fixture.hubRoot);
  await mkdir(stagePath, { recursive: true });
  await writeFile(path.join(stagePath, "must-survive.txt"), "successor\n", "utf8");
  await writeJsonDurableAtomic(journalPath, restoreJournalFixture({
    fixture,
    output,
    snapshotId: created.manifest.snapshotId,
    stagePath,
    rollbackPath,
    phase: "staged",
  }));
  const raw = await readFile(journalPath, "utf8");

  await withHubBackupTestHooksForTests({
    beforeRestoreStageRemoval: async () => {
      await rename(journalPath, `${journalPath}.predecessor`);
      await writeFile(journalPath, raw, "utf8");
    },
  }, async () => {
    await assert.rejects(
      recoverInterruptedHubRestore({ hubRoot: fixture.hubRoot }),
      { code: "HUB_BACKUP_AUTHORITY_CHANGED" },
    );
  });

  assert.equal(await readFile(path.join(stagePath, "must-survive.txt"), "utf8"), "successor\n");
  assert.equal(await readFile(journalPath, "utf8"), raw);
});

test("restore stage cleanup reports committed evidence when the journal is replaced afterward", async () => {
  const fixture = await setupHubFixture("cpb-hub-restore-journal-aba-after-stage");
  const output = path.join(fixture.root, "backup");
  const created = await createHubBackup({ ...fixture, output });
  const stagePath = path.join(fixture.root, `.${path.basename(fixture.hubRoot)}.restore-stage-journal-aba-after`);
  const rollbackPath = `${fixture.hubRoot}.pre-restore-journal-aba-after`;
  const journalPath = hubRestoreJournalPath(fixture.hubRoot);
  const displacedJournal = `${journalPath}.predecessor`;
  let quarantinePath = "";
  await mkdir(stagePath, { recursive: true });
  await writeFile(path.join(stagePath, "must-survive.txt"), "predecessor\n", "utf8");
  await writeJsonDurableAtomic(journalPath, restoreJournalFixture({
    fixture,
    output,
    snapshotId: created.manifest.snapshotId,
    stagePath,
    rollbackPath,
    phase: "staged",
  }));
  const raw = await readFile(journalPath, "utf8");

  await withHubBackupTestHooksForTests({
    beforeRestoreJournalCleanupAfterStageIsolation: async ({
      journalPath: observedJournal,
      quarantinePath: observedQuarantine,
    }) => {
      quarantinePath = observedQuarantine;
      await rename(observedJournal, displacedJournal);
      await writeFile(observedJournal, raw, "utf8");
    },
  }, async () => {
    await assert.rejects(
      recoverInterruptedHubRestore({ hubRoot: fixture.hubRoot }),
      (error: Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string;
        quarantinePreserved?: boolean;
        successorPreserved?: boolean;
        recoveryPaths?: Record<string, string>;
        attemptedPaths?: Record<string, string>;
      }) => {
        assert.equal(error.code, "HUB_RESTORE_STAGE_REMOVE_COMMITTED_AMBIGUOUS");
        assert.equal(error.committed, true);
        assert.equal(error.committedPath, quarantinePath);
        assert.equal(error.quarantinePreserved, true);
        assert.equal(error.successorPreserved, true);
        assert.equal(error.recoveryPaths?.quarantine, quarantinePath);
        assert.equal(error.recoveryPaths?.journal, undefined);
        assert.equal(error.attemptedPaths?.journal, journalPath);
        assert.equal(error.attemptedPaths?.stage, stagePath);
        return true;
      },
    );
  });

  assert.equal(await readFile(path.join(quarantinePath, "must-survive.txt"), "utf8"), "predecessor\n");
  assert.equal(await readFile(journalPath, "utf8"), raw);
  assert.equal(await readFile(displacedJournal, "utf8"), raw);
});

test("restore stage cleanup preserves a same-journal stage successor before isolation", async () => {
  const fixture = await setupHubFixture("cpb-hub-restore-stage-pre-isolation-successor");
  const output = path.join(fixture.root, "backup");
  const created = await createHubBackup({ ...fixture, output });
  const stagePath = path.join(fixture.root, `.${path.basename(fixture.hubRoot)}.restore-stage-pre-isolation-successor`);
  const displaced = `${stagePath}.predecessor`;
  const rollbackPath = `${fixture.hubRoot}.pre-restore-stage-pre-isolation-successor`;
  const journalPath = hubRestoreJournalPath(fixture.hubRoot);
  await mkdir(stagePath, { recursive: true });
  await writeFile(path.join(stagePath, "must-survive.txt"), "predecessor\n", "utf8");
  await writeJsonDurableAtomic(journalPath, restoreJournalFixture({
    fixture,
    output,
    snapshotId: created.manifest.snapshotId,
    stagePath,
    rollbackPath,
    phase: "staged",
  }));

  await withHubBackupTestHooksForTests({
    beforeRestoreStageIsolation: async ({ stagePath: observedStage }) => {
      await rename(observedStage, displaced);
      await mkdir(observedStage, { recursive: true });
      await writeFile(path.join(observedStage, "must-survive.txt"), "successor\n", "utf8");
    },
  }, async () => {
    await assert.rejects(
      recoverInterruptedHubRestore({ hubRoot: fixture.hubRoot }),
      { code: "HUB_BACKUP_AUTHORITY_CHANGED" },
    );
  });

  assert.equal(await readFile(path.join(stagePath, "must-survive.txt"), "utf8"), "successor\n");
  assert.equal(await readFile(path.join(displaced, "must-survive.txt"), "utf8"), "predecessor\n");
  await access(journalPath);
});

test("restore stage cleanup reports committed recovery when a successor appears after isolation", async () => {
  const fixture = await setupHubFixture("cpb-hub-restore-stage-post-isolation-successor");
  const output = path.join(fixture.root, "backup");
  const created = await createHubBackup({ ...fixture, output });
  const stagePath = path.join(fixture.root, `.${path.basename(fixture.hubRoot)}.restore-stage-post-isolation-successor`);
  const rollbackPath = `${fixture.hubRoot}.pre-restore-stage-post-isolation-successor`;
  const journalPath = hubRestoreJournalPath(fixture.hubRoot);
  let quarantinePath = "";
  await mkdir(stagePath, { recursive: true });
  await writeFile(path.join(stagePath, "must-survive.txt"), "predecessor\n", "utf8");
  await writeJsonDurableAtomic(journalPath, restoreJournalFixture({
    fixture,
    output,
    snapshotId: created.manifest.snapshotId,
    stagePath,
    rollbackPath,
    phase: "staged",
  }));

  await withHubBackupTestHooksForTests({
    afterRestoreStageIsolation: async ({ stagePath: observedStage, quarantinePath: observedQuarantine }) => {
      quarantinePath = observedQuarantine;
      await mkdir(observedStage, { recursive: true });
      await writeFile(path.join(observedStage, "must-survive.txt"), "successor\n", "utf8");
    },
  }, async () => {
    await assert.rejects(
      recoverInterruptedHubRestore({ hubRoot: fixture.hubRoot }),
      (error: Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string;
        quarantinePreserved?: boolean;
        successorPreserved?: boolean;
        recoveryPaths?: { stage?: string; journal?: string; quarantine?: string };
        attemptedPaths?: { stage?: string };
      }) => {
        assert.equal(error.code, "HUB_RESTORE_STAGE_REMOVE_COMMITTED_AMBIGUOUS");
        assert.equal(error.committed, true);
        assert.equal(error.committedPath, quarantinePath);
        assert.equal(error.quarantinePreserved, true);
        assert.equal(error.successorPreserved, true);
        assert.equal(error.recoveryPaths?.stage, undefined);
        assert.equal(error.recoveryPaths?.journal, journalPath);
        assert.equal(error.recoveryPaths?.quarantine, quarantinePath);
        assert.equal(error.attemptedPaths?.stage, stagePath);
        return true;
      },
    );
  });

  assert.equal(await readFile(path.join(stagePath, "must-survive.txt"), "utf8"), "successor\n");
  assert.equal(await readFile(path.join(quarantinePath, "must-survive.txt"), "utf8"), "predecessor\n");
  await access(journalPath);
});

test("rollback recovery preserves an empty canonical successor and the rollback root", async () => {
  const fixture = await setupHubFixture("cpb-hub-restore-empty-successor");
  const output = path.join(fixture.root, "backup");
  const created = await createHubBackup({ ...fixture, output });
  await writeFile(path.join(fixture.hubRoot, "queue", "queue.json"), "predecessor\n", "utf8");
  const stagePath = path.join(fixture.root, `.${path.basename(fixture.hubRoot)}.restore-stage-empty-successor`);
  const rollbackPath = `${fixture.hubRoot}.pre-restore-empty-successor`;
  const journalPath = hubRestoreJournalPath(fixture.hubRoot);
  await mkdir(stagePath, { recursive: true });
  await rename(fixture.hubRoot, rollbackPath);
  await writeJsonDurableAtomic(journalPath, restoreJournalFixture({
    fixture,
    output,
    snapshotId: created.manifest.snapshotId,
    stagePath,
    rollbackPath,
    phase: "target_moved",
  }));

  await withHubBackupTestHooksForTests({
    beforeRollbackRestore: async ({ canonicalPath }) => {
      await mkdir(canonicalPath);
    },
  }, async () => {
    await assert.rejects(
      recoverInterruptedHubRestore({ hubRoot: fixture.hubRoot }),
      (error: Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string | null;
        successorPreserved?: boolean;
        recoveryPaths?: { canonical?: string; rollback?: string; publicationSource?: string };
      }) => {
        assert.equal(error.code, "HUB_RESTORE_SUCCESSOR_PRESERVED");
        assert.equal(error.committed, false);
        assert.equal(error.committedPath, null);
        assert.equal(error.successorPreserved, true);
        assert.equal(error.recoveryPaths?.canonical, fixture.hubRoot);
        assert.equal(error.recoveryPaths?.rollback, rollbackPath);
        assert.equal(error.recoveryPaths?.publicationSource, undefined);
        return true;
      },
    );
  });

  assert.deepEqual(await readdir(fixture.hubRoot), []);
  assert.equal(await readFile(path.join(rollbackPath, "queue", "queue.json"), "utf8"), "predecessor\n");
  await access(stagePath);
  await access(journalPath);
});

test("rollback recovery reports its carrier when a canonical successor appears at publication", async () => {
  const fixture = await setupHubFixture("cpb-hub-restore-publication-successor");
  const output = path.join(fixture.root, "backup");
  const created = await createHubBackup({ ...fixture, output });
  await writeFile(path.join(fixture.hubRoot, "queue", "queue.json"), "predecessor\n", "utf8");
  const stagePath = path.join(fixture.root, `.${path.basename(fixture.hubRoot)}.restore-stage-publication-successor`);
  const rollbackPath = `${fixture.hubRoot}.pre-restore-publication-successor`;
  const journalPath = hubRestoreJournalPath(fixture.hubRoot);
  await mkdir(stagePath, { recursive: true });
  await rename(fixture.hubRoot, rollbackPath);
  await writeJsonDurableAtomic(journalPath, restoreJournalFixture({
    fixture,
    output,
    snapshotId: created.manifest.snapshotId,
    stagePath,
    rollbackPath,
    phase: "target_moved",
  }));
  let publicationSource = "";

  await withHubBackupTestHooksForTests({
    beforeDirectoryNoClobberPublish: async ({ destinationPath }) => {
      if (destinationPath === fixture.hubRoot) await mkdir(destinationPath);
    },
  }, async () => {
    await assert.rejects(
      recoverInterruptedHubRestore({ hubRoot: fixture.hubRoot }),
      (error: Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string | null;
        successorPreserved?: boolean;
        recoveryPaths?: { canonical?: string; rollback?: string; publicationSource?: string };
        attemptedPaths?: { rollback?: string };
      }) => {
        assert.equal(error.code, "HUB_RESTORE_SUCCESSOR_PRESERVED");
        assert.equal(error.committed, false);
        assert.equal(error.committedPath, null);
        assert.equal(error.successorPreserved, true);
        assert.equal(error.recoveryPaths?.canonical, fixture.hubRoot);
        assert.equal(error.recoveryPaths?.rollback, undefined);
        assert.equal(error.attemptedPaths?.rollback, rollbackPath);
        publicationSource = error.recoveryPaths?.publicationSource || "";
        assert.ok(publicationSource);
        return true;
      },
    );
  });

  assert.deepEqual(await readdir(fixture.hubRoot), []);
  await assert.rejects(access(rollbackPath), { code: "ENOENT" });
  assert.equal(await readFile(path.join(publicationSource, "queue", "queue.json"), "utf8"), "predecessor\n");
  await access(stagePath);
  await access(journalPath);
});

test("rollback recovery reports committed ambiguity after rename directory sync failure", async () => {
  const fixture = await setupHubFixture("cpb-hub-restore-rollback-sync");
  const output = path.join(fixture.root, "backup");
  const created = await createHubBackup({ ...fixture, output });
  const stagePath = path.join(fixture.root, `.${path.basename(fixture.hubRoot)}.restore-stage-rollback-sync`);
  const rollbackPath = `${fixture.hubRoot}.pre-restore-rollback-sync`;
  const journalPath = hubRestoreJournalPath(fixture.hubRoot);
  await mkdir(stagePath, { recursive: true });
  await rename(fixture.hubRoot, rollbackPath);
  await writeJsonDurableAtomic(journalPath, restoreJournalFixture({
    fixture,
    output,
    snapshotId: created.manifest.snapshotId,
    stagePath,
    rollbackPath,
    phase: "target_moved",
  }));
  const syncFailure = Object.assign(new Error("simulated rollback parent sync failure"), { code: "EIO" });

  await withHubBackupTestHooksForTests({
    syncDirectory: async ({ operation }) => {
      if (operation === "rollback-restore") throw syncFailure;
    },
  }, async () => {
    await assert.rejects(
      recoverInterruptedHubRestore({ hubRoot: fixture.hubRoot }),
      (error: Error & {
        code?: string;
        cause?: unknown;
        committed?: boolean;
        committedPath?: string;
        recoveryPaths?: { canonical?: string };
      }) => {
        assert.equal(error.code, "HUB_RESTORE_ROLLBACK_COMMITTED_AMBIGUOUS");
        assert.equal(error.cause, syncFailure);
        assert.equal(error.committed, true);
        assert.equal(error.committedPath, fixture.hubRoot);
        assert.deepEqual(error.recoveryPaths, { canonical: fixture.hubRoot });
        return true;
      },
    );
  });

  await access(fixture.hubRoot);
  await assert.rejects(access(rollbackPath), { code: "ENOENT" });
  await access(journalPath);
});

test("Hub startup automatically recovers a staged restore transaction", async () => {
  const fixture = await setupHubFixture("cpb-hub-start-recover-staged");
  const output = path.join(fixture.root, "backup");
  const created = await createHubBackup({ ...fixture, output });
  const stagePath = path.join(fixture.root, `.${path.basename(fixture.hubRoot)}.restore-stage-test-startup`);
  const rollbackPath = `${fixture.hubRoot}.pre-restore-test-startup`;
  await mkdir(stagePath, { recursive: true });
  await writeJsonDurableAtomic(
    hubRestoreJournalPath(fixture.hubRoot),
    restoreJournalFixture({ fixture, output, snapshotId: created.manifest.snapshotId, stagePath, rollbackPath, phase: "staged" }),
  );

  const server = await startHubServer({ cpbRoot: fixture.cpbRoot, hubRoot: fixture.hubRoot, host: "127.0.0.1", port: 0, allowAnonymousDev: true });
  try {
    await assert.rejects(access(stagePath));
    await assert.rejects(access(hubRestoreJournalPath(fixture.hubRoot)));
  } finally {
    await server.close();
  }
});

test("Hub restore recovery rejects journal paths outside its stable sibling namespace", async () => {
  const fixture = await setupHubFixture("cpb-hub-restore-invalid-journal-path");
  const output = path.join(fixture.root, "backup");
  const created = await createHubBackup({ ...fixture, output });
  const rollbackPath = `${fixture.hubRoot}.pre-restore-invalid-journal`;
  const journal = restoreJournalFixture({
    fixture,
    output,
    snapshotId: created.manifest.snapshotId,
    stagePath: path.join(fixture.root, "not-a-restore-stage"),
    rollbackPath,
    phase: "staged",
  });
  await writeJsonDurableAtomic(hubRestoreJournalPath(fixture.hubRoot), journal);

  await assert.rejects(
    recoverInterruptedHubRestore({ hubRoot: fixture.hubRoot }),
    /invalid Hub restore journal/,
  );
});

test("Hub backup and restore preserve read-only directory modes without blocking population", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-read-only-directory");
  const queueRoot = path.join(fixture.hubRoot, "queue");
  const output = path.join(fixture.root, "backup");
  await chmod(queueRoot, 0o500);
  await createHubBackup({ ...fixture, output });
  await chmod(queueRoot, 0o700);

  try {
    await restoreHubBackup({ ...fixture, input: output, force: true });

    assert.equal((await lstat(path.join(fixture.hubRoot, "queue"))).mode & 0o777, 0o500);
    assert.equal(await readFile(path.join(fixture.hubRoot, "queue", "queue.json"), "utf8"), "original-queue\n");
  } finally {
    await chmod(path.join(fixture.hubRoot, "queue"), 0o700).catch(() => undefined);
    await chmod(path.join(output, "data", "roots", "hub", "queue"), 0o700).catch(() => undefined);
  }
});

test("Hub restore rejects targets nested inside the backup directory", async () => {
  const fixture = await setupHubFixture("cpb-hub-restore-overlap");
  const output = path.join(fixture.root, "backup");
  await createHubBackup({ ...fixture, output });

  await assert.rejects(
    restoreHubBackup({
      cpbRoot: fixture.cpbRoot,
      hubRoot: path.join(output, "nested-target"),
      input: output,
      force: true,
    }),
    /must not overlap/,
  );
});

test("Hub backup refuses a live Hub and backup paths inside the Hub root", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-offline");
  await assert.rejects(
    createHubBackup({ ...fixture, output: path.join(fixture.hubRoot, "backup") }),
    /outside every backed-up root/,
  );

  const hub = await startHubServer({ cpbRoot: fixture.cpbRoot, hubRoot: fixture.hubRoot, host: "127.0.0.1", port: 0, allowAnonymousDev: true });
  try {
    await assert.rejects(
      createHubBackup({ ...fixture, output: path.join(fixture.root, "live-backup") }),
      /offline control plane/,
    );
  } finally {
    await hub.close();
  }
});

test("Hub backup refuses active runner and child process registry entries", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-process-registry");
  const processRoot = path.join(fixture.projectRuntimeRoot, "processes");
  await mkdir(processRoot, { recursive: true });
  await writeFile(path.join(processRoot, "job-1.json"), `${JSON.stringify({
    jobId: "job-1",
    runnerPid: process.pid,
    processIdentity: captureProcessIdentity(process.pid, { strict: true }),
    childPids: [],
  })}\n`, "utf8");

  await assert.rejects(
    createHubBackup({ ...fixture, output: path.join(fixture.root, "backup") }),
    new RegExp(`project runtime process under .* pid ${process.pid} is alive`),
  );
});

test("Hub backup fails closed when a legacy child PID lacks an exact process identity", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-child-pid-without-identity");
  const processRoot = path.join(fixture.projectRuntimeRoot, "processes");
  await mkdir(processRoot, { recursive: true });
  await writeFile(path.join(processRoot, "job-legacy.json"), `${JSON.stringify({
    jobId: "job-legacy",
    childPids: [process.pid],
  })}\n`, "utf8");

  await assert.rejects(
    createHubBackup({ ...fixture, output: path.join(fixture.root, "backup") }),
    new RegExp(`project runtime child process under .* pid ${process.pid} lacks process identity`),
  );
});

test("Hub backup fails closed on a malformed worker registry record", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-malformed-worker");
  const workerRoot = path.join(fixture.hubRoot, "workers", "registry");
  await mkdir(workerRoot, { recursive: true });
  await writeFile(path.join(workerRoot, "worker-broken.json"), "not-json\n", "utf8");

  await assert.rejects(
    createHubBackup({ ...fixture, output: path.join(fixture.root, "backup") }),
    /invalid worker registry record/,
  );
});

test("Hub backup fails closed when Hub liveness state is unreadable", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-malformed-liveness");
  const stateRoot = path.join(fixture.hubRoot, "state");
  await mkdir(stateRoot, { recursive: true });
  await writeFile(path.join(stateRoot, "hub.json"), "not-json\n", "utf8");

  await assert.rejects(
    createHubBackup({ ...fixture, output: path.join(fixture.root, "backup") }),
    /cannot prove Hub is offline/,
  );
});

test("Hub backup rejects symbolic links instead of following data outside the Hub root", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-symlink");
  const outside = path.join(fixture.root, "outside-secret.txt");
  await writeFile(outside, "must-not-copy\n", "utf8");
  await symlink(outside, path.join(fixture.hubRoot, "outside-link"));

  await assert.rejects(
    createHubBackup({ ...fixture, output: path.join(fixture.root, "backup") }),
    /refuses symbolic link/,
  );
});

test("Hub backup verification rejects a symbolic-link data container", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-data-symlink");
  const output = path.join(fixture.root, "backup");
  const signingKey = "hub-backup-data-container-key-at-least-32-bytes";
  await createHubBackup({ ...fixture, output, signingKey });
  const externalData = path.join(fixture.root, "external-data");
  await rename(path.join(output, "data"), externalData);
  await symlink(externalData, path.join(output, "data"), "dir");

  await assert.rejects(
    verifyHubBackup(output, { signingKey }),
    /Hub backup data directory must be a real directory/,
  );
});

test("Hub backup verification rejects oversized manifests before reading JSON", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-oversized-manifest");
  const output = path.join(fixture.root, "backup");
  await createHubBackup({ ...fixture, output });
  await truncate(path.join(output, "manifest.json"), 128 * 1024 * 1024 + 1);

  await assert.rejects(verifyUnsignedHubBackup(output), /manifest exceeds/);
});

test("Hub backup verification rejects overlong manifest paths", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-overlong-path");
  const output = path.join(fixture.root, "backup");
  await createHubBackup({ ...fixture, output });
  const manifestPath = path.join(output, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.entries[0].path = "a".repeat(4097);
  const raw = `${JSON.stringify(manifest, null, 2)}\n`;
  const digest = createHash("sha256").update(raw).digest("hex");
  await writeFile(manifestPath, raw, "utf8");
  await writeFile(path.join(output, "manifest.sha256"), `${digest}  manifest.json\n`, "utf8");

  await assert.rejects(verifyUnsignedHubBackup(output), /unsafe backup manifest path/);
});

test("Hub backup refuses a registry whose project runtime root is missing", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-missing-runtime");
  await rm(fixture.projectRuntimeRoot, { recursive: true, force: true });

  await assert.rejects(
    createHubBackup({ ...fixture, output: path.join(fixture.root, "backup") }),
    /registered project runtime root is missing/,
  );
});

test("Hub restore fails closed on a malformed current project registry", async () => {
  const fixture = await setupHubFixture("cpb-hub-restore-malformed-registry");
  const output = path.join(fixture.root, "backup");
  await createHubBackup({ ...fixture, output });
  await writeFile(path.join(fixture.hubRoot, "projects.json"), "not-json\n", "utf8");

  await assert.rejects(
    restoreHubBackup({ ...fixture, input: output, force: true }),
    /Unexpected token|JSON/,
  );
  assert.equal(await readFile(path.join(fixture.hubRoot, "projects.json"), "utf8"), "not-json\n");
});
