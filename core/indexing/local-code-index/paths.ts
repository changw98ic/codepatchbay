/**
 * Local Code Index v2 — canonical roots, key derivation, and path builders.
 *
 * Implements spec sections 7.1 (Location) and 7.2 (Repository, worktree,
 * and source keys).
 *
 * Dependencies: node:crypto, node:path, node:fs/promises, contracts.ts.
 *
 * - `resolveStorageRoot` resolves and validates the canonical storage root.
 * - `validateSourcePath` / `validateStorageRoot` reject a storage root
 *   equal to or nested under the source root.
 * - Key derivation delegates to contracts.ts (`deriveRepositoryKey`,
 *   `deriveWorktreeKey`, `deriveSourceKey`).
 * - Path builders return absolute paths under the validated storage root.
 */

import { createHash } from "node:crypto";
import { stat, lstat, realpath, mkdir } from "node:fs/promises";
import path from "node:path";

import {
  deriveRepositoryKey,
  deriveWorktreeKey,
  deriveSourceKey,
  LocalCodeIndexUnavailableError,
} from "./contracts.js";

// ── Re-exports from contracts ────────────────────────────────────────────────

export { deriveRepositoryKey, deriveWorktreeKey, deriveSourceKey };

// ── Constants ────────────────────────────────────────────────────────────────

/** Canonical suffix under the storage root where v2 index data lives. */
const INDEX_SUBPATH = path.join("indexes", "local-code", "v2");

// ── Canonical path helpers ───────────────────────────────────────────────────

/**
 * Resolve a filesystem path to its canonical absolute form, resolving
 * symlinks.  Throws `LocalCodeIndexUnavailableError` with
 * `reason: "unsafe_source_path"` or `"unsafe_storage_root"` when
 * resolution fails or the path does not exist.
 */
async function canonicalize(
  input: string,
  reason: "unsafe_source_path" | "unsafe_storage_root",
): Promise<string> {
  if (!input || typeof input !== "string") {
    throw new LocalCodeIndexUnavailableError(reason, {
      sourcePath: input ?? "",
    });
  }
  const abs = path.resolve(input);
  try {
    // `stat` follows symlinks and confirms existence.
    const st = await stat(abs);
    if (!st.isDirectory()) {
      throw new LocalCodeIndexUnavailableError(reason, { sourcePath: abs });
    }
    return await realpath(abs);
  } catch (err: unknown) {
    if (err instanceof LocalCodeIndexUnavailableError) throw err;
    throw new LocalCodeIndexUnavailableError(reason, { sourcePath: abs, cause: err });
  }
}

/**
 * Return true when `child` is the same path as or a descendant of `parent`.
 * Both paths must already be canonical absolute paths.
 */
