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

import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, mkdir, writeFile, readdir, realpath, rename, stat, lstat } from "node:fs/promises";
import { execFile as _execFile, spawn as _spawn, type ChildProcess } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  sameWorktreeDirectoryIdentity,
  type WorktreeDirectoryIdentity,
} from "../../core/contracts/worktree-ownership.js";
import type { LooseRecord } from "../../core/contracts/types.js";
import chokidar from "chokidar";
import {
  finalizerMutationFenceDigest,
  poolExhaustedJob,
  redactSecrets,
  releaseManagedAcpJob,
  releaseManagedAcpWorktree,
  stopManagedAcpPool,
} from "../../bridges/runtime-services.js";
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
import {
  captureProcessIdentity,
  isProcessIdentityAlive,
  killTree,
  sameProcessIdentity,
  type ProcessIdentity,
} from "../../core/runtime/process-tree.js";
import {
  readBoundedRegularFileNoFollow,
  type BoundedRegularFileReadHooks,
} from "../../core/runtime/durable-directory-lock.js";
import { fsyncDirectory } from "../../shared/hub-maintenance.js";
import {
  validatedFinalizerCandidate,
  verifyFinalizerCandidateCommit,
  type ValidatedFinalizerCandidate,
} from "../../shared/orchestrator/finalizer-candidate.js";
import {
  cleanupManagedWorkerWorktree,
  createIsolatedWorktreeWithRetry,
  managedWorktreeContext,
  parseManagedWorktreeDispositionProof,
  parseVerifiedManagedWorktreeContext,
  verifyRetainedManagedWorkerWorktree,
  type ManagedWorktreeCleanupProof,
  type VerifiedManagedWorktreeContext,
} from "./worktree-manager.js";
import {
  finalizeAndWriteSuccessfulResult,
  recoverAndWriteFinalizerOnlyResult,
  type AssertFinalizerMutationLease,
  type FinalizerMutationFence,
} from "./assignment-finalizer.js";

const execFileAsync = promisify(_execFile);

const POLL_MS = 5_000;
const HEARTBEAT_MS = 10_000;
const CANCEL_POLL_MS = 1_000;
const WATCHER_CLOSE_TIMEOUT_MS = 2_000;
const PRODUCT_VALIDATION_KEEP_WORKTREE_ENV = "CPB_PRODUCT_VALIDATION_KEEP_WORKTREE";
const WORKER_EXIT_ON_IDLE_ENV = "CPB_WORKER_EXIT_ON_IDLE";
const WORKER_IDLE_EXIT_MS_ENV = "CPB_WORKER_IDLE_EXIT_MS";
const CODEGRAPH_STOP_TIMEOUT_MS = 2_000;
const CODEGRAPH_STATE_MAX_BYTES = 64 * 1024;
const TERMINAL_RESULT_MAX_BYTES = 16 * 1024 * 1024;
const CODEGRAPH_CLEANUP_PROOF_GENERATOR = "runtime/worker/managed-worker.ts#stopAssignmentCodeGraphRuntime";
const FINALIZER_RECOVERY_SCHEMA = "cpb.finalizer-recovery.v1";
const FINALIZER_HANDOFF_SCHEMA = "cpb.finalizer-handoff.v1";
const FINALIZER_HANDOFF_EVIDENCE_SCHEMA = "cpb.finalizer-handoff-evidence.v1";

type WorktreeCodeGraphLog = Pick<ReturnType<typeof createLogger>, "info" | "warn">;

export type WorktreeCodeGraphRuntime = {
  pid: number;
  processPid: number;
  statePath: string;
  evidence: LooseRecord;
  stop: () => Promise<WorktreeCodeGraphCleanupProof>;
};

export type WorktreeCodeGraphStartupProof = {
  ok: true;
  source: string;
  pid: number;
  processPid: number;
  statePath: string;
  startedAt: string;
  readyAt: string;
};

export type WorktreeCodeGraphCleanupProof = {
  ok: true;
  cleanupVerified: true;
  processTreeStopped: true;
  stateRemoved: true;
  statePath: string;
  worktreePath: string;
  startup: WorktreeCodeGraphStartupProof;
  startupSource: string;
  pid: number;
  processPid: number;
  cleanupStartedAt: string;
  cleanupCompletedAt: string;
};

type AssignmentCodeGraphCleanupProof = WorktreeCodeGraphCleanupProof & {
  generator: typeof CODEGRAPH_CLEANUP_PROOF_GENERATOR;
  assignmentId: string;
  attempt: number;
  attemptToken: string;
  orchestratorEpoch?: number;
  entryId: string;
  projectId: string;
  jobId: string;
  workerId: string;
  context: "before_terminal_publication" | "assignment_cleanup";
  cleanupAttempt: number;
};

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

function recordValue(value: unknown): LooseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as LooseRecord
    : {};
}

function redactedWorkerRecord(value: unknown): LooseRecord {
  const redacted = redactSecrets(value);
  return recordValue(redacted);
}

export function redactedWorkerErrorMessage(error: unknown, fallback = "worker operation failed"): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : String(recordValue(error).message || fallback);
  const redacted = redactSecrets(raw);
  return typeof redacted === "string" && redacted.trim() ? redacted : fallback;
}

export function finalizerFailureEvidenceFromError(error: unknown): LooseRecord | null {
  const record = recordValue(error);
  const nested = recordValue(record.finalizeResult);
  const candidate = Object.keys(nested).length > 0
    ? nested
    : (record.code === "ASSIGNMENT_CANCELLED" || record.code === "MUTATION_LEASE_LOST")
      ? record
      : {};
  if (Object.keys(candidate).length === 0) return null;
  const evidence = redactedWorkerRecord(candidate);
  const mode = typeof evidence.mode === "string" ? evidence.mode : null;
  const jobId = typeof evidence.jobId === "string" ? evidence.jobId : null;
  const committed = typeof evidence.committed === "boolean" || evidence.committed === null
    ? evidence.committed
    : null;
  return {
    ...evidence,
    mode,
    jobId,
    committed,
  };
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

async function waitForChildExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

type CodeGraphDaemonState = {
  pid: number;
  codebaseRoot: string;
  socketPath: string | null;
  source: string;
  processIdentity: ProcessIdentity;
};

type CodeGraphStateGeneration = {
  dev: number | bigint;
  ino: number | bigint;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
};

type CodeGraphDaemonStateSnapshot = {
  state: CodeGraphDaemonState;
  generation: CodeGraphStateGeneration;
};

export type CodeGraphStateTestHooks = {
  boundedRead?: BoundedRegularFileReadHooks;
  afterStaleStateObserved?: (context: { statePath: string }) => void | Promise<void>;
  afterStateQuarantineRename?: (context: {
    statePath: string;
    quarantinePath: string;
  }) => void | Promise<void>;
  syncDirectory?: (context: {
    directory: string;
    phase: "quarantine-rename" | "quarantine-remove";
  }) => void | Promise<void>;
};

const codeGraphStateTestHookStorage = new AsyncLocalStorage<CodeGraphStateTestHooks>();

export function withCodeGraphStateTestHooksForTests<T>(hooks: CodeGraphStateTestHooks, operation: () => T): T {
  const parent = codeGraphStateTestHookStorage.getStore();
  return codeGraphStateTestHookStorage.run(parent ? { ...parent, ...hooks } : hooks, operation);
}

function codeGraphStateTestHooks() {
  return codeGraphStateTestHookStorage.getStore() || {};
}

function codeGraphStateError(message: string, code = "codegraph_state_invalid", cause?: unknown) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

async function waitForProcessIdentityExit(identity: ProcessIdentity, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessIdentityAlive(identity) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isProcessIdentityAlive(identity);
}

async function verifyPathRemoved(targetPath: string) {
  try {
    await stat(targetPath);
    return false;
  } catch (error: unknown) {
    if ((error as { code?: unknown })?.code === "ENOENT") return true;
    throw Object.assign(new Error(`CodeGraph state removal check failed for ${targetPath}: ${error instanceof Error ? error.message : String(error)}`), {
      code: "codegraph_cleanup_failed",
    });
  }
}

function parseStoredProcessIdentity(value: unknown, expectedPid: number): ProcessIdentity | null {
  const record = recordValue(value);
  const pid = Number(record.pid);
  const birthId = typeof record.birthId === "string" ? record.birthId : "";
  const incarnation = typeof record.incarnation === "string" ? record.incarnation : "";
  const capturedAt = typeof record.capturedAt === "string" ? record.capturedAt : "";
  const birthIdPrecision = typeof record.birthIdPrecision === "string" ? record.birthIdPrecision : undefined;
  const processGroupId = Number(record.processGroupId);
  if (
    !Number.isSafeInteger(pid)
    || pid <= 0
    || pid !== expectedPid
    || !birthId
    || !capturedAt
    || !Number.isFinite(Date.parse(capturedAt))
    || new Date(Date.parse(capturedAt)).toISOString() !== capturedAt
    || incarnation !== `${pid}:${birthId}`
    || birthIdPrecision !== "exact"
    || (record.processGroupId !== undefined && (!Number.isSafeInteger(processGroupId) || processGroupId <= 0))
  ) return null;
  const identity: ProcessIdentity = {
    pid,
    birthId,
    incarnation,
    capturedAt,
    birthIdPrecision: "exact",
  };
  if (Number.isSafeInteger(processGroupId) && processGroupId > 0) identity.processGroupId = processGroupId;
  return identity;
}

function codeGraphStateGeneration(info: CodeGraphStateGeneration): CodeGraphStateGeneration {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    birthtimeMs: info.birthtimeMs,
  };
}

function sameCodeGraphStateGeneration(left: CodeGraphStateGeneration, right: CodeGraphStateGeneration) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs;
}

function sameCodeGraphStateAcrossRename(left: CodeGraphStateGeneration, right: CodeGraphStateGeneration) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.birthtimeMs === right.birthtimeMs;
}

function sameCodeGraphDaemonState(left: CodeGraphDaemonState, right: CodeGraphDaemonState) {
  return left.pid === right.pid
    && left.codebaseRoot === right.codebaseRoot
    && left.socketPath === right.socketPath
    && left.source === right.source
    && sameProcessIdentity(left.processIdentity, right.processIdentity);
}

async function readPinnedCodeGraphState(filePath: string) {
  const before = await lstat(filePath);
  const content = await readBoundedRegularFileNoFollow(filePath, {
    maxBytes: CODEGRAPH_STATE_MAX_BYTES,
    hooks: codeGraphStateTestHooks().boundedRead,
  });
  const after = await lstat(filePath);
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || !after.isFile()
    || after.isSymbolicLink()
    || !sameCodeGraphStateGeneration(before, after)
  ) {
    throw codeGraphStateError(`CodeGraph state generation changed while reading: ${filePath}`);
  }
  return { content, generation: codeGraphStateGeneration(after) };
}

async function syncCodeGraphStateDirectory(
  directory: string,
  phase: "quarantine-rename" | "quarantine-remove",
) {
  await codeGraphStateTestHooks().syncDirectory?.({ directory, phase });
  await fsyncDirectory(directory);
}

function codeGraphStateRecoveryError(
  message: string,
  cause: unknown,
  metadata: Record<string, unknown>,
) {
  return Object.assign(new Error(message, { cause }), { code: "codegraph_runtime_failed", ...metadata });
}

