/**
 * `cpb task` command tests — Phase 1 (WAVE 2).
 *
 * These tests pin the thin product entry in `cli/commands/task.ts`:
 *   (1) a known task renders state + next step and exits 0;
 *   (2) a known task in `needs_input` maps to a "reply" next step (non-trivial
 *       nextAction.kind, proving the command renders nextAction — not just
 *       state);
 *   (3) an unknown task id exits non-zero with a plain message;
 *   (4) the rendered output contains NONE of the forbidden internal terms or
 *       fields (asserted on the rendered string, across multiple states).
 *
 * The command is a thin facade over `projectTaskView`; these tests seed the
 * same durable queue file the production path reads (`<hubRoot>/queue/
 * queue.json`) and drive the command end-to-end. No fake/injected projection
 * layer is used. Deterministic: no real workers, no ACP, no network.
 *
 * The test runner clears every `CPB_*` env var at startup, so `CPB_HUB_ROOT`
 * is unset before each test; we set it explicitly to point at the seeded hub
 * root (which is what `resolveHubRoot` inside `projectTaskView` reads when the
 * command calls it without opts) and restore it on exit.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  run as runTaskCommand,
  humanResultLine,
  checkStatusById,
} from "../cli/commands/task.js";
import {
  TASK_VIEW_SCHEMA_VERSION,
  TaskState,
  type TaskStateValue,
  type TaskView,
  type TaskViewCheck,
} from "../core/contracts/task-view.js";
import { FORBIDDEN_TASKVIEW_FIELDS } from "../core/contracts/task-view-fields.js";
import { tempRoot, writeJson } from "./helpers.js";

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

/** Write `<hubRoot>/queue/queue.json` — the durable shape `loadQueue` reads. */
async function seedQueue(hubRoot: string, entries: QueueEntry[]): Promise<void> {
  await writeJson(path.join(hubRoot, "queue", "queue.json"), { version: 1, entries });
}

// ─── output capture ──────────────────────────────────────────────────────────

type Capture = {
  out: string[];
  err: string[];
  restore(): void;
};

