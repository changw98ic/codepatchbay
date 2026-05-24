import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("runtime context lists legacy and registered project data roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-runtime-context-"));
  const hubRoot = path.join(root, ".hub");
  const projectRuntimeRoot = path.join(root, ".hub", "projects", "demo");

  await mkdir(path.join(root, "cpb-task", "events", "demo"), { recursive: true });
  await mkdir(projectRuntimeRoot, { recursive: true });
  await writeFile(path.join(hubRoot, "projects.json"), JSON.stringify({
    version: 1,
    updatedAt: new Date(0).toISOString(),
    projects: {
      demo: {
        id: "demo",
        name: "demo",
        sourcePath: root,
        projectRoot: path.join(root, "cpb-task"),
        projectRuntimeRoot,
        enabled: true,
      },
    },
  }));

  const { listRuntimeDataRoots, resolveProjectDataRoot } = await import("../server/services/runtime-context.js");

  const roots = await listRuntimeDataRoots(root, { hubRoot });
  assert.deepEqual(roots.map((r) => r.dataRoot).sort(), [
    path.join(root, "cpb-task"),
    projectRuntimeRoot,
  ].sort());

  const demoRoot = await resolveProjectDataRoot(root, "demo", { hubRoot });
  assert.equal(demoRoot, projectRuntimeRoot);

  await rm(root, { recursive: true, force: true }).catch(() => {});
});

test("job queries include legacy and Hub project runtime roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-runtime-jobs-"));
  const hubRoot = path.join(root, ".hub");
  const projectRuntimeRoot = path.join(hubRoot, "projects", "demo");
  const legacyEventDir = path.join(root, "cpb-task", "events", "demo");
  const hubEventDir = path.join(projectRuntimeRoot, "events", "demo");

  await mkdir(legacyEventDir, { recursive: true });
  await mkdir(hubEventDir, { recursive: true });
  await writeFile(path.join(hubRoot, "projects.json"), JSON.stringify({
    version: 1,
    updatedAt: new Date(0).toISOString(),
    projects: {
      demo: {
        id: "demo",
        name: "demo",
        sourcePath: root,
        projectRoot: path.join(root, "cpb-task"),
        projectRuntimeRoot,
        enabled: true,
      },
    },
  }));

  await writeFile(path.join(legacyEventDir, "job-20260524-000000-aaaaaa.jsonl"),
    JSON.stringify({ type: "job_created", jobId: "job-20260524-000000-aaaaaa", project: "demo", task: "legacy", workflow: "standard", ts: "2026-05-24T00:00:00Z" }) + "\n");
  await writeFile(path.join(hubEventDir, "job-20260524-000001-bbbbbb.jsonl"),
    JSON.stringify({ type: "job_created", jobId: "job-20260524-000001-bbbbbb", project: "demo", task: "hub", workflow: "standard", ts: "2026-05-24T00:00:01Z" }) + "\n");

  const { listJobsAcrossRuntimeRoots } = await import("../server/services/job-store.js");
  const jobs = await listJobsAcrossRuntimeRoots(root, { hubRoot });
  assert.deepEqual(jobs.map((j) => j.task).sort(), ["hub", "legacy"]);

  await rm(root, { recursive: true, force: true }).catch(() => {});
});
