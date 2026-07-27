/**
 * TaskView projection tests — Phase 1 (WAVE 1).
 *
 * These tests pin the behavior of `projectTaskView` in
 * `server/services/task/task-view.ts`:
 *   (a) queue-only projection (entry exists, job absent) -> state accepted|queued
 *       and NO forbidden fields leak;
 *   (b) job-linked running -> state running;
 *   (c) terminal job -> succeeded|failed|canceled;
 *   (d) blocked queue entry -> blocked|needs_input;
 *   (e) unknown taskId -> null;
 *   (f) a seeded record carrying forbidden fields is fully sanitized.
 *
 * State is seeded by writing the durable artifacts the real services read:
 *   - `hubRoot/queue/queue.json`        (the queue entry — authoritative for task id)
 *   - `dataRoot/jobs-index.json`        (the job projection index)
 *   - `dataRoot/events/<project>/<jobId>.jsonl` (a minimal event stream so the
 *     index entry is not treated as orphaned by `mergeMissingEventStreams`)
 *
 * No fake/injected projection layer is used — the projection reads the same
 * authoritative state the production path reads. The tests are deterministic
 * (no real workers, no ACP, no network).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { projectTaskView } from "../server/services/task/task-view.js";
import {
  TASK_VIEW_SCHEMA_VERSION,
  TaskState,
  TERMINAL_TASK_STATES,
  type TaskView,
} from "../core/contracts/task-view.js";
import {
  FORBIDDEN_TASKVIEW_FIELDS,
  PUBLIC_TASKVIEW_FIELDS,
} from "../core/contracts/task-view-fields.js";
import { tempRoot, writeJson } from "./helpers.js";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

// ─── fixtures ────────────────────────────────────────────────────────────────

const PROJECT = "proj";
const TASK_ID = "q-task-001";

type QueueEntry = Record<string, unknown>;

function queueEntry(overrides: QueueEntry = {}): QueueEntry {
  return {
    id: TASK_ID,
    projectId: PROJECT,
    description: "Add a --json flag to cpb status",
    status: "pending",
    priority: "P2",
    type: "candidate",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Write `hubRoot/queue/queue.json` with `entries`. This is the durable shape
 * `loadQueue` reads (version 1 + entries array). `loadQueue` is a pure read —
 * no hub writability check — so writing the file directly is sufficient.
 */
async function seedQueue(hubRoot: string, entries: QueueEntry[]): Promise<void> {
  await writeJson(path.join(hubRoot, "queue", "queue.json"), { version: 1, entries });
}

type JobState = Record<string, unknown>;

/**
 * Write a job projection the way `listJobsFromIndex` reads it:
 *   - `dataRoot/jobs-index.json` with a well-formed `_meta` + the job under
 *     key `<project>/<jobId>`.
 *   - `dataRoot/events/<project>/<jobId>.jsonl` with a single `job_created`
 *     event so the entry is not treated as orphaned by
 *     `mergeMissingEventStreams` (which deletes index entries lacking a
 *     matching event file).
 *
 * `mergeMissingEventStreams` skips re-materialization when the index already
 * has the key, so the seeded JobState is the authoritative projection read.
 */
async function seedJob(dataRoot: string, jobId: string, job: JobState): Promise<void> {
  const eventFile = path.join(dataRoot, "events", PROJECT, `${jobId}.jsonl`);
  await mkdir(path.dirname(eventFile), { recursive: true });
  await writeFile(
    eventFile,
    `${JSON.stringify({
      type: "job_created",
      jobId,
      project: PROJECT,
      ts: "2026-07-27T00:00:00.000Z",
    })}\n`,
    "utf8",
  );
  const key = `${PROJECT}/${jobId}`;
  await writeJson(path.join(dataRoot, "jobs-index.json"), {
    _meta: { version: 1, updatedAt: "2026-07-27T00:00:00.000Z", jobCount: 1 },
    jobs: { [key]: { createdAt: "2026-07-27T00:00:00.000Z", project: PROJECT, jobId, ...job } },
  });
}

