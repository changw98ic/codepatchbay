import assert from "node:assert/strict";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { describe, beforeEach, afterEach } from "node:test";

import { installBin, renderLauncher, resolveInstallBinExecutorRoot, shellQuoteSingle } from "../../server/services/install-bin.js";
import { installRelease } from "../../server/services/release-store.js";

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
    "runtime/evolve", "runtime/worker",
  ];
  for (const dir of dirs) await mkdir(path.join(root, dir), { recursive: true });

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
  await chmod(path.join(root, "cpb"), 0o755);
}

describe("renderLauncher", () => {
  test("renders a valid shell script with pinned executor root", () => {
    const script = renderLauncher({
      executorRoot: "/opt/cpb/releases/v1",
      runtimeRootDefault: "${CPB_HOME:-$HOME/.cpb}",
    });
    assert.ok(script.startsWith("#!/bin/sh"));
    assert.ok(script.includes("set -eu"));
    assert.ok(script.includes(`CPB_EXECUTOR_ROOT=${shellQuoteSingle("/opt/cpb/releases/v1")}`));
    assert.ok(script.includes("CPB_ROOT"));
    assert.ok(script.includes("${CPB_HOME:-$HOME/.cpb}"));
    assert.ok(script.includes('exec "${CPB_EXECUTOR_ROOT}/cpb" "$@"'));
    assert.ok(script.includes("[ ! -x"));
  });

  test("escapes single quotes in executor root path", () => {
    const script = renderLauncher({
      executorRoot: "/path/with'quote",
      runtimeRootDefault: "${CPB_HOME:-$HOME/.cpb}",
    });
    assert.ok(script.includes("CPB_EXECUTOR_ROOT='/path/with'\\''quote'"));
  });

  test("safely quotes paths containing double quotes", () => {
    const script = renderLauncher({
      executorRoot: '/path/with"double',
      runtimeRootDefault: "${CPB_HOME:-$HOME/.cpb}",
    });
    assert.ok(script.includes(`CPB_EXECUTOR_ROOT=${shellQuoteSingle('/path/with"double')}`));
    assert.ok(!script.includes(`CPB_EXECUTOR_ROOT="/path/with"double"`));
  });

  test("safely quotes paths containing dollar signs", () => {
    const script = renderLauncher({
      executorRoot: "/path/with$dollar",
      runtimeRootDefault: "${CPB_HOME:-$HOME/.cpb}",
    });
    assert.ok(script.includes(`CPB_EXECUTOR_ROOT=${shellQuoteSingle("/path/with$dollar")}`));
    assert.ok(!script.includes('CPB_EXECUTOR_ROOT="/path/with$dollar"'));
  });

  test("safely quotes paths containing backticks", () => {
    const script = renderLauncher({
      executorRoot: "/path/with`backtick",
      runtimeRootDefault: "${CPB_HOME:-$HOME/.cpb}",
    });
    assert.ok(script.includes(`CPB_EXECUTOR_ROOT=${shellQuoteSingle("/path/with`backtick")}`));
  });

  test("safely quotes paths containing backslashes", () => {
    const script = renderLauncher({
      executorRoot: "/path/with\\backslash",
      runtimeRootDefault: "${CPB_HOME:-$HOME/.cpb}",
    });
    assert.ok(script.includes(`CPB_EXECUTOR_ROOT=${shellQuoteSingle("/path/with\\backslash")}`));
  });
});

describe("resolveInstallBinExecutorRoot", () => {
  test("validates explicit executor root", async () => {
    const root = await resolveInstallBinExecutorRoot({
      executorRootOption: CPB_ROOT,
      scriptRoot: CPB_ROOT,
      env: process.env,
    });
    assert.equal(root, path.resolve(CPB_ROOT));
  });

  test("rejects invalid explicit executor root", async () => {
    await assert.rejects(
      () => resolveInstallBinExecutorRoot({
        executorRootOption: "/nonexistent/path",
        scriptRoot: CPB_ROOT,
        env: process.env,
      }),
    );
  });

  test("falls back to CPB_EXECUTOR_ROOT env when no option given", async () => {
    const root = await resolveInstallBinExecutorRoot({
      executorRootOption: null,
      scriptRoot: "/unused",
      env: { CPB_EXECUTOR_ROOT: CPB_ROOT },
    });
    assert.equal(root, path.resolve(CPB_ROOT));
  });

  test("falls back to script root when no env and no option", async () => {
    const root = await resolveInstallBinExecutorRoot({
      executorRootOption: null,
      scriptRoot: CPB_ROOT,
      env: {},
    });
    assert.equal(root, path.resolve(CPB_ROOT));
  });

  test("--executor-root current fails when no current selector", async () => {
    const cpbHome = await mkdtemp(path.join(tmpdir(), "cpb-no-current-"));
    try {
      await assert.rejects(
        () => resolveInstallBinExecutorRoot({
          executorRootOption: "current",
          scriptRoot: CPB_ROOT,
          env: { CPB_HOME: cpbHome },
        }),
        { message: /No current CPB release selected/ },
      );
    } finally {
      await rm(cpbHome, { recursive: true, force: true });
    }
  });

  test("--executor-root current resolves via CPB_HOME/current symlink", async () => {
    const cpbHome = await mkdtemp(path.join(tmpdir(), "cpb-current-"));
    const releaseDir = await mkdtemp(path.join(tmpdir(), "cpb-current-release-"));
    try {
      await buildFixtureSource(releaseDir);
      await symlink(releaseDir, path.join(cpbHome, "current"));

      const root = await resolveInstallBinExecutorRoot({
        executorRootOption: "current",
        scriptRoot: CPB_ROOT,
        env: { CPB_HOME: cpbHome },
      });
      assert.equal(root, path.resolve(await import("node:fs/promises").then(m => m.realpath(releaseDir))));
    } finally {
      await rm(cpbHome, { recursive: true, force: true });
      await rm(releaseDir, { recursive: true, force: true });
    }
  });
});

describe("installBin service", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "cpb-install-bin-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("writes executable launcher to target path", async () => {
    const target = path.join(tmpDir, "bin", "cpb");
    await mkdir(path.dirname(target), { recursive: true });

    const metadata = await installBin({
      target,
      executorRoot: CPB_ROOT,
    });

    assert.equal(metadata.target, path.resolve(target));
    assert.equal(metadata.executorRoot, path.resolve(CPB_ROOT));
    assert.equal(metadata.launcherVersion, 1);
    assert.ok(await pathExists(target));

    const content = await readFile(target, "utf8");
    assert.ok(content.startsWith("#!/bin/sh"));
    assert.ok(content.includes(`CPB_EXECUTOR_ROOT=${shellQuoteSingle(path.resolve(CPB_ROOT))}`));
  });

  test("launcher is not a symlink", async () => {
    const target = path.join(tmpDir, "bin", "cpb");
    await mkdir(path.dirname(target), { recursive: true });

    await installBin({ target, executorRoot: CPB_ROOT });

    const info = await lstat(target);
    assert.equal(info.isSymbolicLink(), false);
  });

  test("fails cleanly when executor root is invalid", async () => {
    const target = path.join(tmpDir, "bin", "cpb");
    await mkdir(path.dirname(target), { recursive: true });

    await assert.rejects(
      () => installBin({ target, executorRoot: "/nonexistent/path" }),
    );
    assert.equal(await pathExists(target), false);
  });
});

