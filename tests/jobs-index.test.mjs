#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

// --- Concurrency: parallel updateJobsIndexEntry must not lose entries ---
const concurrencyRoot = await mkdtemp(path.join(tmpdir(), "cpb-jobs-index-conc-"));
const PARALLEL = 20;
const baseState = {
  status: "running", phase: "plan", attempt: 1, workflow: "standard",
  artifacts: {}, leaseId: null, worktree: null, blockedReason: null,
  failureCode: null, failurePhase: null, retryable: false, retryCount: 0,
  failureCause: null, cancelRequested: false, cancelReason: null,
  redirectContext: null, redirectReason: null, redirectEventId: null,
  consumedRedirectIds: [], lastActivityAt: null, lastActivityMessage: null,
};

const parallelWrites = Array.from({ length: PARALLEL }, (_, i) => {
  const jobId = `job-conc-${String(i).padStart(3, "0")}`;
  return updateJobsIndexEntry(concurrencyRoot, "conctest", jobId, {
    ...baseState,
    jobId,
    project: "conctest",
    task: `Parallel task ${i}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

await Promise.all(parallelWrites);
const concIndex = await readJobsIndex(concurrencyRoot);
assert.equal(concIndex._meta.jobCount, PARALLEL, `expected ${PARALLEL} jobs, got ${concIndex._meta.jobCount}`);
for (let i = 0; i < PARALLEL; i++) {
  const key = `conctest/job-conc-${String(i).padStart(3, "0")}`;
  assert.ok(concIndex.jobs[key], `missing entry: ${key}`);
}

// --- Concurrency: duplicate key update under parallel writes ---
const dupRoot = await mkdtemp(path.join(tmpdir(), "cpb-jobs-index-dup-"));
const DUP_COUNT = 15;
const dupWrites = Array.from({ length: DUP_COUNT }, (_, i) =>
  updateJobsIndexEntry(dupRoot, "dupproj", "job-same", {
    ...baseState,
    jobId: "job-same",
    project: "dupproj",
    task: `Duplicate update ${i}`,
    status: i === DUP_COUNT - 1 ? "completed" : "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
);
await Promise.all(dupWrites);
const dupIndex = await readJobsIndex(dupRoot);
assert.equal(dupIndex._meta.jobCount, 1, "duplicate key should result in single entry");
assert.equal(dupIndex.jobs["dupproj/job-same"].status, "completed",
  "last write should win for duplicate key");

// --- Concurrency: append + update mix under parallel writes ---
const mixRoot = await mkdtemp(path.join(tmpdir(), "cpb-jobs-index-mix-"));
const mixOps = [];
// 5 new entries
for (let i = 0; i < 5; i++) {
  const jobId = `job-mix-${i}`;
  mixOps.push(updateJobsIndexEntry(mixRoot, "mixproj", jobId, {
    ...baseState, jobId, project: "mixproj", task: `Mix new ${i}`,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }));
}
// 3 updates to the first entry
for (let i = 0; i < 3; i++) {
  mixOps.push(updateJobsIndexEntry(mixRoot, "mixproj", "job-mix-0", {
    ...baseState, jobId: "job-mix-0", project: "mixproj",
    task: `Mix update ${i}`, attempt: i + 2,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }));
}
await Promise.all(mixOps);
const mixIndex = await readJobsIndex(mixRoot);
assert.equal(mixIndex._meta.jobCount, 5, "5 unique keys expected");
assert.equal(mixIndex.jobs["mixproj/job-mix-0"].attempt, 4,
  "last of 3 updates (initial + 3) should have attempt=4");

// --- Concurrency: lock released on write failure ---
const failRoot = await mkdtemp(path.join(tmpdir(), "cpb-jobs-index-lockrel-"));
// Write a valid first entry
await updateJobsIndexEntry(failRoot, "fproj", "job-ok-1", {
  ...baseState, jobId: "job-ok-1", project: "fproj", task: "ok",
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});

// Corrupt the index directory to force a write failure on next update
const indexPath = path.join(failRoot, "cpb-task", "jobs-index.json");
await rm(indexPath);

// Create a directory at the index file path to make write fail
await mkdir(indexPath, { recursive: true });

// This update should fail but release the lock
await assert.rejects(
  () => updateJobsIndexEntry(failRoot, "fproj", "job-fail", {
    ...baseState, jobId: "job-fail", project: "fproj", task: "fail",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }),
  "write to directory path should fail"
);

// Remove the blocking directory so writes can succeed again
await rm(indexPath, { recursive: true });

// This must succeed — proves lock was released after the failure
await updateJobsIndexEntry(failRoot, "fproj", "job-after", {
  ...baseState, jobId: "job-after", project: "fproj", task: "after recovery",
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});
const afterIndex = await readJobsIndex(failRoot);
assert.ok(afterIndex.jobs["fproj/job-after"], "post-failure write should succeed");

console.log("jobs-index: all tests passed");
