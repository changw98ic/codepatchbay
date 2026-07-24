import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inspectHubAccessAuditUsage,
  openHubAccessAudit,
  verifyHubAccessAudit,
  verifyHubAccessAuditFile,
} from "../server/services/audit/hub-access-audit.js";
import {
  createHubAccessAuditArchive,
  recoverHubAccessAuditArchive,
  verifyHubAccessAuditArchive,
} from "../server/services/audit/hub-access-audit-archive.js";
import { run as runHubCommand } from "../cli/commands/hub.js";

const SIGNING_KEY = "archive-signing-key-32-bytes-minimum";

async function appendRecords(hubRoot: string, count = 2) {
  const writer = await openHubAccessAudit({ hubRoot, maxBytes: 1024 * 1024 });
  for (let index = 0; index < count; index += 1) {
    await writer.append({
      requestId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      method: "GET",
      path: `/archive/${index + 1}?secret=excluded`,
      statusCode: 200,
      outcome: "allowed",
      principalId: "archive-test",
      durationMs: index + 1,
    });
  }
  await writer.close();
  return verifyHubAccessAudit({ hubRoot, maxBytes: 1024 * 1024 });
}

async function exists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("audit archive recovery is a no-op before a new Hub root exists", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "cpb-audit-new-hub-"));
  const hubRoot = path.join(parent, "hub");

  assert.deepEqual(
    await recoverHubAccessAuditArchive({ hubRoot }),
    { recovered: false, outcome: "none" },
  );
  assert.equal(await exists(hubRoot), false);
});

test("offline audit archive publishes a signed verified snapshot before resetting the live log", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-audit-archive-hub-"));
  const output = path.join(await mkdtemp(path.join(os.tmpdir(), "cpb-audit-archive-out-")), "archive");
  const before = await appendRecords(hubRoot, 3);

  const created = await createHubAccessAuditArchive({ hubRoot, output, signingKey: SIGNING_KEY });
  assert.equal(created.output, await realpath(output));
  assert.equal(created.manifest.recordCount, 3);
  assert.equal(created.manifest.lastHash, before.lastHash);
  assert.equal(created.manifest.signature?.algorithm, "hmac-sha256");

  const verified = await verifyHubAccessAuditArchive(output, {
    signingKey: SIGNING_KEY,
    requireSignature: true,
  });
  assert.equal(verified.manifest.manifestHash, created.manifest.manifestHash);
  assert.equal(verified.log.recordCount, 3);

  const live = await verifyHubAccessAudit({ hubRoot, maxBytes: 1024 * 1024 });
  assert.equal(live.recordCount, 0);
  assert.equal(live.sizeBytes, 0);

  const writer = await openHubAccessAudit({ hubRoot, maxBytes: 1024 * 1024 });
  const firstAfterArchive = await writer.append({
    requestId: "00000000-0000-4000-8000-000000000099",
    method: "GET",
    path: "/after-archive",
    statusCode: 200,
    outcome: "allowed",
    durationMs: 1,
  });
  await writer.close();
  assert.equal(firstAfterArchive.sequence, 1);
});

test("archiving a full audit restores write capacity without losing the terminal chain", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-audit-full-archive-hub-"));
  const output = path.join(await mkdtemp(path.join(os.tmpdir(), "cpb-audit-full-archive-out-")), "archive");
  const writer = await openHubAccessAudit({ hubRoot, maxBytes: 64 * 1024 });
  let fullError: NodeJS.ErrnoException | null = null;
  for (let index = 0; index < 100; index += 1) {
    try {
      await writer.append({
        requestId: randomUUID(),
        method: "GET",
        path: `/${"x".repeat(4000)}`,
        statusCode: 200,
        outcome: "allowed",
        durationMs: 1,
      });
    } catch (error) {
      fullError = error as NodeJS.ErrnoException;
      break;
    }
  }
  await writer.close();
  assert.equal(fullError?.code, "HUB_ACCESS_AUDIT_FULL");
  const terminal = await verifyHubAccessAudit({ hubRoot, maxBytes: 64 * 1024 });

  const archived = await createHubAccessAuditArchive({
    hubRoot,
    output,
    maxBytes: 64 * 1024,
    minimumFreeBytes: 0,
  });
  assert.equal(archived.manifest.lastHash, terminal.lastHash);
  assert.equal(archived.manifest.recordCount, terminal.recordCount);

  const reopened = await openHubAccessAudit({ hubRoot, maxBytes: 64 * 1024 });
  const record = await reopened.append({
    requestId: "00000000-0000-4000-8000-000000000777",
    method: "GET",
    path: "/capacity-restored",
    statusCode: 200,
    outcome: "allowed",
    durationMs: 1,
  });
  await reopened.close();
  assert.equal(record.sequence, 1);
});

