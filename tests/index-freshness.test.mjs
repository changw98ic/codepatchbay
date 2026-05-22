import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { describe, beforeEach, afterEach } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  INDEX_MANIFEST_SCHEMA_VERSION,
  DEFAULT_INDEX_TTL_MS,
  checkIndexFreshness,
  ensureIndexFresh,
  parseEnvSnapshot,
  refreshIndexManifest,
  snapshotForJob,
} from "../server/services/index-freshness.js";

const exec = promisify(execFile);

async function gitInit(dir) {
  await exec("git", ["init"], { cwd: dir });
  await exec("git", ["config", "user.email", "test@cpb.test"], { cwd: dir });
  await exec("git", ["config", "user.name", "Test"], { cwd: dir });
}

async function gitCommit(dir, msg) {
  await exec("git", ["add", "."], { cwd: dir });
  await exec("git", ["commit", "-m", msg, "--allow-empty"], { cwd: dir });
}

let fixture;

beforeEach(async () => {
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-idx-src-"));
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "cpb-idx-rt-"));
  await gitInit(sourcePath);
  await writeFile(path.join(sourcePath, "README.md"), "# test\n");
  await gitCommit(sourcePath, "init");

  const project = {
    id: "test-project",
    name: "Test Project",
    sourcePath,
    projectRoot: sourcePath,
    projectRuntimeRoot: runtimeRoot,
    metadata: { env: "test" },
  };

  fixture = { sourcePath, runtimeRoot, project };
});

afterEach(async () => {
  if (!fixture) return;
  await rm(fixture.sourcePath, { recursive: true, force: true });
  await rm(fixture.runtimeRoot, { recursive: true, force: true });
});

describe("checkIndexFreshness", () => {
  test("reports missing_manifest when no manifest exists", async () => {
    const result = await checkIndexFreshness(fixture.project);
    assert.equal(result.indexDirty, true);
    assert.equal(result.worktreeDirty, false);
    assert.equal(result.indexStale, false);
    assert.ok(result.dirtyReasons.includes("missing_manifest"));
    assert.equal(result.manifest, null);
  });

  test("reports fresh after ensureIndexFresh", async () => {
    await ensureIndexFresh(fixture.project);
    const result = await checkIndexFreshness(fixture.project);
    assert.equal(result.indexDirty, false);
    assert.equal(result.worktreeDirty, false);
    assert.equal(result.indexStale, false);
    assert.equal(result.dirtyReasons.length, 0);
    assert.ok(result.manifest);
  });

  test("reports head_change after new commit", async () => {
    await ensureIndexFresh(fixture.project);
    await writeFile(path.join(fixture.sourcePath, "new.txt"), "content\n");
    await gitCommit(fixture.sourcePath, "second commit");

    const result = await checkIndexFreshness(fixture.project);
    assert.equal(result.indexDirty, true);
    assert.ok(result.dirtyReasons.includes("head_change"));
  });

  test("reports worktree_status_change on dirty worktree", async () => {
    await ensureIndexFresh(fixture.project);
    await writeFile(path.join(fixture.sourcePath, "dirty.txt"), "uncommitted\n");

    const result = await checkIndexFreshness(fixture.project);
    assert.equal(result.worktreeDirty, true);
    assert.equal(result.indexDirty, true);
    assert.ok(result.dirtyReasons.includes("worktree_status_change"));
  });

  test("filters CPB runtime paths from worktree status", async () => {
    await ensureIndexFresh(fixture.project);
    await mkdir(path.join(fixture.sourcePath, "cpb-task"), { recursive: true });
    await writeFile(path.join(fixture.sourcePath, "cpb-task", "state.json"), "{}");
    await mkdir(path.join(fixture.sourcePath, ".cpb"), { recursive: true });
    await writeFile(path.join(fixture.sourcePath, ".cpb", "hub"), "data");

    const result = await checkIndexFreshness(fixture.project);
    assert.equal(result.worktreeDirty, false, "CPB runtime paths should be filtered");
    assert.equal(result.indexDirty, false);
  });

  test("reports file_inventory_change on new tracked file", async () => {
    await ensureIndexFresh(fixture.project);
    await writeFile(path.join(fixture.sourcePath, "added.txt"), "new file\n");
    await exec("git", ["add", "added.txt"], { cwd: fixture.sourcePath });
    await gitCommit(fixture.sourcePath, "add file");

    const result = await checkIndexFreshness(fixture.project);
    assert.equal(result.indexDirty, true);
    assert.ok(result.dirtyReasons.includes("head_change") || result.dirtyReasons.includes("file_inventory_change"));
  });

  test("reports project_config_change when project fields change", async () => {
    await ensureIndexFresh(fixture.project);
    const modified = { ...fixture.project, name: "Changed Name" };
    const result = await checkIndexFreshness(modified);
    assert.equal(result.indexDirty, true);
    assert.ok(result.dirtyReasons.includes("project_config_change"));
  });

  test("reports schema_change on version mismatch", async () => {
    await ensureIndexFresh(fixture.project);
    const mfPath = path.join(fixture.runtimeRoot, "index", "manifest.json");
    const mf = JSON.parse(await readFile(mfPath, "utf8"));
    mf.schemaVersion = 999;
    await writeFile(mfPath, `${JSON.stringify(mf, null, 2)}\n`);

    const result = await checkIndexFreshness(fixture.project);
    assert.equal(result.indexDirty, true);
    assert.ok(result.dirtyReasons.includes("schema_change"));
  });

  test("reports source_path_mismatch on different sourcePath", async () => {
    await ensureIndexFresh(fixture.project);
    const modified = { ...fixture.project, sourcePath: "/different/path" };
    const result = await checkIndexFreshness(modified);
    assert.equal(result.indexDirty, true);
    assert.ok(result.dirtyReasons.includes("source_path_mismatch"));
  });

  test("reports indexStale (not dirty) when TTL expires with unchanged fingerprints", async () => {
    const now = Date.now();
    await ensureIndexFresh(fixture.project, { now: new Date(now - 48 * 60 * 60 * 1000).toISOString() });

    const result = await checkIndexFreshness(fixture.project, {
      ttlMs: DEFAULT_INDEX_TTL_MS,
      now,
    });
    assert.equal(result.indexStale, true);
    assert.equal(result.indexDirty, false);
    assert.equal(result.worktreeDirty, false);
  });
});

