import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { describe } from "node:test";

import {
  buildProjectQueueStatus,
  claimEligible,
  dequeue,
  enqueue,
  isMutatingEntry,
  listQueue,
  peekQueue,
  queueStatus,
  updateEntry,
} from "../server/services/hub-queue.js";

describe("hub-queue service", () => {
  test("enqueue adds entry with projectId, sourcePath, session metadata", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hq-"));
    const entry = await enqueue(hubRoot, {
      projectId: "my-project",
      sourcePath: "/repos/my-project",
      sessionId: "sess-001",
      executionBoundary: "worktree",
      description: "Add dark mode",
      priority: "P1",
    });

    assert.ok(entry.id);
    assert.equal(entry.projectId, "my-project");
    assert.equal(entry.sourcePath, "/repos/my-project");
    assert.equal(entry.sessionId, "sess-001");
    assert.equal(entry.executionBoundary, "worktree");
    assert.equal(entry.status, "pending");
    assert.equal(entry.priority, "P1");
    assert.ok(entry.createdAt);
  });

  test("enqueue rejects entry without projectId", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hq-"));
    await assert.rejects(
      () => enqueue(hubRoot, { sourcePath: "/x" }),
      /projectId is required/,
    );
  });

  test("dequeue returns highest-priority pending entry and marks in_progress", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hq-"));
    await enqueue(hubRoot, { projectId: "p1", sourcePath: "/a", priority: "P2", description: "low" });
    await enqueue(hubRoot, { projectId: "p2", sourcePath: "/b", priority: "P0", description: "urgent" });
    await enqueue(hubRoot, { projectId: "p3", sourcePath: "/c", priority: "P1", description: "mid" });

    const entry = await dequeue(hubRoot);
    assert.equal(entry.projectId, "p2");
    assert.equal(entry.status, "in_progress");
    assert.ok(entry.claimedAt);

    const remaining = await listQueue(hubRoot, { status: "pending" });
    assert.equal(remaining.length, 2);
  });

  test("dequeue returns null when no pending entries", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hq-"));
    const entry = await dequeue(hubRoot);
    assert.equal(entry, null);
  });

  test("peekQueue returns top entry without changing status", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hq-"));
    await enqueue(hubRoot, { projectId: "p1", sourcePath: "/a", priority: "P1", description: "peek me" });

    const peeked = await peekQueue(hubRoot);
    assert.equal(peeked.projectId, "p1");
    assert.equal(peeked.status, "pending");

    const peekedAgain = await peekQueue(hubRoot);
    assert.equal(peekedAgain.id, peeked.id);
  });

  test("updateEntry changes status and metadata", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hq-"));
    const entry = await enqueue(hubRoot, {
      projectId: "p1", sourcePath: "/a", description: "fix bug",
    });

    const updated = await updateEntry(hubRoot, entry.id, {
      status: "completed",
      metadata: { exitCode: 0 },
    });

    assert.equal(updated.status, "completed");
    assert.equal(updated.metadata.exitCode, 0);
    assert.ok(updated.updatedAt);

    const all = await listQueue(hubRoot);
    assert.equal(all[0].status, "completed");
  });

  test("updateEntry returns null for unknown id", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hq-"));
    const result = await updateEntry(hubRoot, "nonexistent", { status: "completed" });
    assert.equal(result, null);
  });

  test("listQueue filters by status and projectId", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hq-"));
    await enqueue(hubRoot, { projectId: "alpha", sourcePath: "/a", description: "a1" });
    await enqueue(hubRoot, { projectId: "beta", sourcePath: "/b", description: "b1" });
    await enqueue(hubRoot, { projectId: "alpha", sourcePath: "/a", description: "a2" });

    const alpha = await listQueue(hubRoot, { projectId: "alpha" });
    assert.equal(alpha.length, 2);

    const pending = await listQueue(hubRoot, { status: "pending" });
    assert.equal(pending.length, 3);

    const empty = await listQueue(hubRoot, { projectId: "gamma" });
    assert.equal(empty.length, 0);
  });

  test("queueStatus returns summary counts", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hq-"));
    await enqueue(hubRoot, { projectId: "p1", sourcePath: "/a", description: "t1" });
    await enqueue(hubRoot, { projectId: "p2", sourcePath: "/b", description: "t2" });
    const claimed = await dequeue(hubRoot);
    await updateEntry(hubRoot, claimed.id, { status: "failed" });

    const status = await queueStatus(hubRoot);
    assert.equal(status.total, 2);
    assert.equal(status.pending, 1);
    assert.equal(status.inProgress, 0);
    assert.equal(status.failed, 1);
    assert.equal(status.completed, 0);
  });

  test("queue persists across service restarts (file-backed)", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hq-"));
    await enqueue(hubRoot, { projectId: "persist-test", sourcePath: "/x", description: "survive restart" });

    const { loadQueue } = await import("../server/services/hub-queue.js");
    const queue = await loadQueue(hubRoot);
    assert.equal(queue.entries.length, 1);
    assert.equal(queue.entries[0].projectId, "persist-test");
  });

  test("enqueue deduplicates by projectId + description", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hq-"));
    const first = await enqueue(hubRoot, { projectId: "p1", sourcePath: "/a", description: "fix login" });
    const second = await enqueue(hubRoot, { projectId: "p1", sourcePath: "/a", description: "fix login" });

    assert.equal(first.id, second.id);
    const all = await listQueue(hubRoot);
    assert.equal(all.length, 1);
  });

  test("enqueue keeps repair lineage task distinct from the original task", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hq-"));
    const original = await enqueue(hubRoot, {
      projectId: "p1",
      sourcePath: "/a",
      description: "fix login",
    });
    const followup = await enqueue(hubRoot, {
      projectId: "p1",
      sourcePath: "/a",
      description: "fix login",
      metadata: {
        originJobId: "job-123",
        originQueueEntryId: original.id,
        repairArtifact: "repair-001",
        repairStatus: "FIXED",
        lineageReason: "external_repair_fixed_cpb_self_bug",
      },
    });

    assert.notEqual(original.id, followup.id);
    const all = await listQueue(hubRoot);
    assert.equal(all.length, 2);
    assert.equal(followup.metadata.originJobId, "job-123");
  });

  test("entries are ordered by priority then createdAt", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hq-"));
    await enqueue(hubRoot, { projectId: "p1", sourcePath: "/a", priority: "P2", description: "c" });
    await enqueue(hubRoot, { projectId: "p2", sourcePath: "/b", priority: "P0", description: "a" });
    await enqueue(hubRoot, { projectId: "p3", sourcePath: "/c", priority: "P0", description: "b" });

    const top = await peekQueue(hubRoot);
    assert.equal(top.description, "a");
  });

  test("enqueue carries workerId and cwd metadata", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hq-"));
    const entry = await enqueue(hubRoot, {
      projectId: "meta-test",
      sourcePath: "/repos/project",
      sessionId: "sess-abc",
      workerId: "worker-2",
      cwd: "/repos/project/worktree",
    });

    assert.equal(entry.workerId, "worker-2");
    assert.equal(entry.cwd, "/repos/project/worktree");
    assert.equal(entry.sessionId, "sess-abc");
  });

  test("enqueue makes missing sessionId/workerId explicit null", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hq-"));
    const entry = await enqueue(hubRoot, {
      projectId: "null-meta",
      sourcePath: "/repos/project",
    });

    assert.equal(entry.sessionId, null);
    assert.equal(entry.workerId, null);
    assert.equal(entry.cwd, "/repos/project");
  });

  test("enqueue defaults cwd to sourcePath when cwd not provided", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hq-"));
    const entry = await enqueue(hubRoot, {
      projectId: "cwd-default",
      sourcePath: "/repos/auto-cwd",
    });

    assert.equal(entry.cwd, "/repos/auto-cwd");
    assert.equal(entry.sourcePath, "/repos/auto-cwd");
  });

  test("enqueue makes missing sourcePath explicit null with null cwd", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hq-"));
    const entry = await enqueue(hubRoot, {
      projectId: "no-source",
    });

    assert.equal(entry.sourcePath, null);
    assert.equal(entry.cwd, null);
  });
});

