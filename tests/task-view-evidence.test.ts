/**
 * TaskView evidence-driven projection tests — Phase 2 (WAVE 1).
 *
 * These tests pin the Phase 2 three-way distinction surfaced by
 * `projectTaskView` in `server/services/task/task-view.ts`:
 *
 *   completed    = the job reached a terminal state.
 *   verified     = completionGate.outcome === "complete" (the authoritative
 *                  evidence signal — the gate already incorporates the verify
 *                  verdict, candidate identity, clean-replay, and the full
 *                  missing/mismatched/stale/poisoned/polluted evidence check).
 *   deliveryReady = verified AND a finalizer receipt is present.
 *
 * The distinction is encoded in the frozen `checks: TaskViewCheck[]` contract
 * (one check per dimension + an honest evidence-issues check carrying
 * COUNTS/CATEGORIES ONLY). `nextAction` states the real status in plain
 * language and never claims a live PR was published unless the durable log
 * actually records it.
 *
 * Cases:
 *   (1) completed-but-not-verified (gate incomplete) -> failed, verified=fail,
 *       nextAction explains the gate reason in plain language.
 *   (2) verified (gate complete) -> succeeded, verified=pass.
 *   (3) deliveryReady (verified + finalizer receipt) -> deliveryReady=pass.
 *   (4) verified but no finalizer receipt -> deliveryReady=unchecked.
 *   (5) evidence issues (missing/polluted/stale refs in gate details) ->
 *       not verified, evidence check=fail.
 *
 * Plus: no forbidden field/value ever leaks into checks or nextAction.
 *
 * State is seeded by writing the durable artifacts the real services read
 * (same idiom as tests/task-view-projection.test.ts):
 *   - `hubRoot/queue/queue.json`
 *   - `dataRoot/jobs-index.json` + `dataRoot/events/<project>/<jobId>.jsonl`
 *
 * Deterministic: no real workers, no ACP, no network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { projectTaskView } from "../server/services/task/task-view.js";
import {
  TASK_VIEW_SCHEMA_VERSION,
  TaskState,
  TERMINAL_TASK_STATES,
  type TaskView,
  type TaskViewCheck,
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

async function seedQueue(hubRoot: string, entries: QueueEntry[]): Promise<void> {
  await writeJson(path.join(hubRoot, "queue", "queue.json"), { version: 1, entries });
}

type JobState = Record<string, unknown>;

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

async function seed(
  label: string,
  entryOverrides: QueueEntry,
  jobId: string,
  job: JobState,
): Promise<{ root: string; hubRoot: string; dataRoot: string }> {
  const root = await tempRoot(`cpb-task-view-ev-${label}`);
  const hubRoot = path.join(root, "hub");
  const dataRoot = path.join(root, "data");
  await seedQueue(hubRoot, [queueEntry(entryOverrides)]);
  await seedJob(dataRoot, jobId, job);
  return { root, hubRoot, dataRoot };
}

// ─── assertions ─────────────────────────────────────────────────────────────

/** Find a check by id; throws if missing (every dimension must be present). */
function findCheck(view: TaskView, id: string): TaskViewCheck {
  const check = view.checks.find((c) => c.id === id);
  assert.ok(check, `checks[] must include a "${id}" dimension`);
  return check;
}

/**
 * Assert that the public whitelist is exactly the surfaced field set and not a
 * single forbidden TOP-LEVEL field appears (mirrors the Phase 1 boundary test).
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

/**
 * Assert that no forbidden marker value ever reaches the public text surfaces
 * (checks[].requirement + nextAction.message). The forbidden VALUES live on
 * the internal job/queue record; the projection must reduce them to counts /
 * plain categories and never echo them.
 */
