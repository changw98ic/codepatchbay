import assert from "node:assert/strict";
import { test } from "node:test";

import { emitDiagnosticArtifactEvents, writeRuntimeArtifactEvent } from "../core/engine/runtime-artifact-events.js";

test("writeRuntimeArtifactEvent emits the artifact_created event shape used by the artifact index", async () => {
  const events: Record<string, any>[] = [];

  await writeRuntimeArtifactEvent({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-artifact",
    phase: "prepare_task",
    artifact: {
      kind: "acceptance-checklist",
      name: "acceptance-checklist-1",
      id: "artifact-1",
      sha256: "abc123",
    },
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, any>) => {
      events.push(event);
    },
    attemptId: "attempt-1",
    now: () => "2026-06-22T00:00:00.000Z",
  });

  assert.deepEqual(events, [{
    type: "artifact_created",
    jobId: "job-artifact",
    project: "proj",
    phase: "prepare_task",
    kind: "acceptance-checklist",
    artifactKind: "acceptance-checklist",
    artifact: "acceptance-checklist-1",
    artifactId: "artifact-1",
    attemptId: "attempt-1",
    sha256: "abc123",
    ts: "2026-06-22T00:00:00.000Z",
  }]);
});

test("emitDiagnosticArtifactEvents writes only side artifacts and skips the primary phase artifact", async () => {
  const events: Record<string, any>[] = [];

  await emitDiagnosticArtifactEvents({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-artifact",
    phase: "verify",
    phaseResult: {
      artifact: { name: "verdict-1" },
      diagnostics: {
        executionMap: {
          kind: "execution-map",
          name: "execution-map-1",
          id: "artifact-2",
          sha256: "def456",
        },
        primaryAgain: {
          kind: "verdict",
          name: "verdict-1",
          id: "artifact-primary",
          sha256: "should-not-emit",
        },
        evidenceLedger: {
          kind: "evidence-ledger",
          name: "evidence-ledger-1",
          id: "artifact-3",
        },
        malformed: {
          kind: "missing-name",
        },
        scalar: "ignored",
      },
    },
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, any>) => {
      events.push(event);
    },
    attemptId: null,
    now: () => "2026-06-22T00:00:00.000Z",
  });

  assert.deepEqual(events, [{
    type: "artifact_created",
    jobId: "job-artifact",
    project: "proj",
    phase: "verify",
    kind: "execution-map",
    artifactKind: "execution-map",
    artifact: "execution-map-1",
    artifactId: "artifact-2",
    attemptId: null,
    sha256: "def456",
    ts: "2026-06-22T00:00:00.000Z",
  }, {
    type: "artifact_created",
    jobId: "job-artifact",
    project: "proj",
    phase: "verify",
    kind: "evidence-ledger",
    artifactKind: "evidence-ledger",
    artifact: "evidence-ledger-1",
    artifactId: "artifact-3",
    attemptId: null,
    sha256: null,
    ts: "2026-06-22T00:00:00.000Z",
  }]);
});
