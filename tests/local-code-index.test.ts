/**
 * Service-level behavior tests for the Local Code Index v2.
 *
 * Verifies four behavioral categories demanded by the Phase 6 gate:
 *
 *   1. ensureLocalCodeIndex produces a correct ref with schemaVersion: 2.
 *   2. localCodeIndexStatus reports available/fresh states accurately.
 *   3. Incremental rebuild detects source changes and publishes new
 *      content-addressed snapshots.
 *   4. Publication is atomic — current.json only appears after a
 *      complete successful build and points to a fully verified snapshot.
 *
 * All tests use temporary directories and exercise the real service
 * implementation against the non-Git directory observer path.
 *
 * Run:
 *   npm run build:tests
 *   node dist-tests/scripts/run-node-tests.js tests/local-code-index.test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, describe, beforeEach, afterEach } from "node:test";

import {
  ensureLocalCodeIndex,
  localCodeIndexStatus,
} from "../core/indexing/local-code-index/service.js";

import type {
  EnsureLocalCodeIndexResult,
  LocalCodeIndexRef,
} from "../core/indexing/local-code-index/contracts.js";

import {
  readSnapshotIdentity,
} from "../core/indexing/local-code-index/snapshot-store.js";

import {
  computeKeys,
  resolveStorageRoot,
  fileObjectPath,
  worktreeCurrentPointer,
  snapshotDir,
  snapshotIdentityPath,
} from "../core/indexing/local-code-index/paths.js";

import { readBoundedFileNoFollow } from "../core/indexing/local-code-index/safe-files.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

async function tempDir(label: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `lci-${label}-`));
}

/** Create a minimal source tree with TypeScript files. */
async function createSourceTree(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
}

