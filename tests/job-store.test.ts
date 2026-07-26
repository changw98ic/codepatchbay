#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { listEventFiles } from "../server/services/event/event-store.js";
import {
  blockJob,
  budgetExceeded,
  completeJob,
  completePhase,
  createJob,
  failJob,
  FAILURE_CODES,
  getJob,
  listJobs,
  retryJob,
  startPhase,
} from "../server/services/job/job-store.js";

type JobRecord = Awaited<ReturnType<typeof createJob>>;

let root = "";
const project = "demo";
let dataRoot = "";
let created = {} as JobRecord;
let planned = {} as JobRecord;
let completed = {} as JobRecord;
let failed = {} as JobRecord;
let retriedState = {} as JobRecord;
let budgetBlocked = {} as JobRecord;
let manuallyBlocked = {} as JobRecord;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cpb-job-store-"));
  dataRoot = path.join(root, "runtime");

  created = await createJob(root, {
    project,
    task: "Ship unattended supervisor",
    workflow: "ralph",
    ts: "2026-05-13T00:00:00.000Z",
    dataRoot,
  });
  await startPhase(root, project, created.jobId, {
    phase: "plan",
    attempt: 2,
    leaseId: "lease-1",
    ts: "2026-05-13T00:01:00.000Z",
    dataRoot,
  });
  await completePhase(root, project, created.jobId, {
    phase: "plan",
    artifact: "wiki/projects/demo/inbox/plan-001.md",
    ts: "2026-05-13T00:02:00.000Z",
    dataRoot,
  });
  planned = await getJob(root, project, created.jobId, { dataRoot });
  await completeJob(root, project, created.jobId, {
    ts: "2026-05-13T00:03:00.000Z",
    dataRoot,
  });
  completed = await getJob(root, project, created.jobId, { dataRoot });

  failed = await createJob(root, {
    project,
    task: "Fail direct assertion",
    ts: "2026-05-13T01:00:00.000Z",
    dataRoot,
  });
  await failJob(root, project, failed.jobId, {
    reason: "verification failed",
    code: FAILURE_CODES.RECOVERABLE,
    phase: "execute",
    ts: "2026-05-13T01:01:00.000Z",
    dataRoot,
  });
  retriedState = await retryJob(root, project, failed.jobId, {
    ts: "2026-05-13T01:02:00.000Z",
    dataRoot,
  });

  budgetBlocked = await createJob(root, {
    project,
    task: "Stop runaway provider loop",
    ts: "2026-05-13T01:10:00.000Z",
    dataRoot,
  });
  await budgetExceeded(root, project, budgetBlocked.jobId, {
    reason: "max provider retries reached",
    ts: "2026-05-13T01:11:00.000Z",
    dataRoot,
  });

  manuallyBlocked = await createJob(root, {
    project,
    task: "Wait for human approval",
    ts: "2026-05-13T01:12:00.000Z",
    dataRoot,
  });
  await blockJob(root, project, manuallyBlocked.jobId, {
    reason: "approval required",
    code: "approval_required",
    kind: "human_gate",
    ts: "2026-05-13T01:13:00.000Z",
    dataRoot,
  });
});

after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

test("job store creates, advances, completes, and retries jobs", async () => {
  assert.match(created.jobId, /^job-\d{8}-\d{6}-[a-z0-9]+$/);
  assert.equal(created.project, project);
  assert.equal(created.task, "Ship unattended supervisor");
  assert.equal(created.workflow, "ralph");
  assert.equal(created.status, "running");

  assert.equal(planned.status, "running");
  assert.equal(planned.phase, "plan");
  assert.equal(planned.attempt, 2);
  assert.equal(planned.artifacts.plan, "wiki/projects/demo/inbox/plan-001.md");
  assert.equal(planned.updatedAt, "2026-05-13T00:02:00.000Z");

  assert.equal(completed.status, "completed");
  assert.equal(completed.phase, "completed");
  assert.equal(completed.blockedReason, null);

  const failedState = await getJob(root, project, failed.jobId, { dataRoot });
  assert.equal(failedState.status, "failed");
  assert.equal(failedState.blockedReason, "verification failed");
  assert.equal(failedState.failureCode, FAILURE_CODES.RECOVERABLE);
  assert.equal(failedState.failurePhase, "execute");
  assert.equal(failedState.retryable, true);

  assert.equal(retriedState.status, "running");
  assert.notEqual(retriedState.jobId, failed.jobId);
  assert.equal(retriedState.task, "Fail direct assertion");
  assert.equal(retriedState.lineage.parentJobId, failed.jobId);
  assert.equal(retriedState.lineage.parentStatus, "failed");
  assert.equal(retriedState.lineage.parentFailureCode, FAILURE_CODES.RECOVERABLE);

  const failedAfterRetry = await getJob(root, project, failed.jobId, { dataRoot });
  assert.equal(failedAfterRetry.status, "failed");
  assert.equal(failedAfterRetry.blockedReason, "verification failed");
  assert.equal(failedAfterRetry.failureCode, FAILURE_CODES.RECOVERABLE);
});

