// @ts-nocheck
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { describe, beforeEach, afterEach } from "node:test";

import {
  installRelease,
  readReleaseMetadata,
  resolveReleaseStoreRoot,
  validateReleaseId,
  resolveCpbHome,
  currentReleaseLinkPath,
  currentReleaseStatePath,
  listReleases,
  readCurrentReleaseSelection,
  inspectCurrentRelease,
  supportedStateFormatVersions,
  checkReleaseCompatibility,
  selectRelease,
  ReleaseCompatibilityError,
} from "../../server/services/release-store.js";

const execFileAsync = promisify(execFile);
const CPB_ROOT = path.resolve(import.meta.dirname, "..", "..");
const CPB_BIN = path.join(CPB_ROOT, "cpb");

async function pathExists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function buildFixtureSource(root) {
  const { REQUIRED_EXECUTOR_FILES } = await import("../../server/services/executor-root.js");

  const dirs = [
    "bridges", "cli", "server/services", "profiles", "templates",
    "wiki/system", "wiki/projects/_template", "wiki/projects/flow",
    "core/workflow", "shared/orchestrator", "scripts",
    "runtime/evolve", "runtime/worker", "skills",
  ];
  for (const dir of dirs) await mkdir(path.join(root, dir), { recursive: true });

  const files = {
    "bridges/common.sh": "#!/bin/bash\n",
    "bridges/run-pipeline.js": "",
    "bridges/project-worker.js": "",
    "bridges/job-runner.js": "",
    "server/services/job-store.js": "// job-store\n",
    "profiles/.keep": "",
    "templates/.keep": "",
    "wiki/system/.keep": "",
    "wiki/projects/_template/.keep": "",
    "wiki/projects/flow/context.md": "# flow context",
    "skills/.keep": "",
  };
  for (const [rel, content] of Object.entries(files)) {
    await writeFile(path.join(root, rel), content, "utf8");
  }

  // Create all REQUIRED_EXECUTOR_FILES so assertExecutorRoot passes
  for (const rel of REQUIRED_EXECUTOR_FILES) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, "", "utf8");
  }

  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "codepatchbay", version: "0.2.0" }),
    "utf8",
  );
  await writeFile(path.join(root, "cpb"), "#!/bin/bash\necho cpb\n", "utf8");
  const { chmod: chmodP } = await import("node:fs/promises");
  await chmodP(path.join(root, "cpb"), 0o755);
}

async function installTestRelease(sourceRoot, destRoot, name, now) {
  return installRelease({ sourceRoot, destRoot, name, now: now || new Date() });
}

// ─── Service-level tests ───

describe("resolveCpbHome", () => {
  test("honors CPB_HOME env", () => {
    assert.equal(resolveCpbHome({ env: { CPB_HOME: "/opt/cpb" } }), "/opt/cpb");
  });

  test("falls back to HOME/.cpb", () => {
    assert.equal(resolveCpbHome({ env: { HOME: "/home/user" } }), "/home/user/.cpb");
  });
});

describe("currentReleaseLinkPath", () => {
  test("returns CPB_HOME/current", () => {
    assert.equal(
      currentReleaseLinkPath({ env: { CPB_HOME: "/opt/cpb" } }),
      "/opt/cpb/current",
    );
  });
});

describe("currentReleaseStatePath", () => {
  test("returns CPB_HOME/release/current.json", () => {
    assert.equal(
      currentReleaseStatePath({ env: { CPB_HOME: "/opt/cpb" } }),
      "/opt/cpb/release/current.json",
    );
  });
});

describe("supportedStateFormatVersions", () => {
  test("returns current code format versions", async () => {
    const versions = await supportedStateFormatVersions();
    assert.equal(typeof versions.queue, "object");
    assert.ok(Array.isArray(versions.queue));
    assert.ok(versions.queue.includes(1));
    assert.ok(Array.isArray(versions.jobsEvents));
    assert.ok(Array.isArray(versions.leases));
    assert.ok(Array.isArray(versions.processRegistry));
    assert.ok(Array.isArray(versions.releaseMetadata));
  });
});