/** Swap console.log/error for collectors; restore on `restore()`. */
function captureOutput(): Capture {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => { out.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { err.push(args.map(String).join(" ")); };
  return {
    out,
    err,
    restore() {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

/**
 * Run the task command with `CPB_HUB_ROOT` pointed at `hubRoot`, restoring the
 * prior value (or deleting it) afterwards. Returns the captured output and the
 * exit code.
 */
async function runWithCapture(
  args: string[],
  cpbRoot: string,
  hubRoot: string,
): Promise<{ exit: number; out: string[]; err: string[] }> {
  const cap = captureOutput();
  const prevHub = process.env.CPB_HUB_ROOT;
  process.env.CPB_HUB_ROOT = hubRoot;
  try {
    const exit = await runTaskCommand(args, { command: "task", cpbRoot });
    return { exit, out: [...cap.out], err: [...cap.err] };
  } finally {
    if (prevHub === undefined) delete process.env.CPB_HUB_ROOT;
    else process.env.CPB_HUB_ROOT = prevHub;
    cap.restore();
  }
}

// ─── forbidden-token assertion ───────────────────────────────────────────────

/**
 * Tokens that must NEVER appear in the rendered output:
 *   - every frozen forbidden FIELD name (lowercased) — catches accidental
 *     leakage of internal runtime identifiers / paths;
 *   - the architecture TERMS the plan §3.4 calls out (Hub, Worker, ACP,
 *     Provider, lease, session, Evidence) plus "agent" — catches accidental
 *     use of internal vocabulary in user-facing prose.
 *
 * Substring (case-insensitive) matching is safe here because the command's
 * wording is fixed and short; a future prose change that introduced one of
 * these tokens would fail this test and force a reword — which is the point.
 */
const FORBIDDEN_TOKENS: readonly string[] = [
  ...FORBIDDEN_TASKVIEW_FIELDS.map((f) => f.toLowerCase()),
  "hub",
  "worker",
  "acp",
  "evidence",
];

function assertNoForbiddenTerms(rendered: string, label: string): void {
  const lower = rendered.toLowerCase();
  for (const token of FORBIDDEN_TOKENS) {
    assert.ok(
      !lower.includes(token),
      `${label}: rendered output must not contain forbidden token "${token}". Output was:\n${rendered}`,
    );
  }
}

// ─── (1) known task: exit 0 + state + next step ──────────────────────────────

test("(1) cpb task renders state + next step for a known queued task and exits 0", { concurrency: false }, async () => {
  const root = await tempRoot("cpb-task-cmd-found");
  const hubRoot = path.join(root, "hub");
  await seedQueue(hubRoot, [queueEntry({ status: "pending" })]);

  const { exit, out } = await runWithCapture([TASK_ID, "--project", PROJECT], root, hubRoot);

  assert.equal(exit, 0, "a known task must exit 0");
  const text = out.join("\n");

  // State is rendered as a human line (queued -> "Queued ...").
  assert.match(text, /Queued/, "output must include the mapped state line");
  // nextAction is rendered as a human next step (kind "wait" here).
  assert.match(text, /Nothing for you to do right now/, "output must include the next step");
  // The summary (user-authored task text) is shown.
  assert.match(text, /Add a --json flag/);

  // Output boundary: no forbidden internal terms or fields leak.
  assertNoForbiddenTerms(text, "queued");
});

// ─── (2) known needs_input task: state + reply next step ─────────────────────

test("(2) cpb task maps needs_input to a reply next step (non-trivial nextAction)", { concurrency: false }, async () => {
  const root = await tempRoot("cpb-task-cmd-needs-input");
  const hubRoot = path.join(root, "hub");
  await seedQueue(hubRoot, [
    queueEntry({ status: "needs_issue_link", reason: "link a tracking issue" }),
  ]);

  const { exit, out } = await runWithCapture([TASK_ID, "--project", PROJECT], root, hubRoot);

  assert.equal(exit, 0);
  const text = out.join("\n");
  assert.match(text, /Needs your input/, "needs_input maps to a human state line");
  // nextAction.kind === "respond" -> a reply prompt. This proves the command
  // renders nextAction, not just state, and does NOT echo the projection's raw
  // message (which would carry the internal reason text verbatim).
  assert.match(text, /Reply with what it needs to continue/);
  assertNoForbiddenTerms(text, "needs_input");
});

// ─── (3) unknown task: exit non-zero + plain message ─────────────────────────

test("(3) cpb task exits non-zero with a plain message when the task id is unknown", { concurrency: false }, async () => {
  const root = await tempRoot("cpb-task-cmd-unknown");
  const hubRoot = path.join(root, "hub");
  // Queue exists but holds a different id — TASK_ID must not resolve.
  await seedQueue(hubRoot, [
    queueEntry({ id: "q-different", projectId: PROJECT, status: "pending" }),
  ]);

  const { exit, out, err } = await runWithCapture([TASK_ID, "--project", PROJECT], root, hubRoot);

  assert.notEqual(exit, 0, "an unknown task must exit non-zero");
  assert.equal(exit, 1, "the unknown-task exit code is 1");

  // The message goes to stderr and stays plain (no internal terms).
  const errText = err.join("\n");
  assert.match(errText, /No task found/);
  // Nothing is printed to stdout for a miss.
  assert.equal(out.length, 0, "stdout must be empty on a miss");
  assertNoForbiddenTerms(errText, "unknown");
});

// ─── (4) missing task-id: usage error, exit non-zero ─────────────────────────

test("(4) cpb task with no task id prints usage and exits non-zero", { concurrency: false }, async () => {
  const root = await tempRoot("cpb-task-cmd-noarg");
  const hubRoot = path.join(root, "hub");
  await seedQueue(hubRoot, [queueEntry()]);

  const { exit, err } = await runWithCapture(["--project", PROJECT], root, hubRoot);

  assert.equal(exit, 1);
  assert.match(err.join("\n"), /Usage: cpb task/);
});

// ─── (5) forbidden terms/fields absent across every rendered state ───────────

test("(5) rendered output never contains a forbidden internal term or field, across states", { concurrency: false }, async () => {
  const cases: Array<{ label: string; entry: QueueEntry }> = [
    { label: "queued", entry: queueEntry({ status: "pending" }) },
    { label: "needs_input", entry: queueEntry({ status: "needs_issue_link", reason: "link a tracking issue" }) },
    { label: "blocked", entry: queueEntry({ status: "blocked" }) },
    { label: "completed-queue", entry: queueEntry({ status: "completed" }) },
    { label: "failed-queue", entry: queueEntry({ status: "failed" }) },
    { label: "canceled-queue", entry: queueEntry({ status: "canceled" }) },
  ];

  for (const { label, entry } of cases) {
    const root = await tempRoot(`cpb-task-cmd-clean-${label}`);
    const hubRoot = path.join(root, "hub");
    // Seed the entry carrying the leak-prone runtime fields a real QueueEntry
    // can hold (sessionId, workerId, cwd, sourcePath, claimedBy, originJobId,
    // retryJobId). The command must not echo any of them — they are forbidden
    // fields. This is the load-bearing boundary check on the RENDERED string
    // (the projection's own sanitize boundary is covered in
    // task-view-projection.test.ts).
    await seedQueue(hubRoot, [{
      ...entry,
      sessionId: "LEAK-session-abc",
      workerId: "LEAK-worker-1",
      cwd: "/private/var/LEAK/cwd",
      sourcePath: "/private/var/LEAK/source",
      claimedBy: "LEAK-claimed-by",
      metadata: { retryJobId: "LEAK-retry-job", originJobId: "LEAK-origin-job" },
    }]);

    const { exit, out, err } = await runWithCapture([TASK_ID, "--project", PROJECT], root, hubRoot);
    assert.equal(exit, 0, `${label}: task must be found and rendered`);

    const rendered = [...out, ...err].join("\n");
    assertNoForbiddenTerms(rendered, label);

    // Positive guard: the leaked runtime values themselves must not appear.
    assert.ok(
      !rendered.includes("LEAK"),
      `${label}: rendered output must not echo any seeded LEAK value. Output was:\n${rendered}`,
    );
  }
});

// ─── (6) humanResultLine / checkStatusById: pure distinction unit tests ──────
//
// The Result line is the load-bearing Phase 2 output. These pure tests pin the
// three-way distinction (verified / not-verified / deliveryReady) and the
// absence of every forbidden internal term, independent of the projection.

function check(
  id: string,
  status: TaskViewCheck["status"],
  required = true,
): TaskViewCheck {
  return { id, requirement: `${id} dimension`, status, required };
}

function viewWith(state: TaskStateValue, checks: TaskViewCheck[]): TaskView {
  return {
    schemaVersion: TASK_VIEW_SCHEMA_VERSION,
    taskId: "t",
    state,
    summary: "",
    progress: { ratio: null, label: "" },
    checks,
    changedFiles: [],
    nextAction: { kind: null, message: "" },
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
  };
}

test("(6a) humanResultLine: verified + deliveryReady -> 'Verified - ready to deliver.'", () => {
  const line = humanResultLine(
    viewWith(TaskState.Succeeded, [
      check("completed", "pass"),
      check("verified", "pass"),
      check("deliveryReady", "pass", false),
      check("evidence", "pass"),
    ]),
  );
  assert.equal(line, "Verified - ready to deliver.");
});

test("(6b) humanResultLine: verified but not deliveryReady -> 'Done and verified, not yet delivered.'", () => {
  const line = humanResultLine(
    viewWith(TaskState.Succeeded, [
      check("completed", "pass"),
      check("verified", "pass"),
      check("deliveryReady", "unchecked", false),
      check("evidence", "pass"),
    ]),
  );
  assert.equal(line, "Done and verified, not yet delivered.");
});

test("(6c) humanResultLine: succeeded state but not verified -> 'Completed but not verified.'", () => {
  const line = humanResultLine(
    viewWith(TaskState.Succeeded, [
      check("completed", "pass"),
      check("verified", "fail"),
      check("deliveryReady", "unchecked", false),
      check("evidence", "fail"),
    ]),
  );
  assert.equal(line, "Completed but not verified.");
});

test("(6d) humanResultLine: non-terminal states render no result line", () => {
  for (const state of [
    TaskState.Queued,
    TaskState.Running,
    TaskState.Verifying,
    TaskState.NeedsInput,
    TaskState.Blocked,
  ]) {
    const line = humanResultLine(
      viewWith(state, [
        check("completed", "unchecked"),
        check("verified", "unchecked"),
        check("deliveryReady", "unchecked", false),
        check("evidence", "unchecked"),
      ]),
    );
    assert.equal(line, "", `${state}: no result line while the task is in flight`);
  }
});

test("(6e) humanResultLine: failed/canceled render no result line (the State line already signals the outcome)", () => {
  for (const state of [TaskState.Failed, TaskState.Canceled]) {
    const line = humanResultLine(
      viewWith(state, [
        check("completed", "pass"),
        check("verified", "fail"),
        check("deliveryReady", "unchecked", false),
        check("evidence", "fail"),
      ]),
    );
    assert.equal(
      line,
      "",
      `${state}: no result line — avoids contradicting the "Did not succeed" / "Canceled" State line`,
    );
  }
});

test("(6f) humanResultLine never emits a forbidden internal term or field name", () => {
  const cases = [
    viewWith(TaskState.Succeeded, [
      check("completed", "pass"),
      check("verified", "pass"),
      check("deliveryReady", "pass", false),
      check("evidence", "pass"),
    ]),
    viewWith(TaskState.Succeeded, [
      check("completed", "pass"),
      check("verified", "pass"),
      check("deliveryReady", "unchecked", false),
      check("evidence", "pass"),
    ]),
    viewWith(TaskState.Succeeded, [
      check("completed", "pass"),
      check("verified", "fail"),
      check("deliveryReady", "unchecked", false),
      check("evidence", "fail"),
    ]),
  ];
  for (const v of cases) {
    const line = humanResultLine(v);
    // The line may be non-empty or empty; either way it must carry no token.
    assertNoForbiddenTerms(line, `state=${v.state}`);
  }
});

test("(6g) checkStatusById returns the status for a known dimension and '' when absent", () => {
  const v = viewWith(TaskState.Succeeded, [
    check("verified", "pass"),
    check("deliveryReady", "unchecked", false),
  ]);
  assert.equal(checkStatusById(v, "verified"), "pass");
  assert.equal(checkStatusById(v, "deliveryReady"), "unchecked");
  // A missing dimension is NEVER treated as pass — it is "" (not evaluated).
  assert.equal(checkStatusById(v, "completed"), "", "missing dimension -> '' (never pass)");
  assert.equal(checkStatusById(v, "nonexistent"), "");
});

// ─── job-seeded fixtures (mirror tests/task-view-evidence.test.ts) ────────────

/**
 * Write the hub registry with one project whose `projectRuntimeRoot` is
 * `dataRoot`. Registering the project is what lets the command's data-root
 * resolution (`listRuntimeDataRoots`) discover a seeded job in `dataRoot`.
 */
async function writeRegistry(hubRoot: string, dataRoot: string): Promise<void> {
  await writeJson(path.join(hubRoot, "projects.json"), {
    version: 1,
    revision: 1,
    updatedAt: "2026-07-27T00:00:00.000Z",
    projects: { [PROJECT]: { id: PROJECT, projectRuntimeRoot: dataRoot } },
    projectRevisions: { [PROJECT]: 1 },
    mutationId: "task-cmd-test",
  });
}

/** Seed a materialized job at `dataRoot` (the same shape `getJobByQueueEntryId` reads). */
async function seedJob(
  dataRoot: string,
  jobId: string,
  job: Record<string, unknown>,
): Promise<void> {
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
    jobs: { [key]: { createdAt: "2026-07-27T00:00:01.000Z", project: PROJECT, jobId, ...job } },
  });
}

// ─── (7) command renders the distinction via the REAL projection ─────────────

test("(7a) cpb task renders 'Verified - ready to deliver.' for a verified job with a finalizer receipt", async () => {
  const root = await tempRoot("cpb-task-cmd-verified-delivered");
  const hubRoot = path.join(root, "hub");
  const dataRoot = path.join(root, "data");
  await writeRegistry(hubRoot, dataRoot);
  await seedQueue(hubRoot, [queueEntry({ status: "completed" })]);
  await seedJob(dataRoot, "job-verified-delivered", {
    queueEntryId: TASK_ID,
    status: "completed",
    phase: "verify",
    task: "Add a --json flag to cpb status",
    verdict: "PASS",
    completionGate: {
      outcome: "complete",
      reason: "all gates passed",
      missingGates: [],
      failedChecklistIds: [],
      uncheckedChecklistIds: [],
    },
    finalizer: {
      ok: true,
      status: "ok",
      code: null,
      commit: "abc123",
      closed: null,
      mode: "local",
      ts: "2026-07-27T00:31:00.000Z",
    },
    createdAt: "2026-07-27T00:00:01.000Z",
    updatedAt: "2026-07-27T00:31:00.000Z",
  });

  const { exit, out } = await runWithCapture([TASK_ID, "--project", PROJECT], root, hubRoot);
  assert.equal(exit, 0);
  const text = out.join("\n");
  assert.match(text, /State:\s+Done/, "verified -> Succeeded -> 'Done' state line");
  assert.match(text, /Result:\s+Verified - ready to deliver\./, "must surface the verified+deliveryReady distinction");
  assertNoForbiddenTerms(text, "verified-delivered");
});

test("(7b) cpb task renders 'Done and verified, not yet delivered.' for a verified job with no finalizer", async () => {
  const root = await tempRoot("cpb-task-cmd-verified-not-delivered");
  const hubRoot = path.join(root, "hub");
  const dataRoot = path.join(root, "data");
  await writeRegistry(hubRoot, dataRoot);
  await seedQueue(hubRoot, [queueEntry({ status: "completed" })]);
  await seedJob(dataRoot, "job-verified-not-delivered", {
    queueEntryId: TASK_ID,
    status: "completed",
    phase: "verify",
    task: "Add a --json flag to cpb status",
    verdict: "PASS",
    completionGate: { outcome: "complete", reason: "all gates passed" },
    createdAt: "2026-07-27T00:00:01.000Z",
    updatedAt: "2026-07-27T00:30:00.000Z",
  });

  const { exit, out } = await runWithCapture([TASK_ID, "--project", PROJECT], root, hubRoot);
  assert.equal(exit, 0);
  const text = out.join("\n");
  assert.match(text, /Result:\s+Done and verified, not yet delivered\./);
  assertNoForbiddenTerms(text, "verified-not-delivered");
});

test("(7c) cpb task renders 'Completed but not verified.' when a queue entry is completed with no verifying job", async () => {
  const root = await tempRoot("cpb-task-cmd-unverified");
  const hubRoot = path.join(root, "hub");
  // No registered project, no job — the queue-only fallback. The projection
  // surfaces Succeeded + verified=fail; the renderer must call that gap out
  // rather than letting the "Done" State line mask an unverified outcome.
  await seedQueue(hubRoot, [queueEntry({ status: "completed" })]);

  const { exit, out } = await runWithCapture([TASK_ID, "--project", PROJECT], root, hubRoot);
  assert.equal(exit, 0);
  const text = out.join("\n");
  assert.match(text, /State:\s+Done/, "the State line still reads Done — the gap the Result line exposes");
  assert.match(text, /Result:\s+Completed but not verified\./);
  assertNoForbiddenTerms(text, "unverified");
});
