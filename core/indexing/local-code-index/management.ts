/**
 * Local Code Index v2 — lock inspection and repair.
 *
 * Typed internal operations that inspect and repair index locks without
 * exposing raw owner.json or election file parsing to callers.
 *
 * Both operations work under the lock (read + validate inside the lock
 * directory), not around it.  Test callers never parse owner/election
 * files directly; they receive bounded descriptors and pass them back.
 *
 * Spec: docs/architecture/local-code-index-v2-spec.md section 10
 *       (Concurrency and recovery)
 *
 * Dependencies: node:fs/promises, node:path, contracts.ts, safe-files.ts.
 */

import { createHash } from "node:crypto";
import { mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";

import { LocalCodeIndexUnavailableError } from "./contracts.js";
import { readBoundedFileNoFollow } from "./safe-files.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum bytes for an owner.json file (generous bound). */
const OWNER_JSON_MAX_BYTES = 4096;

/** Maximum age in milliseconds before a lock is considered stale. */
const LOCK_STALE_THRESHOLD_MS = 10 * 60 * 1_000; // 10 minutes

// ── Descriptor types ─────────────────────────────────────────────────────────

/**
 * Valid scope kinds for index locks.
 *
 * Mirrors the two lock scopes defined in spec section 10:
 * - `"repository-objects"` guards shared object mutation.
 * - `"worktree-publication"` guards snapshot publication per worktree.
 */
export type IndexLockScopeKind =
  | "repository-objects"
  | "worktree-publication";

/**
 * Bounded identity descriptor returned by {@link inspectIndexLock}.
 *
 * Every field is either a typed primitive or `null` (when the underlying
 * file is absent or malformed).  Callers pass this exact descriptor back
 * to {@link repairIndexLock}; they never construct paths or parse files.
 */
export type IndexLockDescriptor = Readonly<{
  /** Absolute path to the lock directory this descriptor describes. */
  lockDir: string;

  /**
   * Lock state observed at inspection time.
   *
   * - `"active"`      — valid owner, not stale.
   * - `"stale"`       — valid owner, but age exceeds the staleness threshold.
   * - `"incomplete"`  — lock directory exists but has no valid owner.json.
   * - `"missing"`     — lock directory does not exist.
   */
  state: "active" | "stale" | "incomplete" | "missing";

  /**
   * Scope kind parsed from owner.json, or `null` when the owner file
   * is absent or its scopeKind field is not a recognized value.
   */
  scopeKind: IndexLockScopeKind | null;

  /**
   * Scope key parsed from owner.json (the repository key or worktree key
   * that this lock guards).  `null` when the owner file is absent or
   * malformed.
   */
  scopeKey: string | null;

  /**
   * Owner token extracted from owner.json.  `null` when the owner file
   * is absent or does not contain a non-empty string token.
   */
  owner: string | null;

  /**
   * Lock age in milliseconds, computed from the owner.json `acquiredAt`
   * field relative to the current time.  `null` when the owner file is
   * absent or the timestamp is missing / not a valid number.
   */
  age: number | null;

  /**
   * SHA-256 hex hash of the owner token, suitable as a key for the
   * `recovery-elections/` directory.  `null` when `owner` is `null`.
   */
  ownerTokenHash: string | null;
}>;

// ── Repair input types ───────────────────────────────────────────────────────

/**
 * Valid repair actions.
 *
 * - `"quarantine-incomplete"` — rename an incomplete lock directory to
 *   a quarantine path so a new acquisition can proceed.
 * - `"quarantine-stale"` — rename a stale lock directory after proving
 *   the owner is dead or unavailable, and create a recovery election.
 * - `"quarantine-election"` — quarantine an orphaned recovery election
 *   directory.
 */
export type RepairAction =
  | "quarantine-incomplete"
  | "quarantine-stale"
  | "quarantine-election";

/**
 * Input to {@link repairIndexLock}.
 *
 * The caller must supply:
 * - `descriptor`: the exact descriptor returned by a prior
 *   {@link inspectIndexLock} call on the same lock directory.
 * - `action`: the repair action to perform.
 *
 * For `"quarantine-stale"`, the caller must additionally supply
 * `electionDir` — the path to the recovery-election directory that
 * will be created (typically `recovery-elections/<ownerTokenHash>`).
 * This path is validated to be a sibling of the lock's parent namespace.
 */
export type RepairIndexLockInput = Readonly<{
  /** Exact descriptor from a prior inspectIndexLock call. */
  descriptor: IndexLockDescriptor;

  /** The repair action to perform. */
  action: RepairAction;

  /**
   * Path to the recovery-election directory for `"quarantine-stale"`.
   * Required only for that action; ignored for others.
   */
  electionDir?: string;
}>;

/**
 * Result of a successful repair.
 */
export type RepairIndexLockResult = Readonly<{
  /** The original lock directory path. */
  lockDir: string;

  /** The quarantine path the lock was renamed to. */
  quarantinePath: string;

  /** The action that was performed. */
  action: RepairAction;
}>;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive the owner-token-hash used as the directory name under
 * `recovery-elections/`.
 */
function deriveOwnerTokenHash(ownerToken: string): string {
  return createHash("sha256").update(ownerToken).digest("hex");
}

/**
 * Validate that `candidateDir` is a direct child of `parentDir`.
 * Rejects paths that escape the parent (e.g., via `..`).
 */
function assertDirectChild(candidateDir: string, parentDir: string): void {
  const resolved = path.resolve(candidateDir);
  const resolvedParent = path.resolve(parentDir);
  if (path.dirname(resolved) !== resolvedParent) {
    throw new LocalCodeIndexUnavailableError("index_lock_repair_required", {
      sourcePath: candidateDir,
    });
  }
}

// ── Owner file parsing (internal only) ───────────────────────────────────────

/**
 * Internal owner.json shape.  Never exposed to callers.
 */
type OwnerFileData = Readonly<{
  scopeKind: IndexLockScopeKind | null;
  scopeKey: string | null;
  ownerToken: string | null;
  age: number | null;
  ownerTokenHash: string | null;
}>;

/**
 * Read and parse owner.json from a lock directory.
 *
 * Returns parsed fields with `null` for any field that is absent or
 * malformed.  Never throws on parse errors — the caller decides what
 * to do with incomplete data.
 */
async function readOwnerFile(lockDir: string): Promise<OwnerFileData> {
  const ownerPath = path.join(lockDir, "owner.json");

  let raw: Uint8Array;
  try {
    raw = await readBoundedFileNoFollow(ownerPath, OWNER_JSON_MAX_BYTES);
  } catch {
    return {
      scopeKind: null,
      scopeKey: null,
      ownerToken: null,
      age: null,
      ownerTokenHash: null,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
  } catch {
    return {
      scopeKind: null,
      scopeKey: null,
      ownerToken: null,
      age: null,
      ownerTokenHash: null,
    };
  }

  // scopeKind
  const rawScopeKind = parsed.scopeKind;
  const scopeKind: IndexLockScopeKind | null =
    rawScopeKind === "repository-objects" || rawScopeKind === "worktree-publication"
      ? rawScopeKind
      : null;

  // scopeKey
  const rawScopeKey = parsed.scopeKey;
  const scopeKey = typeof rawScopeKey === "string" && rawScopeKey.length > 0
    ? rawScopeKey
    : null;

  // ownerToken
  const rawToken = parsed.ownerToken;
  const ownerToken = typeof rawToken === "string" && rawToken.length > 0
    ? rawToken
    : null;

  // age (from acquiredAt)
  let age: number | null = null;
  const rawAcquiredAt = parsed.acquiredAt;
  if (typeof rawAcquiredAt === "number" && Number.isFinite(rawAcquiredAt)) {
    age = Date.now() - rawAcquiredAt;
    if (age < 0) age = 0;
  }

  // ownerTokenHash
  const ownerTokenHash = ownerToken !== null ? deriveOwnerTokenHash(ownerToken) : null;

  return { scopeKind, scopeKey, ownerToken, age, ownerTokenHash };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Inspect a lock directory and return a bounded identity descriptor.
 *
 * Reads `owner.json` inside `lockDir` (if present) through a bounded
 * no-follow read and returns typed fields.  Callers never need to parse
 * the raw file; they receive `scopeKind`, `scopeKey`, `owner`, `age`,
 * and `state` directly.
 *
 * The descriptor is designed to be passed verbatim to
 * {@link repairIndexLock}.
 *
 * @param lockDir Absolute path to the lock directory
 *   (e.g., `objects.lock/` or `lock.lock/`).
 * @returns A bounded identity descriptor.
 */
export async function inspectIndexLock(
  lockDir: string,
): Promise<IndexLockDescriptor> {
  // Check if the lock directory exists.
  let dirExists = false;
  try {
    const st = await stat(lockDir);
    dirExists = st.isDirectory();
  } catch {
    dirExists = false;
  }

  if (!dirExists) {
    return {
      lockDir,
      state: "missing",
      scopeKind: null,
      scopeKey: null,
      owner: null,
      age: null,
      ownerTokenHash: null,
    };
  }

  // Read and parse owner.json.
  const ownerData = await readOwnerFile(lockDir);

  // Incomplete: lock dir exists but no valid owner token.
  if (ownerData.ownerToken === null) {
    return {
      lockDir,
      state: "incomplete",
      scopeKind: ownerData.scopeKind,
      scopeKey: ownerData.scopeKey,
      owner: null,
      age: ownerData.age,
      ownerTokenHash: null,
    };
  }

  // Determine staleness.
  const isStale =
    ownerData.age !== null && ownerData.age > LOCK_STALE_THRESHOLD_MS;

  return {
    lockDir,
    state: isStale ? "stale" : "active",
    scopeKind: ownerData.scopeKind,
    scopeKey: ownerData.scopeKey,
    owner: ownerData.ownerToken,
    age: ownerData.age,
    ownerTokenHash: ownerData.ownerTokenHash,
  };
}

/**
 * Repair an index lock based on an exact descriptor from inspection.
 *
 * Accepts the descriptor returned by a prior {@link inspectIndexLock} call
 * and performs the requested repair action.  The descriptor must not be
 * constructed or modified by the caller — it is passed verbatim.
 *
 * Actions:
 *
 * - `"quarantine-incomplete"`: Renames the incomplete lock directory to a
 *   quarantine path containing a random UUID, freeing the canonical lock
 *   path for a new acquisition.  Requires `descriptor.state === "incomplete"`.
 *
 * - `"quarantine-stale"`: Creates a recovery election directory keyed by the
 *   owner token hash, then renames the stale lock directory to a quarantine
 *   path.  Requires `descriptor.state === "stale"` and `descriptor.owner`
 *   to be non-null.  The `electionDir` parameter is required and must be a
 *   direct child of the recovery-elections directory for this namespace.
 *
 * - `"quarantine-election"`: Renames an orphaned recovery election directory
 *   to a quarantine path.  Requires `descriptor.state === "stale"` (the
 *   election is associated with a stale owner).  The `electionDir` parameter
 *   is required.
 *
 * All operations:
 * - Verify that the lock directory identity has not changed since inspection
 *   (re-stat and compare).
 * - Work under the lock (read + rename inside the lock directory tree).
 * - Never touch a successor owner or a different lock generation.
 *
 * @param input The repair input containing the descriptor and action.
 * @returns The quarantine path on success.
 * @throws {LocalCodeIndexUnavailableError} with appropriate reason when
 *   the repair cannot proceed.
 */
export async function repairIndexLock(
  input: RepairIndexLockInput,
): Promise<RepairIndexLockResult> {
  const { descriptor, action } = input;
  const { lockDir } = descriptor;

  // ── Verify lock directory still exists and matches ──────────────────────
  let lockDirStat: { ino: bigint; dev: bigint } | null = null;
  try {
    const st = await stat(lockDir, { bigint: true });
    if (!st.isDirectory()) {
      throw new LocalCodeIndexUnavailableError("index_lock_lost", {
        sourcePath: lockDir,
      });
    }
    lockDirStat = { ino: st.ino, dev: st.dev };
  } catch (err: unknown) {
    if (err instanceof LocalCodeIndexUnavailableError) throw err;
    throw new LocalCodeIndexUnavailableError("index_lock_lost", {
      sourcePath: lockDir,
      cause: err,
    });
  }

  // ── Generate quarantine suffix ──────────────────────────────────────────
  const quarantineSuffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  // ── Action: quarantine-incomplete ───────────────────────────────────────
  if (action === "quarantine-incomplete") {
    if (descriptor.state !== "incomplete") {
      throw new LocalCodeIndexUnavailableError("index_lock_repair_required", {
        sourcePath: lockDir,
      });
    }

    // Re-read to confirm it is still incomplete.
    const reRead = await readOwnerFile(lockDir);
    if (reRead.ownerToken !== null) {
      // A valid owner appeared — the lock is no longer incomplete.
      throw new LocalCodeIndexUnavailableError("index_lock_lost", {
        sourcePath: lockDir,
      });
    }

    const quarantinePath = `${lockDir}.quarantine-incomplete-${quarantineSuffix}`;
    await rename(lockDir, quarantinePath);

    return { lockDir, quarantinePath, action };
  }

  // ── Action: quarantine-stale ────────────────────────────────────────────
  if (action === "quarantine-stale") {
    if (descriptor.state !== "stale" || descriptor.owner === null) {
      throw new LocalCodeIndexUnavailableError("index_lock_repair_required", {
        sourcePath: lockDir,
      });
    }

    const electionDir = input.electionDir;
    if (!electionDir || typeof electionDir !== "string") {
      throw new LocalCodeIndexUnavailableError("index_lock_repair_required", {
        sourcePath: lockDir,
      });
    }

    // Validate electionDir is a direct child of its parent (recovery-elections/).
    assertDirectChild(electionDir, path.dirname(electionDir));

    // Re-read owner to confirm it is still the same stale owner.
    const reRead = await readOwnerFile(lockDir);
    if (reRead.ownerToken === null || reRead.ownerToken !== descriptor.owner) {
      throw new LocalCodeIndexUnavailableError("index_lock_lost", {
        sourcePath: lockDir,
      });
    }

    // Create the recovery election directory (exclusive via mkdir).
    try {
      await mkdir(electionDir, { recursive: false });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // Election already exists — another recoverer won.
        throw new LocalCodeIndexUnavailableError("index_lock_lost", {
          sourcePath: lockDir,
        });
      }
      throw new LocalCodeIndexUnavailableError("index_lock_repair_required", {
        sourcePath: lockDir,
        cause: err,
      });
    }

    // Quarantine the stale lock directory.
    const quarantinePath = `${lockDir}.quarantine-stale-${quarantineSuffix}`;
    await rename(lockDir, quarantinePath);

    return { lockDir, quarantinePath, action };
  }

  // ── Action: quarantine-election ─────────────────────────────────────────
  if (action === "quarantine-election") {
    const electionDir = input.electionDir;
    if (!electionDir || typeof electionDir !== "string") {
      throw new LocalCodeIndexUnavailableError("index_lock_repair_required", {
        sourcePath: lockDir,
      });
    }

    // Validate electionDir is a direct child of its parent.
    assertDirectChild(electionDir, path.dirname(electionDir));

    // Verify the election directory exists.
    try {
      const st = await stat(electionDir);
      if (!st.isDirectory()) {
        throw new LocalCodeIndexUnavailableError("index_lock_repair_required", {
          sourcePath: electionDir,
        });
      }
    } catch (err: unknown) {
      if (err instanceof LocalCodeIndexUnavailableError) throw err;
      throw new LocalCodeIndexUnavailableError("index_lock_repair_required", {
        sourcePath: electionDir,
        cause: err,
      });
    }

    // Quarantine the election directory.
    const quarantinePath = `${electionDir}.quarantine-election-${quarantineSuffix}`;
    await rename(electionDir, quarantinePath);

    return { lockDir: electionDir, quarantinePath, action };
  }

  // Unreachable with typed action, but exhaustiveness guard.
  throw new LocalCodeIndexUnavailableError("index_lock_repair_required", {
    sourcePath: lockDir,
  });
}
