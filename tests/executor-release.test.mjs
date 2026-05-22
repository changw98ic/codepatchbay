import assert from "node:assert/strict";
import { access, chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { describe, beforeEach, afterEach } from "node:test";

import { listJobs } from "../server/services/job-store.js";
import { installRelease, readReleaseMetadata, resolveReleaseStoreRoot, validateReleaseId, releasePath, manifestPathForRelease, RELEASE_METADATA_FORMAT_VERSION } from "../server/services/release-store.js";

const execFileAsync = promisify(execFile);

// Strip ALL CPB_* env vars so tests run in isolation from the worktree environment.
function cleanEnv(overrides = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("CPB_")) clean[k] = v;
  }
  return { ...clean, ...overrides };
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function buildFixtureSource(root) {
  const dirs = [
    "bridges",
    "server/services",
    "profiles",
    "templates",
    "wiki/system",
    "wiki/projects/_template",
    "wiki/projects/flow",
    "cpb-task/queue",
    "cpb-task/events/project",
    "cpb-task/leases",
    "cpb-task/processes",
    ".omx",
    "omx_wiki",
  ];
  for (const dir of dirs) {
    await mkdir(path.join(root, dir), { recursive: true });
  }

  const files = {
    "bridges/common.sh": "#!/bin/bash\n",
    "bridges/run-pipeline.mjs": "",
    "bridges/project-worker.mjs": "",
    "bridges/job-runner.mjs": "",
    "server/services/job-store.js": "// job-store\n",
    "profiles/.keep": "",
    "templates/.keep": "",
    "wiki/system/.keep": "",
    "wiki/projects/_template/.keep": "",
    "wiki/projects/flow/context.md": "# flow context",
    "cpb-task/queue/queue.json": "{}",
    "cpb-task/events/project/job.jsonl": '{"type":"created"}\n',
    "cpb-task/leases/lease.json": "{}",
    "cpb-task/processes/process.json": "{}",
    ".omx/state.json": "{}",
    "omx_wiki/state.json": "{}",
  };
  for (const [rel, content] of Object.entries(files)) {
    await writeFile(path.join(root, rel), content, "utf8");
  }

  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "codepatchbay", version: "0.2.0" }),
    "utf8",
  );
  await writeFile(path.join(root, "cpb"), "#!/bin/bash\necho cpb\n", "utf8");
}

async function buildCliExecutorRoot(root) {
  for (const item of ["bridges", "server", "profiles", "templates", "package.json", "cpb"]) {
    await cp(path.join(process.cwd(), item), path.join(root, item), { recursive: true });
  }
  await chmod(path.join(root, "cpb"), 0o755);

  await mkdir(path.join(root, "wiki", "system"), { recursive: true });
  await mkdir(path.join(root, "wiki", "projects", "_template"), { recursive: true });
  await writeFile(
    path.join(root, "wiki", "system", "handshake-protocol.md"),
    "# Handshake\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "wiki", "projects", "_template", "context.md"),
    "# Project Context\n",
    "utf8",
  );
}

