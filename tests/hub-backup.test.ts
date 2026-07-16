import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { startHubServer } from "../server/index.js";
import {
  createHubBackup,
  recoverInterruptedHubRestore,
  restoreHubBackup,
  verifyHubBackup,
} from "../server/services/hub/hub-backup.js";
import { saveRegistry } from "../server/services/hub/hub-registry.js";
import {
  hubMaintenanceLockPath,
  hubRestoreJournalPath,
  writeJsonDurableAtomic,
} from "../shared/hub-maintenance.js";
import { tempRoot } from "./helpers.js";

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

test("Hub backup safely reclaims an owned stage left by an interrupted process", async () => {
  const fixture = await setupHubFixture("cpb-hub-backup-owned-stage");
  const output = path.join(fixture.root, "backup");
  const stage = backupStageArtifacts(fixture.hubRoot, output);
  await mkdir(stage.stage, { recursive: true });
  await writeFile(path.join(stage.stage, "partial.txt"), "partial\n", "utf8");
  await writeJsonDurableAtomic(stage.owner, {
    format: "cpb-hub-backup-stage/v1",
    hubRoot: fixture.hubRoot,
    output,
    createdAt: new Date(0).toISOString(),
  });

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
  await writeJsonDurableAtomic(stage.owner, {
    format: "cpb-hub-backup-stage/v1",
    hubRoot: fixture.hubRoot,
    output,
    createdAt: new Date(0).toISOString(),
  });

  await assert.rejects(createHubBackup({ ...fixture, output }), /backup output already exists/);

  await assert.rejects(access(stage.owner));
  await assert.rejects(access(stage.stage));
  await verifyUnsignedHubBackup(output);
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
}: {
  fixture: Awaited<ReturnType<typeof setupHubFixture>>;
  output: string;
  snapshotId: string;
  stagePath: string;
  rollbackPath: string | null;
  phase: "staged" | "target_moved" | "committed";
}) {
  const now = new Date().toISOString();
  return {
    format: "cpb-hub-restore/v1",
    snapshotId,
    input: output,
    hubRoot: fixture.hubRoot,
    targetPath: fixture.hubRoot,
    stagePath,
    rollbackPath,
    targetExisted: rollbackPath !== null,
    signatureRequired: false,
    phase,
    createdAt: now,
    updatedAt: now,
  };
}

test("interrupted restore recovery rolls back a moved target and clears a dead maintenance owner", async () => {
  const fixture = await setupHubFixture("cpb-hub-restore-recover-rollback");
  const output = path.join(fixture.root, "backup");
  const created = await createHubBackup({ ...fixture, output });
  await writeFile(path.join(fixture.hubRoot, "queue", "queue.json"), "pre-restore-current\n", "utf8");
  const stagePath = path.join(fixture.root, `.${path.basename(fixture.hubRoot)}.restore-stage-test-rollback`);
  const rollbackPath = `${fixture.hubRoot}.pre-restore-test-rollback`;
  await mkdir(stagePath, { recursive: true });
  await rename(fixture.hubRoot, rollbackPath);
  await writeJsonDurableAtomic(
    hubRestoreJournalPath(fixture.hubRoot),
    restoreJournalFixture({ fixture, output, snapshotId: created.manifest.snapshotId, stagePath, rollbackPath, phase: "target_moved" }),
  );
  const lockPath = hubMaintenanceLockPath(fixture.hubRoot);
  await mkdir(lockPath, { recursive: true });
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
    format: "cpb-hub-maintenance/v1",
    ownerToken: "crashed-restore",
    operation: "Hub restore",
    hubRoot: fixture.hubRoot,
    pid: 999_999_999,
    host: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
  })}\n`, "utf8");

  const recovered = await recoverInterruptedHubRestore({ hubRoot: fixture.hubRoot });

  assert.equal(recovered.recovered, true);
  assert.equal(recovered.outcome, "rolled_back");
  assert.equal(await readFile(path.join(fixture.hubRoot, "queue", "queue.json"), "utf8"), "pre-restore-current\n");
  await assert.rejects(access(stagePath));
  await assert.rejects(access(hubRestoreJournalPath(fixture.hubRoot)));
  await assert.rejects(access(lockPath));
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

test("interrupted restore recovery preserves an invalid replacement and restores the previous root", async () => {
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

  const recovered = await recoverInterruptedHubRestore({ hubRoot: fixture.hubRoot });

  assert.equal(recovered.recovered, true);
  assert.equal(recovered.outcome, "rolled_back");
  if (!("failedReplacementPath" in recovered)) assert.fail("invalid replacement path was not preserved");
  assert.ok(recovered.failedReplacementPath);
  assert.equal(await readFile(path.join(fixture.hubRoot, "queue", "queue.json"), "utf8"), "pre-restore-current\n");
  assert.equal(
    await readFile(path.join(String(recovered.failedReplacementPath), "queue", "queue.json"), "utf8"),
    "corrupt-replacement\n",
  );
  await assert.rejects(access(hubRestoreJournalPath(fixture.hubRoot)));
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
    childPids: [],
  })}\n`, "utf8");

  await assert.rejects(
    createHubBackup({ ...fixture, output: path.join(fixture.root, "backup") }),
    new RegExp(`project runtime process ${process.pid} is alive`),
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
