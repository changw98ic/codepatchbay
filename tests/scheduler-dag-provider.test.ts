// @ts-nocheck
import assert from "node:assert/strict";
import { test } from "node:test";

import { Scheduler } from "../server/orchestrator/scheduler.js";
import { enqueue, listQueue, updateEntry } from "../server/services/hub-queue.js";
import { tempRoot, writeJson } from "./helpers.js";
import { AssignmentStore } from "../shared/orchestrator/assignment-store.js";
import path from "node:path";

const noAssignmentStore = { getAssignment: async () => null };

async function hubWithConfig(config = {}) {
  const hubRoot = await tempRoot("cpb-sched-dag");
  await writeJson(path.join(hubRoot, "config.json"), config);
  return hubRoot;
}

// ── DAG dependency blocking ──

test("nextCandidate skips entries with unmet dependencies", async () => {
  const hubRoot = await hubWithConfig({ scheduler: { mode: "default" } });
  const store = new AssignmentStore(hubRoot);
  await store.init();

  // Enqueue two entries; second depends on first
  const first = await enqueue(hubRoot, { projectId: "proj", description: "parent task", priority: "P1" });
  const second = await enqueue(hubRoot, {
    projectId: "proj",
    description: "child task",
    priority: "P0",
    metadata: { dependsOn: [first.id] },
  });

  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
  });

  // Only the first (no deps) should be returned, even though second has higher priority
  const candidate = await scheduler.nextCandidate();
  assert.equal(candidate.id, first.id);
});

test("nextCandidate returns dependent entry after dependency completes", async () => {
  const hubRoot = await hubWithConfig({ scheduler: { mode: "default" } });
  const store = new AssignmentStore(hubRoot);
  await store.init();

  const first = await enqueue(hubRoot, { projectId: "proj", description: "parent task", priority: "P2" });
  const second = await enqueue(hubRoot, {
    projectId: "proj",
    description: "child task",
    priority: "P1",
    metadata: { dependsOn: [first.id] },
  });

  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
  });

  // First: only parent eligible
  const c1 = await scheduler.nextCandidate();
  assert.equal(c1.id, first.id);

  // Mark parent as completed
  await updateEntry(hubRoot, first.id, { status: "completed" });

  // Now child should be eligible
  const c2 = await scheduler.nextCandidate();
  assert.equal(c2.id, second.id);
});

test("entries with empty dependsOn array are always eligible", async () => {
  const hubRoot = await hubWithConfig({ scheduler: { mode: "default" } });
  const store = new AssignmentStore(hubRoot);
  await store.init();

  const entry = await enqueue(hubRoot, {
    projectId: "proj",
    description: "no deps",
    priority: "P1",
    metadata: { dependsOn: [] },
  });

  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
  });

  const candidate = await scheduler.nextCandidate();
  assert.equal(candidate.id, entry.id);
});

test("entries with no dependsOn metadata are always eligible", async () => {
  const hubRoot = await hubWithConfig({ scheduler: { mode: "default" } });
  const store = new AssignmentStore(hubRoot);
  await store.init();

  const entry = await enqueue(hubRoot, { projectId: "proj", description: "plain task", priority: "P1" });

  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
  });

  const candidate = await scheduler.nextCandidate();
  assert.equal(candidate.id, entry.id);
});

test("entry with multiple dependencies requires all to complete", async () => {
  const hubRoot = await hubWithConfig({ scheduler: { mode: "default" } });
  const store = new AssignmentStore(hubRoot);
  await store.init();

  const dep1 = await enqueue(hubRoot, { projectId: "proj", description: "dep 1", priority: "P2" });
  const dep2 = await enqueue(hubRoot, { projectId: "proj", description: "dep 2", priority: "P2" });
  const child = await enqueue(hubRoot, {
    projectId: "proj",
    description: "child",
    priority: "P1",
    metadata: { dependsOn: [dep1.id, dep2.id] },
  });

  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
  });

  // Complete only dep1 — child still blocked
  const c1 = await scheduler.nextCandidate();
  assert.equal(c1.id, dep1.id);
  await updateEntry(hubRoot, dep1.id, { status: "completed" });

  // dep2 is next, not child
  const c2 = await scheduler.nextCandidate();
  assert.equal(c2.id, dep2.id);

  // Complete dep2 — now child eligible
  await updateEntry(hubRoot, dep2.id, { status: "completed" });
  const c3 = await scheduler.nextCandidate();
  assert.equal(c3.id, child.id);
});

// ── Provider-only capacity ──

test("nextCandidates uses provider capacity when providerCapacityFn is set", async () => {
  const hubRoot = await hubWithConfig({ scheduler: { mode: "default" } });
  const store = new AssignmentStore(hubRoot);
  await store.init();

  await enqueue(hubRoot, { projectId: "proj-a", description: "task a", priority: "P1" });
  await enqueue(hubRoot, { projectId: "proj-b", description: "task b", priority: "P1" });
  await enqueue(hubRoot, { projectId: "proj-c", description: "task c", priority: "P1" });

  // Provider allows 2 slots
  let providerCapacity = { available: 2, total: 2 };
  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
    providerCapacityFn: async () => providerCapacity,
  });

  const candidates = await scheduler.nextCandidates(10);
  assert.equal(candidates.length, 2);
});

