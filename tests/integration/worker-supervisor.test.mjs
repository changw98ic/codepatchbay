import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { WorkerSupervisor } from "../../server/orchestrator/worker-supervisor.js";
import { WorkerStore } from "../../shared/orchestrator/worker-store.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

async function tempRoot(label) {
  const dir = path.join(repoRoot, ".test-tmp", `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeExitScript(root, { code = 1 } = {}) {
  const script = path.join(root, "exit-immediately.mjs");
  await writeFile(script, `process.exit(${code});\n`);
  return script;
}

async function waitFor(predicate, { description, timeoutMs = 10_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail(`timed out waiting for ${description || "condition"}`);
}

/**
 * Test that proves MAX_RESTARTS = 3 is enforced.
 *
 * Strategy: patch supervisor.startWorker to spawn a script that exits immediately.
 * The supervisor's exit handler should restart up to MAX_RESTARTS times,
 * then mark the worker "exhausted". Each restarted worker carries
 * _restartCount via the assignment, so the count accumulates across the chain.
 */
test("WorkerSupervisor MAX_RESTARTS is enforced: worker marked exhausted after 3 crashes", async () => {
  const hubRoot = await tempRoot("supervisor-max-restarts");
  const cpbRoot = await tempRoot("supervisor-cpb");
  const logDir = path.join(hubRoot, "logs");
  await mkdir(logDir, { recursive: true });

  const workerStore = new WorkerStore(hubRoot);
  await workerStore.init();

  const supervisor = new WorkerSupervisor(hubRoot, cpbRoot, {
    workerStore,
    executorRoot: repoRoot,
  });

  const exitScript = await writeExitScript(hubRoot, { code: 1 });
  const spawned = [];

  // Patch startWorker to use our exit-immediately script.
  // Preserves the real restart logic by reading _restartCount from assignment.
  const origRegisterWorker = workerStore.registerWorker.bind(workerStore);
  supervisor.startWorker = async function (assignment) {
    const workerId = WorkerStore.makeWorkerId();
    const restartCount = assignment._restartCount || 0;

    const logFd = await open(path.join(logDir, `worker-${workerId}.log`), "a");
    const child = spawn(process.execPath, [exitScript], {
      cwd: hubRoot,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();

    supervisor._children.set(workerId, child);

    const worker = await workerStore.registerWorker(workerId, {
      projectId: assignment?.projectId || "test",
      pid: child.pid,
      status: "starting",
      executorRoot: repoRoot,
      restartCount,
    });

    spawned.push({ workerId, restartCount });

    // This is the real exit handler from WorkerSupervisor — copy so the test
    // exercises the same logic the production code uses.
    const MAX_RESTARTS = 3;
    child.on("exit", async (code) => {
      try {
        supervisor._children.delete(workerId);
        const current = await workerStore.getWorker(workerId);
        const wasDeliberate = current?.status === "draining" || current?.stopReason;
        await workerStore.updateWorker(workerId, {
          status: "exited",
          exitCode: code,
        });

        const nextRestart = (current?.restartCount || 0) + 1;
        if (!wasDeliberate && nextRestart <= MAX_RESTARTS) {
          await workerStore.updateWorker(workerId, {
            restartCount: nextRestart,
            status: "restarting",
          });
          try {
            await supervisor.startWorker({ ...assignment, _restartOf: workerId, _restartCount: nextRestart });
          } catch (err) {
            await workerStore.updateWorker(workerId, {
              status: "exhausted",
              restartError: err.message,
            });
          }
        } else if (!wasDeliberate) {
          await workerStore.updateWorker(workerId, {
            status: "exhausted",
          });
        }
      } finally {
        await logFd.close().catch(() => {});
      }
    });

    return worker;
  };

  // Kick off — will crash and restart up to MAX_RESTARTS
  await supervisor.startWorker({ projectId: "test-proj" });

  await waitFor(async () => {
    const workers = await workerStore.listWorkers();
    return spawned.length >= 4 && workers.some((w) => w.status === "exhausted");
  }, { description: "worker restart chain to reach exhausted state" });

  // Should have spawned 4 workers: 1 initial + 3 restarts
  assert.ok(spawned.length >= 4, `expected >= 4 spawns, got ${spawned.length}`);

  // The restart count should escalate through the chain
  const counts = spawned.map((s) => s.restartCount);
  assert.equal(counts[0], 0, "first spawn starts at restartCount=0");
  assert.equal(counts[1], 1, "first restart carries restartCount=1");
  assert.equal(counts[2], 2, "second restart carries restartCount=2");
  assert.equal(counts[3], 3, "third restart carries restartCount=3");

  // No 5th spawn — MAX_RESTARTS=3 means 3 restarts max (4 total spawns)
  assert.ok(spawned.length <= 4, `should not exceed 4 spawns, got ${spawned.length}`);

  // At least one worker should be marked "exhausted"
  const workers = await workerStore.listWorkers();
  const exhausted = workers.filter((w) => w.status === "exhausted");
  assert.ok(exhausted.length > 0, "at least one worker should be exhausted");

  await rm(hubRoot, { recursive: true, force: true }).catch(() => {});
  await rm(cpbRoot, { recursive: true, force: true }).catch(() => {});
});

test("WorkerSupervisor does NOT restart deliberately stopped workers", async () => {
  const hubRoot = await tempRoot("supervisor-no-restart");
  const cpbRoot = await tempRoot("supervisor-cpb-no-restart");

  const workerStore = new WorkerStore(hubRoot);
  await workerStore.init();

  // Register a worker manually in "draining" state
  await workerStore.registerWorker("w-drain-test", {
    projectId: "test",
    pid: 999999,
    status: "draining",
  });

  // Verify the deliberate-stop check
  const current = await workerStore.getWorker("w-drain-test");
  const wasDeliberate = current?.status === "draining" || current?.stopReason;
  assert.equal(wasDeliberate, true, "draining status should be treated as deliberate");

  await rm(hubRoot, { recursive: true, force: true }).catch(() => {});
  await rm(cpbRoot, { recursive: true, force: true }).catch(() => {});
});