function isSameOrDescendant(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// ── Storage root resolution ──────────────────────────────────────────────────

/**
 * Resolve the canonical storage root for the local code index.
 *
 * Resolution order (spec section 7.1):
 *  1. When `cpbRoot` is provided, use `<cpbRoot>/indexes/local-code/v2/`.
 *  2. Otherwise, use the current user's protected local-index directory under
 *     the canonical operating-system temporary root.
 *
 * The resolved root must **not** be equal to or nested under the canonical
 * source root.
 */
export async function resolveStorageRoot(
  cpbRoot: string | undefined,
  sourcePath: string,
  options: Readonly<{ readOnly?: boolean }> = {},
): Promise<string> {
  const canonicalSource = await canonicalize(sourcePath, "unsafe_source_path");
  let safeCpbRoot: string | undefined;
  if (cpbRoot && typeof cpbRoot === "string") {
    const canonicalCpbRoot = await canonicalize(cpbRoot, "unsafe_storage_root");
    try {
      await lstat(path.join(canonicalCpbRoot, ".git"));
      throw new LocalCodeIndexUnavailableError("unsafe_storage_root", {
        sourcePath: canonicalSource,
      });
    } catch (error) {
      if (error instanceof LocalCodeIndexUnavailableError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new LocalCodeIndexUnavailableError("unsafe_storage_root", {
          sourcePath: canonicalSource,
          cause: error,
        });
      }
    }
    const candidate = path.resolve(canonicalCpbRoot, INDEX_SUBPATH);
    if (isSameOrDescendant(candidate, canonicalSource)) {
      throw new LocalCodeIndexUnavailableError("unsafe_storage_root", {
        sourcePath: canonicalSource,
      });
    }
    safeCpbRoot = canonicalCpbRoot;
  }

  const result = await resolveStorageAuthority({
    cpbRoot: safeCpbRoot,
    readOnly: options.readOnly === true,
  });
  if (!result.ok) {
    // A read-only status check must not create a missing authority. Return the
    // deterministic safe path so the pointer read reports a missing index.
    if (
      options.readOnly === true
      && "code" in result
      && result.code === "EXPLICIT_ROOT_MISSING"
    ) {
      if (safeCpbRoot) return path.join(safeCpbRoot, INDEX_SUBPATH);
      const tmpRoot = await realpath(os.tmpdir());
      return path.join(
        tmpRoot,
        `${USER_DIR_PREFIX}${currentAdapter().getuid()}`,
        INDEX_SUBPATH,
      );
    }
    throw new LocalCodeIndexUnavailableError("unsafe_storage_root", {
      sourcePath: canonicalSource,
    });
  }
  if (isSameOrDescendant(result.authority, canonicalSource)) {
    throw new LocalCodeIndexUnavailableError("unsafe_storage_root", {
      sourcePath: canonicalSource,
    });
  }
  return result.authority;
}

// ── Validation helpers ───────────────────────────────────────────────────────

/**
 * Validate that the source path exists and is a directory.
 *
 * Returns the canonical absolute path on success.
 */
export async function validateSourcePath(
  sourcePath: string,
): Promise<string> {
  return canonicalize(sourcePath, "unsafe_source_path");
}

/**
 * Validate that the storage root is **not** equal to or nested under the
 * source root.  Both paths must already be canonical absolute paths.
 */
export function validateStorageRoot(
  storageRoot: string,
  canonicalSourcePath: string,
): void {
  if (!storageRoot || !canonicalSourcePath) {
    throw new LocalCodeIndexUnavailableError("unsafe_storage_root", {
      sourcePath: canonicalSourcePath,
    });
  }
  if (isSameOrDescendant(storageRoot, canonicalSourcePath)) {
    throw new LocalCodeIndexUnavailableError("unsafe_storage_root", {
      sourcePath: canonicalSourcePath,
    });
  }
}

// ── Object prefix ────────────────────────────────────────────────────────────

/**
 * Derive the two-character hex prefix used to shard objects into
 * subdirectories.  Uses the first byte of the SHA-256 of the object ID.
 *
 * Object IDs are full 64-hex-char SHA-256 digests (or the 32-hex-char
 * repository/worktree keys).  The prefix is always a lowercase two-hex-char
 * string.
 */
export function objectPrefix(objectId: string): string {
  const hash = createHash("sha256").update(objectId).digest("hex");
  return hash.slice(0, 2);
}

// ── Storage layout builders ──────────────────────────────────────────────────
//
// Every function takes a validated `storageRoot` and the relevant key(s).
// Returned paths are absolute but may refer to entries that do not yet exist.
// Callers are responsible for creating directories/files as needed.

/**
 * Base directory for the entire v2 index:
 * `<storageRoot>/`
 */
export function storageBase(storageRoot: string): string {
  return storageRoot;
}

// ── Repository namespace ─────────────────────────────────────────────────────

/**
 * `<storageRoot>/repositories/<repositoryKey>/`
 */
export function repositoryDir(
  storageRoot: string,
  repositoryKey: string,
): string {
  return path.join(storageRoot, "repositories", repositoryKey);
}

/**
 * `<storageRoot>/repositories/<repositoryKey>/objects.lock/`
 */
export function repositoryObjectsLockDir(
  storageRoot: string,
  repositoryKey: string,
): string {
  return path.join(repositoryDir(storageRoot, repositoryKey), "objects.lock");
}

/**
 * `<storageRoot>/repositories/<repositoryKey>/objects.lock/owner.json`
 */
export function repositoryObjectsLockOwner(
  storageRoot: string,
  repositoryKey: string,
): string {
  return path.join(repositoryObjectsLockDir(storageRoot, repositoryKey), "owner.json");
}

/**
 * `<storageRoot>/repositories/<repositoryKey>/recovery-elections/`
 */
export function repositoryRecoveryElectionsDir(
  storageRoot: string,
  repositoryKey: string,
): string {
  return path.join(repositoryDir(storageRoot, repositoryKey), "recovery-elections");
}

/**
 * `<storageRoot>/repositories/<repositoryKey>/recovery-elections/<ownerTokenHash>/`
 */
export function repositoryRecoveryElectionDir(
  storageRoot: string,
  repositoryKey: string,
  ownerTokenHash: string,
): string {
  return path.join(
    repositoryRecoveryElectionsDir(storageRoot, repositoryKey),
    ownerTokenHash,
  );
}

/**
 * `<storageRoot>/repositories/<repositoryKey>/objects/`
 */
export function repositoryObjectsDir(
  storageRoot: string,
  repositoryKey: string,
): string {
  return path.join(repositoryDir(storageRoot, repositoryKey), "objects");
}

/**
 * Immutable lookup record for a clean Git state that has already been indexed.
 *
 * The record lives in the repository namespace, rather than a worktree
 * namespace, because a newly-created worktree can safely reuse the parsed
 * objects only after it proves that its Git state has the same content key.
 */
export function repositoryReusableSnapshotPath(
  storageRoot: string,
  repositoryKey: string,
  reusableStateKey: string,
): string {
  return path.join(
    repositoryDir(storageRoot, repositoryKey),
    "reusable-snapshots",
    "v2",
    objectPrefix(reusableStateKey),
    `${reusableStateKey}.json`,
  );
}

/**
 * `<storageRoot>/repositories/<repositoryKey>/objects/files/<prefix>/<fileObjectId>.json`
 */
export function fileObjectPath(
  storageRoot: string,
  repositoryKey: string,
  fileObjectId: string,
): string {
  return path.join(
    repositoryObjectsDir(storageRoot, repositoryKey),
    "files",
    objectPrefix(fileObjectId),
    `${fileObjectId}.json`,
  );
}

/**
 * `<storageRoot>/repositories/<repositoryKey>/objects/blob-map/<prefix>/<blobMapObjectId>.json`
 */
export function blobMapObjectPath(
  storageRoot: string,
  repositoryKey: string,
  blobMapObjectId: string,
): string {
  return path.join(
    repositoryObjectsDir(storageRoot, repositoryKey),
    "blob-map",
    objectPrefix(blobMapObjectId),
    `${blobMapObjectId}.json`,
  );
}

/**
 * `<storageRoot>/repositories/<repositoryKey>/objects/symbol-shards/<prefix>/<symbolShardId>.json`
 */
export function symbolShardPath(
  storageRoot: string,
  repositoryKey: string,
  symbolShardId: string,
): string {
  return path.join(
    repositoryObjectsDir(storageRoot, repositoryKey),
    "symbol-shards",
    objectPrefix(symbolShardId),
    `${symbolShardId}.json`,
  );
}

/**
 * `<storageRoot>/repositories/<repositoryKey>/objects/relation-shards/<prefix>/<relationShardId>.json`
 */
export function relationShardPath(
  storageRoot: string,
  repositoryKey: string,
  relationShardId: string,
): string {
  return path.join(
    repositoryObjectsDir(storageRoot, repositoryKey),
    "relation-shards",
    objectPrefix(relationShardId),
    `${relationShardId}.json`,
  );
}

// ── Worktree namespace ───────────────────────────────────────────────────────

/**
 * `<storageRoot>/worktrees/<worktreeKey>/`
 */
export function worktreeDir(
  storageRoot: string,
  worktreeKey: string,
): string {
  return path.join(storageRoot, "worktrees", worktreeKey);
}

/**
 * `<storageRoot>/worktrees/<worktreeKey>/current.json`
 */
export function worktreeCurrentPointer(
  storageRoot: string,
  worktreeKey: string,
): string {
  return path.join(worktreeDir(storageRoot, worktreeKey), "current.json");
}

/**
 * `<storageRoot>/worktrees/<worktreeKey>/lock.lock/`
 */
export function worktreeLockDir(
  storageRoot: string,
  worktreeKey: string,
): string {
  return path.join(worktreeDir(storageRoot, worktreeKey), "lock.lock");
}

/**
 * `<storageRoot>/worktrees/<worktreeKey>/lock.lock/owner.json`
 */
export function worktreeLockOwner(
  storageRoot: string,
  worktreeKey: string,
): string {
  return path.join(worktreeLockDir(storageRoot, worktreeKey), "owner.json");
}

/**
 * `<storageRoot>/worktrees/<worktreeKey>/recovery-elections/`
 */
export function worktreeRecoveryElectionsDir(
  storageRoot: string,
  worktreeKey: string,
): string {
  return path.join(worktreeDir(storageRoot, worktreeKey), "recovery-elections");
}

/**
 * `<storageRoot>/worktrees/<worktreeKey>/recovery-elections/<ownerTokenHash>/`
 */
export function worktreeRecoveryElectionDir(
  storageRoot: string,
  worktreeKey: string,
  ownerTokenHash: string,
): string {
  return path.join(
    worktreeRecoveryElectionsDir(storageRoot, worktreeKey),
    ownerTokenHash,
  );
}

/**
 * `<storageRoot>/worktrees/<worktreeKey>/snapshots/`
 */
export function snapshotsDir(
  storageRoot: string,
  worktreeKey: string,
): string {
  return path.join(worktreeDir(storageRoot, worktreeKey), "snapshots");
}

/**
 * `<storageRoot>/worktrees/<worktreeKey>/snapshots/<snapshotId>/`
 */
export function snapshotDir(
  storageRoot: string,
  worktreeKey: string,
  snapshotId: string,
): string {
  return path.join(snapshotsDir(storageRoot, worktreeKey), snapshotId);
}

/**
 * `<storageRoot>/worktrees/<worktreeKey>/snapshots/<snapshotId>/identity.json`
 */
export function snapshotIdentityPath(
  storageRoot: string,
  worktreeKey: string,
  snapshotId: string,
): string {
  return path.join(snapshotDir(storageRoot, worktreeKey, snapshotId), "identity.json");
}

/**
 * `<storageRoot>/worktrees/<worktreeKey>/snapshots/<snapshotId>/index-map.json`
 */
export function snapshotIndexMapPath(
  storageRoot: string,
  worktreeKey: string,
  snapshotId: string,
): string {
  return path.join(snapshotDir(storageRoot, worktreeKey, snapshotId), "index-map.json");
}

/**
 * `<storageRoot>/worktrees/<worktreeKey>/runs/`
 */
export function runsDir(
  storageRoot: string,
  worktreeKey: string,
): string {
  return path.join(worktreeDir(storageRoot, worktreeKey), "runs");
}

/**
 * `<storageRoot>/worktrees/<worktreeKey>/runs/<runId>.json`
 */
export function runReportPath(
  storageRoot: string,
  worktreeKey: string,
  runId: string,
): string {
  return path.join(runsDir(storageRoot, worktreeKey), `${runId}.json`);
}

// ── Temporary file helpers ───────────────────────────────────────────────────

/**
 * Derive a deterministic temporary file name scoped to an owner token.
 *
 * Temporary files are placed alongside the final target path with a
 * `.tmp-<ownerToken>-<randomSuffix>` extension, ensuring they are
 * unique per owner and never collide with final names.
 */
export function tempFileName(ownerToken: string, suffix = ""): string {
  const rand = createHash("sha256")
    .update(ownerToken)
    .update(String(Date.now()))
    .update(String(Math.random()))
    .digest("hex")
    .slice(0, 12);
  const tag = suffix ? `-${suffix}` : "";
  return `.tmp-${ownerToken.slice(0, 8)}-${rand}${tag}`;
}

// ── Full key bundle ──────────────────────────────────────────────────────────

/**
 * Compute all three keys for a given source observation.
 *
 * For Git repositories, pass `commonGitDir` as `commonGitDirOrSourcePath`
 * and the worktree's own canonical path as `canonicalSourcePath`.
 * For non-Git directories, both arguments are the same canonical path.
 */
export function computeKeys(
  commonGitDirOrSourcePath: string,
  canonicalSourcePath: string,
): { repositoryKey: string; worktreeKey: string; sourceKey: string } {
  const repositoryKey = deriveRepositoryKey(commonGitDirOrSourcePath);
  const worktreeKey = deriveWorktreeKey(canonicalSourcePath);
  const sourceKey = deriveSourceKey(repositoryKey, worktreeKey);
  return { repositoryKey, worktreeKey, sourceKey };
}

// ── Storage resolution + filesystem authority adapter (Phase 4) ─────────────

import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";

import type {
  AuthoritySource,
  PinnedIdentity,
  StorageErrorCode,
  StorageFail,
  StorageOk,
  StorageResult,
} from "./types.js";

// --- FsAuthorityAdapter ---

export type LstatLike = {
  mode: number;
  uid: number;
  gid: number;
  dev: bigint;
  ino: bigint;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
};

export interface FsAuthorityAdapter {
  lstatNoFollow(p: string): Promise<LstatLike | null>;
  statFollow(p: string): Promise<LstatLike | null>;
  realpath(p: string): Promise<string>;
  mkdirMode(p: string, mode: number): Promise<void>;
  mkdirRecursive(p: string, mode: number): Promise<void>;
  getuid(): number;
}

function bigintStatToLstatLike(s: import("node:fs").BigIntStats): LstatLike {
  return {
    mode: Number(s.mode),
    uid: Number(s.uid),
    gid: Number(s.gid),
    dev: s.dev,
    ino: s.ino,
    isSymbolicLink: () => s.isSymbolicLink(),
    isDirectory: () => s.isDirectory(),
  };
}

const defaultFsAdapter: FsAuthorityAdapter = {
  async lstatNoFollow(p: string): Promise<LstatLike | null> {
    try {
      return bigintStatToLstatLike(await lstat(p, { bigint: true }));
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") return null;
      throw err;
    }
  },
  async statFollow(p: string): Promise<LstatLike | null> {
    try {
      const fs = await import("node:fs/promises");
      return bigintStatToLstatLike(await fs.stat(p, { bigint: true }));
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") return null;
      throw err;
    }
  },
  async realpath(p: string): Promise<string> {
    return realpath(p);
  },
  async mkdirMode(p: string, mode: number): Promise<void> {
    await mkdir(p, { mode, recursive: false });
  },
  async mkdirRecursive(p: string, mode: number): Promise<void> {
    await mkdir(p, { mode, recursive: true });
  },
  getuid(): number {
    return typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
  },
};

// --- Test hook injection ---

type FsAdapterHook = { adapter?: FsAuthorityAdapter };

const hookStorage = new AsyncLocalStorage<FsAdapterHook>();

function currentAdapter(): FsAuthorityAdapter {
  return hookStorage.getStore()?.adapter ?? defaultFsAdapter;
}

/**
 * Inject a custom FsAuthorityAdapter for testing. Runs `fn` with the adapter active.
 */
export async function withFsAuthorityTestAdapter<T>(
  adapter: FsAuthorityAdapter,
  fn: () => Promise<T>,
): Promise<T> {
  return hookStorage.run({ adapter }, fn);
}

// --- Internal helpers ---

function fail(code: StorageErrorCode, reason: string): StorageFail {
  return { ok: false, reason, code };
}

function isPathWithin(candidate: string, ancestor: string): boolean {
  const relative = path.relative(ancestor, candidate);
  return relative === "" || (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..");
}

const USER_DIR_PREFIX = "cpb-local-code-index-uid-";

// --- Tmp root validation ---

async function resolveTmpRoot(adapter: FsAuthorityAdapter): Promise<
  | { ok: true; tmpRoot: string; source: "tmp-private" | "tmp-shared"; pinned: PinnedIdentity }
  | StorageFail
> {
  const candidates = [process.env.TMPDIR || os.tmpdir(), "/tmp"];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    const info = await adapter.lstatNoFollow(resolved);
    if (!info) continue;

    if (info.isSymbolicLink()) {
      let canonical: string;
      try {
        canonical = await adapter.realpath(resolved);
      } catch {
        continue;
      }
      const targetInfo = await adapter.lstatNoFollow(canonical);
      if (!targetInfo || targetInfo.isSymbolicLink()) continue;
      const uid = adapter.getuid();
      if (targetInfo.uid === uid) {
        if ((targetInfo.mode & 0o077) !== 0) return fail("UNSAFE_TMP_MODE", `private tmp has group/world bits: ${canonical}`);
        return {
          ok: true, tmpRoot: canonical, source: "tmp-private",
          pinned: { dev: targetInfo.dev, ino: targetInfo.ino, canonicalPath: canonical },
        };
      } else if (targetInfo.uid === 0) {
        if ((targetInfo.mode & 0o1000) === 0) return fail("UNSAFE_TMP_MODE", `shared tmp missing sticky bit: ${canonical}`);
        return {
          ok: true, tmpRoot: canonical, source: "tmp-shared",
          pinned: { dev: targetInfo.dev, ino: targetInfo.ino, canonicalPath: canonical },
        };
      } else {
        return fail("UNSAFE_TMP_OWNER", `tmp owned by unexpected uid ${targetInfo.uid}: ${canonical}`);
      }
    }

    const uid = adapter.getuid();
    if (info.uid === uid) {
      if ((info.mode & 0o077) !== 0) return fail("UNSAFE_TMP_MODE", `private tmp has group/world bits: ${resolved}`);
      let canonical: string;
      try { canonical = await adapter.realpath(resolved); } catch { continue; }
      return {
        ok: true, tmpRoot: canonical, source: "tmp-private",
        pinned: { dev: info.dev, ino: info.ino, canonicalPath: canonical },
      };
    } else if (info.uid === 0) {
      if ((info.mode & 0o1000) === 0) return fail("UNSAFE_TMP_MODE", `shared tmp missing sticky bit: ${resolved}`);
      let canonical: string;
      try { canonical = await adapter.realpath(resolved); } catch { continue; }
      return {
        ok: true, tmpRoot: canonical, source: "tmp-shared",
        pinned: { dev: info.dev, ino: info.ino, canonicalPath: canonical },
      };
    } else {
      return fail("UNSAFE_TMP_OWNER", `tmp owned by unexpected uid ${info.uid}: ${resolved}`);
    }
  }

  return fail("NO_SAFE_TMP", "no safe temporary directory found");
}

// --- Authority directory creation/validation ---

async function createAuthorityDir(
  adapter: FsAuthorityAdapter,
  authorityPath: string,
  source: AuthoritySource = "tmp-private",
): Promise<StorageResult> {
  const parent = path.dirname(authorityPath);
  try {
    await adapter.mkdirRecursive(parent, 0o755);
  } catch (err: unknown) {
    return fail("AUTHORITY_CREATE_FAILED", `failed to create parent: ${parent}: ${err}`);
  }

  try {
    await adapter.mkdirMode(authorityPath, 0o700);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "EEXIST") {
      // Already exists — validate below
    } else {
      return fail("AUTHORITY_CREATE_FAILED", `failed to create authority: ${authorityPath}: ${err}`);
    }
  }

  return validateAuthorityDir(adapter, authorityPath, false, source);
}

