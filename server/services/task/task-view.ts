/**
 * TaskView projection — the READ-ONLY product surface for a task.
 *
 * This is the Phase 1 thin projection mandated by
 * `docs/product/cpb-product-entry-execution-kernel-plan-2026-07-27.md` §3.2 / §四
 * 阶段 1. It does NOT introduce a new state machine, a new task entity, or a
 * task→job registry. `taskId` is the OPAQUE existing queue entry id; the
 * TaskView is projected from authoritative state that already exists:
 *
 *   queue entry (hub-queue)
 *     → job / assignment / attempt (job-store)
 *     → completion gate + verdict (materialized job state)
 *     → finalizer receipt (queue entry metadata.finalizer)
 *
 * Field boundary: `sanitizeTaskView` is applied as the final boundary so NO
 * forbidden field (jobId, attemptId, provider, agent, lease, session, PID,
 * prompt, env, absolute paths) ever reaches a public consumer — see
 * `core/contracts/task-view-fields.ts`.
 *
 * Stabilization freeze: this module reuses existing queue/job/gate services
 * and introduces NO new agent/workflow/provider/scheduler type.
 */

import {
  TASK_VIEW_SCHEMA_VERSION,
  TaskState,
  type TaskStateValue,
  type TaskView,
  type TaskViewCheck,
  type TaskViewNextAction,
  type TaskViewProgress,
} from "../../../core/contracts/task-view.js";
import {
  sanitizeTaskView,
} from "../../../core/contracts/task-view-fields.js";
import { recordValue, isRecord, type LooseRecord } from "../../../core/contracts/types.js";
import { parseVerdict } from "../../../core/engine/completion-gate.js";
import { loadQueue } from "../hub/hub-queue.js";
import { getJobByQueueEntryId } from "../job/job-store.js";
import { resolveHubRoot } from "../hub/hub-registry.js";

// ─── helpers ────────────────────────────────────────────────────────────────

/** ISO timestamp that sorts before any real timestamp; used only as a floor. */
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

function nowIso(): string {
  return new Date().toISOString();
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

/** Latest of two ISO timestamps (treating null/empty as the epoch floor). */
function latestIso(a: unknown, b: unknown): string {
  const ta = Date.parse(stringValue(a) || EPOCH_ISO);
  const tb = Date.parse(stringValue(b) || EPOCH_ISO);
  const winning = Number.isFinite(ta) && ta >= tb ? a : b;
  return stringValue(winning) || stringValue(a) || stringValue(b) || nowIso();
}

/**
 * Filter `paths` to repo-relative POSIX paths only. Absolute paths, parent
 * references, and empty strings are dropped — the public TaskView must never
 * leak the host filesystem layout (see FORBIDDEN_TASKVIEW_FIELDS: cwd /
 * sourcePath / runtimePath / worktreePath / ...).
 */
function relativePathsOnly(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];
  const out: string[] = [];
  for (const raw of paths) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("/")) continue; // absolute — leak risk
    if (trimmed.includes("..")) continue; // parent escape — leak risk
    // Backslash separators (Windows) normalized to POSIX; any backslash
    // segment is treated as relative-only after normalization.
    const normalized = trimmed.replace(/\\/g, "/");
    if (normalized.startsWith("/")) continue;
    out.push(normalized);
  }
  return out;
}

// ─── state derivation ───────────────────────────────────────────────────────

type ProjectedState = {
  state: TaskStateValue;
  /** True when the job/queue reached a terminal outcome with verification PASS. */
  verified: boolean;
};

/**
 * Map a job's materialized status + phase + verdict to a TaskState.
 *
 * Contract invariants enforced here (see task-view.ts):
 *   - `succeeded` REQUIRES evidence-driven verification to have passed. The
 *     authoritative signal is `completionGate.outcome === "complete"` (the
 *     completion gate already incorporates the verify verdict, candidate
 *     identity, and clean-replay checks). When no gate is materialized but a
 *     canonical `VERDICT: PASS` text is present, that is accepted as a
 *     fallback signal. A job that ran to completion without passing
 *     verification is `failed`, never `succeeded`.
 *   - `verifying` is surfaced distinctly from `running` when the current phase
 *     is the verify gate.
 */