describe("isMutatingEntry", () => {
  test("returns true by default", () => {
    assert.equal(isMutatingEntry({ metadata: {} }), true);
    assert.equal(isMutatingEntry({ metadata: { mutating: true } }), true);
    assert.equal(isMutatingEntry({}), true);
  });

  test("returns false only when metadata.mutating === false", () => {
    assert.equal(isMutatingEntry({ metadata: { mutating: false } }), false);
  });
});

describe("buildProjectQueueStatus", () => {
  test("computes per-project counts and active lock details", () => {
    const entries = [
      { projectId: "a", status: "pending", metadata: {} },
      { projectId: "a", status: "in_progress", metadata: {}, claimedBy: "w1", workerId: "w1", claimedAt: "2026-05-20T00:00:00Z" },
      { projectId: "b", status: "pending", metadata: {} },
      { projectId: "b", status: "failed", metadata: {} },
    ];
    const status = buildProjectQueueStatus(entries);
    assert.equal(status.a.pending, 1);
    assert.equal(status.a.inProgress, 1);
    assert.equal(status.a.activeMutating, 1);
    assert.equal(status.a.busy, true);
    assert.equal(status.a.busyReason, "active-mutating-task");
    assert.equal(status.a.claimedBy, "w1");
    assert.equal(status.b.pending, 1);
    assert.equal(status.b.failed, 1);
    assert.equal(status.b.busy, false);
  });

  test("non-mutating in_progress does not mark project busy", () => {
    const entries = [
      { projectId: "a", status: "in_progress", metadata: { mutating: false }, claimedBy: "w1", workerId: "w1", claimedAt: "2026-05-20T00:00:00Z" },
    ];
    const status = buildProjectQueueStatus(entries);
    assert.equal(status.a.activeMutating, 0);
    assert.equal(status.a.busy, false);
  });
});

