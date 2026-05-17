import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  heartbeatWorker,
  listProjects,
  registerProject,
} from "../server/services/hub-registry.js";

test("hub registry attaches projects idempotently by canonical sourcePath", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hub-"));
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-project-"));
  const canonical = await realpath(sourcePath);

  const first = await registerProject(hubRoot, { name: "Calc Test", sourcePath });
  const second = await registerProject(hubRoot, { name: "renamed", sourcePath, weight: 2 });
  const projects = await listProjects(hubRoot);

  assert.equal(first.id, second.id);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].sourcePath, canonical);
  assert.equal(projects[0].weight, 2);
});

test("hub registry records worker heartbeat without changing sourcePath", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hub-heartbeat-"));
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-project-heartbeat-"));
  const canonical = await realpath(sourcePath);
  const project = await registerProject(hubRoot, { name: "worker-demo", sourcePath });

  const updated = await heartbeatWorker(hubRoot, project.id, {
    workerId: "worker-1",
    pid: 123,
    capabilities: ["scan", "execute"],
  });

  assert.equal(updated.sourcePath, canonical);
  assert.equal(updated.worker.workerId, "worker-1");
  assert.deepEqual(updated.worker.capabilities, ["scan", "execute"]);
});

test("hub registry preserves concurrent project registrations", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hub-concurrent-"));
  const sourceA = await mkdtemp(path.join(tmpdir(), "cpb-project-concurrent-a-"));
  const sourceB = await mkdtemp(path.join(tmpdir(), "cpb-project-concurrent-b-"));

  await Promise.all([
    registerProject(hubRoot, { name: "concurrent-a", sourcePath: sourceA }),
    registerProject(hubRoot, { name: "concurrent-b", sourcePath: sourceB }),
  ]);

  const projects = await listProjects(hubRoot);
  assert.deepEqual(projects.map((project) => project.id), ["concurrent-a", "concurrent-b"]);
});
