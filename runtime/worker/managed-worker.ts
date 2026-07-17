#!/usr/bin/env node
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
import os from "node:os";
import crypto from "node:crypto";
import type { LooseRecord } from "../../core/contracts/types.js";
import chokidar from "chokidar";
import { poolExhaustedJob, releaseManagedAcpWorktree, stopManagedAcpPool } from "../../bridges/runtime-services.js";
import { createLogger } from "../../shared/logger.js";
import { writeJsonAtomic, writeJsonOnce } from "../../shared/fs-utils.js";
import { AssignmentStore, type AttemptIdentity } from "../../shared/orchestrator/assignment-store.js";
import {
  INBOX_CLAIM_TTL_MS,
  WorkerStore,
  type WorkerUpdateExpectation,
} from "../../shared/orchestrator/worker-store.js";
import { WorkerBrokerClient } from "../../shared/orchestrator/worker-broker-client.js";
import { FailureKind } from "../../core/contracts/failure.js";
import { createIsolatedWorktreeWithRetry } from "./worktree-manager.js";
import { finalizeAndWriteSuccessfulResult } from "./assignment-finalizer.js";

const execFileAsync = promisify(_execFile);

const POLL_MS = 5_000;
const HEARTBEAT_MS = 10_000;
const CANCEL_POLL_MS = 1_000;
const WATCHER_CLOSE_TIMEOUT_MS = 2_000;
const PRODUCT_VALIDATION_KEEP_WORKTREE_ENV = "CPB_PRODUCT_VALIDATION_KEEP_WORKTREE";
const WORKER_EXIT_ON_IDLE_ENV = "CPB_WORKER_EXIT_ON_IDLE";
const WORKER_IDLE_EXIT_MS_ENV = "CPB_WORKER_IDLE_EXIT_MS";

export function executionLeaseRenewalLost({
  renewed,
  errored = false,
  elapsedSinceSuccessMs = 0,
  errorCode = null,
}: {
  renewed?: boolean;
  errored?: boolean;
  elapsedSinceSuccessMs?: number;
  errorCode?: string | null;
}) {
  if (renewed === false) return true;
  if ([
    "STALE_ATTEMPT",
    "STALE_INBOX_CLAIM",
    "HUB_WORKER_BROKER_AUTHENTICATION_REQUIRED",
    "HUB_WORKER_BROKER_OPERATION_DENIED",
  ].includes(String(errorCode || ""))) return true;
  return errored && elapsedSinceSuccessMs >= INBOX_CLAIM_TTL_MS - HEARTBEAT_MS;
}

export function shouldRetainWorkerWorktree(env: Record<string, string | undefined> = process.env): boolean {
  return env[PRODUCT_VALIDATION_KEEP_WORKTREE_ENV] === "1";
}

function shouldExitWorkerOnIdle(env: Record<string, string | undefined> = process.env): boolean {
  return env[WORKER_EXIT_ON_IDLE_ENV] === "1";
}