describe("claimEligible — project-aware parallel scheduling", () => {
  test("skips busy project and claims from another project", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-claim-"));
    // Project A has an active mutating task and a pending task (should be skipped)
    const a1 = await enqueue(hubRoot, { projectId: "a", sourcePath: "/a", description: "a-task-1" });
    await updateEntry(hubRoot, a1.id, { status: "in_progress", claimedBy: "w1", workerId: "w1", claimedAt: new Date().toISOString() });
    await enqueue(hubRoot, { projectId: "a", sourcePath: "/a", description: "a-task-2" });
    // Project B has a pending task
    await enqueue(hubRoot, { projectId: "b", sourcePath: "/b", description: "b-task-1" });

    const result = await claimEligible(hubRoot, { workerId: "w2", maxActivePerProject: 1, claimTimeoutMs: 0 });
    assert.ok(result.entry);
    assert.equal(result.entry.projectId, "b");
    assert.equal(result.entry.status, "in_progress");
    assert.equal(result.entry.claimedBy, "w2");
    assert.ok(result.skippedBusy.includes("a"));
  });

  test("same-project mutating tasks serialized with maxActivePerProject=1", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-claim-ser-"));
    const e1 = await enqueue(hubRoot, { projectId: "a", sourcePath: "/a", description: "a1" });
    await updateEntry(hubRoot, e1.id, { status: "in_progress", claimedBy: "w1", workerId: "w1", claimedAt: new Date().toISOString() });
    await enqueue(hubRoot, { projectId: "a", sourcePath: "/a", description: "a2" });

    const result = await claimEligible(hubRoot, { workerId: "w2", maxActivePerProject: 1, claimTimeoutMs: 0 });
    assert.equal(result.entry, null);
    assert.equal(result.reason, "all-projects-busy");
  });

  test("different projects can run concurrently when capacity available", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-claim-conc-"));
    const a1 = await enqueue(hubRoot, { projectId: "a", sourcePath: "/a", description: "a1" });
    await updateEntry(hubRoot, a1.id, { status: "in_progress", claimedBy: "w1", workerId: "w1", claimedAt: new Date().toISOString() });
    await enqueue(hubRoot, { projectId: "b", sourcePath: "/b", description: "b1" });

    const result = await claimEligible(hubRoot, { workerId: "w2", maxActivePerProject: 1, claimTimeoutMs: 0 });
    assert.ok(result.entry);
    assert.equal(result.entry.projectId, "b");
  });

  test("provider slot exhaustion prevents claiming without recording project lock", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-claim-prov-"));
    await enqueue(hubRoot, { projectId: "a", sourcePath: "/a", description: "a1" });

    const result = await claimEligible(hubRoot, { workerId: "w1", providerSlotsAvailable: false });
    assert.equal(result.entry, null);
    assert.equal(result.reason, "provider-slots-exhausted");
    // Queue not mutated
    const all = await listQueue(hubRoot);
    assert.equal(all[0].status, "pending");
  });

  test("stale claims are recovered before claiming", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-claim-stale-"));
    const e1 = await enqueue(hubRoot, { projectId: "a", sourcePath: "/a", description: "a1" });
    const oldTime = new Date(Date.now() - 200_000).toISOString();
    await updateEntry(hubRoot, e1.id, { status: "in_progress", claimedBy: "w-old", workerId: "w-old", claimedAt: oldTime });

    const result = await claimEligible(hubRoot, { workerId: "w2", claimTimeoutMs: 120_000, maxActivePerProject: 1 });
    assert.ok(result.entry);
    assert.equal(result.entry.projectId, "a");
    assert.ok(result.recovered.includes(e1.id));
  });

  test("non-mutating entry bypasses project lock", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-claim-nm-"));
    const a1 = await enqueue(hubRoot, { projectId: "a", sourcePath: "/a", description: "a1" });
    await updateEntry(hubRoot, a1.id, { status: "in_progress", claimedBy: "w1", workerId: "w1", claimedAt: new Date().toISOString() });
    // Non-mutating entry for same project
    await enqueue(hubRoot, { projectId: "a", sourcePath: "/a", description: "a2-readonly", metadata: { mutating: false } });

    const result = await claimEligible(hubRoot, { workerId: "w2", maxActivePerProject: 1, claimTimeoutMs: 0 });
    assert.ok(result.entry);
    assert.equal(result.entry.projectId, "a");
    assert.equal(result.entry.description, "a2-readonly");
  });

  test("projectId filter scopes claim to specific project", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-claim-filter-"));
    await enqueue(hubRoot, { projectId: "a", sourcePath: "/a", description: "a1", priority: "P0" });
    await enqueue(hubRoot, { projectId: "b", sourcePath: "/b", description: "b1", priority: "P0" });

    const result = await claimEligible(hubRoot, { workerId: "w1", projectId: "b", claimTimeoutMs: 0 });
    assert.ok(result.entry);
    assert.equal(result.entry.projectId, "b");
  });

  test("returns no-eligible reason when no pending entries", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-claim-empty-"));
    const result = await claimEligible(hubRoot, { workerId: "w1", claimTimeoutMs: 0 });
    assert.equal(result.entry, null);
    assert.equal(result.reason, "no-pending-entries");
  });

  test("returns active projects in result", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-claim-ap-"));
    const a1 = await enqueue(hubRoot, { projectId: "a", sourcePath: "/a", description: "a1" });
    await updateEntry(hubRoot, a1.id, { status: "in_progress", claimedBy: "w1", workerId: "w1", claimedAt: new Date().toISOString() });
    await enqueue(hubRoot, { projectId: "b", sourcePath: "/b", description: "b1" });

    const result = await claimEligible(hubRoot, { workerId: "w2", claimTimeoutMs: 0 });
    assert.ok(result.entry);
    // After claiming, both project a (pre-existing) and project b (just claimed) are active
    assert.ok(result.activeProjects.length >= 1);
    const projA = result.activeProjects.find((p) => p.projectId === "a");
    assert.ok(projA);
    assert.equal(projA.busyReason, "active-mutating-task");
  });
});

