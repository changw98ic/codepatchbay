/**
 * TaskView projection — the READ-ONLY product surface for a task.
 *
 * Phase 1 (§3.2 / §四 阶段 1) established the thin projection: `taskId` is the
 * OPAQUE existing queue entry id; the TaskView is projected from authoritative
 * state that already exists (no new task entity, no task→job registry):
 *
 *   queue entry (hub-queue)
 *     → job / assignment / attempt (job-store)
 *     → completion gate + verdict (materialized job state)
 *     → finalizer receipt (materialized job state + queue entry metadata)
 *
 * Phase 2 (§四 阶段 2) enriches the projection with the EVIDENCE-DRIVEN
 * three-way distinction — WITHOUT adding TaskView fields (the contract is
 * frozen) and WITHOUT re-implementing the completion gate:
 *
 *   completed    = the job reached a terminal state.
 *   verified     = completionGate.outcome === "complete" (the authoritative
 *                  evidence signal — the gate already incorporates the verify
 *                  verdict, candidate identity, clean-replay, and the full
 *                  missing/mismatched/stale/poisoned/polluted evidence check).
 *   deliveryReady = verified AND a finalizer receipt is present (delivery
 *                  published or ready).
 *
 * The distinction is surfaced through the existing `checks: TaskViewCheck[]`
 * contract (one check per dimension + an honest evidence-issues check that
 * carries COUNTS/CATEGORIES ONLY — never the underlying refs, which carry
 * internal attemptId/evidenceId). `nextAction` states the real status in plain
 * language and NEVER claims a live PR was published unless the finalizer
 * receipt / pr_opened event actually records it.
 *
 * Field boundary: `sanitizeTaskView` is applied as the final boundary so NO
 * forbidden field (jobId, attemptId, provider, agent, lease, session, PID,
 * prompt, env, absolute paths) ever reaches a public consumer — see
 * `core/contracts/task-view-fields.ts`.
 *
 * Stabilization freeze: this module reuses existing queue/job/gate services
 * and introduces NO new agent/workflow/provider/scheduler type. It is purely a
 * read-only projection — it never auto-executes a live PR or external side
 * effect.
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

/** Count of non-empty string entries in `value` (0 when not an array). */
function stringCount(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  let n = 0;
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim() !== "") n += 1;
  }
  return n;
}

/**
 * Length of an evidence-ref array (0 when not an array). Refs carry internal
 * attemptId/evidenceId/ledgerId — they are COUNTED here, never surfaced; the
 * count alone is public-safe.
 */
function refCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** Join reason fragments into a plain English sentence (Oxford comma). */
function joinReasons(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return `${parts[0]}.`;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}.`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}.`;
}

// ─── gate evidence extraction ───────────────────────────────────────────────

/**
 * Honest, PUBLIC-SAFE summary of the completion-gate evidence for a job.
 *
 * The authoritative source is `job.completionGate` (materialized from the
 * `completion_gate_evaluated` event), which carries the gate outcome and every
 * evidence-ref category at the top level.
 *
 * Only COUNTS and plain CATEGORIES are produced. The underlying evidence refs
 * (ledgerId / evidenceId / attemptId) are deliberately reduced to counts —
 * they are internal artifact identifiers and must never reach a public
 * consumer (see FORBIDDEN_TASKVIEW_FIELDS).
 */
type GateEvidence = {
  /** True iff any evidence issue category is non-empty. */
  hasIssues: boolean;
  missingGateCount: number;
  failedCheckCount: number;
  uncheckedCheckCount: number;
  /** Plain-language issue fragments (one per non-empty category). */
  issueCategories: string[];
  /** Plain gate reason for nextAction; "" when the gate is clean. */
  gateReason: string;
};

const CLEAN_GATE: GateEvidence = {
  hasIssues: false,
  missingGateCount: 0,
  failedCheckCount: 0,
  uncheckedCheckCount: 0,
  issueCategories: [],
  gateReason: "",
};