function deriveStateFromJob(job: LooseRecord | null): ProjectedState {
  if (!job) return { state: TaskState.Queued, verified: false };
  const status = stringValue(job.status);
  const phase = stringValue(job.phase);
  const completionGate = recordValue(job.completionGate);
  const completionReport = recordValue(job.completionReport);
  const gateOutcome = stringValue(
    completionGate.outcome || completionReport.outcome,
  );
  const parsedVerdict = parseVerdict(job.verdict);
  const verdictPass = parsedVerdict?.status === "pass";
  // `complete` is the authoritative success signal; the verdict fallback only
  // applies when the gate was never materialized (older / partial records).
  const verified = gateOutcome === "complete" || (gateOutcome === "" && verdictPass);

  switch (status) {
    case "running":
      if (phase === "verify" || phase === "adversarial_verify") {
        return { state: TaskState.Verifying, verified };
      }
      return { state: TaskState.Running, verified };
    case "completed":
      // `completed` is the internal terminal status; it is `succeeded` ONLY
      // when evidence-driven verification passed. Otherwise the task ran to
      // completion but did not pass its acceptance gate — `failed`.
      return verified
        ? { state: TaskState.Succeeded, verified }
        : { state: TaskState.Failed, verified };
    case "failed":
      return { state: TaskState.Failed, verified };
    case "blocked":
      // A blocked job may be waiting on human input (redirect / approval) or
      // on a runtime gate. The queue-status path distinguishes the two; when
      // we only have the job we surface `blocked` and let nextAction guide.
      return { state: TaskState.Blocked, verified };
    case "cancelled":
    case "canceled":
      return { state: TaskState.Canceled, verified };
    case "scheduled":
    case "pending":
      return { state: TaskState.Queued, verified };
    default:
      // Unknown / transitional job status — surface as running rather than
      // crashing; the projection is best-effort and must stay readable.
      return { state: TaskState.Running, verified };
  }
}

/**
 * Map a queue entry's status (no job linked yet) to a TaskState. The queue is
 * authoritative for the pre-job and queue-terminal phases.
 */
function deriveStateFromQueueEntry(entry: LooseRecord): ProjectedState {
  const status = stringValue(entry.status);
  switch (status) {
    case "pending":
      // The entry is durably persisted in the queue (we are reading it from
      // queue.json), so the transient `accepted` state has already evolved to
      // `queued`.
      return { state: TaskState.Queued, verified: false };
    case "scheduled":
    case "in_progress":
      // Claimed/running at the queue level but no job record materialized yet.
      // This is the brief window between claim and job creation.
      return { state: TaskState.Running, verified: false };
    case "needs_issue_link":
      // User must link an issue before execution can proceed.
      return { state: TaskState.NeedsInput, verified: false };
    case "blocked":
      return { state: TaskState.Blocked, verified: false };
    case "codegraph_unavailable":
    case "index_unavailable":
      // Runtime indexing is unavailable; the user can only wait for the
      // index to recover. Surfaced as `blocked` (runtime gate), not failed.
      return { state: TaskState.Blocked, verified: false };
    case "completed":
      // Queue marked completed with no job to consult for verification.
      // Be conservative: do NOT claim `succeeded` without verdict evidence.
      return { state: TaskState.Succeeded, verified: false };
    case "failed":
      return { state: TaskState.Failed, verified: false };
    case "cancelled":
    case "canceled":
      return { state: TaskState.Canceled, verified: false };
    default:
      return { state: TaskState.Queued, verified: false };
  }
}

// ─── field builders ─────────────────────────────────────────────────────────

function buildSummary(entry: LooseRecord, job: LooseRecord | null): string {
  const task = stringValue(job?.task);
  if (task) return task;
  return stringValue(entry.description) || "Task queued.";
}

