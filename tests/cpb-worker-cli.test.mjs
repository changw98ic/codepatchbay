import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

function envFor(hubRoot) {
  return { ...process.env, CPB_HUB_ROOT: hubRoot };
}

test("cpb worker heartbeat records project worker state in Hub registry", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-worker-hub-"));
  const projectRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-worker-project-"));
  const canonicalProjectRoot = await realpath(projectRoot);

  const { stdout } = await execFileAsync("./cpb", ["worker", "heartbeat", projectRoot, "worker-project"], {
    cwd: process.cwd(),
    env: envFor(hubRoot),
  });
  const heartbeat = JSON.parse(stdout);

  assert.equal(heartbeat.heartbeat, true);
  assert.equal(heartbeat.project.id, "worker-project");
  assert.equal(heartbeat.project.sourcePath, canonicalProjectRoot);
  assert.equal(heartbeat.project.worker.status, "online");
  assert.deepEqual(heartbeat.project.worker.capabilities, ["scan", "execute"]);

  const projects = JSON.parse((await execFileAsync("./cpb", ["hub", "projects", "--json"], {
    cwd: process.cwd(),
    env: envFor(hubRoot),
  })).stdout);

  assert.equal(projects[0].worker.status, "online");
});