test("job store preserves blocked states and newest-first listing", async () => {
  const budgetBlockedState = await getJob(root, project, budgetBlocked.jobId, { dataRoot });
  assert.equal(budgetBlockedState.status, "blocked");
  assert.equal(budgetBlockedState.blockedReason, "max provider retries reached");

  const manuallyBlockedState = await getJob(root, project, manuallyBlocked.jobId, { dataRoot });
  assert.equal(manuallyBlockedState.status, "blocked");
  assert.equal(manuallyBlockedState.blockedReason, "approval required");
  assert.equal(manuallyBlockedState.failureCode, "approval_required");

  const jobs = await listJobs(root, { dataRoot });
  assert.equal(jobs.length, 5);
  assert.equal(jobs[0].jobId, manuallyBlocked.jobId);
  assert.equal(jobs[1].jobId, budgetBlocked.jobId);
  assert.equal(jobs[2].jobId, retriedState.jobId);
  assert.equal(jobs[3].jobId, failed.jobId);
  assert.equal(jobs[4].jobId, created.jobId);
  assert(jobs.some((job) => job.jobId === created.jobId));
});

test("job listing ignores unrelated directories and orphan streams", async () => {
  const eventsRoot = path.join(dataRoot, "events");
  await mkdir(path.join(eventsRoot, "ignored"), { recursive: true });
  await writeFile(path.join(eventsRoot, "ignored", "notes.txt"), "skip me\n", "utf8");
  await writeFile(path.join(eventsRoot, "ignored", "job-20260513-020000-extra.jsonl"), "", "utf8");

  const jobsWithoutEmptyStream = await listJobs(root, { dataRoot });
  assert.equal(jobsWithoutEmptyStream.length, 5);
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
    "utf8",
  );

  const jobsWithoutOrphanStream = await listJobs(root, { dataRoot });
  assert.equal(jobsWithoutOrphanStream.length, 5);
  assert(!jobsWithoutOrphanStream.some((job) => job.jobId === orphanJobId));
  await rm(path.join(eventsRoot, "ignored"), { recursive: true, force: true });
});

test("event file listing honors canonical and optional legacy roots", async () => {
  const files = await listEventFiles(root, { dataRoot });
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
        file: path.join("runtime", "events", project, `${created.jobId}.jsonl`),
      },
      {
        project,
        jobId: budgetBlocked.jobId,
        file: path.join("runtime", "events", project, `${budgetBlocked.jobId}.jsonl`),
      },
      {
        project,
        jobId: manuallyBlocked.jobId,
        file: path.join("runtime", "events", project, `${manuallyBlocked.jobId}.jsonl`),
      },
      {
        project,
        jobId: retriedState.jobId,
        file: path.join("runtime", "events", project, `${retriedState.jobId}.jsonl`),
      },
      {
        project,
        jobId: failed.jobId,
        file: path.join("runtime", "events", project, `${failed.jobId}.jsonl`),
      },
    ].sort((a, b) => a.file.localeCompare(b.file)),
  );

  const missingEventsRoot = await mkdtemp(path.join(tmpdir(), "cpb-job-store-missing-"));
  assert.deepEqual(await listEventFiles(missingEventsRoot, { dataRoot: path.join(missingEventsRoot, "runtime") }), []);
  await rm(missingEventsRoot, { recursive: true, force: true });

  const fallbackRoot = await mkdtemp(path.join(tmpdir(), "cpb-event-fallback-"));
  try {
    const projectDataRoot = path.join(fallbackRoot, "hub", "projects", "alpha", "jobs");
    await mkdir(path.join(fallbackRoot, "cpb-task", "events", "legacy"), { recursive: true });
    await mkdir(path.join(projectDataRoot, "events", "alpha"), { recursive: true });
    await writeFile(
      path.join(fallbackRoot, "cpb-task", "events", "legacy", "job-20260611-010000-legacy.jsonl"),
      "{}\n",
      "utf8",
    );
    await writeFile(
      path.join(projectDataRoot, "events", "alpha", "job-20260611-010100-project.jsonl"),
      "{}\n",
      "utf8",
    );

    assert.deepEqual(
      (await listEventFiles(fallbackRoot, { dataRoot: projectDataRoot })).map(({ project: p, jobId }) => `${p}/${jobId}`).sort(),
      ["alpha/job-20260611-010100-project"],
    );
    assert.deepEqual(
      (await listEventFiles(fallbackRoot, { dataRoot: projectDataRoot, includeLegacyFallback: true })).map(({ project: p, jobId }) => `${p}/${jobId}`).sort(),
      ["alpha/job-20260611-010100-project", "legacy/job-20260611-010000-legacy"],
    );
    assert.deepEqual(
      (await listEventFiles(fallbackRoot, { dataRoot: projectDataRoot, includeLegacyFallback: false }))
        .map(({ project: p, jobId }) => `${p}/${jobId}`).sort(),
      ["alpha/job-20260611-010100-project"],
    );
  } finally {
    await rm(fallbackRoot, { recursive: true, force: true });
  }
});
