import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, appendFile, chmod, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  inspectHubAccessAuditUsage,
  openHubAccessAudit,
  verifyHubAccessAudit,
  type HubAccessAuditRecord,
} from "../server/services/audit/hub-access-audit.js";
import { run as runHubCommand } from "../cli/commands/hub.js";
import { writeJsonDurableAtomic } from "../shared/hub-maintenance.js";
import { tempRoot } from "./helpers.js";

function input(index: number, requestPath = `/api/projects/${index}`) {
  return {
    requestId: randomUUID(),
    method: "GET",
    path: requestPath,
    statusCode: 200,
    outcome: "allowed" as const,
    principalId: "test-reader",
    principalSource: "service-token-file",
    remoteAddress: "127.0.0.1",
    requiredScope: "hub:read",
    errorCode: null,
    durationMs: index,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function nextRecord(previous: HubAccessAuditRecord, overrides: Partial<HubAccessAuditRecord> = {}): HubAccessAuditRecord {
  const payload = {
    format: "cpb-hub-access-audit/v1" as const,
    sequence: previous.sequence + 1,
    timestamp: new Date().toISOString(),
    requestId: randomUUID(),
    method: "GET",
    path: "/api/health",
    pathTruncated: false,
    statusCode: 200,
    outcome: "allowed" as const,
    principalId: "recovered-reader",
    principalSource: "service-token-file",
    remoteAddress: "127.0.0.1",
    requiredScope: "hub:health",
    errorCode: null,
    durationMs: 1,
    previousHash: previous.hash,
    ...overrides,
  };
  return {
    ...payload,
    hash: createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex"),
  };
}

test("Hub access audit serializes concurrent appends into a verifiable chain", async () => {
  const root = await tempRoot("cpb-hub-access-audit-chain");
  const hubRoot = path.join(root, "hub");
  const audit = await openHubAccessAudit({ hubRoot });
  const records = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    audit.append(input(index, index === 0 ? "/api/projects?secret=must-not-persist" : `/api/projects/${index}`))));
  await audit.close();

  const verified = await verifyHubAccessAudit({ hubRoot });
  const raw = await readFile(verified.filePath, "utf8");
  const persisted = raw.trim().split("\n").map((line) => JSON.parse(line));

  assert.equal(verified.recordCount, 20);
  assert.equal(verified.lastSequence, 20);
  assert.deepEqual(records.map((record) => record.sequence), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.deepEqual(persisted.map((record) => record.sequence), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.equal(persisted[0].path, "/api/projects");
  assert.doesNotMatch(raw, /must-not-persist/);
});

test("Hub access audit verification rejects record tampering", async () => {
  const root = await tempRoot("cpb-hub-access-audit-tamper");
  const hubRoot = path.join(root, "hub");
  const audit = await openHubAccessAudit({ hubRoot });
  await audit.append(input(1));
  await audit.close();
  const filePath = path.join(hubRoot, "audit", "http-access.jsonl");
  const record = JSON.parse((await readFile(filePath, "utf8")).trim());
  record.statusCode = 500;
  await writeFile(filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);

  await assert.rejects(verifyHubAccessAudit({ hubRoot }), /hash mismatch/);
  await assert.rejects(openHubAccessAudit({ hubRoot }), /hash mismatch/);
});

test("active Hub access-audit writer detects same-size external modification before the next append", async () => {
  const root = await tempRoot("cpb-hub-access-audit-live-tamper");
  const hubRoot = path.join(root, "hub");
  const audit = await openHubAccessAudit({ hubRoot });
  await audit.append(input(1));
  const filePath = path.join(hubRoot, "audit", "http-access.jsonl");
  const raw = await readFile(filePath, "utf8");
  const tampered = raw.replace("test-reader", "evil-reader");
  assert.equal(Buffer.byteLength(tampered), Buffer.byteLength(raw));
  await writeFile(filePath, tampered, { mode: 0o600 });
  await utimes(filePath, new Date(0), new Date(0));

  await assert.rejects(audit.append(input(2)), /changed outside the active writer/);
  await audit.close();
});

test("Hub access audit recovers a pending record after a partial append", async () => {
  const root = await tempRoot("cpb-hub-access-audit-recover");
  const hubRoot = path.join(root, "hub");
  const audit = await openHubAccessAudit({ hubRoot });
  const first = await audit.append(input(1));
  await audit.close();
  const directory = path.join(hubRoot, "audit");
  const filePath = path.join(directory, "http-access.jsonl");
  const pendingPath = path.join(directory, "http-access.pending.json");
  const second = nextRecord(first);
  await writeJsonDurableAtomic(pendingPath, {
    format: "cpb-hub-access-audit-pending/v1",
    record: second,
  });
  const partial = JSON.stringify(second).slice(0, 53);
  await appendFile(filePath, partial, "utf8");

  await assert.rejects(verifyHubAccessAudit({ hubRoot }), /pending recovery is required/);
  const recovered = await openHubAccessAudit({ hubRoot });
  assert.equal(recovered.status().lastSequence, 2);
  await recovered.close();

  const verified = await verifyHubAccessAudit({ hubRoot });
  assert.equal(verified.recordCount, 2);
  await assert.rejects(access(pendingPath));
  assert.equal((await readFile(filePath, "utf8")).trim().split("\n").length, 2);
});

test("Hub access audit rejects an unexplained truncated tail", async () => {
  const root = await tempRoot("cpb-hub-access-audit-truncated");
  const hubRoot = path.join(root, "hub");
  const audit = await openHubAccessAudit({ hubRoot });
  await audit.append(input(1));
  await audit.close();
  await appendFile(path.join(hubRoot, "audit", "http-access.jsonl"), "{\"partial\"", "utf8");

  await assert.rejects(verifyHubAccessAudit({ hubRoot }), /truncated final record/);
  await assert.rejects(openHubAccessAudit({ hubRoot }), /truncated final record/);
});

test("Hub access audit fails closed at its configured capacity without corrupting the chain", async () => {
  const root = await tempRoot("cpb-hub-access-audit-capacity");
  const hubRoot = path.join(root, "hub");
  const audit = await openHubAccessAudit({ hubRoot, maxBytes: 64 * 1024 });
  let failure: NodeJS.ErrnoException | null = null;
  for (let index = 0; index < 100; index += 1) {
    try {
      await audit.append(input(index, `/${"x".repeat(4000)}`));
    } catch (error) {
      failure = error as NodeJS.ErrnoException;
      break;
    }
  }
  await audit.close();

  assert.equal(failure?.code, "HUB_ACCESS_AUDIT_FULL");
  const verified = await verifyHubAccessAudit({ hubRoot, maxBytes: 64 * 1024 });
  const usage = await inspectHubAccessAuditUsage({ hubRoot, maxBytes: 64 * 1024 });
  assert.ok(verified.recordCount > 0);
  assert.ok(verified.sizeBytes <= 64 * 1024);
  assert.equal(usage.pending, false);
  assert.equal(usage.sizeBytes, verified.sizeBytes);
  assert.ok(usage.usagePercent > 75);
});

test("Hub access audit refuses a symlink audit directory", async () => {
  if (process.platform === "win32") return;
  const root = await tempRoot("cpb-hub-access-audit-symlink");
  const hubRoot = path.join(root, "hub");
  const outside = path.join(root, "outside-audit");
  await mkdir(hubRoot, { recursive: true });
  await mkdir(outside, { recursive: true });
  const { symlink } = await import("node:fs/promises");
  await symlink(outside, path.join(hubRoot, "audit"), "dir");

  await assert.rejects(openHubAccessAudit({ hubRoot }), /must be a real directory/);
});

test("hub verify-access-audit command emits a bounded verification summary", async () => {
  const root = await tempRoot("cpb-hub-access-audit-cli");
  const hubRoot = path.join(root, "hub");
  const audit = await openHubAccessAudit({ hubRoot });
  const record = await audit.append(input(1));
  await audit.close();
  const previousHubRoot = process.env.CPB_HUB_ROOT;
  const lines: string[] = [];
  const originalLog = console.log;
  process.env.CPB_HUB_ROOT = hubRoot;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    assert.equal(await runHubCommand(["verify-access-audit", "--json"], { cpbRoot: root, executorRoot: root }), 0);
  } finally {
    console.log = originalLog;
    if (previousHubRoot === undefined) delete process.env.CPB_HUB_ROOT;
    else process.env.CPB_HUB_ROOT = previousHubRoot;
  }
  const result = JSON.parse(lines.join("\n"));
  assert.equal(result.recordCount, 1);
  assert.equal(result.lastHash, record.hash);
  assert.equal(result.fileIdentity, undefined);
  assert.equal(result.fileFingerprint, undefined);
});
