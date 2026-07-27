import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { appendEvent } from "../server/services/event/event-store.js";
import { registerProject } from "../server/services/hub/hub-registry.js";
import { createJob, listJobsAcrossRuntimeRoots } from "../server/services/job/job-store.js";

async function appendCreatedJob(
  cpbRoot: string,
  project: string,
  jobId: string,
  dataRoot: string | undefined,
  second: number,
  task = "snapshot cache",
) {
  const suffix = String(second).padStart(2, "0");
  await appendEvent(
    cpbRoot,
    project,
    jobId,
    {
      type: "job_created",
      jobId,
      project,
      task: `${task} ${suffix}`,
      workflow: "standard",
      ts: `2026-06-11T04:00:${suffix}.000Z`,
    },
    { dataRoot }
  );
}

test("listJobsAcrossRuntimeRoots invalidates short-lived snapshots after event writes", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-jobs-snapshot-cache-"));
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-jobs-snapshot-hub-"));
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-jobs-snapshot-source-"));
  const dataRoot = path.join(hubRoot, "projects", "flow");
  try {
    await registerProject(hubRoot, {
      id: "flow",
      name: "flow",
      sourcePath,
      skipCodeGraphGate: true,
    });

    const firstJobId = "job-20260611-040000-first";
    const secondJobId = "job-20260611-040001-second";
    await appendCreatedJob(cpbRoot, "flow", firstJobId, dataRoot, 0);

    const cachedFirst = await listJobsAcrossRuntimeRoots(cpbRoot, { hubRoot, cacheTtlMs: 10_000 });
    assert.deepEqual(cachedFirst.map((job) => job.jobId), [firstJobId]);

    await appendCreatedJob(cpbRoot, "flow", secondJobId, dataRoot, 1);

    const cachedSecond = await listJobsAcrossRuntimeRoots(cpbRoot, { hubRoot, cacheTtlMs: 10_000 });
    assert.deepEqual(new Set(cachedSecond.map((job) => job.jobId)), new Set([firstJobId, secondJobId]));

    const uncached = await listJobsAcrossRuntimeRoots(cpbRoot, { hubRoot });
    assert.deepEqual(new Set(uncached.map((job) => job.jobId)), new Set([firstJobId, secondJobId]));
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
    await rm(sourcePath, { recursive: true, force: true });
  }
});

test("listJobsAcrossRuntimeRoots returns the registered project runtime job", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-jobs-root-collision-"));
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-jobs-root-collision-hub-"));
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-jobs-root-collision-source-"));
  const dataRoot = path.join(hubRoot, "projects", "flow");
  const jobId = "job-20260611-040100-collision";
  try {
    await registerProject(hubRoot, {
      id: "flow",
      name: "flow",
      sourcePath,
      skipCodeGraphGate: true,
    });

    await appendCreatedJob(cpbRoot, "flow", jobId, dataRoot, 10, "canonical copy");
    await appendEvent(
      cpbRoot,
      "flow",
      jobId,
      {
        type: "job_completed",
        jobId,
        project: "flow",
        ts: "2026-06-11T04:00:11.000Z",
      },
      { dataRoot }
    );

    const jobs = await listJobsAcrossRuntimeRoots(cpbRoot, { hubRoot });

    assert.equal(jobs.filter((job) => job.project === "flow" && job.jobId === jobId).length, 1);
    const job = jobs.find((entry) => entry.project === "flow" && entry.jobId === jobId);
    assert.equal(job?.task, "canonical copy 10");
    assert.equal(job?.status, "completed");
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
    await rm(sourcePath, { recursive: true, force: true });
  }
});

test("project runtime job creation rejects a terminal canonical duplicate", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-jobs-create-collision-"));
  const dataRoot = path.join(cpbRoot, "hub", "projects", "flow");
  const jobId = "job-20260611-040200-collision";
  try {
    await appendCreatedJob(cpbRoot, "flow", jobId, dataRoot, 20, "canonical terminal");
    await appendEvent(
      cpbRoot,
      "flow",
      jobId,
      {
        type: "job_completed",
        jobId,
        project: "flow",
        ts: "2026-06-11T04:00:21.000Z",
      },
      { dataRoot }
    );

    await assert.rejects(
      () => createJob(cpbRoot, {
        project: "flow",
        jobId,
        task: "duplicate job",
        workflow: "standard",
        ts: "2026-06-11T04:00:22.000Z",
        dataRoot,
      }),
      /job is terminal/,
    );
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
  }
});