function assertNoForbiddenValuesInText(
  view: TaskView,
  markers: string[],
  label: string,
): void {
  const haystack = JSON.stringify({
    checks: view.checks,
    nextAction: view.nextAction,
    progress: view.progress,
    summary: view.summary,
  });
  for (const marker of markers) {
    assert.equal(
      haystack.includes(marker),
      false,
      `${label}: forbidden value "${marker}" leaked into checks/nextAction/progress/summary`,
    );
  }
}

// ─── (1) completed-but-not-verified (gate incomplete) -> failed ──────────────

test("(1) completed-but-not-verified job projects to failed with verified=fail and an explanatory nextAction", async () => {
  const { root, hubRoot, dataRoot } = await seed(
    "completed-unverified",
    { status: "completed" },
    "job-completed-unverified",
    {
      queueEntryId: TASK_ID,
      status: "completed",
      phase: "verify",
      task: "Add a --json flag to cpb status",
      // No completionGate, no verdict — ran to completion but verification
      // never produced a PASS outcome. The contract forbids "succeeded".
      createdAt: "2026-07-27T00:00:01.000Z",
      updatedAt: "2026-07-27T00:30:00.000Z",
    },
  );

  const view = await projectTaskView(root, PROJECT, TASK_ID, { hubRoot, dataRoot });
  assert.ok(view, "a TaskView must be produced");
  assert.equal(view.schemaVersion, TASK_VIEW_SCHEMA_VERSION);
  // Terminal-but-NOT-verified -> failed (never succeeded).
  assert.equal(view.state, TaskState.Failed);
  assert.equal(TERMINAL_TASK_STATES.includes(view.state), true);

  // The three-way distinction.
  const completed = findCheck(view, "completed");
  assert.equal(completed.status, "pass", "completed dimension passes (terminal reached)");
  const verified = findCheck(view, "verified");
  assert.equal(verified.status, "fail", "verified dimension fails (gate incomplete)");
  const deliveryReady = findCheck(view, "deliveryReady");
  assert.equal(deliveryReady.status, "unchecked", "deliveryReady is unchecked when not verified");

  // nextAction plainly explains the gate failure and points at the next step.
  assert.equal(view.nextAction.kind, "retry");
  assert.match(view.nextAction.message, /^Could not verify:/);
  assert.match(view.nextAction.message, /Next:/);
  // It never claims success or delivery.
  assert.equal(view.nextAction.message.includes("delivered"), false);
  assert.equal(view.nextAction.message.includes("Ready to deliver"), false);

  assertOnlyPublicFields(view, "completed-unverified");
});

// ─── (2) verified (gate complete) -> succeeded ───────────────────────────────

test("(2) completed job with a complete gate projects to succeeded with verified=pass", async () => {
  const { root, hubRoot, dataRoot } = await seed(
    "verified",
    { status: "completed" },
    "job-verified",
    {
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
        missingEvidenceRefs: [],
        pollutedEvidenceRefs: [],
      },
      createdAt: "2026-07-27T00:00:01.000Z",
      updatedAt: "2026-07-27T00:30:00.000Z",
    },
  );

  const view = await projectTaskView(root, PROJECT, TASK_ID, { hubRoot, dataRoot });
  assert.ok(view);
  assert.equal(view.state, TaskState.Succeeded);
  assert.equal(TERMINAL_TASK_STATES.includes(view.state), true);

  const completed = findCheck(view, "completed");
  assert.equal(completed.status, "pass");
  const verified = findCheck(view, "verified");
  assert.equal(verified.status, "pass", "verified dimension passes when outcome=complete");
  // A clean gate -> evidence check passes too.
  const evidence = findCheck(view, "evidence");
  assert.equal(evidence.status, "pass");
  assert.equal(view.progress.ratio, 1);

  assertOnlyPublicFields(view, "verified");
});

// ─── (3) deliveryReady (verified + finalizer receipt) -> deliveryReady=pass ──

