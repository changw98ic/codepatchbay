import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, rm, stat, mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cpbBin = path.join(repoRoot, "cpb");

const REQUIRED_ASSETS = ["cpb", "cli", "bridges", "core", "runtime", "server", "skills"];
const FORBIDDEN_ASSETS = [
  "node_modules", ".git", "cpb-task", ".omx", ".omc", "omx_wiki", "providers",
];

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

const nodeBin = process.execPath;

function cpbRelease(args) {
  return execFileSync(nodeBin, [cpbBin, "release", ...args], {
    encoding: "utf8",
    env: { ...process.env, CPB_ROOT: repoRoot },
    timeout: 15000,
  });
}

// --- D43: npm pack smoke tests ---

function resolveNpmInvoker() {
  const bundledCli = path.resolve(process.execPath, "..", "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const npmExecPath = process.env.npm_execpath || "";
  for (const candidate of [npmExecPath, bundledCli]) {
    if (!candidate || !existsSync(candidate)) continue;
    return candidate.endsWith(".js")
      ? { command: nodeBin, argsPrefix: [candidate] }
      : { command: candidate, argsPrefix: [] };
  }
  return { command: process.platform === "win32" ? "npm.cmd" : "npm", argsPrefix: [] };
}

const npmInvoker = resolveNpmInvoker();

function runNpm(args, opts) {
  return execFileSync(npmInvoker.command, [...npmInvoker.argsPrefix, ...args], {
    encoding: "utf8",
    timeout: 30000,
    ...opts,
  });
}

async function npmPackAndExtract() {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-pack-"));
  const output = runNpm(["pack", "--json", "--pack-destination", tmpDir], { cwd: repoRoot });
  const [packed] = JSON.parse(output);
  const tarballPath = path.join(tmpDir, path.basename(packed.filename));
  assert.ok(await exists(tarballPath), `tarball not found: ${tarballPath}`);

  const extractDir = path.join(tmpDir, "extracted");
  await mkdir(extractDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarballPath, "-C", extractDir], { timeout: 15000 });

  const packageDir = path.join(extractDir, "package");
  assert.ok(await exists(packageDir), "tarball must contain package/ root");
  return { tmpDir, extractDir, packageDir, packed };
}

const PACK_REQUIRED_FILES = [
  "core/setup/agent-catalog.js",
  "core/setup/detect.js",
  "core/setup/install-plan.js",
  "core/setup/manifest-schema.js",
  "core/setup/health-check.js",
  "core/setup/wizard.js",
  "core/setup/manifests/codex.json",
  "cli/commands/setup.js",
  "cli/commands/agents.js",
  "cli/commands/demo.js",
  "skills/codepatchbay/SKILL.md",
  "skills/codepatchbay/agents/openai.yaml",
  "web/dist/index.html",
  "README.md",
  "docs/demo.md",
];

test("npm pack install smoke can run cpb setup --json from extracted package", async () => {
  const packed = await npmPackAndExtract();
  try {
    const output = execFileSync(nodeBin, [path.join(packed.packageDir, "cpb"), "setup", "--json"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CPB_ROOT: packed.packageDir,
        CPB_EXECUTOR_ROOT: packed.packageDir,
      },
      timeout: 15000,
    });
    const json = JSON.parse(output);
    assert.ok(json.detected?.system, "setup --json must return system info");
    assert.ok(json.detected?.agents?.codex, "setup --json must include known agent readiness");
    assert.ok(json.profile, "setup --json must return setup profile data");
    assert.equal(json.executed, false, "setup --json alone must not silently install");
  } finally {
    await rm(packed.tmpDir, { recursive: true, force: true });
  }
});

test("npm pack includes quickstart runtime and docs", async () => {
  const packed = await npmPackAndExtract();
  try {
    for (const rel of PACK_REQUIRED_FILES) {
      const full = path.join(packed.packageDir, rel);
      assert.ok(await exists(full), `missing in packed tarball: ${rel}`);
    }
    assert.ok(
      packed.packed.files.some((file) => file.path.startsWith("core/setup/")),
      "npm pack file list must include core/setup/",
    );
  } finally {
    await rm(packed.tmpDir, { recursive: true, force: true });
  }
});

// --- Existing tests below (unchanged) ---

test("release install creates a valid release package", async () => {
  const releaseName = `test-pkg-${Date.now()}`;
  const output = cpbRelease(["install", "--name", releaseName, "--json"]);
  const manifest = JSON.parse(output);

  assert.equal(manifest.releaseId, releaseName);
  assert.equal(manifest.codeVersion, "0.2.1");
  assert.ok(await exists(manifest.installedPath));

  const entries = await readdir(manifest.installedPath);
  for (const name of REQUIRED_ASSETS) {
    assert.ok(entries.includes(name), `missing required asset: ${name}`);
  }
  for (const name of FORBIDDEN_ASSETS) {
    assert.ok(!entries.includes(name), `forbidden asset present: ${name}`);
  }

  const runtimeEntries = await readdir(path.join(manifest.installedPath, "runtime"));
  assert.ok(!runtimeEntries.includes("target"), "runtime/target should be excluded");

  const manifestFile = path.join(manifest.installedPath, "release", "manifest.json");
  const manifestData = JSON.parse(await readFile(manifestFile, "utf8"));
  assert.equal(manifestData.releaseId, releaseName);

  await rm(manifest.installedPath, { recursive: true, force: true });
});

test("installed release runs cpb version", async () => {
  const releaseName = `test-ver-${Date.now()}`;
  const output = cpbRelease(["install", "--name", releaseName, "--json"]);
  const manifest = JSON.parse(output);

  const version = execFileSync(nodeBin, [
    path.join(manifest.installedPath, "cli", "cpb.mjs"), "version",
  ], {
    encoding: "utf8",
    env: { CPB_EXECUTOR_ROOT: manifest.installedPath, CPB_ROOT: repoRoot },
    timeout: 5000,
  }).trim();

  assert.equal(version, "cpb v0.2.1");

  await rm(manifest.installedPath, { recursive: true, force: true });
});

test("release gc dry-run returns valid plan", async () => {
  const output = cpbRelease(["gc", "--dry-run", "--json"]);
  const result = JSON.parse(output);
  assert.equal(result.dryRun, true);
  assert.ok(result.plan);
  assert.ok(result.plan.releaseStoreRoot);
});

test("release install subcommand is routed", async () => {
  const output = cpbRelease(["install", "--help"]);
  assert.ok(output.includes("--name"), "install help should mention --name");
  assert.ok(output.includes("--dest-root"), "install help should mention --dest-root");
});

test("direct cpb.mjs returns non-zero for unknown command", async () => {
  let threw = false;
  try {
    execFileSync(nodeBin, [path.join(repoRoot, "cli", "cpb.mjs"), "definitely-not-a-command"], {
      encoding: "utf8",
      timeout: 5000,
    });
  } catch (err) {
    threw = true;
    assert.ok(err.status !== 0, "should exit non-zero");
  }
  assert.ok(threw, "unknown command must fail");
});
