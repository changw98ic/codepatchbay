#!/usr/bin/env node
/**
 * Managed Worker — passive execution slot for Hub Orchestrator.
 *
 * Watches inbox directory for assignment files, executes via Engine.runJob(),
 * writes results back to assignment directory. Does NOT poll queue or claim entries.
 * Can run independently of Hub parent process (file-based communication).
 */

import { readFile, mkdir, writeFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";

const POLL_MS = 5_000;
const HEARTBEAT_MS = 10_000;

function parseArgs(argv) {
  const opts = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--worker-id") opts.workerId = argv[++i];
    else if (argv[i] === "--hub-root") opts.hubRoot = argv[++i];
    else if (argv[i] === "--cpb-root") opts.cpbRoot = argv[++i];
    else if (argv[i] === "--once") opts.once = true;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.workerId || !opts.hubRoot || !opts.cpbRoot) {
    process.stderr.write("Usage: managed-worker.js --worker-id <id> --hub-root <path> --cpb-root <path> [--once]\n");
    process.exit(1);
  }

  const { workerId, hubRoot, cpbRoot, once } = opts;
  const inboxDir = path.join(hubRoot, "workers", "inbox", workerId);
  await mkdir(inboxDir, { recursive: true });

  // Register self
  const registryFile = path.join(hubRoot, "workers", "registry", `worker-${workerId}.json`);
  await mkdir(path.dirname(registryFile), { recursive: true });
  await writeFile(registryFile, JSON.stringify({
    workerId,
    pid: process.pid,
    host: "local",
    status: "ready",
    startedAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
  }, null, 2) + "\n", "utf8");

  // Start heartbeat
  const heartbeatTimer = setInterval(async () => {
    try {
      const existing = JSON.parse(await readFile(registryFile, "utf8"));
      existing.lastHeartbeatAt = new Date().toISOString();
      await writeFile(registryFile, JSON.stringify(existing, null, 2) + "\n", "utf8");
    } catch { /* ignore */ }
  }, HEARTBEAT_MS);
  heartbeatTimer.unref();

  // Load unified engine (P0-5: single entry point, delegates to runPipeline internally)
  const { runJob } = await import("../../core/engine/run-job.js");

  // Process inbox
  async function processInbox() {
    const files = await readdir(inboxDir).catch(() => []);
    const jsonFiles = files.filter(f => f.endsWith(".json"));

    for (const file of jsonFiles) {
      const filePath = path.join(inboxDir, file);
      let assignment;
      try {
        assignment = JSON.parse(await readFile(filePath, "utf8"));
      } catch {
        process.stderr.write(`[worker-${workerId}] malformed inbox file: ${file}\n`);
        continue;
      }

      // Validate flattened payload (P0-2 fix)
      if (!Number.isInteger(assignment.attempt) || assignment.attempt < 1) {
        process.stderr.write(`[worker-${workerId}] invalid attempt in assignment: ${JSON.stringify(assignment.attempt)}\n`);
        await unlink(filePath).catch(() => {});
        continue;
      }
      if (!assignment.attemptToken) {
        process.stderr.write(`[worker-${workerId}] missing attemptToken in assignment\n`);
        await unlink(filePath).catch(() => {});
        continue;
      }

      const assignmentId = assignment.assignmentId;
      const attemptNum = assignment.attempt;
      const attemptDir = path.join(
        hubRoot, "assignments", assignmentId, "attempts", String(attemptNum).padStart(3, "0"),
      );

      // Update registry
      const reg = JSON.parse(await readFile(registryFile, "utf8"));
      reg.status = "running";
      reg.currentAssignmentId = assignmentId;
      await writeFile(registryFile, JSON.stringify(reg, null, 2) + "\n", "utf8");

      // Write accepted.json — signals reconciler to transition assignment to "running" (P0-3 fix)
      await writeFile(path.join(attemptDir, "accepted.json"), JSON.stringify({
        workerId,
        assignmentId,
        attempt: attemptNum,
        attemptToken: assignment.attemptToken,
        acceptedAt: new Date().toISOString(),
        pid: process.pid,
      }, null, 2) + "\n", "utf8");

      // Write heartbeat for this assignment
      await writeFile(path.join(attemptDir, "heartbeat.json"), JSON.stringify({
        workerId,
        assignmentId,
        attempt: attemptNum,
        phase: "starting",
        status: "running",
        pid: process.pid,
        updatedAt: new Date().toISOString(),
      }, null, 2) + "\n", "utf8");

      // Run job via Engine.runJob (P0-5: unified entry point)
      try {
        const result = await runJob({
          cpbRoot,
          hubRoot,
          project: assignment.projectId,
          task: assignment.task,
          jobId: `job-${assignment.entryId}`,
          workflow: assignment.workflow || "standard",
          planMode: assignment.planMode || "full",
          sourcePath: assignment.sourcePath,
          sourceContext: assignment.sourceContext,
          maxRetries: 3,
          timeoutMin: 60,
        });

        await writeFile(path.join(attemptDir, "result.json"), JSON.stringify({
          assignmentId,
          attempt: attemptNum,
          attemptToken: assignment.attemptToken,
          status: result.status,
          jobResult: result,
          writtenAt: new Date().toISOString(),
        }, null, 2) + "\n", "utf8");
      } catch (err) {
        await writeFile(path.join(attemptDir, "result.json"), JSON.stringify({
          assignmentId,
          attempt: attemptNum,
          attemptToken: assignment.attemptToken,
          status: "failed",
          jobResult: {
            status: "failed",
            failure: { kind: "worker_crashed", reason: err.message, retryable: true },
          },
          writtenAt: new Date().toISOString(),
        }, null, 2) + "\n", "utf8");
      }

      // Remove inbox entry
      await unlink(filePath).catch(() => {});

      // Update registry
      const regAfter = JSON.parse(await readFile(registryFile, "utf8"));
      regAfter.status = "ready";
      regAfter.currentAssignmentId = null;
      await writeFile(registryFile, JSON.stringify(regAfter, null, 2) + "\n", "utf8");

      if (once) {
        clearInterval(heartbeatTimer);
        process.exit(0);
      }
    }
  }

  // Watch inbox with chokidar
  const watcher = chokidar.watch(path.join(inboxDir, "*.json"), {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 100 },
  });

  watcher.on("add", async () => {
    try { await processInbox(); } catch (err) {
      process.stderr.write(`[worker-${workerId}] process error: ${err.message}\n`);
    }
  });

  // Fallback poll
  const pollTimer = setInterval(async () => {
    try { await processInbox(); } catch { /* ignore */ }
  }, POLL_MS);
  pollTimer.unref();

  // Graceful shutdown
  async function shutdown(signal) {
    clearInterval(heartbeatTimer);
    clearInterval(pollTimer);
    await watcher.close();

    const reg = JSON.parse(await readFile(registryFile, "utf8"));
    reg.status = "exited";
    reg.exitSignal = signal;
    await writeFile(registryFile, JSON.stringify(reg, null, 2) + "\n", "utf8");
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  process.stderr.write(`[managed-worker] fatal: ${err.message}\n`);
  process.exit(1);
});