/**
 * Assert that `view` contains exactly the public whitelist and not a single
 * forbidden field. The output TaskView is constructed by the projection; this
 * is the load-bearing boundary check that no internal runtime detail leaks.
 */
function assertOnlyPublicFields(view: TaskView, label: string): void {
  const keys = Object.keys(view).sort();
  const whitelist = [...PUBLIC_TASKVIEW_FIELDS].sort();
  assert.deepEqual(keys, whitelist, `${label}: TaskView keys must exactly equal PUBLIC_TASKVIEW_FIELDS`);
  for (const field of FORBIDDEN_TASKVIEW_FIELDS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(view, field),
      false,
      `${label}: forbidden field "${field}" must not appear on TaskView`,
    );
  }
}

// ─── (e) unknown taskId -> null ──────────────────────────────────────────────

test("(e) projectTaskView returns null when taskId matches no queue entry", async () => {
  const root = await tempRoot("cpb-task-view-unknown");
  const hubRoot = path.join(root, "hub");
  const dataRoot = path.join(root, "data");
  // Queue exists but has no entry for TASK_ID.
  await seedQueue(hubRoot, [
    queueEntry({ id: "q-different", projectId: PROJECT, status: "pending" }),
  ]);

  const view = await projectTaskView(root, PROJECT, TASK_ID, { hubRoot, dataRoot });
  assert.equal(view, null, "unknown taskId must project to null");
});

// ─── (isolation) cross-project taskId must NOT resolve ───────────────────────

test("(isolation) projectTaskView never returns another project's task by id", async () => {
  const root = await tempRoot("cpb-task-view-xproject");
  const hubRoot = path.join(root, "hub");
  const dataRoot = path.join(root, "data");
  // TASK_ID exists in the queue but is owned by a DIFFERENT project. A
  // cross-project id-only fallback would leak it across the project boundary;
  // the projection must return null instead (plan §3.2: taskId is project-scoped).
  await seedQueue(hubRoot, [
    queueEntry({ id: TASK_ID, projectId: "other-project", status: "pending" }),
  ]);

  const view = await projectTaskView(root, PROJECT, TASK_ID, { hubRoot, dataRoot });
  assert.equal(view, null, "a task id owned by another project must not resolve (no cross-project fallback)");
});

// ─── (a) queue-only projection: entry exists, job absent ─────────────────────

test("(a) queue-only pending entry projects to queued with no forbidden fields", async () => {
  const root = await tempRoot("cpb-task-view-queued");
  const hubRoot = path.join(root, "hub");
  const dataRoot = path.join(root, "data");
  await seedQueue(hubRoot, [queueEntry({ status: "pending" })]);

  const view = await projectTaskView(root, PROJECT, TASK_ID, { hubRoot, dataRoot });

  assert.ok(view, "queue entry must project to a TaskView");
  assert.equal(view.schemaVersion, TASK_VIEW_SCHEMA_VERSION);
  assert.equal(view.taskId, TASK_ID);
  // Queue-only pending -> the transient `accepted` has already evolved to
  // `queued` (the entry is durably persisted by the time we read it).
  assert.ok(
    view.state === TaskState.Queued || view.state === TaskState.Accepted,
    `queue-only pending state must be accepted|queued, got ${view.state}`,
  );
  assert.equal(view.state, TaskState.Queued);
  // Summary falls back to the queue entry description when no job task exists.
  assert.equal(view.summary, "Add a --json flag to cpb status");
  assert.equal(view.createdAt, "2026-07-27T00:00:00.000Z");
  assert.equal(view.updatedAt, "2026-07-27T00:00:00.000Z");
  assertOnlyPublicFields(view, "queue-only");
});

test("(a) queue-only `needs_issue_link` entry projects to needs_input", async () => {
  const root = await tempRoot("cpb-task-view-needs-input");
  const hubRoot = path.join(root, "hub");
  const dataRoot = path.join(root, "data");
  await seedQueue(hubRoot, [
    queueEntry({ status: "needs_issue_link", reason: "link a tracking issue" }),
  ]);

  const view = await projectTaskView(root, PROJECT, TASK_ID, { hubRoot, dataRoot });
  assert.ok(view);
  assert.equal(view.state, TaskState.NeedsInput);
  // The user-facing next action invites a response.
  assert.equal(view.nextAction.kind, "respond");
  assertOnlyPublicFields(view, "needs_input");
});

