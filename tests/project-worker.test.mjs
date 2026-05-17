import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { describe, beforeEach, afterEach } from "node:test";

import { ProjectWorker, parseArgs } from "../bridges/project-worker.mjs";
import { registerProject, heartbeatWorker, getProject } from "../server/services/hub-registry.js";
import { enqueue, listQueue, queueStatus } from "../server/services/hub-queue.js";
import { listDispatches } from "../server/services/dispatch-state.js";

describe("ProjectWorker", () => {
  let hubRoot;
  let sourceDir;
  let projectId;
  const originalDispatch = process.env.CPB_WORKER_DISPATCH_ENABLED;

  beforeEach(async () => {
    hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-pw-hub-"));
    sourceDir = await mkdtemp(path.join(tmpdir(), "cpb-pw-src-"));
    const project = await registerProject(hubRoot, { name: "test-proj", sourcePath: sourceDir });
    projectId = project.id;
  });

  afterEach(() => {
    if (originalDispatch === undefined) delete process.env.CPB_WORKER_DISPATCH_ENABLED;
    else process.env.CPB_WORKER_DISPATCH_ENABLED = originalDispatch;
  });

  function makeWorker(opts = {}) {
    return new ProjectWorker({
      projectId,
      hubRoot,
      once: true,
      runPipelineFn: opts.runPipelineFn || (() => Promise.resolve({ ok: true, code: 0, stdout: "", stderr: "" })),
      ...opts,
    });
  }

  test("init resolves project from registry", async () => {
    const worker = makeWorker();
    const project = await worker.init();
    assert.equal(project.id, projectId);
    assert.equal(project.sourcePath, await realpath(sourceDir));
  });

  test("init throws for unknown project", async () => {
    const worker = new ProjectWorker({ projectId: "no-such-project", hubRoot });
    await assert.rejects(() => worker.init(), /project not found/);
  });

  test("heartbeat registers worker on project", async () => {
    const worker = makeWorker({ workerId: "test-w-1" });
    await worker.init();
    await worker.heartbeat();

    const project = await getProject(hubRoot, projectId);
    assert.equal(project.worker.workerId, "test-w-1");
    assert.equal(project.worker.status, "online");
    assert.deepEqual(project.worker.capabilities, ["scan", "execute", "pipeline"]);
  });

  test("claimNext returns null when queue is empty", async () => {
    const worker = makeWorker();
    await worker.init();
    const entry = await worker.claimNext();
    assert.equal(entry, null);
  });

  test("claimNext claims pending entry for its project", async () => {
    const queued = await enqueue(hubRoot, {
      projectId,
      sourcePath: sourceDir,
      description: "test task",
      priority: "P1",
    });

    const worker = makeWorker();
    await worker.init();
    const claimed = await worker.claimNext();

    assert.ok(claimed);
    assert.equal(claimed.id, queued.id);
    assert.equal(claimed.status, "in_progress");
    assert.equal(claimed.claimedBy, worker.workerId);
  });

  test("claimNext ignores entries for other projects", async () => {
    const otherDir = await mkdtemp(path.join(tmpdir(), "cpb-pw-other-"));
    const other = await registerProject(hubRoot, { name: "other-proj", sourcePath: otherDir });
    await enqueue(hubRoot, { projectId: other.id, description: "other task" });

    const worker = makeWorker();
    await worker.init();
    const entry = await worker.claimNext();
    assert.equal(entry, null);
  });

  test("claimNext picks highest priority entry first", async () => {
    await enqueue(hubRoot, { projectId, description: "low", priority: "P2" });
    await enqueue(hubRoot, { projectId, description: "high", priority: "P0" });

    const worker = makeWorker();
    await worker.init();
    const claimed = await worker.claimNext();

    assert.equal(claimed.description, "high");
  });

  test("executeEntry runs pipeline and returns result", async () => {
    const queued = await enqueue(hubRoot, {
      projectId,
      sourcePath: sourceDir,
      description: "exec test",
    });

    let capturedEntry = null;
    const worker = makeWorker({
      runPipelineFn: (entry) => {
        capturedEntry = entry;
        return Promise.resolve({ ok: true, code: 0, stdout: "done", stderr: "" });
      },
    });
    await worker.init();
    const result = await worker.executeEntry(queued);

    assert.equal(result.ok, true);
    assert.equal(capturedEntry.id, queued.id);
  });

  test("executeEntry fails on sourcePath guard mismatch when dispatch enabled", async () => {
    process.env.CPB_WORKER_DISPATCH_ENABLED = "1";
    const otherDir = await mkdtemp(path.join(tmpdir(), "cpb-pw-mismatch-"));

    const queued = await enqueue(hubRoot, {
      projectId,
      sourcePath: otherDir,
      description: "guard test",
    });

    const worker = makeWorker();
    await worker.init();
    const result = await worker.executeEntry(queued);

    assert.equal(result.ok, false);
    assert.match(result.error, /sourcePath guard/);
  });

  test("executeEntry records dispatch lifecycle when enabled", async () => {
    process.env.CPB_WORKER_DISPATCH_ENABLED = "1";

    const queued = await enqueue(hubRoot, {
      projectId,
      sourcePath: sourceDir,
      description: "dispatch lifecycle",
    });

    const worker = makeWorker();
    await worker.init();
    await worker.executeEntry(queued);

    const dispatches = await listDispatches(hubRoot);
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].projectId, projectId);
    assert.equal(dispatches[0].status, "completed");
    assert.equal(dispatches[0].workerId, worker.workerId);
    assert.equal(dispatches[0].queueEntryId, queued.id);
  });

  test("executeEntry records failed dispatch on pipeline failure", async () => {
    process.env.CPB_WORKER_DISPATCH_ENABLED = "1";

    const queued = await enqueue(hubRoot, {
      projectId,
      sourcePath: sourceDir,
      description: "fail dispatch",
    });

    const worker = makeWorker({
      runPipelineFn: () => Promise.resolve({ ok: false, code: 1, stdout: "", stderr: "boom" }),
    });
    await worker.init();
    await worker.executeEntry(queued);

    const dispatches = await listDispatches(hubRoot);
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].status, "failed");
  });

  test("poll marks queue entry completed on success", async () => {
    await enqueue(hubRoot, { projectId, description: "poll ok", sourcePath: sourceDir });

    const worker = makeWorker();
    await worker.init();
    const result = await worker.poll();

    assert.ok(result.entry);
    assert.equal(result.result.ok, true);

    const entries = await listQueue(hubRoot);
    assert.equal(entries[0].status, "completed");
  });

  test("poll marks queue entry failed on pipeline failure", async () => {
    await enqueue(hubRoot, { projectId, description: "poll fail", sourcePath: sourceDir });

    const worker = makeWorker({
      runPipelineFn: () => Promise.resolve({ ok: false, code: 1, stdout: "", stderr: "err" }),
    });
    await worker.init();
    const result = await worker.poll();

    assert.ok(result.entry);
    assert.equal(result.result.ok, false);

    const entries = await listQueue(hubRoot);
    assert.equal(entries[0].status, "failed");
  });

  test("poll returns idle when no entries", async () => {
    const worker = makeWorker();
    await worker.init();
    const result = await worker.poll();

    assert.deepEqual(result, { idle: true });
  });

  test("run with once=true processes single entry then exits", async () => {
    await enqueue(hubRoot, { projectId, description: "once-a", sourcePath: sourceDir });
    await enqueue(hubRoot, { projectId, description: "once-b", sourcePath: sourceDir });

    const worker = makeWorker();
    const result = await worker.run();

    assert.ok(result.entry);
    assert.equal(result.result.ok, true);

    // Only one entry should be claimed
    const entries = await listQueue(hubRoot);
    const claimed = entries.filter((e) => e.status === "completed");
    const pending = entries.filter((e) => e.status === "pending");
    assert.equal(claimed.length, 1);
    assert.equal(pending.length, 1);
  });

  test("run with once=true returns idle when queue empty", async () => {
    const worker = makeWorker();
    const result = await worker.run();

    assert.deepEqual(result, { idle: true });
  });

  test("worker heartbeat is active during run", async () => {
    await enqueue(hubRoot, { projectId, description: "hb test", sourcePath: sourceDir });

    const worker = makeWorker();
    await worker.run();

    const project = await getProject(hubRoot, projectId);
    assert.equal(project.worker.status, "online");
  });

  test("no dispatch records when dispatch not enabled", async () => {
    delete process.env.CPB_WORKER_DISPATCH_ENABLED;

    await enqueue(hubRoot, { projectId, description: "no dispatch", sourcePath: sourceDir });

    const worker = makeWorker();
    await worker.run();

    const dispatches = await listDispatches(hubRoot);
    assert.equal(dispatches.length, 0);
  });
});

