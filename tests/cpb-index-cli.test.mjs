#!/usr/bin/env node
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function envFor(hubRoot) {
  return { ...process.env, CPB_HUB_ROOT: hubRoot, CPB_EXECUTOR_ROOT: process.cwd() };
}

async function makeMiniRepo(root) {
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "cli-test-project",
    scripts: { test: "node --test", build: "echo build" },
  }, null, 2));
  await writeFile(path.join(root, "src", "index.js"), "export function main() {}\n");
}

test("cpb index status reports missing before refresh", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-idx-cli-hub-"));
  const repoRoot = await mkdtemp(path.join(tmpdir(), "cpb-idx-cli-repo-"));
  await makeMiniRepo(repoRoot);

  await execFileAsync("./cpb", ["attach", repoRoot, "cli-idx"], {
    cwd: process.cwd(),
    env: envFor(hubRoot),
  });

  const { stdout } = await execFileAsync("./cpb", ["index", "status", "cli-idx", "--json"], {
    cwd: process.cwd(),
    env: envFor(hubRoot),
  });
  const status = JSON.parse(stdout);
  assert.equal(status.status, "missing");

  await rm(hubRoot, { recursive: true, force: true });
  await rm(repoRoot, { recursive: true, force: true });
});

test("cpb index refresh writes artifacts and status reports ready", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-idx-cli-hub2-"));
  const repoRoot = await mkdtemp(path.join(tmpdir(), "cpb-idx-cli-repo2-"));
  await makeMiniRepo(repoRoot);

  await execFileAsync("./cpb", ["attach", repoRoot, "cli-idx2"], {
    cwd: process.cwd(),
    env: envFor(hubRoot),
  });

  const { stdout: refreshOut } = await execFileAsync("./cpb", ["index", "refresh", "cli-idx2", "--json"], {
    cwd: process.cwd(),
    env: envFor(hubRoot),
  });
  const refresh = JSON.parse(refreshOut);
  assert.equal(refresh.status, "ready");
  assert.ok(refresh.fileCount > 0);
  assert.ok(refresh.contentHash);

  const { stdout: statusOut } = await execFileAsync("./cpb", ["index", "status", "cli-idx2", "--json"], {
    cwd: process.cwd(),
    env: envFor(hubRoot),
  });
  const status = JSON.parse(statusOut);
  assert.equal(status.status, "ready");
  assert.ok(status.fileCount > 0);
  assert.ok(status.symbolCount >= 0);
  assert.ok(status.commandCount >= 0);

  await rm(hubRoot, { recursive: true, force: true });
  await rm(repoRoot, { recursive: true, force: true });
});

// --- Temp CPB_HUB_ROOT artifact placement (issue #28 acceptance) ---

test("cpb index refresh writes artifacts under CPB_HUB_ROOT/projects/<id>/index", async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "cpb-idx-cli-hubroot-"));
  const projectDir = path.join(tmpDir, "project");
  const hubDir = path.join(tmpDir, "hub");
  await mkdir(path.join(projectDir, "src"), { recursive: true });
  await writeFile(path.join(projectDir, "package.json"), JSON.stringify({
    name: "hubroot-test",
    scripts: { test: "node --test" },
  }, null, 2));
  await writeFile(path.join(projectDir, "src", "index.js"), "export function main() { return 1; }\n");

  const projectId = "hubroot-proj";
  const expectedIndexDir = path.join(hubDir, "projects", projectId, "index");

  await execFileAsync("./cpb", ["attach", projectDir, projectId], {
    cwd: process.cwd(),
    env: envFor(hubDir),
  });

  const { stdout: refreshOut } = await execFileAsync("./cpb", ["index", "refresh", projectId, "--json"], {
    cwd: process.cwd(),
    env: envFor(hubDir),
  });
  const refresh = JSON.parse(refreshOut);
  assert.equal(refresh.status, "ready");

  // Assert artifacts exist under hubDir/projects/<id>/index
  const manifest = JSON.parse(await readFile(path.join(expectedIndexDir, "manifest.json"), "utf8"));
  assert.equal(manifest.projectId, projectId);
  assert.equal(manifest.indexRoot, expectedIndexDir);

  await readFile(path.join(expectedIndexDir, "files.json"), "utf8");
  await readFile(path.join(expectedIndexDir, "symbols.json"), "utf8");
  await readFile(path.join(expectedIndexDir, "commands.json"), "utf8");
  await readFile(path.join(expectedIndexDir, "summary.md"), "utf8");

  // Assert manifest.indexRoot equals the expected index directory
  assert.equal(manifest.indexRoot, expectedIndexDir, "manifest.indexRoot matches CPB_HUB_ROOT location");

  await rm(tmpDir, { recursive: true, force: true });
});