/** Write a single file inside an existing source tree. */
async function writeSourceFile(
  root: string,
  rel: string,
  content: string,
): Promise<void> {
  const abs = path.join(root, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}

/** Remove a single file from the source tree. */
async function removeSourceFile(root: string, rel: string): Promise<void> {
  await rm(path.join(root, rel));
}

/** Read the current.json pointer as parsed JSON. */
async function readCurrentPointer(
  storageRoot: string,
  worktreeKey: string,
): Promise<Record<string, unknown> | null> {
  const pointerPath = worktreeCurrentPointer(storageRoot, worktreeKey);
  let raw: Uint8Array;
  try {
    raw = await readBoundedFileNoFollow(pointerPath, 4096);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const SAMPLE_FILES: Readonly<Record<string, string>> = {
  "src/index.ts": [
    'import { greet } from "./greeter.js";',
    "",
    "export function main(): void {",
    '  console.log(greet("world"));',
    "}",
  ].join("\n"),
  "src/greeter.ts": [
    "export function greet(name: string): string {",
    '  return `Hello, ${name}!`;',
    "}",
  ].join("\n"),
  "src/utils.ts": [
    "export function add(a: number, b: number): number {",
    "  return a + b;",
    "}",
  ].join("\n"),
};

// ──────────────────────────────────────────────────────────────────────────────
// 1. ensureLocalCodeIndex produces correct ref with schemaVersion: 2
// ──────────────────────────────────────────────────────────────────────────────

describe("ensureLocalCodeIndex ref contract", () => {
  let sourceRoot: string;
  let storageRoot: string;

  beforeEach(async () => {
    sourceRoot = await tempDir("ensure-source");
    storageRoot = await tempDir("ensure-storage");
    await createSourceTree(sourceRoot, SAMPLE_FILES);
  });

  afterEach(async () => {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  });

  test("result.ref.schemaVersion is exactly 2", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    assert.strictEqual(result.available, true);
    assert.strictEqual(result.ref.schemaVersion, 2);
  });

  test("result.ref contains all six required fields with correct formats", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    const ref = result.ref;
    assert.strictEqual(typeof ref.sourcePath, "string");
    assert.ok(ref.sourcePath.length > 0, "sourcePath must be non-empty");
    assert.strictEqual(typeof ref.repositoryKey, "string");
    assert.strictEqual(ref.repositoryKey.length, 32, "repositoryKey must be 32 hex chars");
    assert.match(ref.repositoryKey, /^[0-9a-f]{32}$/, "repositoryKey must be lowercase hex");
    assert.strictEqual(typeof ref.worktreeKey, "string");
    assert.strictEqual(ref.worktreeKey.length, 32, "worktreeKey must be 32 hex chars");
    assert.match(ref.worktreeKey, /^[0-9a-f]{32}$/, "worktreeKey must be lowercase hex");
    assert.strictEqual(typeof ref.sourceKey, "string");
    assert.strictEqual(ref.sourceKey.length, 64, "sourceKey must be 64 hex chars");
    assert.match(ref.sourceKey, /^[0-9a-f]{64}$/, "sourceKey must be lowercase hex");
    assert.strictEqual(typeof ref.snapshotId, "string");
    assert.ok(ref.snapshotId.startsWith("idx2-"), "snapshotId must start with idx2-");
  });

  test("ref keys are derived deterministically from source path", async () => {
    const result1 = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    const result2 = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    assert.strictEqual(result1.ref.repositoryKey, result2.ref.repositoryKey);
    assert.strictEqual(result1.ref.worktreeKey, result2.ref.worktreeKey);
    assert.strictEqual(result1.ref.sourceKey, result2.ref.sourceKey);
  });

  test("different source paths produce different worktree keys", async () => {
    const otherSource = await tempDir("ensure-other");
    await createSourceTree(otherSource, SAMPLE_FILES);

    try {
      const otherStorage = await tempDir("ensure-other-storage");
      try {
        const r1 = await ensureLocalCodeIndex({
          sourcePath: sourceRoot,
          cpbRoot: storageRoot,
        });
        const r2 = await ensureLocalCodeIndex({
          sourcePath: otherSource,
          cpbRoot: otherStorage,
        });

        assert.notStrictEqual(
          r1.ref.worktreeKey,
          r2.ref.worktreeKey,
          "different source paths must produce different worktree keys",
        );
      } finally {
        await rm(otherStorage, { recursive: true, force: true });
      }
    } finally {
      await rm(otherSource, { recursive: true, force: true });
    }
  });

  test("result includes tool state with coverage summary", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    assert.strictEqual(result.tool.name, "ast-grep");
    assert.strictEqual(typeof result.tool.extractorFingerprint, "string");
    assert.strictEqual(typeof result.tool.available, "boolean");
    assert.ok(
      typeof result.tool.coverage === "object" && result.tool.coverage !== null,
    );
    assert.strictEqual(typeof result.tool.coverage.effective, "string");
    assert.strictEqual(typeof result.tool.coverage.partial, "boolean");
    assert.strictEqual(typeof result.tool.coverage.failedFiles, "number");
    assert.strictEqual(typeof result.tool.coverage.oversizedFiles, "number");
  });

  test("result includes build stats with all required fields", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    const s = result.stats;
    assert.ok(
      ["reused", "incremental", "full"].includes(s.mode),
      `unexpected mode: ${s.mode}`,
    );
    assert.strictEqual(typeof s.discoveredFiles, "number");
    assert.strictEqual(typeof s.reusedFiles, "number");
    assert.strictEqual(typeof s.hashedFiles, "number");
    assert.strictEqual(typeof s.parsedFiles, "number");
    assert.strictEqual(typeof s.deletedFiles, "number");
    assert.strictEqual(typeof s.oversizedFiles, "number");
    assert.strictEqual(typeof s.rebuiltSymbolShards, "number");
    assert.strictEqual(typeof s.rebuiltRelationShards, "number");
    assert.strictEqual(typeof s.bytesRead, "number");
    assert.strictEqual(typeof s.bytesWritten, "number");
    assert.strictEqual(typeof s.durationMs, "number");
    assert.ok(s.durationMs >= 0);
    assert.ok(
      typeof s.timings === "object" && s.timings !== null,
    );
    assert.strictEqual(typeof s.timings.inventoryMs, "number");
    assert.strictEqual(typeof s.timings.hashingMs, "number");
    assert.strictEqual(typeof s.timings.parsingMs, "number");
    assert.strictEqual(typeof s.timings.lookupMs, "number");
    assert.strictEqual(typeof s.timings.publicationMs, "number");
  });

  test("discoveredFiles count matches source tree file count", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    assert.strictEqual(result.stats.discoveredFiles, 3);
  });

  test("snapshot identity is persisted with schemaVersion 2", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    const resolvedStorage = await resolveStorageRoot(storageRoot, sourceRoot);
    const identity = await readSnapshotIdentity(
      resolvedStorage,
      result.ref.worktreeKey,
      result.ref.snapshotId,
    );

    assert.notStrictEqual(identity, null, "identity must be persisted");
    assert.strictEqual(identity!.schemaVersion, 2);
    assert.strictEqual(typeof identity!.worktreeStateFingerprint, "string");
    assert.ok(identity!.worktreeStateFingerprint.length > 0);
  });

  test("force: true produces a valid result", async () => {
    await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
      force: true,
    });

    assert.strictEqual(result.available, true);
    assert.strictEqual(result.ref.schemaVersion, 2);
    assert.ok(result.stats.durationMs >= 0);
  });

  test("force: true rebuilds without reading a missing object from the previous snapshot", async () => {
    const initial = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });
    const resolvedStorage = await resolveStorageRoot(storageRoot, sourceRoot);
    const identity = await readSnapshotIdentity(
      resolvedStorage,
      initial.ref.worktreeKey,
      initial.ref.snapshotId,
    );
    assert.ok(identity);
    const firstEntry = Object.values(identity.inventory)[0];
    assert.ok(firstEntry);
    await rm(
      fileObjectPath(
        resolvedStorage,
        initial.ref.repositoryKey,
        firstEntry.fileObjectId,
      ),
      { force: true },
    );

    const rebuilt = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
      force: true,
    });

    assert.equal(rebuilt.available, true);
    assert.equal(rebuilt.stats.mode, "full");
    assert.equal(rebuilt.ref.snapshotId, initial.ref.snapshotId);
    await stat(
      fileObjectPath(
        resolvedStorage,
        initial.ref.repositoryKey,
        firstEntry.fileObjectId,
      ),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. localCodeIndexStatus reports available/fresh states
// ──────────────────────────────────────────────────────────────────────────────

describe("localCodeIndexStatus", () => {
  let sourceRoot: string;
  let storageRoot: string;

  beforeEach(async () => {
    sourceRoot = await tempDir("status-source");
    storageRoot = await tempDir("status-storage");
    await createSourceTree(sourceRoot, SAMPLE_FILES);
  });

  afterEach(async () => {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  });

  test("status reports available:false with reason missing_local_code_index when no index exists", async () => {
    const status = await localCodeIndexStatus({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    assert.strictEqual(status.available, false);
    if (!status.available) {
      assert.strictEqual(status.reason, "missing_local_code_index");
      assert.strictEqual(status.fresh, false);
      assert.strictEqual(status.exact, false);
    }
  });

  test("status is read-only — calling status alone does not create an index", async () => {
    await localCodeIndexStatus({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    // A second call should also report missing.
    const status2 = await localCodeIndexStatus({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });
    assert.strictEqual(status2.available, false);
  });

  test("status reports available:true after ensure", async () => {
    await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    const status = await localCodeIndexStatus({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    assert.strictEqual(status.available, true);
    if (status.available) {
      assert.strictEqual(status.exact, true);
      assert.strictEqual(status.ref.schemaVersion, 2);
      assert.strictEqual(typeof status.files, "number");
      assert.strictEqual(typeof status.indexedBytes, "number");
    }
  });

  test("status ref matches the ref from ensure", async () => {
    const ensureResult = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    const status = await localCodeIndexStatus({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    assert.strictEqual(status.available, true);
    if (status.available) {
      assert.strictEqual(status.ref.snapshotId, ensureResult.ref.snapshotId);
      assert.strictEqual(status.ref.repositoryKey, ensureResult.ref.repositoryKey);
      assert.strictEqual(status.ref.worktreeKey, ensureResult.ref.worktreeKey);
      assert.strictEqual(status.ref.sourceKey, ensureResult.ref.sourceKey);
      assert.strictEqual(status.ref.sourcePath, ensureResult.ref.sourcePath);
    }
  });

  test("status tool state reflects persisted snapshot", async () => {
    await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    const status = await localCodeIndexStatus({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    assert.strictEqual(status.available, true);
    if (status.available) {
      assert.strictEqual(status.tool.name, "ast-grep");
      assert.strictEqual(typeof status.tool.available, "boolean");
      assert.strictEqual(typeof status.tool.extractorFingerprint, "string");
      assert.strictEqual(typeof status.tool.coverage, "object");
    }
  });

  test("status for nonexistent source path returns unsafe_source_path", async () => {
    const status = await localCodeIndexStatus({
      sourcePath: "/nonexistent/path/that/does/not/exist/at/all",
      cpbRoot: storageRoot,
    });

    assert.strictEqual(status.available, false);
    if (!status.available) {
      assert.strictEqual(status.reason, "unsafe_source_path");
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 3. Incremental rebuild detects source changes and publishes new snapshots
// ──────────────────────────────────────────────────────────────────────────────

describe("incremental rebuild detects source changes", () => {
  let sourceRoot: string;
  let storageRoot: string;

  beforeEach(async () => {
    sourceRoot = await tempDir("incr-source");
    storageRoot = await tempDir("incr-storage");
    await createSourceTree(sourceRoot, SAMPLE_FILES);
  });

  afterEach(async () => {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  });

  test("unchanged source produces the same snapshot ID", async () => {
    const first = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    const second = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    assert.strictEqual(
      first.ref.snapshotId,
      second.ref.snapshotId,
      "identical source must produce identical snapshot ID (content-addressed)",
    );
  });

  test("modifying a file produces a new snapshot ID", async () => {
    const first = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    await writeSourceFile(
      sourceRoot,
      "src/greeter.ts",
      [
        "export function greet(name: string): string {",
        '  return `Hi there, ${name}!`;',
        "}",
      ].join("\n"),
    );

    const second = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    assert.notStrictEqual(
      first.ref.snapshotId,
      second.ref.snapshotId,
      "modified source must produce a different snapshot ID",
    );
    assert.ok(second.stats.discoveredFiles >= 3, "should still discover all files");
  });

  test("adding a file produces a new snapshot ID", async () => {
    const first = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    await writeSourceFile(
      sourceRoot,
      "src/new-module.ts",
      "export function brand_new(): string { return 'new'; }\n",
    );

    const second = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    assert.notStrictEqual(
      first.ref.snapshotId,
      second.ref.snapshotId,
      "adding a file must produce a different snapshot ID",
    );
    assert.strictEqual(
      second.stats.discoveredFiles,
      4,
      "should now discover 4 files",
    );
  });

  test("deleting a file produces a new snapshot ID", async () => {
    const first = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    assert.strictEqual(first.stats.discoveredFiles, 3);

    await removeSourceFile(sourceRoot, "src/utils.ts");

    const second = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    assert.notStrictEqual(
      first.ref.snapshotId,
      second.ref.snapshotId,
      "deleting a file must produce a different snapshot ID",
    );
    assert.strictEqual(
      second.stats.discoveredFiles,
      2,
      "should now discover 2 files",
    );
  });

  test("each change produces monotonically different snapshot IDs", async () => {
    const ids = new Set<string>();

    // Initial build.
    const r0 = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });
    ids.add(r0.ref.snapshotId);

    // Modify a file.
    await writeSourceFile(sourceRoot, "src/utils.ts", "export const X = 99;\n");
    const r1 = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });
    ids.add(r1.ref.snapshotId);

    // Add a file.
    await writeSourceFile(sourceRoot, "src/extra.ts", "export const E = 1;\n");
    const r2 = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });
    ids.add(r2.ref.snapshotId);

    // All three must be distinct.
    assert.strictEqual(ids.size, 3, "each change must produce a unique snapshot ID");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 4. Publication is atomic
// ──────────────────────────────────────────────────────────────────────────────

describe("publication atomicity", () => {
  let sourceRoot: string;
  let storageRoot: string;

  beforeEach(async () => {
    sourceRoot = await tempDir("atomic-source");
    storageRoot = await tempDir("atomic-storage");
    await createSourceTree(sourceRoot, SAMPLE_FILES);
  });

  afterEach(async () => {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  });

  test("current.json exists and is well-formed after a successful ensure", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    const resolvedStorage = await resolveStorageRoot(storageRoot, sourceRoot);
    const ptr = await readCurrentPointer(resolvedStorage, result.ref.worktreeKey);

    assert.notStrictEqual(ptr, null, "current.json must exist after ensure");
    assert.strictEqual(ptr!.schemaVersion, 1);
    assert.strictEqual(ptr!.worktreeKey, result.ref.worktreeKey);
    assert.strictEqual(ptr!.snapshotId, result.ref.snapshotId);
    assert.strictEqual(typeof ptr!.identityHash, "string");
    assert.ok((ptr!.identityHash as string).length > 0, "identityHash must be non-empty");
    assert.strictEqual(typeof ptr!.ownerToken, "string");
    assert.ok((ptr!.ownerToken as string).length > 0, "ownerToken must be non-empty");
    assert.strictEqual(typeof ptr!.publishedAt, "string");
  });

  test("identity.json hash matches current.json identityHash", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    const resolvedStorage = await resolveStorageRoot(storageRoot, sourceRoot);

    const ptr = await readCurrentPointer(resolvedStorage, result.ref.worktreeKey);
    assert.notStrictEqual(ptr, null, "current.json must exist");

    const identityPath = snapshotIdentityPath(
      resolvedStorage,
      result.ref.worktreeKey,
      result.ref.snapshotId,
    );
    const identityBytes = await readBoundedFileNoFollow(identityPath, 32 * 1024 * 1024);
    const identityHash = createHash("sha256").update(identityBytes).digest("hex");

    assert.strictEqual(
      identityHash,
      ptr!.identityHash,
      "SHA-256 of identity.json must match identityHash in current.json",
    );
  });

  test("snapshot directory contains identity.json and index-map.json", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    const resolvedStorage = await resolveStorageRoot(storageRoot, sourceRoot);
    const snapDir = snapshotDir(
      resolvedStorage,
      result.ref.worktreeKey,
      result.ref.snapshotId,
    );

    const entries = await readdir(snapDir);
    assert.ok(entries.includes("identity.json"), "snapshot directory must contain identity.json");
    assert.ok(entries.includes("index-map.json"), "snapshot directory must contain index-map.json");
  });

  test("previous snapshot is recorded in current.json when pointer advances", async () => {
    const first = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    // Modify source to force a new snapshot.
    await writeSourceFile(
      sourceRoot,
      "src/extra.ts",
      "export const EXTRA = true;\n",
    );

    const second = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    assert.notStrictEqual(
      first.ref.snapshotId,
      second.ref.snapshotId,
      "modifying source must produce a new snapshot",
    );

    const resolvedStorage = await resolveStorageRoot(storageRoot, sourceRoot);
    const ptr = await readCurrentPointer(resolvedStorage, second.ref.worktreeKey);

    assert.notStrictEqual(ptr, null);
    assert.strictEqual(
      ptr!.snapshotId,
      second.ref.snapshotId,
      "current.json must point to the latest snapshot",
    );

    const prevIds = ptr!.previousSnapshotIds as string[];
    assert.ok(
      prevIds.includes(first.ref.snapshotId),
      "previousSnapshotIds must include the prior snapshot ID",
    );
  });

  test("previous snapshot identity remains readable after pointer advances", async () => {
    const first = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    await writeSourceFile(
      sourceRoot,
      "src/another.ts",
      "export const ANOTHER = 1;\n",
    );

    await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    const resolvedStorage = await resolveStorageRoot(storageRoot, sourceRoot);

    // The first snapshot identity must still be readable.
    const oldIdentity = await readSnapshotIdentity(
      resolvedStorage,
      first.ref.worktreeKey,
      first.ref.snapshotId,
    );
    assert.notStrictEqual(
      oldIdentity,
      null,
      "previous snapshot identity must remain readable after pointer advances",
    );
    assert.strictEqual(oldIdentity!.schemaVersion, 2);
  });

  test("no current.json is created when ensure is aborted", async () => {
    const abortController = new AbortController();
    abortController.abort();

    await assert.rejects(
      () =>
        ensureLocalCodeIndex({
          sourcePath: sourceRoot,
          cpbRoot: storageRoot,
          signal: abortController.signal,
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );

    const resolvedStorage = await resolveStorageRoot(storageRoot, sourceRoot);
    const { worktreeKey } = computeKeys(sourceRoot, sourceRoot);
    const ptr = await readCurrentPointer(resolvedStorage, worktreeKey);
    assert.strictEqual(
      ptr,
      null,
      "aborted ensure must not create current.json",
    );
  });

  test("second ensure without source changes keeps the same current pointer", async () => {
    const first = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    const second = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    assert.strictEqual(first.ref.snapshotId, second.ref.snapshotId);

    const resolvedStorage = await resolveStorageRoot(storageRoot, sourceRoot);
    const ptr = await readCurrentPointer(resolvedStorage, first.ref.worktreeKey);
    assert.notStrictEqual(ptr, null);
    assert.strictEqual(
      ptr!.snapshotId,
      first.ref.snapshotId,
      "current.json must still point to the same snapshot when nothing changed",
    );
  });
});