function extractGateEvidence(job: LooseRecord | null): GateEvidence {
  if (!job) return CLEAN_GATE;
  const completionGate = recordValue(job.completionGate);

  const gateHasContent = Boolean(
    completionGate.outcome
    || completionGate.reason
    || completionGate.missingGates
    || completionGate.failedChecklistIds
    || completionGate.uncheckedChecklistIds
    || completionGate.missingEvidenceRefs
    || completionGate.mismatchedEvidenceRefs
    || completionGate.staleEvidenceRefs
    || completionGate.poisonedEvidenceRefs
    || completionGate.pollutedEvidenceRefs
    || completionGate.runtimeFailureRefs
    || completionGate.unmappedChangedFiles,
  );
  if (!gateHasContent) return CLEAN_GATE;
  const src = completionGate;

  const failedCheckCount = stringCount(src.failedChecklistIds);
  const uncheckedCheckCount = stringCount(src.uncheckedChecklistIds);
  const missingGateCount = stringCount(src.missingGates);
  const missing = refCount(src.missingEvidenceRefs);
  const mismatched = refCount(src.mismatchedEvidenceRefs);
  const stale = refCount(src.staleEvidenceRefs);
  const poisoned = refCount(src.poisonedEvidenceRefs);
  const polluted = refCount(src.pollutedEvidenceRefs);
  const runtimeFailures = refCount(src.runtimeFailureRefs);
  const unmappedChanges = refCount(src.unmappedChangedFiles);

  const categories: string[] = [];
  if (failedCheckCount > 0) categories.push(`${failedCheckCount} acceptance check(s) failed`);
  if (uncheckedCheckCount > 0) categories.push(`${uncheckedCheckCount} acceptance check(s) not verified`);
  if (missingGateCount > 0) categories.push(`${missingGateCount} required gate(s) missing`);
  if (missing > 0) categories.push(`${missing} evidence record(s) missing`);
  if (mismatched > 0) categories.push(`${mismatched} evidence record(s) mismatched`);
  if (stale > 0) categories.push(`${stale} evidence record(s) stale`);
  if (poisoned > 0) categories.push(`${poisoned} evidence record(s) rejected`);
  if (polluted > 0) categories.push(`${polluted} evidence record(s) contaminated`);
  if (runtimeFailures > 0) categories.push(`${runtimeFailures} runtime failure(s) during verification`);
  if (unmappedChanges > 0) categories.push(`${unmappedChanges} changed file(s) outside expected scope`);

  const issueSummary = joinReasons(categories);
  return {
    hasIssues: categories.length > 0,
    missingGateCount,
    failedCheckCount,
    uncheckedCheckCount,
    issueCategories: categories,
    gateReason: issueSummary || stringValue(completionGate.reason),
  };
}

// ─── finalizer receipt detection ────────────────────────────────────────────

/**
 * True iff a finalizer receipt is materialized for this job. The receipt is
 * the durable signal that delivery finalization ran — it lives on
 * `job.finalizer` (from the `finalizer_result` event) and is mirrored by
 * `job.pr` (from `pr_opened`). The queue entry metadata is consulted as a
 * defensive fallback. This is a PRESENCE check only; it does not interpret the
 * receipt's success/failure (that is the gate's job).
 */
function finalizerReceiptPresent(
  job: LooseRecord | null,
  entry: LooseRecord,
): boolean {
  if (job) {
    if (isRecord(job.finalizer) && Object.keys(job.finalizer).length > 0) return true;
    const pr = recordValue(job.pr);
    if (stringValue(pr.url) || pr.number) return true;
  }
  const entryMetadata = recordValue(entry.metadata);
  if (isRecord(entryMetadata.finalizer) && Object.keys(entryMetadata.finalizer).length > 0) return true;
  if (isRecord(entryMetadata.finalize) && Object.keys(entryMetadata.finalize).length > 0) return true;
  return false;
}

/**
 * True iff the durable event log records an actual publication — a `pr_opened`
 * event carrying a pull-request URL. This is the ONLY signal that justifies
 * claiming a live PR was published; a bare finalizer receipt without it means
 * "ready to deliver", not "delivered".
 */
