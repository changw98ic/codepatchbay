import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  listJobsFromIndex,
  readJobsIndex,
  updateJobsIndexEntry,
} from "../server/services/job/job-store.js";

async function tempRoot(prefix: string) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function assertMissing(file: string) {
  await assert.rejects(() => access(file), { code: "ENOENT" });
}

function jobState(project: string, jobId: string, task: string) {
  return {
    project,
    jobId,
    task,
    status: "running",
    createdAt: "2026-06-11T09:00:00.000Z",
    updatedAt: "2026-06-11T09:00:00.000Z",
  };
}

test("jobs-index rejects project-scoped access without an explicit dataRoot", async () => {
  const cpbRoot = await tempRoot("cpb-jobs-index-no-root-");
  try {
    await assert.rejects(
      () => readJobsIndex(cpbRoot),
      /dataRoot is required for project jobs-index paths/,
    );
    await assert.rejects(
      () => listJobsFromIndex(cpbRoot),
      /dataRoot is required for project jobs-index paths/,
    );
    await assert.rejects(
      () => updateJobsIndexEntry(
        cpbRoot,
        "flow",
        "job-20260611-090000-no-root",
        jobState("flow", "job-20260611-090000-no-root", "missing root"),
      ),
      /dataRoot is required for project jobs-index paths/,
    );
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

test("jobs-index writes project state only under the explicit dataRoot", async () => {
  const cpbRoot = await tempRoot("cpb-jobs-index-project-root-");
  const dataRoot = path.join(cpbRoot, "hub", "projects", "flow", "jobs");
  const jobId = "job-20260611-091000-project";
  try {
    await updateJobsIndexEntry(cpbRoot, "flow", jobId, jobState("flow", jobId, "runtime root"), { dataRoot });

    const index = JSON.parse(await readFile(path.join(dataRoot, "jobs-index.json"), "utf8"));
    assert.equal(index.jobs[`flow/${jobId}`].task, "runtime root");
    await assertMissing(path.join(cpbRoot, "cpb-task", "jobs-index.json"));
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

test("jobs-index legacy paths are available only through explicit opt-in", async () => {
  const cpbRoot = await tempRoot("cpb-jobs-index-legacy-root-");
  const jobId = "job-20260611-092000-legacy";
  try {
    await updateJobsIndexEntry(
      cpbRoot,
      "legacy",
      jobId,
      jobState("legacy", jobId, "legacy root"),
      { legacyOnly: true },
    );

    const index = await readJobsIndex(cpbRoot, { legacyOnly: true });
    assert.equal(index?.jobs?.[`legacy/${jobId}`]?.task, "legacy root");
    assert.equal(
      JSON.parse(await readFile(path.join(cpbRoot, "cpb-task", "jobs-index.json"), "utf8")).jobs[`legacy/${jobId}`].task,
      "legacy root",
    );
    await assert.rejects(
      () => readJobsIndex(cpbRoot),
      /dataRoot is required for project jobs-index paths/,
    );
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
  }
});

test("jobs-index ignores ambient CPB_PROJECT_RUNTIME_ROOT when dataRoot is omitted", async () => {
  const cpbRoot = await tempRoot("cpb-jobs-index-env-root-");
  const ambientRoot = path.join(cpbRoot, "ambient");
  const original = process.env.CPB_PROJECT_RUNTIME_ROOT;
  try {
    process.env.CPB_PROJECT_RUNTIME_ROOT = ambientRoot;
    await assert.rejects(
      () => updateJobsIndexEntry(
        cpbRoot,
        "flow",
        "job-20260611-093000-env",
        jobState("flow", "job-20260611-093000-env", "ambient"),
      ),
      /dataRoot is required for project jobs-index paths/,
    );
    await assertMissing(path.join(ambientRoot, "jobs-index.json"));
    await assertMissing(path.join(cpbRoot, "cpb-task", "jobs-index.json"));
  } finally {
    if (original === undefined) delete process.env.CPB_PROJECT_RUNTIME_ROOT;
    else process.env.CPB_PROJECT_RUNTIME_ROOT = original;
    await rm(cpbRoot, { recursive: true, force: true });
  }
});
