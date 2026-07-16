import assert from "node:assert/strict";
import { test } from "node:test";

import { emitPhaseResultEvent } from "../core/engine/phase-result-events.js";

test("emitPhaseResultEvent writes phase_result event and progress payload", async () => {
  const events: Record<string, unknown>[] = [];
  const progress: Record<string, unknown>[] = [];

  await emitPhaseResultEvent({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-phase",
    phase: "verify",
    agentName: "verifier-agent",
    phaseResult: {
      status: "failed",
      artifact: { name: "verdict-1" },
      diagnostics: {
        promptArtifact: { name: "prompt-1" },
        acpAuditFile: "audit.jsonl",
        usage: { inputTokens: 12, outputTokens: 3 },
      },
      failure: {
        kind: "verification_failed",
        reason: "VERDICT: FAIL",
        cause: { checklistId: "AC-1" },
      },
    },
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
      events.push(event);
    },
    onProgress: async (event: Record<string, unknown>) => {
      progress.push(event);
    },
    now: () => "2026-06-22T00:00:00.000Z",
  });

  assert.deepEqual(events, [{
    type: "phase_result",
    jobId: "job-phase",
    project: "proj",
    phase: "verify",
    agent: "verifier-agent",
    status: "failed",
    artifact: "verdict-1",
    promptArtifact: "prompt-1",
    acpAuditFile: "audit.jsonl",
    usage: { inputTokens: 12, outputTokens: 3 },
    failure: {
      kind: "verification_failed",
      reason: "VERDICT: FAIL",
      cause: { checklistId: "AC-1" },
    },
    ts: "2026-06-22T00:00:00.000Z",
  }]);
  assert.deepEqual(progress, [{
    ts: "2026-06-22T00:00:00.000Z",
    type: "phase_result",
    jobId: "job-phase",
    project: "proj",
    phase: "verify",
    agent: "verifier-agent",
    status: "failed",
    artifact: "verdict-1",
    failure: {
      kind: "verification_failed",
      reason: "VERDICT: FAIL",
      cause: { checklistId: "AC-1" },
    },
  }]);
});

test("emitPhaseResultEvent ignores progress callback failures after writing the event", async () => {
  const events: Record<string, unknown>[] = [];

  await emitPhaseResultEvent({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-progress-failure",
    phase: "plan",
    agentName: "planner-agent",
    phaseResult: { status: "passed" },
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
      events.push(event);
    },
    onProgress: async () => {
      throw new Error("progress sink unavailable");
    },
    now: () => "2026-06-22T00:00:00.000Z",
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "phase_result");
  assert.equal(events[0].status, "passed");
});

test("emitPhaseResultEvent correlates phase audit with attempt and candidate identity", async () => {
  const events: Record<string, unknown>[] = [];
  await emitPhaseResultEvent({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-candidate",
    phase: "execute",
    agentName: "codex",
    attemptId: "attempt-2",
    phaseResult: {
      status: "passed",
      diagnostics: {
        acpAuditFile: "execute-audit.jsonl",
        candidateArtifact: { identityHash: `sha256:${"a".repeat(64)}` },
      },
    },
    appendEvent: async (_cpbRoot, _project, _jobId, event) => { events.push(event); },
  });

  assert.equal(events[0].attemptId, "attempt-2");
  assert.equal(events[0].candidateId, `sha256:${"a".repeat(64)}`);
});