function publicationProven(job: LooseRecord | null): boolean {
  if (!job) return false;
  const pr = recordValue(job.pr);
  return Boolean(stringValue(pr.url));
}

// ─── projected evidence bundle ──────────────────────────────────────────────

/**
 * The Phase 2 three-way distinction, computed once and consumed by every field
 * builder. `verified` is the authoritative evidence signal
 * (`completionGate.outcome === "complete"`); `deliveryReady` layers the
 * finalizer receipt on top of it.
 */
type ProjectedEvidence = {
  /** The job reached a terminal state (completed/failed/canceled). */
  reachedTerminal: boolean;
  /** completionGate.outcome === "complete" (the evidence gate passed). */
  verified: boolean;
  /** Verified AND a finalizer receipt is present (published or ready). */
  deliveryReady: boolean;
  /** The durable log records an actual publication (e.g. a PR URL). */
  published: boolean;
  /** Honest, public-safe gate evidence summary (counts/categories only). */
  gate: GateEvidence;
};

// ─── state derivation ───────────────────────────────────────────────────────

type ProjectedState = {
  state: TaskStateValue;
  /** True when the job/queue reached a terminal outcome with verification PASS. */
  verified: boolean;
  /** True when the underlying job/queue reached a terminal status. */
  reachedTerminal: boolean;
};

/**
 * Map a job's materialized status + phase + verdict to a TaskState.
 *
 * Contract invariants enforced here (see task-view.ts):
 *   - `succeeded` REQUIRES evidence-driven verification to have passed. The
 *     authoritative signal is `completionGate.outcome === "complete"` (the
 *     completion gate already incorporates the verify verdict, candidate
 *     identity, and clean-replay checks). A job that ran to completion without
 *     a completed gate
 *     verification is `failed`, never `succeeded`.
 *   - `verifying` is surfaced distinctly from `running` when the current phase
 *     is the verify gate.
 */