async function removeStaleCodeGraphState(
  statePath: string,
  canonicalWorktreePath: string,
  expectedState?: CodeGraphDaemonState,
) {
  let observed: CodeGraphDaemonStateSnapshot | null;
  try {
    observed = await readCodeGraphDaemonStateSnapshot(statePath, canonicalWorktreePath);
  } catch (error: unknown) {
    if ((error as { code?: unknown })?.code === "ENOENT") return;
    throw Object.assign(new Error(`stale CodeGraph state cleanup failed for ${statePath}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    }), {
      code: "codegraph_runtime_failed",
    });
  }
  if (!observed) return;
  if (expectedState && !sameCodeGraphDaemonState(expectedState, observed.state)) {
    throw codeGraphStateRecoveryError(
      `CodeGraph state successor preserved instead of removing owned state: ${statePath}`,
      codeGraphStateError(`CodeGraph state no longer matches the owned runtime: ${statePath}`),
      {
        committed: false,
        successorPreserved: true,
        recoveryPaths: { canonical: statePath },
      },
    );
  }
  if (isProcessIdentityAlive(observed.state.processIdentity)) {
    throw Object.assign(new Error(`CodeGraph state belongs to a live process incarnation: ${observed.state.processIdentity.incarnation}`), {
      code: "codegraph_runtime_failed",
    });
  }
  await codeGraphStateTestHooks().afterStaleStateObserved?.({ statePath });

  let current: CodeGraphDaemonStateSnapshot | null;
  try {
    current = await readCodeGraphDaemonStateSnapshot(statePath, canonicalWorktreePath);
  } catch (error: unknown) {
    throw codeGraphStateRecoveryError(
      `stale CodeGraph state changed before quarantine: ${statePath}`,
      error,
      {
        committed: false,
        successorPreserved: true,
        recoveryPaths: { canonical: statePath },
      },
    );
  }
  if (!current) return;
  if (
    !sameCodeGraphStateGeneration(observed.generation, current.generation)
    || !sameCodeGraphDaemonState(observed.state, current.state)
  ) {
    throw codeGraphStateRecoveryError(
      `stale CodeGraph state successor preserved before quarantine: ${statePath}`,
      codeGraphStateError(`CodeGraph state generation changed before quarantine: ${statePath}`),
      {
        committed: false,
        successorPreserved: true,
        recoveryPaths: { canonical: statePath },
      },
    );
  }

  const quarantinePath = `${statePath}.stale-${process.pid}-${crypto.randomUUID()}`;
  const directory = path.dirname(statePath);
  try {
    await rename(statePath, quarantinePath);
  } catch (error: unknown) {
    if ((error as { code?: unknown })?.code === "ENOENT") return;
    throw codeGraphStateRecoveryError(
      `stale CodeGraph state quarantine failed: ${statePath}`,
      error,
      {
        committed: false,
        recoveryPaths: { canonical: statePath },
      },
    );
  }

  try {
    await syncCodeGraphStateDirectory(directory, "quarantine-rename");
  } catch (error) {
    throw codeGraphStateRecoveryError(
      `stale CodeGraph state quarantine committed with ambiguous durability: ${statePath}`,
      error,
      {
        committed: true,
        renameCommitted: true,
        removalCommitted: false,
        committedPath: quarantinePath,
        quarantinePreserved: true,
        recoveryPaths: { canonical: statePath, quarantine: quarantinePath },
      },
    );
  }

  let renamedGeneration: CodeGraphStateGeneration;
  try {
    const renamed = await lstat(quarantinePath);
    if (!renamed.isFile() || renamed.isSymbolicLink() || !sameCodeGraphStateAcrossRename(current.generation, renamed)) {
      throw codeGraphStateError(`CodeGraph state generation changed during quarantine rename: ${quarantinePath}`);
    }
    renamedGeneration = codeGraphStateGeneration(renamed);
    await codeGraphStateTestHooks().afterStateQuarantineRename?.({ statePath, quarantinePath });
    const moved = await readCodeGraphDaemonStateSnapshot(quarantinePath, canonicalWorktreePath);
    if (
      !moved
      || !sameCodeGraphStateGeneration(renamedGeneration, moved.generation)
      || !sameCodeGraphDaemonState(current.state, moved.state)
    ) {
      throw codeGraphStateError(`CodeGraph state changed after quarantine rename: ${quarantinePath}`);
    }
  } catch (error) {
    throw codeGraphStateRecoveryError(
      `stale CodeGraph state quarantine preserved after verification failure: ${quarantinePath}`,
      error,
      {
        committed: true,
        renameCommitted: true,
        removalCommitted: false,
        committedPath: quarantinePath,
        quarantinePreserved: true,
        recoveryPaths: { canonical: statePath, quarantine: quarantinePath },
      },
    );
  }

  try {
    await lstat(statePath);
    throw codeGraphStateError(`CodeGraph state successor appeared during quarantine: ${statePath}`);
  } catch (error: unknown) {
    if ((error as { code?: unknown })?.code !== "ENOENT") {
      throw codeGraphStateRecoveryError(
        `stale CodeGraph state successor and quarantine preserved: ${statePath}`,
        error,
        {
          committed: true,
          renameCommitted: true,
          removalCommitted: false,
          committedPath: quarantinePath,
          quarantinePreserved: true,
          successorPreserved: true,
          recoveryPaths: { canonical: statePath, quarantine: quarantinePath },
        },
      );
    }
  }

  // Node does not expose unlinkat(2) with a pinned directory descriptor. Keep
  // the verified, randomly named quarantine as recovery evidence instead of
  // reintroducing a check-then-unlink window that could delete a successor.
}

export const _removeStaleCodeGraphStateForTests = removeStaleCodeGraphState;

async function readCodeGraphDaemonStateSnapshot(
  statePath: string,
  canonicalWorktreePath: string,
  { allowChildIdentity }: { allowChildIdentity?: ProcessIdentity } = {},
): Promise<CodeGraphDaemonStateSnapshot | null> {
  try {
    const pinned = await readPinnedCodeGraphState(statePath);
    const state = JSON.parse(pinned.content) as LooseRecord;
    const pid = Number(state.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw codeGraphStateError(`CodeGraph state has an invalid pid: ${statePath}`);
    }
    const codebaseRoot = typeof state.codebaseRoot === "string"
      ? await realpath(state.codebaseRoot)
      : "";
    if (codebaseRoot !== canonicalWorktreePath) {
      throw codeGraphStateError(`CodeGraph state is bound to a different worktree: ${statePath}`);
    }
    let processIdentity = parseStoredProcessIdentity(state.processIdentity, pid);
    if (!processIdentity && allowChildIdentity && pid === allowChildIdentity.pid) {
      const current = captureProcessIdentity(pid, { strict: true });
      if (sameProcessIdentity(current, allowChildIdentity)) processIdentity = allowChildIdentity;
    }
    if (!processIdentity) {
      throw codeGraphStateError(`CodeGraph state has no verifiable process identity: ${statePath}`);
    }
    return {
      state: {
        pid,
        codebaseRoot,
        socketPath: typeof state.socketPath === "string" ? state.socketPath : null,
        source: typeof state.source === "string" ? state.source : "codegraph_daemon",
        processIdentity,
      },
      generation: pinned.generation,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw codeGraphStateError(`CodeGraph state contains invalid JSON: ${statePath}`, "codegraph_state_invalid", error);
    }
    throw error;
  }
}

async function readCodeGraphDaemonState(
  statePath: string,
  canonicalWorktreePath: string,
  options: { allowChildIdentity?: ProcessIdentity } = {},
): Promise<CodeGraphDaemonState | null> {
  return (await readCodeGraphDaemonStateSnapshot(statePath, canonicalWorktreePath, options))?.state ?? null;
}

async function waitForCodeGraphDaemonState({
  statePath,
  canonicalWorktreePath,
  child,
  childIdentity,
  timeoutMs,
}: {
  statePath: string;
  canonicalWorktreePath: string;
  child: ChildProcess;
  childIdentity: ProcessIdentity;
  timeoutMs: number;
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readCodeGraphDaemonState(statePath, canonicalWorktreePath, { allowChildIdentity: childIdentity });
    if (state && isProcessIdentityAlive(state.processIdentity)) return state;
    if (child.exitCode !== null || child.signalCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

type StopCodeGraphProcessTreeOptions = {
  killProcessTree?: typeof killTree;
  childIdentity?: ProcessIdentity;
  processIdentityIsAlive?: typeof isProcessIdentityAlive;
  waitForProcessIdentityExit?: typeof waitForProcessIdentityExit;
};

export async function stopCodeGraphProcessTree(
  child: ChildProcess,
  daemonIdentity: ProcessIdentity | null,
  {
    killProcessTree = killTree,
    childIdentity,
    processIdentityIsAlive = isProcessIdentityAlive,
    waitForProcessIdentityExit: waitForIdentityExit = waitForProcessIdentityExit,
  }: StopCodeGraphProcessTreeOptions = {},
) {
  child.stdin?.end();
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    if (!childIdentity || childIdentity.pid !== child.pid) {
      throw codeGraphStateError(`CodeGraph child process identity unavailable for pid ${child.pid}`, "codegraph_cleanup_failed");
    }
    await killProcessTree(child.pid, CODEGRAPH_STOP_TIMEOUT_MS, {
      requireDescendantScan: true,
      expectedRootIdentity: childIdentity,
    });
  }
  const childExited = await waitForChildExit(child, CODEGRAPH_STOP_TIMEOUT_MS);

  let daemonExited = !daemonIdentity || daemonIdentity.pid === child.pid
    ? childExited
    : false;
  if (daemonIdentity && daemonIdentity.pid !== child.pid) {
    await killProcessTree(daemonIdentity.pid, CODEGRAPH_STOP_TIMEOUT_MS, {
      requireDescendantScan: true,
      expectedRootIdentity: daemonIdentity,
    });
    daemonExited = await waitForIdentityExit(daemonIdentity, CODEGRAPH_STOP_TIMEOUT_MS);
    if (!daemonExited || processIdentityIsAlive(daemonIdentity)) {
      throw Object.assign(new Error(`CodeGraph daemon cleanup could not be verified for pid ${daemonIdentity.pid}`), {
        code: "codegraph_cleanup_failed",
      });
    }
  }

  return childExited && daemonExited;
}

export async function cleanupStartingCodeGraphProcess(
  pid: number,
  identity: ProcessIdentity,
  killProcessTree: typeof killTree = killTree,
) {
  if (identity.pid !== pid || !sameProcessIdentity(identity, identity)) {
    throw codeGraphStateError(`CodeGraph starting process identity unavailable for pid ${pid}`, "codegraph_cleanup_failed");
  }
  await killProcessTree(pid, CODEGRAPH_STOP_TIMEOUT_MS, {
    requireDescendantScan: true,
    expectedRootIdentity: identity,
  });
}

/**
 * Build a fresh worktree index and keep a real CodeGraph MCP process alive for
 * the exact worktree that prepareTask will inspect. The worktree-local state
 * avoids cross-assignment collisions in the shared CPB root and preserves the
 * normal fail-closed readiness contract (usable index + live matching PID).
 */
export async function startWorktreeCodeGraphRuntime(
  worktreePath: string | null | undefined,
  {
    env = process.env,
    log = createLogger("worker-codegraph"),
    onSpawn: onProcessSpawn,
    stopProcessTree = stopCodeGraphProcessTree,
    verifyStateRemoved: verifyStateRemovedFn = verifyPathRemoved,
  }: {
    env?: NodeJS.ProcessEnv;
    log?: WorktreeCodeGraphLog;
    onSpawn?: (pid: number, identity: ProcessIdentity) => void;
    stopProcessTree?: typeof stopCodeGraphProcessTree;
    verifyStateRemoved?: typeof verifyPathRemoved;
  } = {},
): Promise<WorktreeCodeGraphRuntime | null> {
  if (!worktreePath || env.CPB_CODEGRAPH_ENABLED === "0" || env.CPB_WORKTREE_CODEGRAPH_INIT === "0") {
    return null;
  }

  const canonicalWorktreePath = await realpath(worktreePath);
  const timeout = Number.parseInt(env.CPB_WORKTREE_CODEGRAPH_INIT_TIMEOUT_MS || "600000", 10);
  const timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 600_000;
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  let initStdout = "";
  let initStderr = "";
  try {
    const initialized = await execFileAsync("codegraph", ["init", canonicalWorktreePath], {
      cwd: canonicalWorktreePath,
      env,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    initStdout = String(initialized.stdout || "");
    initStderr = String(initialized.stderr || "");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`codegraph init failed for worktree: ${message}`);
    throw Object.assign(new Error(`CodeGraph init failed for worktree: ${message}`), {
      code: "codegraph_init_failed",
    });
  }

  const statePath = path.join(canonicalWorktreePath, ".codegraph", "daemon.pid");
  await removeStaleCodeGraphState(statePath, canonicalWorktreePath);
  let serverStderr = "";
  const child = _spawn("codegraph", ["serve", "--mcp", "--path", canonicalWorktreePath], {
    cwd: canonicalWorktreePath,
    env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout?.resume();
  child.stderr?.on("data", (chunk: Buffer) => {
    serverStderr = `${serverStderr}${chunk.toString("utf8")}`.slice(-2_000);
  });
  child.on("error", (error) => {
    log.warn(`codegraph MCP process error: ${error.message}`);
  });

  let childIdentity: ProcessIdentity | null = null;
  let daemonState: CodeGraphDaemonState | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        child.off("exit", onExit);
        if (!child.pid) {
          reject(new Error("CodeGraph MCP spawn completed without a pid"));
          return;
        }
        try {
          childIdentity = captureProcessIdentity(child.pid, { strict: true });
          if (!childIdentity) throw new Error(`CodeGraph MCP process identity unavailable for pid ${child.pid}`);
          onProcessSpawn?.(child.pid, childIdentity);
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        child.off("exit", onExit);
        reject(error);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
        reject(new Error(`CodeGraph MCP exited before readiness (code=${code}, signal=${signal || "none"})`));
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
      child.once("exit", onExit);
    });

    if (!child.pid) {
      throw new Error(`CodeGraph MCP did not remain alive${serverStderr ? `: ${serverStderr}` : ""}`);
    }
    if (!childIdentity) {
      throw new Error(`CodeGraph MCP process identity unavailable for pid ${child.pid}`);
    }
    const childPid = child.pid;
    const serveTimeout = Number.parseInt(env.CPB_WORKTREE_CODEGRAPH_SERVE_TIMEOUT_MS || "10000", 10);
    daemonState = await waitForCodeGraphDaemonState({
      statePath,
      canonicalWorktreePath,
      child,
      childIdentity,
      timeoutMs: Number.isFinite(serveTimeout) && serveTimeout > 0 ? serveTimeout : 10_000,
    });
    if (!daemonState && child.exitCode === null && child.signalCode === null) {
      // A degraded in-process server reports readiness on stderr instead of
      // publishing daemon.pid. Give that explicit readiness frame a small,
      // bounded delivery grace after the file-state deadline; under scheduler
      // pressure the child can be spawned before its first stderr write runs.
      const fallbackDeadline = Date.now() + 1_000;
      while (
        !/Shared daemon unavailable; serving this session in-process \(degraded\)/.test(serverStderr)
        && child.exitCode === null
        && child.signalCode === null
        && Date.now() < fallbackDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (!daemonState
      && child.exitCode === null
      && child.signalCode === null
      && /Shared daemon unavailable; serving this session in-process \(degraded\)/.test(serverStderr)) {
      daemonState = {
        pid: childPid,
        codebaseRoot: canonicalWorktreePath,
        socketPath: null,
        source: "managed_worker_mcp_in_process",
        processIdentity: childIdentity,
      };
      await writeJsonAtomic(statePath, {
        ...daemonState,
        startedAt: new Date().toISOString(),
      });
    }
    if (!daemonState) {
      throw new Error(`CodeGraph daemon did not publish live readiness${serverStderr ? `: ${serverStderr}` : ""}`);
    }
    const readyDaemonState = daemonState;
    const readyChildIdentity = childIdentity;
    await writeJsonAtomic(statePath, {
      ...readyDaemonState,
      processIdentity: readyDaemonState.processIdentity,
      startedAt: new Date().toISOString(),
    });
    const readyAt = Date.now();
    const readyAtIso = new Date(readyAt).toISOString();

    let stopped = false;
    let stopProof: WorktreeCodeGraphCleanupProof | null = null;
    let stopPromise: Promise<WorktreeCodeGraphCleanupProof> | null = null;
    const stop = () => {
      if (stopped && stopProof) return Promise.resolve(stopProof);
      if (stopPromise) return stopPromise;

      const attempt = (async () => {
        const cleanupStartedAt = new Date().toISOString();
        const processTreeStopped = await stopProcessTree(child, readyDaemonState.processIdentity, {
          childIdentity: readyChildIdentity,
        });
        if (!processTreeStopped) {
          throw Object.assign(new Error(`CodeGraph process cleanup failed for ${canonicalWorktreePath}`), {
            code: "codegraph_cleanup_failed",
          });
        }
        try {
          await removeStaleCodeGraphState(statePath, canonicalWorktreePath, readyDaemonState);
        } catch (error: unknown) {
          throw Object.assign(new Error(
            `CodeGraph state cleanup failed for ${canonicalWorktreePath}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          ), {
            code: "codegraph_cleanup_failed",
          });
        }
        let stateRemoved: boolean;
        try {
          stateRemoved = await verifyStateRemovedFn(statePath);
        } catch (error: unknown) {
          throw Object.assign(new Error(
            `CodeGraph state removal verification failed for ${canonicalWorktreePath}: ${error instanceof Error ? error.message : String(error)}`,
          ), {
            code: "codegraph_cleanup_failed",
            cause: error,
          });
        }
        if (!stateRemoved) {
          throw Object.assign(new Error(`CodeGraph state cleanup did not remove ${statePath}`), {
            code: "codegraph_cleanup_failed",
          });
        }
        const cleanupCompletedAt = new Date().toISOString();
        return {
          ok: true,
          cleanupVerified: true,
          processTreeStopped: true,
          stateRemoved: true,
          statePath,
          worktreePath: canonicalWorktreePath,
          startup: {
            ok: true,
            source: readyDaemonState.source,
            pid: readyDaemonState.pid,
            processPid: childPid,
            statePath,
            startedAt: startedAtIso,
            readyAt: readyAtIso,
          },
          startupSource: readyDaemonState.source,
          pid: readyDaemonState.pid,
          processPid: childPid,
          cleanupStartedAt,
          cleanupCompletedAt,
        } satisfies WorktreeCodeGraphCleanupProof;
      })();
      stopPromise = attempt;
      void attempt.then(
        (proof) => {
          stopped = true;
          stopProof = proof;
          if (stopPromise === attempt) stopPromise = null;
        },
        () => {
          if (stopPromise === attempt) stopPromise = null;
        },
      );
      return attempt;
    };

    log.info(`codegraph initialized and serving worktree in ${Date.now() - startedAt}ms`);
    return {
      pid: readyDaemonState.pid,
      processPid: childPid,
      statePath,
      evidence: {
        ok: true,
        elapsedMs: Date.now() - startedAt,
        startedAt: startedAtIso,
        readyAt: readyAtIso,
        pid: readyDaemonState.pid,
        processPid: childPid,
        source: readyDaemonState.source,
        stdoutTail: initStdout.slice(-2_000),
        stderrTail: initStderr.slice(-2_000),
      },
      stop,
    };
  } catch (err: unknown) {
    let cleanupError: unknown = null;
    try {
      await stopCodeGraphProcessTree(child, daemonState?.processIdentity || null, {
        ...(childIdentity ? { childIdentity } : {}),
      });
      if (daemonState) {
        await removeStaleCodeGraphState(statePath, canonicalWorktreePath, daemonState);
      }
    } catch (error) {
      cleanupError = error;
    }
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`codegraph runtime failed for worktree: ${message}`);
    const runtimeError = Object.assign(new Error(`CodeGraph runtime failed for worktree: ${message}`, { cause: err }), {
      code: "codegraph_runtime_failed",
    });
    if (!cleanupError) throw runtimeError;
    throw Object.assign(new AggregateError([runtimeError, cleanupError], runtimeError.message, { cause: runtimeError }), {
      code: "codegraph_runtime_failed",
      primaryError: runtimeError,
      cleanupError,
    });
  }
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