// ─── (b) job-linked running -> running ───────────────────────────────────────

test("(b) job-linked running execution (execute phase) projects to running", async () => {
  const root = await tempRoot("cpb-task-view-running");
  const hubRoot = path.join(root, "hub");
  const dataRoot = path.join(root, "data");
  await seedQueue(hubRoot, [queueEntry({ status: "in_progress" })]);
  await seedJob(dataRoot, "job-running", {
    queueEntryId: TASK_ID,
    status: "running",
    phase: "execute",
    task: "Add a --json flag to cpb status",
    createdAt: "2026-07-27T00:00:01.000Z",
    updatedAt: "2026-07-27T00:10:00.000Z",
  });

  const view = await projectTaskView(root, PROJECT, TASK_ID, { hubRoot, dataRoot });

  assert.ok(view);
  assert.equal(view.state, TaskState.Running);
  // Summary prefers the job task when present.
  assert.equal(view.summary, "Add a --json flag to cpb status");
  // updatedAt is the latest of (entry, job).
  assert.equal(view.updatedAt, "2026-07-27T00:10:00.000Z");
  assertOnlyPublicFields(view, "running");
});

test("(b) job-linked running verify phase projects to verifying", async () => {
  const root = await tempRoot("cpb-task-view-verifying");
  const hubRoot = path.join(root, "hub");
  const dataRoot = path.join(root, "data");
  await seedQueue(hubRoot, [queueEntry({ status: "in_progress" })]);
  await seedJob(dataRoot, "job-verifying", {
    queueEntryId: TASK_ID,
    status: "running",
    phase: "verify",
    task: "Verify the json flag works",
    createdAt: "2026-07-27T00:00:01.000Z",
    updatedAt: "2026-07-27T00:20:00.000Z",
  });

  const view = await projectTaskView(root, PROJECT, TASK_ID, { hubRoot, dataRoot });
  assert.ok(view);
  assert.equal(view.state, TaskState.Verifying);
  assertOnlyPublicFields(view, "verifying");
});

// ─── (c) terminal job -> succeeded|failed|canceled ───────────────────────────

test("(c) completed job with PASS verdict + complete gate projects to succeeded", async () => {
  const root = await tempRoot("cpb-task-view-succeeded");
  const hubRoot = path.join(root, "hub");
  const dataRoot = path.join(root, "data");
  await seedQueue(hubRoot, [queueEntry({ status: "completed" })]);
  await seedJob(dataRoot, "job-succeeded", {
    queueEntryId: TASK_ID,
    status: "completed",
    phase: "verify",
    task: "Add a --json flag to cpb status",
    verdict: "PASS",
    completionGate: { outcome: "complete", reason: "all gates passed" },
    completionReport: {
      outcome: "complete",
      candidateValidation: {
        unmappedChangedFiles: ["src/status.ts", "docs/status.md"],
      },
    },
    createdAt: "2026-07-27T00:00:01.000Z",
    updatedAt: "2026-07-27T00:30:00.000Z",
  });

  const view = await projectTaskView(root, PROJECT, TASK_ID, { hubRoot, dataRoot });
  assert.ok(view);
  assert.equal(view.state, TaskState.Succeeded);
  assert.equal(TERMINAL_TASK_STATES.includes(view.state), true);
  // repo-relative changed files surface; absolute paths would be filtered.
  assert.deepEqual(view.changedFiles, ["src/status.ts", "docs/status.md"]);
  // progress reflects a clean pass.
  assert.equal(view.progress.ratio, 1);
  assertOnlyPublicFields(view, "succeeded");
});

