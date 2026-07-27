import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TASK_VIEW_SCHEMA_VERSION,
  TaskState,
  TASK_STATES,
  TERMINAL_TASK_STATES,
  isTerminalTaskState,
  PreSubmitFailure,
  PRE_SUBMIT_FAILURES,
  isPreSubmitFailure,
  type TaskView,
} from "../core/contracts/task-view.js";
import {
  FORBIDDEN_TASKVIEW_FIELDS,
  PUBLIC_TASKVIEW_FIELDS,
  sanitizeTaskView,
  isForbiddenTaskViewField,
} from "../core/contracts/task-view-fields.js";
import {
  ExitCode,
  PRE_SUBMIT_FAILURE_EXIT_CODE,
  exitCodeForPreSubmitFailure,
  isPreSubmitFailureExitCode,
  isSuccessExitCode,
} from "../core/contracts/exit-code.js";

// ─── fixtures ────────────────────────────────────────────────────────────────

/** A TaskView sample that contains EXACTLY the public whitelist (no more). */
function publicTaskView(overrides: Partial<TaskView> = {}): TaskView {
  return {
    schemaVersion: TASK_VIEW_SCHEMA_VERSION,
    taskId: "queue-entry-001",
    state: TaskState.Queued,
    summary: "Add a json flag to cpb status",
    progress: { ratio: 0, label: "0 of 1 checks passed" },
    checks: [
      { id: "AC-001", requirement: "cpb status --json emits JSON", status: "pending", required: true },
    ],
    changedFiles: [],
    nextAction: { kind: "wait", message: "queued for execution" },
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * A raw projection containing EVERY forbidden field plus every public field.
 * Used to prove sanitizeTaskView strips each forbidden name while preserving
 * the public ones.
 */
function rawWithEveryForbiddenField(): Record<string, unknown> {
  const raw: Record<string, unknown> = { ...publicTaskView() };
  for (const field of FORBIDDEN_TASKVIEW_FIELDS) {
    raw[field] = `LEAK::${field}`;
  }
  return raw;
}

// ─── (a) sanitizeTaskView strips every forbidden field ───────────────────────

test("sanitizeTaskView strips every forbidden field from a sample containing them", () => {
  const raw = rawWithEveryForbiddenField();

  // Sanity: the raw sample actually carries every forbidden field pre-sanitize.
  for (const field of FORBIDDEN_TASKVIEW_FIELDS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(raw, field),
      true,
      `fixture must seed forbidden field "${field}" for the strip assertion`,
    );
  }

  const sanitized = sanitizeTaskView(raw);

  // Every forbidden field is gone.
  for (const field of FORBIDDEN_TASKVIEW_FIELDS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(sanitized, field),
      false,
      `sanitizeTaskView must strip forbidden field "${field}"`,
    );
    assert.equal(
      (sanitized as Record<string, unknown>)[field],
      undefined,
      `forbidden field "${field}" must not survive sanitizeTaskView`,
    );
  }

  // Public fields survive.
  for (const field of PUBLIC_TASKVIEW_FIELDS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(sanitized, field),
      true,
      `sanitizeTaskView must preserve public field "${field}"`,
    );
  }
});

test("the forbidden set covers every category named in the contract", () => {
  // The spec enumerates these categories; each must be represented by at least
  // one concrete field name in FORBIDDEN_TASKVIEW_FIELDS.
  const categories: Array<{ label: string; requireAny: string[] }> = [
    { label: "jobId", requireAny: ["jobId"] },
    { label: "attemptId", requireAny: ["attemptId"] },
    { label: "provider", requireAny: ["provider"] },
    { label: "agent", requireAny: ["agent"] },
    { label: "lease", requireAny: ["lease", "leaseId"] },
    { label: "session", requireAny: ["session", "sessionId"] },
    { label: "PID/pid", requireAny: ["PID", "pid"] },
    { label: "prompt", requireAny: ["prompt", "promptBytes"] },
    { label: "env/environment variables", requireAny: ["env", "environment", "environmentVariables"] },
    { label: "absolute runtime paths", requireAny: ["cwd", "sourcePath", "runtimePath", "worktreePath"] },
  ];
  for (const { label, requireAny } of categories) {
    assert.ok(
      requireAny.some((name) => FORBIDDEN_TASKVIEW_FIELDS.includes(name)),
      `forbidden set must cover the "${label}" category`,
    );
  }
});