function workerIdleExitMs(env: Record<string, string | undefined> = process.env) {
  const parsed = Number.parseInt(env[WORKER_IDLE_EXIT_MS_ENV] || "600000", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 600000;
}

async function closeWatcherBounded(
  watcher: { close: () => Promise<unknown> },
  log: ReturnType<typeof createLogger>,
) {
  let timeout: NodeJS.Timeout | null = null;
  let timedOut = false;
  try {
    await Promise.race([
      watcher.close(),
      new Promise((resolve) => {
        timeout = setTimeout(() => {
          timedOut = true;
          resolve(null);
        }, WATCHER_CLOSE_TIMEOUT_MS);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (timedOut) log.warn(`watcher close timed out after ${WATCHER_CLOSE_TIMEOUT_MS}ms; continuing shutdown`);
}

type ManagedWorkerArgs = {
  workerId?: string;
  hubRoot?: string;
  cpbRoot?: string;
  once?: boolean;
};

type AssignmentPayload = LooseRecord & {
  assignmentId: string;
  entryId: string;
  attempt: number;
  attemptToken: string;
  projectId: string;
  sourcePath?: string;
  task?: string;
  workflow?: string;
  planMode?: string;
  sourceContext?: LooseRecord;
  metadata?: LooseRecord;
  orchestratorEpoch?: number;
};

type HeartbeatState = LooseRecord & {
  workerId: string;
  assignmentId: string;
  attempt: number;
  phase: string;
  activePhase: string | null;
  activeJobId: string | null;
  status: string;
  executionBoundary: string;
  sourcePath?: string;
  pid: number;
  progressKind: string;
  lastProgressType: string;
  progressUpdatedAt: string;
  updatedAt: string;
};

type CancelRequest = LooseRecord & {
  reason?: string;
  requestedAt?: string;
  requestedBy?: string;
};

type WorktreeInfo = LooseRecord & {
  path: string;
  branch?: string;
};

type JobResult = LooseRecord & {
  status?: string;
  failure?: LooseRecord;
};

type ManagedAssignmentStore = {
  assertActiveAttemptIdentity: (assignmentId: string, attempt: number, identity: AttemptIdentity) => Promise<unknown>;
  markRunning: (assignmentId: string, attempt: number, identity?: AttemptIdentity) => Promise<unknown>;
  recordHeartbeat: (assignmentId: string, attempt: number, heartbeat: LooseRecord) => Promise<unknown>;
  readCancel: (assignmentId: string, attempt: number) => Promise<LooseRecord | null>;
  completeAttemptAndAckInbox: (assignmentId: string, attempt: number, result: LooseRecord, options: { workerId: string; claimToken: string }) => Promise<{ accepted: boolean; inboxAcked: boolean }>;
};

type ManagedWorkerStore = {
  registerWorker: (workerId: string, meta: LooseRecord) => Promise<unknown>;
  updateWorkerIf: (workerId: string, updates: LooseRecord, expected: WorkerUpdateExpectation) => Promise<LooseRecord | null>;
  hasInboxWork: (workerId: string) => Promise<boolean>;
  claimInboxEntries: (workerId: string, incarnationToken?: string) => Promise<Array<{ assignmentId: string; assignment: LooseRecord; claimToken: string }>>;
  completeInboxClaim: (workerId: string, assignmentId: string, claimToken: string) => Promise<boolean>;
  renewInboxClaim: (workerId: string, assignmentId: string, claimToken: string, incarnationToken?: string) => Promise<boolean>;
};

async function completeAssignmentStateFromResult({
  assignmentStore,
  assignmentId,
  attemptNum,
  attemptDir,
  workerId,
  claimToken,
  log,
}: {
  assignmentStore: ManagedAssignmentStore;
  assignmentId: string;
  attemptNum: number;
  attemptDir: string;
  workerId: string;
  claimToken: string;
  log: ReturnType<typeof createLogger>;
}) {
  try {
    const resultPath = path.join(attemptDir, "result.json");
    const result = JSON.parse(await readFile(resultPath, "utf8")) as LooseRecord;
    const completion = await assignmentStore.completeAttemptAndAckInbox(
      assignmentId,
      attemptNum,
      result,
      { workerId, claimToken },
    );
    return { result, inboxAcked: completion.inboxAcked };
  } catch (err) {
    log.error(`failed to sync terminal assignment state: ${err instanceof Error ? err.message : String(err)}`);
    return { result: null, inboxAcked: false };
  }
}

export function shouldCleanupWorkerWorktree(
  attemptResult: LooseRecord | null | undefined,
  env: Record<string, string | undefined> = process.env,
) {
  return ["completed", "cancelled"].includes(String(attemptResult?.status || ""))
    && !shouldRetainWorkerWorktree(env);
}

type ProgressEvent = LooseRecord & {
  type?: string;
  phase?: string;
  jobId?: string;
  ts?: string;
};

function parseArgs(argv: string[]): ManagedWorkerArgs {
  const opts: ManagedWorkerArgs = {};
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
  const { assertHubWritable } = await import("../../shared/hub-maintenance.js");
  await assertHubWritable(hubRoot);
  const log = createLogger(`worker-${workerId}`);
  const inboxDir = path.join(hubRoot, "workers", "inbox", workerId);
  await mkdir(inboxDir, { recursive: true });
  const workerIncarnationToken = process.env.CPB_WORKER_INCARNATION_TOKEN || crypto.randomUUID();
  const brokerUrl = process.env.CPB_HUB_WORKER_BROKER_URL;
  const brokerToken = process.env.CPB_HUB_WORKER_BROKER_TOKEN;
  if (Boolean(brokerUrl) !== Boolean(brokerToken)) throw new Error("worker broker URL and token must be configured together");
  const brokerClient = brokerUrl && brokerToken
    ? new WorkerBrokerClient({ url: brokerUrl, token: brokerToken, workerId, incarnationToken: workerIncarnationToken })
    : null;
  let assignmentStore: ManagedAssignmentStore;
  let workerStore: ManagedWorkerStore;
  let sharedWorkerState: boolean;
  if (brokerClient) {
    assignmentStore = brokerClient;
    workerStore = brokerClient;
    sharedWorkerState = true;
  } else {
    const directAssignmentStore = new AssignmentStore(hubRoot);
    await directAssignmentStore.init();
    const directWorkerStore = new WorkerStore(hubRoot);
    await directWorkerStore.init();
    assignmentStore = directAssignmentStore;
    workerStore = directWorkerStore;
    sharedWorkerState = await directWorkerStore.usesSharedState();
  }

  // Both stores cache the trusted Redis backend during init. Never expose the
  // credential-bearing config path to repository-controlled test/phase child
  // processes spawned later by this worker.
  delete process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE;
  delete process.env.CPB_WORKER_INCARNATION_TOKEN;
  delete process.env.CPB_HUB_WORKER_BROKER_URL;
  delete process.env.CPB_HUB_WORKER_BROKER_TOKEN;

  // Register self
  await workerStore.registerWorker(workerId, {
    workerId,
    pid: process.pid,
    host: os.hostname(),
    status: "ready",
    startedAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
    incarnationToken: workerIncarnationToken,
  });

  // Start heartbeat
  const heartbeatTimer = setInterval(async () => {
    try {
      await workerStore.updateWorkerIf(workerId, { lastHeartbeatAt: new Date().toISOString() }, {
        incarnationToken: workerIncarnationToken,
      });
    } catch { /* ignore */ }
  }, HEARTBEAT_MS);
  heartbeatTimer.unref();

  // Bridge: service injection + sourcePath resolution (no direct core import)
  const { runJobWithServices } = await import("../../bridges/engine-bridge.js");

  async function stopWorkerAcpPool(jobLog: ReturnType<typeof createLogger> = log) {
    try {
      const stopped = await stopManagedAcpPool({ cpbRoot, hubRoot });
      if (stopped) jobLog.info("ACP pool stopped");
    } catch (err: unknown) {
      jobLog.warn(`ACP pool stop failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function releaseWorkerAcpWorktree(worktreePath: string | null | undefined, jobLog: ReturnType<typeof createLogger> = log) {
    if (!worktreePath) return true;
    try {
      const released = await releaseManagedAcpWorktree({
        cpbRoot,
        hubRoot,
        cwd: worktreePath,
        closeProvider: true,
      });
      if (released) jobLog.info("ACP worktree session released");
      return true;
    } catch (err: unknown) {
      jobLog.warn(`ACP worktree session release failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async function initWorktreeCodeGraph(worktreePath: string | null | undefined, jobLog: ReturnType<typeof createLogger> = log) {
    if (!worktreePath || process.env.CPB_CODEGRAPH_ENABLED === "0" || process.env.CPB_WORKTREE_CODEGRAPH_INIT === "0") {
      return null;
    }
    const timeout = Number.parseInt(process.env.CPB_WORKTREE_CODEGRAPH_INIT_TIMEOUT_MS || "600000", 10);
    const startedAt = Date.now();
    try {
      const { stdout, stderr } = await execFileAsync("codegraph", ["init", worktreePath], {
        cwd: worktreePath,
        timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 600000,
        maxBuffer: 10 * 1024 * 1024,
      });
      jobLog.info(`codegraph initialized for worktree in ${Date.now() - startedAt}ms`);
      return {
        ok: true,
        elapsedMs: Date.now() - startedAt,
        stdoutTail: String(stdout || "").slice(-2000),
        stderrTail: String(stderr || "").slice(-2000),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      jobLog.warn(`codegraph init failed for worktree: ${message}`);
      throw Object.assign(new Error(`CodeGraph init failed for worktree: ${message}`), {
        code: "codegraph_init_failed",
      });
    }
  }

  // Process inbox
  async function processInbox() {
    const claims = await workerStore.claimInboxEntries(workerId, workerIncarnationToken);

    for (const claim of claims) {
      const assignment = claim.assignment as AssignmentPayload;
      const inboxAssignmentId = claim.assignmentId;

      if ((assignment as LooseRecord).__malformedInbox) {
        log.warn(`malformed inbox file: ${inboxAssignmentId}.json`);
        await workerStore.completeInboxClaim(workerId, inboxAssignmentId, claim.claimToken);
        continue;
      }

      // Validate flattened payload (P0-2 fix)
      if (!Number.isInteger(assignment.attempt) || assignment.attempt < 1) {
        log.warn(`invalid attempt in assignment: ${JSON.stringify(assignment.attempt)}`);
        await workerStore.completeInboxClaim(workerId, inboxAssignmentId, claim.claimToken);
        continue;
      }
      if (!assignment.attemptToken) {
        log.warn(`missing attemptToken in assignment`);
        await workerStore.completeInboxClaim(workerId, inboxAssignmentId, claim.claimToken);
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
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(assignmentId)) {
        log.warn(`discarding invalid assignment id: ${JSON.stringify(assignmentId)}`);
        await workerStore.completeInboxClaim(workerId, inboxAssignmentId, claim.claimToken);
        continue;
      }
      await mkdir(attemptDir, { recursive: true, mode: 0o700 });

      try {
        await assignmentStore.assertActiveAttemptIdentity(assignmentId, attemptNum, {
          assignmentId,
          attempt: attemptNum,
          attemptToken: assignment.attemptToken,
          orchestratorEpoch: assignment.orchestratorEpoch,
        });
      } catch (err) {
        log.warn(`discarding stale assignment ${assignmentId} attempt ${attemptNum}: ${err instanceof Error ? err.message : String(err)}`);
        await workerStore.completeInboxClaim(workerId, inboxAssignmentId, claim.claimToken);
        continue;
      }

      // Update registry
      const runningUpdates = {
        status: "running",
        currentAssignmentId: assignmentId,
        currentAttemptToken: assignment.attemptToken,
      };
      const runningWorker = sharedWorkerState
        ? await workerStore.updateWorkerIf(workerId, runningUpdates, {
            incarnationToken: workerIncarnationToken,
            currentAssignmentId: assignmentId,
            currentAttemptToken: assignment.attemptToken,
            status: ["assigned", "running"],
          })
        : await workerStore.updateWorkerIf(workerId, runningUpdates, {
            incarnationToken: workerIncarnationToken,
            currentAssignmentId: null,
            status: "ready",
          });
      if (!runningWorker) {
        log.warn(`discarding assignment ${assignmentId}: worker reservation changed`);
        await workerStore.completeInboxClaim(workerId, inboxAssignmentId, claim.claimToken);
        continue;
      }

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
      await assignmentStore.markRunning(assignmentId, attemptNum, {
        assignmentId,
        attempt: attemptNum,
        attemptToken: assignment.attemptToken,
        orchestratorEpoch: assignment.orchestratorEpoch,
      });

      const heartbeatPath = path.join(attemptDir, "heartbeat.json");
      let heartbeatState: HeartbeatState = {
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

      async function writeAssignmentHeartbeat(patch: LooseRecord = {}, { progress = false }: { progress?: boolean } = {}) {
        const now = new Date().toISOString();
        heartbeatState = {
          ...heartbeatState,
          ...patch,
          updatedAt: now,
        };
        if (progress) {
          const progressUpdatedAt = typeof patch.progressUpdatedAt === "string" ? patch.progressUpdatedAt : null;
          const progressKind = typeof patch.progressKind === "string" ? patch.progressKind : null;
          const lastProgressType = typeof patch.lastProgressType === "string" ? patch.lastProgressType : null;
          heartbeatState.progressUpdatedAt = progressUpdatedAt || now;
          heartbeatState.progressKind = progressKind || lastProgressType || heartbeatState.progressKind;
          heartbeatState.lastProgressType = lastProgressType || progressKind || heartbeatState.lastProgressType;
        }
        await writeJsonAtomic(heartbeatPath, heartbeatState);
        await assignmentStore.recordHeartbeat(assignmentId, attemptNum, heartbeatState);
      }

      await writeAssignmentHeartbeat({}, { progress: true });

      // Start assignment heartbeat timer — refreshes heartbeat.json during execution
      // without refreshing progressUpdatedAt. Reconciler distinguishes healthy
      // long-running tasks from no-progress stalls using the progress timestamp.
      const metadata = assignment.metadata || {};
      const jobId = `job-${assignment.entryId}${attemptNum > 1 ? `-a${attemptNum}` : ""}`;
      const jobAbort = new AbortController();
      let executionLeaseLost: (Error & { code?: string }) | null = null;
      let resolveExecutionLeaseLoss!: (result: JobResult) => void;
      const executionLeaseLossPromise = new Promise<JobResult>((resolve) => {
        resolveExecutionLeaseLoss = resolve;
      });
      let lastInboxClaimRenewedAt = Date.now();
      let assignmentHeartbeat: NodeJS.Timeout;

      function loseExecutionLease(reason: string) {
        if (executionLeaseLost) return;
        executionLeaseLost = Object.assign(new Error(reason), { code: "WORKER_EXECUTION_LEASE_LOST" });
        clearInterval(assignmentHeartbeat);
        jobAbort.abort(executionLeaseLost);
        resolveExecutionLeaseLoss({
          status: "failed",
          jobId,
          failure: {
            kind: FailureKind.RUNTIME_INTERRUPTED,
            reason,
            retryable: true,
            cause: { code: "WORKER_EXECUTION_LEASE_LOST" },
          },
        });
        log.error(reason);
      }

      function assertExecutionLeaseHeld() {
        if (executionLeaseLost) throw executionLeaseLost;
      }

      assignmentHeartbeat = setInterval(async () => {
        try {
          await writeAssignmentHeartbeat({ status: "running" });
          const renewed = await workerStore.renewInboxClaim(
            workerId,
            inboxAssignmentId,
            claim.claimToken,
            workerIncarnationToken,
          );
          if (executionLeaseRenewalLost({ renewed })) {
            loseExecutionLease(`worker execution lease lost for ${assignmentId} attempt ${attemptNum}`);
            return;
          }
          lastInboxClaimRenewedAt = Date.now();
        } catch (error) {
          const elapsedSinceSuccessMs = Date.now() - lastInboxClaimRenewedAt;
          const errorCode = error && typeof error === "object" && "code" in error ? String(error.code) : null;
          if (executionLeaseRenewalLost({ errored: true, elapsedSinceSuccessMs, errorCode })) {
            loseExecutionLease(`worker execution lease renewal deadline expired for ${assignmentId} attempt ${attemptNum}`);
            return;
          }
          log.warn(`worker execution lease renewal temporarily unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      }, HEARTBEAT_MS);
      assignmentHeartbeat.unref();

      let cancelRequested: CancelRequest | null = null;
      let resolveCancel: ((value: JobResult) => void) | null = null;
      const cancelPromise = new Promise<JobResult>((resolve) => {
        resolveCancel = resolve;
      });
      // AbortSignal for in-flight job work (verify hard gates, agent commands).
      // Fires on cancellation or execution-lease loss; runCommandTree tears down
      // the detached process group so a hung command cannot outlive ownership.

      function interruptedPhase() {
        return heartbeatState.activePhase || (heartbeatState.phase !== "cancelled" ? heartbeatState.phase : null);
      }

      function buildCancelledResult(cancel: CancelRequest | null, phase: string | null = interruptedPhase()): JobResult {
        const reason = cancel?.reason || "assignment cancelled";
        return {
          status: "cancelled",
          jobId: heartbeatState.activeJobId || jobId,
          failure: {
            kind: FailureKind.RUNTIME_INTERRUPTED,
            phase,
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

      async function requestCancel(cancel: CancelRequest | null) {
        if (cancelRequested) return;
        cancelRequested = cancel || { reason: "assignment cancelled" };
        const phase = interruptedPhase();
        await writeAssignmentHeartbeat({
          status: "cancelling",
          phase: "cancelled",
          activePhase: null,
          progressKind: "cancel_requested",
          lastProgressType: "cancel_requested",
        }, { progress: true }).catch(() => {});
        resolveCancel?.(buildCancelledResult(cancelRequested, phase));
        try { jobAbort.abort(); } catch { /* already aborted */ }
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
      let worktreeInfo: WorktreeInfo | null = null;
      let terminalAttemptResult: LooseRecord | null = null;
      let inboxAcked = false;
      let acpWorktreeReleaseComplete = false;

      // Run job via bridge (service injection + sourcePath resolution)
      try {
        await pollCancel();
        if (worktreeRequired) {
          worktreeInfo = await createIsolatedWorktreeWithRetry({
            hubRoot,
            sourcePath: assignment.sourcePath,
            entryId: assignment.entryId,
            log: jobLog,
          } as LooseRecord) as WorktreeInfo;
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
          await writeAssignmentHeartbeat({
            phase: "codegraph",
            activePhase: null,
            progressKind: "codegraph_initializing",
            lastProgressType: "codegraph_initializing",
          }, { progress: true });
          const codegraphResult = await initWorktreeCodeGraph(worktreeInfo.path, jobLog);
          if (codegraphResult) {
            await writeAssignmentHeartbeat({
              phase: "codegraph",
              activePhase: null,
              progressKind: "codegraph_initialized",
              lastProgressType: "codegraph_initialized",
              codegraph: codegraphResult,
            }, { progress: true });
          }
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
        assertExecutionLeaseHeld();
        const jobPromise = runJobWithServices({
          cpbRoot,
          hubRoot,
          project: assignment.projectId,
          signal: jobAbort.signal,
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
          workerBrokerClient: brokerClient,
          onProgress: async (event: ProgressEvent = {}) => {
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
          if (cancelRequested || executionLeaseLost) {
            jobLog.warn(`cancelled job settled after cancellation: ${err.message}`);
          }
        });
        const result: JobResult = cancelRequested
          ? buildCancelledResult(cancelRequested)
          : await Promise.race([jobPromise, cancelPromise, executionLeaseLossPromise]);

        clearInterval(assignmentHeartbeat);
        clearInterval(cancelTimer);

        assertExecutionLeaseHeld();
        await assignmentStore.assertActiveAttemptIdentity(assignmentId, attemptNum, {
          assignmentId,
          attempt: attemptNum,
          attemptToken: assignment.attemptToken,
          orchestratorEpoch: assignment.orchestratorEpoch,
        });
        acpWorktreeReleaseComplete = await releaseWorkerAcpWorktree(worktreeInfo?.path, jobLog);
        if (!acpWorktreeReleaseComplete) {
          throw new Error("ACP worktree session release failed before result publication");
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
        const completion = await completeAssignmentStateFromResult({
          assignmentStore,
          assignmentId,
          attemptNum,
          attemptDir,
          workerId,
          claimToken: claim.claimToken,
          log: jobLog,
        });
        terminalAttemptResult = completion.result;
        inboxAcked = completion.inboxAcked;
      } catch (err: unknown) {
        clearInterval(assignmentHeartbeat);
        clearInterval(cancelTimer);
        const errObj = err instanceof Error ? err as Error & LooseRecord : { message: String(err) } as Error & LooseRecord;
        const isPoolExhausted = errObj.code === "POOL_EXHAUSTED" || errObj.name === "PoolExhaustedError";
        const isWorktreeUnavailable = errObj.code === "WORKTREE_UNAVAILABLE";
        const isExecutionLeaseLost = errObj.code === "WORKER_EXECUTION_LEASE_LOST";
        const failureKind = isPoolExhausted
          ? "pool_exhausted"
          : isWorktreeUnavailable
            ? "worktree_unavailable"
            : isExecutionLeaseLost
              ? FailureKind.RUNTIME_INTERRUPTED
              : FailureKind.WORKER_CRASHED;
        jobLog.error(`job failed (${failureKind}): ${errObj.message}`);
        if (isPoolExhausted) {
          try {
            await poolExhaustedJob(cpbRoot, assignment.projectId, jobId, {
              reason: errObj.message,
              providerKey: errObj.providerKey,
              agent: errObj.agent,
              elapsedMs: errObj.elapsedMs,
              ts: new Date().toISOString(),
            });
          } catch {}
        }
        if (!acpWorktreeReleaseComplete) {
          acpWorktreeReleaseComplete = await releaseWorkerAcpWorktree(worktreeInfo?.path, jobLog);
        }
        if (!acpWorktreeReleaseComplete) {
          throw new Error(`ACP worktree session release failed before failure publication: ${errObj.message}`);
        }
        await writeJsonOnce(path.join(attemptDir, "result.json"), {
          assignmentId,
          attempt: attemptNum,
          attemptToken: assignment.attemptToken,
          ...(assignment.orchestratorEpoch !== undefined ? { orchestratorEpoch: assignment.orchestratorEpoch } : {}),
          status: "failed",
          jobResult: {
            status: "failed",
            failure: { kind: failureKind, reason: errObj.message, retryable: true },
          },
          writtenAt: new Date().toISOString(),
        });
        const completion = await completeAssignmentStateFromResult({
          assignmentStore,
          assignmentId,
          attemptNum,
          attemptDir,
          workerId,
          claimToken: claim.claimToken,
          log: jobLog,
        });
        terminalAttemptResult = completion.result;
        inboxAcked = completion.inboxAcked;
      } finally {
        clearInterval(cancelTimer);
        if (!acpWorktreeReleaseComplete) {
          acpWorktreeReleaseComplete = await releaseWorkerAcpWorktree(worktreeInfo?.path, jobLog);
        }
        if (worktreeInfo && assignment.sourcePath) {
          if (shouldCleanupWorkerWorktree(terminalAttemptResult)) {
            try {
              await execFileAsync("git", ["worktree", "remove", "--force", worktreeInfo.path], {
                cwd: assignment.sourcePath,
                maxBuffer: 10 * 1024 * 1024,
              });
            } catch {}
            try { await rm(worktreeInfo.path, { recursive: true, force: true }); } catch {}
          } else {
            const status = terminalAttemptResult?.status || "uncommitted";
            jobLog.info(`retaining worker worktree for recovery (status=${status}): ${worktreeInfo.path}`);
          }
        }
      }

      // Remove inbox entry (now in processing dir)
      if (!inboxAcked) {
        await workerStore.completeInboxClaim(workerId, inboxAssignmentId, claim.claimToken);
      }

      // Update registry
      await workerStore.updateWorkerIf(workerId, {
        status: "ready",
        currentAssignmentId: null,
        currentAttemptToken: null,
      }, {
        incarnationToken: workerIncarnationToken,
        currentAssignmentId: assignmentId,
        currentAttemptToken: assignment.attemptToken,
        status: ["assigned", "running"],
      });

      if (once) {
        await shutdown("once");
        return;
      }
    }
    if (once && claims.length > 0) await shutdown("once");
  }

  let processing = false;
  let idleSince: number | null = null;
  let exitingIdle = false;

  async function inboxJsonCount() {
    return await workerStore.hasInboxWork(workerId) ? 1 : 0;
  }

  async function exitIdleWorkerIfRequested() {
    if (!shouldExitWorkerOnIdle() || processing || exitingIdle) return;
    const count = await inboxJsonCount();
    if (count > 0) {
      idleSince = null;
      return;
    }
    const now = Date.now();
    idleSince ??= now;
    if (now - idleSince < workerIdleExitMs()) return;
    exitingIdle = true;
    await shutdown("idle");
  }

  async function processInboxGuarded() {
    if (processing) return;
    processing = true;
    try {
      await processInbox();
    } finally {
      processing = false;
    }
    await exitIdleWorkerIfRequested();
  }

  // Watch inbox with chokidar
  const watcher = chokidar.watch(path.join(inboxDir, "*.json"), {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 100 },
  });

  watcher.on("add", async () => {
    try { await processInboxGuarded(); } catch (err: unknown) {
      log.error(`process error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // Do not wait for the watcher implementation or the 5s fallback poll to
  // discover work that already existed before startup.
  void processInboxGuarded().catch((err: unknown) => {
    log.error(`initial inbox process error: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Fallback poll
  const pollTimer = setInterval(async () => {
    try {
      await processInboxGuarded();
      await exitIdleWorkerIfRequested();
    } catch { /* ignore */ }
  }, POLL_MS);

  const idleCheckTimer = shouldExitWorkerOnIdle()
    ? setInterval(async () => {
        try { await exitIdleWorkerIfRequested(); } catch { /* ignore */ }
      }, Math.max(50, Math.min(POLL_MS, workerIdleExitMs() || 50)))
    : null;
  idleCheckTimer?.unref();
  void exitIdleWorkerIfRequested().catch(() => {});

  // Graceful shutdown
  async function shutdown(signal: string) {
    clearInterval(heartbeatTimer);
    clearInterval(pollTimer);
    if (idleCheckTimer) clearInterval(idleCheckTimer);
    await closeWatcherBounded(watcher, log);
    await stopWorkerAcpPool();

    await workerStore.updateWorkerIf(workerId, { status: "exited", exitSignal: signal }, {
      incarnationToken: workerIncarnationToken,
    });
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