test("(3) verified job with a finalizer receipt surfaces deliveryReady=pass", async () => {
  const { root, hubRoot, dataRoot } = await seed(
    "delivery-ready",
    { status: "completed" },
    "job-delivery-ready",
    {
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
      // A materialized finalizer receipt (from the finalizer_result event).
      // `mode: "local"` means committed locally — published=false, but the
      // receipt IS present so deliveryReady=true.
      finalizer: { ok: true, status: "ok", code: null, commit: "abc123", closed: null, mode: "local", ts: "2026-07-27T00:31:00.000Z" },
      createdAt: "2026-07-27T00:00:01.000Z",
      updatedAt: "2026-07-27T00:31:00.000Z",
    },
  );

  const view = await projectTaskView(root, PROJECT, TASK_ID, { hubRoot, dataRoot });
  assert.ok(view);
  assert.equal(view.state, TaskState.Succeeded);

  const verified = findCheck(view, "verified");
  assert.equal(verified.status, "pass");
  const deliveryReady = findCheck(view, "deliveryReady");
  assert.equal(deliveryReady.status, "pass", "deliveryReady passes when a finalizer receipt is present");

  // No pr_opened URL -> published=false -> nextAction is "Ready to deliver"
  // (next-step / dry-run framing; never claims a live PR was published).
  assert.equal(view.nextAction.kind, "review");
  assert.match(view.nextAction.message, /Ready to deliver/);
  assert.equal(view.nextAction.message.includes("delivered"), false);

  assertOnlyPublicFields(view, "delivery-ready");
});

// ─── (3b) delivery published (job.pr.url records it) -> "Verified and delivered"

test("(3b) verified job whose pr_opened event records a URL is reported as delivered", async () => {
  const { root, hubRoot, dataRoot } = await seed(
    "delivered",
    { status: "completed" },
    "job-delivered",
    {
      queueEntryId: TASK_ID,
      status: "completed",
      phase: "verify",
      task: "Add a --json flag to cpb status",
      verdict: "PASS",
      completionGate: { outcome: "complete", reason: "all gates passed" },
      finalizer: { ok: true, status: "ok", code: null, commit: "abc123", closed: true, mode: "pr", ts: "2026-07-27T00:32:00.000Z" },
      // The ONLY signal that justifies claiming a live PR was published.
      pr: {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        artifact: null,
        openedAt: "2026-07-27T00:32:00.000Z",
      },
      createdAt: "2026-07-27T00:00:01.000Z",
      updatedAt: "2026-07-27T00:32:00.000Z",
    },
  );

  const view = await projectTaskView(root, PROJECT, TASK_ID, { hubRoot, dataRoot });
  assert.ok(view);
  assert.equal(view.state, TaskState.Succeeded);
  const deliveryReady = findCheck(view, "deliveryReady");
  assert.equal(deliveryReady.status, "pass");

  // Published is proven -> nextAction says "Verified and delivered". The PR
  // URL itself is NOT echoed (it is semi-internal); only the fact of delivery.
  assert.equal(view.nextAction.kind, "review");
  assert.match(view.nextAction.message, /Verified and delivered/);
  assert.equal(
    view.nextAction.message.includes("https://github.com"),
    false,
    "the PR URL must not be echoed into nextAction",
  );

  assertOnlyPublicFields(view, "delivered");
});

// ─── (4) verified but no finalizer receipt -> deliveryReady=unchecked ─────────

