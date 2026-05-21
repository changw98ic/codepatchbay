import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { describe, beforeEach, afterEach } from "node:test";

import { ProjectWorker, parseArgs } from "../bridges/project-worker.mjs";
import { registerProject, heartbeatWorker, getProject } from "../server/services/hub-registry.js";
import { enqueue, listQueue, queueStatus } from "../server/services/hub-queue.js";
import { appendEvent } from "../server/services/event-store.js";
import { listDispatches } from "../server/services/dispatch-state.js";

describe("ProjectWorker", () => {
  let hubRoot;
  let sourceDir;
  let projectId;
  const originalDispatch = process.env.CPB_WORKER_DISPATCH_ENABLED;
  const originalWorkerWorktreeMode = process.env.CPB_WORKER_WORKTREE_MODE;
  const originalUseWorktree = process.env.CPB_USE_WORKTREE;

  beforeEach(async () => {
    hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-pw-hub-"));
    sourceDir = await mkdtemp(path.join(tmpdir(), "cpb-pw-src-"));
    const project = await registerProject(hubRoot, { name: "test-proj", sourcePath: sourceDir });
    projectId = project.id;
  });

  afterEach(() => {
    if (originalDispatch === undefined) delete process.env.CPB_WORKER_DISPATCH_ENABLED;
    else process.env.CPB_WORKER_DISPATCH_ENABLED = originalDispatch;
    if (originalWorkerWorktreeMode === undefined) delete process.env.CPB_WORKER_WORKTREE_MODE;
    else process.env.CPB_WORKER_WORKTREE_MODE = originalWorkerWorktreeMode;
    if (originalUseWorktree === undefined) delete process.env.CPB_USE_WORKTREE;
    else process.env.CPB_USE_WORKTREE = originalUseWorktree;
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

  test("runPipeline executes from executorRoot while preserving cpbRoot state path", async () => {
    const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-pw-state-root-"));
    const executorRoot = await mkdtemp(path.join(tmpdir(), "cpb-pw-executor-root-"));
    const capturePath = path.join(executorRoot, "capture.json");
    await mkdir(path.join(executorRoot, "bridges"), { recursive: true });
    await writeFile(
      path.join(executorRoot, "bridges", "run-pipeline.mjs"),
      [
        "import { writeFile } from 'node:fs/promises';",
        "await writeFile(process.env.CAPTURE_PATH, JSON.stringify({",
        "  cwd: process.cwd(),",
        "  cpbRoot: process.env.CPB_ROOT,",
        "  executorRoot: process.env.CPB_EXECUTOR_ROOT,",
        "  acpCwd: process.env.CPB_ACP_CWD,",
        "  useWorktree: process.env.CPB_USE_WORKTREE,",
        "  args: process.argv.slice(2),",
        "}, null, 2));",
      ].join("\n"),
      "utf8",
    );

    const queued = await enqueue(hubRoot, {
      projectId,
      sourcePath: sourceDir,
      description: "executor root run",
    });
    const previousCapturePath = process.env.CAPTURE_PATH;
    process.env.CAPTURE_PATH = capturePath;
    try {
      const worker = new ProjectWorker({
        projectId,
        hubRoot,
        cpbRoot,
        executorRoot,
        once: true,
        agentHealthFn: async () => ({ codex: true, claude: true }),
      });
      await worker.init();
      const result = await worker.executeEntry(queued);
      assert.equal(result.ok, true);
    } finally {
      if (previousCapturePath === undefined) delete process.env.CAPTURE_PATH;
      else process.env.CAPTURE_PATH = previousCapturePath;
    }

    const capture = JSON.parse(await readFile(capturePath, "utf8"));
    assert.equal(capture.cwd, await realpath(cpbRoot));
    assert.equal(capture.cpbRoot, path.resolve(cpbRoot));
    assert.equal(capture.executorRoot, path.resolve(executorRoot));
    assert.equal(capture.acpCwd, path.resolve(sourceDir));
    assert.equal(capture.useWorktree, "1");
    assert.ok(capture.args.includes("--source-path"));
  });

  test("runPipeline omits worktree env when worktreeMode is off", async () => {
    const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-pw-state-root-"));
    const executorRoot = await mkdtemp(path.join(tmpdir(), "cpb-pw-executor-root-"));
    const capturePath = path.join(executorRoot, "capture.json");
    await mkdir(path.join(executorRoot, "bridges"), { recursive: true });
    await writeFile(
      path.join(executorRoot, "bridges", "run-pipeline.mjs"),
      [
        "import { writeFile } from 'node:fs/promises';",
        "await writeFile(process.env.CAPTURE_PATH, JSON.stringify({",
        "  useWorktree: process.env.CPB_USE_WORKTREE || null,",
        "  projectOverride: process.env.CPB_PROJECT_PATH_OVERRIDE,",
        "  acpCwd: process.env.CPB_ACP_CWD,",
        "}, null, 2));",
      ].join("\n"),
      "utf8",
    );

    const queued = await enqueue(hubRoot, {
      projectId,
      sourcePath: sourceDir,
      description: "worktree off run",
    });
    const previousCapturePath = process.env.CAPTURE_PATH;
    process.env.CAPTURE_PATH = capturePath;
    process.env.CPB_USE_WORKTREE = "1";
    try {
      const worker = new ProjectWorker({
        projectId,
        hubRoot,
        cpbRoot,
        executorRoot,
        once: true,
        worktreeMode: "off",
        agentHealthFn: async () => ({ codex: true, claude: true }),
      });
      await worker.init();
      const result = await worker.executeEntry(queued);
      assert.equal(result.ok, true);
    } finally {
      if (previousCapturePath === undefined) delete process.env.CAPTURE_PATH;
      else process.env.CAPTURE_PATH = previousCapturePath;
    }

    const capture = JSON.parse(await readFile(capturePath, "utf8"));
    assert.equal(capture.useWorktree, null);
    assert.equal(capture.projectOverride, path.resolve(sourceDir));
    assert.equal(capture.acpCwd, path.resolve(sourceDir));
  });

  test("runPipeline omits worktree env when CPB_WORKER_WORKTREE_MODE is off", async () => {
    process.env.CPB_WORKER_WORKTREE_MODE = "off";
    let capturedWorktree = null;
    const queued = await enqueue(hubRoot, {
      projectId,
      sourcePath: sourceDir,
      description: "env worktree off",
    });

    const worker = makeWorker({
      runPipelineFn: (_entry, _sourcePath, _dispatchId, _overrideProjectId, worktree) => {
        capturedWorktree = worktree;
        return Promise.resolve({ ok: true, code: 0, stdout: "", stderr: "" });
      },
    });
    await worker.init();
    const result = await worker.executeEntry(queued);

    assert.equal(result.ok, true);
    assert.deepEqual(capturedWorktree, { worktreeMode: "off", useWorktree: false });
  });

  test("runPipelineFn receives default worktree mode metadata", async () => {
    let capturedWorktree = null;
    const queued = await enqueue(hubRoot, {
      projectId,
      sourcePath: sourceDir,
      description: "worktree metadata",
    });

    const worker = makeWorker({
      runPipelineFn: (_entry, _sourcePath, _dispatchId, _overrideProjectId, worktree) => {
        capturedWorktree = worktree;
        return Promise.resolve({ ok: true, code: 0, stdout: "", stderr: "" });
      },
    });
    await worker.init();
    const result = await worker.executeEntry(queued);

    assert.equal(result.ok, true);
    assert.deepEqual(capturedWorktree, { worktreeMode: "required", useWorktree: true });
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

  test("poll runs finalizer before marking linked queue entry completed", async () => {
    await enqueue(hubRoot, {
      projectId,
      description: "poll finalizer ok",
      sourcePath: sourceDir,
      metadata: { issueNumber: 58, repositoryFullName: "owner/repo" },
    });

    let finalizerInput = null;
    const worker = makeWorker({
      requireIssueLink: true,
      autoFinalizerMode: "remote",
      runPipelineFn: () => Promise.resolve({
        ok: true,
        code: 0,
        stdout: "done",
        stderr: "",
        job: { jobId: "job-finalizer-ok", status: "completed", worktree: sourceDir },
      }),
      finalizerFn: async (input) => {
        finalizerInput = input;
        return { ok: true, status: "finalized", commit: "abc123", closed: true };
      },
    });
    await worker.init();
    const result = await worker.poll();

    assert.equal(result.result.ok, true);
    assert.equal(finalizerInput.mode, "remote");
    assert.equal(finalizerInput.entry.metadata.issueNumber, 58);
    assert.equal(finalizerInput.job.jobId, "job-finalizer-ok");

    const entries = await listQueue(hubRoot);
    assert.equal(entries[0].status, "completed");
    assert.deepEqual(entries[0].metadata.finalizer, {
      ok: true,
      status: "finalized",
      code: null,
      commit: "abc123",
      closed: true,
      mode: "remote",
      jobId: "job-finalizer-ok",
      inspectedStatus: "completed",
      stateSource: "pipeline-result",
    });
  });

  test("poll fails queue entry when finalizer reports job not completed", async () => {
    await enqueue(hubRoot, {
      projectId,
      description: "poll finalizer skipped",
      sourcePath: sourceDir,
      metadata: { issueNumber: 60, repositoryFullName: "owner/repo" },
    });

    const worker = makeWorker({
      requireIssueLink: true,
      autoFinalizerMode: "remote",
      workflow: "blocked",
      runPipelineFn: () => Promise.resolve({
        ok: true,
        code: 0,
        stdout: "blocked",
        stderr: "",
        job: { jobId: "job-finalizer-skipped", status: "blocked", worktree: sourceDir },
      }),
    });
    await worker.init();
    const result = await worker.poll();

    assert.equal(result.result.ok, false);
    assert.equal(result.result.error, "finalizer rejected: JOB_NOT_COMPLETED");

    const entries = await listQueue(hubRoot);
    assert.equal(entries[0].status, "failed");
    assert.deepEqual(entries[0].metadata.finalizer, {
      ok: false,
      status: "skipped",
      code: "JOB_NOT_COMPLETED",
      commit: null,
      closed: null,
      mode: "remote",
      jobId: "job-finalizer-skipped",
      inspectedStatus: "blocked",
      stateSource: "pipeline-result",
    });
  });

  test("poll marks queue entry failed when finalizer refuses", async () => {
    await enqueue(hubRoot, {
      projectId,
      description: "poll finalizer rejected",
      sourcePath: sourceDir,
      metadata: { issueNumber: 59, repositoryFullName: "owner/repo" },
    });

    const worker = makeWorker({
      requireIssueLink: true,
      autoFinalizerMode: "remote",
      runPipelineFn: () => Promise.resolve({
        ok: true,
        code: 0,
        stdout: "done",
        stderr: "",
        job: { jobId: "job-finalizer-nope", status: "completed", worktree: sourceDir },
      }),
      finalizerFn: async () => ({ ok: false, status: "rejected", code: "UNSAFE_WORKTREE_CHANGES" }),
    });
    await worker.init();
    const result = await worker.poll();

    assert.equal(result.result.ok, false);
    assert.equal(result.result.error, "finalizer rejected: UNSAFE_WORKTREE_CHANGES");

    const entries = await listQueue(hubRoot);
    assert.equal(entries[0].status, "failed");
    assert.deepEqual(entries[0].metadata.finalizer, {
      ok: false,
      status: "rejected",
      code: "UNSAFE_WORKTREE_CHANGES",
      commit: null,
      closed: null,
      mode: "remote",
      jobId: "job-finalizer-nope",
      inspectedStatus: "completed",
      stateSource: "pipeline-result",
    });
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

  test("poll runs when at least one agent passes preflight", async () => {
    await enqueue(hubRoot, { projectId, description: "one-agent-ok", sourcePath: sourceDir });

    let pipelineCalls = 0;
    let healthCalls = 0;
    const worker = makeWorker({
      agentHealthFn: async () => {
        healthCalls++;
        return { codex: true, claude: false };
      },
      runPipelineFn: () => {
        pipelineCalls++;
        return Promise.resolve({ ok: true, code: 0, stdout: "", stderr: "" });
      },
    });
    await worker.init();
    const result = await worker.poll();

    assert.equal(healthCalls, 1);
    assert.equal(pipelineCalls, 1);
    assert.ok(result.entry);
    assert.equal(result.result.ok, true);

    const entries = await listQueue(hubRoot);
    assert.equal(entries[0].status, "completed");
  });

  test("poll skips agent preflight for blocked workflow", async () => {
    await enqueue(hubRoot, { projectId, description: "blocked-no-agent", sourcePath: sourceDir });

    let pipelineCalls = 0;
    let healthCalls = 0;
    const worker = makeWorker({
      workflow: "blocked",
      agentHealthFn: async () => {
        healthCalls++;
        return { codex: false, claude: false };
      },
      runPipelineFn: () => {
        pipelineCalls++;
        return Promise.resolve({ ok: true, code: 0, stdout: "", stderr: "" });
      },
    });
    await worker.init();
    const result = await worker.poll();

    assert.equal(healthCalls, 0);
    assert.equal(pipelineCalls, 1);
    assert.ok(result.entry);
    assert.equal(result.result.ok, true);

    const entries = await listQueue(hubRoot);
    assert.equal(entries[0].status, "completed");
  });

  test("poll backs off three times and stops without leaving a claim when both agents fail preflight", async () => {
    await enqueue(hubRoot, { projectId, description: "both-agents-down", sourcePath: sourceDir });

    let healthCalls = 0;
    let pipelineCalls = 0;
    const worker = makeWorker({
      agentPreflightRetries: 3,
      agentPreflightBackoffMs: 1,
      agentHealthFn: async () => {
        healthCalls++;
        return { codex: false, claude: false };
      },
      runPipelineFn: () => {
        pipelineCalls++;
        return Promise.resolve({ ok: true, code: 0, stdout: "", stderr: "" });
      },
    });
    await worker.init();
    const result = await worker.poll();

    assert.equal(healthCalls, 3);
    assert.equal(pipelineCalls, 0);
    assert.equal(result.stopped, true);
    assert.equal(result.reason, "agents_unavailable");

    const entries = await listQueue(hubRoot);
    assert.equal(entries[0].status, "pending");
    assert.equal(entries[0].claimedBy, null);
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

  test("parses --worktree-mode", () => {
    const opts = parseArgs(["node", "script", "--project", "p", "--worktree-mode", "off"]);
    assert.equal(opts.worktreeMode, "off");
  });

  test("rejects invalid --worktree-mode", () => {
    assert.throws(
      () => parseArgs(["node", "script", "--project", "p", "--worktree-mode", "maybe"]),
      /invalid worktree mode: maybe/,
    );
  });

  test("parses --auto-finalizer-mode", () => {
    const opts = parseArgs(["node", "script", "--project", "p", "--auto-finalizer-mode", "local"]);
    assert.equal(opts.autoFinalizerMode, "local");
  });

  test("rejects invalid --auto-finalizer-mode", () => {
    assert.throws(
      () => parseArgs(["node", "script", "--project", "p", "--auto-finalizer-mode", "maybe"]),
      /invalid auto-finalizer mode: maybe/,
    );
  });

  test("parses accelerated --workflow", () => {
    const opts = parseArgs(["node", "script", "--project", "p", "--workflow", "accelerated"]);
    assert.equal(opts.workflow, "accelerated");
  });

  test("rejects unknown --workflow", () => {
    assert.throws(
      () => parseArgs(["node", "script", "--project", "p", "--workflow", "surprise"]),
      /invalid workflow: surprise/,
    );
  });

  test("parses --executor-root", () => {
    const opts = parseArgs(["node", "script", "--project", "p", "--executor-root", "/tmp/cpb-release"]);
    assert.equal(opts.executorRoot, "/tmp/cpb-release");
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

  test("parses agent preflight retry options", () => {
    const opts = parseArgs([
      "node",
      "script",
      "--project",
      "p",
      "--agent-preflight-retries",
      "3",
      "--agent-preflight-backoff-ms",
      "250",
      "--agent-preflight-timeout-ms",
      "1000",
    ]);
    assert.equal(opts.agentPreflightRetries, 3);
    assert.equal(opts.agentPreflightBackoffMs, 250);
    assert.equal(opts.agentPreflightTimeoutMs, 1000);
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

describe("ProjectWorker crash and reconnect resilience", () => {
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

  test("heartbeat suppresses transient errors and worker continues processing", async () => {
    await enqueue(hubRoot, { projectId, description: "heartbeat-resilience", sourcePath: sourceDir });

    let heartbeatAttempts = 0;
    const worker = new ProjectWorker({
      projectId,
      hubRoot,
      once: true,
      heartbeatMs: 10,
      runPipelineFn: () => Promise.resolve({ ok: true, code: 0, stdout: "", stderr: "" }),
    });

    // Monkey-patch init to intercept heartbeat: after init, sabotage the hubRoot
    // so the first heartbeat fails, then restore it.
    const origInit = worker.init.bind(worker);
    worker.init = async () => {
      const result = await origInit();
      // Temporarily corrupt hubRoot to force heartbeat failure
      const goodHubRoot = worker.hubRoot;
      worker.hubRoot = "/nonexistent/path/for/heartbeat/test";
      // Schedule restore after a tick
      setImmediate(() => { worker.hubRoot = goodHubRoot; });
      return result;
    };

    // Should not throw despite heartbeat failure
    const result = await worker.run();
    assert.ok(result.entry);
    assert.equal(result.result.ok, true);

    // Worker should have processed the entry regardless
    const entries = await listQueue(hubRoot);
    assert.equal(entries[0].status, "completed");
  });

  test("poll cleans up _activeEntryId when executeEntry throws", async () => {
    const queued = await enqueue(hubRoot, { projectId, description: "throw-cleanup", sourcePath: sourceDir });

    const worker = makeWorker({
      runPipelineFn: () => Promise.reject(new Error("pipeline exploded")),
    });
    await worker.init();

    // poll should throw because executeEntry rejects
    await assert.rejects(() => worker.poll(), /pipeline exploded/);

    // _activeEntryId must be reset even after the throw
    assert.equal(worker._activeEntryId, null);
  });

  test("continuous loop survives transient poll errors", async () => {
    let pollCount = 0;
    let pipelineCalls = 0;

    const worker = new ProjectWorker({
      projectId,
      hubRoot,
      once: false,
      pollMs: 10,
      heartbeatMs: 50,
      runPipelineFn: () => {
        pipelineCalls++;
        return Promise.resolve({ ok: true, code: 0, stdout: "", stderr: "" });
      },
    });

    // Enqueue one entry
    await enqueue(hubRoot, { projectId, description: "resilient-task", sourcePath: sourceDir });

    // Monkey-patch claimNext to throw on first call, succeed after
    const origClaimNext = worker.claimNext.bind(worker);
    let firstCall = true;
    worker.claimNext = async () => {
      pollCount++;
      if (firstCall) {
        firstCall = false;
        throw new Error("transient queue read error");
      }
      const entry = await origClaimNext();
      // After successful claim+execute, stop the loop
      if (entry) worker.requestStop();
      return entry;
    };

    await worker.init();
    // run() should complete without throwing despite the first poll error
    const result = await worker.run();
    assert.equal(result.stopped, true);
    assert.ok(pipelineCalls >= 1, "pipeline should have run after recovery");

    const entries = await listQueue(hubRoot);
    assert.equal(entries[0].status, "completed");
  });

  test("worker A crash does not affect project B queue or state", async () => {
    // Set up two projects
    const sourceDirB = await mkdtemp(path.join(tmpdir(), "cpb-pw-srcB-"));
    const projectB = await registerProject(hubRoot, { name: "proj-b", sourcePath: sourceDirB });

    // Both projects have pending entries
    const entryA = await enqueue(hubRoot, { projectId, description: "proj-a-task", sourcePath: sourceDir });
    const entryB = await enqueue(hubRoot, { projectId: projectB.id, description: "proj-b-task", sourcePath: sourceDirB });

    // Worker A claims and "crashes" mid-execution
    const workerA = makeWorker({ workerId: "worker-a-crash" });
    await workerA.init();
    await workerA.heartbeat();
    const claimed = await workerA.claimNext();
    assert.ok(claimed);
    assert.equal(claimed.id, entryA.id);

    // Simulate crash: leave entry in_progress, don't release or complete
    // (worker just stops without cleanup)

    // Worker B should see project B's entry untouched
    const workerB = new ProjectWorker({
      projectId: projectB.id,
      hubRoot,
      once: true,
      runPipelineFn: () => Promise.resolve({ ok: true, code: 0, stdout: "", stderr: "" }),
    });
    await workerB.init();
    await workerB.heartbeat();
    const result = await workerB.run();

    assert.ok(result.entry);
    assert.equal(result.entry.id, entryB.id);
    assert.equal(result.result.ok, true);

    // Project A's entry should still be in_progress (claimed by dead worker A)
    const entriesA = await listQueue(hubRoot, { projectId, status: "in_progress" });
    assert.equal(entriesA.length, 1);
    assert.equal(entriesA[0].claimedBy, "worker-a-crash");

    // Project B's entry should be completed
    const entriesB = await listQueue(hubRoot, { projectId: projectB.id });
    assert.equal(entriesB[0].status, "completed");

    // Project A worker should show stale/offline, project B should show online
    const projA = await getProject(hubRoot, projectId);
    const projB = await getProject(hubRoot, projectB.id);
    assert.equal(projA.worker.workerId, "worker-a-crash");
    assert.equal(projB.worker.workerId.startsWith("worker-"), true);
  });

  test("full crash-reconnect lifecycle: crash → recover → re-claim → complete", async () => {
    const queued = await enqueue(hubRoot, { projectId, description: "lifecycle-task", sourcePath: sourceDir });

    // Phase 1: Worker A starts, claims, heartbeat, then "crashes" mid-execution
    const workerA = makeWorker({ workerId: "lifecycle-a", claimTimeoutMs: 1_000 });
    await workerA.init();
    await workerA.heartbeat();
    const claimed = await workerA.claimNext();
    assert.ok(claimed);
    assert.equal(claimed.status, "in_progress");

    // Simulate crash: worker A stops without cleanup
    // (no releaseOwnEntries, no final status update)

    // Phase 2: Make the claim old enough to be stale
    const { updateEntry } = await import("../server/services/hub-queue.js");
    await updateEntry(hubRoot, queued.id, {
      claimedAt: new Date(Date.now() - 5_000).toISOString(),
    });

    // Phase 3: Worker B starts with short timeout, recovers stale entry, reclaims
    const workerB = makeWorker({ workerId: "lifecycle-b", claimTimeoutMs: 1_000 });
    await workerB.init();
    await workerB.heartbeat();

    const recovered = await workerB.recoverStaleEntries();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, queued.id);
    assert.equal(recovered[0].action, "reset");

    // Entry should be back to pending
    const afterRecover = await listQueue(hubRoot, { projectId });
    assert.equal(afterRecover[0].status, "pending");
    assert.equal(afterRecover[0].claimedBy, null);

    // Phase 4: Worker B claims and completes
    const result = await workerB.run();
    assert.ok(result.entry);
    assert.equal(result.entry.id, queued.id);
    assert.equal(result.result.ok, true);

    const final = await listQueue(hubRoot, { projectId });
    assert.equal(final[0].status, "completed");
  });
});

describe("ProjectWorker issue #61 finalizer metadata", () => {
  let hubRoot;
  let sourceDir;
  let cpbRoot;
  let projectId;

  beforeEach(async () => {
    hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-pw-hub-"));
    sourceDir = await mkdtemp(path.join(tmpdir(), "cpb-pw-src-"));
    cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-pw-cpb-"));
    const project = await registerProject(hubRoot, { name: "test-proj", sourcePath: sourceDir });
    projectId = project.id;
  });

  function makeWorker(opts = {}) {
    return new ProjectWorker({
      projectId,
      hubRoot,
      cpbRoot,
      once: true,
      autoFinalizerMode: "remote",
      runPipelineFn: opts.runPipelineFn || (() => Promise.resolve({ ok: true, code: 0, stdout: "", stderr: "" })),
      ...opts,
    });
  }

  test("successful pipeline with running job marks queue failed with JOB_NOT_COMPLETED", async () => {
    const jobId = "job-20260522-010000-abc123";
    const now = new Date().toISOString();
    await appendEvent(cpbRoot, projectId, jobId, {
      type: "job_created", jobId, project: projectId, task: "test", ts: now,
    });

    await enqueue(hubRoot, { projectId, description: "running-job", sourcePath: sourceDir });

    const worker = makeWorker({
      runPipelineFn: () => Promise.resolve({ ok: true, code: 0, stdout: "", stderr: "", jobId }),
    });
    await worker.init();
    await worker.poll();

    const entries = await listQueue(hubRoot);
    assert.equal(entries[0].status, "failed", "queue entry should be failed, not completed");
    assert.ok(entries[0].metadata.finalizer, "finalizer metadata should exist");
    assert.equal(entries[0].metadata.finalizer.code, "JOB_NOT_COMPLETED");
    assert.equal(entries[0].metadata.finalizer.status, "skipped");
    assert.equal(entries[0].metadata.finalizer.jobId, jobId);
    assert.equal(entries[0].metadata.finalizer.inspectedStatus, "running");
    assert.equal(entries[0].metadata.finalizer.stateSource, "job-store");
  });

  test("successful pipeline with missing job state marks queue failed", async () => {
    const jobId = "job-20260522-020000-nomatch";
    await enqueue(hubRoot, { projectId, description: "missing-job", sourcePath: sourceDir });

    const worker = makeWorker({
      runPipelineFn: () => Promise.resolve({ ok: true, code: 0, stdout: `Job ${jobId} started\n`, stderr: "" }),
    });
    await worker.init();
    await worker.poll();

    const entries = await listQueue(hubRoot);
    assert.equal(entries[0].status, "failed");
    assert.ok(entries[0].metadata.finalizer);
    assert.equal(entries[0].metadata.finalizer.code, "JOB_NOT_FOUND");
    assert.equal(entries[0].metadata.finalizer.status, "skipped");
    assert.equal(entries[0].metadata.finalizer.stateSource, "missing");
    assert.equal(entries[0].metadata.finalizer.jobId, jobId);
  });

  test("completed job with successful remote finalizer marks queue completed with metadata", async () => {
    const jobId = "job-20260522-030000-def456";
    const commit = "abc123def456";
    const now = new Date().toISOString();
    await appendEvent(cpbRoot, projectId, jobId, {
      type: "job_created", jobId, project: projectId, task: "test", ts: now,
    });
    await appendEvent(cpbRoot, projectId, jobId, {
      type: "job_completed", jobId, project: projectId, ts: now,
    });

    await enqueue(hubRoot, { projectId, description: "completed-finalize", sourcePath: sourceDir });

    let finalizerCalled = false;
    let finalizerEntry = null;
    let finalizerJobState = null;
    const worker = makeWorker({
      runPipelineFn: () => Promise.resolve({ ok: true, code: 0, stdout: "", stderr: "", jobId }),
      finalizerFn: async ({ entry, job }) => {
        finalizerCalled = true;
        finalizerEntry = entry;
        finalizerJobState = job;
        return { ok: true, status: "completed", mode: "remote", commit, closed: true };
      },
    });
    await worker.init();
    await worker.poll();

    assert.equal(finalizerCalled, true, "finalizer should have been called");
    assert.ok(finalizerEntry, "finalizer should receive the queue entry");
    assert.equal(finalizerJobState?.status, "completed", "finalizer should receive completed job state");

    const entries = await listQueue(hubRoot);
    assert.equal(entries[0].status, "completed");
    assert.equal(entries[0].metadata.finalizer.ok, true);
    assert.equal(entries[0].metadata.finalizer.code, null, "successful finalizer must not have a failure code");
    assert.equal(entries[0].metadata.finalizer.commit, commit);
    assert.equal(entries[0].metadata.finalizer.closed, true);
    assert.equal(entries[0].metadata.finalizer.mode, "remote");
    assert.equal(entries[0].metadata.finalizer.jobId, jobId);
    assert.equal(entries[0].metadata.finalizer.inspectedStatus, "completed");
    assert.equal(entries[0].metadata.finalizer.stateSource, "job-store");
  });

  test("completed job with required finalizer JOB_NOT_COMPLETED marks queue failed", async () => {
    const jobId = "job-20260522-040000-ghi789";
    const now = new Date().toISOString();
    await appendEvent(cpbRoot, projectId, jobId, {
      type: "job_created", jobId, project: projectId, task: "test", ts: now,
    });
    await appendEvent(cpbRoot, projectId, jobId, {
      type: "job_completed", jobId, project: projectId, ts: now,
    });

    await enqueue(hubRoot, { projectId, description: "finalizer-fail", sourcePath: sourceDir });

    const worker = makeWorker({
      runPipelineFn: () => Promise.resolve({ ok: true, code: 0, stdout: "", stderr: "", jobId }),
      finalizerFn: async () => ({
        ok: false, status: "skipped", code: "JOB_NOT_COMPLETED", mode: "remote",
      }),
    });
    await worker.init();
    await worker.poll();

    const entries = await listQueue(hubRoot);
    assert.equal(entries[0].status, "failed", "queue should be failed when required finalizer fails");
    assert.equal(entries[0].metadata.finalizer.ok, false);
    assert.equal(entries[0].metadata.finalizer.code, "JOB_NOT_COMPLETED");
    assert.equal(entries[0].metadata.finalizer.mode, "remote");
    assert.equal(entries[0].metadata.finalizer.jobId, jobId);
    assert.equal(entries[0].metadata.finalizer.inspectedStatus, "completed");
    assert.equal(entries[0].metadata.finalizer.stateSource, "job-store");
  });

  test("acceptable skip leaves queue completed with actionable metadata", async () => {
    const jobId = "job-20260522-050000-jkl012";
    const now = new Date().toISOString();
    await appendEvent(cpbRoot, projectId, jobId, {
      type: "job_created", jobId, project: projectId, task: "test", ts: now,
    });
    await appendEvent(cpbRoot, projectId, jobId, {
      type: "job_completed", jobId, project: projectId, ts: now,
    });

    await enqueue(hubRoot, { projectId, description: "acceptable-skip", sourcePath: sourceDir });

    const worker = makeWorker({
      runPipelineFn: () => Promise.resolve({ ok: true, code: 0, stdout: "", stderr: "", jobId }),
      finalizerFn: async () => ({
        ok: false, status: "skipped", code: "NO_REMOTE", mode: "remote", acceptableSkip: true,
      }),
    });
    await worker.init();
    await worker.poll();

    const entries = await listQueue(hubRoot);
    assert.equal(entries[0].status, "completed", "acceptable skip should leave queue completed");
    assert.ok(entries[0].metadata.finalizer);
    assert.equal(entries[0].metadata.finalizer.ok, false);
    assert.equal(entries[0].metadata.finalizer.acceptableSkip, true);
    assert.equal(entries[0].metadata.finalizer.jobId, jobId);
    assert.equal(entries[0].metadata.finalizer.inspectedStatus, "completed");
    assert.equal(entries[0].metadata.finalizer.stateSource, "job-store");
  });
});