test("(c) completed job WITHOUT passing verification projects to failed (never succeeded)", async () => {
  const root = await tempRoot("cpb-task-view-completed-unverified");
  const hubRoot = path.join(root, "hub");
  const dataRoot = path.join(root, "data");
  await seedQueue(hubRoot, [queueEntry({ status: "completed" })]);
  await seedJob(dataRoot, "job-completed-unverified", {
    queueEntryId: TASK_ID,
    status: "completed",
    phase: "verify",
    task: "Add a --json flag to cpb status",
    // No verdict / no completionGate — ran to completion but verification did
    // not pass. The contract forbids calling this `succeeded`.
    createdAt: "2026-07-27T00:00:01.000Z",
    updatedAt: "2026-07-27T00:30:00.000Z",
  });

  const view = await projectTaskView(root, PROJECT, TASK_ID, { hubRoot, dataRoot });
  assert.ok(view);
  assert.equal(view.state, TaskState.Failed, "completed-without-verification must be `failed`, never `succeeded`");
  assert.equal(TERMINAL_TASK_STATES.includes(view.state), true);
  assertOnlyPublicFields(view, "completed-unverified");
});

test("(c) failed job projects to failed", async () => {
  const root = await tempRoot("cpb-task-view-failed");
  const hubRoot = path.join(root, "hub");
  const dataRoot = path.join(root, "data");
  await seedQueue(hubRoot, [queueEntry({ status: "failed" })]);
  await seedJob(dataRoot, "job-failed", {
    queueEntryId: TASK_ID,
    status: "failed",
    phase: "execute",
    task: "Add a --json flag to cpb status",
    failurePhase: "execute",
    failureCause: { reason: "compile error in status.ts" },
    createdAt: "2026-07-27T00:00:01.000Z",
    updatedAt: "2026-07-27T00:05:00.000Z",
  });

  const view = await projectTaskView(root, PROJECT, TASK_ID, { hubRoot, dataRoot });
  assert.ok(view);
  assert.equal(view.state, TaskState.Failed);
  assert.equal(view.nextAction.kind, "retry");
  assertOnlyPublicFields(view, "failed");
});

test("(c) cancelled job projects to canceled (both US and GB spelling)", async () => {
  const root = await tempRoot("cpb-task-view-canceled");
  const hubRoot = path.join(root, "hub");
  const dataRoot = path.join(root, "data");
  await seedQueue(hubRoot, [queueEntry({ status: "cancelled" })]);
  await seedJob(dataRoot, "job-canceled", {
    queueEntryId: TASK_ID,
    status: "cancelled",
    task: "Add a --json flag to cpb status",
    createdAt: "2026-07-27T00:00:01.000Z",
    updatedAt: "2026-07-27T00:02:00.000Z",
  });

  const view = await projectTaskView(root, PROJECT, TASK_ID, { hubRoot, dataRoot });
  assert.ok(view);
  assert.equal(view.state, TaskState.Canceled);
  assert.equal(TERMINAL_TASK_STATES.includes(view.state), true);
  assertOnlyPublicFields(view, "canceled");
});

// ─── (d) blocked queue entry -> blocked ──────────────────────────────────────

test("(d) blocked job projects to blocked with a wait next action", async () => {
  const root = await tempRoot("cpb-task-view-blocked");
  const hubRoot = path.join(root, "hub");
  const dataRoot = path.join(root, "data");
  await seedQueue(hubRoot, [queueEntry({ status: "blocked" })]);
  await seedJob(dataRoot, "job-blocked", {
    queueEntryId: TASK_ID,
    status: "blocked",
    phase: "review",
    task: "Add a --json flag to cpb status",
    blockedReason: "waiting on human approval",
    createdAt: "2026-07-27T00:00:01.000Z",
    updatedAt: "2026-07-27T00:15:00.000Z",
  });

  const view = await projectTaskView(root, PROJECT, TASK_ID, { hubRoot, dataRoot });
  assert.ok(view);
  assert.equal(view.state, TaskState.Blocked);
  assert.equal(view.nextAction.kind, "wait");
  assertOnlyPublicFields(view, "blocked");
});