test("audit archive refuses a live Hub and leaves the source untouched", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-audit-live-hub-"));
  const output = path.join(await mkdtemp(path.join(os.tmpdir(), "cpb-audit-live-out-")), "archive");
  const before = await appendRecords(hubRoot, 1);
  await mkdir(path.join(hubRoot, "state"), { recursive: true });
  await writeFile(path.join(hubRoot, "state", "hub.json"), `${JSON.stringify({
    health: "ok",
    pid: process.pid,
    startedAt: new Date().toISOString(),
  })}\n`);

  await assert.rejects(
    createHubAccessAuditArchive({ hubRoot, output }),
    /offline.*Hub|Hub.*offline/i,
  );
  assert.equal(await exists(output), false);
  const after = await verifyHubAccessAudit({ hubRoot, maxBytes: 1024 * 1024 });
  assert.equal(after.lastHash, before.lastHash);
  assert.equal(after.recordCount, 1);
});

test("audit archive rejects insufficient target space before creating transaction state", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-audit-space-hub-"));
  const output = path.join(await mkdtemp(path.join(os.tmpdir(), "cpb-audit-space-out-")), "archive");
  const before = await appendRecords(hubRoot, 1);
  await assert.rejects(
    createHubAccessAuditArchive({
      hubRoot,
      output,
      minimumFreeBytes: Number.MAX_SAFE_INTEGER,
    }),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "HUB_ACCESS_AUDIT_ARCHIVE_INSUFFICIENT_SPACE");
      return true;
    },
  );
  assert.equal(await exists(output), false);
  assert.equal(await exists(path.join(hubRoot, "audit", "http-access.archive.json")), false);
  const after = await verifyHubAccessAudit({ hubRoot, maxBytes: 1024 * 1024 });
  assert.equal(after.lastHash, before.lastHash);
});

test("archive verification rejects tampering and enforces signature policy", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-audit-tamper-hub-"));
  const output = path.join(await mkdtemp(path.join(os.tmpdir(), "cpb-audit-tamper-out-")), "archive");
  await appendRecords(hubRoot, 2);
  await createHubAccessAuditArchive({ hubRoot, output, signingKey: SIGNING_KEY });

  await assert.rejects(
    verifyHubAccessAuditArchive(output, { signingKey: "wrong-signing-key-that-is-long-enough", requireSignature: true }),
    /signature/i,
  );
  await writeFile(path.join(output, "http-access.jsonl"), "tampered\n", { flag: "a" });
  await assert.rejects(
    verifyHubAccessAuditArchive(output, { signingKey: SIGNING_KEY, requireSignature: true }),
    /hash|JSON|sequence|size|exceeds/i,
  );

  const unsignedHub = await mkdtemp(path.join(os.tmpdir(), "cpb-audit-unsigned-hub-"));
  const unsignedOutput = path.join(await mkdtemp(path.join(os.tmpdir(), "cpb-audit-unsigned-out-")), "archive");
  await appendRecords(unsignedHub, 1);
  await createHubAccessAuditArchive({ hubRoot: unsignedHub, output: unsignedOutput });
  await assert.rejects(
    verifyHubAccessAuditArchive(unsignedOutput, { requireSignature: true }),
    /signature/i,
  );

  if (process.platform !== "win32") {
    const link = path.join(path.dirname(unsignedOutput), "archive-link");
    await symlink(unsignedOutput, link, "dir");
    await assert.rejects(verifyHubAccessAuditArchive(link), /real directory/);
  }
});

