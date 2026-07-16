import assert from "node:assert/strict";
import { test } from "node:test";

import { extractPhaseArtifactId, trackPassedPhaseArtifact } from "../core/engine/phase-artifact-tracker.js";

test("extractPhaseArtifactId preserves hyphen suffix and legacy id fallback behavior", () => {
  assert.equal(extractPhaseArtifactId({ name: "plan-abc123", id: "fallback-id" }), "abc123");
  assert.equal(extractPhaseArtifactId({ name: "deliverable", id: "deliverable-id" }), "deliverable-id");
  assert.equal(extractPhaseArtifactId({ name: "deliverable" }), null);
  assert.equal(extractPhaseArtifactId(null), null);
});

test("trackPassedPhaseArtifact records plan artifact id and completes the phase", async () => {
  const state: Record<string, unknown> = { planId: null, deliverableId: null };
  const completed: Record<string, unknown>[] = [];

  const tracked = await trackPassedPhaseArtifact({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-plan",
    phase: "plan",
    state,
    phaseResult: {
      status: "passed",
      artifact: { name: "plan-abc123", id: "fallback-id" },
    },
    completePhase: async (cpbRoot: string, project: string, jobId: string, payload: Record<string, unknown>) => {
      completed.push({ cpbRoot, project, jobId, payload });
    },
  });

  assert.equal(tracked, true);
  assert.equal(state.planId, "abc123");
  assert.equal(state.deliverableId, null);
  assert.deepEqual(completed, [{
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-plan",
    payload: {
      phase: "plan",
      artifact: "plan-abc123",
    },
  }]);
});

test("trackPassedPhaseArtifact records execute deliverable id with legacy id fallback", async () => {
  const state: Record<string, unknown> = { planId: "plan-1", deliverableId: null };
  const completed: Record<string, unknown>[] = [];

  const tracked = await trackPassedPhaseArtifact({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-execute",
    phase: "execute",
    state,
    phaseResult: {
      status: "passed",
      artifact: { name: "deliverable", id: "deliverable-id" },
    },
    completePhase: async (_cpbRoot: string, _project: string, _jobId: string, payload: Record<string, unknown>) => {
      completed.push(payload);
    },
  });

  assert.equal(tracked, true);
  assert.equal(state.planId, "plan-1");
  assert.equal(state.deliverableId, "deliverable-id");
  assert.deepEqual(completed, [{
    phase: "execute",
    artifact: "deliverable",
  }]);
});

test("trackPassedPhaseArtifact skips failed results and passed results without artifacts", async () => {
  const state: Record<string, unknown> = { planId: null, deliverableId: null };
  const completed: Record<string, unknown>[] = [];
  const completePhase = async (_cpbRoot: string, _project: string, _jobId: string, payload: Record<string, unknown>) => {
    completed.push(payload);
  };

  const failedTracked = await trackPassedPhaseArtifact({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-failed",
    phase: "plan",
    state,
    phaseResult: { status: "failed", artifact: { name: "plan-failed" } },
    completePhase,
  });
  const missingArtifactTracked = await trackPassedPhaseArtifact({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-missing",
    phase: "execute",
    state,
    phaseResult: { status: "passed" },
    completePhase,
  });

  assert.equal(failedTracked, false);
  assert.equal(missingArtifactTracked, false);
  assert.deepEqual(state, { planId: null, deliverableId: null });
  assert.deepEqual(completed, []);
});
