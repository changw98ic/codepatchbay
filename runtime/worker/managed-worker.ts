#!/usr/bin/env node
// @ts-nocheck
/**
 * Managed Worker — passive execution slot for Hub Orchestrator.
 *
 * Watches inbox directory for assignment files, executes via Engine.runJob(),
 * writes results back to assignment directory. Does NOT poll queue or claim entries.
 * Can run independently of Hub parent process (file-based communication).
 *
 * Modularized:
 *   - worktree-manager.js  : worktree creation, isolation, cleanup
 *   - assignment-finalizer.js : PR/review bundle finalization + result persistence
 */

import { readFile, mkdir, writeFile, readdir, unlink, rename, rm } from "node:fs/promises";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import path from "node:path";
import chokidar from "chokidar";
import { poolExhaustedJob, releaseManagedAcpWorktree, stopManagedAcpPool } from "../../bridges/runtime-services.js";
import { createLogger } from "../../shared/logger.js";
import { writeJsonAtomic, writeJsonOnce } from "../../shared/fs-utils.js";
import { AssignmentStore } from "../../shared/orchestrator/assignment-store.js";
import { FailureKind } from "../../core/contracts/failure.js";
import { createIsolatedWorktreeWithRetry } from "./worktree-manager.js";
import { finalizeAndWriteSuccessfulResult } from "./assignment-finalizer.js";

const execFileAsync = promisify(_execFile);

const POLL_MS = 5_000;
const HEARTBEAT_MS = 10_000;
const CANCEL_POLL_MS = 1_000;

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

