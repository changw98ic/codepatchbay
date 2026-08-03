import assert from "node:assert/strict";
import test from "node:test";

import {
  assertLivePipelineCompleted,
  buildLivePipelineDiagnostics,
  resolveLiveWorktreeEvidence,
} from "./live-e2e/diagnostics.js";

test("live E2E diagnostics retain queue, assignment, and worker failure evidence", () => {
  const diagnostics = buildLivePipelineDiagnostics({
    queue: {
      id: "q-1",
      status: "scheduled",
      metadata: {
        failureReason: "worker lost its execution lease",
        dispatchFailure: { retryable: true, error: "inbox claim expired" },
        accessToken: "must-not-leak",
      },
    },
    assignment: {
      assignmentId: "a-q-1",
      status: "failed",
      workerId: "w-1",
      activeAttempt: 1,
      jobResult: {
        status: "failed",
        failure: { kind: "worker_crashed", reason: "provider process exited" },
      },
    },
    workers: [{
      workerId: "w-1",
      status: "exited",
      currentAssignmentId: "a-q-1",
      exitCode: 1,
      error: "provider process exited",
    }],
  });

  assert.equal(diagnostics.queue.status, "scheduled");
  assert.equal(diagnostics.queue.metadata.failureReason, "worker lost its execution lease");
  assert.equal(diagnostics.queue.metadata.accessToken, "[REDACTED]");
  assert.equal(diagnostics.assignment.status, "failed");
  assert.equal(diagnostics.assignment.workerId, "w-1");
  assert.equal(diagnostics.assignment.jobResult.failure.reason, "provider process exited");
  assert.equal(diagnostics.workers[0].status, "exited");
  assert.equal(diagnostics.workers[0].error, "provider process exited");
});

test("live E2E refuses to read result artifacts unless both terminal states completed", () => {
  assert.throws(
    () => assertLivePipelineCompleted({
      queue: { id: "q-1", status: "scheduled" },
      assignment: {
        assignmentId: "a-q-1",
        status: "failed",
        metadata: { failureReason: "worker failed before publishing result.json" },
      },
      workers: [{ workerId: "w-1", status: "exited" }],
      timedOut: false,
      timeoutMs: 900_000,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal("code" in error ? error.code : null, "CPB_LIVE_PIPELINE_TERMINAL_FAILURE");
      assert.match(error.message, /worker failed before publishing result\.json/);
      assert.equal(
        "diagnostics" in error
          && error.diagnostics
          && typeof error.diagnostics === "object"
          && "assignment" in error.diagnostics
          && error.diagnostics.assignment
          && typeof error.diagnostics.assignment === "object"
          && "status" in error.diagnostics.assignment
          ? error.diagnostics.assignment.status
          : null,
        "failed",
      );
      return true;
    },
  );

  assert.doesNotThrow(() => assertLivePipelineCompleted({
    queue: { id: "q-2", status: "completed" },
    assignment: { assignmentId: "a-q-2", status: "completed", workerId: "w-2" },
    workers: [{ workerId: "w-2", status: "idle" }],
    timedOut: false,
    timeoutMs: 900_000,
  }));
});

test("live E2E timeout errors include the last scheduler and worker state", () => {
  assert.throws(
    () => assertLivePipelineCompleted({
      queue: { id: "q-3", status: "scheduled" },
      assignment: { assignmentId: "a-q-3", status: "assigned", workerId: "w-3" },
      workers: [{ workerId: "w-3", status: "busy", currentAssignmentId: "a-q-3" }],
      timedOut: true,
      timeoutMs: 30_000,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal("code" in error ? error.code : null, "CPB_LIVE_PIPELINE_TIMEOUT");
      assert.match(error.message, /30000ms/);
      assert.match(error.message, /scheduled/);
      assert.match(error.message, /assigned/);
      assert.match(error.message, /busy/);
      return true;
    },
  );
});

test("live E2E reads completed edits from verified worktree quarantine evidence", () => {
  const evidence = resolveLiveWorktreeEvidence({
    status: "completed",
    cleanup: {
      worktree: {
        disposition: "quarantined",
        ok: true,
        cleanupVerified: true,
        canonicalPathRemoved: true,
        quarantinePreserved: true,
        quarantinePath: "/tmp/cpb-live-worktrees/.cpb-cleanup-quarantine-1/worktree",
      },
    },
  });

  assert.equal(evidence.path, "/tmp/cpb-live-worktrees/.cpb-cleanup-quarantine-1/worktree");
  assert.equal(evidence.cleanup.disposition, "quarantined");
  assert.equal(evidence.cleanup.cleanupVerified, true);

  assert.throws(
    () => resolveLiveWorktreeEvidence({
      status: "completed",
      cleanup: { worktree: { disposition: "quarantined", cleanupVerified: false } },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal("code" in error ? error.code : null, "CPB_LIVE_WORKTREE_EVIDENCE_INVALID");
      return true;
    },
  );
});
