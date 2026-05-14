#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listEventFiles } from "../server/services/event-store.js";
import {
  blockJob,
  budgetExceeded,
  completeJob,
  completePhase,
  createJob,
  failJob,
  getJob,
  listJobs,
  startPhase,
} from "../server/services/job-store.js";

const root = await mkdtemp(path.join(tmpdir(), "cpb-job-store-"));
const project = "demo";

const created = await createJob(root, {
  project,
  task: "Ship unattended supervisor",
  workflow: "ralph",
  ts: "2026-05-13T00:00:00.000Z",
});
assert.match(created.jobId, /^job-\d{8}-\d{6}-[a-z0-9]+$/);
assert.equal(created.project, project);
assert.equal(created.task, "Ship unattended supervisor");
assert.equal(created.workflow, "ralph");
assert.equal(created.status, "running");

await startPhase(root, project, created.jobId, {
  phase: "plan",
  attempt: 2,
  leaseId: "lease-1",
  ts: "2026-05-13T00:01:00.000Z",
});
await completePhase(root, project, created.jobId, {
  phase: "plan",
  artifact: "wiki/projects/demo/inbox/plan-001.md",
  ts: "2026-05-13T00:02:00.000Z",
});

const planned = await getJob(root, project, created.jobId);
assert.equal(planned.status, "running");
assert.equal(planned.phase, "plan");
assert.equal(planned.attempt, 2);
assert.equal(planned.artifacts.plan, "wiki/projects/demo/inbox/plan-001.md");
assert.equal(planned.updatedAt, "2026-05-13T00:02:00.000Z");

await blockJob(root, project, created.jobId, {
  reason: "needs human decision",
  ts: "2026-05-13T00:03:00.000Z",
});
const blocked = await getJob(root, project, created.jobId);
assert.equal(blocked.status, "blocked");
assert.equal(blocked.blockedReason, "needs human decision");

await completeJob(root, project, created.jobId, {
  ts: "2026-05-13T00:04:00.000Z",
});
const completed = await getJob(root, project, created.jobId);
assert.equal(completed.status, "completed");
assert.equal(completed.phase, "completed");
assert.equal(completed.blockedReason, null);

const failed = await createJob(root, {
  project,
  task: "Fail direct assertion",
  ts: "2026-05-13T01:00:00.000Z",
});
await failJob(root, project, failed.jobId, {
  reason: "verification failed",
  ts: "2026-05-13T01:01:00.000Z",
});
const failedState = await getJob(root, project, failed.jobId);
assert.equal(failedState.status, "failed");
assert.equal(failedState.blockedReason, "verification failed");

const budgetBlocked = await createJob(root, {
  project,
  task: "Stop runaway provider loop",
  ts: "2026-05-13T01:10:00.000Z",
});
await budgetExceeded(root, project, budgetBlocked.jobId, {
  reason: "max provider retries reached",
  ts: "2026-05-13T01:11:00.000Z",
});
const budgetBlockedState = await getJob(root, project, budgetBlocked.jobId);
assert.equal(budgetBlockedState.status, "blocked");
assert.equal(budgetBlockedState.blockedReason, "max provider retries reached");

const jobs = await listJobs(root);
assert.equal(jobs.length, 3);
assert.equal(jobs[0].jobId, budgetBlocked.jobId);
assert.equal(jobs[1].jobId, failed.jobId);
assert.equal(jobs[2].jobId, created.jobId);
assert(jobs.some((job) => job.jobId === created.jobId));

const eventsRoot = path.join(root, "cpb-task", "events");
await mkdir(path.join(eventsRoot, "ignored"), { recursive: true });
await writeFile(path.join(eventsRoot, "ignored", "notes.txt"), "skip me\n", "utf8");
await writeFile(path.join(eventsRoot, "ignored", "job-20260513-020000-extra.jsonl"), "", "utf8");

const jobsWithoutEmptyStream = await listJobs(root);
assert.equal(jobsWithoutEmptyStream.length, 3);
assert(!jobsWithoutEmptyStream.some((job) => job.project === "ignored"));

const orphanJobId = "job-20260513-030000-orphan";
await writeFile(
  path.join(eventsRoot, "ignored", `${orphanJobId}.jsonl`),
  `${JSON.stringify({
    type: "phase_started",
    project: "ignored",
    jobId: orphanJobId,
    phase: "plan",
    ts: "2026-05-13T03:00:00.000Z",
  })}\n`,
  "utf8"
);

const jobsWithoutOrphanStream = await listJobs(root);
assert.equal(jobsWithoutOrphanStream.length, 3);
assert(!jobsWithoutOrphanStream.some((job) => job.jobId === orphanJobId));

const files = await listEventFiles(root);
assert.deepEqual(
  files
    .map(({ project: fileProject, jobId, file }) => ({
      project: fileProject,
      jobId,
      file: path.relative(root, file),
    }))
    .sort((a, b) => a.file.localeCompare(b.file)),
  [
    {
      project,
      jobId: created.jobId,
      file: path.join("cpb-task", "events", project, `${created.jobId}.jsonl`),
    },
    {
      project,
      jobId: budgetBlocked.jobId,
      file: path.join("cpb-task", "events", project, `${budgetBlocked.jobId}.jsonl`),
    },
    {
      project,
      jobId: failed.jobId,
      file: path.join("cpb-task", "events", project, `${failed.jobId}.jsonl`),
    },
    {
      project: "ignored",
      jobId: "job-20260513-020000-extra",
      file: path.join("cpb-task", "events", "ignored", "job-20260513-020000-extra.jsonl"),
    },
    {
      project: "ignored",
      jobId: orphanJobId,
      file: path.join("cpb-task", "events", "ignored", `${orphanJobId}.jsonl`),
    },
  ].sort((a, b) => a.file.localeCompare(b.file))
);

const missingEventsRoot = await mkdtemp(path.join(tmpdir(), "cpb-job-store-missing-"));
assert.deepEqual(await listEventFiles(missingEventsRoot), []);