describe("release-store service", () => {
  let sourceRoot;
  let destRoot;

  beforeEach(async () => {
    sourceRoot = await mkdtemp(path.join(tmpdir(), "cpb-release-src-"));
    destRoot = await mkdtemp(path.join(tmpdir(), "cpb-release-dest-"));
    await buildFixtureSource(sourceRoot);
  });

  afterEach(async () => {
    await rm(sourceRoot, { recursive: true, force: true }).catch(() => {});
    await rm(destRoot, { recursive: true, force: true }).catch(() => {});
  });

  test("installRelease returns canonical metadata", async () => {
    const now = new Date("2026-05-20T14:00:00Z");
    const metadata = await installRelease({
      sourceRoot,
      destRoot,
      name: "test-release",
      now,
    });

    assert.equal(metadata.metadataVersion, 1);
    assert.equal(metadata.releaseId, "test-release");
    assert.equal(metadata.sourcePath, path.resolve(sourceRoot));
    assert.ok(metadata.installedPath.includes("test-release"));
    assert.equal(metadata.createdAt, "2026-05-20T14:00:00.000Z");
    assert.equal(metadata.codeVersion, "0.2.0");
    assert.equal(metadata.packageName, "codepatchbay");
    assert.equal(typeof metadata.stateFormatVersions.queue, "number");
    assert.equal(typeof metadata.stateFormatVersions.jobsEvents, "number");
    assert.equal(typeof metadata.stateFormatVersions.leases, "number");
    assert.equal(typeof metadata.stateFormatVersions.processRegistry, "number");
    assert.equal(typeof metadata.stateFormatVersions.releaseMetadata, "number");
  });

  test("manifest is readable from installed path", async () => {
    const now = new Date("2026-05-20T14:00:00Z");
    const metadata = await installRelease({
      sourceRoot,
      destRoot,
      name: "readback-test",
      now,
    });

    const manifestPath = path.join(metadata.installedPath, "release", "manifest.json");
    const raw = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw);

    assert.equal(parsed.metadataVersion, 1);
    assert.equal(parsed.releaseId, "readback-test");
    assert.equal(parsed.sourcePath, path.resolve(sourceRoot));
    assert.equal(parsed.createdAt, "2026-05-20T14:00:00.000Z");
    assert.equal(parsed.codeVersion, "0.2.0");
    assert.equal(parsed.packageName, "codepatchbay");
    assert.equal(parsed.stateFormatVersions.releaseMetadata, RELEASE_METADATA_FORMAT_VERSION);
  });

  test("readReleaseMetadata reads from installed path", async () => {
    const now = new Date("2026-05-20T14:00:00Z");
    const metadata = await installRelease({
      sourceRoot,
      destRoot,
      name: "meta-read",
      now,
    });

    const fromDir = await readReleaseMetadata(metadata.installedPath);
    assert.equal(fromDir.releaseId, "meta-read");
    assert.equal(fromDir.codeVersion, "0.2.0");

    const manifestFile = manifestPathForRelease(metadata.installedPath);
    const fromFile = await readReleaseMetadata(manifestFile);
    assert.equal(fromFile.releaseId, "meta-read");
  });

  test("duplicate release id is rejected before copy", async () => {
    await installRelease({ sourceRoot, destRoot, name: "dup-test" });
    await assert.rejects(
      () => installRelease({ sourceRoot, destRoot, name: "dup-test" }),
      { message: /release already exists/ },
    );
  });

  test("duplicate install does not overwrite existing release", async () => {
    await installRelease({ sourceRoot, destRoot, name: "sentinel-test" });
    const sentinel = path.join(destRoot, "sentinel-test", "release", "manifest.json");
    const original = await readFile(sentinel, "utf8");

    try {
      await installRelease({ sourceRoot, destRoot, name: "sentinel-test" });
    } catch {}

    const after = await readFile(sentinel, "utf8");
    assert.equal(after, original);
  });

  test("generated release id uses code version and UTC timestamp", async () => {
    const now = new Date("2026-05-20T14:00:01Z");
    const metadata = await installRelease({ sourceRoot, destRoot, now });
    assert.equal(metadata.releaseId, "0.2.0-20260520T140001Z");
    assert.ok(await pathExists(metadata.installedPath));
  });

  test("runtime state directories are excluded from release", async () => {
    const metadata = await installRelease({ sourceRoot, destRoot, name: "excl-test" });
    const installed = metadata.installedPath;

    const excludedPaths = [
      path.join(installed, "cpb-task"),
      path.join(installed, "cpb-task", "queue"),
      path.join(installed, "cpb-task", "events"),
      path.join(installed, "cpb-task", "leases"),
      path.join(installed, "cpb-task", "processes"),
      path.join(installed, ".omx"),
      path.join(installed, "omx_wiki"),
      path.join(installed, "wiki", "projects", "flow"),
    ];
    for (const p of excludedPaths) {
      assert.equal(await pathExists(p), false, `Expected ${p} to be absent`);
    }
  });

  test("allowed executor assets are present in release", async () => {
    const metadata = await installRelease({ sourceRoot, destRoot, name: "assets-test" });
    const installed = metadata.installedPath;

    assert.ok(await pathExists(path.join(installed, "bridges", "common.sh")));
    assert.ok(await pathExists(path.join(installed, "server", "services", "job-store.js")));
    assert.ok(await pathExists(path.join(installed, "wiki", "system", ".keep")));
    assert.ok(await pathExists(path.join(installed, "wiki", "projects", "_template", ".keep")));
    assert.ok(await pathExists(path.join(installed, "package.json")));
    assert.ok(await pathExists(path.join(installed, "release", "manifest.json")));
  });
});

describe("validateReleaseId", () => {
  test("accepts valid ids", () => {
    assert.doesNotThrow(() => validateReleaseId("my-release"));
    assert.doesNotThrow(() => validateReleaseId("v1.2.3"));
    assert.doesNotThrow(() => validateReleaseId("release_001"));
  });

  test("rejects empty, dot, dot-dot, slashes", () => {
    assert.throws(() => validateReleaseId(""), /non-empty/);
    assert.throws(() => validateReleaseId("."), /invalid/);
    assert.throws(() => validateReleaseId(".."), /invalid/);
    assert.throws(() => validateReleaseId("foo/bar"), /must not contain slashes/);
  });

  test("rejects ids starting with non-alphanumeric", () => {
    assert.throws(() => validateReleaseId("-bad"), /invalid/);
    assert.throws(() => validateReleaseId(".hidden"), /invalid/);
  });
});

describe("resolveReleaseStoreRoot", () => {
  test("uses explicit destRoot when provided", () => {
    const result = resolveReleaseStoreRoot({ destRoot: "/tmp/my-releases" });
    assert.equal(result, path.resolve("/tmp/my-releases"));
  });

  test("falls back to CPB_HOME/releases", () => {
    const result = resolveReleaseStoreRoot({ env: { CPB_HOME: "/opt/cpb" } });
    assert.equal(result, path.join("/opt/cpb", "releases"));
  });
});

