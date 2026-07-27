import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hashTaskKey,
  isHashedTaskKey,
  HASHED_TASK_KEY_PATTERN,
  isTerminalQueueStatus,
  TERMINAL_QUEUE_STATUSES,
  selectIdempotentEntry,
  type IdempotencyQueueEntry,
} from "../core/contracts/idempotency.js";
// Ground the alignment assertion in the REAL hub-queue surface rather than a
// hardcoded copy of its rules. isActiveEntry is a pure function (see
// server/services/hub/hub-queue.ts) and importing it here is established
// practice (many tests import enqueue/listQueue from the same module).
import { isActiveEntry } from "../server/services/hub/hub-queue.js";

// ─── fixtures ────────────────────────────────────────────────────────────────

/** A QueueEntry-shaped record matching the hub-queue surface (id/status/metadata). */
function entry(
  id: string,
  status: string,
  hashedKey: string | undefined,
  extra: Record<string, unknown> = {},
): IdempotencyQueueEntry {
  return {
    id,
    status,
    metadata: { queueDedupeKey: hashedKey, ...extra },
  };
}

// ─── (3) the dedupe key is stored as a hash, never plaintext ─────────────────

test("hashTaskKey produces a sha256 digest, never plaintext", () => {
  const rawKey = "flow::add json output::origin-job-7";
  const hashed = hashTaskKey(rawKey);

  // Shape: sha256:<64 lowercase hex>.
  assert.match(hashed, /^sha256:[a-f0-9]{64}$/);
  assert.equal(isHashedTaskKey(hashed), true);
  assert.equal(HASHED_TASK_KEY_PATTERN.test(hashed), true);

  // Never plaintext: the raw key does not appear anywhere in the digest.
  assert.equal(
    hashed.includes(rawKey),
    false,
    "hashed key must not contain the raw key (plaintext leak)",
  );
  assert.equal(
    hashed.includes("flow"),
    false,
    "hashed key must not contain any raw substring",
  );
});

test("hashTaskKey is deterministic — identical raw keys reuse the same entry", () => {
  const rawKey = "flow::fix login bug::ctx-42";
  assert.equal(hashTaskKey(rawKey), hashTaskKey(rawKey));
});

test("hashTaskKey distinguishes distinct raw keys", () => {
  // Two genuinely different inputs must not collide at the test level.
  const a = hashTaskKey("flow::task one");
  const b = hashTaskKey("flow::task two");
  assert.notEqual(a, b);

  // Near-collisions on a single character still differ.
  assert.notEqual(hashTaskKey("key-1"), hashTaskKey("key-2"));
  // Empty input is still a valid (deterministic) hash, never empty/undefined.
  assert.match(hashTaskKey(""), /^sha256:[a-f0-9]{64}$/);
});

test("isHashedTaskKey rejects plaintext and malformed values", () => {
  assert.equal(isHashedTaskKey("plaintext-key"), false);
  assert.equal(isHashedTaskKey("flow::some::key"), false);
  assert.equal(isHashedTaskKey(""), false);
  assert.equal(isHashedTaskKey(null), false);
  assert.equal(isHashedTaskKey(undefined), false);
  assert.equal(isHashedTaskKey(42), false);
  // Uppercase hex or wrong length are rejected (the digest is lowercase 64-hex).
  assert.equal(isHashedTaskKey("sha256:ABCDEF"), false);
  assert.equal(
    isHashedTaskKey("sha256:" + "a".repeat(63)),
    false,
    "63-hex is the wrong length",
  );
});

// ─── (1) active-task with same key reuses existing entry ─────────────────────

test("selectIdempotentEntry reuses an existing ACTIVE entry with the same hashed key", () => {
  const key = hashTaskKey("flow::add json output");
  const entries = [
    entry("entry-A", "in_progress", key), // active: running
  ];

  const selected = selectIdempotentEntry(entries, key);
  assert.equal(selected?.id, "entry-A", "active in_progress entry must be reused");
});

test("selectIdempotentEntry reuses entries across every non-terminal (active) status", () => {
  const key = hashTaskKey("flow::task");
  // pending = queued but not started; scheduled/in_progress = claimed/running;
  // needs_issue_link / codegraph_unavailable = in-flight but waiting. All are
  // non-terminal and therefore dedupe-eligible.
  const activeStatuses = [
    "pending",
    "scheduled",
    "in_progress",
    "needs_issue_link",
    "codegraph_unavailable",
  ];
  for (const status of activeStatuses) {
    const entries = [entry(`entry-${status}`, status, key)];
    const selected = selectIdempotentEntry(entries, key);
    assert.equal(
      selected?.id,
      `entry-${status}`,
      `status "${status}" must be dedupe-eligible (active)`,
    );
  }
});