test("archive verification rejects a symlinked manifest without touching its target", async () => {
  if (process.platform === "win32") return;
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-audit-manifest-link-hub-"));
  const output = path.join(await mkdtemp(path.join(os.tmpdir(), "cpb-audit-manifest-link-out-")), "archive");
  await appendRecords(hubRoot, 1);
  await createHubAccessAuditArchive({ hubRoot, output });
  const manifestPath = path.join(output, "manifest.json");
  const targetPath = path.join(path.dirname(output), "manifest-target.json");
  await rename(manifestPath, targetPath);
  const targetBytes = await readFile(targetPath);
  await symlink(targetPath, manifestPath);

  await assert.rejects(verifyHubAccessAuditArchive(output), /symbolic|symlink|real file|no-follow/i);
  assert.deepEqual(await readFile(targetPath), targetBytes);
  assert.equal((await lstat(manifestPath)).isSymbolicLink(), true);
});

test("archive verification rejects oversized and growing manifests with bounded reads", async (t) => {
  await t.test("oversized", async () => {
    const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-audit-manifest-large-hub-"));
    const output = path.join(await mkdtemp(path.join(os.tmpdir(), "cpb-audit-manifest-large-out-")), "archive");
    await appendRecords(hubRoot, 1);
    await createHubAccessAuditArchive({ hubRoot, output });
    const manifestPath = path.join(output, "manifest.json");
    await writeFile(manifestPath, "x".repeat(64 * 1024 + 1));
    await assert.rejects(verifyHubAccessAuditArchive(output), /exceeds 65536 bytes/i);
    assert.equal((await lstat(manifestPath)).size, 64 * 1024 + 1);
  });

  await t.test("growth-after-open", async () => {
    const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-audit-manifest-grow-hub-"));
    const output = path.join(await mkdtemp(path.join(os.tmpdir(), "cpb-audit-manifest-grow-out-")), "archive");
    await appendRecords(hubRoot, 1);
    await createHubAccessAuditArchive({ hubRoot, output });
    const manifestPath = path.join(output, "manifest.json");
    const canonicalManifestPath = await realpath(manifestPath);
    let injected = false;
    await assert.rejects(
      verifyHubAccessAuditArchive(output, {
        hooksForTest: {
          async afterOpen({ filePath }: { filePath: string }) {
            if (injected || filePath !== canonicalManifestPath) return;
            injected = true;
            await writeFile(filePath, "x".repeat(64 * 1024 + 1));
          },
        },
      }),
      /changed|grew|exceeds 65536 bytes/i,
    );
    assert.equal(injected, true);
  });
});

test("stage recovery preserves a same-owner ABA successor", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-audit-stage-aba-hub-"));
  const outputParent = await mkdtemp(path.join(os.tmpdir(), "cpb-audit-stage-aba-out-"));
  const output = path.join(outputParent, "archive");
  await appendRecords(hubRoot, 1);
  await assert.rejects(
    createHubAccessAuditArchive({
      hubRoot,
      output,
      faultInjector(phase) {
        if (phase === "stage_created") throw new Error("leave owned stage");
      },
    }),
    /leave owned stage/,
  );
  const journalPath = path.join(hubRoot, "audit", "http-access.archive.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { stage: string };
  const displaced = `${journal.stage}.original`;
  const sentinel = path.join(journal.stage, "successor.txt");
  let injected = false;

  await assert.rejects(
    recoverHubAccessAuditArchive({
      hubRoot,
      hooksForTest: {
        async beforeStageIsolation({ stage }: { stage: string }) {
          if (injected) return;
          injected = true;
          await rename(stage, displaced);
          await mkdir(stage, { mode: 0o700 });
          await writeFile(sentinel, "same-owner successor\n", { mode: 0o600 });
        },
      },
    }),
    /generation|identity|changed|preserv/i,
  );
  assert.equal(injected, true);
  assert.equal(await readFile(sentinel, "utf8"), "same-owner successor\n");
  await lstat(displaced);
});

