import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { listJobs } from "../server/services/job-store.js";
import { installRelease } from "../bridges/install-release.mjs";

const execFileAsync = promisify(execFile);

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

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
    env: {
      ...process.env,
      CPB_ROOT: cpbRoot,
      CPB_EXECUTOR_ROOT: executorRoot,
    },
  });

  const jobs = await listJobs(cpbRoot);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].executor.root, executorRoot);
  assert.equal(jobs[0].executor.packageName, "codepatchbay");
});

test("installRelease copies executor assets without project runtime state", async () => {
  const destRoot = await mkdtemp(path.join(tmpdir(), "cpb-release-dest-"));
  const manifest = await installRelease({
    sourceRoot: process.cwd(),
    destRoot,
    name: "test-release",
  });

  assert.equal(manifest.releaseId, "test-release");
  assert.equal(await pathExists(path.join(manifest.releaseRoot, "bridges", "run-pipeline.mjs")), true);
  assert.equal(await pathExists(path.join(manifest.releaseRoot, "server", "services", "executor-root.js")), true);
  assert.equal(await pathExists(path.join(manifest.releaseRoot, "wiki", "system")), true);
  assert.equal(await pathExists(path.join(manifest.releaseRoot, "wiki", "projects", "_template")), true);
  assert.equal(await pathExists(path.join(manifest.releaseRoot, "cpb-task")), false);
  assert.equal(await pathExists(path.join(manifest.releaseRoot, "wiki", "projects", "flow")), false);
});