describe("listReleases", () => {
  let sourceRoot, destRoot;

  beforeEach(async () => {
    sourceRoot = await mkdtemp(path.join(tmpdir(), "cpb-list-src-"));
    destRoot = await mkdtemp(path.join(tmpdir(), "cpb-list-dest-"));
    await buildFixtureSource(sourceRoot);
  });

  afterEach(async () => {
    await rm(sourceRoot, { recursive: true, force: true }).catch(() => {});
    await rm(destRoot, { recursive: true, force: true }).catch(() => {});
  });

  test("returns empty array when store root is absent", async () => {
    const isolatedEnv = { ...process.env, CPB_HOME: "/nonexistent/cpb-home" };
    const result = await listReleases({ destRoot: "/nonexistent/path", env: isolatedEnv });
    assert.equal(result.releaseStoreRoot, path.resolve("/nonexistent/path"));
    assert.equal(result.current, null);
    assert.equal(result.releases.length, 0);
  });

  test("lists installed releases sorted by createdAt then releaseId", async () => {
    await installTestRelease(sourceRoot, destRoot, "release-b", new Date("2026-01-01T00:00:00Z"));
    await installTestRelease(sourceRoot, destRoot, "release-a", new Date("2026-01-02T00:00:00Z"));

    const result = await listReleases({ destRoot });
    assert.equal(result.releases.length, 2);
    assert.equal(result.releases[0].releaseId, "release-b");
    assert.equal(result.releases[1].releaseId, "release-a");
    assert.equal(result.releases[0].status, "valid");
    assert.equal(result.releases[1].status, "valid");
  });

  test("marks current release", async () => {
    const cpbHome = await mkdtemp(path.join(tmpdir(), "cpb-list-home-"));
    try {
      await installTestRelease(sourceRoot, destRoot, "rel-cur");
      await installTestRelease(sourceRoot, destRoot, "rel-other");

      const meta = await readReleaseMetadata(path.join(destRoot, "rel-cur"));
      await selectRelease({ releaseId: "rel-cur", destRoot, env: { CPB_HOME: cpbHome } });

      const result = await listReleases({ destRoot, env: { CPB_HOME: cpbHome } });
      const current = result.releases.find(r => r.releaseId === "rel-cur");
      const other = result.releases.find(r => r.releaseId === "rel-other");
      assert.equal(current.current, true);
      assert.equal(other.current, false);
    } finally {
      await rm(cpbHome, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("includes malformed entries with status invalid", async () => {
    await installTestRelease(sourceRoot, destRoot, "good-release");
    const badDir = path.join(destRoot, "bad-release");
    await mkdir(badDir, { recursive: true });
    await mkdir(path.join(badDir, "release"), { recursive: true });
    await writeFile(path.join(badDir, "release", "manifest.json"), "NOT JSON", "utf8");

    const result = await listReleases({ destRoot });
    assert.equal(result.releases.length, 2);
    const bad = result.releases.find(r => r.releaseId === "bad-release");
    assert.equal(bad.status, "invalid");
    assert.ok(bad.error);
    const good = result.releases.find(r => r.releaseId === "good-release");
    assert.equal(good.status, "valid");
  });
});

describe("readCurrentReleaseSelection", () => {
  let cpbHome;

  beforeEach(async () => {
    cpbHome = await mkdtemp(path.join(tmpdir(), "cpb-sel-home-"));
  });

  afterEach(async () => {
    await rm(cpbHome, { recursive: true, force: true }).catch(() => {});
  });

  test("returns null when nothing is selected", async () => {
    const result = await readCurrentReleaseSelection({ env: { CPB_HOME: cpbHome } });
    assert.equal(result, null);
  });
});

describe("checkReleaseCompatibility", () => {
  let sourceRoot, destRoot;

  beforeEach(async () => {
    sourceRoot = await mkdtemp(path.join(tmpdir(), "cpb-compat-src-"));
    destRoot = await mkdtemp(path.join(tmpdir(), "cpb-compat-dest-"));
    await buildFixtureSource(sourceRoot);
  });

  afterEach(async () => {
    await rm(sourceRoot, { recursive: true, force: true }).catch(() => {});
    await rm(destRoot, { recursive: true, force: true }).catch(() => {});
  });

  test("passes for valid release", async () => {
    await installTestRelease(sourceRoot, destRoot, "compat-ok");
    const result = await checkReleaseCompatibility({ releaseId: "compat-ok", destRoot });
    assert.equal(result.ok, true);
    assert.equal(result.failures.length, 0);
    assert.ok(result.metadata);
    assert.equal(result.metadata.releaseId, "compat-ok");
  });

  test("fails with missing_release for nonexistent release", async () => {
    const result = await checkReleaseCompatibility({ releaseId: "ghost", destRoot });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some(f => f.code === "missing_release"));
  });

  test("fails with manifest_malformed for bad JSON", async () => {
    const badDir = path.join(destRoot, "bad-manifest");
    await mkdir(badDir, { recursive: true });
    await mkdir(path.join(badDir, "release"), { recursive: true });
    await writeFile(path.join(badDir, "release", "manifest.json"), "{broken", "utf8");

    const result = await checkReleaseCompatibility({ releaseId: "bad-manifest", destRoot });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some(f => f.code === "manifest_malformed"));
  });

  test("fails with unsupported_state_format for mismatched version", async () => {
    await installTestRelease(sourceRoot, destRoot, "bad-version");
    const manifestPath = path.join(destRoot, "bad-version", "release", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.stateFormatVersions.queue = 999;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const result = await checkReleaseCompatibility({ releaseId: "bad-version", destRoot });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some(f => f.code === "unsupported_state_format"));
  });

  test("fails with missing_required_file when cpb is absent", async () => {
    await installTestRelease(sourceRoot, destRoot, "no-cpb");
    await rm(path.join(destRoot, "no-cpb", "cpb")).catch(() => {});

    const result = await checkReleaseCompatibility({ releaseId: "no-cpb", destRoot });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some(f => f.code === "missing_required_file"));
  });

  test("fails with missing_required_file when cpb is not executable", async () => {
    await installTestRelease(sourceRoot, destRoot, "no-exec-cpb");
    const cpbPath = path.join(destRoot, "no-exec-cpb", "cpb");
    const { chmod: chmodFn } = await import("node:fs/promises");
    await chmodFn(cpbPath, 0o644);

    const result = await checkReleaseCompatibility({ releaseId: "no-exec-cpb", destRoot });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some(f => f.code === "missing_required_file" && f.message.includes("executable")));
  });

  test("non-executable cpb via CLI use is rejected without changing current selection", async () => {
    const cpbHomeLocal = await mkdtemp(path.join(tmpdir(), "cpb-noexec-home-"));
    try {
      await installTestRelease(sourceRoot, destRoot, "first-sel");
      await installTestRelease(sourceRoot, destRoot, "noexec-sel");

      await selectRelease({ releaseId: "first-sel", destRoot, env: { CPB_HOME: cpbHomeLocal } });

      const { chmod: chmodFn } = await import("node:fs/promises");
      await chmodFn(path.join(destRoot, "noexec-sel", "cpb"), 0o644);

      try {
        await execFileAsync(CPB_BIN, [
          "release", "use", "noexec-sel", "--json", "--dest-root", destRoot,
        ], { env: { ...process.env, CPB_ROOT: CPB_ROOT, CPB_EXECUTOR_ROOT: CPB_ROOT, CPB_HOME: cpbHomeLocal } });
        assert.fail("should have thrown");
      } catch (err) {
        assert.ok(err.code !== 0);
        const parsed = JSON.parse(err.stderr);
        assert.equal(parsed.ok, false);
        assert.ok(parsed.failures.some(f => f.code === "missing_required_file"));
      }

      const current = await readCurrentReleaseSelection({ env: { CPB_HOME: cpbHomeLocal } });
      assert.equal(current.selector.releaseId, "first-sel");
    } finally {
      await rm(cpbHomeLocal, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("fails with metadata_incomplete for missing fields", async () => {
    const badDir = path.join(destRoot, "incomplete-meta");
    await mkdir(badDir, { recursive: true });
    await mkdir(path.join(badDir, "release"), { recursive: true });
    await writeFile(
      path.join(badDir, "release", "manifest.json"),
      JSON.stringify({ metadataVersion: 1, releaseId: "incomplete-meta" }),
      "utf8",
    );
    await writeFile(path.join(badDir, "cpb"), "#!/bin/bash\n", "utf8");

    const result = await checkReleaseCompatibility({ releaseId: "incomplete-meta", destRoot });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some(f => f.code === "metadata_incomplete"));
  });

  test("fails with release_id_mismatch when manifest id differs", async () => {
    await installTestRelease(sourceRoot, destRoot, "original-id");
    const manifestPath = path.join(destRoot, "original-id", "release", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.releaseId = "different-id";
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const result = await checkReleaseCompatibility({ releaseId: "original-id", destRoot });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some(f => f.code === "release_id_mismatch"));
  });

  test("fails with manifest_missing when manifest file is absent", async () => {
    const badDir = path.join(destRoot, "no-manifest");
    await mkdir(badDir, { recursive: true });
    await writeFile(path.join(badDir, "cpb"), "#!/bin/bash\n", "utf8");

    const result = await checkReleaseCompatibility({ releaseId: "no-manifest", destRoot });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some(f => f.code === "manifest_missing"));
  });

  test("rejects slash-containing releaseId without filesystem inspection", async () => {
    const result = await checkReleaseCompatibility({ releaseId: "../etc/passwd", destRoot });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some(f => f.code === "release_path_invalid"));
    assert.equal(result.metadata, null);
  });

  test("rejects dot-dot releaseId without filesystem inspection", async () => {
    const result = await checkReleaseCompatibility({ releaseId: "..", destRoot });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some(f => f.code === "release_path_invalid"));
    assert.equal(result.metadata, null);
  });

  test("rejects absolute-path releaseId without filesystem inspection", async () => {
    const result = await checkReleaseCompatibility({ releaseId: "/etc/shadow", destRoot });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some(f => f.code === "release_path_invalid"));
    assert.equal(result.metadata, null);
  });

  test("rejects traversal via CLI use without changing current selection", async () => {
    const cpbHomeLocal = await mkdtemp(path.join(tmpdir(), "cpb-trav-home-"));
    try {
      await installTestRelease(sourceRoot, destRoot, "trav-safe");
      await selectRelease({ releaseId: "trav-safe", destRoot, env: { CPB_HOME: cpbHomeLocal } });

      try {
        await execFileAsync(CPB_BIN, [
          "release", "use", "../etc/passwd", "--json", "--dest-root", destRoot,
        ], { env: { ...process.env, CPB_ROOT: CPB_ROOT, CPB_EXECUTOR_ROOT: CPB_ROOT, CPB_HOME: cpbHomeLocal } });
        assert.fail("should have thrown");
      } catch (err) {
        assert.ok(err.code !== 0);
        const parsed = JSON.parse(err.stderr);
        assert.equal(parsed.ok, false);
        assert.ok(parsed.failures.some(f => f.code === "release_path_invalid"));
      }

      const current = await readCurrentReleaseSelection({ env: { CPB_HOME: cpbHomeLocal } });
      assert.equal(current.selector.releaseId, "trav-safe");
    } finally {
      await rm(cpbHomeLocal, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("fails with release_path_invalid for symlink release directory and short-circuits before manifest reads", async () => {
    await installTestRelease(sourceRoot, destRoot, "real-release");
    const linkDir = path.join(destRoot, "link-release");
    const { symlink: symlinkFn } = await import("node:fs/promises");
    await symlinkFn(path.join(destRoot, "real-release"), linkDir);

    const result = await checkReleaseCompatibility({ releaseId: "link-release", destRoot });
    assert.equal(result.ok, false);
    assert.equal(result.failures.length, 1, "symlink should produce exactly one failure and short-circuit");
    assert.equal(result.failures[0].code, "release_path_invalid");
    assert.equal(result.metadata, null, "metadata must not be read through symlink");
  });

  test("symlink release via CLI use is rejected without changing current selection", async () => {
    const cpbHomeLocal = await mkdtemp(path.join(tmpdir(), "cpb-symlink-home-"));
    try {
      await installTestRelease(sourceRoot, destRoot, "symlink-safe");
      await selectRelease({ releaseId: "symlink-safe", destRoot, env: { CPB_HOME: cpbHomeLocal } });

      const { symlink: symlinkFn } = await import("node:fs/promises");
      await symlinkFn(path.join(destRoot, "symlink-safe"), path.join(destRoot, "symlink-target"));

      try {
        await execFileAsync(CPB_BIN, [
          "release", "use", "symlink-target", "--json", "--dest-root", destRoot,
        ], { env: { ...process.env, CPB_ROOT: CPB_ROOT, CPB_EXECUTOR_ROOT: CPB_ROOT, CPB_HOME: cpbHomeLocal } });
        assert.fail("should have thrown");
      } catch (err) {
        assert.ok(err.code !== 0);
        const parsed = JSON.parse(err.stderr);
        assert.equal(parsed.ok, false);
        assert.ok(parsed.failures.some(f => f.code === "release_path_invalid"));
        assert.equal(parsed.failures.length, 1, "CLI should report exactly one failure for symlink");
      }

      const current = await readCurrentReleaseSelection({ env: { CPB_HOME: cpbHomeLocal } });
      assert.equal(current.selector.releaseId, "symlink-safe");
    } finally {
      await rm(cpbHomeLocal, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("selectRelease", () => {
  let sourceRoot, destRoot, cpbHome;

  beforeEach(async () => {
    sourceRoot = await mkdtemp(path.join(tmpdir(), "cpb-select-src-"));
    destRoot = await mkdtemp(path.join(tmpdir(), "cpb-select-dest-"));
    cpbHome = await mkdtemp(path.join(tmpdir(), "cpb-select-home-"));
    await buildFixtureSource(sourceRoot);
  });

  afterEach(async () => {
    await rm(sourceRoot, { recursive: true, force: true }).catch(() => {});
    await rm(destRoot, { recursive: true, force: true }).catch(() => {});
    await rm(cpbHome, { recursive: true, force: true }).catch(() => {});
  });

  test("selects a compatible release and writes selector state", async () => {
    await installTestRelease(sourceRoot, destRoot, "sel-a");
    const result = await selectRelease({
      releaseId: "sel-a",
      destRoot,
      env: { CPB_HOME: cpbHome },
    });

    assert.ok(result.selector);
    assert.equal(result.selector.releaseId, "sel-a");
    assert.equal(result.selector.stateVersion, 1);
    assert.equal(result.compatibility.ok, true);
    assert.ok(result.metadata);

    const linkPath = currentReleaseLinkPath({ env: { CPB_HOME: cpbHome } });
    assert.ok(await pathExists(linkPath), "current symlink should exist");

    const statePath = currentReleaseStatePath({ env: { CPB_HOME: cpbHome } });
    assert.ok(await pathExists(statePath), "selector JSON should exist");
  });

  test("throws ReleaseCompatibilityError for missing release", async () => {
    await assert.rejects(
      () => selectRelease({ releaseId: "ghost", destRoot, env: { CPB_HOME: cpbHome } }),
      (err) => {
        assert.ok(err instanceof ReleaseCompatibilityError);
        assert.ok(err.failures.some(f => f.code === "missing_release"));
        return true;
      },
    );

    const linkPath = currentReleaseLinkPath({ env: { CPB_HOME: cpbHome } });
    assert.equal(await pathExists(linkPath), false, "no symlink on failure");
  });

  test("does not mutate job state", async () => {
    const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-sel-root-"));
    const eventsDir = path.join(cpbRoot, "cpb-task", "events");
    await mkdir(eventsDir, { recursive: true });
    const sentinelPath = path.join(eventsDir, "sentinel.jsonl");
    await writeFile(sentinelPath, '{"type":"sentinel"}\n', "utf8");

    try {
      await installTestRelease(sourceRoot, destRoot, "no-mutate");
      await selectRelease({
        releaseId: "no-mutate",
        destRoot,
        env: { CPB_HOME: cpbHome, CPB_ROOT: cpbRoot },
      });

      const content = await readFile(sentinelPath, "utf8");
      assert.equal(content, '{"type":"sentinel"}\n');

      try {
        await selectRelease({ releaseId: "ghost", destRoot, env: { CPB_HOME: cpbHome, CPB_ROOT: cpbRoot } });
      } catch {}
      const contentAfter = await readFile(sentinelPath, "utf8");
      assert.equal(contentAfter, '{"type":"sentinel"}\n');
    } finally {
      await rm(cpbRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("failed select leaves previous selection unchanged", async () => {
    await installTestRelease(sourceRoot, destRoot, "prev-sel");
    await installTestRelease(sourceRoot, destRoot, "fail-sel");

    await selectRelease({ releaseId: "prev-sel", destRoot, env: { CPB_HOME: cpbHome } });

    const manifestPath = path.join(destRoot, "fail-sel", "release", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.stateFormatVersions.queue = 999;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    await assert.rejects(
      () => selectRelease({ releaseId: "fail-sel", destRoot, env: { CPB_HOME: cpbHome } }),
    );

    const current = await readCurrentReleaseSelection({ env: { CPB_HOME: cpbHome } });
    assert.equal(current.selector.releaseId, "prev-sel");
  });
});

describe("inspectCurrentRelease", () => {
  let sourceRoot, destRoot, cpbHome;

  beforeEach(async () => {
    sourceRoot = await mkdtemp(path.join(tmpdir(), "cpb-inspect-src-"));
    destRoot = await mkdtemp(path.join(tmpdir(), "cpb-inspect-dest-"));
    cpbHome = await mkdtemp(path.join(tmpdir(), "cpb-inspect-home-"));
    await buildFixtureSource(sourceRoot);
  });

  afterEach(async () => {
    await rm(sourceRoot, { recursive: true, force: true }).catch(() => {});
    await rm(destRoot, { recursive: true, force: true }).catch(() => {});
    await rm(cpbHome, { recursive: true, force: true }).catch(() => {});
  });

  test("returns null when no current release is selected", async () => {
    const result = await inspectCurrentRelease({ env: { CPB_HOME: cpbHome } });
    assert.equal(result, null);
  });

  test("returns selector and metadata for selected release", async () => {
    await installTestRelease(sourceRoot, destRoot, "inspect-me");
    await selectRelease({ releaseId: "inspect-me", destRoot, env: { CPB_HOME: cpbHome } });

    const result = await inspectCurrentRelease({ env: { CPB_HOME: cpbHome } });
    assert.ok(result);
    assert.ok(result.selector);
    assert.equal(result.selector.releaseId, "inspect-me");
    assert.ok(result.metadata);
    assert.equal(result.metadata.releaseId, "inspect-me");
    assert.equal(result.metadata.codeVersion, "0.2.0");
    assert.ok(result.metadata.stateFormatVersions);
  });
});

// ─── CLI tests ───

describe("cpb release list CLI", () => {
  let sourceRoot, destRoot;

  beforeEach(async () => {
    sourceRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-list-src-"));
    destRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-list-dest-"));
    await buildFixtureSource(sourceRoot);
  });

  afterEach(async () => {
    await rm(sourceRoot, { recursive: true, force: true }).catch(() => {});
    await rm(destRoot, { recursive: true, force: true }).catch(() => {});
  });

  test("list --json returns parseable JSON with empty releases", async () => {
    const emptyHome = await mkdtemp(path.join(tmpdir(), "cpb-list-cli-home-"));
    try {
      const { stdout } = await execFileAsync(CPB_BIN, [
        "release", "list", "--json", "--dest-root", destRoot,
      ], { env: { ...process.env, CPB_ROOT: CPB_ROOT, CPB_EXECUTOR_ROOT: CPB_ROOT, CPB_HOME: emptyHome } });

      const parsed = JSON.parse(stdout);
      assert.ok(parsed.releaseStoreRoot);
      assert.equal(parsed.current, null);
      assert.ok(Array.isArray(parsed.releases));
    } finally {
      await rm(emptyHome, { recursive: true, force: true });
    }
  });

  test("list --json returns installed releases", async () => {
    await installTestRelease(sourceRoot, destRoot, "cli-a", new Date("2026-01-01T00:00:00Z"));
    await installTestRelease(sourceRoot, destRoot, "cli-b", new Date("2026-01-02T00:00:00Z"));

    const { stdout } = await execFileAsync(CPB_BIN, [
      "release", "list", "--json", "--dest-root", destRoot,
    ], { env: { ...process.env, CPB_ROOT: CPB_ROOT, CPB_EXECUTOR_ROOT: CPB_ROOT } });

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.releases.length, 2);
    assert.equal(parsed.releases[0].releaseId, "cli-a");
    assert.equal(parsed.releases[1].releaseId, "cli-b");
  });
});

describe("cpb release use CLI", () => {
  let sourceRoot, destRoot, cpbHome;

  beforeEach(async () => {
    sourceRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-use-src-"));
    destRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-use-dest-"));
    cpbHome = await mkdtemp(path.join(tmpdir(), "cpb-cli-use-home-"));
    await buildFixtureSource(sourceRoot);
  });

  afterEach(async () => {
    await rm(sourceRoot, { recursive: true, force: true }).catch(() => {});
    await rm(destRoot, { recursive: true, force: true }).catch(() => {});
    await rm(cpbHome, { recursive: true, force: true }).catch(() => {});
  });

  test("use <release-id> --json selects release", async () => {
    await installTestRelease(sourceRoot, destRoot, "use-ok");

    const { stdout } = await execFileAsync(CPB_BIN, [
      "release", "use", "use-ok", "--json", "--dest-root", destRoot,
    ], { env: { ...process.env, CPB_ROOT: CPB_ROOT, CPB_EXECUTOR_ROOT: CPB_ROOT, CPB_HOME: cpbHome } });

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.selected, true);
    assert.ok(parsed.selector);
    assert.equal(parsed.selector.releaseId, "use-ok");
    assert.ok(parsed.metadata);
    assert.ok(parsed.compatibility);
  });

  test("use missing-release --json exits non-zero with structured error", async () => {
    try {
      await execFileAsync(CPB_BIN, [
        "release", "use", "ghost", "--json", "--dest-root", destRoot,
      ], { env: { ...process.env, CPB_ROOT: CPB_ROOT, CPB_EXECUTOR_ROOT: CPB_ROOT, CPB_HOME: cpbHome } });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err.code !== 0, "should exit non-zero");
      const parsed = JSON.parse(err.stderr);
      assert.equal(parsed.ok, false);
      assert.ok(parsed.failures.some(f => f.code === "missing_release"));
    }

    const linkPath = path.join(cpbHome, "current");
    assert.equal(await pathExists(linkPath), false);
  });

  test("use with unsupported state format exits non-zero", async () => {
    await installTestRelease(sourceRoot, destRoot, "bad-fmt");
    const manifestPath = path.join(destRoot, "bad-fmt", "release", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.stateFormatVersions.queue = 999;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    try {
      await execFileAsync(CPB_BIN, [
        "release", "use", "bad-fmt", "--json", "--dest-root", destRoot,
      ], { env: { ...process.env, CPB_ROOT: CPB_ROOT, CPB_EXECUTOR_ROOT: CPB_ROOT, CPB_HOME: cpbHome } });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err.code !== 0);
      const parsed = JSON.parse(err.stderr);
      assert.ok(parsed.failures.some(f => f.code === "unsupported_state_format"));
    }
  });
});

describe("cpb release current CLI", () => {
  let sourceRoot, destRoot, cpbHome;

  beforeEach(async () => {
    sourceRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-cur-src-"));
    destRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-cur-dest-"));
    cpbHome = await mkdtemp(path.join(tmpdir(), "cpb-cli-cur-home-"));
    await buildFixtureSource(sourceRoot);
  });

  afterEach(async () => {
    await rm(sourceRoot, { recursive: true, force: true }).catch(() => {});
    await rm(destRoot, { recursive: true, force: true }).catch(() => {});
    await rm(cpbHome, { recursive: true, force: true }).catch(() => {});
  });

  test("current --json returns metadata after selection", async () => {
    await installTestRelease(sourceRoot, destRoot, "cur-test");

    await execFileAsync(CPB_BIN, [
      "release", "use", "cur-test", "--json", "--dest-root", destRoot,
    ], { env: { ...process.env, CPB_ROOT: CPB_ROOT, CPB_EXECUTOR_ROOT: CPB_ROOT, CPB_HOME: cpbHome } });

    const { stdout } = await execFileAsync(CPB_BIN, [
      "release", "current", "--json",
    ], { env: { ...process.env, CPB_ROOT: CPB_ROOT, CPB_EXECUTOR_ROOT: CPB_ROOT, CPB_HOME: cpbHome } });

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.current, true);
    assert.ok(parsed.selector);
    assert.equal(parsed.selector.releaseId, "cur-test");
    assert.ok(parsed.metadata);
    assert.equal(parsed.metadata.releaseId, "cur-test");
    assert.ok(parsed.metadata.stateFormatVersions);
  });

  test("current --json exits non-zero with structured error when nothing selected", async () => {
    try {
      await execFileAsync(CPB_BIN, [
        "release", "current", "--json",
      ], { env: { ...process.env, CPB_ROOT: CPB_ROOT, CPB_EXECUTOR_ROOT: CPB_ROOT, CPB_HOME: cpbHome } });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err.code !== 0);
      const parsed = JSON.parse(err.stderr);
      assert.equal(parsed.current, false);
      assert.ok(parsed.error);
    }
  });
});

describe("cpb release list marks current after use", () => {
  let sourceRoot, destRoot, cpbHome;

  beforeEach(async () => {
    sourceRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-mark-src-"));
    destRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-mark-dest-"));
    cpbHome = await mkdtemp(path.join(tmpdir(), "cpb-cli-mark-home-"));
    await buildFixtureSource(sourceRoot);
  });

  afterEach(async () => {
    await rm(sourceRoot, { recursive: true, force: true }).catch(() => {});
    await rm(destRoot, { recursive: true, force: true }).catch(() => {});
    await rm(cpbHome, { recursive: true, force: true }).catch(() => {});
  });

  test("list --json marks selected release as current", async () => {
    await installTestRelease(sourceRoot, destRoot, "mark-a", new Date("2026-01-01T00:00:00Z"));
    await installTestRelease(sourceRoot, destRoot, "mark-b", new Date("2026-01-02T00:00:00Z"));

    await execFileAsync(CPB_BIN, [
      "release", "use", "mark-a", "--json", "--dest-root", destRoot,
    ], { env: { ...process.env, CPB_ROOT: CPB_ROOT, CPB_EXECUTOR_ROOT: CPB_ROOT, CPB_HOME: cpbHome } });

    const { stdout } = await execFileAsync(CPB_BIN, [
      "release", "list", "--json", "--dest-root", destRoot,
    ], { env: { ...process.env, CPB_ROOT: CPB_ROOT, CPB_EXECUTOR_ROOT: CPB_ROOT, CPB_HOME: cpbHome } });

    const parsed = JSON.parse(stdout);
    const a = parsed.releases.find(r => r.releaseId === "mark-a");
    const b = parsed.releases.find(r => r.releaseId === "mark-b");
    assert.equal(a.current, true);
    assert.equal(b.current, false);
  });
});

describe("release use does not mutate job state", () => {
  let sourceRoot, destRoot, cpbHome, cpbRoot;

  beforeEach(async () => {
    sourceRoot = await mkdtemp(path.join(tmpdir(), "cpb-nomut-src-"));
    destRoot = await mkdtemp(path.join(tmpdir(), "cpb-nomut-dest-"));
    cpbHome = await mkdtemp(path.join(tmpdir(), "cpb-nomut-home-"));
    cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-nomut-root-"));
    await buildFixtureSource(sourceRoot);

    const eventsDir = path.join(cpbRoot, "cpb-task", "events");
    await mkdir(eventsDir, { recursive: true });
    await writeFile(
      path.join(eventsDir, "sentinel.jsonl"),
      '{"type":"sentinel"}\n',
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(sourceRoot, { recursive: true, force: true }).catch(() => {});
    await rm(destRoot, { recursive: true, force: true }).catch(() => {});
    await rm(cpbHome, { recursive: true, force: true }).catch(() => {});
    await rm(cpbRoot, { recursive: true, force: true }).catch(() => {});
  });

  test("successful use does not create job files", async () => {
    await installTestRelease(sourceRoot, destRoot, "nomut-ok");

    await execFileAsync(CPB_BIN, [
      "release", "use", "nomut-ok", "--json", "--dest-root", destRoot,
    ], { env: { ...process.env, CPB_ROOT: cpbRoot, CPB_EXECUTOR_ROOT: CPB_ROOT, CPB_HOME: cpbHome } });

    const sentinel = await readFile(path.join(cpbRoot, "cpb-task", "events", "sentinel.jsonl"), "utf8");
    assert.equal(sentinel, '{"type":"sentinel"}\n');
  });
});
