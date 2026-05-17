import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  heartbeatWorker,
  hubStatus,
  listProjects,
  registerProject,
  workerStatus,
} from "../server/services/hub-registry.js";

const DEFAULT_TTL = 120_000; // 120s matches lease TTL

function makeHub() {
  return mkdtemp(path.join(tmpdir(), "cpb-worker-ttl-"));
}

async function makeProject() {
  const dir = await mkdtemp(path.join(tmpdir(), "cpb-worker-ttl-proj-"));
  return realpath(dir);
}

test("workerStatus returns offline for project with no worker data", async () => {
  const hubRoot = await makeHub();
  const sourcePath = await makeProject();
  const project = await registerProject(hubRoot, { name: "no-worker", sourcePath });

  const status = workerStatus(project);

  assert.equal(status, "offline");
});

test("workerStatus returns online for project with recent heartbeat", async () => {
  const hubRoot = await makeHub();
  const sourcePath = await makeProject();
  const project = await registerProject(hubRoot, { name: "fresh-worker", sourcePath });
  await heartbeatWorker(hubRoot, project.id, { workerId: "w1", capabilities: ["scan"] });

  const updated = (await listProjects(hubRoot))[0];
  const status = workerStatus(updated);

  assert.equal(status, "online");
});

test("workerStatus returns stale when lastSeenAt exceeds TTL", async () => {
  const hubRoot = await makeHub();
  const sourcePath = await makeProject();
  const project = await registerProject(hubRoot, { name: "stale-worker", sourcePath });

  // Inject a heartbeat with old lastSeenAt by manually updating
  const updated = await heartbeatWorker(hubRoot, project.id, { workerId: "w-stale" });
  // Now patch lastSeenAt to 200s ago (beyond 120s TTL)
  const registry = await import("../server/services/hub-registry.js");
  const reg = await registry.loadRegistry(hubRoot);
  reg.projects[project.id].worker.lastSeenAt = new Date(Date.now() - 200_000).toISOString();
  await registry.saveRegistry(hubRoot, reg);

  const reloaded = (await listProjects(hubRoot))[0];
  const status = workerStatus(reloaded, DEFAULT_TTL);

  assert.equal(status, "stale");
});

test("workerStatus accepts custom TTL", async () => {
  const hubRoot = await makeHub();
  const sourcePath = await makeProject();
  const project = await registerProject(hubRoot, { name: "custom-ttl", sourcePath });
  await heartbeatWorker(hubRoot, project.id, { workerId: "w-custom" });

  // Make lastSeenAt 5s ago
  const registry = await import("../server/services/hub-registry.js");
  const reg = await registry.loadRegistry(hubRoot);
  reg.projects[project.id].worker.lastSeenAt = new Date(Date.now() - 5_000).toISOString();
  await registry.saveRegistry(hubRoot, reg);

  const reloaded = (await listProjects(hubRoot))[0];

  // With 10s TTL, still online
  assert.equal(workerStatus(reloaded, 10_000), "online");
  // With 1s TTL, stale
  assert.equal(workerStatus(reloaded, 1_000), "stale");
});

test("worker reconnect restores online status after being stale", async () => {
  const hubRoot = await makeHub();
  const sourcePath = await makeProject();
  const project = await registerProject(hubRoot, { name: "reconnect", sourcePath });

  // First heartbeat
  await heartbeatWorker(hubRoot, project.id, { workerId: "w-reconn" });

  // Make it stale
  const registry = await import("../server/services/hub-registry.js");
  const reg = await registry.loadRegistry(hubRoot);
  reg.projects[project.id].worker.lastSeenAt = new Date(Date.now() - 200_000).toISOString();
  await registry.saveRegistry(hubRoot, reg);

  let reloaded = (await listProjects(hubRoot))[0];
  assert.equal(workerStatus(reloaded, DEFAULT_TTL), "stale");

  // Reconnect: send fresh heartbeat
  await heartbeatWorker(hubRoot, project.id, { workerId: "w-reconn" });

  reloaded = (await listProjects(hubRoot))[0];
  assert.equal(workerStatus(reloaded, DEFAULT_TTL), "online");
  // sourcePath must survive reconnect
  assert.equal(reloaded.sourcePath, await realpath(sourcePath));
});

test("hubStatus reports online/stale/offline worker counts", async () => {
  const hubRoot = await makeHub();
  const src1 = await makeProject();
  const src2 = await makeProject();
  const src3 = await makeProject();

  // Project 1: online worker
  const p1 = await registerProject(hubRoot, { name: "online-proj", sourcePath: src1 });
  await heartbeatWorker(hubRoot, p1.id, { workerId: "w1" });

  // Project 2: stale worker
  const p2 = await registerProject(hubRoot, { name: "stale-proj", sourcePath: src2 });
  await heartbeatWorker(hubRoot, p2.id, { workerId: "w2" });
  const registry = await import("../server/services/hub-registry.js");
  const reg = await registry.loadRegistry(hubRoot);
  reg.projects[p2.id].worker.lastSeenAt = new Date(Date.now() - 200_000).toISOString();
  await registry.saveRegistry(hubRoot, reg);

  // Project 3: no worker at all
  await registerProject(hubRoot, { name: "offline-proj", sourcePath: src3 });

  const status = await hubStatus(hubRoot, { workerTtl: DEFAULT_TTL });

  assert.equal(status.projectCount, 3);
  assert.equal(status.workersOnline, 1);
  assert.equal(status.workersStale, 1);
  assert.equal(status.workersOffline, 1);
});

test("heartbeatWorker preserves sourcePath and project id across multiple heartbeats", async () => {
  const hubRoot = await makeHub();
  const sourcePath = await makeProject();
  const canonical = await realpath(sourcePath);
  const project = await registerProject(hubRoot, { name: "idempotent", sourcePath });

  for (let i = 0; i < 5; i++) {
    const updated = await heartbeatWorker(hubRoot, project.id, {
      workerId: "w-stable",
      capabilities: ["scan", "execute"],
    });
    assert.equal(updated.id, project.id);
    assert.equal(updated.sourcePath, canonical);
  }

  const list = await listProjects(hubRoot);
  assert.equal(list.length, 1);
  assert.equal(list[0].sourcePath, canonical);
});
