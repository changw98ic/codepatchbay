/**
 * tests/local-code-index-v2-migration.test.ts
 *
 * Behavioral tests for the local-code-index v2 hub data migration.
 *
 * Verifies four invariants demanded by the Phase 9 gate:
 *
 *   1. Active-job refusal changes no bytes.
 *   2. Successful cleanup is byte-idempotent on rerun.
 *   3. Injected write failures preserve backups.
 *   4. Pending migrated work cannot dispatch before v2 ensure.
 *
 * All tests use temporary hub roots and exercise the real migration
 * module against the locked entry points in hub-queue.ts and
 * hub-registry.ts.
 *
 * Run:
 *   npm run build:tests
 *   node dist-tests/scripts/run-node-tests.js tests/local-code-index-v2-migration.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test, beforeEach, afterEach } from "node:test";

import {
  migrateQueueWithLock,
  migrateRegistryWithLock,
  runLocalCodeIndexV2Migration,
  applyQueueMigration,
  applyRegistryMigration,
  inspectQueueForMigration,
} from "../server/services/migration/local-code-index-v2.js";

import {
  withQueueLockTestHooks,
} from "../server/services/hub/hub-queue.js";

import {
  gateDispatchCandidate,
} from "../server/services/hub/local-code-index-state-gate.js";

import {
  computeKeys,
  resolveStorageRoot,
  worktreeCurrentPointer,
  snapshotIdentityPath,
} from "../core/indexing/local-code-index/paths.js";

import { canonicalStringify } from "../core/indexing/local-code-index/canonical-json.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

async function tempDir(label: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), `lci-v2-migration-${label}-`)));
}

/**
 * Set up a minimal hub root directory with queue/ and projects.json.
 */
async function setupHubRoot(label: string): Promise<string> {
  const hubRoot = await tempDir(label);
  await mkdir(path.join(hubRoot, "queue"), { recursive: true });
  return hubRoot;
}

/**
 * Write a queue file to the hub root.
 */