describe("ensureIndexFresh", () => {
  test("creates manifest and snapshot on first call", async () => {
    const result = await ensureIndexFresh(fixture.project);
    assert.equal(result.available, true);
    assert.ok(result.indexSnapshotId);
    assert.ok(result.sourceFingerprint);
    assert.ok(result.sourceFingerprint.gitHead);
    assert.ok(result.sourceFingerprint.branch);
    assert.ok(result.sourceFingerprint.worktreeStatusHash);
    assert.ok(result.sourceFingerprint.fileInventoryHash);
    assert.ok(result.sourceFingerprint.importantConfigHash);

    const mf = JSON.parse(await readFile(path.join(fixture.runtimeRoot, "index", "manifest.json"), "utf8"));
    assert.equal(mf.schemaVersion, INDEX_MANIFEST_SCHEMA_VERSION);
    assert.equal(mf.projectId, "test-project");
    assert.equal(mf.indexSnapshotId, result.indexSnapshotId);

    const snap = JSON.parse(
      await readFile(path.join(fixture.runtimeRoot, "index", "snapshots", `${result.indexSnapshotId}.json`), "utf8"),
    );
    assert.equal(snap.indexSnapshotId, result.indexSnapshotId);
  });

  test("reuses existing snapshot when fresh", async () => {
    const first = await ensureIndexFresh(fixture.project);
    const second = await ensureIndexFresh(fixture.project);
    assert.equal(second.indexSnapshotId, first.indexSnapshotId);
  });

  test("creates new snapshot when stale", async () => {
    const first = await ensureIndexFresh(fixture.project);
    const mfPath = path.join(fixture.runtimeRoot, "index", "manifest.json");
    const mf = JSON.parse(await readFile(mfPath, "utf8"));
    mf.indexedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await writeFile(mfPath, `${JSON.stringify(mf, null, 2)}\n`);

    const second = await ensureIndexFresh(fixture.project);
    assert.equal(second.available, true);
    assert.notEqual(second.indexSnapshotId, first.indexSnapshotId);
  });

  test("returns available false when git commands fail", async () => {
    const bad = {
      ...fixture.project,
      sourcePath: "/nonexistent/path/that/does/not/exist",
    };
    const result = await ensureIndexFresh(bad);
    assert.equal(result.available, false);
    assert.equal(result.indexSnapshotId, null);
  });
});

