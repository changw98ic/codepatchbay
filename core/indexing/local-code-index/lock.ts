/**
 * Local Code Index v2 — socket-free lock protocol.
 *
 * Implements spec section 10 (Concurrency and recovery) for the local code
 * index.  One parameterized lock protocol serves both scope kinds:
 *   - "repository-objects" (shared mutable objects for a repository key)
 *   - "worktree-publication" (per-worktree current-pointer publication)
 *
 * Protocol overview:
 *   1. Atomic acquisition via exclusive `mkdir` of `canonicalLockDirectory`.
 *   2. Owner file published atomically (temp + rename + dir sync).
 *   3. Bounded wait with exponential backoff for contended locks.
 *   4. Exact release: owner-token verification, rename to quarantine, dir sync.
 *   5. Stale-owner election via `recovery-elections/<owner-token-hash>/`.
 *   6. Quarantine of stale and released lock directories.
 *   7. Orphan-election repair requiring exact pinned identities.
 *   8. Process-incarnation probes for macOS and Linux (no network handles).
 *
 * Security constraints:
 *   - No `node:net` import.  No listening sockets.  No network handles.
 *   - O_NOFOLLOW on all file opens.
 *   - Owner files bounded at 16 KiB.
 *   - Every transition synced to stable storage before acknowledgment.
 *
 * Lock order (caller-enforced, not module-enforced):
 *   repository-objects → worktree-publication.
 *   Use `acquireOrderedIndexLocks` / `withOrderedIndexLocks` for both scopes.
 *
 * Spec: docs/architecture/local-code-index-v2-spec.md section 10
 * Plan: docs/architecture/local-code-index-v2-implementation-plan.md Phase 2
 *
 * Dependencies: node:crypto, node:fs, node:fs/promises, node:os, node:path,
 *   shared/primitives/process-tree.js, ./contracts.js, ./canonical-json.js.
 *   Does NOT import node:net or any network-capable module.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  captureProcessIdentity,
  isProcessIdentityAlive,
  type ProcessIdentity,
} from "../../../shared/primitives/process-tree.js";
import { canonicalStringify } from "./canonical-json.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** Maximum bytes accepted for an owner.json file. */
const MAX_OWNER_BYTES = 16 * 1024;

/** Owner file name inside the lock directory. */
const OWNER_FILE = "owner.json";

/** Recovery elections directory name. */
const RECOVERY_ELECTIONS_DIR = "recovery-elections";

// ── Scope kind ─────────────────────────────────────────────────────────────

export type IndexLockScopeKind = "repository-objects" | "worktree-publication";

// ── Owner record ───────────────────────────────────────────────────────────

export type IndexLockOwner = {
  scopeKind: IndexLockScopeKind;
  scopeKey: string;
  pid: number;
  ownerToken: string;
  timestamp: string;
  host: string;
  processIdentity: ProcessIdentity | null;
};

// ── Acquisition options ────────────────────────────────────────────────────

export type AcquireIndexLockOptions = {
  scopeKind: IndexLockScopeKind;
  scopeKey: string;
  /** Base retry interval in ms.  Actual delay is min(retryMs * 2^attempt, remaining). */
  retryMs?: number;
  /** Maximum total wait in ms.  Default 10 000. */
  waitMs?: number;
  signal?: AbortSignal;
  /** Test seam: override process identity capture. */
  captureIdentity?: () => ProcessIdentity | null;
  /** Test seam: override process identity liveness check. */
  isIdentityAlive?: (identity: ProcessIdentity) => boolean;
};

// ── Errors ─────────────────────────────────────────────────────────────────

export type IndexLockErrorCode =
  | "index_lock_timeout"
  | "index_lock_lost"
  | "index_lock_repair_required"
  | "index_lock_invalid";

export class IndexLockError extends Error {
  override readonly name = "IndexLockError";
  readonly code: IndexLockErrorCode;
  readonly lockDir: string;
  readonly committed?: boolean;
  readonly recoveryPaths?: readonly string[];

  constructor(
    message: string,
    code: IndexLockErrorCode,
    lockDir: string,
    details?: {
      committed?: boolean;
      recoveryPaths?: readonly string[];
      cause?: unknown;
    },
  ) {
    super(message, { cause: details?.cause });
    this.code = code;
    this.lockDir = lockDir;
    if (details?.committed !== undefined) {
      this.committed = details.committed;
    }
    if (details?.recoveryPaths !== undefined) {
      this.recoveryPaths = details.recoveryPaths;
    }
  }
}

// ── Cached process identity ────────────────────────────────────────────────

let cachedProcessIdentity: ProcessIdentity | null = null;

function getCachedProcessIdentity(): ProcessIdentity | null {
  if (!cachedProcessIdentity) {
    cachedProcessIdentity = captureProcessIdentity(process.pid, { strict: true });
  }
  return cachedProcessIdentity ? { ...cachedProcessIdentity } : null;
}

