#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readJobsIndex,
  rebuildJobsIndex,
  updateJobsIndexEntry,
  listJobsFromIndex,
} from "../server/services/jobs-index.js";
import {
  createJob,
  completeJob,
  failJob,
  FAILURE_CODES,
  listJobs,
  startPhase,
  completePhase,
} from "../server/services/job-store.js";

// --- readJobsIndex: empty / missing ---
const emptyRoot = await mkdtemp(path.join(tmpdir(), "cpb-jobs-index-"));
assert.equal(await readJobsIndex(emptyRoot), null);

// --- updateJobsIndexEntry creates index on first write ---
const state1 = {
  jobId: "job-20260513-000001",
  project: "alpha",
  task: "First task",
  status: "running",
  phase: "plan",
  attempt: 1,
  workflow: "standard",
  artifacts: {},
  leaseId: null,
  worktree: null,
  createdAt: "2026-05-13T00:00:00.000Z",
  updatedAt: "2026-05-13T00:01:00.000Z",
  blockedReason: null,
  failureCode: null,
  failurePhase: null,
  retryable: false,
  retryCount: 0,
  failureCause: null,
  cancelRequested: false,
  cancelReason: null,
  redirectContext: null,
  redirectReason: null,
  redirectEventId: null,
  consumedRedirectIds: [],
  lastActivityAt: null,
  lastActivityMessage: null,
};

await updateJobsIndexEntry(emptyRoot, "alpha", "job-20260513-000001", state1);
const idx1 = await readJobsIndex(emptyRoot);
assert.equal(idx1._meta.version, 1);
assert.equal(idx1._meta.jobCount, 1);
assert.deepEqual(idx1.jobs["alpha/job-20260513-000001"], state1);

// --- Second entry updates the same index ---
const state2 = {
  ...state1,
  jobId: "job-20260514-000002",
  project: "beta",
  task: "Second task",
  createdAt: "2026-05-14T00:00:00.000Z",
  updatedAt: "2026-05-14T00:02:00.000Z",
};

await updateJobsIndexEntry(emptyRoot, "beta", "job-20260514-000002", state2);
const idx2 = await readJobsIndex(emptyRoot);
assert.equal(idx2._meta.jobCount, 2);
assert.ok(idx2.jobs["alpha/job-20260513-000001"]);
assert.ok(idx2.jobs["beta/job-20260514-000002"]);

// --- Update existing entry overwrites ---
const updated1 = { ...state1, status: "completed", phase: "completed" };
await updateJobsIndexEntry(emptyRoot, "alpha", "job-20260513-000001", updated1);
const idx3 = await readJobsIndex(emptyRoot);
assert.equal(idx3._meta.jobCount, 2);
assert.equal(idx3.jobs["alpha/job-20260513-000001"].status, "completed");

// --- listJobsFromIndex reads index and sorts by updatedAt desc ---
const listed = await listJobsFromIndex(emptyRoot);
assert.equal(listed.length, 2);
assert.equal(listed[0].jobId, "job-20260514-000002"); // newer updatedAt first
assert.equal(listed[1].jobId, "job-20260513-000001");

// --- Corrupt index triggers rebuild ---
const indexFile = path.join(emptyRoot, "cpb-task", "jobs-index.json");
await writeFile(indexFile, "{bad json", "utf8");
const corruptResult = await readJobsIndex(emptyRoot);
assert.equal(corruptResult, null);

// listJobsFromIndex should rebuild from events and return results
const rebuilt = await listJobsFromIndex(emptyRoot);
assert.ok(Array.isArray(rebuilt));

// --- Wrong version triggers rebuild ---
await writeFile(indexFile, JSON.stringify({ _meta: { version: 99 }, jobs: {} }), "utf8");
assert.equal(await readJobsIndex(emptyRoot), null);

// --- rebuildJobsIndex from real events ---
const eventRoot = await mkdtemp(path.join(tmpdir(), "cpb-jobs-index-rebuild-"));
const project = "demo";

const job1 = await createJob(eventRoot, {
  project,
  task: "Index rebuild test 1",
  ts: "2026-05-13T00:00:00.000Z",
  jobId: "job-20260513-000001",
});
await startPhase(eventRoot, project, job1.jobId, {
  phase: "plan",
  ts: "2026-05-13T00:01:00.000Z",
});
await completePhase(eventRoot, project, job1.jobId, {
  phase: "plan",
  artifact: "plan-001.md",
  ts: "2026-05-13T00:02:00.000Z",
});
await completeJob(eventRoot, project, job1.jobId, {
  ts: "2026-05-13T00:03:00.000Z",
});

const job2 = await createJob(eventRoot, {
  project,
  task: "Index rebuild test 2",
  ts: "2026-05-13T01:00:00.000Z",
  jobId: "job-20260513-010000",
});
await failJob(eventRoot, project, job2.jobId, {
  reason: "test failure",
  code: FAILURE_CODES.RECOVERABLE,
  phase: "execute",
  ts: "2026-05-13T01:01:00.000Z",
});

// Delete index to force rebuild
const eventIndexFile = path.join(eventRoot, "cpb-task", "jobs-index.json");
await rm(eventIndexFile, { force: true });

const rebuiltIndex = await rebuildJobsIndex(eventRoot);
assert.equal(rebuiltIndex._meta.jobCount, 2);
assert.equal(rebuiltIndex.jobs[`${project}/${job1.jobId}`].status, "completed");
assert.equal(rebuiltIndex.jobs[`${project}/${job2.jobId}`].status, "failed");

// listJobsFromIndex returns same results after rebuild
const listedAfterRebuild = await listJobsFromIndex(eventRoot);
assert.equal(listedAfterRebuild.length, 2);
assert.equal(listedAfterRebuild[0].jobId, job2.jobId); // failed has later updatedAt
assert.equal(listedAfterRebuild[1].jobId, job1.jobId);

// --- listJobs (job-store) now uses index ---
const jobStoreListed = await listJobs(eventRoot);
assert.equal(jobStoreListed.length, 2);
assert.equal(jobStoreListed[0].jobId, job2.jobId);

// --- Filters: entries without createdAt/project/jobId are excluded ---
const filterRoot = await mkdtemp(path.join(tmpdir(), "cpb-jobs-index-filter-"));
await updateJobsIndexEntry(filterRoot, "x", "bad-job", { status: "running" });
const filtered = await listJobsFromIndex(filterRoot);
assert.equal(filtered.length, 0);

// --- Atomic write: temp file should not remain ---
const tempFile = path.join(emptyRoot, "cpb-task", "jobs-index.tmp");
await updateJobsIndexEntry(emptyRoot, "gamma", "job-new", { ...state1, jobId: "job-new", project: "gamma", createdAt: "2026-05-15T00:00:00.000Z", updatedAt: "2026-05-15T00:00:00.000Z" });
const { readFile: readCheck } = await import("node:fs/promises");
try {
  await readCheck(tempFile, "utf8");
  assert.fail("temp file should not exist after atomic write");
} catch (err) {
  assert.equal(err.code, "ENOENT");
}

console.log("jobs-index: all tests passed");