describe("parseArgs", () => {
  test("parses required --project", () => {
    const opts = parseArgs(["node", "script", "--project", "my-proj"]);
    assert.equal(opts.project, "my-proj");
    assert.equal(opts.once, false);
  });

  test("parses --once flag", () => {
    const opts = parseArgs(["node", "script", "--project", "p", "--once"]);
    assert.equal(opts.once, true);
  });

  test("parses --workflow", () => {
    const opts = parseArgs(["node", "script", "--project", "p", "--workflow", "blocked"]);
    assert.equal(opts.workflow, "blocked");
  });

  test("parses --poll-ms and --heartbeat-ms", () => {
    const opts = parseArgs(["node", "script", "--project", "p", "--poll-ms", "1000", "--heartbeat-ms", "5000"]);
    assert.equal(opts.pollMs, 1000);
    assert.equal(opts.heartbeatMs, 5000);
  });

  test("throws on unknown argument", () => {
    assert.throws(() => parseArgs(["node", "script", "--bogus"]), /unknown argument/);
  });

  test("sets help flag", () => {
    const opts = parseArgs(["node", "script", "--help"]);
    assert.equal(opts.help, true);
  });

  test("parses --claim-timeout-ms", () => {
    const opts = parseArgs(["node", "script", "--project", "p", "--claim-timeout-ms", "60000"]);
    assert.equal(opts.claimTimeoutMs, 60000);
  });

  test("default claim-timeout-ms is 120000", () => {
    const opts = parseArgs(["node", "script", "--project", "p"]);
    assert.equal(opts.claimTimeoutMs, 120_000);
  });
});