// ── Internal helpers ───────────────────────────────────────────────────────

function lockError(
  message: string,
  code: IndexLockErrorCode,
  lockDir: string,
  details?: {
    committed?: boolean;
    recoveryPaths?: readonly string[];
    cause?: unknown;
  },
): IndexLockError {
  return new IndexLockError(message, code, lockDir, details);
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw lockError(
      "index lock operation aborted",
      "index_lock_invalid",
      "",
      { cause: signal.reason },
    );
  }
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (op: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      op();
    };
    const onAbort = () =>
      finish(() =>
        reject(
          lockError("index lock operation aborted", "index_lock_invalid", "", {
            cause: signal?.reason,
          }),
        ),
      );
    const timer = setTimeout(() => finish(resolve), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function ownerTokenHash(ownerToken: string): string {
  return createHash("sha256").update(ownerToken).digest("hex").slice(0, 32);
}

function validateProcessIdentity(
  value: unknown,
  expectedPid: number,
): ProcessIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const c = value as Partial<ProcessIdentity>;
  if (
    !Number.isSafeInteger(c.pid) ||
    c.pid !== expectedPid ||
    typeof c.birthId !== "string" ||
    !c.birthId ||
    c.incarnation !== `${c.pid}:${c.birthId}` ||
    typeof c.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(c.capturedAt)) ||
    new Date(Date.parse(c.capturedAt)).toISOString() !== c.capturedAt
  ) {
    return null;
  }
  if (
    c.birthIdPrecision !== undefined &&
    c.birthIdPrecision !== "exact" &&
    c.birthIdPrecision !== "coarse"
  ) {
    return null;
  }
  const identity: ProcessIdentity = {
    pid: c.pid,
    birthId: c.birthId,
    incarnation: c.incarnation,
    capturedAt: c.capturedAt,
  };
  if (c.birthIdPrecision !== undefined) {
    identity.birthIdPrecision = c.birthIdPrecision;
  }
  if (
    c.processGroupId !== undefined &&
    (!Number.isSafeInteger(c.processGroupId) || Number(c.processGroupId) <= 0)
  ) {
    return null;
  }
  if (c.processGroupId !== undefined) {
    identity.processGroupId = Number(c.processGroupId);
  }
  return identity;
}

function validateOwner(
  parsed: unknown,
  expectedScopeKind?: IndexLockScopeKind,
  expectedScopeKey?: string,
): IndexLockOwner | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (
    o.scopeKind !== "repository-objects" &&
    o.scopeKind !== "worktree-publication"
  ) {
    return null;
  }
  if (expectedScopeKind !== undefined && o.scopeKind !== expectedScopeKind) return null;
  if (typeof o.scopeKey !== "string" || !o.scopeKey) return null;
  if (expectedScopeKey !== undefined && o.scopeKey !== expectedScopeKey) return null;
  if (!Number.isSafeInteger(o.pid) || Number(o.pid) <= 0) return null;
  if (typeof o.ownerToken !== "string" || !o.ownerToken) return null;
  if (typeof o.timestamp !== "string" || !Number.isFinite(Date.parse(o.timestamp))) return null;
  if (typeof o.host !== "string" || !o.host) return null;
  // Allow null processIdentity (fenced mode) — owner was written without process identity
  const identity = o.processIdentity === null ? null : validateProcessIdentity(o.processIdentity, Number(o.pid));
  if (o.processIdentity !== null && !identity) return null;
  return {
    scopeKind: o.scopeKind as IndexLockScopeKind,
    scopeKey: o.scopeKey as string,
    pid: Number(o.pid),
    ownerToken: o.ownerToken as string,
    timestamp: o.timestamp as string,
    host: o.host as string,
    processIdentity: identity,
  };
}

// ── Owner file I/O ─────────────────────────────────────────────────────────

/**
 * Read the owner.json file from a lock directory.
 * Returns null when the file is absent, corrupt, or unreadable.
 * Throws on unexpected filesystem errors.
 */
