import { createHash } from "node:crypto";

/**
 * Idempotency contract for the `cpb fix` / `cpb task` product facades.
 *
 * When a facade enqueues a task, it MUST dedupe against an existing in-flight
 * entry with the same key, so a double-submit (or a retry that lands while the
 * first is still running) does NOT create a duplicate. The rules:
 *
 *   1. ACTIVE entry, same key  → REUSE the existing entry (return its id).
 *      "Active" = any non-terminal queue status (pending, scheduled,
 *      in_progress, ...). The user gets back the SAME taskId.
 *
 *   2. TERMINAL entry, same key → CREATE a new entry.
 *      A completed/failed/cancelled task does not block a fresh run; the
 *      user gets a NEW taskId.
 *
 *   3. The dedupe key is persisted as a HASH, never plaintext.
 *      `hashTaskKey` produces `sha256:<64-hex>`; the raw key (which may include
 *      project id + task text + context lineage) is NEVER written to disk.
 *
 * This module freezes rules 1-3 as pure functions over a QueueEntry-shaped
 * record, so the contract is testable without I/O and so Phase 1 can wire it
 * into `server/services/hub/hub-queue.ts` `enqueue` without re-deriving the
 * rules. The contract is a SUPERSET of hub-queue's `isActiveEntry`: every
 * status `isActiveEntry` treats as active is non-terminal here, and `pending`
 * is additionally covered (so a re-submit while still queued reuses too).
 */

/**
 * Minimal QueueEntry shape this contract operates on.
 *
 * Intentionally a structural subset of `QueueEntry` in
 * `server/services/hub/hub-queue.ts` (id, status, metadata.queueDedupeKey) —
 * structural typing lets the contract accept the real QueueEntry without an
 * import dependency on `server/` (core/ must not depend on server/). The index
 * signature mirrors `LooseRecord` so an `IdempotencyQueueEntry` is assignable
 * to hub-queue's `QueueEntryInput` (and therefore usable with helpers like
 * `isActiveEntry` in tests) without weakening the named-field contract here.
 */
export interface IdempotencyQueueEntry {
  id?: string;
  status?: string;
  metadata?: { queueDedupeKey?: string } & Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Queue statuses that mark an entry TERMINAL — it will never transition again,
 * so a same-key submit against it must create a NEW entry rather than dedupe.
 *
 * This is the SOURCE OF TRUTH for terminality in the dedupe rule. It is a
 * deliberate, narrow set: everything else (pending, scheduled, in_progress,
 * needs_issue_link, codegraph_unavailable, ...) is treated as in-flight and
 * therefore dedupe-eligible. Aligns with `TERMINAL_TASK_STATES` in
 * task-view.ts at the product-facing layer.
 */
export const TERMINAL_QUEUE_STATUSES: readonly string[] = Object.freeze([
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "archived",
]);

const TERMINAL_SET: ReadonlySet<string> = new Set(TERMINAL_QUEUE_STATUSES);

/**
 * True iff `status` marks a queue entry terminal (no further transitions).
 * An entry that is NOT terminal is "active" for dedupe purposes.
 */
export function isTerminalQueueStatus(status: unknown): boolean {
  return typeof status === "string" && TERMINAL_SET.has(status);
}

/**
 * Hash a raw dedupe key into an opaque, persistence-safe form.
 *
 * Returns `sha256:<64 lowercase hex>`. The raw key is NEVER retained — callers
 * MUST pass the key through this BEFORE writing it onto a queue entry's
 * `metadata.queueDedupeKey`, so the value on disk cannot leak the task text or
 * lineage that fed the key. Deterministic: identical raw keys hash identically
 * (which is what makes dedupe work); distinct raw keys are intended to hash
 * distinctly (sha256 collision resistance).
 */
export function hashTaskKey(rawKey: string): string {
  return `sha256:${createHash("sha256").update(rawKey, "utf8").digest("hex")}`;
}

/**
 * The shape every hashed dedupe key takes. Exposed so callers can validate a
 * stored key was hashed (rather than plaintext) without re-deriving the regex.
 */
export const HASHED_TASK_KEY_PATTERN = /^sha256:[a-f0-9]{64}$/;

/** True iff `value` is a string matching HASHED_TASK_KEY_PATTERN. */
export function isHashedTaskKey(value: unknown): boolean {
  return typeof value === "string" && HASHED_TASK_KEY_PATTERN.test(value);
}

/**
 * Select the existing entry to reuse for a hashed dedupe key, or `null` if a
 * new entry must be created.
 *
 * Rule: return the FIRST entry whose `metadata.queueDedupeKey` equals
 * `hashedKey` AND whose status is non-terminal. If the only matching entries
 * are terminal, return `null` (caller creates a new entry). If no entry
 * matches, return `null`.
 *
 * Iteration order follows the input array; callers SHOULD pass entries in
 * creation order so the oldest in-flight entry is reused (stable taskId).
 */
export function selectIdempotentEntry<T extends IdempotencyQueueEntry>(
  entries: readonly T[],
  hashedKey: string,
): T | null {
  for (const entry of entries) {
    if (entry?.metadata?.queueDedupeKey !== hashedKey) continue;
    if (isTerminalQueueStatus(entry?.status)) continue;
    return entry;
  }
  return null;
}
