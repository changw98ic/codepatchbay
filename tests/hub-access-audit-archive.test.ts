import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inspectHubAccessAuditUsage,
  openHubAccessAudit,
  verifyHubAccessAudit,
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

test("recovery completes an archive published before a simulated crash", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-audit-published-hub-"));
  const output = path.join(await mkdtemp(path.join(os.tmpdir(), "cpb-audit-published-out-")), "archive");
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
    /simulated crash/,
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
    const recovered = await recoverHubAccessAuditArchive({ hubRoot });
    assert.equal(recovered.outcome, "rolled_back");
    const after = await verifyHubAccessAudit({ hubRoot, maxBytes: 1024 * 1024 });
    assert.equal(after.lastHash, before.lastHash);
    const leftovers = (await readdir(outputParent))
      .filter((name) => name.includes("cpb-audit-stage"));
    assert.deepEqual(leftovers, []);
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