function buildProgress(
  state: TaskStateValue,
  job: LooseRecord | null,
): TaskViewProgress {
  const completionReport = recordValue(job?.completionReport);
  const checklist = recordValue(completionReport.checklist);
  const failedIds = Array.isArray(checklist.failedChecklistIds)
    ? (checklist.failedChecklistIds as unknown[])
    : [];
  const uncheckedIds = Array.isArray(checklist.uncheckedChecklistIds)
    ? (checklist.uncheckedChecklistIds as unknown[])
    : [];

  if (state === TaskState.Succeeded) {
    return { ratio: 1, label: "All acceptance checks passed." };
  }
  if (state === TaskState.Failed) {
    const failed = failedIds.length;
    const unchecked = uncheckedIds.length;
    if (failed + unchecked > 0) {
      return {
        ratio: 0,
        label: `Verification failed (${failed} failed, ${unchecked} unchecked).`,
      };
    }
    return { ratio: 0, label: "Verification did not pass." };
  }
  if (state === TaskState.Verifying) {
    return { ratio: null, label: "Verifying acceptance checks." };
  }
  if (state === TaskState.Running) {
    return { ratio: null, label: "Working on the task." };
  }
  if (state === TaskState.NeedsInput) {
    return { ratio: null, label: "Waiting for your input." };
  }
  if (state === TaskState.Blocked) {
    return { ratio: null, label: "Waiting for a blocker to clear." };
  }
  // accepted / queued / canceled
  return { ratio: null, label: "Task queued for execution." };
}

function buildChecks(_job: LooseRecord | null): TaskViewCheck[] {
  // Phase 1 intentionally surfaces NO per-item checks: the verdict-level
  // summary lives in `progress`, and fabricating per-item checks without the
  // full evidence-ledger projection (Phase 2) would over-claim verification
  // state. Returning an empty array is the honest v1 shape; the contract
  // explicitly permits `checks: []`.
  return [];
}

function buildChangedFiles(job: LooseRecord | null): string[] {
  if (!job) return [];
  const completionReport = recordValue(job.completionReport);
  const candidateValidation = recordValue(completionReport.candidateValidation);
  const fromValidation = relativePathsOnly(candidateValidation.unmappedChangedFiles);
  if (fromValidation.length > 0) return fromValidation;
  // Fall back to any repo-relative diff paths recorded on the artifacts index.
  const artifacts = recordValue(job.artifacts);
  const diff = relativePathsOnly(artifacts.diffPaths || artifacts.changedFiles);
  return diff;
}

function buildNextAction(
  state: TaskStateValue,
  entry: LooseRecord,
  job: LooseRecord | null,
): TaskViewNextAction {
  const entryMetadata = recordValue(entry.metadata);
  switch (state) {
    case TaskState.Accepted:
    case TaskState.Queued:
      return { kind: "wait", message: "Task queued. It will start when a worker is ready." };
    case TaskState.Running:
    case TaskState.Verifying:
      // Running autonomously — no user action expected.
      return { kind: null, message: "" };
    case TaskState.NeedsInput: {
      const reason = stringValue(
        entry.reason || entryMetadata.reason || job?.blockedReason,
        "This task needs more information before it can continue.",
      );
      return { kind: "respond", message: reason };
    }
    case TaskState.Blocked: {
      const reason = stringValue(
        job?.blockedReason || entry.reason || entryMetadata.reason,
        "This task is blocked and waiting for a gate to clear.",
      );
      return { kind: "wait", message: reason };
    }
    case TaskState.Failed: {
      const cause = recordValue(job?.failureCause);
      const reason = stringValue(
        cause.reason || job?.failureCause || entry.reason,
        "Verification failed. Review the failure and retry or revise the task.",
      );
      return { kind: "retry", message: reason };
    }
    case TaskState.Succeeded:
      return { kind: null, message: "" };
    case TaskState.Canceled:
      return { kind: null, message: "" };
    default:
      return { kind: null, message: "" };
  }
}

// ─── projection entry point ─────────────────────────────────────────────────