async function validateAuthorityDir(
  adapter: FsAuthorityAdapter,
  authorityPath: string,
  readOnly = false,
  source: AuthoritySource = "tmp-private",
): Promise<StorageResult> {
  const info = await adapter.lstatNoFollow(authorityPath);
  if (!info) {
    if (readOnly) return fail("EXPLICIT_ROOT_MISSING", `authority does not exist: ${authorityPath}`);
    return fail("AUTHORITY_CREATE_FAILED", `authority missing after creation: ${authorityPath}`);
  }

  if (info.isSymbolicLink()) {
    return fail("UNSAFE_AUTHORITY_SYMLINK", `authority is a symlink: ${authorityPath}`);
  }

  if (!info.isDirectory()) {
    return fail("UNSAFE_AUTHORITY_SYMLINK", `authority is not a directory: ${authorityPath}`);
  }

  const uid = adapter.getuid();
  if (info.uid !== uid) {
    return fail("UNSAFE_AUTHORITY_OWNER", `authority owned by uid ${info.uid}, expected ${uid}: ${authorityPath}`);
  }

  if ((info.mode & 0o077) !== 0) {
    return fail("UNSAFE_AUTHORITY_MODE", `authority has group/world bits (${(info.mode & 0o777).toString(8)}): ${authorityPath}`);
  }

  let canonical: string;
  try {
    canonical = await adapter.realpath(authorityPath);
  } catch {
    return fail("UNSAFE_AUTHORITY_SYMLINK", `cannot resolve authority path: ${authorityPath}`);
  }

  return { ok: true, authority: canonical, source, pinned: { dev: info.dev, ino: info.ino, canonicalPath: canonical } };
}