test("sanitizeTaskView is non-mutating and idempotent", () => {
  const raw = rawWithEveryForbiddenField();
  const snapshot = { ...raw };
  const once = sanitizeTaskView(raw);
  const twice = sanitizeTaskView(once);

  // Input not mutated.
  assert.deepEqual(raw, snapshot, "sanitizeTaskView must not mutate its input");
  // Idempotent.
  assert.deepEqual(twice, once, "sanitizeTaskView must be idempotent");
});

test("sanitizeTaskView preserves non-forbidden extra fields (blacklist, not whitelist mode)", () => {
  const raw = { ...publicTaskView(), futurePublicField: "ok", jobId: "LEAK" };
  const sanitized = sanitizeTaskView(raw);
  assert.equal((sanitized as Record<string, unknown>).futurePublicField, "ok");
  assert.equal((sanitized as Record<string, unknown>).jobId, undefined);
});

test("isForbiddenTaskViewField mirrors the frozen set", () => {
  assert.equal(isForbiddenTaskViewField("jobId"), true);
  assert.equal(isForbiddenTaskViewField("pid"), true);
  assert.equal(isForbiddenTaskViewField("PID"), true);
  assert.equal(isForbiddenTaskViewField("taskId"), false);
  assert.equal(isForbiddenTaskViewField("summary"), false);
});

// ─── (b) a public TaskView sample contains ONLY whitelisted fields ───────────

test("a public TaskView sample contains exactly the whitelisted fields", () => {
  const sample = publicTaskView();
  const sampleKeys = Object.keys(sample).sort();
  const whitelist = [...PUBLIC_TASKVIEW_FIELDS].sort();
  assert.deepEqual(
    sampleKeys,
    whitelist,
    "TaskView sample keys must exactly equal PUBLIC_TASKVIEW_FIELDS (drift check)",
  );
});

test("PUBLIC_TASKVIEW_FIELDS matches the TaskView interface field set", () => {
  // The canonical 10 public fields from the frozen contract. If this literal
  // drifts from PUBLIC_TASKVIEW_FIELDS, either the whitelist or the contract
  // type changed without the other following.
  const canonical = [
    "schemaVersion",
    "taskId",
    "state",
    "summary",
    "progress",
    "checks",
    "changedFiles",
    "nextAction",
    "createdAt",
    "updatedAt",
  ].sort();
  assert.deepEqual(
    [...PUBLIC_TASKVIEW_FIELDS].sort(),
    canonical,
    "PUBLIC_TASKVIEW_FIELDS must list exactly the 10 TaskView fields",
  );
  assert.equal(PUBLIC_TASKVIEW_FIELDS.length, 10);
});

test("forbidden fields never overlap the public whitelist", () => {
  const whitelist = new Set(PUBLIC_TASKVIEW_FIELDS);
  const overlap = FORBIDDEN_TASKVIEW_FIELDS.filter((f) => whitelist.has(f));
  assert.deepEqual(overlap, [], "a field cannot be both forbidden and public");
});

test("TaskState frozen set is exactly the 9 contract states", () => {
  assert.deepEqual(
    [...TASK_STATES].sort(),
    [
      "accepted",
      "blocked",
      "canceled",
      "failed",
      "needs_input",
      "queued",
      "running",
      "succeeded",
      "verifying",
    ],
  );
});

test("terminal task states are succeeded, failed, canceled", () => {
  assert.deepEqual(
    [...TERMINAL_TASK_STATES].sort(),
    ["canceled", "failed", "succeeded"],
  );
  assert.equal(isTerminalTaskState("succeeded"), true);
  assert.equal(isTerminalTaskState("failed"), true);
  assert.equal(isTerminalTaskState("canceled"), true);
  assert.equal(isTerminalTaskState("running"), false);
  assert.equal(isTerminalTaskState("queued"), false);
  assert.equal(isTerminalTaskState("verifying"), false);
});

test("PreSubmitFailure categories are exactly needs_setup, invalid_request, runtime_unavailable", () => {
  assert.deepEqual(
    [...PRE_SUBMIT_FAILURES].sort(),
    ["invalid_request", "needs_setup", "runtime_unavailable"],
  );
  assert.equal(PreSubmitFailure.NeedsSetup, "needs_setup");
  assert.equal(PreSubmitFailure.InvalidRequest, "invalid_request");
  assert.equal(PreSubmitFailure.RuntimeUnavailable, "runtime_unavailable");
  assert.equal(isPreSubmitFailure("needs_setup"), true);
  assert.equal(isPreSubmitFailure("running"), false);
});

