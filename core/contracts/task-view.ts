/**
 * TaskView v1 — the public, sanitized product contract for a task.
 *
 * This is the stable surface that `cpb fix` / `cpb task` (Phase 1) and the
 * TaskView renderer (Phase 2) build against. It is deliberately NARROWER than
 * the internal QueueEntry / Job record: it exposes only product-relevant state
 * and NEVER leaks runtime execution detail (jobId, attemptId, provider, agent,
 * lease, session, pid, prompt, env, absolute runtime paths). The forbidden set
 * is enumerated in `task-view-fields.ts`; `sanitizeTaskView` enforces it.
 *
 * `taskId` is the OPAQUE existing queue entry id — never a job id, attempt id,
 * or any other internal identifier. There is NO separate task-to-job registry:
 * a TaskView is a *projection* of a single queue entry, not a new entity. This
 * keeps the public contract 1:1 with the durable queue surface that already
 * exists (see `server/services/hub/hub-queue.ts` `enqueue` / `QueueEntry`).
 *
 * `schemaVersion` pins the wire shape. Bump it when — and only when — a
 * breaking change is made to this type; consumers gate on schemaVersion.
 */

/**
 * The TaskView wire-format version. Increment on a breaking change to the
 * public shape (renamed/removed fields, changed semantics of an existing
 * field). Adding a new optional field is NOT a bump — consumers must ignore
 * unknown keys forward-compatibly.
 */
export const TASK_VIEW_SCHEMA_VERSION = 1 as const;

export type TaskViewSchemaVersion = typeof TASK_VIEW_SCHEMA_VERSION;

/**
 * Product-facing task lifecycle states.
 *
 * These are the ONLY states a public TaskView may report. They are projected
 * from the richer internal queue/job statuses (pending, scheduled,
 * in_progress, completed, failed, needs_issue_link, local_code_index_unavailable,
 * ...) but collapse implementation detail into a user-comprehensible shape.
 *
 * Lifecycle:
 *
 *   accepted ─▶ queued ─▶ running ─▶ verifying ─▶ succeeded
 *                                    │
 *                                    ├─▶ needs_input ─▶ running
 *                                    ├─▶ blocked ─▶ running
 *                                    ├─▶ failed
 *                                    └─▶ canceled
 *
 * `accepted` is the transient "validated and handed to the queue" state; it
 * becomes `queued` once the queue entry is durably persisted. `verifying` is
 * surfaced distinctly from `running` because evidence-driven verification is
 * the load-bearing acceptance gate and the user must see it happening.
 *
 * `succeeded` REQUIRES evidence-driven verification to have passed — a task
 * that ran to completion without passing verification is `failed`, never
 * `succeeded`.
 */
export const TaskState = Object.freeze({
  Accepted: "accepted",
  Queued: "queued",
  Running: "running",
  Verifying: "verifying",
  Succeeded: "succeeded",
  NeedsInput: "needs_input",
  Blocked: "blocked",
  Failed: "failed",
  Canceled: "canceled",
} as const);

export type TaskStateValue = typeof TaskState[keyof typeof TaskState];

/** Every valid TaskState value. Frozen; extend via an additive enum change. */
export const TASK_STATES: readonly TaskStateValue[] = Object.freeze(
  Object.values(TaskState),
);

/**
 * Terminal task states — once reached, the task never transitions again.
 * Used by idempotency (a same-key submission against a terminal task creates a
 * NEW entry) and by `--follow` exit-code selection.
 */
export const TERMINAL_TASK_STATES: readonly TaskStateValue[] = Object.freeze([
  TaskState.Succeeded,
  TaskState.Failed,
  TaskState.Canceled,
]);

/** True iff `state` is one of TERMINAL_TASK_STATES. */
export function isTerminalTaskState(state: unknown): state is TaskStateValue {
  return (
    typeof state === "string"
    && (TERMINAL_TASK_STATES as readonly string[]).includes(state)
  );
}

/** True iff `state` is any value in TASK_STATES. */
export function isTaskState(state: unknown): state is TaskStateValue {
  return (
    typeof state === "string"
    && (TASK_STATES as readonly string[]).includes(state)
  );
}

/**
 * One acceptance-checklist line surfaced to the user as part of a TaskView.
 *
 * `status` is the product-facing verdict for this check, projected from the
 * internal evidence ledger / checklist verdict — it is NOT the raw probe
 * output. `required` marks checks that MUST pass for the task to reach
 * `succeeded`; a single required `fail` blocks success.
 */