describe("cpb install-bin CLI", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "cpb-cli-install-bin-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("cpb install-bin --target <path> --executor-root <repo> --json", async () => {
    const target = path.join(tmpDir, "bin", "cpb");
    await mkdir(path.dirname(target), { recursive: true });

    const { stdout } = await execFileAsync(CPB_BIN, [
      "install-bin",
      "--target", target,
      "--executor-root", CPB_ROOT,
      "--json",
    ], {
      env: { ...process.env, CPB_ROOT, CPB_EXECUTOR_ROOT: CPB_ROOT },
    });

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.executorRoot, path.resolve(CPB_ROOT));
    assert.equal(parsed.launcherVersion, 1);
    assert.ok(parsed.target);

    const content = await readFile(target, "utf8");
    assert.ok(content.includes(`CPB_EXECUTOR_ROOT=${shellQuoteSingle(path.resolve(CPB_ROOT))}`));
  });

  test("installed launcher runs version --json from outside checkout", async () => {
    const target = path.join(tmpDir, "bin", "cpb");
    const runtimeRoot = path.join(tmpDir, "runtime");
    await mkdir(path.dirname(target), { recursive: true });
    await mkdir(runtimeRoot, { recursive: true });

    await execFileAsync(CPB_BIN, [
      "install-bin",
      "--target", target,
      "--executor-root", CPB_ROOT,
      "--json",
    ], {
      env: { ...process.env, CPB_ROOT, CPB_EXECUTOR_ROOT: CPB_ROOT },
    });

    const { stdout } = await execFileAsync(target, ["version", "--json"], {
      env: {
        ...process.env,
        CPB_ROOT: runtimeRoot,
        CPB_EXECUTOR_ROOT: undefined,
      },
      cwd: tmpDir,
    });

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.CPB_ROOT, path.resolve(runtimeRoot));
    assert.equal(parsed.CPB_EXECUTOR_ROOT, path.resolve(CPB_ROOT));
    assert.notEqual(parsed.CPB_ROOT, parsed.CPB_EXECUTOR_ROOT);
  });

  test("launcher pinned to installed release reports correct executor root", async () => {
    const releaseStore = await mkdtemp(path.join(tmpdir(), "cpb-release-store-"));
    try {
      // Install a release
      const { stdout: releaseStdout } = await execFileAsync(CPB_BIN, [
        "release", "install",
        "--name", "launcher-release",
        "--dest-root", releaseStore,
        "--json",
      ], {
        env: { ...process.env, CPB_ROOT, CPB_EXECUTOR_ROOT: CPB_ROOT },
      });
      const releaseMeta = JSON.parse(releaseStdout);
      const releaseRoot = releaseMeta.installedPath;

      const target = path.join(tmpDir, "bin", "cpb");
      const runtimeRoot = path.join(tmpDir, "runtime");
      await mkdir(path.dirname(target), { recursive: true });
      await mkdir(runtimeRoot, { recursive: true });

      await execFileAsync(CPB_BIN, [
        "install-bin",
        "--target", target,
        "--executor-root", releaseRoot,
        "--json",
      ], {
        env: { ...process.env, CPB_ROOT, CPB_EXECUTOR_ROOT: CPB_ROOT },
      });

      const { stdout } = await execFileAsync(target, ["version", "--json"], {
        env: {
          ...process.env,
          CPB_ROOT: runtimeRoot,
          CPB_EXECUTOR_ROOT: undefined,
        },
        cwd: tmpDir,
      });

      const parsed = JSON.parse(stdout);
      assert.equal(parsed.CPB_ROOT, path.resolve(runtimeRoot));
      assert.equal(parsed.CPB_EXECUTOR_ROOT, path.resolve(releaseRoot));
      assert.equal(parsed.activeAppReleaseId, "launcher-release");
    } finally {
      await rm(releaseStore, { recursive: true, force: true });
    }
  });

  test("--executor-root current with no selector exits non-zero without creating target", async () => {
    const cpbHome = await mkdtemp(path.join(tmpdir(), "cpb-empty-home-"));
    const target = path.join(tmpDir, "bin", "cpb");
    await mkdir(path.dirname(target), { recursive: true });

    try {
      await assert.rejects(
        () => execFileAsync(CPB_BIN, [
          "install-bin",
          "--target", target,
          "--executor-root", "current",
          "--json",
        ], {
          env: {
            ...process.env,
            CPB_ROOT,
            CPB_EXECUTOR_ROOT: CPB_ROOT,
            CPB_HOME: cpbHome,
          },
        }),
        /No current CPB release selected/,
      );
      assert.equal(await pathExists(target), false);
    } finally {
      await rm(cpbHome, { recursive: true, force: true });
    }
  });

  test("local-checkout fallback works when no --executor-root given", async () => {
    const target = path.join(tmpDir, "bin", "cpb");
    const runtimeRoot = path.join(tmpDir, "runtime");
    await mkdir(path.dirname(target), { recursive: true });
    await mkdir(runtimeRoot, { recursive: true });

    const { stdout } = await execFileAsync(CPB_BIN, [
      "install-bin",
      "--target", target,
      "--json",
    ], {
      env: { ...process.env, CPB_ROOT, CPB_EXECUTOR_ROOT: CPB_ROOT },
    });

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.executorRoot, path.resolve(CPB_ROOT));

    const { stdout: versionOut } = await execFileAsync(target, ["version", "--json"], {
      env: {
        ...process.env,
        CPB_ROOT: runtimeRoot,
        CPB_EXECUTOR_ROOT: undefined,
      },
      cwd: tmpDir,
    });

    const versionParsed = JSON.parse(versionOut);
    assert.equal(versionParsed.CPB_ROOT, path.resolve(runtimeRoot));
    assert.equal(versionParsed.CPB_EXECUTOR_ROOT, path.resolve(CPB_ROOT));
    assert.notEqual(versionParsed.CPB_ROOT, versionParsed.CPB_EXECUTOR_ROOT);
  });

  test("--bin-dir installs as DIR/cpb", async () => {
    const binDir = path.join(tmpDir, "my-bin");
    await mkdir(binDir, { recursive: true });

    const { stdout } = await execFileAsync(CPB_BIN, [
      "install-bin",
      "--bin-dir", binDir,
      "--executor-root", CPB_ROOT,
      "--json",
    ], {
      env: { ...process.env, CPB_ROOT, CPB_EXECUTOR_ROOT: CPB_ROOT },
    });

    const parsed = JSON.parse(stdout);
    assert.equal(parsed.target, path.join(binDir, "cpb"));
    assert.ok(await pathExists(path.join(binDir, "cpb")));
  });
});

describe("legacy cpb install delegates to install-bin", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "cpb-legacy-install-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("cpb install --target <path> writes a generated launcher, not a symlink", async () => {
    const target = path.join(tmpDir, "bin", "cpb");
    await mkdir(path.dirname(target), { recursive: true });

    await execFileAsync(CPB_BIN, [
      "install",
      "--target", target,
    ], {
      env: { ...process.env, CPB_ROOT, CPB_EXECUTOR_ROOT: CPB_ROOT },
    });

    assert.ok(await pathExists(target));
    const info = await lstat(target);
    assert.equal(info.isSymbolicLink(), false, "legacy install should produce a generated launcher, not a symlink");

    const content = await readFile(target, "utf8");
    assert.ok(content.startsWith("#!/bin/sh"));
    assert.ok(content.includes("CPB_EXECUTOR_ROOT"));
  });
});
