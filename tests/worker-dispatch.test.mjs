import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { describe, beforeEach, afterEach } from "node:test";

import {
  assignWorker,
  completeDispatch,
  createDispatch,
  deleteDispatchFile,
  failDispatch,
  getDispatch,
  listDispatches,
  makeDispatchId,
  startDispatch,
} from "../server/services/dispatch-state.js";
import {
  guardSourcePath,
  recordDispatch,
  markDispatchAssigned,
  markDispatchStarted,
  markDispatchCompleted,
  markDispatchFailed,
} from "../server/services/worker-dispatch.js";
import { registerProject } from "../server/services/hub-registry.js";

describe("dispatch-state service", () => {
  let hubRoot;

  beforeEach(async () => {
    hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-dispatch-"));
  });

  test("createDispatch creates a dispatch record with all fields", async () => {
    const dispatch = await createDispatch(hubRoot, {
      projectId: "my-project",
      sourcePath: "/repos/my-project",
      sessionId: "sess-001",
      workerId: "worker-1",
      queueEntryId: "q-abc123",
    });

    assert.ok(dispatch.dispatchId);
    assert.ok(dispatch.dispatchId.startsWith("dispatch-"));
    assert.equal(dispatch.projectId, "my-project");
    assert.equal(dispatch.sourcePath, "/repos/my-project");
    assert.equal(dispatch.sessionId, "sess-001");
    assert.equal(dispatch.workerId, "worker-1");
    assert.equal(dispatch.queueEntryId, "q-abc123");
    assert.equal(dispatch.status, "pending");
    assert.ok(dispatch.createdAt);
    assert.ok(dispatch.updatedAt);
  });

  test("createDispatch requires projectId", async () => {
    await assert.rejects(
      () => createDispatch(hubRoot, {}),
      /projectId is required/,
    );
  });

  test("dispatch lifecycle: pending to assigned to running to completed", async () => {
    const created = await createDispatch(hubRoot, { projectId: "p1" });
    assert.equal(created.status, "pending");

    const assigned = await assignWorker(hubRoot, created.dispatchId, { workerId: "w-1" });
    assert.equal(assigned.status, "assigned");
    assert.equal(assigned.workerId, "w-1");

    const started = await startDispatch(hubRoot, created.dispatchId);
    assert.equal(started.status, "running");

    const completed = await completeDispatch(hubRoot, created.dispatchId);
    assert.equal(completed.status, "completed");
    assert.equal(completed.workerId, "w-1");
    assert.equal(completed.projectId, "p1");
  });

  test("dispatch lifecycle: pending to running to failed", async () => {
    const created = await createDispatch(hubRoot, { projectId: "p2" });
    await startDispatch(hubRoot, created.dispatchId);
    const failed = await failDispatch(hubRoot, created.dispatchId);
    assert.equal(failed.status, "failed");
  });

  test("getDispatch returns null for unknown dispatchId", async () => {
    const result = await getDispatch(hubRoot, "dispatch-nonexistent");
    assert.equal(result, null);
  });

  test("listDispatches returns all dispatches with optional filters", async () => {
    await createDispatch(hubRoot, { projectId: "alpha" });
    await createDispatch(hubRoot, { projectId: "beta" });
    await createDispatch(hubRoot, { projectId: "alpha" });

    const all = await listDispatches(hubRoot);
    assert.equal(all.length, 3);

    const alpha = await listDispatches(hubRoot, { projectId: "alpha" });
    assert.equal(alpha.length, 2);

    const running = await listDispatches(hubRoot, { status: "running" });
    assert.equal(running.length, 0);
  });

  test("listDispatches returns empty when no dispatches directory", async () => {
    const empty = await listDispatches(hubRoot);
    assert.deepEqual(empty, []);
  });

  test("makeDispatchId produces valid IDs", () => {
    const id = makeDispatchId();
    assert.ok(/^dispatch-\d{8}-\d{6}-[0-9a-f]{6}$/.test(id));
  });

  test("makeDispatchId rejects invalid timestamp", () => {
    assert.throws(() => makeDispatchId("not-a-date"), /invalid timestamp/);
  });

  test("createDispatch carries cwd and defaults it to sourcePath", async () => {
    const dispatch = await createDispatch(hubRoot, {
      projectId: "cwd-test",
      sourcePath: "/repos/project",
      sessionId: "sess-1",
      workerId: "worker-1",
    });

    assert.equal(dispatch.cwd, "/repos/project");
    assert.equal(dispatch.sourcePath, "/repos/project");
    assert.equal(dispatch.sessionId, "sess-1");
    assert.equal(dispatch.workerId, "worker-1");
  });

  test("createDispatch makes missing sessionId/workerId/cwd explicit null", async () => {
    const dispatch = await createDispatch(hubRoot, {
      projectId: "null-fields",
    });

    assert.equal(dispatch.sourcePath, null);
    assert.equal(dispatch.sessionId, null);
    assert.equal(dispatch.workerId, null);
    assert.equal(dispatch.cwd, null);
  });
});

