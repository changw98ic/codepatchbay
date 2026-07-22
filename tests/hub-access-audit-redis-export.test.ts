import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import type { HubRedisStateBackend } from "../shared/hub-state-redis.js";
import {
  exportRedisHubAccessAudit,
  verifyRedisHubAccessAuditExport,
  withRedisAuditExportTestHooks,
} from "../server/services/audit/hub-access-audit-redis-export.js";
import { tempRoot } from "./helpers.js";

const GENESIS_HASH = "0".repeat(64);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite test value");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function auditRecord(sequence: number, previousHash: string) {
  const payload = {
    format: "cpb-hub-access-audit/v1",
    sequence,
    timestamp: new Date().toISOString(),
    requestId: randomUUID(),
    method: "GET",
    path: `/api/redis-export/${sequence}`,
    pathTruncated: false,
    statusCode: 200,
    outcome: "allowed",
    principalId: "redis-export-test",
    principalSource: "service-token-file",
    remoteAddress: "127.0.0.1",
    requiredScope: "hub:read",
    errorCode: null,
    durationMs: sequence,
    previousHash,
  };
  return {
    ...payload,
    hash: createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex"),
  };
}

function redisAuditBackend(recordCount = 2): HubRedisStateBackend {
  const records: string[] = [];
  let previousHash = GENESIS_HASH;
  for (let sequence = 1; sequence <= recordCount; sequence += 1) {
    const record = auditRecord(sequence, previousHash);
    previousHash = record.hash;
    records.push(JSON.stringify(record));
  }
  const sizeBytes = records.reduce((total, record) => total + Buffer.byteLength(record, "utf8") + 1, 0);
  return {
    identityFingerprint: "redis-export-test-backend",
    readAccessAuditHead: async () => ({
      sequence: records.length,
      hash: previousHash,
      sizeBytes,
      maxBytes: null,
    }),
    readAccessAuditRecords: async () => records,
  } as HubRedisStateBackend;
}

function codedError(error: unknown, code: string): (Error & Record<string, unknown>) | null {
  const seen = new Set<unknown>();
  const visit = (candidate: unknown): ReturnType<typeof codedError> => {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return null;
    seen.add(candidate);
    const record = candidate as Error & {
      code?: unknown;
      cause?: unknown;
      primaryError?: unknown;
      cleanupErrors?: unknown[];
      errors?: unknown[];
    };
    if (record.code === code) return record as Error & Record<string, unknown>;
    for (const nested of [
      ...(record instanceof AggregateError ? record.errors : []),
      ...(Array.isArray(record.errors) ? record.errors : []),
      ...(Array.isArray(record.cleanupErrors) ? record.cleanupErrors : []),
      record.primaryError,
      record.cause,
    ]) {
      const found = visit(nested);
      if (found) return found;
    }
    return null;
  };
  return visit(error);
}

test("Redis audit export does not overwrite a same-path successor after output reservation", async () => {
  const root = await tempRoot("cpb-redis-audit-export-successor");
  const hubRoot = path.join(root, "hub");
  const output = path.join(root, "export");
  await mkdir(hubRoot, { recursive: true });

  await assert.rejects(
    withRedisAuditExportTestHooks({
      async afterOutputReserved({ output: reservedOutput }) {
        await writeFile(path.join(reservedOutput, "successor.txt"), "preserve me\n", "utf8");
      },
    }, () => exportRedisHubAccessAudit({
      backend: redisAuditBackend(),
      hubRoot,
      output,
    })),
    (error: unknown) => {
      const aggregate = error as AggregateError & {
        recoveryPaths?: { stage?: string; reservation?: string };
      };
      assert.ok(codedError(error, "HUB_ACCESS_AUDIT_EXPORT_CHANGED"));
      assert.ok(codedError(error, "HUB_ACCESS_AUDIT_EXPORT_SUCCESSOR_PRESERVED"));
      assert.equal(aggregate.recoveryPaths?.reservation, undefined);
      assert.ok(aggregate.recoveryPaths?.stage);
      return true;
    },
  );

  assert.equal(await readFile(path.join(output, "successor.txt"), "utf8"), "preserve me\n");
});

