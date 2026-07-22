import assert from "node:assert/strict";
import { test } from "node:test";

import { emitPhaseStartEvents } from "../core/engine/phase-start-events.js";

test("emitPhaseStartEvents writes fallback phase_started, dag_node_started, and progress events", async () => {
  const events: Record<string, unknown>[] = [];
  const progress: Record<string, unknown>[] = [];

  await emitPhaseStartEvents({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-start",
    phase: "execute",
    role: "executor",
    nodeId: "execute-1",
    dagNode: { checklistIds: ["AC-1", "AC-2"] },
    selectedAgent: "executor-agent",
    attemptId: "attempt-1",
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
      events.push(event);
    },
    onProgress: async (event: Record<string, unknown>) => {
      progress.push(event);
    },
    now: () => "2026-06-22T00:00:00.000Z",
  });

  assert.deepEqual(events, [{
    type: "phase_started",
    jobId: "job-start",
    project: "proj",
    phase: "execute",
    attemptId: "attempt-1",
    agent: "executor-agent",
    ts: "2026-06-22T00:00:00.000Z",
  }, {
    type: "dag_node_started",
    jobId: "job-start",
    project: "proj",
    nodeId: "execute-1",
    phase: "execute",
    role: "executor",
    attempt: 1,
    attemptId: "attempt-1",
    checklistIds: ["AC-1", "AC-2"],
    ts: "2026-06-22T00:00:00.000Z",
  }]);
  assert.deepEqual(progress, [{
    ts: "2026-06-22T00:00:00.000Z",
    type: "phase_started",
    jobId: "job-start",
    project: "proj",
    phase: "execute",
    role: "executor",
    agent: "executor-agent",
  }]);
});

test("emitPhaseStartEvents uses startPhase when available and keeps progress best-effort", async () => {
  const started: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];

  await emitPhaseStartEvents({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-start-service",
    phase: "verify",
    role: "verifier",
    nodeId: "verify",
    dagNode: {},
    selectedAgent: null,
    attemptId: null,
    startPhase: async (cpbRoot: string, project: string, jobId: string, payload: Record<string, unknown>) => {
      started.push({ cpbRoot, project, jobId, payload });
    },
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
      events.push(event);
    },
    onProgress: async () => {
      throw new Error("progress sink unavailable");
    },
    now: () => "2026-06-22T00:00:00.000Z",
  });

  assert.deepEqual(started, [{
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-start-service",
    payload: {
      phase: "verify",
      agent: null,
      role: "verifier",
      attemptId: null,
    },
  }]);
  assert.deepEqual(events, [{
    type: "dag_node_started",
    jobId: "job-start-service",
    project: "proj",
    nodeId: "verify",
    phase: "verify",
    role: "verifier",
    attempt: 1,
    attemptId: null,
    checklistIds: [],
    ts: "2026-06-22T00:00:00.000Z",
  }]);
});