test("selectIdempotentEntry returns the OLDEST (first) matching active entry", () => {
  const key = hashTaskKey("flow::task");
  const entries = [
    entry("entry-old", "in_progress", key),
    entry("entry-new", "pending", key),
  ];
  // Iteration follows input order; the first active match wins so the taskId
  // a user already received stays stable on re-submit.
  const selected = selectIdempotentEntry(entries, key);
  assert.equal(selected?.id, "entry-old");
});

test("selectIdempotentEntry returns null when no entry matches the hashed key", () => {
  const key = hashTaskKey("flow::task");
  const entries = [
    entry("entry-other", "in_progress", hashTaskKey("flow::different task")),
  ];
  assert.equal(selectIdempotentEntry(entries, key), null);
});

// ─── (2) terminal task with same key creates a new entry ────────────────────

test("selectIdempotentEntry returns null for a TERMINAL entry with the same key (new entry created)", () => {
  const key = hashTaskKey("flow::task");
  for (const terminalStatus of TERMINAL_QUEUE_STATUSES) {
    const entries = [entry(`entry-${terminalStatus}`, terminalStatus, key)];
    const selected = selectIdempotentEntry(entries, key);
    assert.equal(
      selected,
      null,
      `terminal status "${terminalStatus}" must NOT dedupe (caller creates a new entry)`,
    );
  }
});

test("selectIdempotentEntry prefers an active entry over a terminal entry with the same key", () => {
  const key = hashTaskKey("flow::task");
  // A prior completed run AND a current in-flight run share the key. The
  // contract must dedupe against the active one, not the terminal one.
  const entries = [
    entry("entry-completed", "completed", key),
    entry("entry-running", "in_progress", key),
  ];
  const selected = selectIdempotentEntry(entries, key);
  assert.equal(selected?.id, "entry-running");
});

test("isTerminalQueueStatus classifies the terminal and active sets", () => {
  for (const terminal of TERMINAL_QUEUE_STATUSES) {
    assert.equal(isTerminalQueueStatus(terminal), true);
  }
  // Both spellings of "canceled" are terminal (US + GB), matching the queue's
  // permissive write side.
  assert.equal(isTerminalQueueStatus("completed"), true);
  assert.equal(isTerminalQueueStatus("failed"), true);
  assert.equal(isTerminalQueueStatus("cancelled"), true);
  assert.equal(isTerminalQueueStatus("canceled"), true);

  for (const active of ["pending", "scheduled", "in_progress", "needs_issue_link"]) {
    assert.equal(isTerminalQueueStatus(active), false);
  }
  assert.equal(isTerminalQueueStatus(undefined), false);
  assert.equal(isTerminalQueueStatus(null), false);
});

// ─── alignment with the real hub-queue surface (isActiveEntry) ───────────────

test("contract dedupe is a superset of hub-queue isActiveEntry — every active status is non-terminal", () => {
  // isActiveEntry returns true ONLY for {in_progress, scheduled} (see
  // server/services/hub/hub-queue.ts). Every status it treats as active must
  // be dedupe-eligible under the contract (non-terminal), so a re-submit while
  // a claimed/running task is in flight reuses rather than duplicates.
  const activePerHubQueue = ["in_progress", "scheduled"];
  for (const status of activePerHubQueue) {
    const e = entry("e", status, "k");
    assert.equal(
      isActiveEntry(e),
      true,
      `fixture: isActiveEntry must treat "${status}" as active`,
    );
    assert.equal(
      isTerminalQueueStatus(status),
      false,
      `contract must treat isActiveEntry-active status "${status}" as non-terminal`,
    );
  }
});

test("selectIdempotentEntry reuses entries that hub-queue isActiveEntry reports as active", () => {
  const key = hashTaskKey("flow::active-task");
  for (const status of ["in_progress", "scheduled"]) {
    const entries = [entry(`e-${status}`, status, key)];
    // Cross-check: hub-queue itself considers this entry active.
    assert.equal(isActiveEntry(entries[0]), true);
    // And the contract selects it for reuse.
    assert.equal(selectIdempotentEntry(entries, key)?.id, `e-${status}`);
  }
});

test("QueueEntry-shaped records (id/status/metadata.queueDedupeKey) are accepted structurally", () => {
  // The contract operates on a structural subset of hub-queue's QueueEntry.
  // This test pins that subset: an object with exactly the documented keys
  // type-checks against IdempotencyQueueEntry and is selected correctly.
  const key = hashTaskKey("flow::shape");
  const realShapedEntry = {
    id: "queue-19",
    status: "in_progress",
    metadata: { queueDedupeKey: key, originJobId: "job-7", acpProfile: "headless" },
  } satisfies IdempotencyQueueEntry;
  // Extra metadata keys (originJobId, acpProfile) are tolerated — the contract
  // only reads metadata.queueDedupeKey.
  const selected = selectIdempotentEntry([realShapedEntry], key);
  assert.equal(selected?.id, "queue-19");
});
