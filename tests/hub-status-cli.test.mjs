import { execFile as execFileCb } from "node:child_process";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const repoRoot = path.resolve(import.meta.dirname, "..");

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("cpb hub status", () => {
  it("prints managed orchestrator and worker state instead of legacy project-worker counts", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-status-"));
    const hubRoot = path.join(tmpRoot, "hub");

    try {
      await writeJson(path.join(hubRoot, "projects.json"), {
        version: 1,
        updatedAt: new Date().toISOString(),
        projects: {
          alpha: { id: "alpha", sourcePath: tmpRoot, enabled: true },
          beta: { id: "beta", sourcePath: tmpRoot, enabled: true },
        },
      });
      await writeJson(path.join(hubRoot, "state", "hub.json"), {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        cpbRoot: tmpRoot,
        hubRoot,
        version: "test",
        runtime: "node",
        health: "alive",
      });
      await writeJson(path.join(hubRoot, "orchestrator", "leader.lock", "leader.json"), {
        hubId: "live-orchestrator",
        host: os.hostname(),
        pid: process.pid,
        epoch: 7,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await writeJson(path.join(hubRoot, "queue", "queue.json"), {
        version: 1,
        entries: [
          { id: "q-running", projectId: "alpha", status: "in_progress", metadata: {}, createdAt: new Date().toISOString() },
          { id: "q-pending", projectId: "beta", status: "pending", metadata: {}, createdAt: new Date().toISOString() },
        ],
      });
      for (const [workerId, status] of Object.entries({ ready: "ready", running: "running", unhealthy: "unhealthy", exited: "exited" })) {
        await writeJson(path.join(hubRoot, "workers", "registry", `worker-${workerId}.json`), {
          workerId,
          status,
          currentAssignmentId: status === "running" ? "a-q-running" : null,
          lastHeartbeatAt: new Date().toISOString(),
        });
      }

      const { stdout } = await execFile(process.execPath, [path.join(repoRoot, "cli", "cpb.mjs"), "hub", "status"], {
        cwd: tmpRoot,
        env: {
          ...process.env,
          CPB_ROOT: tmpRoot,
          CPB_EXECUTOR_ROOT: repoRoot,
          CPB_HUB_ROOT: hubRoot,
        },
      });

      assert.match(stdout, /Orchestrator: running .*epoch:7/);
      assert.match(stdout, /Queue: 2 entries .*running:1.*failed:0/);
      assert.match(stdout, /Workers: ready:1 running:1 unhealthy:1 exited:1/);
      assert.doesNotMatch(stdout, /Workers: 0 online, 0 stale, 2 offline/);

      const jsonResult = await execFile(process.execPath, [path.join(repoRoot, "cli", "cpb.mjs"), "hub", "status", "--json"], {
        cwd: tmpRoot,
        env: {
          ...process.env,
          CPB_ROOT: tmpRoot,
          CPB_EXECUTOR_ROOT: repoRoot,
          CPB_HUB_ROOT: hubRoot,
        },
      });
      const parsed = JSON.parse(jsonResult.stdout);
      assert.deepEqual(parsed.workers, { ready: 1, running: 1, unhealthy: 1, exited: 1 });
      assert.equal(Object.hasOwn(parsed, "legacyProjectWorkers"), false);
      assert.equal(Object.hasOwn(parsed, "workersOnline"), false);
      assert.equal(Object.hasOwn(parsed, "workersStale"), false);
      assert.equal(Object.hasOwn(parsed, "workersOffline"), false);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