describe("queueStatus per-project breakdown", () => {
  test("includes projects, activeProjects in queue status", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-qs-proj-"));
    const a1 = await enqueue(hubRoot, { projectId: "a", sourcePath: "/a", description: "a1" });
    await updateEntry(hubRoot, a1.id, { status: "in_progress", claimedBy: "w1", workerId: "w1", claimedAt: new Date().toISOString() });
    await enqueue(hubRoot, { projectId: "b", sourcePath: "/b", description: "b1" });

    const status = await queueStatus(hubRoot);
    assert.equal(status.total, 2);
    assert.equal(status.pending, 1);
    assert.equal(status.inProgress, 1);
    assert.ok(status.projects);
    assert.equal(status.projects.a.activeMutating, 1);
    assert.equal(status.projects.b.activeMutating, 0);
    assert.ok(Array.isArray(status.activeProjects));
    assert.equal(status.activeProjects.length, 1);
    assert.equal(status.activeProjects[0].projectId, "a");
  });
});

describe("eligible queued-work projection", () => {
  test("eligibleQueued counts pending entries from non-busy projects", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-elig-1-"));
    // Project A: active mutating + pending (pending should NOT be eligible)
    const a1 = await enqueue(hubRoot, { projectId: "a", sourcePath: "/a", description: "a-active" });
    await updateEntry(hubRoot, a1.id, { status: "in_progress", claimedBy: "w1", workerId: "w1", claimedAt: new Date().toISOString() });
    await enqueue(hubRoot, { projectId: "a", sourcePath: "/a", description: "a-pending" });
    // Project B: pending only (should be eligible)
    await enqueue(hubRoot, { projectId: "b", sourcePath: "/b", description: "b-pending" });

    const status = await queueStatus(hubRoot);
    assert.equal(status.eligibleQueued, 1);
    assert.ok(status.eligibleProjects.includes("b"));
    assert.ok(!status.eligibleProjects.includes("a"));
    assert.equal(status.projects.a.eligiblePending, 0);
    assert.equal(status.projects.b.eligiblePending, 1);
  });

  test("non-mutating pending entry remains eligible when project is busy", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-elig-2-"));
    // Project A: active mutating entry
    const a1 = await enqueue(hubRoot, { projectId: "a", sourcePath: "/a", description: "a-active" });
    await updateEntry(hubRoot, a1.id, { status: "in_progress", claimedBy: "w1", workerId: "w1", claimedAt: new Date().toISOString() });
    // Project A: pending non-mutating entry (should be eligible despite busy project)
    const a2 = await enqueue(hubRoot, { projectId: "a", sourcePath: "/a", description: "a-readonly", metadata: { mutating: false } });

    const status = await queueStatus(hubRoot);
    assert.equal(status.eligibleQueued, 1);
    assert.equal(status.projects.a.eligiblePending, 1);
    assert.ok(status.projects.a.eligibleEntryIds.includes(a2.id));
  });

  test("all pending entries eligible when no projects are busy", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-elig-3-"));
    await enqueue(hubRoot, { projectId: "a", sourcePath: "/a", description: "a-pending" });
    await enqueue(hubRoot, { projectId: "b", sourcePath: "/b", description: "b-pending" });

    const status = await queueStatus(hubRoot);
    assert.equal(status.eligibleQueued, 2);
    assert.ok(status.eligibleProjects.includes("a"));
    assert.ok(status.eligibleProjects.includes("b"));
  });

  test("buildProjectQueueStatus accepts maxActivePerProject option", () => {
    const entries = [
      { projectId: "a", status: "in_progress", id: "e1", metadata: {} },
      { projectId: "a", status: "in_progress", id: "e2", metadata: {} },
      { projectId: "a", status: "pending", id: "e3", metadata: {} },
    ];
    // 2 active mutating >= maxActive 2 => pending NOT eligible
    const statusCap = buildProjectQueueStatus(entries, { maxActivePerProject: 2 });
    assert.equal(statusCap.a.eligiblePending, 0);

    // 2 active mutating < maxActive 3 => pending IS eligible
    const statusBelow = buildProjectQueueStatus(entries, { maxActivePerProject: 3 });
    assert.equal(statusBelow.a.eligiblePending, 1);
    assert.ok(statusBelow.a.eligibleEntryIds.includes("e3"));
  });
});