describe("ProjectWorker stale queue recovery", () => {
  let hubRoot;
  let sourceDir;
  let projectId;

  beforeEach(async () => {
    hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-pw-hub-"));
    sourceDir = await mkdtemp(path.join(tmpdir(), "cpb-pw-src-"));
    const project = await registerProject(hubRoot, { name: "test-proj", sourcePath: sourceDir });
    projectId = project.id;
  });

  function makeWorker(opts = {}) {
    return new ProjectWorker({
      projectId,
      hubRoot,
      once: true,
      runPipelineFn: opts.runPipelineFn || (() => Promise.resolve({ ok: true, code: 0, stdout: "", stderr: "" })),
      ...opts,
    });
  }

  async function claimAs(workerId, entryId, claimedAtIso) {
    const { updateEntry } = await import("../server/services/hub-queue.js");
    return updateEntry(hubRoot, entryId, {
      status: "in_progress",
      claimedBy: workerId,
      workerId,
      claimedAt: claimedAtIso,
    });
  }

  test("recoverStaleEntries resets expired entries claimed by another worker", async () => {
    const queued = await enqueue(hubRoot, { projectId, description: "stale-task", sourcePath: sourceDir });
    const oldTime = new Date(Date.now() - 200_000).toISOString();
    await claimAs("worker-dead", queued.id, oldTime);

    const worker = makeWorker({ workerId: "worker-b", claimTimeoutMs: 100_000 });
    await worker.init();
    const recovered = await worker.recoverStaleEntries();

    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, queued.id);
    assert.equal(recovered[0].action, "reset");

    const entries = await listQueue(hubRoot, { projectId });
    assert.equal(entries[0].status, "pending");
    assert.equal(entries[0].claimedBy, null);
  });

  test("recoverStaleEntries reclaims expired entries claimed by same workerId", async () => {
    const queued = await enqueue(hubRoot, { projectId, description: "own-stale", sourcePath: sourceDir });
    const oldTime = new Date(Date.now() - 200_000).toISOString();
    await claimAs("worker-restart", queued.id, oldTime);

    const worker = makeWorker({ workerId: "worker-restart", claimTimeoutMs: 100_000 });
    await worker.init();
    const recovered = await worker.recoverStaleEntries();

    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].action, "reclaimed");

    const entries = await listQueue(hubRoot, { projectId });
    assert.equal(entries[0].status, "in_progress");
    assert.equal(entries[0].claimedBy, "worker-restart");
    assert.ok(new Date(entries[0].claimedAt).getTime() > new Date(oldTime).getTime());
  });

  test("recoverStaleEntries does not touch entries before timeout", async () => {
    const queued = await enqueue(hubRoot, { projectId, description: "fresh-task", sourcePath: sourceDir });
    const recentTime = new Date(Date.now() - 5_000).toISOString();
    await claimAs("worker-a", queued.id, recentTime);

    const worker = makeWorker({ workerId: "worker-b", claimTimeoutMs: 100_000 });
    await worker.init();
    const recovered = await worker.recoverStaleEntries();

    assert.equal(recovered.length, 0);

    const entries = await listQueue(hubRoot, { projectId });
    assert.equal(entries[0].status, "in_progress");
    assert.equal(entries[0].claimedBy, "worker-a");
  });

  test("recoverStaleEntries does not touch other project entries", async () => {
    const otherDir = await mkdtemp(path.join(tmpdir(), "cpb-pw-other-"));
    const other = await registerProject(hubRoot, { name: "other-proj", sourcePath: otherDir });
    const otherEntry = await enqueue(hubRoot, { projectId: other.id, description: "other-stale" });
    const oldTime = new Date(Date.now() - 200_000).toISOString();
    await claimAs("worker-x", otherEntry.id, oldTime);

    const worker = makeWorker({ workerId: "worker-b", claimTimeoutMs: 100_000 });
    await worker.init();
    const recovered = await worker.recoverStaleEntries();

    assert.equal(recovered.length, 0);

    const entries = await listQueue(hubRoot, { projectId: other.id });
    assert.equal(entries[0].status, "in_progress");
    assert.equal(entries[0].claimedBy, "worker-x");
  });

  test("recoverStaleEntries is no-op when claimTimeoutMs is 0", async () => {
    const queued = await enqueue(hubRoot, { projectId, description: "no-recover", sourcePath: sourceDir });
    const oldTime = new Date(Date.now() - 200_000).toISOString();
    await claimAs("worker-dead", queued.id, oldTime);

    const worker = makeWorker({ workerId: "worker-b", claimTimeoutMs: 0 });
    await worker.init();
    const recovered = await worker.recoverStaleEntries();

    assert.equal(recovered.length, 0);
  });

  test("releaseOwnEntries resets only own non-active entries on graceful stop", async () => {
    const entry1 = await enqueue(hubRoot, { projectId, description: "owned-a", sourcePath: sourceDir });
    const entry2 = await enqueue(hubRoot, { projectId, description: "owned-b", sourcePath: sourceDir });
    await claimAs("worker-stop", entry1.id, new Date().toISOString());
    await claimAs("worker-stop", entry2.id, new Date().toISOString());

    const worker = makeWorker({ workerId: "worker-stop" });
    await worker.init();
    worker._activeEntryId = entry1.id;

    const released = await worker.releaseOwnEntries();
    assert.deepEqual(released, [entry2.id]);

    const entries = await listQueue(hubRoot, { projectId });
    const e1 = entries.find((e) => e.id === entry1.id);
    const e2 = entries.find((e) => e.id === entry2.id);
    assert.equal(e1.status, "in_progress");
    assert.equal(e2.status, "pending");
  });

  test("releaseOwnEntries does not touch entries from other workers", async () => {
    const entry = await enqueue(hubRoot, { projectId, description: "other-owned", sourcePath: sourceDir });
    await claimAs("worker-other", entry.id, new Date().toISOString());

    const worker = makeWorker({ workerId: "worker-stop" });
    await worker.init();
    const released = await worker.releaseOwnEntries();
    assert.equal(released.length, 0);

    const entries = await listQueue(hubRoot, { projectId });
    assert.equal(entries[0].status, "in_progress");
    assert.equal(entries[0].claimedBy, "worker-other");
  });

  test("claimNext sets claimedAt on claim", async () => {
    await enqueue(hubRoot, { projectId, description: "claim-time", sourcePath: sourceDir });

    const worker = makeWorker();
    await worker.init();
    const before = Date.now();
    const claimed = await worker.claimNext();
    const after = Date.now();

    assert.ok(claimed.claimedAt);
    const claimedMs = new Date(claimed.claimedAt).getTime();
    assert.ok(claimedMs >= before && claimedMs <= after);
  });

  test("heartbeat includes claimTimeoutMs", async () => {
    const worker = makeWorker({ workerId: "hb-meta", claimTimeoutMs: 45_000 });
    await worker.init();
    await worker.heartbeat();

    const project = await getProject(hubRoot, projectId);
    assert.equal(project.worker.claimTimeoutMs, 45_000);
  });

  test("worker B claims entry after timeout expires following worker A crash", async () => {
    const queued = await enqueue(hubRoot, { projectId, description: "crash-recover", sourcePath: sourceDir });
    const oldTime = new Date(Date.now() - 300_000).toISOString();
    await claimAs("worker-a", queued.id, oldTime);

    const workerB = makeWorker({ workerId: "worker-b", claimTimeoutMs: 100_000 });
    await workerB.init();
    await workerB.recoverStaleEntries();

    const reclaimed = await workerB.claimNext();
    assert.ok(reclaimed);
    assert.equal(reclaimed.id, queued.id);
    assert.equal(reclaimed.claimedBy, "worker-b");
    assert.equal(reclaimed.status, "in_progress");
  });

  test("worker B cannot claim before timeout expires", async () => {
    const queued = await enqueue(hubRoot, { projectId, description: "not-yet", sourcePath: sourceDir });
    const recentTime = new Date(Date.now() - 5_000).toISOString();
    await claimAs("worker-a", queued.id, recentTime);

    const workerB = makeWorker({ workerId: "worker-b", claimTimeoutMs: 100_000 });
    await workerB.init();
    await workerB.recoverStaleEntries();

    const claimed = await workerB.claimNext();
    assert.equal(claimed, null);
  });
});
