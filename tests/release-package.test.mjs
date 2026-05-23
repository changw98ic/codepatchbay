import { execFileSync } from "node:child_process";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cpbBin = path.join(repoRoot, "cpb");

const REQUIRED_ASSETS = ["cpb", "cli", "bridges", "core", "runtime", "server"];
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

test("release install creates a valid release package", async () => {
  const releaseName = `test-pkg-${Date.now()}`;
  const output = cpbRelease(["install", "--name", releaseName, "--json"]);
  const manifest = JSON.parse(output);

  assert.equal(manifest.releaseId, releaseName);
  assert.equal(manifest.codeVersion, "0.2.0");
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

  assert.equal(version, "cpb v0.2.0");

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