type WorktreeInfo = VerifiedManagedWorktreeContext;

type JobResult = LooseRecord & {
  status?: string;
  failure?: LooseRecord;
};

type ManagedAssignmentStore = {
  getAttempt: (assignmentId: string, attempt: number) => Promise<LooseRecord | null>;
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

type FinalizerLeaseGuardOptions = {
  assignmentStore: Pick<ManagedAssignmentStore, "assertActiveAttemptIdentity">;
  workerStore: Pick<ManagedWorkerStore, "renewInboxClaim" | "updateWorkerIf">;
  assignmentId: string;
  inboxAssignmentId: string;
  attempt: number;
  attemptToken: string;
  orchestratorEpoch?: number;
  workerId: string;
  workerIncarnation: string;
  claimToken: string;
  assertExecutionLeaseHeld: () => void;
  pollCancel: () => Promise<unknown>;
  cancelRequested: () => CancelRequest | null;
  loseExecutionLease: (reason: string) => void;
};

function finalizerLeaseError(
  reason: string,
  code: "MUTATION_LEASE_LOST" | "ASSIGNMENT_CANCELLED",
  identity: LooseRecord,
  cause?: unknown,
) {
  return Object.assign(
    new Error(reason, cause === undefined ? undefined : { cause }),
    {
      code,
      status: "blocked",
      committed: code === "ASSIGNMENT_CANCELLED" ? false : null,
      retryable: code === "MUTATION_LEASE_LOST",
      mutationFence: identity,
    },
  );
}

export function createFinalizerMutationLeaseGuard({
  assignmentStore,
  workerStore,
  assignmentId,
  inboxAssignmentId,
  attempt,
  attemptToken,
  orchestratorEpoch,
  workerId,
  workerIncarnation,
  claimToken,
  assertExecutionLeaseHeld,
  pollCancel,
  cancelRequested,
  loseExecutionLease,
}: FinalizerLeaseGuardOptions): AssertFinalizerMutationLease {
  const identity = {
    assignmentId,
    attempt,
    attemptToken,
    orchestratorEpoch: orchestratorEpoch ?? null,
    workerId,
    workerIncarnation,
    claimToken,
  };

  return async (context) => {
    try {
      assertExecutionLeaseHeld();
      await pollCancel();
      const cancel = cancelRequested();
      if (cancel && context.operation !== "result.publish") {
        throw finalizerLeaseError(
          `assignment cancelled during finalization: ${cancel.reason || "cancel requested"}`,
          "ASSIGNMENT_CANCELLED",
          identity,
        );
      }

      const renewed = await workerStore.renewInboxClaim(
        workerId,
        inboxAssignmentId,
        claimToken,
        workerIncarnation,
      );
      if (renewed !== true) {
        throw new Error("worker inbox claim is no longer active");
      }
      await assignmentStore.assertActiveAttemptIdentity(assignmentId, attempt, {
        assignmentId,
        attempt,
        attemptToken,
        orchestratorEpoch,
      });
      const worker = await workerStore.updateWorkerIf(workerId, {}, {
        incarnationToken: workerIncarnation,
        currentAssignmentId: assignmentId,
        currentAttemptToken: attemptToken,
        status: ["assigned", "running"],
      });
      if (!worker) throw new Error("worker incarnation or assignment reservation changed");
      assertExecutionLeaseHeld();
      if (cancelRequested() && context.operation !== "result.publish") {
        throw finalizerLeaseError(
          "assignment cancelled during finalization",
          "ASSIGNMENT_CANCELLED",
          identity,
        );
      }
      return true;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error
        && error.code === "ASSIGNMENT_CANCELLED") {
        throw error;
      }
      const reason = `finalizer mutation lease lost for ${assignmentId} attempt ${attempt}`;
      loseExecutionLease(reason);
      throw finalizerLeaseError(reason, "MUTATION_LEASE_LOST", identity, error);
    }
  };
}

function normalizedFinalizerHandoffEvidence(value: unknown) {
  const evidence = recordValue(value);
  return {
    schema: evidence.schema,
    previousAssignmentId: evidence.previousAssignmentId,
    previousAttempt: evidence.previousAttempt,
    previousAttemptTokenDigest: evidence.previousAttemptTokenDigest,
    previousOrchestratorEpoch: evidence.previousOrchestratorEpoch,
    previousJobId: evidence.previousJobId,
    previousResultStatus: evidence.previousResultStatus,
    previousCommitted: evidence.previousCommitted,
    finalizationId: evidence.finalizationId,
    journalGeneration: evidence.journalGeneration,
    previousClaimId: evidence.previousClaimId,
    previousOwnerDigest: evidence.previousOwnerDigest,
    journalStage: evidence.journalStage,
    journalDigest: evidence.journalDigest,
    commit: evidence.commit,
    tree: evidence.tree,
  };
}