test("archive verification rejects a same-content directory replacement after validation", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-audit-post-verify-hub-"));
  const output = path.join(await mkdtemp(path.join(os.tmpdir(), "cpb-audit-post-verify-out-")), "archive");
  await appendRecords(hubRoot, 1);
  await createHubAccessAuditArchive({ hubRoot, output });
  const successor = `${output}.successor`;
  const displaced = `${output}.displaced`;
  await cp(output, successor, { recursive: true, preserveTimestamps: true });
  let injected = false;

  await assert.rejects(
    verifyHubAccessAuditArchive(output, {
      hooksForTest: {
        async afterArchiveValidation({ archiveRoot }: { archiveRoot: string }) {
          if (injected) return;
          injected = true;
          await rename(archiveRoot, displaced);
          await rename(successor, archiveRoot);
        },
      },
    }),
    /generation|identity|changed|replaced/i,
  );
  assert.equal(injected, true);
  await lstat(output);
  await lstat(displaced);
});

test("archive creation refuses a same-content stage replacement after validation", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-audit-stage-post-verify-hub-"));
  const output = path.join(await mkdtemp(path.join(os.tmpdir(), "cpb-audit-stage-post-verify-out-")), "archive");
  await appendRecords(hubRoot, 1);
  let injected = false;
  let stage = "";
  let displaced = "";

  await assert.rejects(
    createHubAccessAuditArchive({
      hubRoot,
      output,
      hooksForTest: {
        async afterArchiveValidation({ archiveRoot }: { archiveRoot: string }) {
          if (injected) return;
          injected = true;
          stage = archiveRoot;
          const successor = `${archiveRoot}.successor`;
          displaced = `${archiveRoot}.displaced`;
          await cp(archiveRoot, successor, { recursive: true, preserveTimestamps: true });
          await rename(archiveRoot, displaced);
          await rename(successor, archiveRoot);
        },
      },
    }),
    /generation|identity|changed|replaced/i,
  );
  assert.equal(injected, true);
  assert.equal(await exists(output), false);
  await lstat(stage);
  await lstat(displaced);
  await verifyHubAccessAuditArchive(stage);
  await verifyHubAccessAuditArchive(displaced);
});

test("published recovery refuses a same-content archive generation replacement", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-audit-output-generation-hub-"));
  const output = path.join(await mkdtemp(path.join(os.tmpdir(), "cpb-audit-output-generation-out-")), "archive");
  await appendRecords(hubRoot, 1);
  await assert.rejects(
    createHubAccessAuditArchive({
      hubRoot,
      output,
      faultInjector(phase) {
        if (phase === "published") throw new Error("leave published archive");
      },
    }),
    /leave published archive/,
  );
  const liveLog = path.join(hubRoot, "audit", "http-access.jsonl");
  const liveBytes = await readFile(liveLog);
  const displaced = `${output}.displaced`;
  await rename(output, displaced);
  await cp(displaced, output, { recursive: true, preserveTimestamps: true });
  const canonicalOutput = await realpath(output);

  await assert.rejects(
    recoverHubAccessAuditArchive({ hubRoot }),
    (error: unknown) => {
      const candidate = error as NodeJS.ErrnoException & { committed?: boolean; committedPath?: string };
      assert.equal(candidate.code, "HUB_ACCESS_AUDIT_ARCHIVE_RECOVERY_CONFLICT");
      assert.equal(candidate.committed, true);
      assert.equal(candidate.committedPath, canonicalOutput);
      return true;
    },
  );
  assert.deepEqual(await readFile(liveLog), liveBytes);
  await verifyHubAccessAuditArchive(output);
  await verifyHubAccessAuditArchive(displaced);
});