describe("worker-dispatch guard", () => {
  let hubRoot;
  let sourceDir;

  const originalEnv = process.env.CPB_WORKER_DISPATCH_ENABLED;

  beforeEach(async () => {
    hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-wd-guard-"));
    sourceDir = await mkdtemp(path.join(tmpdir(), "cpb-wd-source-"));
    process.env.CPB_WORKER_DISPATCH_ENABLED = "1";
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CPB_WORKER_DISPATCH_ENABLED;
    else process.env.CPB_WORKER_DISPATCH_ENABLED = originalEnv;
  });

  test("guardSourcePath passes when sourcePath matches registry", async () => {
    await registerProject(hubRoot, { name: "guarded-project", sourcePath: sourceDir });
    await guardSourcePath(hubRoot, "guarded-project", sourceDir);
  });

  test("guardSourcePath rejects mismatched sourcePath", async () => {
    const otherDir = await mkdtemp(path.join(tmpdir(), "cpb-wd-other-"));
    await registerProject(hubRoot, { name: "mismatch-project", sourcePath: sourceDir });
    await assert.rejects(
      () => guardSourcePath(hubRoot, "mismatch-project", otherDir),
      /sourcePath mismatch/,
    );
  });

  test("guardSourcePath is no-op when dispatch not enabled", async () => {
    process.env.CPB_WORKER_DISPATCH_ENABLED = undefined;
    const otherDir = await mkdtemp(path.join(tmpdir(), "cpb-wd-noop-"));
    await registerProject(hubRoot, { name: "noop-project", sourcePath: sourceDir });
    await guardSourcePath(hubRoot, "noop-project", otherDir);
  });

  test("recordDispatch returns null when dispatch not enabled", async () => {
    process.env.CPB_WORKER_DISPATCH_ENABLED = undefined;
    const result = await recordDispatch(hubRoot, { projectId: "p1" });
    assert.equal(result, null);
  });

  test("recordDispatch creates dispatch when enabled", async () => {
    const dispatch = await recordDispatch(hubRoot, {
      projectId: "p1",
      sourcePath: "/x",
      sessionId: "s1",
      queueEntryId: "q1",
    });
    assert.ok(dispatch);
    assert.equal(dispatch.projectId, "p1");
    assert.equal(dispatch.sourcePath, "/x");
  });

  test("markDispatch* functions are no-op when not enabled", async () => {
    process.env.CPB_WORKER_DISPATCH_ENABLED = undefined;
    const result = await markDispatchAssigned(hubRoot, "dispatch-xxx", { workerId: "w1" });
    assert.equal(result, null);
    const started = await markDispatchStarted(hubRoot, "dispatch-xxx");
    assert.equal(started, null);
    const completed = await markDispatchCompleted(hubRoot, "dispatch-xxx");
    assert.equal(completed, null);
    const failed = await markDispatchFailed(hubRoot, "dispatch-xxx");
    assert.equal(failed, null);
  });
});