function canonicalWorkerDigest(value: unknown) {
  const canonical = (nested: unknown): unknown => {
    if (Array.isArray(nested)) return nested.map(canonical);
    if (!nested || typeof nested !== "object") return nested;
    return Object.fromEntries(Object.entries(nested as LooseRecord)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, child]) => [key, canonical(child)]));
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function workerCommittedReceipt(value: unknown, operation: string) {
  const receipt = recordValue(value);
  return receipt.operation === operation
    && receipt.attempted === true
    && receipt.committed === true
    && typeof receipt.observedAt === "string"
    && typeof receipt.eventId === "string";
}

function workerSafePartialContinuation(mode: unknown, finalizeResultValue: unknown) {
  const finalizeResult = recordValue(finalizeResultValue);
  const intent = recordValue(finalizeResult.remoteIntent);
  const receipts = recordValue(intent.receipts);
  const reconciliation = recordValue(finalizeResult.reconciliation);
  const proof = recordValue(finalizeResult.safeContinuation);
  const matrix: Record<string, { operation: string; readbackKey: string; readback: unknown }> = mode === "remote"
    ? {
        claimed: { operation: "repository.push", readbackKey: "journal", readback: reconciliation.journal },
        "repository.push.intent": { operation: "repository.push", readbackKey: "push", readback: reconciliation.push },
        "repository.push.receipt": { operation: "repository.push", readbackKey: "receipts.push", readback: receipts.push },
        "issue.close.intent": { operation: "issue.close", readbackKey: "issueClose", readback: reconciliation.issueClose },
        "issue.close.receipt": { operation: "issue.close", readbackKey: "receipts.issueClose", readback: receipts.issueClose },
        "remote.complete": { operation: "issue.close", readbackKey: "receipts.issueClose", readback: receipts.issueClose },
      }
    : mode === "pr"
      ? {
          claimed: { operation: "pull_request.push", readbackKey: "journal", readback: reconciliation.journal },
          "pull_request.push.intent": { operation: "pull_request.push", readbackKey: "push", readback: reconciliation.push },
          "pull_request.push.receipt": { operation: "pull_request.push", readbackKey: "receipts.branchPush", readback: receipts.branchPush },
          "pull_request.create.intent": { operation: "pull_request.create", readbackKey: "pullRequestCreate", readback: reconciliation.pullRequestCreate },
          "pull_request.create.receipt": { operation: "pull_request.create", readbackKey: "receipts.pullRequestCreate", readback: receipts.pullRequestCreate },
          "pr_opened.publish.intent": { operation: "pr_opened.publish", readbackKey: "prEvent", readback: reconciliation.prEvent },
          "pr_opened.publish.receipt": { operation: "pr_opened.publish", readbackKey: "receipts.prEvent", readback: receipts.prEvent },
        }
      : {};
  const expected = matrix[String(intent.stage || "")];
  const readback = recordValue(expected?.readback);
  if (!expected
    || proof.schema !== "cpb.finalizer-safe-continuation.v1"
    || proof.finalizationId !== intent.finalizationId
    || proof.journalDigest !== canonicalWorkerDigest(intent)
    || proof.journalGeneration !== intent.generation
    || proof.stage !== intent.stage
    || proof.operation !== expected.operation
    || proof.readbackKey !== expected.readbackKey
    || proof.readbackDigest !== canonicalWorkerDigest(expected.readback)
    || typeof proof.decision !== "boolean") return false;
  if (intent.stage === "claimed") {
    return proof.decision === false && readback.remoteMutationStarted === false;
  }
  if (expected.readbackKey.startsWith("receipts.")) {
    return proof.decision === true && workerCommittedReceipt(expected.readback, expected.operation);
  }
  if (intent.stage === "pull_request.create.intent" && proof.decision !== true) return false;
  return typeof readback.committed === "boolean" && readback.committed === proof.decision;
}

function validatedFinalizerRecoveryTakeover(value: unknown): FinalizerMutationFence["takeover"] | null {
  const recovery = recordValue(value);
  if (recovery.schema !== FINALIZER_RECOVERY_SCHEMA
    || recovery.required !== true
    || recovery.allowMutation !== true
    || (recovery.committed !== false && recovery.safePartialContinuation !== true)) return null;
  const takeover = recordValue(recovery.takeover);
  const ownerProof = recordValue(recovery.priorAttemptProof);
  const evidence = recordValue(takeover.evidence);
  const previousAssignmentId = typeof recovery.previousAssignmentId === "string"
    ? recovery.previousAssignmentId
    : null;
  const previousAttempt = Number(recovery.previousAttempt);
  const previousJobId = typeof recovery.previousJobId === "string" ? recovery.previousJobId : null;
  const previousClaimId = typeof recovery.previousClaimId === "string" ? recovery.previousClaimId : null;
  const observedAt = typeof takeover.observedAt === "string" ? takeover.observedAt : null;
  const evidenceId = typeof takeover.evidenceId === "string" ? takeover.evidenceId : null;
  const normalizedEvidence = normalizedFinalizerHandoffEvidence(evidence);
  const expectedEvidenceId = crypto.createHash("sha256")
    .update(JSON.stringify(normalizedEvidence), "utf8")
    .digest("hex");
  if (takeover.schema !== FINALIZER_HANDOFF_SCHEMA
    || takeover.kind !== "explicit-handoff"
    || evidence.schema !== FINALIZER_HANDOFF_EVIDENCE_SCHEMA
    || !previousAssignmentId
    || !Number.isSafeInteger(previousAttempt) || previousAttempt < 1
    || !previousJobId
    || !previousClaimId || !/^[a-f0-9]{64}$/.test(previousClaimId)
    || takeover.previousClaimId !== previousClaimId
    || evidence.previousAssignmentId !== previousAssignmentId
    || !Number.isSafeInteger(Number(evidence.previousAttempt)) || Number(evidence.previousAttempt) < 1
    || typeof evidence.previousJobId !== "string" || !evidence.previousJobId
    || evidence.previousClaimId !== previousClaimId
    || (typeof evidence.previousCommitted !== "boolean" && evidence.previousCommitted !== null)
    || typeof evidence.previousOwnerDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(evidence.previousOwnerDigest)
    || typeof evidence.journalStage !== "string" || !evidence.journalStage
    || typeof evidence.journalDigest !== "string" || !/^[a-f0-9]{64}$/.test(evidence.journalDigest)
    || !["blocked", "failed"].includes(String(evidence.previousResultStatus || ""))
    || typeof evidence.previousAttemptTokenDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(evidence.previousAttemptTokenDigest)
    || !Number.isSafeInteger(Number(evidence.previousOrchestratorEpoch))
    || Number(evidence.previousOrchestratorEpoch) < 1
    || typeof evidence.finalizationId !== "string"
    || !/^[a-f0-9]{64}$/.test(evidence.finalizationId)
    || !Number.isSafeInteger(Number(evidence.journalGeneration))
    || Number(evidence.journalGeneration) < 1
    || typeof evidence.commit !== "string" || !/^[a-f0-9]{40,64}$/.test(evidence.commit)
    || typeof evidence.tree !== "string" || !/^[a-f0-9]{40,64}$/.test(evidence.tree)
    || !evidenceId || evidenceId !== expectedEvidenceId
    || ownerProof.evidenceId !== evidenceId
    || canonicalWorkerDigest(ownerProof.evidence) !== canonicalWorkerDigest(evidence)
    || !observedAt || !Number.isFinite(Date.parse(observedAt))) return null;
  return {
    kind: "explicit-handoff",
    previousClaimId,
    evidenceId,
    observedAt,
  };
}

const VERIFIED_FINALIZER_PRIOR_ATTEMPT = Symbol("verified-finalizer-prior-attempt");
type VerifiedFinalizerPriorAttempt = {
  [VERIFIED_FINALIZER_PRIOR_ATTEMPT]: true;
  evidenceId: string;
  ownerDigest: string;
  source: LooseRecord;
  targetBranch: string;
  preRemoteHead: string | null;
  candidate: ValidatedFinalizerCandidate;
  completionGate: LooseRecord;
  originJobId: string;
};