test("archive publication revalidates content before resetting the source", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-audit-publish-revalidate-hub-"));
  const outputParent = await realpath(await mkdtemp(path.join(os.tmpdir(), "cpb-audit-publish-revalidate-out-")));
  const output = path.join(outputParent, "archive");
  const before = await appendRecords(hubRoot, 1);
  const liveLog = path.join(hubRoot, "audit", "http-access.jsonl");
  const liveBytes = await readFile(liveLog);

  await assert.rejects(
    createHubAccessAuditArchive({
      hubRoot,
      output,
      async faultInjector(phase) {
        if (phase !== "published") return;
        await writeFile(path.join(output, "http-access.jsonl"), "tampered after validation\n", { flag: "a" });
      },
    }),
    (error: unknown) => {
      const candidate = error as Error & { committed?: boolean; committedPath?: string };
      assert.match(candidate.message, /hash|size|changed|exceeds/i);
      assert.equal(candidate.committed, true);
      assert.equal(candidate.committedPath, output);
      return true;
    },
  );
  assert.deepEqual(await readFile(liveLog), liveBytes);
  const live = await verifyHubAccessAuditFile(liveLog, { maxBytes: 1024 * 1024 });
  assert.equal(live.lastHash, before.lastHash);
  assert.equal(live.recordCount, 1);
  await assert.rejects(verifyHubAccessAuditArchive(output), /hash|size|exceeds/i);
});

test("published recovery preserves a same-content journal successor with committed metadata", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-audit-journal-aba-hub-"));
  const output = path.join(await mkdtemp(path.join(os.tmpdir(), "cpb-audit-journal-aba-out-")), "archive");
  await appendRecords(hubRoot, 1);
  await assert.rejects(
    createHubAccessAuditArchive({
      hubRoot,
      output,
      faultInjector(phase) {
        if (phase === "published") throw new Error("leave published journal");
      },
    }),
    /leave published journal/,
  );
  const journalPath = await realpath(path.join(hubRoot, "audit", "http-access.archive.json"));
  const publishedOutput = await realpath(output);
  const journalBytes = await readFile(journalPath);
  const displaced = `${journalPath}.displaced`;
  let injected = false;

  await assert.rejects(
    recoverHubAccessAuditArchive({
      hubRoot,
      hooksForTest: {
        async beforeDurableRemoval({ filePath }: { filePath: string }) {
          if (injected || filePath !== journalPath) return;
          injected = true;
          await rename(filePath, displaced);
          await writeFile(filePath, journalBytes, { mode: 0o600 });
        },
      },
    }),
    (error: unknown) => {
      const candidate = error as Error & {
        committed?: boolean;
        committedPath?: string;
        recoveryPaths?: string[] | Record<string, string>;
      };
      assert.equal(candidate.committed, true);
      assert.equal(candidate.committedPath, publishedOutput);
      assert.match(JSON.stringify(candidate.recoveryPaths), /http-access\.archive\.json/);
      return true;
    },
  );
  assert.equal(injected, true);
  assert.deepEqual(await readFile(journalPath), journalBytes);
  assert.deepEqual(await readFile(displaced), journalBytes);
});

test("published archive reset preserves a same-content live-log successor", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-audit-log-aba-hub-"));
  const outputParent = await realpath(await mkdtemp(path.join(os.tmpdir(), "cpb-audit-log-aba-out-")));
  const output = path.join(outputParent, "archive");
  await appendRecords(hubRoot, 1);
  const liveLog = await realpath(path.join(hubRoot, "audit", "http-access.jsonl"));
  const liveBytes = await readFile(liveLog);
  const displaced = `${liveLog}.displaced`;
  let injected = false;

  await assert.rejects(
    createHubAccessAuditArchive({
      hubRoot,
      output,
      hooksForTest: {
        async beforeDurableRemoval({ filePath }: { filePath: string }) {
          if (injected || filePath !== liveLog) return;
          injected = true;
          await rename(filePath, displaced);
          await writeFile(filePath, liveBytes, { mode: 0o600 });
        },
      },
    }),
    (error: unknown) => {
      const candidate = error as Error & {
        committed?: boolean;
        committedPath?: string;
        recoveryPaths?: string[] | Record<string, string>;
      };
      assert.equal(candidate.committed, true);
      assert.equal(candidate.committedPath, output);
      assert.match(JSON.stringify(candidate.recoveryPaths), /http-access\.jsonl/);
      return true;
    },
  );
  assert.equal(injected, true);
  assert.deepEqual(await readFile(liveLog), liveBytes);
  assert.deepEqual(await readFile(displaced), liveBytes);
  await lstat(output);
});