test("nextCandidates applies priority ordering before projecting provider capacity", async () => {
  const hubRoot = await hubWithConfig({ scheduler: { mode: "default" } });
  const store = new AssignmentStore(hubRoot);
  await store.init();

  await enqueue(hubRoot, { projectId: "proj-low", description: "low priority first", priority: "P2" });
  const high = await enqueue(hubRoot, { projectId: "proj-high", description: "high priority second", priority: "P0" });

  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
    providerCapacityFn: async () => ({ providerKey: "claude", available: 1, total: 1 }),
  });

  const candidates = await scheduler.nextCandidates(10);

  assert.deepEqual(candidates.map((entry) => entry.id), [high.id]);
});

test("nextCandidates returns empty when provider capacity is zero", async () => {
  const hubRoot = await hubWithConfig({ scheduler: { mode: "default" } });
  const store = new AssignmentStore(hubRoot);
  await store.init();

  await enqueue(hubRoot, { projectId: "proj", description: "task", priority: "P1" });

  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
    providerCapacityFn: async () => ({ available: 0, total: 3 }),
  });

  const candidates = await scheduler.nextCandidates(10);
  assert.equal(candidates.length, 0);
});

test("provider-full queues entries instead of failing them", async () => {
  const hubRoot = await hubWithConfig({ scheduler: { mode: "default" } });
  const store = new AssignmentStore(hubRoot);
  await store.init();

  await enqueue(hubRoot, { projectId: "proj", description: "task", priority: "P1" });

  // Provider full
  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
    providerCapacityFn: async () => ({ available: 0, total: 3 }),
  });

  const candidates = await scheduler.nextCandidates(10);
  assert.equal(candidates.length, 0);

  // Entry is still pending — not failed
  const entries = await listQueue(hubRoot);
  const entry = entries.find(e => e.description === "task");
  assert.equal(entry.status, "pending");
});

test("provider capacity accounts for active entries", async () => {
  const hubRoot = await hubWithConfig({ scheduler: { mode: "default" } });
  const store = new AssignmentStore(hubRoot);
  await store.init();

  // Two active entries already running
  const active1 = await enqueue(hubRoot, { projectId: "proj", description: "active 1", priority: "P1" });
  await updateEntry(hubRoot, active1.id, { status: "in_progress", claimedBy: "w-1", claimedAt: new Date().toISOString() });
  const active2 = await enqueue(hubRoot, { projectId: "proj", description: "active 2", priority: "P1" });
  await updateEntry(hubRoot, active2.id, { status: "in_progress", claimedBy: "w-2", claimedAt: new Date().toISOString() });

  // One pending
  await enqueue(hubRoot, { projectId: "proj", description: "pending task", priority: "P2" });

  // Provider total = 2, so 2 active means 0 available
  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
    providerCapacityFn: async () => ({ available: 0, total: 2 }),
  });

  const candidates = await scheduler.nextCandidates(10);
  assert.equal(candidates.length, 0);
});

// ── Batch nextCandidates with parallel ready nodes ──

test("nextCandidates returns multiple independent ready nodes", async () => {
  const hubRoot = await hubWithConfig({ scheduler: { mode: "default" } });
  const store = new AssignmentStore(hubRoot);
  await store.init();

  const e1 = await enqueue(hubRoot, { projectId: "proj-a", description: "task 1", priority: "P1" });
  const e2 = await enqueue(hubRoot, { projectId: "proj-b", description: "task 2", priority: "P1" });
  const e3 = await enqueue(hubRoot, { projectId: "proj-c", description: "task 3", priority: "P1" });

  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
    providerCapacityFn: async () => ({ available: 3, total: 3 }),
  });

  const candidates = await scheduler.nextCandidates(10);
  assert.equal(candidates.length, 3);
  const ids = new Set(candidates.map(c => c.id));
  assert.ok(ids.has(e1.id));
  assert.ok(ids.has(e2.id));
  assert.ok(ids.has(e3.id));
});

test("nextCandidates respects batchSize limit", async () => {
  const hubRoot = await hubWithConfig({ scheduler: { mode: "default" } });
  const store = new AssignmentStore(hubRoot);
  await store.init();

  await enqueue(hubRoot, { projectId: "proj-a", description: "task 1", priority: "P1" });
  await enqueue(hubRoot, { projectId: "proj-b", description: "task 2", priority: "P1" });
  await enqueue(hubRoot, { projectId: "proj-c", description: "task 3", priority: "P1" });

  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
    providerCapacityFn: async () => ({ available: 10, total: 10 }),
  });

  const candidates = await scheduler.nextCandidates(2);
  assert.equal(candidates.length, 2);
});