export async function verifyFinalizerRecoveryPriorAttempt({
  assignmentStore,
  assignmentId,
  entryId,
  recovery: recoveryValue,
}: {
  assignmentStore: Pick<ManagedAssignmentStore, "getAttempt">;
  assignmentId: string;
  entryId: string;
  recovery: unknown;
}): Promise<VerifiedFinalizerPriorAttempt | null> {
  const recovery = recordValue(recoveryValue);
  const proof = recordValue(recovery.priorAttemptProof);
  const evidence = recordValue(proof.evidence);
  const normalizedEvidence = normalizedFinalizerHandoffEvidence(evidence);
  const evidenceId = typeof proof.evidenceId === "string" ? proof.evidenceId : null;
  const ownerAttemptNumber = Number(evidence.previousAttempt);
  const previousAttempt = Number(recovery.previousAttempt);
  const observationProof = recordValue(recovery.lastObservationProof);
  const observationEvidence = recordValue(observationProof.evidence);
  if (recovery.schema !== FINALIZER_RECOVERY_SCHEMA
    || recovery.required !== true
    || proof.schema !== FINALIZER_HANDOFF_SCHEMA
    || proof.kind !== "explicit-handoff"
    || !evidenceId || !/^[a-f0-9]{64}$/.test(evidenceId)
    || evidenceId !== crypto.createHash("sha256").update(JSON.stringify(normalizedEvidence), "utf8").digest("hex")
    || recovery.previousAssignmentId !== assignmentId
    || evidence.previousAssignmentId !== assignmentId
    || !Number.isSafeInteger(ownerAttemptNumber) || ownerAttemptNumber < 1
    || !Number.isSafeInteger(previousAttempt) || previousAttempt < 1
    || observationProof.schema !== "cpb.finalizer-observation-proof.v1"
    || observationEvidence.schema !== "cpb.finalizer-observation-evidence.v1"
    || observationEvidence.assignmentId !== assignmentId
    || observationEvidence.attempt !== previousAttempt
    || observationEvidence.jobId !== recovery.previousJobId
    || observationProof.evidenceId !== canonicalWorkerDigest(observationEvidence)) return null;

  const priorAttempt = recordValue(await assignmentStore.getAttempt(assignmentId, ownerAttemptNumber));
  const priorResult = recordValue(priorAttempt.result);
  const priorJobResult = recordValue(priorResult.jobResult);
  const finalizeResult = recordValue(priorResult.finalizeResult);
  const intent = recordValue(finalizeResult.remoteIntent);
  const claim = recordValue(intent.claim);
  const heartbeat = recordValue(priorAttempt.heartbeat);
  const completionGate = recordValue(priorJobResult.completionGate);
  const candidate = validatedFinalizerCandidate(priorJobResult);
  const failureCause = recordValue(recordValue(priorJobResult.failure).cause);
  const priorWorktreePath = typeof heartbeat.worktreePath === "string"
    ? heartbeat.worktreePath
    : typeof failureCause.worktreePath === "string"
      ? failureCause.worktreePath
      : null;
  const processIdentity = recordValue(heartbeat.processIdentity);
  const attemptToken = typeof priorAttempt.attemptToken === "string" ? priorAttempt.attemptToken : null;
  const ownerDigest = typeof claim.ownerDigest === "string" ? claim.ownerDigest : null;
  const source = recordValue(intent.source);
  const targetBranch = typeof intent.targetBranch === "string" ? intent.targetBranch : null;
  const preRemoteHead = intent.preRemoteHead === null
    ? null
    : typeof intent.preRemoteHead === "string" ? intent.preRemoteHead : undefined;
  const expectedFenceDigest = finalizerMutationFenceDigest({
    assignmentId,
    entryId,
    attemptToken,
    orchestratorEpoch: priorAttempt.orchestratorEpoch,
    workerId: priorAttempt.workerId,
    workerIncarnation: heartbeat.workerIncarnation,
    processIdentity: {
      pid: processIdentity.pid,
      startTimeTicks: processIdentity.startTimeTicks,
    },
  });
  const proofBinding = recordValue(proof.journalBinding);
  if (!priorAttempt.result
    || !["blocked", "failed"].includes(String(priorAttempt.status || ""))
    || priorResult.assignmentId !== assignmentId
    || Number(priorResult.attempt) !== ownerAttemptNumber
    || priorResult.attemptToken !== attemptToken
    || priorResult.status !== evidence.previousResultStatus
    || finalizeResult.jobId !== evidence.previousJobId
    || intent.originJobId !== evidence.previousJobId
    || recovery.originJobId !== intent.originJobId
    || finalizeResult.committed !== evidence.previousCommitted
    || intent.entryId !== entryId
    || intent.finalizationId !== evidence.finalizationId
    || intent.generation !== evidence.journalGeneration
    || intent.stage !== evidence.journalStage
    || intent.commit !== evidence.commit
    || intent.tree !== evidence.tree
    || claim.claimId !== evidence.previousClaimId
    || recovery.previousClaimId !== claim.claimId
    || proof.previousClaimId !== claim.claimId
    || ownerDigest !== evidence.previousOwnerDigest
    || proof.acceptedOwnerDigest !== ownerDigest
    || !ownerDigest || ownerDigest !== expectedFenceDigest
    || heartbeat.workerId !== priorAttempt.workerId
    || processIdentity.birthIdPrecision !== "exact"
    || !attemptToken
    || crypto.createHash("sha256").update(attemptToken, "utf8").digest("hex") !== evidence.previousAttemptTokenDigest
    || canonicalWorkerDigest(intent) !== evidence.journalDigest
    || canonicalWorkerDigest(proofBinding.source) !== canonicalWorkerDigest(source)
    || proofBinding.targetBranch !== targetBranch
    || proofBinding.preRemoteHead !== preRemoteHead
    || !targetBranch
    || preRemoteHead === undefined
    || !candidate
    || !priorWorktreePath
    || candidate.baseSha !== String(source.head || "").toLowerCase()
    || !(await verifyFinalizerCandidateCommit({
      repositoryPath: priorWorktreePath,
      result: finalizeResult,
      candidate,
    }))) return null;
  const observedAttempt = ownerAttemptNumber === previousAttempt
    ? priorAttempt
    : recordValue(await assignmentStore.getAttempt(assignmentId, previousAttempt));
  const observedResult = recordValue(observedAttempt.result);
  const observedFinalizeResult = recordValue(observedResult.finalizeResult);
  const observedIntent = recordValue(observedFinalizeResult.remoteIntent);
  const observedHeartbeat = recordValue(observedAttempt.heartbeat);
  const observedProcessIdentity = recordValue(observedHeartbeat.processIdentity);
  const observedAttemptToken = typeof observedAttempt.attemptToken === "string"
    ? observedAttempt.attemptToken
    : null;
  const observedSafeContinuation = workerSafePartialContinuation(recovery.mode, observedFinalizeResult);
  if (!observedAttempt.result
    || !["blocked", "failed"].includes(String(observedAttempt.status || ""))
    || observedResult.assignmentId !== assignmentId
    || Number(observedResult.attempt) !== previousAttempt
    || observedResult.attemptToken !== observedAttemptToken
    || observedResult.status !== observationEvidence.resultStatus
    || observedFinalizeResult.jobId !== observationEvidence.jobId
    || observedFinalizeResult.committed !== observationEvidence.committed
    || recovery.committed !== observationEvidence.committed
    || recovery.safePartialContinuation !== observedSafeContinuation
    || observationEvidence.finalizeResultDigest !== canonicalWorkerDigest(observedFinalizeResult)
    || canonicalWorkerDigest(observedIntent) !== observationEvidence.journalDigest
    || canonicalWorkerDigest(observedIntent) !== evidence.journalDigest
    || recordValue(observedIntent.claim).claimId !== claim.claimId
    || recordValue(observedIntent.claim).ownerDigest !== ownerDigest
    || observedAttempt.workerId !== observationEvidence.workerId
    || observedHeartbeat.workerId !== observationEvidence.workerId
    || observedHeartbeat.workerIncarnation !== observationEvidence.workerIncarnation
    || observedProcessIdentity.pid !== recordValue(observationEvidence.processIdentity).pid
    || observedProcessIdentity.startTimeTicks !== recordValue(observationEvidence.processIdentity).startTimeTicks
    || observedProcessIdentity.birthIdPrecision !== "exact"
    || observedAttempt.orchestratorEpoch !== observationEvidence.orchestratorEpoch
    || !observedAttemptToken
    || crypto.createHash("sha256").update(observedAttemptToken, "utf8").digest("hex")
      !== observationEvidence.attemptTokenDigest) return null;
  const takeover = recovery.allowMutation === true
    ? validatedFinalizerRecoveryTakeover(recovery)
    : null;
  if (recovery.allowMutation === true
    && (!takeover || takeover.evidenceId !== evidenceId || takeover.previousClaimId !== claim.claimId)) return null;
  return {
    [VERIFIED_FINALIZER_PRIOR_ATTEMPT]: true,
    evidenceId,
    ownerDigest,
    source,
    targetBranch,
    preRemoteHead: preRemoteHead ?? null,
    candidate,
    completionGate,
    originJobId: String(intent.originJobId),
  };
}

export function buildFinalizerMutationFence({
  assignmentId,
  entryId,
  attemptToken,
  orchestratorEpoch,
  workerId,
  workerIncarnation,
  processIdentity,
  finalizerRecovery = null,
  verifiedPriorAttempt = null,
}: {
  assignmentId: string;
  entryId: string;
  attemptToken: string;
  orchestratorEpoch?: number;
  workerId: string;
  workerIncarnation: string;
  processIdentity: ProcessIdentity;
  finalizerRecovery?: LooseRecord | null;
  verifiedPriorAttempt?: VerifiedFinalizerPriorAttempt | null;
}): FinalizerMutationFence {
  if (!Number.isSafeInteger(orchestratorEpoch)) {
    throw Object.assign(new Error("finalizer mutation fence requires an orchestrator epoch"), {
      code: "MUTATION_FENCE_INVALID",
    });
  }
  if (processIdentity.birthIdPrecision !== "exact" || !processIdentity.birthId) {
    throw Object.assign(new Error("finalizer mutation fence requires an exact process identity"), {
      code: "MUTATION_FENCE_INVALID",
    });
  }
  const takeover = validatedFinalizerRecoveryTakeover(finalizerRecovery);
  if (recordValue(finalizerRecovery).allowMutation === true
    && (!takeover
      || verifiedPriorAttempt?.[VERIFIED_FINALIZER_PRIOR_ATTEMPT] !== true
      || takeover.evidenceId !== verifiedPriorAttempt.evidenceId)) {
    throw Object.assign(new Error("finalizer recovery mutation requires a valid orchestrator handoff"), {
      code: "MUTATION_FENCE_INVALID",
    });
  }
  return {
    assignmentId,
    entryId,
    attemptToken,
    orchestratorEpoch: orchestratorEpoch!,
    workerId,
    workerIncarnation,
    processIdentity: {
      pid: processIdentity.pid,
      startTimeTicks: processIdentity.birthId,
    },
    ...(takeover ? { takeover } : {}),
  };
}

function staleTerminalSyncError(err: unknown) {
  const code = err && typeof err === "object" && "code" in err ? String(err.code || "") : "";
  return code === "STALE_ATTEMPT" || code === "STALE_INBOX_CLAIM";
}

export function shouldCompleteInboxClaimAfterTerminalSync({
  inboxAcked,
  terminalSyncFailed,
}: {
  inboxAcked: boolean;
  terminalSyncFailed?: boolean;
}) {
  return !inboxAcked && !terminalSyncFailed;
}

export async function completeAssignmentStateFromResult({
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
    return {
      result,
      inboxAcked: completion.inboxAcked,
      terminalSyncFailed: false,
      mutationOwnershipLost: false,
    };
  } catch (err) {
    log.error(`failed to sync terminal assignment state: ${redactedWorkerErrorMessage(err, "terminal state sync failed")}`);
    return {
      result: null,
      inboxAcked: false,
      terminalSyncFailed: true,
      mutationOwnershipLost: staleTerminalSyncError(err),
    };
  }
}

export function shouldCleanupWorkerWorktree(
  attemptResult: LooseRecord | null | undefined,
  env: Record<string, string | undefined> = process.env,
) {
  return ["completed", "cancelled"].includes(String(attemptResult?.status || ""))
    && !shouldRetainWorkerWorktree(env);
}

export function worktreeCleanupFailureEvidence(error: unknown): LooseRecord | null {
  if (!error || typeof error !== "object") return null;
  const record = error as LooseRecord;
  const code = typeof record.code === "string" ? record.code : "";
  if (!code.startsWith("WORKTREE_CLEANUP_")) return null;
  const evidence: LooseRecord = { code };
  for (const key of [
    "committed",
    "containerCommitted",
    "renameCommitted",
    "removalCommitted",
    "quarantinePreserved",
    "successorPreserved",
    "committedPath",
  ]) {
    if (record[key] !== undefined) evidence[key] = record[key];
  }
  if (record.recoveryPaths && typeof record.recoveryPaths === "object" && !Array.isArray(record.recoveryPaths)) {
    evidence.recoveryPaths = { ...record.recoveryPaths as LooseRecord };
  }
  return evidence;
}

type DeferredTerminalResult = {
  file: string;
  value: LooseRecord;
};

type PublishTerminalResultAfterWorktreeCleanupOptions = {
  produceResult: (
    capture: (file: string, value: unknown) => Promise<true>,
  ) => Promise<unknown>;
  managedWorktree?: VerifiedManagedWorktreeContext | null;
  cleanupWorktree?: (() => Promise<unknown>) | null;
  retainWorktree?: (() => Promise<unknown>) | null;
  writeResult?: (file: string, value: unknown) => Promise<boolean>;
  expectedResultPath?: string | null;
  env?: Record<string, string | undefined>;
  beforePublish?: ((value: LooseRecord) => Promise<unknown>) | null;
};

function canonicalTerminalResult(value: unknown): LooseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("terminal result must be a JSON object"), {
      code: "TERMINAL_RESULT_INVALID",
    });
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (cause) {
    throw Object.assign(new Error("terminal result must be JSON serializable", { cause }), {
      code: "TERMINAL_RESULT_INVALID",
    });
  }
  if (typeof serialized !== "string") {
    throw Object.assign(new Error("terminal result must serialize to a JSON document"), {
      code: "TERMINAL_RESULT_INVALID",
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (cause) {
    throw Object.assign(new Error("terminal result JSON could not be parsed", { cause }), {
      code: "TERMINAL_RESULT_INVALID",
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("terminal result must serialize to a JSON object"), {
      code: "TERMINAL_RESULT_INVALID",
    });
  }
  return parsed as LooseRecord;
}

export async function writeTerminalResultOnceVerified({
  file,
  value,
  writeResult = writeJsonOnce,
}: {
  file: string;
  value: unknown;
  writeResult?: (file: string, value: unknown) => Promise<boolean>;
}) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file) {
    throw Object.assign(new Error("terminal result path must be absolute and normalized"), {
      code: "TERMINAL_RESULT_PATH_INVALID",
    });
  }
  const intended = canonicalTerminalResult(value);
  const written = await writeResult(file, intended);
  if (written === true) return { created: true, idempotent: false, value: intended };
  if (written !== false) {
    throw Object.assign(new Error("terminal result writer must return true or false"), {
      code: "TERMINAL_RESULT_WRITE_CONTRACT_INVALID",
    });
  }

  let existing: LooseRecord;
  try {
    existing = canonicalTerminalResult(JSON.parse(await readBoundedRegularFileNoFollow(file, {
      maxBytes: TERMINAL_RESULT_MAX_BYTES,
    })));
  } catch (cause) {
    throw Object.assign(new Error("existing terminal result could not be safely verified", { cause }), {
      code: "TERMINAL_RESULT_CONFLICT",
    });
  }
  if (!isDeepStrictEqual(existing, intended)) {
    throw Object.assign(new Error("existing terminal result differs from the intended publication"), {
      code: "TERMINAL_RESULT_CONFLICT",
    });
  }
  return { created: false, idempotent: true, value: intended };
}

function terminalDirectoryIdentity(info: {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
  mode: bigint;
  uid: bigint;
  gid: bigint;
}): WorktreeDirectoryIdentity {
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    birthtimeNs: String(info.birthtimeNs),
    mode: String(info.mode),
    uid: String(info.uid),
    gid: String(info.gid),
  };
}

function terminalFsErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

async function terminalPathPresence(candidate: string): Promise<boolean | null> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    return terminalFsErrorCode(error) === "ENOENT" ? false : null;
  }
}