test("recovery completes an archive published before a simulated crash", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-audit-published-hub-"));
  const output = path.join(await mkdtemp(path.join(os.tmpdir(), "cpb-audit-published-out-")), "archive");
  const canonicalOutput = path.join(await realpath(path.dirname(output)), path.basename(output));
  const before = await appendRecords(hubRoot, 2);

  await assert.rejects(
    createHubAccessAuditArchive({
      hubRoot,
      output,
      signingKey: SIGNING_KEY,
      faultInjector(phase) {
        if (phase === "published") throw new Error("simulated crash after publish");
      },
    }),
    (error: unknown) => {
      const candidate = error as Error & {
        committed?: boolean;
        committedPath?: string;
        recoveryPaths?: string[] | Record<string, string>;
      };
      assert.match(candidate.message, /simulated crash/);
      assert.equal(candidate.committed, true);
      assert.equal(candidate.committedPath, canonicalOutput);
      assert.match(JSON.stringify(candidate.recoveryPaths), /http-access\.archive\.json/);
      return true;
    },
  );
  assert.equal(await exists(output), true);
  const stillLive = await readFile(path.join(hubRoot, "audit", "http-access.jsonl"), "utf8");
  assert.notEqual(stillLive, "");

  const recovered = await recoverHubAccessAuditArchive({ hubRoot, signingKey: SIGNING_KEY });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.outcome, "completed");
  const verified = await verifyHubAccessAuditArchive(output, { signingKey: SIGNING_KEY, requireSignature: true });
  assert.equal(verified.manifest.lastHash, before.lastHash);
  assert.equal((await verifyHubAccessAudit({ hubRoot, maxBytes: 1024 * 1024 })).recordCount, 0);
});

test("Hub audit startup automatically completes a published archive transaction", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-audit-startup-hub-"));
  const output = path.join(await mkdtemp(path.join(os.tmpdir(), "cpb-audit-startup-out-")), "archive");
  await appendRecords(hubRoot, 1);
  await assert.rejects(
    createHubAccessAuditArchive({
      hubRoot,
      output,
      faultInjector(phase) {
        if (phase === "published") throw new Error("simulated startup recovery");
      },
    }),
    /simulated startup recovery/,
  );
  const interrupted = await inspectHubAccessAuditUsage({ hubRoot });
  assert.equal(interrupted.archivePending, true);
  await assert.rejects(
    verifyHubAccessAudit({ hubRoot }),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "HUB_ACCESS_AUDIT_ARCHIVE_RECOVERY_REQUIRED");
      return true;
    },
  );

  const writer = await openHubAccessAudit({ hubRoot });
  assert.equal(writer.status().recordCount, 0);
  await writer.close();
  assert.equal((await inspectHubAccessAuditUsage({ hubRoot })).archivePending, false);
  assert.equal((await verifyHubAccessAudit({ hubRoot })).recordCount, 0);
});

test("recovery rolls back an unpublished stage and preserves the source log", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-audit-staged-hub-"));
  const output = path.join(await mkdtemp(path.join(os.tmpdir(), "cpb-audit-staged-out-")), "archive");
  const before = await appendRecords(hubRoot, 2);

  await assert.rejects(
    createHubAccessAuditArchive({
      hubRoot,
      output,
      faultInjector(phase) {
        if (phase === "staged") throw new Error("simulated crash before publish");
      },
    }),
    /simulated crash/,
  );
  assert.equal(await exists(output), false);
  const recovered = await recoverHubAccessAuditArchive({ hubRoot });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.outcome, "rolled_back");
  const after = await verifyHubAccessAudit({ hubRoot, maxBytes: 1024 * 1024 });
  assert.equal(after.lastHash, before.lastHash);
  assert.equal(after.recordCount, 2);
});