test("(d) codegraph_unavailable queue entry projects to blocked (runtime gate)", async () => {
  const root = await tempRoot("cpb-task-view-codegraph");
  const hubRoot = path.join(root, "hub");
  const dataRoot = path.join(root, "data");
  await seedQueue(hubRoot, [queueEntry({ status: "codegraph_unavailable" })]);

  const view = await projectTaskView(root, PROJECT, TASK_ID, { hubRoot, dataRoot });
  assert.ok(view);
  assert.equal(view.state, TaskState.Blocked);
  assertOnlyPublicFields(view, "codegraph-blocked");
});

// ─── (f) seeded forbidden fields are fully sanitized in output ───────────────

test("(f) a seeded record carrying every forbidden category is fully sanitized in output", async () => {
  const root = await tempRoot("cpb-task-view-sanitize");
  const hubRoot = path.join(root, "hub");
  const dataRoot = path.join(root, "data");

  // The queue entry carries runtime concurrency + host-layout fields that
  // exist on the real QueueEntry shape (sessionId, workerId, cwd, sourcePath,
  // claimedBy). None of these may reach the public TaskView.
  await seedQueue(hubRoot, [
    queueEntry({
      status: "in_progress",
      sessionId: "LEAK-session-abc",
      workerId: "LEAK-worker-1",
      cwd: "/private/var/LEAK/cwd",
      sourcePath: "/private/var/LEAK/source",
      claimedBy: "LEAK-claimed-by",
      claimedAt: "2026-07-27T00:00:00.000Z",
    }),
  ]);
  // The job carries execution-backend identity + runtime primitives that must
  // never be surfaced (agent, leaseId, executor, worktree, attemptId, PID,
  // prompt, env, provider). These are present on the internal JobState.
  await seedJob(dataRoot, "job-leak", {
    queueEntryId: TASK_ID,
    status: "running",
    phase: "execute",
    task: "Add a --json flag to cpb status",
    agent: "LEAK-codex",
    provider: "LEAK-openai",
    leaseId: "LEAK-lease-123",
    attemptId: "LEAK-attempt-7",
    executor: { root: "/private/var/LEAK/executor", releaseId: "LEAK-release" },
    worktree: "/private/var/LEAK/worktree",
    prompt: "LEAK-prompt-content-with-secrets",
    env: { SECRET_TOKEN: "LEAK-secret" },
    PID: 99999,
    createdAt: "2026-07-27T00:00:01.000Z",
    updatedAt: "2026-07-27T00:10:00.000Z",
  });

  const view = await projectTaskView(root, PROJECT, TASK_ID, { hubRoot, dataRoot });

  assert.ok(view, "a sanitized TaskView must still be produced");
  assert.equal(view.state, TaskState.Running);
  // The full forbidden set is absent — this is the load-bearing assertion.
  for (const field of FORBIDDEN_TASKVIEW_FIELDS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(view, field),
      false,
      `forbidden field "${field}" leaked into TaskView`,
    );
    assert.equal(
      (view as unknown as Record<string, unknown>)[field],
      undefined,
      `forbidden field "${field}" must be undefined on TaskView`,
    );
  }
  // The public whitelist is exactly what remains.
  assertOnlyPublicFields(view, "sanitized");
  // And the summary — the only place user-authored text surfaces — does not
  // echo any leaked runtime value (it comes from job.task, not the forbidden
  // fields).
  assert.equal(view.summary, "Add a --json flag to cpb status");
  // changedFiles is empty (no completion report); no absolute path leaks.
  assert.deepEqual(view.changedFiles, []);
});

// ─── bonus: schema version + taskId stability ────────────────────────────────

test("projected TaskView always carries the frozen schema version and opaque taskId", async () => {
  const root = await tempRoot("cpb-task-view-schema");
  const hubRoot = path.join(root, "hub");
  const dataRoot = path.join(root, "data");
  await seedQueue(hubRoot, [queueEntry({ status: "pending" })]);

  const view = await projectTaskView(root, PROJECT, TASK_ID, { hubRoot, dataRoot });
  assert.ok(view);
  assert.equal(view.schemaVersion, TASK_VIEW_SCHEMA_VERSION);
  // taskId is the queue entry id verbatim (no job id substitution).
  assert.equal(view.taskId, TASK_ID);
});
