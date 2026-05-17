import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const cpbRoot = path.resolve(import.meta.dirname, "..");

function envFor(hubRoot) {
  return { ...process.env, CPB_ROOT: cpbRoot, CPB_HUB_ROOT: hubRoot };
}

test("cpb hub queue returns empty list for new hub", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-q-"));
  const { stdout } = await execFileAsync("./cpb", ["hub", "queue", "--json"], {
    cwd: cpbRoot,
    env: envFor(hubRoot),
  });
  const entries = JSON.parse(stdout);
  assert.deepEqual(entries, []);
});

test("cpb hub queue-status returns zero counts for new hub", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-qs-"));
  const { stdout } = await execFileAsync("./cpb", ["hub", "queue-status", "--json"], {
    cwd: cpbRoot,
    env: envFor(hubRoot),
  });
  const status = JSON.parse(stdout);
  assert.equal(status.total, 0);
  assert.equal(status.pending, 0);
});

test("cpb hub queue shows entries after programmatic enqueue", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cli-qe-"));
  const { enqueue } = await import("../server/services/hub-queue.js");
  await enqueue(hubRoot, { projectId: "test-proj", sourcePath: "/tmp/x", description: "fix bug", priority: "P0" });

  const { stdout } = await execFileAsync("./cpb", ["hub", "queue", "--json"], {
    cwd: cpbRoot,
    env: envFor(hubRoot),
  });
  const entries = JSON.parse(stdout);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].projectId, "test-proj");
  assert.equal(entries[0].description, "fix bug");
  assert.equal(entries[0].priority, "P0");

  const { stdout: statusOut } = await execFileAsync("./cpb", ["hub", "queue-status", "--json"], {
    cwd: cpbRoot,
    env: envFor(hubRoot),
  });
  const status = JSON.parse(statusOut);
  assert.equal(status.total, 1);
  assert.equal(status.pending, 1);
});