// --- Revalidation ---

async function revalidatePinned(
  adapter: FsAuthorityAdapter,
  pinned: PinnedIdentity,
  label: string,
): Promise<StorageFail | null> {
  const info = await adapter.lstatNoFollow(pinned.canonicalPath);
  if (!info) return fail("STALE_TMP_GENERATION", `${label} disappeared: ${pinned.canonicalPath}`);
  if (info.isSymbolicLink()) return fail("STALE_TMP_GENERATION", `${label} became a symlink: ${pinned.canonicalPath}`);
  if (info.dev !== pinned.dev || info.ino !== pinned.ino) return fail("STALE_TMP_GENERATION", `${label} generation changed (dev/ino mismatch): ${pinned.canonicalPath}`);
  let canonical: string;
  try { canonical = await adapter.realpath(pinned.canonicalPath); } catch { return fail("STALE_TMP_GENERATION", `${label} canonical path unresolvable: ${pinned.canonicalPath}`); }
  if (canonical !== pinned.canonicalPath) return fail("STALE_TMP_GENERATION", `${label} canonical path changed: ${pinned.canonicalPath} -> ${canonical}`);
  return null;
}

// --- Source validation ---

export function sourceAboveAuthority(source: string, authority: string): boolean {
  const s = path.resolve(source);
  const a = path.resolve(authority);
  return s === a || a.startsWith(s + path.sep);
}