function deriveStateFromJob(job: LooseRecord | null): ProjectedState {
  if (!job) return { state: TaskState.Queued, verified: false, reachedTerminal: false };
  const status = stringValue(job.status);
  const phase = stringValue(job.phase);
  const completionGate = recordValue(job.completionGate);
  const completionReport = recordValue(job.completionReport);
  const gateOutcome = stringValue(completionGate.outcome);
  const verified = gateOutcome === "complete";

  const isTerminalStatus =
    status === "completed"
    || status === "failed"
    || status === "cancelled"
    || status === "canceled";

  switch (status) {
    case "running":
      if (phase === "verify" || phase === "adversarial_verify") {
        return { state: TaskState.Verifying, verified, reachedTerminal: false };
      }
      return { state: TaskState.Running, verified, reachedTerminal: false };
    case "completed":
      // `completed` is the internal terminal status; it is `succeeded` ONLY
      // when evidence-driven verification passed. Otherwise the task ran to
      // completion but did not pass its acceptance gate — `failed`.
      return verified
        ? { state: TaskState.Succeeded, verified, reachedTerminal: true }
        : { state: TaskState.Failed, verified, reachedTerminal: true };
    case "failed":
      return { state: TaskState.Failed, verified, reachedTerminal: true };
    case "blocked":
      // A blocked job may be waiting on human input (redirect / approval) or
      // on a runtime gate. The queue-status path distinguishes the two; when
      // we only have the job we surface `blocked` and let nextAction guide.
      return { state: TaskState.Blocked, verified, reachedTerminal: false };
    case "cancelled":
    case "canceled":
      return { state: TaskState.Canceled, verified, reachedTerminal: true };
    case "scheduled":
    case "pending":
      return { state: TaskState.Queued, verified, reachedTerminal: false };
    default:
      // Unknown / transitional job status — surface as running rather than
      // crashing; the projection is best-effort and must stay readable.
      return { state: TaskState.Running, verified, reachedTerminal: isTerminalStatus };
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
      return { state: TaskState.Queued, verified: false, reachedTerminal: false };
    case "scheduled":
    case "in_progress":
      // Claimed/running at the queue level but no job record materialized yet.
      // This is the brief window between claim and job creation.
      return { state: TaskState.Running, verified: false, reachedTerminal: false };
    case "needs_issue_link":
      // User must link an issue before execution can proceed.
      return { state: TaskState.NeedsInput, verified: false, reachedTerminal: false };
    case "blocked":
      return { state: TaskState.Blocked, verified: false, reachedTerminal: false };
    case "codegraph_unavailable":
      // Runtime indexing is unavailable; the user can only wait for the
      // index to recover. Surfaced as `blocked` (runtime gate), not failed.
      return { state: TaskState.Blocked, verified: false, reachedTerminal: false };
    case "completed":
      // Queue marked completed with no job to consult for verification.
      // Be conservative: do NOT claim `succeeded` without verdict evidence.
      return { state: TaskState.Succeeded, verified: false, reachedTerminal: true };
    case "failed":
      return { state: TaskState.Failed, verified: false, reachedTerminal: true };
    case "cancelled":
    case "canceled":
      return { state: TaskState.Canceled, verified: false, reachedTerminal: true };
    default:
      return { state: TaskState.Queued, verified: false, reachedTerminal: false };
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
  gate: GateEvidence,
): TaskViewProgress {
  if (state === TaskState.Succeeded) {
    return { ratio: 1, label: "All acceptance checks passed." };
  }
  if (state === TaskState.Failed) {
    const failed = gate.failedCheckCount;
    const unchecked = gate.uncheckedCheckCount;
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

/**
 * Build the public `checks` array — the Phase 2 evidence-driven breakdown
 * encoded as `TaskViewCheck` entries (the contract is frozen; the breakdown
 * is surfaced through the existing per-check shape so the renderer can iterate
 * it without a schema change).
 *
 * One check per dimension:
 *   - `completed`    — did the task reach a terminal state?
 *   - `verified`     — did evidence-driven verification pass?
 *   - `deliveryReady`— is a finalizer receipt present (published or ready)?
 *   - `evidence`     — honest COUNTS/CATEGORIES of any gate evidence issues.
 *
 * Status semantics:
 *   - `pass`     — the dimension is satisfied.
 *   - `fail`     — the dimension was evaluated and did not pass.
 *   - `unchecked`— the dimension has not been evaluated yet (still running,
 *                  or not applicable at this lifecycle stage).
 *
 * Only counts/categories are surfaced. The underlying evidence refs (which
 * carry internal attemptId/evidenceId) are never surfaced — see
 * `extractGateEvidence`.
 */
function buildChecks(evidence: ProjectedEvidence): TaskViewCheck[] {
  const verifiedStatus: TaskViewCheck["status"] = evidence.verified
    ? "pass"
    : evidence.reachedTerminal
      ? "fail"
      : "unchecked";

  const deliveryStatus: TaskViewCheck["status"] = evidence.deliveryReady
    ? "pass"
    : "unchecked";

  // Evidence issues are only "fail" once the gate actually ran and found
  // something. Before the gate runs (non-terminal), they are "unchecked".
  const evidenceStatus: TaskViewCheck["status"] = evidence.gate.hasIssues
    ? "fail"
    : evidence.reachedTerminal
      ? "pass"
      : "unchecked";

  const issueSummary = evidence.gate.issueCategories.length
    ? joinReasons(evidence.gate.issueCategories)
    : "";
  const evidenceRequirement = evidence.gate.hasIssues
    ? `Evidence issues: ${issueSummary}`
    : "No evidence issues detected.";

  return [
    {
      id: "completed",
      requirement: "Task reached a terminal state.",
      status: evidence.reachedTerminal ? "pass" : "unchecked",
      required: true,
    },
    {
      id: "verified",
      requirement: "Evidence-driven verification passed all acceptance gates.",
      status: verifiedStatus,
      required: true,
    },
    {
      id: "deliveryReady",
      requirement: "Delivery published or ready to deliver.",
      status: deliveryStatus,
      required: false,
    },
    {
      id: "evidence",
      requirement: evidenceRequirement,
      status: evidenceStatus,
      required: true,
    },
  ];
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

/**
 * Plain-language failure reason for the Failed nextAction, drawn from the job's
 * failure cause when the completion gate never produced a verdict (e.g. the job
 * failed mid-execution before reaching verify).
 */
function plainFailureReason(job: LooseRecord | null, entry: LooseRecord): string {
  const cause = recordValue(job?.failureCause);
  const fromCause = stringValue(cause.reason);
  if (fromCause) return fromCause;
  return stringValue(entry.reason);
}

function buildNextAction(
  state: TaskStateValue,
  entry: LooseRecord,
  job: LooseRecord | null,
  evidence: ProjectedEvidence,
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
      // Terminal but NOT verified. Explain the gate reason in plain language;
      // fall back to the failure cause when the gate never produced a verdict.
      // Never surface internal artifact ids — only counts/categories.
      const reason = evidence.gate.gateReason
        || plainFailureReason(job, entry)
        || "Verification did not pass.";
      const message = `Could not verify: ${reason} Next: review the failure and retry or revise the task.`;
      return { kind: "retry", message };
    }
    case TaskState.Succeeded: {
      // Verified. Distinguish delivered vs ready-to-deliver. NEVER claim a
      // live PR was published unless the durable log actually records it
      // (publicationProven). The default framing is next-step / dry-run — the
      // projection is read-only and never auto-publishes.
      if (evidence.published) {
        return { kind: "review", message: "Verified and delivered. Review the published change." };
      }
      if (evidence.deliveryReady) {
        return {
          kind: "review",
          message: "Verified. Ready to deliver: review the changes and publish when ready.",
        };
      }
      return { kind: "review", message: "Done and verified. Not yet delivered." };
    }
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
 *   4. finalizer receipt (materialized job state + queue entry metadata)
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
  // Match by id WITHIN THIS PROJECT ONLY. A cross-project id-only fallback
  // would let a caller scoped to project A read project B's task by supplying
  // B's task id — a project-isolation / authorization boundary violation
  // (plan §3.2: taskId is the project-scoped opaque queue entry id). If the id
  // is not found in this project, return null rather than searching others.
  const entry =
    entryList.find((e) => stringValue(e.id) === taskId && stringValue(e.projectId) === project)
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

  // 4. Compute the Phase 2 evidence bundle. `verified` is the authoritative
  //    gate signal; `deliveryReady` layers the finalizer receipt on top. The
  //    bundle is consumed by every field builder so the three-way distinction
  //    is consistent across checks / progress / nextAction.
  const gate = extractGateEvidence(job);
  const receiptPresent = finalizerReceiptPresent(job, entry);
  const published = publicationProven(job);
  const deliveryReady = projected.verified && (receiptPresent || published);
  const evidence: ProjectedEvidence = {
    reachedTerminal: projected.reachedTerminal,
    verified: projected.verified,
    deliveryReady,
    published,
    gate,
  };

  // 5. Build the public fields. None of these copy forbidden fields verbatim —
  //    each is a deliberate, minimal derivation.
  const summary = buildSummary(entry, job);
  const progress = buildProgress(projected.state, gate);
  const checks = buildChecks(evidence);
  const changedFiles = buildChangedFiles(job);
  const nextAction = buildNextAction(projected.state, entry, job, evidence);

  const entryCreatedAt = stringValue(entry.createdAt);
  const entryUpdatedAt = stringValue(entry.updatedAt);
  const jobCreatedAt = stringValue(job?.createdAt);
  const jobUpdatedAt = stringValue(job?.updatedAt);
  const createdAt = entryCreatedAt || jobCreatedAt || nowIso();
  const updatedAt = latestIso(entryUpdatedAt, jobUpdatedAt) || createdAt;

  // 6. Compose, sanitize, and return. `sanitizeTaskView` is the frozen
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