test("recovery closes every pre-copy stage ownership crash window", async () => {
  for (const phase of ["prepared", "stage_owned", "stage_created"] as const) {
    const hubRoot = await mkdtemp(path.join(os.tmpdir(), `cpb-audit-${phase}-hub-`));
    const outputParent = await mkdtemp(path.join(os.tmpdir(), `cpb-audit-${phase}-out-`));
    const output = path.join(outputParent, "archive");
    const before = await appendRecords(hubRoot, 1);
    await assert.rejects(
      createHubAccessAuditArchive({
        hubRoot,
        output,
        faultInjector(current) {
          if (current === phase) throw new Error(`simulated ${phase} crash`);
        },
      }),
      new RegExp(`simulated ${phase} crash`),
    );
    const pendingJournal = JSON.parse(
      await readFile(path.join(hubRoot, "audit", "http-access.archive.json"), "utf8"),
    ) as { stage: string };
    const recovered = await recoverHubAccessAuditArchive({ hubRoot });
    assert.equal(recovered.outcome, "rolled_back");
    const after = await verifyHubAccessAudit({ hubRoot, maxBytes: 1024 * 1024 });
    assert.equal(after.lastHash, before.lastHash);
    const leftovers = (await readdir(outputParent))
      .filter((name) => name.includes("cpb-audit-stage"));
    assert.equal(await exists(pendingJournal.stage), false);
    assert.equal(await exists(`${pendingJournal.stage}.owner.json`), false);
    for (const leftover of leftovers) {
      assert.match(leftover, /\.removed-/);
      const info = await lstat(path.join(outputParent, leftover));
      assert.equal(info.isSymbolicLink(), false);
      if (process.platform !== "win32") assert.equal(info.mode & 0o077, 0);
    }
  }
});

test("archive recovery fails closed when the source diverges after publication", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-audit-conflict-hub-"));
  const output = path.join(await mkdtemp(path.join(os.tmpdir(), "cpb-audit-conflict-out-")), "archive");
  await appendRecords(hubRoot, 1);
  await assert.rejects(
    createHubAccessAuditArchive({
      hubRoot,
      output,
      faultInjector(phase) {
        if (phase === "published") throw new Error("simulated crash after publish");
      },
    }),
    /simulated crash/,
  );
  await writeFile(path.join(hubRoot, "audit", "http-access.jsonl"), "diverged\n", { flag: "a" });
  await assert.rejects(
    recoverHubAccessAuditArchive({ hubRoot }),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "HUB_ACCESS_AUDIT_ARCHIVE_RECOVERY_CONFLICT");
      return true;
    },
  );
});

test("Hub CLI creates and verifies a signed access-audit archive", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-audit-cli-root-"));
  const hubRoot = path.join(root, "hub");
  const output = path.join(root, "archive");
  await appendRecords(hubRoot, 2);
  const previousHubRoot = process.env.CPB_HUB_ROOT;
  const previousSigningKey = process.env.CPB_HUB_ACCESS_AUDIT_ARCHIVE_SIGNING_KEY;
  const originalLog = console.log;
  const lines: string[] = [];
  process.env.CPB_HUB_ROOT = hubRoot;
  process.env.CPB_HUB_ACCESS_AUDIT_ARCHIVE_SIGNING_KEY = SIGNING_KEY;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    assert.equal(await runHubCommand([
      "archive-access-audit", "--output", output, "--json",
    ], { cpbRoot: root, executorRoot: root }), 0);
    const created = JSON.parse(lines.join("\n"));
    assert.equal(created.manifest.recordCount, 2);
    lines.length = 0;
    assert.equal(await runHubCommand([
      "verify-access-audit-archive", "--input", output, "--require-signature", "--json",
    ], { cpbRoot: root, executorRoot: root }), 0);
    const verified = JSON.parse(lines.join("\n"));
    assert.equal(verified.log.recordCount, 2);
    assert.equal(verified.signatureVerified, true);
  } finally {
    console.log = originalLog;
    if (previousHubRoot === undefined) delete process.env.CPB_HUB_ROOT;
    else process.env.CPB_HUB_ROOT = previousHubRoot;
    if (previousSigningKey === undefined) delete process.env.CPB_HUB_ACCESS_AUDIT_ARCHIVE_SIGNING_KEY;
    else process.env.CPB_HUB_ACCESS_AUDIT_ARCHIVE_SIGNING_KEY = previousSigningKey;
  }
});