test("Redis audit export reports committed ambiguity after publish parent fsync failure", async () => {
  const root = await tempRoot("cpb-redis-audit-export-committed");
  const hubRoot = path.join(root, "hub");
  const output = path.join(root, "export");
  await mkdir(hubRoot, { recursive: true });
  const canonicalOutput = path.join(await realpath(path.dirname(output)), path.basename(output));

  await assert.rejects(
    withRedisAuditExportTestHooks({
      syncDirectory(_directory, operation) {
        if (operation === "publish-output") {
          throw Object.assign(new Error("injected fsync failure"), { code: "EIO" });
        }
      },
    }, () => exportRedisHubAccessAudit({
      backend: redisAuditBackend(),
      hubRoot,
      output,
    })),
    (error: unknown) => {
      const actual = error as Error & {
        code?: unknown;
        committed?: unknown;
        committedPath?: unknown;
        recoveryPaths?: { output?: unknown; parent?: unknown };
      };
      assert.equal(actual.code, "HUB_ACCESS_AUDIT_EXPORT_COMMITTED_AMBIGUOUS");
      assert.equal(actual.committed, true);
      assert.equal(actual.committedPath, canonicalOutput);
      assert.equal(actual.recoveryPaths?.output, canonicalOutput);
      return true;
    },
  );
  assert.ok(JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8")));
});

test("Redis audit export cleanup preserves a replaced stage generation", async () => {
  const root = await tempRoot("cpb-redis-audit-export-stage-successor");
  const hubRoot = path.join(root, "hub");
  const output = path.join(root, "export");
  let successorStage = "";
  await mkdir(hubRoot, { recursive: true });

  await assert.rejects(
    withRedisAuditExportTestHooks({
      async beforeStageRename({ stage }) {
        await rename(stage, `${stage}.saved`);
        await mkdir(stage, { mode: 0o700 });
        await writeFile(path.join(stage, "successor.txt"), "stage successor\n", "utf8");
        successorStage = stage;
      },
    }, () => exportRedisHubAccessAudit({
      backend: redisAuditBackend(),
      hubRoot,
      output,
    })),
    (error: unknown) => {
      const actual = error as AggregateError & { cleanupErrors?: Array<{ code?: unknown }> };
      assert.ok(error instanceof AggregateError);
      assert.equal(actual.cleanupErrors?.some((entry) => entry.code === "HUB_ACCESS_AUDIT_EXPORT_STAGE_SUCCESSOR_PRESERVED"), true);
      return true;
    },
  );

  assert.equal(await readFile(path.join(successorStage, "successor.txt"), "utf8"), "stage successor\n");
  assert.equal((await readdir(root)).some((entry) => entry.includes(".export.stage-")), true);
});

test("Redis audit export failure preserves only revalidated recovery directories", async () => {
  const root = await tempRoot("cpb-redis-audit-export-preserved-recovery");
  const hubRoot = path.join(root, "hub");
  const output = path.join(root, "export");
  await mkdir(hubRoot, { recursive: true });
  let failure: (Error & {
    cleanupCommitted?: boolean;
    quarantinePreserved?: boolean;
    recoveryPaths?: { stage?: string; reservation?: string };
  }) | null = null;

  await assert.rejects(
    withRedisAuditExportTestHooks({
      beforeStageRename() {
        throw Object.assign(new Error("stop before publication"), { code: "EIO" });
      },
    }, () => exportRedisHubAccessAudit({ backend: redisAuditBackend(), hubRoot, output })),
    (error: unknown) => {
      failure = error as typeof failure;
      return true;
    },
  );
  assert.ok(failure);
  assert.equal(failure.cleanupCommitted, true);
  assert.equal(failure.quarantinePreserved, true);
  assert.ok(failure.recoveryPaths?.stage);
  assert.ok(failure.recoveryPaths?.reservation);
  assert.ok(JSON.parse(await readFile(path.join(failure.recoveryPaths.stage, "manifest.json"), "utf8")));
  assert.deepEqual(await readdir(failure.recoveryPaths.reservation), []);
  await assert.rejects(lstat(output), { code: "ENOENT" });
});

test("Redis audit export never advertises a replaced recovery path", async () => {
  const root = await tempRoot("cpb-redis-audit-export-recovery-successor");
  const hubRoot = path.join(root, "hub");
  const output = path.join(root, "export");
  let replacedRecovery = "";
  let originalEvidence = "";
  await mkdir(hubRoot, { recursive: true });

  await assert.rejects(
    withRedisAuditExportTestHooks({
      beforeStageRename() {
        throw Object.assign(new Error("stop before publication"), { code: "EIO" });
      },
      async beforeCleanupIsolation({ kind }) {
        if (kind !== "reservation") return;
        const recoveryName = (await readdir(root)).find((entry) => entry.includes(".stage-preserved."));
        assert.ok(recoveryName);
        replacedRecovery = path.join(root, recoveryName);
        originalEvidence = `${replacedRecovery}.original-evidence`;
        await rename(replacedRecovery, originalEvidence);
        await mkdir(replacedRecovery, { mode: 0o700 });
        await writeFile(path.join(replacedRecovery, "successor.txt"), "recovery successor\n", "utf8");
      },
    }, () => exportRedisHubAccessAudit({ backend: redisAuditBackend(), hubRoot, output })),
    (error: unknown) => {
      const actual = error as AggregateError & {
        recoveryPaths?: { stage?: string; reservation?: string };
      };
      assert.ok(codedError(error, "HUB_ACCESS_AUDIT_EXPORT_RECOVERY_CHANGED"));
      assert.equal(actual.recoveryPaths?.stage, undefined);
      assert.ok(actual.recoveryPaths?.reservation);
      return true;
    },
  );
  assert.equal(await readFile(path.join(replacedRecovery, "successor.txt"), "utf8"), "recovery successor\n");
  assert.ok(JSON.parse(await readFile(path.join(originalEvidence, "manifest.json"), "utf8")));
});

test("Redis audit export refuses stage-file mutation before publication", async () => {
  const root = await tempRoot("cpb-redis-audit-export-stage-file-change");
  const hubRoot = path.join(root, "hub");
  const output = path.join(root, "export");
  await mkdir(hubRoot, { recursive: true });

  await assert.rejects(
    withRedisAuditExportTestHooks({
      async beforeStageRename({ stage }) {
        await writeFile(path.join(stage, "http-access.jsonl"), "tampered\n", "utf8");
      },
    }, () => exportRedisHubAccessAudit({ backend: redisAuditBackend(), hubRoot, output })),
    (error: unknown) => {
      assert.ok(codedError(error, "HUB_ACCESS_AUDIT_EXPORT_CHANGED"));
      return true;
    },
  );
  await assert.rejects(lstat(output), { code: "ENOENT" });
});

test("Redis audit export preserves a post-publication canonical successor", async () => {
  const root = await tempRoot("cpb-redis-audit-export-post-publish-successor");
  const hubRoot = path.join(root, "hub");
  const output = path.join(root, "export");
  const publishedEvidence = path.join(root, "published-evidence");
  await mkdir(hubRoot, { recursive: true });

  await assert.rejects(
    withRedisAuditExportTestHooks({
      async afterStageRename() {
        await rename(output, publishedEvidence);
        await mkdir(output, { mode: 0o700 });
        await writeFile(path.join(output, "successor.txt"), "preserve successor\n", "utf8");
      },
    }, () => exportRedisHubAccessAudit({ backend: redisAuditBackend(), hubRoot, output })),
    (error: unknown) => {
      const conflict = codedError(error, "HUB_ACCESS_AUDIT_EXPORT_PUBLISH_CHANGED") as (Error & {
        committed?: boolean;
        successorPreserved?: boolean;
        recoveryPaths?: { output?: string; publishedEvidence?: string };
      }) | null;
      assert.ok(conflict);
      assert.equal(conflict.committed, true);
      assert.equal(conflict.successorPreserved, true);
      assert.equal(conflict.recoveryPaths?.output, undefined);
      return true;
    },
  );
  assert.equal(await readFile(path.join(output, "successor.txt"), "utf8"), "preserve successor\n");
  assert.ok(JSON.parse(await readFile(path.join(publishedEvidence, "manifest.json"), "utf8")));
});

test("Redis audit export publishes only through the verified canonical parent", async () => {
  if (process.platform === "win32") return;
  const root = await tempRoot("cpb-redis-audit-export-parent-alias");
  const hubRoot = path.join(root, "hub");
  const trustedRoot = path.join(root, "trusted");
  const attackerRoot = path.join(root, "attacker");
  const trustedParent = path.join(trustedRoot, "exports");
  const attackerParent = path.join(attackerRoot, "exports");
  const alias = path.join(root, "output-alias");
  const retiredAlias = path.join(root, "output-alias.retired");
  await Promise.all([
    mkdir(hubRoot, { recursive: true }),
    mkdir(trustedParent, { recursive: true }),
    mkdir(attackerParent, { recursive: true }),
  ]);
  await symlink(trustedRoot, alias, "dir");
  const requestedOutput = path.join(alias, "exports", "export");

  const result = await withRedisAuditExportTestHooks({
    async afterPublicationAuthorityCheck() {
      await rename(alias, retiredAlias);
      await symlink(attackerRoot, alias, "dir");
    },
  }, () => exportRedisHubAccessAudit({ backend: redisAuditBackend(), hubRoot, output: requestedOutput }));

  assert.equal(result.output, path.join(await realpath(trustedParent), "export"));
  assert.ok(JSON.parse(await readFile(path.join(trustedParent, "export", "manifest.json"), "utf8")));
  await assert.rejects(lstat(path.join(attackerParent, "export")), { code: "ENOENT" });
});

test("Redis audit export rejects a lexical outside path that resolves inside the Hub root", async () => {
  if (process.platform === "win32") return;
  const root = await tempRoot("cpb-redis-audit-export-canonical-hub-boundary");
  const hubRoot = path.join(root, "hub");
  const insideParent = path.join(hubRoot, "inside");
  const alias = path.join(root, "outside-alias");
  await mkdir(insideParent, { recursive: true });
  await symlink(insideParent, alias, "dir");

  await assert.rejects(
    exportRedisHubAccessAudit({
      backend: redisAuditBackend(),
      hubRoot,
      output: path.join(alias, "export"),
    }),
    { code: "HUB_ACCESS_AUDIT_EXPORT_INVALID" },
  );
  await assert.rejects(lstat(path.join(insideParent, "export")), { code: "ENOENT" });
});

test("Redis audit export rejects a missing parent that would be created inside the Hub root", async () => {
  if (process.platform === "win32") return;
  const root = await tempRoot("cpb-redis-audit-export-missing-canonical-hub-parent");
  const hubRoot = path.join(root, "hub");
  const alias = path.join(root, "outside-alias");
  await mkdir(hubRoot, { recursive: true });
  await symlink(hubRoot, alias, "dir");

  await assert.rejects(
    exportRedisHubAccessAudit({
      backend: redisAuditBackend(),
      hubRoot,
      output: path.join(alias, "new-parent", "export"),
    }),
    { code: "HUB_ACCESS_AUDIT_EXPORT_INVALID" },
  );
  await assert.rejects(lstat(path.join(hubRoot, "new-parent")), { code: "ENOENT" });
});

test("Redis audit export creates a missing parent only on its verified canonical path", async () => {
  const root = await tempRoot("cpb-redis-audit-export-missing-safe-parent");
  const hubRoot = path.join(root, "hub");
  const output = path.join(root, "safe", "nested", "export");
  await mkdir(hubRoot, { recursive: true });

  const result = await exportRedisHubAccessAudit({ backend: redisAuditBackend(), hubRoot, output });

  assert.equal(result.output, path.join(await realpath(path.join(root, "safe", "nested")), "export"));
  assert.ok(JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8")));
});

test("Redis audit export rejects a canonical parent successor before stage creation", async () => {
  const root = await tempRoot("cpb-redis-audit-export-parent-successor");
  const hubRoot = path.join(root, "hub");
  const parent = path.join(root, "exports");
  const retiredParent = path.join(root, "exports.original");
  const output = path.join(parent, "export");
  await Promise.all([
    mkdir(hubRoot, { recursive: true }),
    mkdir(parent, { recursive: true }),
  ]);

  await assert.rejects(
    withRedisAuditExportTestHooks({
      async afterCanonicalParentAuthorityCaptured({ parent: canonicalParent }) {
        await rename(canonicalParent, retiredParent);
        await mkdir(canonicalParent, { mode: 0o700 });
        await writeFile(path.join(canonicalParent, "successor.txt"), "parent successor\n", "utf8");
      },
    }, () => exportRedisHubAccessAudit({ backend: redisAuditBackend(), hubRoot, output })),
    (error: unknown) => {
      const actual = error as Error & {
        code?: string;
        recoveryPaths?: { stage?: string; reservation?: string; output?: string };
      };
      assert.equal(actual.code, "HUB_ACCESS_AUDIT_EXPORT_CHANGED");
      assert.equal(actual.recoveryPaths, undefined);
      return true;
    },
  );
  assert.deepEqual(await readdir(parent), ["successor.txt"]);
  assert.deepEqual(await readdir(retiredParent), []);
});

test("Redis audit export rejects a canonical parent successor after output reservation", async () => {
  const root = await tempRoot("cpb-redis-audit-export-reserved-parent-successor");
  const hubRoot = path.join(root, "hub");
  const parent = path.join(root, "exports");
  const retiredParent = path.join(root, "exports.original");
  const output = path.join(parent, "export");
  let successorStage = "";
  await Promise.all([
    mkdir(hubRoot, { recursive: true }),
    mkdir(parent, { recursive: true }),
  ]);

  await assert.rejects(
    withRedisAuditExportTestHooks({
      async afterOutputReserved({ stage }) {
        successorStage = stage;
        await rename(parent, retiredParent);
        await mkdir(parent, { mode: 0o700 });
        await mkdir(successorStage, { mode: 0o700 });
        await writeFile(path.join(successorStage, "successor.txt"), "stage successor\n", "utf8");
      },
    }, () => exportRedisHubAccessAudit({ backend: redisAuditBackend(), hubRoot, output })),
    (error: unknown) => {
      const actual = error as Error & {
        code?: string;
        recoveryPaths?: { stage?: string; reservation?: string; output?: string };
      };
      assert.equal(actual.code, "HUB_ACCESS_AUDIT_EXPORT_CHANGED");
      assert.equal(actual.recoveryPaths, undefined);
      return true;
    },
  );

  assert.equal(await readFile(path.join(successorStage, "successor.txt"), "utf8"), "stage successor\n");
  assert.deepEqual(await readdir(successorStage), ["successor.txt"]);
  await assert.rejects(lstat(path.join(parent, "export")), { code: "ENOENT" });
  const retiredEntries = await readdir(retiredParent);
  assert.equal(retiredEntries.includes("export"), true);
  assert.equal(retiredEntries.some((entry) => entry.startsWith(".export.stage-")), true);
});

test("Redis audit export cleanup never removes a stage successor installed after validation", async () => {
  const root = await tempRoot("cpb-redis-audit-export-cleanup-successor");
  const hubRoot = path.join(root, "hub");
  const output = path.join(root, "export");
  let stagePath = "";
  let originalEvidence = "";
  await mkdir(hubRoot, { recursive: true });

  await assert.rejects(
    withRedisAuditExportTestHooks({
      async beforeStageRename({ stage }) {
        stagePath = stage;
        throw Object.assign(new Error("stop before publish"), { code: "EIO" });
      },
      async beforeCleanupIsolation({ canonicalPath, kind }) {
        if (kind !== "stage") return;
        originalEvidence = `${canonicalPath}.original-evidence`;
        await rename(canonicalPath, originalEvidence);
        await mkdir(canonicalPath, { mode: 0o700 });
        await writeFile(path.join(canonicalPath, "successor.txt"), "stage successor\n", "utf8");
      },
    }, () => exportRedisHubAccessAudit({ backend: redisAuditBackend(), hubRoot, output })),
    (error: unknown) => {
      const conflict = codedError(error, "HUB_ACCESS_AUDIT_EXPORT_STAGE_SUCCESSOR_PRESERVED") as (Error & {
        successorPreserved?: boolean;
        recoveryPaths?: { stage?: string };
      }) | null;
      assert.ok(conflict);
      assert.equal(conflict.successorPreserved, true);
      assert.equal(conflict.recoveryPaths?.stage, undefined);
      return true;
    },
  );
  assert.equal(await readFile(path.join(stagePath, "successor.txt"), "utf8"), "stage successor\n");
  assert.ok(JSON.parse(await readFile(path.join(originalEvidence, "manifest.json"), "utf8")));
});

test("Redis audit export hooks are isolated across concurrent exports", async () => {
  const failingRoot = await tempRoot("cpb-redis-audit-export-hook-scope-failing");
  const healthyRoot = await tempRoot("cpb-redis-audit-export-hook-scope-healthy");
  const failingHubRoot = path.join(failingRoot, "hub");
  const healthyHubRoot = path.join(healthyRoot, "hub");
  const failingOutput = path.join(failingRoot, "export");
  const healthyOutput = path.join(healthyRoot, "export");
  await Promise.all([
    mkdir(failingHubRoot, { recursive: true }),
    mkdir(healthyHubRoot, { recursive: true }),
  ]);
  let releaseHook!: () => void;
  const hookGate = new Promise<void>((resolve) => { releaseHook = resolve; });
  let hookEntered!: () => void;
  const entered = new Promise<void>((resolve) => { hookEntered = resolve; });
  const injected = Object.assign(new Error("scoped export failure"), { code: "EIO" });

  const failing = withRedisAuditExportTestHooks({
    async beforeStageRename() {
      hookEntered();
      await hookGate;
      throw injected;
    },
  }, () => exportRedisHubAccessAudit({ backend: redisAuditBackend(), hubRoot: failingHubRoot, output: failingOutput }));
  await entered;
  const healthy = exportRedisHubAccessAudit({ backend: redisAuditBackend(), hubRoot: healthyHubRoot, output: healthyOutput });
  releaseHook();
  const [failingResult, healthyResult] = await Promise.allSettled([failing, healthy]);

  assert.equal(failingResult.status, "rejected");
  assert.equal(
    healthyResult.status,
    "fulfilled",
    healthyResult.status === "rejected" ? String(healthyResult.reason?.stack || healthyResult.reason) : undefined,
  );
  assert.ok(JSON.parse(await readFile(path.join(healthyOutput, "manifest.json"), "utf8")));
});

test("Redis audit export verification rejects manifest symlink replacement before read", async () => {
  if (process.platform === "win32") return;
  const root = await tempRoot("cpb-redis-audit-export-manifest-symlink");
  const hubRoot = path.join(root, "hub");
  const output = path.join(root, "export");
  const outside = path.join(root, "outside-manifest.json");
  await mkdir(hubRoot, { recursive: true });
  await exportRedisHubAccessAudit({ backend: redisAuditBackend(), hubRoot, output });
  await writeFile(outside, "{}\n", { mode: 0o600 });
  await chmod(outside, 0o600);

  await assert.rejects(
    withRedisAuditExportTestHooks({
      async afterManifestPreflight({ manifestPath }) {
        await rename(manifestPath, `${manifestPath}.saved`);
        await symlink(outside, manifestPath);
      },
    }, () => verifyRedisHubAccessAuditExport({ input: output })),
    { code: "HUB_ACCESS_AUDIT_EXPORT_CHANGED" },
  );
  assert.equal(await readFile(outside, "utf8"), "{}\n");
});

test("Redis audit export verification rejects log path replacement before delegated verification", async () => {
  const root = await tempRoot("cpb-redis-audit-export-log-replacement");
  const hubRoot = path.join(root, "hub");
  const output = path.join(root, "export");
  await mkdir(hubRoot, { recursive: true });
  await exportRedisHubAccessAudit({ backend: redisAuditBackend(), hubRoot, output });

  await assert.rejects(
    withRedisAuditExportTestHooks({
      async beforeVerifyAuditFile({ logPath }) {
        await rename(logPath, `${logPath}.saved`);
        await writeFile(logPath, "\n", { mode: 0o600 });
        await chmod(logPath, 0o600);
      },
    }, () => verifyRedisHubAccessAuditExport({ input: output })),
    { code: "HUB_ACCESS_AUDIT_EXPORT_CHANGED" },
  );
});
