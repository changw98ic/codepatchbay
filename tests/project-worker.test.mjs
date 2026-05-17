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
});