describe("cpb release install CLI", () => {
  let sourceRoot;
  let cliDestRoot;

  beforeEach(async () => {
    sourceRoot = await realpath(await mkdtemp(path.join(tmpdir(), "cpb-cli-src-")));
    cliDestRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-dest-"));
    await buildCliExecutorRoot(sourceRoot);
  });

  afterEach(async () => {
    await rm(sourceRoot, { recursive: true, force: true }).catch(() => {});
    await rm(cliDestRoot, { recursive: true, force: true }).catch(() => {});
  });

  test("cpb release install respects CPB_HOME when --dest-root is omitted", async () => {
    const cpbBin = path.join(sourceRoot, "cpb");
    const realRoot = sourceRoot;
    const cpbHome = await mkdtemp(path.join(tmpdir(), "cpb-home-"));
    const homeDir = await mkdtemp(path.join(tmpdir(), "cpb-fake-home-"));

    try {
      const { stdout } = await execFileAsync(cpbBin, [
        "release", "install",
        "--name", "cpb-home-test",
        "--json",
      ], {
        env: cleanEnv({
          CPB_ROOT: realRoot,
          CPB_EXECUTOR_ROOT: realRoot,
          CPB_HOME: cpbHome,
          HOME: homeDir,
        }),
      });

      const parsed = JSON.parse(stdout);
      assert.equal(parsed.releaseId, "cpb-home-test");
      assert.ok(
        parsed.installedPath.startsWith(path.join(cpbHome, "releases")),
        `expected installedPath under ${cpbHome}/releases, got ${parsed.installedPath}`,
      );

      const manifestPath = path.join(cpbHome, "releases", "cpb-home-test", "release", "manifest.json");
      assert.ok(await pathExists(manifestPath));

      const homeReleases = path.join(homeDir, ".cpb", "releases");
      assert.equal(await pathExists(homeReleases), false, "should not write under HOME/.cpb when CPB_HOME is set");
    } finally {
      await rm(cpbHome, { recursive: true, force: true }).catch(() => {});
      await rm(homeDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("cpb release install --name cli-release --dest-root <tmp> --json", async () => {
    const cpbBin = path.join(sourceRoot, "cpb");
    const realRoot = sourceRoot;
    const { stdout } = await execFileAsync(cpbBin, [
      "release", "install",
      "--name", "cli-release",
      "--dest-root", cliDestRoot,
      "--json",
    ], {
      env: cleanEnv({
        CPB_ROOT: realRoot,
        CPB_EXECUTOR_ROOT: realRoot,
      }),
    });

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.releaseId, "cli-release");
    assert.equal(parsed.codeVersion, "0.2.0");
    assert.equal(parsed.packageName, "codepatchbay");
    assert.equal(parsed.metadataVersion, 1);
    assert.ok(parsed.installedPath);
    assert.ok(parsed.createdAt);

    const manifestPath = path.join(cliDestRoot, "cli-release", "release", "manifest.json");
    assert.ok(await pathExists(manifestPath));
  });
});

describe("existing run-pipeline executor root test", () => {
  test("run-pipeline records the pinned executor root on job creation", async () => {
    const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-executor-state-"));
    const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-executor-source-"));
    const executorRoot = process.cwd();

    await execFileAsync(process.execPath, [
      "bridges/run-pipeline.mjs",
      "--project", "executor-meta",
      "--task", "noop",
      "--source-path", sourcePath,
      "--workflow", "blocked",
    ], {
      cwd: process.cwd(),
      env: cleanEnv({
        CPB_ROOT: cpbRoot,
        CPB_EXECUTOR_ROOT: executorRoot,
      }),
    });

    const jobs = await listJobs(cpbRoot);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].executor.root, executorRoot);
    assert.equal(jobs[0].executor.packageName, "codepatchbay");
    assert.equal(jobs[0].executor.version, "0.2.0");

    // Enriched executor identity
    assert.equal(jobs[0].executor.codeVersion, "0.2.0");
    assert.equal(jobs[0].executor.releaseId, null);
    assert.ok(jobs[0].executor.stateFormatVersions);
    assert.equal(typeof jobs[0].executor.stateFormatVersions.queue, "number");
    assert.equal(typeof jobs[0].executor.stateFormatVersions.jobsEvents, "number");
    assert.equal(typeof jobs[0].executor.stateFormatVersions.leases, "number");
    assert.equal(typeof jobs[0].executor.stateFormatVersions.processRegistry, "number");
    assert.equal(typeof jobs[0].executor.stateFormatVersions.releaseMetadata, "number");

    await rm(cpbRoot, { recursive: true, force: true }).catch(() => {});
    await rm(sourcePath, { recursive: true, force: true }).catch(() => {});
  });
});