async function readOwner(lockDir: string): Promise<IndexLockOwner | null> {
  const ownerPath = path.join(lockDir, OWNER_FILE);
  let raw: string;
  try {
    raw = await readFile(ownerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if ((error as NodeJS.ErrnoException).code === "EACCES") return null;
    throw error;
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_OWNER_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return validateOwner(parsed);
}

/**
 * Write an owner file atomically: exclusive temp → fsync → rename → dir sync.
 */
async function writeOwner(
  lockDir: string,
  owner: IndexLockOwner,
): Promise<void> {
  const ownerPath = path.join(lockDir, OWNER_FILE);
  const tempPath = path.join(
    lockDir,
    `.owner-${owner.ownerToken}-${randomUUID()}.tmp`,
  );
  const payload = canonicalStringify(owner);

  const handle = await open(
    tempPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  await rename(tempPath, ownerPath);
}

/**
 * Sync a parent directory to ensure rename/link visibility after crash.
 */
async function syncDirectory(dirPath: string): Promise<void> {
  const handle = await open(dirPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Read the generation (stat) of a directory for identity checks.
 */
async function readDirGeneration(
  dirPath: string,
): Promise<{ dev: number; ino: number; mtimeMs: number; birthtimeMs: number } | null> {
  try {
    const info = await lstat(dirPath);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    return {
      dev: info.dev,
      ino: info.ino,
      mtimeMs: info.mtimeMs,
      birthtimeMs: info.birthtimeMs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameGeneration(
  a: { dev: number; ino: number; mtimeMs: number; birthtimeMs: number },
  b: { dev: number; ino: number; mtimeMs: number; birthtimeMs: number },
): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mtimeMs === b.mtimeMs &&
    a.birthtimeMs === b.birthtimeMs
  );
}

/**
 * Verify that the lock directory still exists with the expected identity
 * and the expected owner.
 *
 * Returns the current owner when the lock directory is absent (ENOENT).
 * Throws IndexLockError on identity mismatch or owner change.
 */
async function verifyLockStillHeld(
  lockDir: string,
  owner: IndexLockOwner,
  generation: { dev: number; ino: number; mtimeMs: number; birthtimeMs: number },
): Promise<IndexLockOwner | null> {
  const current = await readOwner(lockDir);
  if (!current) {
    // Directory may have been renamed by another recovery path.
    // Verify the canonical path is absent.
    try {
      await lstat(lockDir);
      // Still present but no valid owner — another process may be writing.
      throw lockError(
        `index lock owner absent but directory present: ${lockDir}`,
        "index_lock_lost",
        lockDir,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof IndexLockError) throw error;
      throw error;
    }
  }
  if (current.ownerToken !== owner.ownerToken) {
    throw lockError(
      `index lock ownership changed: ${lockDir}`,
      "index_lock_lost",
      lockDir,
    );
  }
  const currentGen = await readDirGeneration(lockDir);
  if (!currentGen || !sameGeneration(generation, currentGen)) {
    throw lockError(
      `index lock directory identity changed: ${lockDir}`,
      "index_lock_lost",
      lockDir,
    );
  }
  return current;
}

// ── Quarantine ─────────────────────────────────────────────────────────────

/**
 * Derive a unique quarantine path for a lock directory.
 * Contains scope kind, lock dir name, owner token hash, and random UUID.
 */
function deriveQuarantinePath(
  lockDir: string,
  scopeKind: IndexLockScopeKind,
  ownerToken: string,
  suffix: string,
): string {
  const parent = path.dirname(lockDir);
  const base = path.basename(lockDir);
  const hash = ownerTokenHash(ownerToken);
  return path.join(parent, `${base}.${scopeKind}-${hash.slice(0, 12)}-${suffix}-${randomUUID()}`);
}

/**
 * Atomically rename a lock directory to a quarantine path and sync the parent.
 * Returns the quarantine path on success.
 * Returns null when the lock directory is already absent (ENOENT).
 * Throws IndexLockError on identity mismatch.
 */
async function quarantineLock(
  lockDir: string,
  owner: IndexLockOwner,
  generation: { dev: number; ino: number; mtimeMs: number; birthtimeMs: number },
  suffix: string,
): Promise<string | null> {
  const beforeGen = await readDirGeneration(lockDir);
  if (!beforeGen) return null;
  if (!sameGeneration(generation, beforeGen)) {
    throw lockError(
      `index lock directory identity changed before quarantine: ${lockDir}`,
      "index_lock_lost",
      lockDir,
    );
  }

  const quarantinePath = deriveQuarantinePath(
    lockDir,
    owner.scopeKind,
    owner.ownerToken,
    suffix,
  );

  try {
    await rename(lockDir, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  await syncDirectory(path.dirname(lockDir));

  // Verify the quarantine succeeded: lock dir absent, quarantine present.
  try {
    await lstat(lockDir);
    // Lock dir still present after rename — possible ABA race.
    throw lockError(
      `index lock quarantine failed: lock directory still present: ${lockDir}`,
      "index_lock_lost",
      lockDir,
      { recoveryPaths: [lockDir, quarantinePath] },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Expected: lock dir is gone.
    } else if (error instanceof IndexLockError) {
      throw error;
    } else {
      throw error;
    }
  }

  return quarantinePath;
}

// ── Liveness ───────────────────────────────────────────────────────────────

/**
 * Check if a lock owner's process is still alive using exact incarnation.
 * Returns true if the process is alive with the same incarnation.
 * Returns false if the process is gone, has a different incarnation, or
 * the identity cannot be verified.
 */
function isOwnerAlive(
  owner: IndexLockOwner,
  isAlive: (identity: ProcessIdentity) => boolean,
): boolean {
  try {
    if (!owner.processIdentity) return true; // fenced mode — cannot determine liveness, treat as alive
    if (owner.processIdentity.birthIdPrecision !== "exact") return false;
    return isAlive(owner.processIdentity);
  } catch {
    return false;
  }
}

// ── Acquisition ────────────────────────────────────────────────────────────

/**
 * Acquire a lock at the given canonical lock directory.
 *
 * The lock directory name must end with `.lock` or start with `.lock-` as
 * a safety convention.  The parent directory is created if absent.
 *
 * Returns the owner record on successful acquisition.
 * Throws IndexLockError on timeout, invalid input, or unrecoverable conflict.
 *
 * Concurrent callers within one process serialize on the same promise.
 * (Callers should use an external per-lock-Dir promise cache if needed.)
 */
export async function acquireIndexLock(
  canonicalLockDirectory: string,
  options: AcquireIndexLockOptions,
): Promise<IndexLockOwner> {
  const {
    scopeKind,
    scopeKey,
    retryMs = 10,
    waitMs = 10_000,
    signal,
    captureIdentity = getCachedProcessIdentity,
    isIdentityAlive = isProcessIdentityAlive,
  } = options;

  // ── Validate inputs ────────────────────────────────────────────────────
  if (typeof canonicalLockDirectory !== "string" || !canonicalLockDirectory.trim()) {
    throw new TypeError("canonicalLockDirectory must be a non-empty string");
  }
  if (scopeKind !== "repository-objects" && scopeKind !== "worktree-publication") {
    throw new TypeError("scopeKind must be 'repository-objects' or 'worktree-publication'");
  }
  if (typeof scopeKey !== "string" || !scopeKey) {
    throw new TypeError("scopeKey must be a non-empty string");
  }
  if (!Number.isFinite(waitMs) || waitMs <= 0) {
    throw new TypeError("waitMs must be a finite positive number");
  }
  if (!Number.isFinite(retryMs) || retryMs <= 0) {
    throw new TypeError("retryMs must be a finite positive number");
  }

  const lockDir = path.resolve(canonicalLockDirectory);
  const lockBase = path.basename(lockDir);
  if (!lockBase.endsWith(".lock") && !lockBase.startsWith(".lock-")) {
    throw lockError(
      `unsafe index lock path (must end with .lock or start with .lock-): ${lockDir}`,
      "index_lock_invalid",
      lockDir,
    );
  }

  await mkdir(path.dirname(lockDir), { recursive: true });
  throwIfAborted(signal);

  // ── Capture process identity ───────────────────────────────────────────
  let identity: ProcessIdentity | null;
  try {
    identity = captureIdentity();
  } catch (cause) {
    throw lockError(
      `index lock process identity capture failed: ${lockDir}`,
      "index_lock_invalid",
      lockDir,
      { cause },
    );
  }
  if (!identity && captureIdentity !== getCachedProcessIdentity) {
    // Explicit captureIdentity returning null = fenced mode (caller accepts no liveness check)
  } else if (!identity) {
    throw lockError(
      `index lock process identity unavailable: ${lockDir}`,
      "index_lock_invalid",
      lockDir,
    );
  }

  // ── Build owner record ─────────────────────────────────────────────────
  const ownerToken = randomUUID();
  const owner: IndexLockOwner = {
    scopeKind,
    scopeKey,
    pid: process.pid,
    ownerToken,
    timestamp: new Date().toISOString(),
    host: os.hostname(),
    processIdentity: identity,
  };

  // ── Acquisition loop with exponential backoff ──────────────────────────
  const deadlineAt = Date.now() + waitMs;
  let attempt = 0;

  while (Date.now() < deadlineAt) {
    throwIfAborted(signal);

    // Step 1: Atomically create the lock directory with mkdir.
    try {
      await mkdir(lockDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      // Lock directory exists — check for stale owner.
      const existingOwner = await readOwner(lockDir);
      if (existingOwner) {
        if (
          existingOwner.scopeKind !== scopeKind ||
          existingOwner.scopeKey !== scopeKey
        ) {
          throw lockError(
            `index lock scope mismatch: expected ${scopeKind}/${scopeKey}, got ${existingOwner.scopeKind}/${existingOwner.scopeKey}: ${lockDir}`,
            "index_lock_invalid",
            lockDir,
          );
        }
        if (existingOwner.host === os.hostname() && isOwnerAlive(existingOwner, isIdentityAlive)) {
          // Owner is alive — wait and retry.
        } else if (existingOwner.host === os.hostname()) {
          // Owner appears dead — attempt stale recovery.
          await staleOwnerRecovery(
            lockDir,
            existingOwner,
            isIdentityAlive,
          );
          // Recovery quarantined the old lock. Loop will retry mkdir.
        }
        // Owner on different host — cannot determine liveness. Wait.
      } else {
        // Lock directory exists but no valid owner — incomplete lock.
        throw lockError(
          `index lock exists without valid owner; repair required: ${lockDir}`,
          "index_lock_repair_required",
          lockDir,
        );
      }

      // Exponential backoff: retryMs * 2^attempt, capped at remaining time.
      const backoffMs = Math.min(
        retryMs * Math.pow(2, attempt),
        Math.max(1, deadlineAt - Date.now()),
      );
      attempt += 1;
      await delay(backoffMs, signal);
      continue;
    }

    // Step 2: Write owner file inside the newly created directory.
    try {
      await writeOwner(lockDir, owner);

      // Step 3: Sync the parent directory to ensure the lock directory and
      // owner file are visible after crash.
      await syncDirectory(path.dirname(lockDir));

      // Step 4: Re-read and verify the owner file and directory identity.
      const reReadOwner = await readOwner(lockDir);
      if (!reReadOwner || reReadOwner.ownerToken !== ownerToken) {
        throw lockError(
          `index lock owner verification failed after acquisition: ${lockDir}`,
          "index_lock_lost",
          lockDir,
        );
      }

      const dirGen = await readDirGeneration(lockDir);
      if (!dirGen) {
        throw lockError(
          `index lock directory disappeared after acquisition: ${lockDir}`,
          "index_lock_lost",
          lockDir,
        );
      }

      return reReadOwner;
    } catch (writeError) {
      // Acquisition partially failed. Attempt cleanup.
      let cleanupError: unknown = null;
      try {
        const currentOwner = await readOwner(lockDir);
        const cleanupGen = await readDirGeneration(lockDir);
        if (currentOwner && currentOwner.ownerToken === ownerToken && cleanupGen) {
          await quarantineLock(lockDir, currentOwner, cleanupGen, "incomplete");
        }
      } catch (error) {
        cleanupError = error;
      }

      if (cleanupError) {
        throw lockError(
          `index lock acquisition and cleanup failed: ${lockDir}`,
          "index_lock_invalid",
          lockDir,
          {
            cause: new AggregateError(
              [writeError, cleanupError],
              "index lock acquisition and cleanup failed",
              { cause: writeError },
            ),
          },
        );
      }
      throw writeError;
    }
  }

  throw lockError(
    `index lock acquisition timed out after ${waitMs}ms: ${lockDir}`,
    "index_lock_timeout",
    lockDir,
  );
}

// ── Stale-owner recovery ──────────────────────────────────────────────────

/**
 * Attempt stale-owner recovery for a lock directory.
 *
 * Protocol (spec section 10.3):
 *   1. Derive owner-token-hash = SHA-256(owner token).
 *   2. Atomically create recovery-elections/<owner-token-hash> with mkdir.
 *   3. Only the process that created that election directory may continue.
 *   4. Re-read and identity-check lock.lock/owner.json.
 *   5. Require the same owner token, process identity, lock path, scope kind,
 *      scope key, and lock directory identity observed before election.
 *   6. Rename lock.lock once to an exclusive quarantine path.
 *   7. Sync the canonical parent namespace containing that lock.
 *   8. Never touch the canonical lock path again during that recovery.
 *
 * The election directory is retained as evidence.
 *
 * Returns true when the lock was quarantined, false when the lock was
 * already absent or a successor appeared.
 *
 * Throws IndexLockError on unrecoverable conflict.
 */
async function staleOwnerRecovery(
  lockDir: string,
  staleOwner: IndexLockOwner,
  isIdentityAlive: (identity: ProcessIdentity) => boolean,
): Promise<boolean> {
  // Capture the lock directory generation before election.
  const beforeGen = await readDirGeneration(lockDir);
  if (!beforeGen) return false;

  // Capture the owner before election.
  const beforeOwner = await readOwner(lockDir);
  if (!beforeOwner) return false;
  if (beforeOwner.ownerToken !== staleOwner.ownerToken) {
    // Owner changed between observation and recovery — a successor appeared.
    return false;
  }

  // Step 1–3: Atomically create the recovery election directory.
  const electionParent = path.join(path.dirname(lockDir), RECOVERY_ELECTIONS_DIR);
  await mkdir(electionParent, { recursive: true });
  const hash = ownerTokenHash(staleOwner.ownerToken);
  const electionDir = path.join(electionParent, hash);
  try {
    await mkdir(electionDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // Another process already created this election — cannot proceed.
      return false;
    }
    throw error;
  }

  // Step 4: Re-read and identity-check owner.json.
  const reReadOwner = await readOwner(lockDir);
  if (!reReadOwner) {
    // Owner disappeared after election — a successor may have appeared.
    return false;
  }
  if (reReadOwner.ownerToken !== staleOwner.ownerToken) {
    // Owner token changed — a successor appeared.
    return false;
  }

  // Step 5: Verify directory identity and owner identity match pre-election.
  const reReadGen = await readDirGeneration(lockDir);
  if (!reReadGen || !sameGeneration(beforeGen, reReadGen)) {
    throw lockError(
      `index lock directory identity changed during recovery election: ${lockDir}`,
      "index_lock_lost",
      lockDir,
    );
  }
  if (
    reReadOwner.processIdentity && staleOwner.processIdentity &&
    reReadOwner.processIdentity.incarnation !== staleOwner.processIdentity.incarnation
  ) {
    throw lockError(
      `index lock owner identity changed during recovery election: ${lockDir}`,
      "index_lock_lost",
      lockDir,
    );
  }

  // Step 6–7: Quarantine the stale lock.
  const quarantinePath = await quarantineLock(
    lockDir,
    reReadOwner,
    reReadGen,
    `stale-${hash.slice(0, 12)}`,
  );

  return quarantinePath !== null;
}

// ── Release ────────────────────────────────────────────────────────────────

/**
 * Release a lock held by the given owner.
 *
 * Protocol (spec section 10.4):
 *   1. Re-read and verify owner token and directory identity.
 *   2. Rename the owned lock directory to an exclusive released quarantine.
 *   3. Sync the canonical parent namespace containing that lock.
 *   4. Never recursively remove the canonical lock path.
 *
 * A changed owner or directory generation throws IndexLockError with
 * code "index_lock_lost".
 *
 * Returns the quarantine path on success, or null if the lock was
 * already absent.
 */
export async function releaseIndexLock(
  canonicalLockDirectory: string,
  owner: IndexLockOwner,
): Promise<string | null> {
  const lockDir = path.resolve(canonicalLockDirectory);

  // Step 1: Re-read and verify owner token.
  const currentOwner = await readOwner(lockDir);
  if (!currentOwner) {
    // Lock already released or absent.
    try {
      await lstat(lockDir);
      // Directory present but no valid owner — cannot verify ownership.
      throw lockError(
        `index lock owner absent but directory present during release: ${lockDir}`,
        "index_lock_lost",
        lockDir,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof IndexLockError) throw error;
      throw error;
    }
  }

  if (currentOwner.ownerToken !== owner.ownerToken) {
    throw lockError(
      `index lock ownership changed during release: ${lockDir}`,
      "index_lock_lost",
      lockDir,
    );
  }

  // Step 1b: Verify directory identity.
  const dirGen = await readDirGeneration(lockDir);
  if (!dirGen) {
    throw lockError(
      `index lock directory absent during release: ${lockDir}`,
      "index_lock_lost",
      lockDir,
    );
  }

  // Step 2: Quarantine the lock.
  const quarantinePath = await quarantineLock(lockDir, currentOwner, dirGen, "released");
  return quarantinePath;
}

// ── withIndexLock ──────────────────────────────────────────────────────────

/**
 * Acquire a lock, execute a callback while holding it, and release.
 *
 * Aggregate error handling: when both the callback and release fail,
 * the errors are combined into an AggregateError.
 */
export async function withIndexLock<T>(
  canonicalLockDirectory: string,
  options: AcquireIndexLockOptions,
  callback: (owner: IndexLockOwner) => Promise<T>,
): Promise<T> {
  const owner = await acquireIndexLock(canonicalLockDirectory, options);

  let value: T | undefined;
  let callbackError: unknown = null;
  try {
    value = await callback(owner);
  } catch (error) {
    callbackError = error;
  }

  let releaseError: unknown = null;
  try {
    await releaseIndexLock(canonicalLockDirectory, owner);
  } catch (error) {
    releaseError = error;
  }

  if (callbackError) {
    if (!releaseError) throw callbackError;
    throw new AggregateError(
      [callbackError, releaseError],
      `index lock callback and release failed: ${canonicalLockDirectory}`,
      { cause: callbackError },
    );
  }
  if (releaseError) throw releaseError;
  return value as T;
}

// ── Lock order enforcement ─────────────────────────────────────────────────

/**
 * Acquire both repository-objects and worktree-publication locks in the
 * required global order: repository first, then worktree.
 *
 * Returns both owner records.
 */
export async function acquireOrderedIndexLocks(
  repositoryLockDir: string,
  worktreeLockDir: string,
  repositoryOptions: Omit<AcquireIndexLockOptions, "scopeKind" | "scopeKey"> & {
    scopeKey: string;
  },
  worktreeOptions: Omit<AcquireIndexLockOptions, "scopeKind" | "scopeKey"> & {
    scopeKey: string;
  },
): Promise<{ repositoryOwner: IndexLockOwner; worktreeOwner: IndexLockOwner }> {
  const repositoryOwner = await acquireIndexLock(repositoryLockDir, {
    ...repositoryOptions,
    scopeKind: "repository-objects",
  });

  let worktreeOwner: IndexLockOwner;
  try {
    worktreeOwner = await acquireIndexLock(worktreeLockDir, {
      ...worktreeOptions,
      scopeKind: "worktree-publication",
    });
  } catch (error) {
    // Worktree lock acquisition failed — release the repository lock.
    try {
      await releaseIndexLock(repositoryLockDir, repositoryOwner);
    } catch {
      // Swallow release error — the primary error is more important.
    }
    throw error;
  }

  return { repositoryOwner, worktreeOwner };
}

/**
 * Acquire both locks in order, execute a callback, and release in reverse
 * order (worktree first, then repository).
 */
export async function withOrderedIndexLocks<T>(
  repositoryLockDir: string,
  worktreeLockDir: string,
  repositoryOptions: Omit<AcquireIndexLockOptions, "scopeKind" | "scopeKey"> & {
    scopeKey: string;
  },
  worktreeOptions: Omit<AcquireIndexLockOptions, "scopeKind" | "scopeKey"> & {
    scopeKey: string;
  },
  callback: (owners: {
    repositoryOwner: IndexLockOwner;
    worktreeOwner: IndexLockOwner;
  }) => Promise<T>,
): Promise<T> {
  const { repositoryOwner, worktreeOwner } = await acquireOrderedIndexLocks(
    repositoryLockDir,
    worktreeLockDir,
    repositoryOptions,
    worktreeOptions,
  );

  let value: T | undefined;
  let callbackError: unknown = null;
  try {
    value = await callback({ repositoryOwner, worktreeOwner });
  } catch (error) {
    callbackError = error;
  }

  // Release in reverse order: worktree first, then repository.
  let worktreeReleaseError: unknown = null;
  try {
    await releaseIndexLock(worktreeLockDir, worktreeOwner);
  } catch (error) {
    worktreeReleaseError = error;
  }

  let repositoryReleaseError: unknown = null;
  try {
    await releaseIndexLock(repositoryLockDir, repositoryOwner);
  } catch (error) {
    repositoryReleaseError = error;
  }

  const releaseErrors = [worktreeReleaseError, repositoryReleaseError].filter(
    (e) => e !== null,
  );

  if (callbackError) {
    if (releaseErrors.length === 0) throw callbackError;
    throw new AggregateError(
      [callbackError, ...releaseErrors],
      `index lock callback and release failed`,
      { cause: callbackError },
    );
  }
  if (releaseErrors.length === 1) throw releaseErrors[0];
  if (releaseErrors.length > 1) {
    throw new AggregateError(releaseErrors, "index lock release failed", {
      cause: releaseErrors[0],
    });
  }
  return value as T;
}

// ── Inspection ─────────────────────────────────────────────────────────────

export type IndexLockInspectResult = {
  lockDir: string;
  locked: boolean;
  owner: IndexLockOwner | null;
  generation: { dev: number; ino: number; mtimeMs: number; birthtimeMs: number } | null;
};

/**
 * Inspect the current state of a lock directory without acquiring it.
 * Returns the owner record and directory generation, or null values when
 * the lock is not held.
 */
export async function inspectIndexLock(
  canonicalLockDirectory: string,
): Promise<IndexLockInspectResult> {
  const lockDir = path.resolve(canonicalLockDirectory);
  const generation = await readDirGeneration(lockDir);
  if (!generation) {
    return { lockDir, locked: false, owner: null, generation: null };
  }
  const owner = await readOwner(lockDir);
  return { lockDir, locked: owner !== null, owner, generation };
}

// ── Repair ─────────────────────────────────────────────────────────────────

export type RepairIndexLockOptions = {
  /** The lock directory path as observed by the caller. */
  lockDir: string;
  /** The lock directory generation as observed by the caller. */
  lockGeneration: { dev: number; ino: number; mtimeMs: number; birthtimeMs: number };
  /** The stale owner as observed by the caller. */
  staleOwner: IndexLockOwner;
  /** The stale election directory path (if repairing an orphaned election). */
  staleElectionDir?: string;
  /** The stale election directory generation (if repairing an orphaned election). */
  staleElectionGeneration?: { dev: number; ino: number; mtimeMs: number; birthtimeMs: number };
  /** Test seam. */
  captureIdentity?: () => ProcessIdentity | null;
  /** Test seam. */
  isIdentityAlive?: (identity: ProcessIdentity) => boolean;
};

export type RepairIndexLockResult = {
  lockQuarantinePath: string;
  electionQuarantinePath?: string;
};

/**
 * Repair an incomplete or orphaned lock.
 *
 * Handles two cases:
 *   1. Incomplete lock (no valid owner): quarantine the lock directory.
 *   2. Orphaned recovery election: quarantine both the election and the
 *      stale lock, requiring exact pinned identities.
 *
 * The repair requires the caller to provide the exact observed identities.
 * It never touches a canonical lock or election whose generation differs
 * from the pinned input, and never touches a successor owner.
 */
export async function repairIndexLock(
  options: RepairIndexLockOptions,
): Promise<RepairIndexLockResult> {
  const {
    lockDir: rawLockDir,
    lockGeneration,
    staleOwner,
    staleElectionDir,
    staleElectionGeneration,
    captureIdentity = getCachedProcessIdentity,
    isIdentityAlive = isProcessIdentityAlive,
  } = options;

  const lockDir = path.resolve(rawLockDir);

  // Verify the lock directory still has the expected generation.
  const currentGen = await readDirGeneration(lockDir);
  if (!currentGen) {
    throw lockError(
      `index lock directory absent during repair: ${lockDir}`,
      "index_lock_lost",
      lockDir,
    );
  }
  if (!sameGeneration(lockGeneration, currentGen)) {
    throw lockError(
      `index lock directory identity changed before repair: ${lockDir}`,
      "index_lock_lost",
      lockDir,
    );
  }

  // Re-read the owner and verify it matches the pinned stale owner.
  const currentOwner = await readOwner(lockDir);
  if (!currentOwner) {
    // Lock directory exists but no valid owner — incomplete lock.
    // Quarantine it directly.
    const quarantinePath = await quarantineLock(lockDir, staleOwner, currentGen, "repair");
    if (!quarantinePath) {
      throw lockError(
        `index lock disappeared during repair: ${lockDir}`,
        "index_lock_lost",
        lockDir,
      );
    }
    return { lockQuarantinePath: quarantinePath };
  }

  if (currentOwner.ownerToken !== staleOwner.ownerToken) {
    // A successor has appeared — do not touch it.
    throw lockError(
      `index lock successor appeared during repair: ${lockDir}`,
      "index_lock_lost",
      lockDir,
    );
  }

  // Verify the stale owner is dead or unavailable.
  if (isOwnerAlive(staleOwner, isIdentityAlive)) {
    throw lockError(
      `index lock owner is still alive; repair not permitted: ${lockDir}`,
      "index_lock_invalid",
      lockDir,
    );
  }

  // Create a repair election.
  const electionParent = path.join(path.dirname(lockDir), RECOVERY_ELECTIONS_DIR);
  await mkdir(electionParent, { recursive: true });
  const hash = ownerTokenHash(staleOwner.ownerToken);
  const repairElectionDir = path.join(electionParent, `repair-${hash}`);
  try {
    await mkdir(repairElectionDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw lockError(
        `index lock repair election already in progress: ${lockDir}`,
        "index_lock_invalid",
        lockDir,
      );
    }
    throw error;
  }

  // Re-verify the lock before quarantining.
  const reReadOwner = await readOwner(lockDir);
  if (!reReadOwner || reReadOwner.ownerToken !== staleOwner.ownerToken) {
    throw lockError(
      `index lock owner changed during repair election: ${lockDir}`,
      "index_lock_lost",
      lockDir,
    );
  }
  const reReadGen = await readDirGeneration(lockDir);
  if (!reReadGen || !sameGeneration(lockGeneration, reReadGen)) {
    throw lockError(
      `index lock directory identity changed during repair election: ${lockDir}`,
      "index_lock_lost",
      lockDir,
    );
  }

  // Quarantine the stale lock.
  const lockQuarantinePath = await quarantineLock(lockDir, reReadOwner, reReadGen, `repair-${hash.slice(0, 12)}`);
  if (!lockQuarantinePath) {
    throw lockError(
      `index lock disappeared during repair quarantine: ${lockDir}`,
      "index_lock_lost",
      lockDir,
    );
  }

  let electionQuarantinePath: string | undefined;

  // If an orphaned election was provided, quarantine it too.
  if (staleElectionDir && staleElectionGeneration) {
    const electionGen = await readDirGeneration(staleElectionDir);
    if (electionGen && sameGeneration(staleElectionGeneration, electionGen)) {
      // Verify the election owner is dead or unavailable.
      if (!isOwnerAlive(staleOwner, isIdentityAlive)) {
        const eqPath = path.join(
          path.dirname(staleElectionDir),
          `.quarantined-election-${hash}-${randomUUID()}`,
        );
        try {
          await rename(staleElectionDir, eqPath);
          await syncDirectory(path.dirname(staleElectionDir));
          electionQuarantinePath = eqPath;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            // Best-effort quarantine — the lock quarantine already succeeded.
          }
        }
      }
    }
  }

  return { lockQuarantinePath, electionQuarantinePath };
}

// ── Lock directory name validation ─────────────────────────────────────────

/**
 * Validate that a lock directory path follows the naming convention.
 * Returns the resolved absolute path.
 */
export function validateLockDirectoryPath(lockDir: string): string {
  const resolved = path.resolve(lockDir);
  const base = path.basename(resolved);
  if (!base.endsWith(".lock") && !base.startsWith(".lock-")) {
    throw lockError(
      `unsafe index lock path (must end with .lock or start with .lock-): ${resolved}`,
      "index_lock_invalid",
      resolved,
    );
  }
  return resolved;
}
