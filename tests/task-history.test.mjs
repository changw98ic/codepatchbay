import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createDispatch, startDispatch } from "../server/services/dispatch-state.js";
import { enqueue, updateEntry } from "../server/services/hub-queue.js";
import { createJob, failJob, FAILURE_CODES } from "../server/services/job-store.js";
import { buildTaskHistory } from "../server/services/task-history.js";

test("buildTaskHistory returns a UI-readable queue, dispatch, and job timeline", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-history-cpb-"));
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-history-hub-"));

  try {
    const queueEntry = await enqueue(hubRoot, {
      projectId: "flow",
      sourcePath: "/repo/flow",
      priority: "P1",
      description: "P0.8a: Add CPB version and runtime identity report",
      metadata: {
        source: "github_issue",
        issueNumber: 20,
        issueUrl: "https://github.com/changw98ic/codepatchbay/issues/20",
        issueTitle: "P0.8a: Add CPB version and runtime identity report",
      },
    });

    await updateEntry(hubRoot, queueEntry.id, {
      status: "completed",
      metadata: {
        finalDisposition: "superseded_by_split_issues",
        supersededByIssues: ["https://github.com/changw98ic/codepatchbay/issues/21"],
      },
    });

    const dispatch = await createDispatch(hubRoot, {
      projectId: "flow",
      sourcePath: "/repo/flow",
      queueEntryId: queueEntry.id,
      ts: "2026-05-20T06:41:00.000Z",
    });
    await startDispatch(hubRoot, dispatch.dispatchId, { ts: "2026-05-20T06:42:00.000Z" });

    const job = await createJob(cpbRoot, {
      project: "flow",
      task: "Project Lock + Supervisor Upgrade Boundary",
      ts: "2026-05-19T08:00:00.000Z",
    });
    await failJob(cpbRoot, "flow", job.jobId, {
      reason: "verifier evidence missing",
      code: FAILURE_CODES.QUALITY_FAIL,
      phase: "verify-retry-3",
      ts: "2026-05-19T08:50:32.000Z",
    });

    const history = await buildTaskHistory({ cpbRoot, hubRoot, limit: 20 });

    assert.ok(history.generatedAt);
    assert.equal(history.summary.totalItems, 3);
    assert.equal(history.summary.queue.completed, 1);
    assert.equal(history.summary.dispatchByStatus.running, 1);
    assert.equal(history.summary.jobByStatus.failed, 1);
    assert.equal(history.summary.byKind.queue, 1);
    assert.equal(history.summary.byKind.dispatch, 1);
    assert.equal(history.summary.byKind.job, 1);

    const queueItem = history.items.find((item) => item.id === `queue:${queueEntry.id}`);
    assert.equal(queueItem.kind, "queue");
    assert.equal(queueItem.title, "P0.8a: Add CPB version and runtime identity report");
    assert.equal(queueItem.issueNumber, 20);
    assert.equal(queueItem.finalDisposition, "superseded_by_split_issues");
    assert.equal(queueItem.links[0].label, "#20");
    assert.equal(queueItem.relations.supersededByIssues.length, 1);

    const dispatchItem = history.items.find((item) => item.id === `dispatch:${dispatch.dispatchId}`);
    assert.equal(dispatchItem.status, "running");
    assert.equal(dispatchItem.relations.queueEntryId, queueEntry.id);

    const jobItem = history.items.find((item) => item.id === `job:${job.jobId}`);
    assert.equal(jobItem.status, "failed");
    assert.equal(jobItem.failureCode, FAILURE_CODES.QUALITY_FAIL);
    assert.equal(jobItem.failurePhase, "verify-retry-3");
    assert.equal(jobItem.reason, "verifier evidence missing");
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
  }
});

test("buildTaskHistory supports project, kind, and limit filters", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-history-cpb-"));
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-history-hub-"));

  try {
    await enqueue(hubRoot, { projectId: "flow", sourcePath: "/repo/flow", description: "flow task" });
    await enqueue(hubRoot, { projectId: "other", sourcePath: "/repo/other", description: "other task" });
    await createJob(cpbRoot, { project: "flow", task: "flow job", ts: "2026-05-20T06:00:00.000Z" });

    const history = await buildTaskHistory({
      cpbRoot,
      hubRoot,
      projectId: "flow",
      kinds: ["queue"],
      limit: 1,
    });

    assert.equal(history.summary.totalItems, 1);
    assert.equal(history.summary.visibleItems, 1);
    assert.equal(history.items.length, 1);
    assert.equal(history.items[0].kind, "queue");
    assert.equal(history.items[0].projectId, "flow");
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
  }
});
