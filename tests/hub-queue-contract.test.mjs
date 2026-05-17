import assert from "node:assert/strict";
import { access, constants, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { describe } from "node:test";

import {
  dequeue,
  enqueue,
  listQueue,
  queueStatus,
  updateEntry,
} from "../server/services/hub-queue.js";

import { resolveRuntimeBin } from "../server/services/runtime-cli.js";
import * as runtimeCli from "../server/services/runtime-cli.js";

async function detectRuntimeBinary() {
  const bin = resolveRuntimeBin(".");
  try {
    await access(bin, constants.X_OK);
    return bin;
  } catch {
    return null;
  }
}

const detectedBinary = await detectRuntimeBinary();
if (detectedBinary && !process.env.CPB_RUNTIME_BIN) {
  process.env.CPB_RUNTIME_BIN = detectedBinary;
}
const hasRuntimeBinary = Boolean(detectedBinary);

const REQUIRED_ENTRY_FIELDS = [
  "id", "projectId", "sourcePath", "sessionId", "executionBoundary",
  "type", "status", "priority", "description", "metadata",
  "claimedBy", "claimedAt", "workerId", "cwd", "createdAt", "updatedAt",
];

function assertEntryShape(entry, label) {
  for (const field of REQUIRED_ENTRY_FIELDS) {
    assert.ok(field in entry, `${label}: missing field "${field}"`);
  }
  assert.ok(entry.id.startsWith("q-"), `${label}: id must start with "q-"`);
}

describe("hub-queue JS/Rust contract", () => {
  test("JS enqueue produces entry with all contract fields including workerId", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-contract-js-"));
    const entry = await enqueue(hubRoot, {
      projectId: "contract-test",
      sourcePath: "/repos/test",
      sessionId: "sess-contract",
      workerId: "worker-contract",
      cwd: "/repos/test/worktree",
      executionBoundary: "worktree",
      priority: "P1",
      description: "contract test entry",
    });

    assertEntryShape(entry, "JS enqueue");
    assert.equal(entry.projectId, "contract-test");
    assert.equal(entry.sourcePath, "/repos/test");
    assert.equal(entry.sessionId, "sess-contract");
    assert.equal(entry.workerId, "worker-contract");
    assert.equal(entry.cwd, "/repos/test/worktree");
    assert.equal(entry.executionBoundary, "worktree");
    assert.equal(entry.status, "pending");
    assert.equal(entry.priority, "P1");
  });

  test("JS full lifecycle: enqueue → dequeue → update → status", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-contract-lifecycle-"));

    await enqueue(hubRoot, { projectId: "p1", sourcePath: "/a", priority: "P2", description: "low" });
    await enqueue(hubRoot, { projectId: "p2", sourcePath: "/b", priority: "P0", description: "urgent" });

    const claimed = await dequeue(hubRoot);
    assert.equal(claimed.projectId, "p2");
    assert.equal(claimed.status, "in_progress");
    assert.ok(claimed.claimedAt);

    await updateEntry(hubRoot, claimed.id, { status: "completed", workerId: "w-001" });

    const status = await queueStatus(hubRoot);
    assert.equal(status.total, 2);
    assert.equal(status.pending, 1);
    assert.equal(status.completed, 1);

    const all = await listQueue(hubRoot);
    const completedEntry = all.find((e) => e.status === "completed");
    assert.equal(completedEntry.workerId, "w-001");
  });

  test("Rust hub-queue enqueue produces compatible entry shape", { skip: !hasRuntimeBinary }, async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-contract-rust-"));

    const entry = await runtimeCli.hubQueueEnqueue(hubRoot, {
      projectId: "rust-contract",
      sourcePath: "/repos/rust",
      sessionId: "sess-rust",
      workerId: "worker-rust",
      cwd: "/repos/rust/worktree",
      executionBoundary: "worktree",
      priority: "P1",
      description: "rust contract test",
    });

    assertEntryShape(entry, "Rust enqueue");
    assert.equal(entry.projectId, "rust-contract");
    assert.equal(entry.sourcePath, "/repos/rust");
    assert.equal(entry.sessionId, "sess-rust");
    assert.equal(entry.workerId, "worker-rust");
    assert.equal(entry.cwd, "/repos/rust/worktree");
    assert.equal(entry.executionBoundary, "worktree");
    assert.equal(entry.status, "pending");
    assert.equal(entry.priority, "P1");
  });

  test("Rust hub-queue full lifecycle matches JS behavior", { skip: !hasRuntimeBinary }, async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-contract-rust-lifecycle-"));

    await runtimeCli.hubQueueEnqueue(hubRoot, { projectId: "p1", sourcePath: "/a", priority: "P2", description: "low" });
    await runtimeCli.hubQueueEnqueue(hubRoot, { projectId: "p2", sourcePath: "/b", priority: "P0", description: "urgent" });

    const claimed = await runtimeCli.hubQueueDequeue(hubRoot);
    assert.equal(claimed.projectId, "p2");
    assert.equal(claimed.status, "in_progress");
    assert.ok(claimed.claimedAt);

    await runtimeCli.hubQueueUpdate(hubRoot, claimed.id, { status: "completed", workerId: "w-rust" });

    const status = await runtimeCli.hubQueueStatus(hubRoot);
    assert.equal(status.total, 2);
    assert.equal(status.pending, 1);
    assert.equal(status.completed, 1);

    const all = await runtimeCli.hubQueueList(hubRoot);
    const completedEntry = all.find((e) => e.status === "completed");
    assert.equal(completedEntry.workerId, "w-rust");
  });

  test("Rust and JS can read each other's queue files", { skip: !hasRuntimeBinary }, async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-contract-interop-"));

    // JS writes
    await enqueue(hubRoot, { projectId: "js-write", sourcePath: "/js", description: "from JS" });

    // Rust reads
    const rustList = await runtimeCli.hubQueueList(hubRoot);
    assert.equal(rustList.length, 1);
    assert.equal(rustList[0].projectId, "js-write");

    // Rust writes
    await runtimeCli.hubQueueEnqueue(hubRoot, { projectId: "rust-write", sourcePath: "/rust", description: "from Rust" });

    // JS reads
    const jsList = await listQueue(hubRoot);
    assert.equal(jsList.length, 2);
    assert.ok(jsList.some((e) => e.projectId === "js-write"));
    assert.ok(jsList.some((e) => e.projectId === "rust-write"));
  });

  test("Rust dequeues same priority order as JS", { skip: !hasRuntimeBinary }, async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-contract-priority-"));

    await enqueue(hubRoot, { projectId: "low", sourcePath: "/a", priority: "P2", description: "low" });
    await enqueue(hubRoot, { projectId: "high", sourcePath: "/b", priority: "P0", description: "high" });

    const claimed = await runtimeCli.hubQueueDequeue(hubRoot);
    assert.equal(claimed.projectId, "high");
    assert.equal(claimed.status, "in_progress");
  });

  test("Dedup: Rust returns existing pending entry for same projectId+description", { skip: !hasRuntimeBinary }, async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-contract-dedup-"));

    const first = await runtimeCli.hubQueueEnqueue(hubRoot, {
      projectId: "dedup",
      sourcePath: "/a",
      description: "fix login",
    });
    const second = await runtimeCli.hubQueueEnqueue(hubRoot, {
      projectId: "dedup",
      sourcePath: "/a",
      description: "fix login",
    });

    assert.equal(first.id, second.id);
    const all = await runtimeCli.hubQueueList(hubRoot);
    assert.equal(all.length, 1);
  });

  test("hubQueueList filters by status and projectId via Rust", { skip: !hasRuntimeBinary }, async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-contract-list-filter-"));

    await runtimeCli.hubQueueEnqueue(hubRoot, { projectId: "alpha", description: "a1" });
    await runtimeCli.hubQueueEnqueue(hubRoot, { projectId: "beta", description: "b1" });

    const alpha = await runtimeCli.hubQueueList(hubRoot, { projectId: "alpha" });
    assert.equal(alpha.length, 1);

    const pending = await runtimeCli.hubQueueList(hubRoot, { status: "pending" });
    assert.equal(pending.length, 2);

    const empty = await runtimeCli.hubQueueList(hubRoot, { projectId: "gamma" });
    assert.equal(empty.length, 0);
  });
});