test("nextCandidates with DAG: only returns ready nodes, not blocked ones", async () => {
  const hubRoot = await hubWithConfig({ scheduler: { mode: "default" } });
  const store = new AssignmentStore(hubRoot);
  await store.init();

  // Two independent tasks + one dependent
  const indep1 = await enqueue(hubRoot, { projectId: "proj-a", description: "indep 1", priority: "P1" });
  const indep2 = await enqueue(hubRoot, { projectId: "proj-b", description: "indep 2", priority: "P1" });
  const blocked = await enqueue(hubRoot, {
    projectId: "proj-c",
    description: "blocked",
    priority: "P0",
    metadata: { dependsOn: [indep1.id] },
  });

  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
    providerCapacityFn: async () => ({ available: 10, total: 10 }),
  });

  const candidates = await scheduler.nextCandidates(10);
  assert.equal(candidates.length, 2);
  const ids = candidates.map(c => c.id);
  assert.ok(ids.includes(indep1.id));
  assert.ok(ids.includes(indep2.id));
  assert.ok(!ids.includes(blocked.id));
});

// ── Provider capacity only affects same-provider entries ──

test("per-provider capacity filters full provider while allowing other providers", async () => {
  const hubRoot = await hubWithConfig({ scheduler: { mode: "default" } });
  const store = new AssignmentStore(hubRoot);
  await store.init();

  const codexEntry = await enqueue(hubRoot, {
    projectId: "proj",
    description: "codex task",
    priority: "P1",
    metadata: { agents: { executor: { agent: "codex" } } },
  });
  const claudeEntry = await enqueue(hubRoot, {
    projectId: "proj",
    description: "claude task",
    priority: "P1",
    metadata: { agents: { executor: { agent: "claude" } } },
  });

  const seenAgents = [];
  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
    providerCapacityFn: async (agent) => {
      seenAgents.push(agent);
      return agent !== "codex";
    },
  });

  const candidates = await scheduler.nextCandidates(10);
  assert.deepEqual(candidates.map((entry) => entry.id), [claudeEntry.id]);
  assert.deepEqual(seenAgents, ["codex", "claude"]);

  const entries = await listQueue(hubRoot);
  assert.equal(entries.find((entry) => entry.id === codexEntry.id).status, "pending");
  assert.equal(entries.find((entry) => entry.id === claudeEntry.id).status, "pending");
});

// ── Legacy behavior preserved when no providerCapacityFn ──

test("without providerCapacityFn, per-project caps still apply", async () => {
  const hubRoot = await hubWithConfig({ scheduler: { mode: "default" } });
  const store = new AssignmentStore(hubRoot);
  await store.init();

  // Make proj have an active mutating entry
  const active = await enqueue(hubRoot, { projectId: "proj", description: "active", priority: "P1" });
  await updateEntry(hubRoot, active.id, { status: "in_progress", claimedBy: "w-1", claimedAt: new Date().toISOString() });

  // Another pending for same project
  await enqueue(hubRoot, { projectId: "proj", description: "pending", priority: "P2" });

  // Pending for different project
  const otherProject = await enqueue(hubRoot, { projectId: "other", description: "other task", priority: "P2" });

  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
    maxActivePerProject: 1,
    // No providerCapacityFn — uses per-project caps
  });

  const candidate = await scheduler.nextCandidate();
  assert.equal(candidate.id, otherProject.id);
});

// ── nextCandidate delegates to nextCandidates ──

test("nextCandidate returns single entry from nextCandidates", async () => {
  const hubRoot = await hubWithConfig({ scheduler: { mode: "default" } });
  const store = new AssignmentStore(hubRoot);
  await store.init();

  const e1 = await enqueue(hubRoot, { projectId: "proj-a", description: "task 1", priority: "P1" });
  const e2 = await enqueue(hubRoot, { projectId: "proj-b", description: "task 2", priority: "P2" });

  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
    providerCapacityFn: async () => ({ available: 10, total: 10 }),
  });

  const candidate = await scheduler.nextCandidate();
  assert.equal(candidate.id, e1.id);
});

test("nextCandidate returns null when no entries", async () => {
  const hubRoot = await hubWithConfig({ scheduler: { mode: "default" } });
  const store = new AssignmentStore(hubRoot);
  await store.init();

  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
    providerCapacityFn: async () => ({ available: 10, total: 10 }),
  });

  const candidate = await scheduler.nextCandidate();
  assert.equal(candidate, null);
});

// ── Dispatch failure visibility ──

test("dispatch failure metadata is written to entry on failure", async () => {
  const hubRoot = await hubWithConfig({ scheduler: { mode: "default" } });
  const store = new AssignmentStore(hubRoot);
  await store.init();

  const entry = await enqueue(hubRoot, { projectId: "proj", description: "task", priority: "P1" });

  // Simulate a dispatch failure by writing dispatchFailure metadata
  await updateEntry(hubRoot, entry.id, {
    metadata: {
      dispatchFailure: {
        error: "worker unavailable",
        retryable: true,
        timestamp: new Date().toISOString(),
      },
    },
  });

  const entries = await listQueue(hubRoot);
  const updated = entries.find(e => e.id === entry.id);
  assert.ok(updated.metadata.dispatchFailure);
  assert.equal(updated.metadata.dispatchFailure.retryable, true);
  assert.ok(updated.metadata.dispatchFailure.timestamp);
  assert.ok(updated.metadata.dispatchFailure.error);
});
