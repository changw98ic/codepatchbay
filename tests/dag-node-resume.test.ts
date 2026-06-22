import assert from "node:assert/strict";
import { test } from "node:test";

import { handleResumeCompletedDagNode } from "../core/engine/dag-node-resume.js";

test("handleResumeCompletedDagNode records artifact state, phase result, skip event, and progress", async () => {
  const state: Record<string, unknown> = { planId: null, deliverableId: null };
  const phaseResults: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const progress: Record<string, unknown>[] = [];

  await handleResumeCompletedDagNode({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-resume",
    nodeId: "execute-1",
    phase: "execute",
    role: "executor",
    dagNode: { checklistIds: ["AC-1"] },
    artifact: { name: "deliverable-abc123", path: "/tmp/deliverable.md" },
    verdict: { status: "pass" },
    resumeTarget: "execute-1",
    state,
    phaseResults,
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
      events.push(event);
    },
    onProgress: async (event: Record<string, unknown>) => {
      progress.push(event);
    },
    now: () => "2026-06-22T00:00:00.000Z",
  });

  assert.equal(state.deliverableId, "abc123");
  assert.deepEqual(phaseResults, [{
    schemaVersion: 1,
    phase: "execute",
    status: "passed",
    artifact: { name: "deliverable-abc123", path: "/tmp/deliverable.md" },
    verdict: { status: "pass" },
    failure: null,
    diagnostics: {
      skipped: true,
      reason: "resume_completed_node",
      nodeId: "execute-1",
      resumeTarget: "execute-1",
    },
    createdAt: "2026-06-22T00:00:00.000Z",
  }]);
  assert.deepEqual(events, [{
    type: "dag_node_skipped",
    jobId: "job-resume",
    project: "proj",
    nodeId: "execute-1",
    phase: "execute",
    role: "executor",
    reason: "resume_completed_node",
    resumeTarget: "execute-1",
    checklistIds: ["AC-1"],
    ts: "2026-06-22T00:00:00.000Z",
  }]);
  assert.deepEqual(progress, [{
    ts: "2026-06-22T00:00:00.000Z",
    type: "dag_node_skipped",
    jobId: "job-resume",
    project: "proj",
    nodeId: "execute-1",
    phase: "execute",
    role: "executor",
    reason: "resume_completed_node",
  }]);
});

test("handleResumeCompletedDagNode preserves skipped result when artifact is absent", async () => {
  const state: Record<string, unknown> = { planId: "plan-1", deliverableId: null };
  const phaseResults: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];

  await handleResumeCompletedDagNode({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-no-artifact",
    nodeId: "verify",
    phase: "verify",
    role: "verifier",
    artifact: null,
    verdict: null,
    resumeTarget: "verify",
    state,
    phaseResults,
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
      events.push(event);
    },
    now: () => "2026-06-22T00:00:00.000Z",
  });

  assert.deepEqual(state, { planId: "plan-1", deliverableId: null });
  assert.equal(phaseResults.length, 1);
  assert.equal(phaseResults[0].status, "passed");
  assert.equal(phaseResults[0].artifact, null);
  assert.deepEqual(phaseResults[0].diagnostics, {
    skipped: true,
    reason: "resume_completed_node",
    nodeId: "verify",
    resumeTarget: "verify",
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "dag_node_skipped");
});
