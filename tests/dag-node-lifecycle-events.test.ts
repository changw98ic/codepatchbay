import assert from "node:assert/strict";
import { test } from "node:test";

import {
  emitDagNodeCompletedEvent,
  emitDagNodeSkippedEvent,
} from "../core/engine/dag-node-lifecycle-events.js";

test("emitDagNodeSkippedEvent writes resume skip event and progress payload", async () => {
  const events: Record<string, unknown>[] = [];
  const progress: Record<string, unknown>[] = [];

  await emitDagNodeSkippedEvent({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-skip",
    nodeId: "verify-1",
    phase: "verify",
    role: "verifier",
    dagNode: { checklistIds: ["AC-2"] },
    resumeTarget: "execute-1",
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
      events.push(event);
    },
    onProgress: async (event: Record<string, unknown>) => {
      progress.push(event);
    },
    now: () => "2026-06-22T00:00:00.000Z",
  });

  assert.deepEqual(events, [{
    type: "dag_node_skipped",
    jobId: "job-skip",
    project: "proj",
    nodeId: "verify-1",
    phase: "verify",
    role: "verifier",
    reason: "resume_completed_node",
    resumeTarget: "execute-1",
    checklistIds: ["AC-2"],
    ts: "2026-06-22T00:00:00.000Z",
  }]);
  assert.deepEqual(progress, [{
    ts: "2026-06-22T00:00:00.000Z",
    type: "dag_node_skipped",
    jobId: "job-skip",
    project: "proj",
    nodeId: "verify-1",
    phase: "verify",
    role: "verifier",
    reason: "resume_completed_node",
  }]);
});

test("emitDagNodeCompletedEvent writes completion event with artifact and checklist ids", async () => {
  const events: Record<string, unknown>[] = [];

  await emitDagNodeCompletedEvent({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-complete",
    nodeId: "execute-1",
    phase: "execute",
    role: "executor",
    attemptId: "attempt-1",
    artifactName: "deliverable-1",
    dagNode: { checklistIds: ["AC-1", "AC-3"] },
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
      events.push(event);
    },
    now: () => "2026-06-22T00:00:00.000Z",
  });

  assert.deepEqual(events, [{
    type: "dag_node_completed",
    jobId: "job-complete",
    project: "proj",
    nodeId: "execute-1",
    phase: "execute",
    role: "executor",
    attemptId: "attempt-1",
    artifact: "deliverable-1",
    checklistIds: ["AC-1", "AC-3"],
    ts: "2026-06-22T00:00:00.000Z",
  }]);
});

test("emitDagNodeSkippedEvent keeps progress best-effort after durable event write", async () => {
  const events: Record<string, unknown>[] = [];

  await emitDagNodeSkippedEvent({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-progress-failure",
    nodeId: "plan",
    phase: "plan",
    role: "planner",
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
      events.push(event);
    },
    onProgress: async () => {
      throw new Error("progress sink unavailable");
    },
    now: () => "2026-06-22T00:00:00.000Z",
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "dag_node_skipped");
});