// ─── (c) exit-code constants match the frozen table ─────────────────────────

test("default (cpb fix) exit codes: 0 accepted; non-0 pre-submit categories", () => {
  assert.equal(ExitCode.FixAccepted, 0, "accepted-into-queue is exit 0");
  assert.notEqual(ExitCode.FixNeedsSetup, 0);
  assert.notEqual(ExitCode.FixInvalidRequest, 0);
  assert.notEqual(ExitCode.FixRuntimeUnavailable, 0);

  // Each pre-submit failure category maps to a distinct non-zero code.
  const codes = [
    ExitCode.FixNeedsSetup,
    ExitCode.FixInvalidRequest,
    ExitCode.FixRuntimeUnavailable,
  ];
  assert.equal(new Set(codes).size, codes.length, "pre-submit codes must be distinct");
  for (const code of codes) {
    assert.equal(code > 0, true, `pre-submit code ${code} must be non-zero`);
  }
});

test("--follow exit codes: 0 completed-and-verified; non-0 failed/canceled/blocked/needs_input/timeout", () => {
  assert.equal(ExitCode.FollowCompletedVerified, 0);
  assert.notEqual(ExitCode.FollowFailed, 0);
  assert.notEqual(ExitCode.FollowCanceled, 0);
  assert.notEqual(ExitCode.FollowBlocked, 0);
  assert.notEqual(ExitCode.FollowNeedsInput, 0);
  assert.notEqual(ExitCode.FollowTimeout, 0);

  const codes = [
    ExitCode.FollowFailed,
    ExitCode.FollowCanceled,
    ExitCode.FollowBlocked,
    ExitCode.FollowNeedsInput,
    ExitCode.FollowTimeout,
  ];
  assert.equal(new Set(codes).size, codes.length, "follow non-zero codes must be distinct");
  for (const code of codes) {
    assert.equal(code > 0, true, `follow code ${code} must be non-zero`);
  }
});

test("every PreSubmitFailure category maps to a non-zero default-mode exit code", () => {
  for (const category of PRE_SUBMIT_FAILURES) {
    const code = exitCodeForPreSubmitFailure(category);
    assert.equal(
      code,
      PRE_SUBMIT_FAILURE_EXIT_CODE[category],
      `category ${category} must resolve via the frozen table`,
    );
    assert.notEqual(code, 0, `pre-submit category ${category} must be non-zero`);
    assert.equal(isPreSubmitFailureExitCode(code), true);
  }
});

test("unknown pre-submit categories fail safe to runtime_unavailable, never 0", () => {
  const code = exitCodeForPreSubmitFailure("does_not_exist");
  assert.equal(code, ExitCode.FixRuntimeUnavailable);
  assert.notEqual(code, 0);
  assert.equal(isSuccessExitCode(code), false);
});

test("isSuccessExitCode recognizes 0 in both modes and rejects non-zero", () => {
  assert.equal(isSuccessExitCode(ExitCode.FixAccepted), true);
  assert.equal(isSuccessExitCode(ExitCode.FollowCompletedVerified), true);
  assert.equal(isSuccessExitCode(ExitCode.FixNeedsSetup), false);
  assert.equal(isSuccessExitCode(ExitCode.FollowFailed), false);
});

// ─── (d) projectTaskView import is RED until Phase 1 lands the module ───────
//
// server/services/task/task-view.ts does not exist yet. This test uses a DYNAMIC
// import so the missing-impl failure is isolated to THIS test and does not take
// down the rest of the file (the other contract assertions above must keep
// passing independently). When Phase 1 creates the module and exports a
// `projectTaskView` function, this test goes green with no edit required.

test("projectTaskView is exported from server/services/task/task-view.ts (RED until Phase 1 lands)", async () => {
  const modulePath = "../server/services/task/task-view.js";
  // Dynamic import: a missing module rejects with ERR_MODULE_NOT_FOUND, which
  // the node:test runner reports as a test failure — the RED we want.
  const mod: { projectTaskView?: unknown } = await import(modulePath);
  assert.equal(
    typeof mod.projectTaskView,
    "function",
    "projectTaskView must be a named export of server/services/task/task-view.ts",
  );
});
