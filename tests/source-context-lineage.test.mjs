#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJob, failJob, retryJob, getJob, FAILURE_CODES } from "../server/services/job-store.js";

const root = await mkdtemp(path.join(tmpdir(), "cpb-source-ctx-"));
const project = "source-ctx-test";

// Step 1: Create a job with source context (simulating a GitHub issue #63 queue entry)
const original = await createJob(root, {
  project,
  task: "Fix auth token handling",
  ts: "2026-05-21T21:34:15.000Z",
  sourceContext: {
    queueEntryId: "q-mpfywkw4-0hhx",
    issueNumber: 63,
    issueUrl: "https://github.com/changw98ic/codepatchbay/issues/63",
    repo: "changw98ic/codepatchbay",
    issueTitle: "P0: Auth token not refreshed on expiry",
    failedQueueId: "q-mpfdxgdb-xhi1",
    failedJobId: "job-20260521-162611-e745cc",
    failureArtifact: "verdict-186",
  },
});

assert.equal(original.sourceContext.issueNumber, 63, "source context issue number should be 63");
assert.equal(original.sourceContext.queueEntryId, "q-mpfywkw4-0hhx");
assert.equal(original.sourceContext.repo, "changw98ic/codepatchbay");
console.log("OK: source context persisted on job creation");

// Step 2: Fail the job, then retry — source context should survive
await failJob(root, project, original.jobId, {
  reason: "verification failed",
  code: FAILURE_CODES.RECOVERABLE,
  phase: "execute",
  ts: "2026-05-21T22:00:00.000Z",
});

const retried = await retryJob(root, project, original.jobId, {
  fromPhase: "execute",
  trigger: "auto",
  ts: "2026-05-21T22:01:00.000Z",
});

assert.equal(retried.sourceContext.issueNumber, 63, "retry should preserve original issue #63");
assert.equal(retried.sourceContext.queueEntryId, "q-mpfywkw4-0hhx", "retry should preserve queue entry id");
assert.equal(retried.sourceContext.failedJobId, "job-20260521-162611-e745cc", "retry should preserve failed job id");
assert.ok(retried.lineage, "retry should have lineage");
assert.equal(retried.lineage.parentJobId, original.jobId, "lineage parent should be original job");
console.log("OK: source context survives retry with issue #63 intact");

// Step 3: Double-check via getJob that materialized state has source context
const fresh = await getJob(root, project, retried.jobId);
assert.equal(fresh.sourceContext.issueNumber, 63, "getJob should materialize source context");
assert.equal(fresh.sourceContext.issueUrl, "https://github.com/changw98ic/codepatchbay/issues/63");
console.log("OK: getJob materializes source context correctly");

// Step 4: Job without source context should have null sourceContext
const plain = await createJob(root, {
  project,
  task: "Direct CLI task without queue",
  ts: "2026-05-21T23:00:00.000Z",
});
assert.equal(plain.sourceContext, null, "job without queue should have null sourceContext");
console.log("OK: non-GitHub job has null sourceContext");

console.log("\nAll source context lineage tests passed.");
