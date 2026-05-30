#!/usr/bin/env node
/**
 * Managed Worker — passive execution slot for Hub Orchestrator.
 *
 * Watches inbox directory for assignment files, executes via Engine.runJob(),
 * writes results back to assignment directory. Does NOT poll queue or claim entries.
 * Can run independently of Hub parent process (file-based communication).
 */

import { readFile, mkdir, writeFile, readdir, unlink, rename, rm } from "node:fs/promises";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import chokidar from "chokidar";
import { writeJsonAtomic, writeJsonOnce } from "../../server/services/fs-utils.js";
import { createWorktree } from "../git/worktree.js";
import { finalizeSuccessfulQueueEntry } from "../../server/services/auto-finalizer.js";
import { resolveGithubTransport } from "../../server/services/github-api.js";

const execFileAsync = promisify(_execFile);

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

  // Bridge: service injection + sourcePath resolution (no direct core import)
  const { runJobWithServices } = await import("../../bridges/engine-bridge.js");

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
        process.stderr.write(`[worker-${workerId}] malformed inbox file: ${file}\n`);
        await unlink(claimedPath).catch(() => {});
        continue;
      }

      // Validate flattened payload (P0-2 fix)
      if (!Number.isInteger(assignment.attempt) || assignment.attempt < 1) {
        process.stderr.write(`[worker-${workerId}] invalid attempt in assignment: ${JSON.stringify(assignment.attempt)}\n`);
        await unlink(claimedPath).catch(() => {});
        continue;
      }
      if (!assignment.attemptToken) {
        process.stderr.write(`[worker-${workerId}] missing attemptToken in assignment\n`);
        await unlink(claimedPath).catch(() => {});
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

      // Write initial heartbeat for this assignment
      await writeFile(path.join(attemptDir, "heartbeat.json"), JSON.stringify({
        workerId,
        assignmentId,
        attempt: attemptNum,
        phase: "starting",
        status: "running",
        pid: process.pid,
        updatedAt: new Date().toISOString(),
      }, null, 2) + "\n", "utf8");

      // Start assignment heartbeat timer — refreshes heartbeat.json during execution
      // so the Reconciler does not mark long-running tasks as heartbeat-lost
      const assignmentHeartbeat = setInterval(async () => {
        try {
          await writeFile(path.join(attemptDir, "heartbeat.json"), JSON.stringify({
            workerId,
            assignmentId,
            attempt: attemptNum,
            phase: "running",
            status: "running",
            pid: process.pid,
            updatedAt: new Date().toISOString(),
          }, null, 2) + "\n", "utf8");
        } catch { /* ignore */ }
      }, HEARTBEAT_MS);

      // Create worktree for isolation when autoFinalize is requested
      const metadata = assignment.metadata || {};
      const autoFinalize = Boolean(metadata.autoFinalize && assignment.sourcePath);
      let worktreeInfo = null;
      let effectiveSourcePath = assignment.sourcePath;
      const jobId = `job-${assignment.entryId}${attemptNum > 1 ? `-a${attemptNum}` : ""}`;
      // Use stable worktree ID (without attempt suffix) so retries reuse the same worktree
      const worktreeJobId = `job-${assignment.entryId}`;

      if (autoFinalize) {
        try {
          const worktreesRoot = path.join(hubRoot, "worktrees");
          worktreeInfo = await createWorktree({
            project: assignment.sourcePath,
            jobId: worktreeJobId,
            slug: "pipeline",
            worktreesRoot,
          });
          effectiveSourcePath = worktreeInfo.path;
          process.stderr.write(`[worker-${workerId}] worktree created: ${worktreeInfo.branch} at ${worktreeInfo.path}\n`);
        } catch (err) {
          process.stderr.write(`[worker-${workerId}] worktree creation failed: ${err.message}, using source path directly\n`);
        }
      }

      // Run job via bridge (service injection + sourcePath resolution)
      try {
        const result = await runJobWithServices({
          cpbRoot,
          hubRoot,
          project: assignment.projectId,
          task: assignment.task,
          jobId,
          workflow: assignment.workflow || "standard",
          planMode: assignment.planMode || "full",
          sourcePath: effectiveSourcePath,
          sourceContext: assignment.sourceContext,
          maxRetries: 3,
          timeoutMin: 60,
          agent: metadata.agent || null,
          agents: metadata.agents || null,
        });

        clearInterval(assignmentHeartbeat);

        // Finalize: create PR + close issue if autoFinalize and job succeeded
        let finalizeResult = null;
        if (autoFinalize && result.status === "completed" && worktreeInfo) {
          // Commit any uncommitted changes in the worktree before finalizing
          try {
            const { stdout: wtStatus } = await execFileAsync("git", ["status", "--porcelain"], { cwd: worktreeInfo.path });
            if (wtStatus.trim()) {
              await execFileAsync("git", ["add", "-A"], { cwd: worktreeInfo.path });
              await execFileAsync("git", ["commit", "-m", assignment.task || "automated change"], { cwd: worktreeInfo.path });
            }
          } catch (commitErr) {
            process.stderr.write(`[worker-${workerId}] worktree commit failed: ${commitErr.message}\n`);
          }
          try {
            const transport = await resolveGithubTransport(hubRoot);
            const entry = {
              id: assignment.entryId,
              projectId: assignment.projectId,
              description: assignment.task,
              metadata,
            };
            const job = {
              status: "completed",
              worktree: worktreeInfo.path,
              jobId,
              project: assignment.projectId,
              sourceContext: assignment.sourceContext || {},
              worktreeBranch: worktreeInfo.branch,
              task: assignment.task,
              planMode: assignment.planMode,
            };

            const finalizeResult = await finalizeSuccessfulQueueEntry({
              cpbRoot,
              hubRoot,
              project: assignment.projectId,
              entry,
              job,
              sourcePath: assignment.sourcePath,
              mode: "pr",
              issueCloser: transport?.closeIssue || null,
              createPullRequest: transport?.createPullRequest || null,
              pushToken: transport?.getToken ? await transport.getToken().catch(() => null) : null,
              transportMode: transport?.mode || null,
            });

            if (finalizeResult.ok) {
              process.stderr.write(`[worker-${workerId}] finalize: ${finalizeResult.status} pr=${finalizeResult.prUrl || "n/a"}\n`);
            } else {
              process.stderr.write(`[worker-${workerId}] finalize: ${finalizeResult.status} code=${finalizeResult.code || "unknown"}\n`);
            }
          } catch (err) {
            process.stderr.write(`[worker-${workerId}] finalize failed: ${err.message}\n`);
          }
        }

        await writeJsonOnce(path.join(attemptDir, "result.json"), {
          assignmentId,
          attempt: attemptNum,
          attemptToken: assignment.attemptToken,
          status: result.status,
          jobResult: result,
          finalizeResult: finalizeResult || null,
          writtenAt: new Date().toISOString(),
        });
      } catch (err) {
        clearInterval(assignmentHeartbeat);
        await writeJsonOnce(path.join(attemptDir, "result.json"), {
          assignmentId,
          attempt: attemptNum,
          attemptToken: assignment.attemptToken,
          status: "failed",
          jobResult: {
            status: "failed",
            failure: { kind: "worker_crashed", reason: err.message, retryable: true },
          },
          writtenAt: new Date().toISOString(),
        });
      } finally {
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
      process.stderr.write(`[worker-${workerId}] process error: ${err.message}\n`);
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