// --- Public API ---

export type ResolveStorageOpts = {
  cpbRoot?: string;
  readOnly?: boolean;
};

export async function resolveStorageAuthority(
  opts: ResolveStorageOpts = {},
): Promise<StorageResult> {
  const adapter = currentAdapter();

  if (opts.cpbRoot) {
    const authority = path.join(path.resolve(opts.cpbRoot), INDEX_SUBPATH);
    if (opts.readOnly) return validateAuthorityDir(adapter, authority, true, "explicit");
    return createAuthorityDir(adapter, authority, "explicit");
  }

  const tmpResult = await resolveTmpRoot(adapter);
  if (!tmpResult.ok) return { ok: false, reason: (tmpResult as StorageFail).reason, code: (tmpResult as StorageFail).code };

  const uid = adapter.getuid();
  const userDir = path.join(tmpResult.tmpRoot, `${USER_DIR_PREFIX}${uid}`);
  const authority = path.join(userDir, INDEX_SUBPATH);

  const staleTmp = await revalidatePinned(adapter, tmpResult.pinned, "temporary root");
  if (staleTmp) return staleTmp;

  if (!opts.readOnly) {
    try {
      await adapter.mkdirMode(userDir, 0o700);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code !== "EEXIST") {
        return fail("AUTHORITY_CREATE_FAILED", `failed to create user dir: ${userDir}: ${err}`);
      }
    }
  }

  const userInfo = await adapter.lstatNoFollow(userDir);
  if (!userInfo) {
    if (opts.readOnly) return fail("EXPLICIT_ROOT_MISSING", `user dir does not exist: ${userDir}`);
    return fail("AUTHORITY_CREATE_FAILED", `user dir missing after creation: ${userDir}`);
  }
  if (userInfo.isSymbolicLink()) return fail("UNSAFE_AUTHORITY_SYMLINK", `user dir is a symlink: ${userDir}`);
  if (userInfo.uid !== uid) return fail("UNSAFE_AUTHORITY_OWNER", `user dir owned by uid ${userInfo.uid}, expected ${uid}: ${userDir}`);
  if ((userInfo.mode & 0o077) !== 0) return fail("UNSAFE_AUTHORITY_MODE", `user dir has group/world bits: ${userDir}`);

  const staleUser = await revalidatePinned(adapter, {
    dev: userInfo.dev, ino: userInfo.ino, canonicalPath: await adapter.realpath(userDir),
  }, "user directory");
  if (staleUser) return staleUser;

  if (opts.readOnly) return validateAuthorityDir(adapter, authority, true, tmpResult.source);
  return createAuthorityDir(adapter, authority);
}