describe("refreshIndexManifest", () => {
  test("writes manifest with all required fields", async () => {
    const result = await refreshIndexManifest(fixture.project);
    const mf = result.manifest;

    assert.equal(mf.schemaVersion, INDEX_MANIFEST_SCHEMA_VERSION);
    assert.equal(mf.projectId, fixture.project.id);
    const expectedRealpath = await realpath(fixture.project.sourcePath);
    assert.equal(mf.sourcePath, expectedRealpath);
    assert.equal(typeof mf.branch, "string");
    assert.equal(typeof mf.gitHead, "string");
    assert.equal(typeof mf.worktreeStatusHash, "string");
    assert.equal(typeof mf.fileInventoryHash, "string");
    assert.equal(typeof mf.importantConfigHash, "string");
    assert.equal(typeof mf.indexedAt, "string");
    assert.equal(typeof mf.indexSnapshotId, "string");
  });

  test("writes immutable snapshot file", async () => {
    const result = await refreshIndexManifest(fixture.project);
    const snapPath = path.join(fixture.runtimeRoot, "index", "snapshots", `${result.indexSnapshotId}.json`);
    const snap = JSON.parse(await readFile(snapPath, "utf8"));
    assert.deepEqual(snap, result.manifest);
  });
});

describe("snapshotForJob", () => {
  test("extracts snapshot data from successful result", () => {
    const result = {
      available: true,
      indexSnapshotId: "idx-abc",
      sourceFingerprint: { gitHead: "sha1", branch: "main" },
      worktreeDirty: false,
    };
    const job = snapshotForJob(result);
    assert.equal(job.indexSnapshotId, "idx-abc");
    assert.deepEqual(job.sourceFingerprint, { gitHead: "sha1", branch: "main" });
    assert.equal(job.indexFreshness.available, true);
  });

  test("returns unavailable when result is null or unavailable", () => {
    const job = snapshotForJob(null);
    assert.equal(job.indexSnapshotId, null);
    assert.equal(job.indexFreshness.available, false);
    assert.ok(job.indexFreshness.dirtyReasons.includes("index_unavailable"));

    const job2 = snapshotForJob({ available: false, indexDirty: true, dirtyReasons: ["refresh_failed"] });
    assert.equal(job2.indexSnapshotId, null);
    assert.equal(job2.indexFreshness.available, false);
    assert.ok(job2.indexFreshness.dirtyReasons.includes("refresh_failed"));
  });
});

describe("parseEnvSnapshot", () => {
  test("accepts valid snapshot with indexSnapshotId", () => {
    const result = parseEnvSnapshot(JSON.stringify({
      indexSnapshotId: "idx-abc123",
      sourceFingerprint: { gitHead: "sha1" },
      indexFreshness: { available: true },
    }));
    assert.ok(result);
    assert.equal(result.indexSnapshot.indexSnapshotId, "idx-abc123");
    assert.deepEqual(result.indexSnapshot.sourceFingerprint, { gitHead: "sha1" });
    assert.deepEqual(result.indexFreshness, { available: true });
  });

  test("accepts valid snapshot without optional fields", () => {
    const result = parseEnvSnapshot(JSON.stringify({ indexSnapshotId: "idx-min" }));
    assert.ok(result);
    assert.equal(result.indexSnapshot.indexSnapshotId, "idx-min");
    assert.equal(result.indexSnapshot.sourceFingerprint, null);
    assert.equal(result.indexFreshness, null);
  });

  test("rejects empty object", () => {
    assert.equal(parseEnvSnapshot("{}"), null);
  });

  test("rejects array", () => {
    assert.equal(parseEnvSnapshot("[]"), null);
  });

  test("rejects object with missing indexSnapshotId", () => {
    assert.equal(parseEnvSnapshot(JSON.stringify({ sourceFingerprint: {} })), null);
  });

  test("rejects object with empty string indexSnapshotId", () => {
    assert.equal(parseEnvSnapshot(JSON.stringify({ indexSnapshotId: "" })), null);
  });

  test("rejects object with numeric indexSnapshotId", () => {
    assert.equal(parseEnvSnapshot(JSON.stringify({ indexSnapshotId: 42 })), null);
  });

  test("rejects non-JSON string", () => {
    assert.equal(parseEnvSnapshot("not-json"), null);
  });

  test("rejects JSON primitives", () => {
    assert.equal(parseEnvSnapshot("42"), null);
    assert.equal(parseEnvSnapshot('"hello"'), null);
    assert.equal(parseEnvSnapshot("true"), null);
    assert.equal(parseEnvSnapshot("null"), null);
  });

  test("returns null for empty or undefined input", () => {
    assert.equal(parseEnvSnapshot(""), null);
    assert.equal(parseEnvSnapshot(undefined), null);
    assert.equal(parseEnvSnapshot(null), null);
  });
});