test("(4) verified job without a finalizer receipt surfaces deliveryReady=unchecked", async () => {
  const { root, hubRoot, dataRoot } = await seed(
    "verified-not-delivered",
    { status: "completed" },
    "job-verified-not-delivered",
    {
      queueEntryId: TASK_ID,
      status: "completed",
      phase: "verify",
      task: "Add a --json flag to cpb status",
      verdict: "PASS",
      completionGate: { outcome: "complete", reason: "all gates passed" },
      // Deliberately NO finalizer receipt and NO pr record.
      createdAt: "2026-07-27T00:00:01.000Z",
      updatedAt: "2026-07-27T00:30:00.000Z",
    },
  );

  const view = await projectTaskView(root, PROJECT, TASK_ID, { hubRoot, dataRoot });
  assert.ok(view);
  assert.equal(view.state, TaskState.Succeeded);

  const verified = findCheck(view, "verified");
  assert.equal(verified.status, "pass");
  const deliveryReady = findCheck(view, "deliveryReady");
  assert.equal(
    deliveryReady.status,
    "unchecked",
    "deliveryReady is unchecked when verified but no finalizer receipt exists",
  );

  // nextAction: "Done and verified. Not yet delivered."
  assert.equal(view.nextAction.kind, "review");
  assert.match(view.nextAction.message, /Done and verified/);
  assert.match(view.nextAction.message, /Not yet delivered/);

  assertOnlyPublicFields(view, "verified-not-delivered");
});

// ─── (5) evidence issues (missing/polluted/stale refs) -> not verified ───────

test("(5) a completed job whose gate details carry evidence issues projects to failed (not verified)", async () => {
  const { root, hubRoot, dataRoot } = await seed(
    "evidence-issues",
    { status: "completed" },
    "job-evidence-issues",
    {
      queueEntryId: TASK_ID,
      status: "completed",
      phase: "verify",
      task: "Add a --json flag to cpb status",
      // outcome !== "complete" -> NOT verified, regardless of any verdict text.
      verdict: "PASS",
      completionGate: {
        outcome: "evidence_invalid",
        reason: "evidence ledger rejected",
        missingGates: [],
        failedChecklistIds: ["check-7"],
        uncheckedChecklistIds: ["check-2"],
        // Evidence refs carry internal attemptId/evidenceId — they must be
        // COUNTED ONLY, never surfaced. Seed distinctive markers to prove they
        // do not leak into the public checks/nextAction text.
        missingEvidenceRefs: [
          { ledgerId: "LEAK-ledger-1", evidenceId: "LEAK-evidence-1", attemptId: "LEAK-attempt-7" },
        ],
        pollutedEvidenceRefs: [
          { ledgerId: "LEAK-ledger-2", evidenceId: "LEAK-evidence-2", attemptId: "LEAK-attempt-8" },
        ],
        staleEvidenceRefs: [
          { ledgerId: "LEAK-ledger-3", evidenceId: "LEAK-evidence-3", attemptId: "LEAK-attempt-9" },
        ],
        runtimeFailureRefs: [],
        unmappedChangedFiles: [],
      },
      createdAt: "2026-07-27T00:00:01.000Z",
      updatedAt: "2026-07-27T00:30:00.000Z",
    },
  );

  const view = await projectTaskView(root, PROJECT, TASK_ID, { hubRoot, dataRoot });
  assert.ok(view);
  // Evidence issues -> outcome !== complete -> NOT verified -> failed.
  assert.equal(view.state, TaskState.Failed, "evidence issues must yield failed, never succeeded");

  const verified = findCheck(view, "verified");
  assert.equal(verified.status, "fail", "verified dimension fails when the gate found evidence issues");
  const evidence = findCheck(view, "evidence");
  assert.equal(evidence.status, "fail", "evidence dimension fails when issues are present");
  // The evidence check carries honest COUNTS/CATEGORIES — it mentions the
  // issue categories but never the underlying ref identifiers.
  assert.match(evidence.requirement, /Evidence issues/);
  assert.match(evidence.requirement, /1 acceptance check\(s\) failed/);
  assert.match(evidence.requirement, /evidence record/);
  // progress reflects the failed/unchecked checklist counts.
  assert.equal(view.progress.ratio, 0);
  assert.match(view.progress.label, /Verification failed/);

  // nextAction explains the gate reason in plain language.
  assert.equal(view.nextAction.kind, "retry");
  assert.match(view.nextAction.message, /^Could not verify:/);

  // CRITICAL: the internal evidence-ref identifiers (attemptId/evidenceId/
  // ledgerId) never reach the public text surfaces — only counts do.
  assertNoForbiddenValuesInText(
    view,
    [
      "LEAK-ledger-1",
      "LEAK-evidence-1",
      "LEAK-attempt-7",
      "LEAK-ledger-2",
      "LEAK-evidence-2",
      "LEAK-attempt-8",
      "LEAK-ledger-3",
      "LEAK-evidence-3",
      "LEAK-attempt-9",
    ],
    "evidence-issues",
  );
  assertOnlyPublicFields(view, "evidence-issues");
});