async function terminalBoundDirectoryState(
  candidate: string,
  expected: WorktreeDirectoryIdentity,
): Promise<boolean | null> {
  let before;
  let canonical;
  let after;
  try {
    before = await lstat(candidate, { bigint: true });
    canonical = await realpath(candidate);
    after = await lstat(candidate, { bigint: true });
  } catch (error) {
    return terminalFsErrorCode(error) === "ENOENT" ? false : null;
  }
  if (
    !before.isDirectory()
    || before.isSymbolicLink()
    || !after.isDirectory()
    || after.isSymbolicLink()
    || canonical !== candidate
  ) {
    return false;
  }
  const beforeIdentity = terminalDirectoryIdentity(before);
  const afterIdentity = terminalDirectoryIdentity(after);
  return sameWorktreeDirectoryIdentity(beforeIdentity, afterIdentity)
    && sameWorktreeDirectoryIdentity(afterIdentity, expected);
}

async function terminalPublicationCleanupError(
  cause: unknown,
  cleanupProof: ManagedWorktreeCleanupProof,
) {
  const recoveryPaths: Record<string, string> = {
    canonical: cleanupProof.worktreePath,
  };
  if (cleanupProof.quarantineContainer) {
    recoveryPaths.quarantineContainer = cleanupProof.quarantineContainer;
  }
  if (cleanupProof.quarantinePath) {
    recoveryPaths.quarantine = cleanupProof.quarantinePath;
  }
  const quarantinePreserved = cleanupProof.quarantinePath
    ? await terminalBoundDirectoryState(
        cleanupProof.quarantinePath,
        cleanupProof.binding.ownership.directory,
      )
    : false;
  const successorPreserved = await terminalPathPresence(cleanupProof.worktreePath);
  const committedPath = quarantinePreserved === true
    ? cleanupProof.quarantinePath || undefined
    : undefined;
  const message = committedPath
    ? `terminal result publication failed after managed worktree quarantine; recovery preserved at ${committedPath}`
    : "terminal result publication failed after managed worktree quarantine; recovery requires inspection";
  return Object.assign(new Error(message, { cause }), {
    code: committedPath
      ? "WORKTREE_CLEANUP_QUARANTINE_PRESERVED"
      : "WORKTREE_CLEANUP_RECOVERY_REQUIRED",
    committed: true,
    containerCommitted: true,
    renameCommitted: true,
    removalCommitted: false,
    quarantinePreserved,
    successorPreserved,
    ...(committedPath ? { committedPath } : {}),
    recoveryPaths,
    cleanupProof,
    terminalPublicationError: cause,
  });
}

/**
 * Defers the terminal result write until managed worktree cleanup has either
 * completed with durable proof or has failed. A cleanup failure therefore
 * cannot coexist with a newly published `completed`/`cancelled` result.
 */