/**
 * Project the public TaskView for `taskId`.
 *
 * `taskId` is the OPAQUE existing queue entry id (per plan §3.2 — there is NO
 * separate task→job registry). The projection reads authoritative state in
 * this order and derives the TaskView from it:
 *
 *   1. queue entry (loadQueue from hub-queue)
 *   2. job / assignment / attempt (getJobByQueueEntryId from job-store)
 *   3. completion gate + verdict (materialized job state)
 *   4. finalizer receipt (queue entry metadata.finalizer — consulted for
 *      terminal delivery readiness in Phase 2; not load-bearing for v1 state)
 *
 * Returns `null` when `taskId` matches no queue entry (unknown task).
 *
 * The result is run through `sanitizeTaskView` before return so the forbidden
 * field boundary is enforced even if a future caller accidentally seeds a
 * private field into the derived record.
 */
export async function projectTaskView(
  cpbRoot: string,
  project: string,
  taskId: string,
  opts: { dataRoot?: string; hubRoot?: string } = {},
): Promise<TaskView | null> {
  if (typeof taskId !== "string" || !taskId) return null;

  // 1. Resolve hub root and read the durable queue.
  const hubRoot = opts.hubRoot ? opts.hubRoot : resolveHubRoot(cpbRoot);
  const queue = await loadQueue(hubRoot);
  const entries: unknown = (queue as LooseRecord)?.entries;
  const entryList: LooseRecord[] = Array.isArray(entries)
    ? entries.filter((e) => isRecord(e))
    : [];
  // Match by id within this project first; fall back to id-only match so a
  // caller who omits the project still resolves. The project-scoped match is
  // authoritative when both are present.
  const entry =
    entryList.find((e) => stringValue(e.id) === taskId && stringValue(e.projectId) === project)
    || entryList.find((e) => stringValue(e.id) === taskId)
    || null;
  if (!entry) return null;

  // 2. Look up the job linked to this queue entry (if any). `getJobByQueueEntryId`
  //    returns null when no job exists yet — the queue-only branch handles that.
  let job: LooseRecord | null = null;
  try {
    const linked = await getJobByQueueEntryId(cpbRoot, project, taskId, {
      dataRoot: opts.dataRoot,
    });
    job = isRecord(linked) ? (linked as LooseRecord) : null;
  } catch {
    // A transient runtime read failure must not crash the read-only projection.
    // Fall back to queue-only state; the caller sees the queue's authoritative
    // status rather than an error.
    job = null;
  }

  // 3. Derive state. The job is authoritative when present (it carries verdict
  //    + completion gate evidence the queue does not). The queue entry is the
  //    authority for the pre-job window and for terminal delivery state.
  const projected = job
    ? deriveStateFromJob(job)
    : deriveStateFromQueueEntry(entry);

  // 4. Build the public fields. None of these copy forbidden fields verbatim —
  //    each is a deliberate, minimal derivation.
  const summary = buildSummary(entry, job);
  const progress = buildProgress(projected.state, job);
  const checks = buildChecks(job);
  const changedFiles = buildChangedFiles(job);
  const nextAction = buildNextAction(projected.state, entry, job);

  const entryCreatedAt = stringValue(entry.createdAt);
  const entryUpdatedAt = stringValue(entry.updatedAt);
  const jobCreatedAt = stringValue(job?.createdAt);
  const jobUpdatedAt = stringValue(job?.updatedAt);
  const createdAt = entryCreatedAt || jobCreatedAt || nowIso();
  const updatedAt = latestIso(entryUpdatedAt, jobUpdatedAt) || createdAt;

  // 5. Compose, sanitize, and return. `sanitizeTaskView` is the frozen
  //    boundary enforcer — it strips any forbidden key that might have been
  //    introduced by future derivation changes. Today it is a no-op safety net.
  const raw: Record<string, unknown> = {
    schemaVersion: TASK_VIEW_SCHEMA_VERSION,
    taskId,
    state: projected.state,
    summary,
    progress,
    checks,
    changedFiles,
    nextAction,
    createdAt,
    updatedAt,
  };
  const sanitized = sanitizeTaskView(raw);
  return sanitized as unknown as TaskView;
}