export interface TaskViewCheck {
  id: string;
  requirement: string;
  status: "pending" | "pass" | "fail" | "unchecked";
  required: boolean;
}

/**
 * Human-facing progress summary.
 *
 * `ratio` is in [0, 1] (fraction of required checks that have passed), or
 * `null` when no required checks are defined yet (progress is undefined, not
 * zero). `label` is a display-ready string (e.g. "2 of 5 checks passed") so
 * thin clients can render without recomputing.
 */
export interface TaskViewProgress {
  ratio: number | null;
  label: string;
}

/**
 * The next concrete action the user should take, or `null` when the task is
 * running autonomously or has reached a terminal state with nothing to do.
 *
 *   needs_input → { kind: "respond", message: "..." }
 *   blocked     → { kind: "wait" | "review", message: "..." }
 *   failed      → { kind: "retry" | "abandon", message: "..." }
 *   succeeded   → null  (or { kind: "review", ... } if artifacts await review)
 *   running     → null
 */
export interface TaskViewNextAction {
  kind: "respond" | "wait" | "review" | "retry" | "abandon" | null;
  message: string;
}

/**
 * TaskView v1 — the public contract.
 *
 * The field set below is EXACTLY the public surface. The whitelist in
 * `task-view-fields.ts` (`PUBLIC_TASKVIEW_FIELDS`) must stay in 1:1 sync with
 * these keys; the contract test asserts the alignment (a TaskView sample
 * contains only whitelisted keys).
 *
 * Invariants a constructor MUST satisfy (enforced downstream, not by the type):
 *   - `schemaVersion === TASK_VIEW_SCHEMA_VERSION`
 *   - `taskId` is the existing queue entry id (non-empty, opaque)
 *   - `state` is a member of TASK_STATES
 *   - `createdAt` / `updatedAt` are ISO-8601 timestamps, createdAt <= updatedAt
 *   - `changedFiles` are repo-relative POSIX paths (never absolute)
 */
export interface TaskView {
  schemaVersion: TaskViewSchemaVersion;
  taskId: string;
  state: TaskStateValue;
  summary: string;
  progress: TaskViewProgress;
  checks: TaskViewCheck[];
  changedFiles: string[];
  nextAction: TaskViewNextAction;
  createdAt: string;
  updatedAt: string;
}

/**
 * Pre-submit failure categories — the ONLY reasons `cpb fix` / `cpb task` may
 * reject a request BEFORE creating a queue entry (and therefore BEFORE a
 * TaskView exists).
 *
 * A pre-submit failure produces NO task: no queue entry is appended, no taskId
 * is issued, no TaskView is renderable. The CLI exits non-zero with a category-
 * specific code (see `exit-code.ts`).
 *
 *   needs_setup         — the project/runtime is uninitialized or misconfigured
 *                         (e.g. `cpb init` not run, no agent gateway detected,
 *                         hub root not writable). Fixable by the user; retry
 *                         succeeds only after setup changes.
 *
 *   invalid_request     — the task as stated cannot be accepted (empty task
 *                         text, disallowed name characters, disallowed scope,
 *                         unknown project). The user MUST reformulate; retry
 *                         with a corrected request.
 *
 *   runtime_unavailable — the local runtime cannot service the request right
 *                         now (no worker capacity, provider unreachable, hub
 *                         I/O failure). Transient; a retry with NO user change
 *                         may succeed.
 *
 * These are intentionally NOT `TaskState` values: a pre-submit failure never
 * enters the task lifecycle. Keeping them separate prevents a "failed before it
 * started" task from polluting the durable queue and the TaskView surface.
 */
export const PreSubmitFailure = Object.freeze({
  NeedsSetup: "needs_setup",
  InvalidRequest: "invalid_request",
  RuntimeUnavailable: "runtime_unavailable",
} as const);

export type PreSubmitFailureValue =
  typeof PreSubmitFailure[keyof typeof PreSubmitFailure];

/** Every valid pre-submit failure category. */
export const PRE_SUBMIT_FAILURES: readonly PreSubmitFailureValue[] =
  Object.freeze(Object.values(PreSubmitFailure));

/** True iff `value` is a valid PreSubmitFailure category. */
export function isPreSubmitFailure(
  value: unknown,
): value is PreSubmitFailureValue {
  return (
    typeof value === "string"
    && (PRE_SUBMIT_FAILURES as readonly string[]).includes(value)
  );
}