export async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.workerId || !opts.hubRoot || !opts.cpbRoot) {
    process.stderr.write("Usage: managed-worker.js --worker-id <id> --hub-root <path> --cpb-root <path> [--once]\n");
    process.exit(1);
  }

  const { workerId, hubRoot, cpbRoot, once } = opts;
  const log = createLogger(`worker-${workerId}`);
  const inboxDir = path.join(hubRoot, "workers", "inbox", workerId);
  await mkdir(inboxDir, { recursive: true });
  const assignmentStore = new AssignmentStore(hubRoot);
  await assignmentStore.init();

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

  // Bridge: service injection + sourcePath resolution (no direct core import)
  const { runJobWithServices } = await import("../../bridges/engine-bridge.js");

  async function stopWorkerAcpPool(jobLog = log) {
    try {
      const stopped = await stopManagedAcpPool({ cpbRoot, hubRoot });
      if (stopped) jobLog.info("ACP pool stopped");
    } catch (err) {
      jobLog.warn(`ACP pool stop failed: ${err.message}`);
    }
  }

  async function releaseWorkerAcpWorktree(worktreePath, jobLog = log) {
    if (!worktreePath) return;
    try {
      const released = await releaseManagedAcpWorktree({ cpbRoot, hubRoot, cwd: worktreePath });
      if (released) jobLog.info("ACP worktree session released");
    } catch (err) {
      jobLog.warn(`ACP worktree session release failed: ${err.message}`);
    }
  }

  // Process inbox
  async function processInbox() {
    const files = await readdir(inboxDir).catch(() => []);
    const jsonFiles = files.filter(f => f.endsWith(".json"));

    for (const file of jsonFiles) {
      const filePath = path.join(inboxDir, file);

      // Atomic claim: rename to processing dir so concurrent calls skip it
      const processingDir = path.join(inboxDir, "processing");
      const claimedPath = path.join(processingDir, file);
      try {
        await mkdir(processingDir, { recursive: true });
        await rename(filePath, claimedPath);
      } catch {
        // Another invocation already claimed this file
        continue;
      }

      let assignment;
      try {
        assignment = JSON.parse(await readFile(claimedPath, "utf8"));
      } catch {
        log.warn(`malformed inbox file: ${file}`);
        await unlink(claimedPath).catch(() => {});
        continue;
      }

      // Validate flattened payload (P0-2 fix)
      if (!Number.isInteger(assignment.attempt) || assignment.attempt < 1) {
        log.warn(`invalid attempt in assignment: ${JSON.stringify(assignment.attempt)}`);
        await unlink(claimedPath).catch(() => {});
        continue;
      }
      if (!assignment.attemptToken) {
        log.warn(`missing attemptToken in assignment`);
        await unlink(claimedPath).catch(() => {});
        continue;
      }

      const assignmentId = assignment.assignmentId;
      const attemptNum = assignment.attempt;
      const jobLog = log.child({ traceId: assignment.entryId });
      const worktreeRequired = assignment.workflow !== "blocked";
      const executionBoundary = worktreeRequired ? "worktree" : "none";
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
        executionBoundary,
        sourcePath: assignment.sourcePath,
        acceptedAt: new Date().toISOString(),
        pid: process.pid,
      }, null, 2) + "\n", "utf8");

      const heartbeatPath = path.join(attemptDir, "heartbeat.json");
      let heartbeatState = {
        workerId,
        assignmentId,
        attempt: attemptNum,
        phase: "starting",
        activePhase: null,
        activeJobId: null,
        status: "running",
        executionBoundary,
        sourcePath: assignment.sourcePath,
        pid: process.pid,
        progressKind: "accepted",
        lastProgressType: "accepted",
        progressUpdatedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      async function writeAssignmentHeartbeat(patch = {}, { progress = false } = {}) {
        const now = new Date().toISOString();
        heartbeatState = {
          ...heartbeatState,
          ...patch,
          updatedAt: now,
        };
        if (progress) {
          heartbeatState.progressUpdatedAt = patch.progressUpdatedAt || now;
          heartbeatState.progressKind = patch.progressKind || patch.lastProgressType || heartbeatState.progressKind;
          heartbeatState.lastProgressType = patch.lastProgressType || patch.progressKind || heartbeatState.lastProgressType;
        }
        await writeJsonAtomic(heartbeatPath, heartbeatState);
      }

      await writeAssignmentHeartbeat({}, { progress: true });

      // Start assignment heartbeat timer — refreshes heartbeat.json during execution
      // without refreshing progressUpdatedAt. Reconciler distinguishes healthy
      // long-running tasks from no-progress stalls using the progress timestamp.
      const assignmentHeartbeat = setInterval(async () => {
        try {
          await writeAssignmentHeartbeat({ status: "running" });
        } catch { /* ignore */ }
      }, HEARTBEAT_MS);
      assignmentHeartbeat.unref();

      let cancelRequested = null;
      let resolveCancel = null;
      const cancelPromise = new Promise((resolve) => {
        resolveCancel = resolve;
      });

      function buildCancelledResult(cancel) {
        const reason = cancel?.reason || "assignment cancelled";
        return {
          status: "cancelled",
          failure: {
            kind: FailureKind.RUNTIME_INTERRUPTED,
            phase: heartbeatState.activePhase || heartbeatState.phase || null,
            reason: `assignment cancelled: ${reason}`,
            retryable: false,
            cause: {
              cancel: {
                reason,
                requestedAt: cancel?.requestedAt || null,
                requestedBy: cancel?.requestedBy || null,
              },
            },
          },
        };
      }

      async function requestCancel(cancel) {
        if (cancelRequested) return;
        cancelRequested = cancel || { reason: "assignment cancelled" };
        await writeAssignmentHeartbeat({
          status: "cancelling",
          phase: "cancelled",
          activePhase: null,
          progressKind: "cancel_requested",
          lastProgressType: "cancel_requested",
        }, { progress: true }).catch(() => {});
        resolveCancel(buildCancelledResult(cancelRequested));
        void stopWorkerAcpPool(jobLog);
      }

      async function pollCancel() {
        const cancel = await assignmentStore.readCancel(assignmentId, attemptNum);
        if (cancel) await requestCancel(cancel);
      }

      const cancelTimer = setInterval(async () => {
        try {
          await pollCancel();
        } catch { /* ignore */ }
      }, CANCEL_POLL_MS);
      cancelTimer.unref();

      // Create worktree for isolation. Managed pipeline execution must never
      // fall back to the source checkout.
      const metadata = assignment.metadata || {};
      const autoFinalize = Boolean(metadata.autoFinalize && assignment.sourcePath);
      const jobId = `job-${assignment.entryId}${attemptNum > 1 ? `-a${attemptNum}` : ""}`;
      let worktreeInfo = null;

      // Run job via bridge (service injection + sourcePath resolution)
      try {
        await pollCancel();
        if (worktreeRequired) {
          worktreeInfo = await createIsolatedWorktreeWithRetry({
            hubRoot,
            sourcePath: assignment.sourcePath,
            entryId: assignment.entryId,
            log: jobLog,
          });
          jobLog.info(`worktree created: ${worktreeInfo.branch} at ${worktreeInfo.path}`);
          await writeAssignmentHeartbeat({
            phase: "worktree",
            activePhase: null,
            worktreePath: worktreeInfo.path,
            worktreeBranch: worktreeInfo.branch,
            progressKind: "worktree_created",
            lastProgressType: "worktree_created",
          }, { progress: true });
          await writeFile(path.join(attemptDir, "worktree.json"), JSON.stringify({
            assignmentId,
            attempt: attemptNum,
            attemptToken: assignment.attemptToken,
            executionBoundary,
            sourcePath: assignment.sourcePath,
            worktreePath: worktreeInfo.path,
            worktreeBranch: worktreeInfo.branch,
            createdAt: new Date().toISOString(),
          }, null, 2) + "\n", "utf8");
        } else {
          jobLog.info("blocked workflow: skipping worktree creation");
          await writeAssignmentHeartbeat({
            phase: "workflow",
            activePhase: null,
            progressKind: "worktree_skipped",
            lastProgressType: "worktree_skipped",
          }, { progress: true });
        }

        await pollCancel();
        const jobPromise = runJobWithServices({
          cpbRoot,
          hubRoot,
          project: assignment.projectId,
          task: assignment.task,
          jobId,
          workflow: assignment.workflow || "standard",
          planMode: assignment.planMode || "full",
          sourcePath: worktreeInfo?.path || assignment.sourcePath,
          sourceContext: assignment.sourceContext,
          maxRetries: 3,
          agent: metadata.agent || null,
          agents: metadata.agents || null,
          routing: metadata.routing || null,
          agentAvailability: metadata.agentAvailability || null,
          agentHealth: metadata.agentHealth || null,
          teamPolicy: metadata.teamPolicy || null,
          onProgress: async (event = {}) => {
            const eventType = event.type || "progress";
            const activePhase = eventType === "phase_result" || eventType === "job_completed" || eventType === "job_failed"
              ? null
              : (event.phase || heartbeatState.activePhase || null);
            await writeAssignmentHeartbeat({
              phase: event.phase || activePhase || "running",
              activePhase,
              activeJobId: event.jobId || jobId,
              progressKind: eventType,
              lastProgressType: eventType,
              progressUpdatedAt: event.ts || new Date().toISOString(),
            }, { progress: true });
          },
        });
        jobPromise.catch((err) => {
          if (cancelRequested) {
            jobLog.warn(`cancelled job settled after cancellation: ${err.message}`);
          }
        });
        const result = cancelRequested
          ? buildCancelledResult(cancelRequested)
          : await Promise.race([jobPromise, cancelPromise]);

        clearInterval(assignmentHeartbeat);
        clearInterval(cancelTimer);

        // Finalize: create PR/review bundle if autoFinalize and job succeeded
        if (autoFinalize && result.status === "completed" && worktreeInfo) {
          // Commit any uncommitted changes in the worktree before finalizing
          try {
            const { stdout: wtStatus } = await execFileAsync("git", ["status", "--porcelain"], { cwd: worktreeInfo.path });
            if (wtStatus.trim()) {
              await execFileAsync("git", ["add", "-A"], { cwd: worktreeInfo.path });
              await execFileAsync("git", ["commit", "-m", assignment.task || "automated change"], { cwd: worktreeInfo.path });
            }
          } catch (commitErr) {
            jobLog.warn(`worktree commit failed: ${commitErr.message}`);
          }
        }

        await finalizeAndWriteSuccessfulResult({
          cpbRoot,
          hubRoot,
          assignment,
          attemptDir,
          assignmentId,
          attemptNum,
          jobId,
          result,
          worktreeInfo,
          log: jobLog,
        });
      } catch (err) {
        clearInterval(assignmentHeartbeat);
        clearInterval(cancelTimer);
        const isPoolExhausted = err.code === "POOL_EXHAUSTED" || err.name === "PoolExhaustedError";
        const isWorktreeUnavailable = err.code === "WORKTREE_UNAVAILABLE";
        const failureKind = isPoolExhausted ? "pool_exhausted" : (isWorktreeUnavailable ? "worktree_unavailable" : "worker_crashed");
        jobLog.error(`job failed (${failureKind}): ${err.message}`);
        if (isPoolExhausted) {
          try {
            await poolExhaustedJob(cpbRoot, assignment.projectId, jobId, {
              reason: err.message,
              providerKey: err.providerKey,
              agent: err.agent,
              elapsedMs: err.elapsedMs,
              ts: new Date().toISOString(),
            });
          } catch {}
        }
        await writeJsonOnce(path.join(attemptDir, "result.json"), {
          assignmentId,
          attempt: attemptNum,
          attemptToken: assignment.attemptToken,
          status: "failed",
          jobResult: {
            status: "failed",
            failure: { kind: failureKind, reason: err.message, retryable: true },
          },
          writtenAt: new Date().toISOString(),
        });
      } finally {
        clearInterval(cancelTimer);
        await releaseWorkerAcpWorktree(worktreeInfo?.path, jobLog);
        // Cleanup worktree regardless of outcome
        if (worktreeInfo && assignment.sourcePath) {
          try {
            await execFileAsync("git", ["worktree", "remove", "--force", worktreeInfo.path], {
              cwd: assignment.sourcePath,
              maxBuffer: 10 * 1024 * 1024,
            });
          } catch {}
          try { await rm(worktreeInfo.path, { recursive: true, force: true }); } catch {}
        }
      }

      // Remove inbox entry (now in processing dir)
      await unlink(claimedPath).catch(() => {});

      // Update registry
      const regAfter = JSON.parse(await readFile(registryFile, "utf8"));
      regAfter.status = "ready";
      regAfter.currentAssignmentId = null;
      await writeFile(registryFile, JSON.stringify(regAfter, null, 2) + "\n", "utf8");

      if (once) {
        clearInterval(heartbeatTimer);
        clearInterval(assignmentHeartbeat);
        process.exit(0);
      }
    }
  }

  let processing = false;
  async function processInboxGuarded() {
    if (processing) return;
    processing = true;
    try {
      await processInbox();
    } finally {
      processing = false;
    }
  }

  // Watch inbox with chokidar
  const watcher = chokidar.watch(path.join(inboxDir, "*.json"), {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 100 },
  });

  watcher.on("add", async () => {
    try { await processInboxGuarded(); } catch (err) {
      log.error(`process error: ${err.message}`);
    }
  });

  // Fallback poll
  const pollTimer = setInterval(async () => {
    try { await processInboxGuarded(); } catch { /* ignore */ }
  }, POLL_MS);
  pollTimer.unref();

  // Graceful shutdown
  async function shutdown(signal) {
    clearInterval(heartbeatTimer);
    clearInterval(pollTimer);
    await watcher.close();
    await stopWorkerAcpPool();

    const reg = JSON.parse(await readFile(registryFile, "utf8"));
    reg.status = "exited";
    reg.exitSignal = signal;
    await writeFile(registryFile, JSON.stringify(reg, null, 2) + "\n", "utf8");
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`[managed-worker] fatal: ${err.message}\n`);
    process.exit(1);
  });
}