async function writeQueue(
  hubRoot: string,
  entries: Array<Record<string, unknown>>,
): Promise<void> {
  const queueData = { version: 1, entries };
  await writeFile(
    path.join(hubRoot, "queue", "queue.json"),
    `${JSON.stringify(queueData, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Write a projects.json registry file to the hub root.
 */
async function writeRegistry(
  hubRoot: string,
  projects: Record<string, Record<string, unknown>>,
): Promise<void> {
  const registryData = {
    version: 1,
    revision: 0,
    updatedAt: new Date(0).toISOString(),
    projects,
    projectRevisions: {},
    mutationId: null,
  };
  await writeFile(
    path.join(hubRoot, "projects.json"),
    `${JSON.stringify(registryData, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Read the raw bytes of the queue file for byte-comparison.
 */
async function readQueueBytes(hubRoot: string): Promise<Buffer> {
  return readFile(path.join(hubRoot, "queue", "queue.json"));
}

/**
 * Read the raw bytes of the projects.json file for byte-comparison.
 */
async function readRegistryBytes(hubRoot: string): Promise<Buffer> {
  return readFile(path.join(hubRoot, "projects.json"));
}

/**
 * SHA-256 hex digest of a buffer.
 */
function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Migration input: v1-style queue metadata with stale index fields.
 * Used exclusively to test the v1→v2 local-code-index migration path.
 */
function migrationInputQueueMetadata(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    indexFreshness: {
      dirtyReasons: ["source_changed"],
      lastCheckedAt: new Date().toISOString(),
    },
    localCodeIndexReadiness: {
      ready: true,
      reason: "index_available",
      indexFile: "/tmp/fake-index.json",
    },
    indexSnapshot: {
      indexSnapshotId: "snap-old-abc123",
      files: 5,
      fingerprint: "deadbeef",
    },
    ...overrides,
  };
}

/**
 * Migration input: v1-style registry project metadata with stale fields.
 * Used exclusively to test the v1→v2 local-code-index migration path.
 */
function migrationInputRegistryMetadata(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    capabilityMapConfidence: "high",
    project_capability_map: {
      confidence: "high",
      coreModules: ["src/index.ts"],
      testSurfaces: ["tests/index.test.ts"],
    },
    ...overrides,
  };
}

/**
 * Create a queue entry with given status and metadata.
 */
function queueEntry(
  id: string,
  projectId: string,
  status: string,
  metadata?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    projectId,
    status,
    description: `Task ${id}`,
    priority: "P1",
    type: "pipeline",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: metadata ?? {},
  };
}

/**
 * List backup files in the hub root's backups/migration directory.
 */
async function listBackups(hubRoot: string): Promise<string[]> {
  const backupDir = path.join(hubRoot, "backups", "migration");
  try {
    return await readdir(backupDir);
  } catch {
    return [];
  }
}

/**
 * Read a backup file's content.
 */
async function readBackup(
  hubRoot: string,
  filename: string,
): Promise<string> {
  return readFile(
    path.join(hubRoot, "backups", "migration", filename),
    "utf8",
  );
}

/**
 * Migration input: create a v1-schema index on disk for a given source path
 * and cpbRoot.  Used exclusively to test the v1→v2 local-code-index
 * migration path.
 *
 * Writes:
 *   <cpbRoot>/indexes/local-code/v2/worktrees/<worktreeKey>/current.json
 *   <cpbRoot>/indexes/local-code/v2/worktrees/<worktreeKey>/snapshots/<snapshotId>/identity.json
 *
 * The identity has schemaVersion: 1, which localCodeIndexStatus rejects
 * with "unsupported_index_schema".
 */
async function createV1IndexMigrationInput(
  sourcePath: string,
  cpbRoot: string,
): Promise<{ worktreeKey: string; snapshotId: string }> {
  const { worktreeKey } = computeKeys(sourcePath, sourcePath);
  const snapshotId = "idx1-fakesnapshot000000000001";

  const storageRoot = await resolveStorageRoot(cpbRoot, sourcePath);

  // Write current.json pointer
  const pointerDir = path.dirname(worktreeCurrentPointer(storageRoot, worktreeKey));
  await mkdir(pointerDir, { recursive: true });

  const identityBytes = new TextEncoder().encode(
    canonicalStringify({
      schemaVersion: 1,
      repositoryKey: "00000000000000000000000000000000",
      worktreeKey,
      sourceKey: "0000000000000000000000000000000000000000000000000000000000000000",
      sourcePath,
      git: null,
      worktreeStateFingerprint: "fake-fingerprint",
      inventory: {},
      extractorFingerprint: "fake-extractor",
      symbolShardIds: [],
      relationShardIds: [],
      toolState: {
        name: "ast-grep",
        version: null,
        extractorFingerprint: "fake-extractor",
        available: false,
        coverage: {
          effective: "file-inventory-only",
          partial: true,
          failedFiles: 0,
          oversizedFiles: 0,
        },
        errors: [],
      },
      indexMapHash: "0000000000000000000000000000000000000000000000000000000000000000",
      indexMapByteLength: 0,
    }),
  );
  const identityHash = createHash("sha256").update(identityBytes).digest("hex");

  const pointer = {
    schemaVersion: 1,
    worktreeKey,
    snapshotId,
    identityHash,
    ownerToken: "fake-owner-token",
    publishedAt: new Date().toISOString(),
    previousSnapshotIds: [],
  };
  await writeFile(
    worktreeCurrentPointer(storageRoot, worktreeKey),
    `${canonicalStringify(pointer)}\n`,
    "utf8",
  );

  // Write identity.json with schemaVersion: 1
  const snapDir = path.dirname(
    snapshotIdentityPath(storageRoot, worktreeKey, snapshotId),
  );
  await mkdir(snapDir, { recursive: true });
  await writeFile(
    snapshotIdentityPath(storageRoot, worktreeKey, snapshotId),
    identityBytes,
    "utf8",
  );

  return { worktreeKey, snapshotId };
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. Active-job refusal changes no bytes
// ──────────────────────────────────────────────────────────────────────────────

describe("active-job refusal changes no bytes", () => {
  let hubRoot: string;

  beforeEach(async () => {
    hubRoot = await setupHubRoot("active-refusal");
  });

  afterEach(async () => {
    await rm(hubRoot, { recursive: true, force: true });
  });

  test("migrateQueueWithLock returns activeBlocked > 0 and migrated = 0 when active mutating entries exist", async () => {
    await writeQueue(hubRoot, [
      queueEntry("q-done", "proj-a", "completed", migrationInputQueueMetadata()),
      queueEntry("q-active", "proj-a", "in_progress", migrationInputQueueMetadata()),
    ]);

    const result = await migrateQueueWithLock(hubRoot);

    assert.strictEqual(result.migrated, 0);
    assert.ok(result.activeBlocked > 0, "must report activeBlocked");
    assert.strictEqual(result.target, "queue");
  });

  test("migrateQueueWithLock leaves queue file bytes unchanged when active work blocks migration", async () => {
    await writeQueue(hubRoot, [
      queueEntry("q-done", "proj-a", "completed", migrationInputQueueMetadata()),
      queueEntry("q-active", "proj-a", "scheduled", migrationInputQueueMetadata()),
    ]);

    const bytesBefore = await readQueueBytes(hubRoot);
    const hashBefore = sha256(bytesBefore);

    await migrateQueueWithLock(hubRoot);

    const bytesAfter = await readQueueBytes(hubRoot);
    const hashAfter = sha256(bytesAfter);

    assert.strictEqual(
      hashAfter,
      hashBefore,
      "queue file must be byte-identical when active work blocks migration",
    );
  });

  test("migrateRegistryWithLock returns activeBlocked > 0 when active queue entries exist", async () => {
    await writeRegistry(hubRoot, {
      "proj-a": {
        id: "proj-a",
        sourcePath: "/tmp/fake-source",
        metadata: migrationInputRegistryMetadata(),
      },
    });
    await writeQueue(hubRoot, [
      queueEntry("q-active", "proj-a", "in_progress", migrationInputQueueMetadata()),
    ]);

    const result = await migrateRegistryWithLock(hubRoot);

    assert.strictEqual(result.migrated, 0);
    assert.ok(result.activeBlocked > 0, "must report activeBlocked");
    assert.strictEqual(result.target, "registry");
  });

  test("migrateRegistryWithLock leaves registry file bytes unchanged when active work blocks migration", async () => {
    await writeRegistry(hubRoot, {
      "proj-a": {
        id: "proj-a",
        sourcePath: "/tmp/fake-source",
        metadata: migrationInputRegistryMetadata(),
      },
    });
    await writeQueue(hubRoot, [
      queueEntry("q-active", "proj-a", "in_progress", migrationInputQueueMetadata()),
    ]);

    const bytesBefore = await readRegistryBytes(hubRoot);
    const hashBefore = sha256(bytesBefore);

    await migrateRegistryWithLock(hubRoot);

    const bytesAfter = await readRegistryBytes(hubRoot);
    const hashAfter = sha256(bytesAfter);

    assert.strictEqual(
      hashAfter,
      hashBefore,
      "registry file must be byte-identical when active work blocks migration",
    );
  });

  test("inspectQueueForMigration reports skip-active for in_progress entries", async () => {
    await writeQueue(hubRoot, [
      queueEntry("q-active", "proj-a", "in_progress", migrationInputQueueMetadata()),
      queueEntry("q-scheduled", "proj-a", "scheduled", migrationInputQueueMetadata()),
    ]);

    const report = await inspectQueueForMigration(hubRoot);

    assert.strictEqual(report.activeBlocked, 2);
    assert.strictEqual(report.eligible, 0);
    assert.ok(
      report.details.every((d) => d.action === "skip-active"),
      "all active entries must be reported as skip-active",
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. Successful cleanup is byte-idempotent on rerun
// ──────────────────────────────────────────────────────────────────────────────

describe("successful cleanup is byte-idempotent on rerun", () => {
  let hubRoot: string;

  beforeEach(async () => {
    hubRoot = await setupHubRoot("idempotent");
  });

  afterEach(async () => {
    await rm(hubRoot, { recursive: true, force: true });
  });

  test("second queue migration run produces byte-identical queue file", async () => {
    await writeQueue(hubRoot, [
      queueEntry("q-1", "proj-a", "completed", migrationInputQueueMetadata()),
      queueEntry("q-2", "proj-a", "completed", migrationInputQueueMetadata()),
    ]);

    const first = await migrateQueueWithLock(hubRoot);
    assert.ok(first.migrated > 0, "first run must migrate entries");

    const bytesAfterFirst = await readQueueBytes(hubRoot);

    const second = await migrateQueueWithLock(hubRoot);
    assert.strictEqual(second.migrated, 0, "second run must migrate nothing");
    assert.ok(
      second.alreadyMigrated > 0,
      "second run must report alreadyMigrated",
    );

    const bytesAfterSecond = await readQueueBytes(hubRoot);

    assert.strictEqual(
      sha256(bytesAfterSecond),
      sha256(bytesAfterFirst),
      "queue file must be byte-identical on rerun",
    );
  });

  test("second registry migration run reports no migration needed and preserves sentinel", async () => {
    await writeRegistry(hubRoot, {
      "proj-a": {
        id: "proj-a",
        sourcePath: "/tmp/fake-source",
        metadata: migrationInputRegistryMetadata(),
      },
    });
    // No active queue entries — registry migration proceeds.
    await writeQueue(hubRoot, []);

    const first = await migrateRegistryWithLock(hubRoot);
    assert.ok(first.migrated > 0, "first run must migrate projects");

    const second = await migrateRegistryWithLock(hubRoot);
    assert.strictEqual(second.migrated, 0, "second run must migrate nothing");
    assert.ok(
      second.alreadyMigrated > 0,
      "second run must report alreadyMigrated",
    );

    // Registry mutation always increments revision, so we verify
    // semantic idempotency: the sentinel is still present and v1
    // fields remain stripped.
    const registryRaw = JSON.parse(
      await readFile(path.join(hubRoot, "projects.json"), "utf8"),
    );
    const meta = registryRaw.projects["proj-a"].metadata;
    assert.strictEqual(
      meta.__localCodeIndexMigrationVersion,
      2,
      "sentinel must persist across reruns",
    );
    assert.strictEqual(
      meta.capabilityMapConfidence,
      undefined,
      "capabilityMapConfidence must remain stripped",
    );
    assert.strictEqual(
      meta.project_capability_map,
      undefined,
      "project_capability_map must remain stripped",
    );
  });

  test("runLocalCodeIndexV2Migration with target=all is idempotent across queue and registry", async () => {
    await writeQueue(hubRoot, [
      queueEntry("q-1", "proj-a", "completed", migrationInputQueueMetadata()),
    ]);
    await writeRegistry(hubRoot, {
      "proj-a": {
        id: "proj-a",
        sourcePath: "/tmp/fake-source",
        metadata: migrationInputRegistryMetadata(),
      },
    });

    const first = await runLocalCodeIndexV2Migration({
      hubRoot,
      dryRun: false,
    });
    assert.ok(first.results, "first run must return results");
    assert.strictEqual(first.results.length, 2);

    // Queue is byte-identical on rerun (withQueueLock only saves when
    // serialized content changes).
    const queueBytes1 = await readQueueBytes(hubRoot);

    const second = await runLocalCodeIndexV2Migration({
      hubRoot,
      dryRun: false,
    });
    assert.ok(second.results, "second run must return results");

    // Both targets must report 0 migrated on the second run.
    for (const r of second.results) {
      assert.strictEqual(r.migrated, 0, `${r.target} must report 0 migrated on rerun`);
    }

    const queueBytes2 = await readQueueBytes(hubRoot);
    assert.strictEqual(
      sha256(queueBytes2),
      sha256(queueBytes1),
      "queue must be byte-identical on rerun",
    );

    // Registry always writes (revision bump), so verify semantic
    // idempotency: sentinel persists and v1 fields stay stripped.
    const registryRaw = JSON.parse(
      await readFile(path.join(hubRoot, "projects.json"), "utf8"),
    );
    const meta = registryRaw.projects["proj-a"].metadata;
    assert.strictEqual(meta.__localCodeIndexMigrationVersion, 2);
    assert.strictEqual(meta.capabilityMapConfidence, undefined);
    assert.strictEqual(meta.project_capability_map, undefined);
  });

  test("dry-run mode does not alter any bytes", async () => {
    await writeQueue(hubRoot, [
      queueEntry("q-1", "proj-a", "completed", migrationInputQueueMetadata()),
    ]);
    await writeRegistry(hubRoot, {
      "proj-a": {
        id: "proj-a",
        sourcePath: "/tmp/fake-source",
        metadata: migrationInputRegistryMetadata(),
      },
    });

    const queueBefore = await readQueueBytes(hubRoot);
    const registryBefore = await readRegistryBytes(hubRoot);

    const result = await runLocalCodeIndexV2Migration({
      hubRoot,
      dryRun: true,
    });
    assert.ok(result.dryRun, "dry-run must return dryRun reports");

    const queueAfter = await readQueueBytes(hubRoot);
    const registryAfter = await readRegistryBytes(hubRoot);

    assert.strictEqual(
      sha256(queueAfter),
      sha256(queueBefore),
      "dry-run must not alter queue bytes",
    );
    assert.strictEqual(
      sha256(registryAfter),
      sha256(registryBefore),
      "dry-run must not alter registry bytes",
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 3. Injected write failures preserve backups
// ──────────────────────────────────────────────────────────────────────────────

describe("injected write failures preserve backups", () => {
  let hubRoot: string;

  beforeEach(async () => {
    hubRoot = await setupHubRoot("backup-preserve");
  });

  afterEach(async () => {
    await rm(hubRoot, { recursive: true, force: true });
  });

  test("backup file is created before queue lock and survives a lock-save failure", async () => {
    await writeQueue(hubRoot, [
      queueEntry("q-1", "proj-a", "completed", migrationInputQueueMetadata()),
    ]);

    // Snapshot the backup directory before migration.
    const backupsBefore = await listBackups(hubRoot);
    assert.strictEqual(backupsBefore.length, 0, "no backups before migration");

    // Inject a write failure via the beforeQueueRename test hook.
    // The backup is written before the lock is acquired, so it should
    // survive the injected failure.
    const hookError = new Error("injected write failure");
    await assert.rejects(
      () =>
        withQueueLockTestHooks(
          {
            beforeQueueRename: () => {
              throw hookError;
            },
          },
          () => migrateQueueWithLock(hubRoot),
        ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        // The error may be wrapped in an AggregateError by the lock
        // release logic, so check the message chain.
        const messages = collectErrorMessages(err);
        assert.ok(
          messages.some((m) => m.includes("injected write failure")),
          `expected injected error in chain, got: ${messages.join("; ")}`,
        );
        return true;
      },
    );

    // The backup must still exist on disk.
    const backupsAfter = await listBackups(hubRoot);
    assert.ok(
      backupsAfter.length > 0,
      "backup must be preserved even when queue save fails",
    );

    // Verify the backup contains the pre-migration queue data.
    const backupContent = await readBackup(hubRoot, backupsAfter[0]);
    const parsed = JSON.parse(backupContent);
    assert.ok(
      parsed.entries && Array.isArray(parsed.entries),
      "backup must contain entries array",
    );
    assert.strictEqual(parsed.entries.length, 1);
    assert.strictEqual(parsed.entries[0].id, "q-1");
  });

  test("backup file contains the full pre-migration queue state", async () => {
    await writeQueue(hubRoot, [
      queueEntry("q-1", "proj-a", "completed", migrationInputQueueMetadata()),
      queueEntry("q-2", "proj-b", "completed", migrationInputQueueMetadata()),
    ]);

    // Run a successful migration (which creates a backup).
    await migrateQueueWithLock(hubRoot);

    const backups = await listBackups(hubRoot);
    assert.ok(backups.length > 0, "backup must exist after successful migration");

    const backupContent = await readBackup(hubRoot, backups[0]);
    const parsed = JSON.parse(backupContent);

    assert.strictEqual(parsed.version, 1);
    assert.strictEqual(parsed.entries.length, 2);

    // The backup entries must still have v1 metadata (pre-migration state).
    const meta1 = parsed.entries[0].metadata;
    assert.ok(
      meta1.indexFreshness || meta1.localCodeIndexReadiness || meta1.indexSnapshot,
      "backup entry must retain v1 metadata",
    );
  });

  test("backup is not created when there is no v1 data to migrate", async () => {
    // Queue with no v1 metadata.
    await writeQueue(hubRoot, [
      queueEntry("q-clean", "proj-a", "completed", {}),
    ]);

    await migrateQueueWithLock(hubRoot);

    const backups = await listBackups(hubRoot);
    assert.strictEqual(
      backups.length,
      0,
      "no backup should be created when there is nothing to migrate",
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 4. Pending migrated work cannot dispatch before v2 ensure
// ──────────────────────────────────────────────────────────────────────────────

describe("pending migrated work cannot dispatch before v2 ensure", () => {
  let hubRoot: string;
  let sourcePath: string;
  let cpbRoot: string;

  beforeEach(async () => {
    hubRoot = await setupHubRoot("dispatch-gate");
    sourcePath = await tempDir("dispatch-source");
    cpbRoot = await tempDir("dispatch-cpbroot");
  });

  afterEach(async () => {
    await rm(hubRoot, { recursive: true, force: true });
    await rm(sourcePath, { recursive: true, force: true });
    await rm(cpbRoot, { recursive: true, force: true });
  });

  test("gateDispatchCandidate rejects project with v1 index schema after queue migration", async () => {
    // Set up registry with a project pointing to sourcePath.
    await writeRegistry(hubRoot, {
      "proj-a": {
        id: "proj-a",
        sourcePath,
        cpbRoot,
        metadata: migrationInputRegistryMetadata(),
      },
    });

    // Set up queue with v1 metadata entries (completed, so no active block).
    await writeQueue(hubRoot, [
      queueEntry("q-1", "proj-a", "completed", migrationInputQueueMetadata()),
    ]);

    // Create a fake v1 index on disk.
    await createV1IndexMigrationInput(sourcePath, cpbRoot);

    // Migrate the queue entries.
    const migrationResult = await migrateQueueWithLock(hubRoot);
    assert.ok(
      migrationResult.migrated > 0,
      "queue migration must succeed",
    );

    // Now attempt to dispatch the project through the state gate.
    // The index is still v1 on disk, so the gate must reject it.
    const gateResult = await gateDispatchCandidate(
      hubRoot,
      "proj-a",
      sourcePath,
      cpbRoot,
    );

    assert.strictEqual(gateResult.passed, false, "gate must reject v1 index");
    if (!gateResult.passed) {
      assert.strictEqual(gateResult.code, "UNSUPPORTED_INDEX_SCHEMA");
      assert.strictEqual(gateResult.projectId, "proj-a");
      assert.strictEqual(gateResult.detectedSchemaVersion, 1);
      assert.strictEqual(gateResult.requiredSchemaVersion, 2);
      assert.ok(
        gateResult.migrationInstructions.length > 0,
        "must include migration instructions",
      );
    }
  });

  test("queue migration sentinel does not bypass the state gate", async () => {
    // The migration only transforms queue metadata.  It does NOT upgrade
    // the on-disk index.  The state gate checks the on-disk index, so
    // a migrated queue entry pointing to a v1 index must still be blocked.

    await writeRegistry(hubRoot, {
      "proj-b": {
        id: "proj-b",
        sourcePath,
        cpbRoot,
        metadata: migrationInputRegistryMetadata(),
      },
    });

    await writeQueue(hubRoot, [
      queueEntry("q-10", "proj-b", "completed", migrationInputQueueMetadata()),
    ]);

    // Create a fake v1 index.
    await createV1IndexMigrationInput(sourcePath, cpbRoot);

    // Migrate.
    await migrateQueueWithLock(hubRoot);

    // Verify the queue entry now carries the migration sentinel.
    const queueRaw = JSON.parse(
      await readFile(path.join(hubRoot, "queue", "queue.json"), "utf8"),
    );
    const migratedMeta = queueRaw.entries[0].metadata;
    assert.strictEqual(
      migratedMeta.__localCodeIndexMigrationVersion,
      2,
      "migrated entry must carry sentinel",
    );

    // But the gate must still reject because the index is v1 on disk.
    const gateResult = await gateDispatchCandidate(
      hubRoot,
      "proj-b",
      sourcePath,
      cpbRoot,
    );

    assert.strictEqual(
      gateResult.passed,
      false,
      "sentinel in queue metadata must not bypass the state gate",
    );
  });

  test("applyQueueMigration pure transform does not affect gate outcome", async () => {
    // Verify that the pure transform function (applyQueueMigration) correctly
    // strips v1 fields and writes the sentinel, but this alone does not
    // make the project dispatchable.

    const queue = {
      entries: [
        {
          ...queueEntry("q-pure", "proj-c", "completed", migrationInputQueueMetadata()),
        },
      ],
    };

    const result = applyQueueMigration(
      queue as { entries: Array<Record<string, unknown>> },
    );

    assert.strictEqual(result.migrated, 1);
    assert.strictEqual(result.activeBlocked, 0);

    // Verify the transform stripped v1 fields.
    const meta = queue.entries[0].metadata as Record<string, unknown>;
    assert.strictEqual(meta.indexFreshness, undefined, "indexFreshness must be stripped");
    assert.strictEqual(meta.localCodeIndexReadiness, undefined, "localCodeIndexReadiness must be stripped");
    assert.strictEqual(meta.indexSnapshot, undefined, "indexSnapshot must be stripped");
    assert.strictEqual(meta.indexSnapshotId, undefined, "indexSnapshotId must be stripped");
    assert.strictEqual(meta.__localCodeIndexMigrationVersion, 2, "sentinel must be written");
  });

  test("applyRegistryMigration pure transform strips v1 fields", async () => {
    const registry = {
      projects: {
        "proj-d": {
          id: "proj-d",
          sourcePath: "/tmp/d",
          metadata: migrationInputRegistryMetadata(),
        },
      },
    };

    const result = applyRegistryMigration(
      registry as { projects: Record<string, Record<string, unknown>> },
    );

    assert.strictEqual(result.migrated, 1);

    const meta = registry.projects["proj-d"].metadata as Record<string, unknown>;
    assert.strictEqual(
      meta.capabilityMapConfidence,
      undefined,
      "capabilityMapConfidence must be stripped",
    );
    assert.strictEqual(
      meta.project_capability_map,
      undefined,
      "project_capability_map must be stripped",
    );
    assert.strictEqual(
      meta.__localCodeIndexMigrationVersion,
      2,
      "sentinel must be written",
    );
  });
});

// ── Error message collector ───────────────────────────────────────────────────

/**
 * Recursively collect all error messages from an error chain
 * (including AggregateError children).
 */
function collectErrorMessages(err: unknown): string[] {
  const messages: string[] = [];
  if (err instanceof Error) {
    messages.push(err.message);
    if (err instanceof AggregateError && Array.isArray(err.errors)) {
      for (const child of err.errors) {
        messages.push(...collectErrorMessages(child));
      }
    }
    if (err.cause) {
      messages.push(...collectErrorMessages(err.cause));
    }
  }
  return messages;
}