// ─── (6) forbidden values seeded across the record never leak into checks ────

test("(6) a delivery-ready record carrying every forbidden category surfaces counts only — never the values", async () => {
  const { root, hubRoot, dataRoot } = await seed(
    "delivery-ready-leak",
    { status: "completed" },
    "job-delivery-ready-leak",
    {
      queueEntryId: TASK_ID,
      status: "completed",
      phase: "verify",
      task: "Add a --json flag to cpb status",
      verdict: "PASS",
      completionGate: { outcome: "complete", reason: "all gates passed" },
      // Finalizer receipt present -> deliveryReady=true. The receipt carries
      // internal detail (commit sha, mode) that must not be echoed verbatim.
      finalizer: {
        ok: true,
        status: "ok",
        code: "LEAK-finalizer-code",
        commit: "LEAK-commit-sha",
        closed: null,
        mode: "pr",
        ts: "2026-07-27T00:32:00.000Z",
      },
      // The internal job record carries the full forbidden set. None of these
      // values may reach checks/nextAction/progress/summary.
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
      updatedAt: "2026-07-27T00:32:00.000Z",
    },
  );

  const view = await projectTaskView(root, PROJECT, TASK_ID, { hubRoot, dataRoot });
  assert.ok(view);
  assert.equal(view.state, TaskState.Succeeded);
  const deliveryReady = findCheck(view, "deliveryReady");
  assert.equal(deliveryReady.status, "pass");
  const verified = findCheck(view, "verified");
  assert.equal(verified.status, "pass");

  // No forbidden TOP-LEVEL field, and no forbidden VALUE in any public text.
  assertOnlyPublicFields(view, "delivery-ready-leak");
  assertNoForbiddenValuesInText(
    view,
    [
      "LEAK-finalizer-code",
      "LEAK-commit-sha",
      "LEAK-codex",
      "LEAK-openai",
      "LEAK-lease-123",
      "LEAK-attempt-7",
      "/private/var/LEAK/executor",
      "LEAK-release",
      "/private/var/LEAK/worktree",
      "LEAK-prompt-content-with-secrets",
      "SECRET_TOKEN",
      "LEAK-secret",
      "99999",
    ],
    "delivery-ready-leak",
  );
});

// ─── (7) the four dimensions are always present, in a stable order ───────────

test("(7) checks always carry the four evidence-driven dimensions in a stable order", async () => {
  const { root, hubRoot, dataRoot } = await seed(
    "stable-checks",
    { status: "in_progress" },
    "job-running",
    {
      queueEntryId: TASK_ID,
      status: "running",
      phase: "execute",
      task: "Add a --json flag to cpb status",
      createdAt: "2026-07-27T00:00:01.000Z",
      updatedAt: "2026-07-27T00:10:00.000Z",
    },
  );

  const view = await projectTaskView(root, PROJECT, TASK_ID, { hubRoot, dataRoot });
  assert.ok(view);
  // A running job: completed=unchecked, verified=unchecked, deliveryReady=
  // unchecked, evidence=unchecked. Every dimension is present and not-yet-
  // evaluated (honest — the gate has not run).
  assert.deepEqual(
    view.checks.map((c) => c.id),
    ["completed", "verified", "deliveryReady", "evidence"],
  );
  for (const c of view.checks) {
    assert.equal(c.status, "unchecked", `running-job dimension "${c.id}" must be unchecked`);
  }
  assertOnlyPublicFields(view, "stable-checks");
});
