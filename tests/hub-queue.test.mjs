import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { describe } from "node:test";

import {
  dequeue,
  enqueue,
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
