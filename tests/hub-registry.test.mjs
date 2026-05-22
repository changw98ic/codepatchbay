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

test("registerProject defaults projectRuntimeRoot under the given hubRoot", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hub-rt-"));
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-project-rt-"));

  const project = await registerProject(hubRoot, { name: "rt-test", sourcePath });

  assert.ok(
    project.projectRuntimeRoot.startsWith(path.resolve(hubRoot) + path.sep),
    `projectRuntimeRoot ${project.projectRuntimeRoot} should be under hubRoot ${hubRoot}`
  );
  assert.ok(
    project.projectRuntimeRoot.includes("projects"),
    `projectRuntimeRoot should contain "projects" segment`
  );
});

test("registerProject preserves explicit projectRuntimeRoot", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hub-explicit-"));
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-project-explicit-"));
  const explicitRoot = path.join(hubRoot, "custom-runtime");

  const project = await registerProject(hubRoot, {
    name: "explicit-rt",
    sourcePath,
    projectRuntimeRoot: explicitRoot,
  });

  assert.equal(project.projectRuntimeRoot, path.resolve(explicitRoot));
});

test("registerProject preserves metadata for test/generated tagging", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hub-meta-"));
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-project-meta-"));

  const project = await registerProject(hubRoot, {
    name: "meta-test",
    sourcePath,
    metadata: { visibility: "test", generatedBy: "node:test" },
  });

  assert.equal(project.metadata.visibility, "test");
  assert.equal(project.metadata.generatedBy, "node:test");
});