export async function publishTerminalResultAfterWorktreeCleanup({
  produceResult,
  managedWorktree = null,
  cleanupWorktree = null,
  retainWorktree = null,
  writeResult = writeJsonOnce,
  expectedResultPath = null,
  env = process.env,
  beforePublish = null,
}: PublishTerminalResultAfterWorktreeCleanupOptions) {
  const binding = managedWorktree
    ? parseVerifiedManagedWorktreeContext(managedWorktree)
    : null;
  let deferred: DeferredTerminalResult | null = null;
  const produced = await produceResult(async (file, value) => {
    if (deferred) {
      throw Object.assign(new Error("terminal result producer attempted more than one publication"), {
        code: "TERMINAL_RESULT_MULTIPLE_PUBLICATIONS",
      });
    }
    if (expectedResultPath && file !== expectedResultPath) {
      throw Object.assign(new Error("terminal result producer targeted an unexpected file"), {
        code: "TERMINAL_RESULT_PATH_INVALID",
      });
    }
    deferred = { file, value: canonicalTerminalResult(value) };
    return true;
  });
  if (!deferred) {
    throw Object.assign(new Error("terminal result producer did not provide a result"), {
      code: "TERMINAL_RESULT_MISSING",
    });
  }

  const captured = deferred as DeferredTerminalResult;
  let cleanupProof: ManagedWorktreeCleanupProof | null = null;
  const successfulTerminal = ["completed", "cancelled"].includes(String(captured.value.status || ""));
  if (beforePublish) await beforePublish(captured.value);
  if (successfulTerminal && binding) {
    const retain = shouldRetainWorkerWorktree(env);
    const produceProof = retain ? retainWorktree : cleanupWorktree;
    if (!produceProof) {
      throw Object.assign(new Error(`terminal result requires verified managed worktree ${retain ? "retention" : "cleanup"} evidence`), {
        code: "WORKTREE_CLEANUP_REQUIRED",
        committed: false,
      });
    }
    cleanupProof = parseManagedWorktreeDispositionProof(await produceProof(), binding);
    if (
      (retain && cleanupProof.disposition !== "retained")
      || (!retain && cleanupProof.disposition !== "quarantined")
    ) {
      throw Object.assign(new Error("managed worktree disposition does not match terminal policy"), {
        code: "WORKTREE_CLEANUP_PROOF_INVALID",
        committed: false,
      });
    }
    captured.value.cleanup = {
      ...recordValue(captured.value.cleanup),
      worktree: cleanupProof,
    };
  } else if (successfulTerminal && (cleanupWorktree || retainWorktree)) {
    throw Object.assign(new Error("terminal worktree disposition cannot be accepted without its create-time binding"), {
      code: "WORKTREE_CLEANUP_PROOF_INVALID",
      committed: false,
    });
  }
  let publication;
  try {
    if (beforePublish) await beforePublish(captured.value);
    publication = await writeTerminalResultOnceVerified({
      file: captured.file,
      value: captured.value,
      writeResult,
    });
  } catch (cause) {
    if (cleanupProof?.disposition === "quarantined") {
      throw await terminalPublicationCleanupError(cause, cleanupProof);
    }
    throw cause;
  }
  return { produced, cleanupProof, attemptResult: publication.value, publication };
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

export async function main({
  startCodeGraphRuntime = startWorktreeCodeGraphRuntime,
}: {
  startCodeGraphRuntime?: typeof startWorktreeCodeGraphRuntime;
} = {}) {
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
  const workerProcessIdentity = captureProcessIdentity(process.pid, { strict: true });
  if (!workerProcessIdentity) {
    throw Object.assign(new Error("managed worker could not capture its exact process identity"), {
      code: "PROCESS_IDENTITY_UNAVAILABLE",
    });
  }
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
    processIdentity: workerProcessIdentity,
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

  let watcher: ReturnType<typeof chokidar.watch> | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let idleCheckTimer: NodeJS.Timeout | null = null;
  let shuttingDown = false;
  const activeCodeGraphRuntimes = new Set<WorktreeCodeGraphRuntime>();
  const startingCodeGraphProcessIdentities = new Map<number, ProcessIdentity>();

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

  async function releaseWorkerAcpAttempt({
    worktreePath,
    projectId,
    jobId,
    jobLog = log,
  }: {
    worktreePath: string | null | undefined;
    projectId: string;
    jobId: string;
    jobLog?: ReturnType<typeof createLogger>;
  }) {
    if (!worktreePath && (!projectId || !jobId)) return true;
    try {
      const releasedJob = projectId && jobId
        ? await releaseManagedAcpJob({ cpbRoot, hubRoot, projectId, jobId })
        : false;
      const releasedWorktree = worktreePath
        ? await releaseManagedAcpWorktree({
            cpbRoot,
            hubRoot,
            cwd: worktreePath,
            closeProvider: true,
          })
        : false;
      if (releasedJob || releasedWorktree) jobLog.info("ACP attempt sessions released");
      return true;
    } catch (err: unknown) {
      jobLog.warn(`ACP attempt session release failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
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
      const metadata = assignment.metadata || {};
      const finalizerRecovery = recordValue(metadata.finalizerRecovery);
      const finalizerOnly = finalizerRecovery.schema === FINALIZER_RECOVERY_SCHEMA
        && finalizerRecovery.required === true;
      const worktreeRequired = !finalizerOnly && assignment.workflow !== "blocked";
      const executionBoundary = finalizerOnly
        ? "finalizer-only"
        : worktreeRequired
          ? "worktree"
          : "none";
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
        workerIncarnation: workerIncarnationToken,
        processIdentity: {
          pid: workerProcessIdentity.pid,
          startTimeTicks: workerProcessIdentity.birthId,
          birthIdPrecision: workerProcessIdentity.birthIdPrecision,
        },
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
        const safeCancel = redactedWorkerRecord(cancel);
        const reason = redactedWorkerErrorMessage(cancel?.reason || "assignment cancelled", "assignment cancelled");
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
                requestedAt: safeCancel.requestedAt || null,
                requestedBy: safeCancel.requestedBy || null,
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
      const assertFinalizerMutationLease = createFinalizerMutationLeaseGuard({
        assignmentStore,
        workerStore,
        assignmentId,
        inboxAssignmentId,
        attempt: attemptNum,
        attemptToken: assignment.attemptToken,
        orchestratorEpoch: assignment.orchestratorEpoch,
        workerId,
        workerIncarnation: workerIncarnationToken,
        claimToken: claim.claimToken,
        assertExecutionLeaseHeld,
        pollCancel,
        cancelRequested: () => cancelRequested,
        loseExecutionLease,
      });
      const verifiedPriorFinalizerAttempt = finalizerOnly
        ? await verifyFinalizerRecoveryPriorAttempt({
            assignmentStore,
            assignmentId,
            entryId: assignment.entryId,
            recovery: finalizerRecovery,
          })
        : null;
      if (finalizerOnly && !verifiedPriorFinalizerAttempt) {
        throw Object.assign(new Error("finalizer recovery prior-attempt proof is not authoritative"), {
          code: "FINALIZER_RECOVERY_PROOF_INVALID",
        });
      }
      const finalizerMutationFence = buildFinalizerMutationFence({
        assignmentId,
        entryId: assignment.entryId,
        attemptToken: assignment.attemptToken,
        orchestratorEpoch: assignment.orchestratorEpoch,
        workerId,
        workerIncarnation: workerIncarnationToken,
        processIdentity: workerProcessIdentity,
        finalizerRecovery: finalizerOnly ? finalizerRecovery : null,
        verifiedPriorAttempt: verifiedPriorFinalizerAttempt,
      });

      // Create worktree for isolation. Managed pipeline execution must never
      // fall back to the source checkout.
      let worktreeInfo: WorktreeInfo | null = null;
      let codegraphRuntime: WorktreeCodeGraphRuntime | null = null;
      let terminalAttemptResult: LooseRecord | null = null;
      let inboxAcked = false;
      let terminalSyncFailed = false;
      let terminalSyncOwnershipLost = false;
      let acpAttemptReleaseComplete = false;
      let mutationOwnershipLost = false;
      let pendingFailure: {
        kind: string;
        reason: string;
        retryable: boolean;
        status?: "failed" | "blocked" | "cancelled";
        evidence?: LooseRecord;
        finalizeResult?: LooseRecord;
      } | null = null;
      let codegraphCleanupComplete = true;
      let codegraphCleanupProof: AssignmentCodeGraphCleanupProof | null = null;
      let worktreeCleanupProof: ManagedWorktreeCleanupProof | null = null;

      async function stopAssignmentCodeGraphRuntime({
        failOnError,
        context,
      }: {
        failOnError: boolean;
        context: "before_terminal_publication" | "assignment_cleanup";
      }) {
        if (!codegraphRuntime) return { ok: true, proof: codegraphCleanupProof };
        const runtime = codegraphRuntime;
        let lastError: unknown = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const runtimeProof = await runtime.stop();
            const proof: AssignmentCodeGraphCleanupProof = {
              generator: CODEGRAPH_CLEANUP_PROOF_GENERATOR,
              assignmentId,
              attempt: attemptNum,
              attemptToken: assignment.attemptToken,
              ...(assignment.orchestratorEpoch !== undefined ? { orchestratorEpoch: assignment.orchestratorEpoch } : {}),
              entryId: assignment.entryId,
              projectId: assignment.projectId,
              jobId,
              workerId,
              context,
              cleanupAttempt: attempt,
              ok: runtimeProof.ok,
              cleanupVerified: runtimeProof.cleanupVerified,
              processTreeStopped: runtimeProof.processTreeStopped,
              stateRemoved: runtimeProof.stateRemoved,
              statePath: runtimeProof.statePath,
              worktreePath: runtimeProof.worktreePath,
              startup: {
                ok: runtimeProof.startup.ok,
                source: runtimeProof.startup.source,
                pid: runtimeProof.startup.pid,
                processPid: runtimeProof.startup.processPid,
                statePath: runtimeProof.startup.statePath,
                startedAt: runtimeProof.startup.startedAt,
                readyAt: runtimeProof.startup.readyAt,
              },
              startupSource: runtimeProof.startupSource,
              pid: runtimeProof.pid,
              processPid: runtimeProof.processPid,
              cleanupStartedAt: runtimeProof.cleanupStartedAt,
              cleanupCompletedAt: runtimeProof.cleanupCompletedAt,
            };
            codegraphCleanupProof = proof;
            activeCodeGraphRuntimes.delete(runtime);
            if (codegraphRuntime === runtime) codegraphRuntime = null;
            return { ok: true, proof };
          } catch (err: unknown) {
            lastError = err;
            if (attempt === 1) {
              jobLog.warn(`CodeGraph cleanup attempt failed; retrying: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }

        const message = lastError instanceof Error ? lastError.message : String(lastError);
        const prefix = context === "before_terminal_publication"
          ? "CodeGraph cleanup failed before terminal publication"
          : "CodeGraph cleanup failed during assignment cleanup";
        const error = Object.assign(new Error(`${prefix} after retry: ${message}`), {
          code: "codegraph_cleanup_failed",
        });
        if (failOnError) throw error;
        jobLog.warn(error.message);
        return { ok: false, proof: null };
      }

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
          const durableManagedWorktree = managedWorktreeContext(worktreeInfo);
          jobLog.info(`worktree created: ${worktreeInfo.branch} at ${worktreeInfo.path}`);
          await writeAssignmentHeartbeat({
            phase: "worktree",
            activePhase: null,
            worktreePath: worktreeInfo.path,
            worktreeBranch: worktreeInfo.branch,
            managedWorktree: durableManagedWorktree,
            worktreeVerification: worktreeInfo.verification,
            progressKind: "worktree_created",
            lastProgressType: "worktree_created",
          }, { progress: true });
          await writeJsonAtomic(path.join(attemptDir, "worktree.json"), {
            assignmentId,
            attempt: attemptNum,
            attemptToken: assignment.attemptToken,
            executionBoundary,
            sourcePath: assignment.sourcePath,
            worktreePath: worktreeInfo.path,
            worktreeBranch: worktreeInfo.branch,
            managedWorktree: durableManagedWorktree,
            worktreeVerification: worktreeInfo.verification,
            createdAt: new Date().toISOString(),
          });
          await writeAssignmentHeartbeat({
            phase: "codegraph",
            activePhase: null,
            progressKind: "codegraph_initializing",
            lastProgressType: "codegraph_initializing",
          }, { progress: true });
          let startingCodeGraphProcessPid: number | null = null;
          try {
            codegraphRuntime = await startCodeGraphRuntime(worktreeInfo.path, {
              log: jobLog,
              onSpawn: (pid, identity) => {
                startingCodeGraphProcessPid = pid;
                startingCodeGraphProcessIdentities.set(pid, identity);
              },
            });
          } finally {
            if (startingCodeGraphProcessPid) startingCodeGraphProcessIdentities.delete(startingCodeGraphProcessPid);
          }
          if (codegraphRuntime) {
            activeCodeGraphRuntimes.add(codegraphRuntime);
            await writeAssignmentHeartbeat({
              phase: "codegraph",
              activePhase: null,
              progressKind: "codegraph_initialized",
              lastProgressType: "codegraph_initialized",
              codegraph: codegraphRuntime.evidence,
            }, { progress: true });
          }
        } else {
          jobLog.info(finalizerOnly
            ? "finalizer-only recovery: skipping worktree creation and job execution"
            : "blocked workflow: skipping worktree creation");
          await writeAssignmentHeartbeat({
            phase: finalizerOnly ? "finalizer_recovery" : "workflow",
            activePhase: null,
            activeJobId: finalizerOnly ? jobId : null,
            progressKind: finalizerOnly ? "finalizer_recovery_started" : "worktree_skipped",
            lastProgressType: finalizerOnly ? "finalizer_recovery_started" : "worktree_skipped",
          }, { progress: true });
        }

        await pollCancel();
        assertExecutionLeaseHeld();
        let result: JobResult;
        if (finalizerOnly) {
          result = cancelRequested
            ? buildCancelledResult(cancelRequested, "finalize")
            : {
                status: "completed",
                jobId,
                finalizerRecovery: {
                  mode: "finalizer-only",
                  generation: finalizerRecovery.generation || null,
                  allowMutation: finalizerRecovery.allowMutation === true,
                },
              };
        } else {
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
            managedWorktree: worktreeInfo ? managedWorktreeContext(worktreeInfo) : undefined,
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
              jobLog.warn(`cancelled job settled after cancellation: ${redactedWorkerErrorMessage(err)}`);
            }
          });
          result = cancelRequested
            ? buildCancelledResult(cancelRequested)
            : await Promise.race([jobPromise, cancelPromise, executionLeaseLossPromise]);
        }

        assertExecutionLeaseHeld();
        await assignmentStore.assertActiveAttemptIdentity(assignmentId, attemptNum, {
          assignmentId,
          attempt: attemptNum,
          attemptToken: assignment.attemptToken,
          orchestratorEpoch: assignment.orchestratorEpoch,
        });
        acpAttemptReleaseComplete = await releaseWorkerAcpAttempt({
          worktreePath: worktreeInfo?.path,
          projectId: assignment.projectId,
          jobId,
          jobLog,
        });
        if (!acpAttemptReleaseComplete) {
          throw new Error("ACP attempt session release failed before result publication");
        }
        const codegraphCleanup = await stopAssignmentCodeGraphRuntime({
          failOnError: true,
          context: "before_terminal_publication",
        });
        codegraphCleanupProof = codegraphCleanup.proof;
        const terminalPublication = await publishTerminalResultAfterWorktreeCleanup({
          produceResult: async (capture) => {
            const captureWithCleanup = async (file: string, value: unknown) => {
              const persisted = { ...recordValue(value) };
              if (persisted.status === "completed" && codegraphCleanupProof) {
                persisted.cleanup = {
                  ...recordValue(persisted.cleanup),
                  codegraph: codegraphCleanupProof,
                };
              }
              return await capture(file, persisted);
            };
            if (finalizerOnly && result.status === "completed") {
              const runtimeServices = await import("../../bridges/runtime-services.js") as unknown as LooseRecord;
              const recoverFinalizerOnly = runtimeServices.recoverFinalizerOnly;
              if (typeof recoverFinalizerOnly !== "function") {
                throw Object.assign(new Error("finalizer-only recovery service is unavailable"), {
                  code: "FINALIZER_RECOVERY_UNAVAILABLE",
                });
              }
              return await recoverAndWriteFinalizerOnlyResult({
                cpbRoot,
                hubRoot,
                assignment,
                attemptDir,
                assignmentId,
                attemptNum,
                jobId,
                result,
                worktreeInfo: null,
                log: jobLog,
                recoverFinalizerOnly: recoverFinalizerOnly as (options: LooseRecord) => Promise<unknown>,
                assertMutationLease: assertFinalizerMutationLease,
                mutationFence: finalizerMutationFence,
                verifiedPriorAttempt: verifiedPriorFinalizerAttempt,
                writeResult: captureWithCleanup,
              });
            }
            return await finalizeAndWriteSuccessfulResult({
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
              assertMutationLease: assertFinalizerMutationLease,
              mutationFence: finalizerMutationFence,
              writeResult: captureWithCleanup,
            });
          },
          managedWorktree: worktreeInfo,
          cleanupWorktree: worktreeInfo && assignment.sourcePath
            ? async () => await cleanupManagedWorkerWorktree({
                hubRoot,
                sourcePath: assignment.sourcePath,
                entryId: assignment.entryId,
                managedWorktree: worktreeInfo!,
              })
            : null,
          retainWorktree: worktreeInfo && assignment.sourcePath
            ? async () => await verifyRetainedManagedWorkerWorktree({
                hubRoot,
                sourcePath: assignment.sourcePath,
                entryId: assignment.entryId,
                managedWorktree: worktreeInfo!,
              })
            : null,
          expectedResultPath: path.join(attemptDir, "result.json"),
          beforePublish: async (attemptResult) => {
            const finalizeResult = recordValue(attemptResult.finalizeResult);
            const remoteIntent = recordValue(finalizeResult.remoteIntent);
            const sourceContext = recordValue(assignment.sourceContext);
            const metadataCapability = recordValue(metadata.remoteCapability);
            const sourceCapability = recordValue(sourceContext.remoteCapability);
            await assertFinalizerMutationLease({
              operation: "result.publish",
              phase: "before-write",
              mode: String(finalizeResult.mode || metadata.finalizeMode || metadata.finalizerMode || "dry-run"),
              project: assignment.projectId,
              entryId: assignment.entryId,
              jobId: String(finalizeResult.jobId || jobId),
              finalizationId: typeof remoteIntent.finalizationId === "string"
                ? remoteIntent.finalizationId
                : typeof finalizeResult.finalizationId === "string"
                  ? finalizeResult.finalizationId
                  : null,
              generation: Number.isSafeInteger(remoteIntent.generation)
                ? Number(remoteIntent.generation)
                : Number.isSafeInteger(finalizeResult.generation)
                  ? Number(finalizeResult.generation)
                  : null,
              repository: String(
                metadataCapability.repository
                || sourceCapability.repository
                || metadata.repo
                || metadata.repository
                || sourceContext.repo
                || sourceContext.repository
                || "",
              ) || null,
              issueNumber: typeof metadataCapability.issueNumber === "string"
                || typeof metadataCapability.issueNumber === "number"
                ? metadataCapability.issueNumber
                : typeof sourceCapability.issueNumber === "string"
                    || typeof sourceCapability.issueNumber === "number"
                  ? sourceCapability.issueNumber
                  : typeof metadata.issueNumber === "string" || typeof metadata.issueNumber === "number"
                    ? metadata.issueNumber
                    : typeof sourceContext.issueNumber === "string" || typeof sourceContext.issueNumber === "number"
                      ? sourceContext.issueNumber
                      : null,
              commit: typeof finalizeResult.commit === "string" ? finalizeResult.commit : null,
              tree: typeof finalizeResult.tree === "string" ? finalizeResult.tree : null,
            });
          },
        });
        worktreeCleanupProof = terminalPublication.cleanupProof as ManagedWorktreeCleanupProof | null;
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
        terminalSyncFailed = completion.terminalSyncFailed;
        terminalSyncOwnershipLost = completion.mutationOwnershipLost;
        clearInterval(assignmentHeartbeat);
        clearInterval(cancelTimer);
      } catch (err: unknown) {
        const errObj = err instanceof Error ? err as Error & LooseRecord : { message: String(err) } as Error & LooseRecord;
        const safeErrorMessage = redactedWorkerErrorMessage(errObj);
        const finalizerEvidence = finalizerFailureEvidenceFromError(errObj);
        const finalizerMutationAmbiguous = Boolean(finalizerEvidence) && (
          finalizerEvidence?.committed !== false
          || Object.keys(recordValue(finalizerEvidence?.remoteIntent)).length > 0
          || Object.keys(recordValue(finalizerEvidence?.remoteWrites)).length > 0
        );
        const isPoolExhausted = errObj.code === "POOL_EXHAUSTED" || errObj.name === "PoolExhaustedError";
        const isWorktreeUnavailable = errObj.code === "WORKTREE_UNAVAILABLE"
          || errObj.code === "WORKTREE_CLEANUP_DEFERRED";
        const isExecutionLeaseLost = errObj.code === "WORKER_EXECUTION_LEASE_LOST";
        const isMutationLeaseLost = errObj.code === "MUTATION_LEASE_LOST"
          || errObj.code === "STALE_ATTEMPT"
          || errObj.code === "STALE_INBOX_CLAIM";
        const isCancelled = errObj.code === "ASSIGNMENT_CANCELLED" || Boolean(cancelRequested);
        mutationOwnershipLost = isExecutionLeaseLost || isMutationLeaseLost;
        const cleanupEvidence = worktreeCleanupFailureEvidence(errObj);
        const failureKind = isPoolExhausted
          ? "pool_exhausted"
          : isWorktreeUnavailable
            ? "worktree_unavailable"
            : isExecutionLeaseLost || isMutationLeaseLost || isCancelled
              ? FailureKind.RUNTIME_INTERRUPTED
              : FailureKind.WORKER_CRASHED;
        jobLog.error(`job failed (${failureKind}): ${safeErrorMessage}`);
        if (isPoolExhausted) {
          try {
            await poolExhaustedJob(cpbRoot, assignment.projectId, jobId, {
              reason: safeErrorMessage,
              providerKey: errObj.providerKey,
              agent: errObj.agent,
              elapsedMs: errObj.elapsedMs,
              ts: new Date().toISOString(),
            });
          } catch {}
        }
        if (!acpAttemptReleaseComplete) {
          acpAttemptReleaseComplete = await releaseWorkerAcpAttempt({
            worktreePath: worktreeInfo?.path,
            projectId: assignment.projectId,
            jobId,
            jobLog,
          });
        }
        if (!acpAttemptReleaseComplete) {
          throw new Error(`ACP attempt session release failed before failure publication: ${safeErrorMessage}`);
        }
        if (!mutationOwnershipLost) {
          pendingFailure = {
            kind: failureKind,
            reason: isCancelled
              ? buildCancelledResult(cancelRequested).failure?.reason as string || safeErrorMessage
              : safeErrorMessage,
            retryable: finalizerMutationAmbiguous
              ? true
              : isCancelled
                ? false
                : cleanupEvidence
                  ? false
                  : true,
            ...(finalizerMutationAmbiguous
              ? { status: "blocked" as const }
              : isCancelled
                ? { status: "cancelled" as const }
                : {}),
            ...((cleanupEvidence || finalizerEvidence)
              ? {
                  evidence: {
                    ...(cleanupEvidence ? { worktreeCleanup: cleanupEvidence } : {}),
                    ...(finalizerEvidence ? { finalizer: finalizerEvidence } : {}),
                  },
                }
              : {}),
            ...(finalizerEvidence ? { finalizeResult: finalizerEvidence } : {}),
          };
        }
      } finally {
        const codegraphCleanup = await stopAssignmentCodeGraphRuntime({
          failOnError: false,
          context: "assignment_cleanup",
        });
        codegraphCleanupComplete = codegraphCleanup.ok;
        if (codegraphCleanup.proof) codegraphCleanupProof = codegraphCleanup.proof;
        if (!acpAttemptReleaseComplete) {
          acpAttemptReleaseComplete = await releaseWorkerAcpAttempt({
            worktreePath: worktreeInfo?.path,
            projectId: assignment.projectId,
            jobId,
            jobLog,
          });
        }
        const failedWorktreeCleanup = recordValue(pendingFailure?.evidence?.worktreeCleanup);
        if (worktreeInfo && worktreeCleanupProof?.disposition === "quarantined") {
          jobLog.info(`worker worktree isolated with recovery evidence: ${worktreeCleanupProof.quarantinePath}`);
        } else if (worktreeInfo && worktreeCleanupProof?.disposition === "retained") {
          jobLog.info(`worker worktree retention verified by terminal policy: ${worktreeInfo.path}`);
        } else if (
          worktreeInfo
          && typeof failedWorktreeCleanup.committedPath === "string"
        ) {
          jobLog.info(`worker worktree cleanup failed after isolation; recovery evidence retained: ${failedWorktreeCleanup.committedPath}`);
        } else if (worktreeInfo) {
          const status = terminalAttemptResult?.status || "uncommitted";
          jobLog.info(`retaining worker worktree for recovery (status=${status}): ${worktreeInfo.path}`);
        }
      }

      if (mutationOwnershipLost) {
        clearInterval(assignmentHeartbeat);
        clearInterval(cancelTimer);
        jobLog.warn("mutation ownership lost; retaining recovery state without publishing a stale terminal result");
        await shutdown("mutation_lease_lost");
        return;
      }

      if (terminalSyncFailed) {
        clearInterval(assignmentHeartbeat);
        clearInterval(cancelTimer);
        jobLog.warn(terminalSyncOwnershipLost
          ? "terminal result publication lost its ownership fence; the uncommitted file will not be reconciled as authoritative"
          : "terminal result was written but durable assignment sync failed; retaining claim and exiting for recovery");
        await shutdown(terminalSyncOwnershipLost ? "mutation_lease_lost" : "terminal_sync_failed");
        return;
      }

      if (pendingFailure) {
        if (!codegraphCleanupComplete) {
          clearInterval(assignmentHeartbeat);
          clearInterval(cancelTimer);
          await writeAssignmentHeartbeat({
            status: "cleanup_failed",
            phase: "codegraph_cleanup",
            activePhase: null,
            progressKind: "codegraph_cleanup_failed",
            lastProgressType: "codegraph_cleanup_failed",
          }, { progress: true }).catch(() => {});
          jobLog.error("CodeGraph cleanup remained failed after retry; retaining assignment ownership and exiting worker for recovery");
          await shutdown("codegraph_cleanup_failed");
          return;
        }

        if (pendingFailure.evidence?.worktreeCleanup) {
          await writeAssignmentHeartbeat({
            status: "cleanup_failed",
            phase: "worktree_cleanup",
            activePhase: null,
            progressKind: "worktree_cleanup_failed",
            lastProgressType: "worktree_cleanup_failed",
            cleanupFailure: pendingFailure.evidence.worktreeCleanup,
          }, { progress: true }).catch(() => {});
        }

        try {
          await assertFinalizerMutationLease({
            operation: "result.publish",
            phase: "before-write",
            mode: "not-required",
            project: assignment.projectId,
            entryId: assignment.entryId,
            jobId,
            finalizationId: null,
            generation: null,
            repository: null,
            issueNumber: null,
            commit: null,
            tree: null,
          });
          await writeTerminalResultOnceVerified({
            file: path.join(attemptDir, "result.json"),
            value: {
              assignmentId,
              attempt: attemptNum,
              attemptToken: assignment.attemptToken,
              ...(assignment.orchestratorEpoch !== undefined ? { orchestratorEpoch: assignment.orchestratorEpoch } : {}),
              status: pendingFailure.status || "failed",
              jobResult: {
                status: pendingFailure.status || "failed",
                failure: {
                  kind: pendingFailure.kind,
                  reason: pendingFailure.reason,
                  retryable: pendingFailure.retryable,
                  ...(pendingFailure.evidence ? { cause: pendingFailure.evidence } : {}),
                },
              },
              ...(pendingFailure.finalizeResult
                ? {
                    finalizeResult: pendingFailure.finalizeResult,
                    finalization: {
                      required: true,
                      ok: false,
                      status: pendingFailure.finalizeResult.status || pendingFailure.status || "blocked",
                      code: pendingFailure.finalizeResult.code || null,
                    },
                    recovery: worktreeInfo?.path
                      ? {
                          retainWorktree: true,
                          worktreePath: worktreeInfo.path,
                          worktreeBranch: worktreeInfo.branch || null,
                          reason: "finalization_recovery_required",
                        }
                      : null,
                  }
                : {}),
              writtenAt: new Date().toISOString(),
            },
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
          terminalSyncFailed = completion.terminalSyncFailed;
          terminalSyncOwnershipLost = completion.mutationOwnershipLost;
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error
            ? String(error.code || "")
            : "";
          if (["MUTATION_LEASE_LOST", "WORKER_EXECUTION_LEASE_LOST", "STALE_ATTEMPT", "STALE_INBOX_CLAIM"].includes(code)) {
            clearInterval(assignmentHeartbeat);
            clearInterval(cancelTimer);
            jobLog.warn("mutation ownership changed before failure publication; no stale result was written");
            await shutdown("mutation_lease_lost");
            return;
          }
          throw error;
        } finally {
          clearInterval(assignmentHeartbeat);
          clearInterval(cancelTimer);
        }
      }

      if (terminalSyncFailed) {
        clearInterval(assignmentHeartbeat);
        clearInterval(cancelTimer);
        jobLog.warn(terminalSyncOwnershipLost
          ? "failure result publication lost its ownership fence; the uncommitted file will not be reconciled as authoritative"
          : "failure result was written but durable assignment sync failed; retaining claim and exiting for recovery");
        await shutdown(terminalSyncOwnershipLost ? "mutation_lease_lost" : "terminal_sync_failed");
        return;
      }

      clearInterval(assignmentHeartbeat);
      clearInterval(cancelTimer);

      // Remove inbox entry (now in processing dir)
      if (shouldCompleteInboxClaimAfterTerminalSync({
        inboxAcked,
        terminalSyncFailed,
      })) {
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

  if (once) {
    await processInboxGuarded();
    await shutdown("once");
    return;
  }

  // Watch inbox with chokidar
  watcher = chokidar.watch(path.join(inboxDir, "*.json"), {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 100 },
    usePolling: true,
    interval: CANCEL_POLL_MS,
    binaryInterval: CANCEL_POLL_MS,
  });

  watcher.on("add", async () => {
    try { await processInboxGuarded(); } catch (err: unknown) {
      log.error(`process error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  watcher.on("error", (err: unknown) => {
    log.warn(`inbox watcher error: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Do not wait for the watcher implementation or the 5s fallback poll to
  // discover work that already existed before startup.
  void processInboxGuarded().catch((err: unknown) => {
    log.error(`initial inbox process error: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Fallback poll
  pollTimer = setInterval(async () => {
    try {
      await processInboxGuarded();
      await exitIdleWorkerIfRequested();
    } catch { /* ignore */ }
  }, POLL_MS);

  idleCheckTimer = shouldExitWorkerOnIdle()
    ? setInterval(async () => {
        try { await exitIdleWorkerIfRequested(); } catch { /* ignore */ }
      }, Math.max(50, Math.min(POLL_MS, workerIdleExitMs() || 50)))
    : null;
  idleCheckTimer?.unref();
  void exitIdleWorkerIfRequested().catch(() => {});

  async function retryCodeGraphShutdownCleanup(label: string, cleanup: () => Promise<unknown>) {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await cleanup();
        return null;
      } catch (error: unknown) {
        lastError = error;
        if (attempt === 1) {
          log.warn(`CodeGraph shutdown cleanup failed for ${label}; retrying: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return lastError;
  }

  async function cleanupCodeGraphBeforeShutdown(signal: string) {
    const failures: string[] = [];
    for (const [pid, identity] of [...startingCodeGraphProcessIdentities]) {
      const error = await retryCodeGraphShutdownCleanup(`starting pid ${pid}`, () => cleanupStartingCodeGraphProcess(pid, identity));
      if (error) {
        failures.push(`starting pid ${pid}: ${error instanceof Error ? error.message : String(error)}`);
      } else {
        startingCodeGraphProcessIdentities.delete(pid);
      }
    }
    for (const runtime of [...activeCodeGraphRuntimes]) {
      const error = await retryCodeGraphShutdownCleanup(`runtime pid ${runtime.pid}`, () => runtime.stop());
      if (error) {
        failures.push(`runtime pid ${runtime.pid}: ${error instanceof Error ? error.message : String(error)}`);
      } else {
        activeCodeGraphRuntimes.delete(runtime);
      }
    }
    if (failures.length === 0) return true;
    const reason = failures.join("; ");
    log.error(`CodeGraph cleanup failed during shutdown (${signal}): ${reason}`);
    await workerStore.updateWorkerIf(workerId, {
      status: "cleanup_failed",
      exitSignal: "codegraph_cleanup_failed",
      cleanupFailureReason: reason,
    }, {
      incarnationToken: workerIncarnationToken,
    }).catch(() => {});
    return false;
  }

  // Graceful shutdown
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeatTimer);
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (idleCheckTimer) {
      clearInterval(idleCheckTimer);
      idleCheckTimer = null;
    }
    if (watcher) await closeWatcherBounded(watcher, log);
    watcher = null;
    const codegraphClean = await cleanupCodeGraphBeforeShutdown(signal);
    await stopWorkerAcpPool();
    if (!codegraphClean) {
      process.exit(1);
    }

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
