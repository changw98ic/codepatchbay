/**
 * Local Code Index v2 — non-Git source observation.
 *
 * Walks a source tree that is NOT inside a Git repository, respecting CPB
 * ignore rules, without following symbolic links.  Every eligible file is
 * hashed (SHA-256) to produce an exact content-addressed inventory.
 *
 * Metadata (size, mtime, mode) is captured as planning information only —
 * it can hint at which files *might* have changed, but metadata alone never
 * proves freshness.  Only content hashing produces exact status.
 *
 * The returned payload mirrors the git-observer structure so downstream
 * consumers (change-plan, snapshot-store) see one unified source-state
 * shape regardless of whether the source lives in a Git repo or a plain
 * directory.
 *
 * Spec: docs/architecture/local-code-index-v2-spec.md section 8.2
 *       (Non-Git directories)
 *
 * Dependencies: node:fs/promises, node:path, node:crypto, contracts.ts,
 *               safe-files.ts, canonical-json.ts.
 */

import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { LocalCodeIndexUnavailableError } from "./contracts.js";
import { canonicalStringify } from "./canonical-json.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Pinned filesystem metadata for a single eligible file.
 *
 * Metadata is planning information only — it can suggest a file *might*
 * have changed, but it never proves freshness by itself.  Only the
 * `contentId` (SHA-256 of file bytes) establishes exact status.
 */
export type DirectoryFileMetadata = Readonly<{
  /** Absolute canonical path. */
  readonly absolutePath: string;
  /** Source-root-relative path using `/` separators. */
  readonly relativePath: string;
  /** Byte size from lstat. */
  readonly size: number;
  /** Nanosecond mtime as a string (BigInt serialized). */
  readonly mtimeNs: string;
  /** Nanosecond ctime as a string (BigInt serialized). */
  readonly ctimeNs: string;
  /** File mode (permission bits). */
  readonly mode: number;
  /** Device ID as a string (BigInt serialized). */
  readonly device: string;
  /** Inode number as a string (BigInt serialized). */
  readonly inode: string;
  /** SHA-256 hex digest of the file's content bytes. */
  readonly contentId: string;
}>;

/**
 * Complete source-state payload returned by the directory observer.
 *
 * This structure is intentionally compatible with the git-observer output
 * so that change-plan and snapshot-store can consume either without
 * branching on repository kind.
 */
export type DirectorySourceState = Readonly<{
  /** Always `"non-git"` for directory observation. */
  readonly repositoryKind: "non-git";

  /** Canonical absolute path of the observed source root. */
  readonly sourcePath: string;

  /**
   * Sorted inventory: relative path -> content metadata.
   * Keys are source-root-relative using `/` separators.
   */
  readonly inventory: Readonly<Record<string, DirectoryFileMetadata>>;

  /**
   * Sorted list of relative paths that were excluded by ignore rules
   * or symlink/special-file rejection.  Diagnostic only.
   */
  readonly excludedPaths: readonly string[];

  /**
   * Sorted list of relative paths that are symbolic links and were
   * skipped (never followed).  Diagnostic only.
   */
  readonly symlinkPaths: readonly string[];

  /**
   * Canonical JSON bytes of this payload (excluding this field).
   * Used for byte-stable comparison between first and second observations.
   */
  readonly canonicalHash: string;

  /**
   * Timestamp when the observation started (ISO 8601).
   * Diagnostic only — never part of the canonical hash.
   */
  readonly observedAt: string;
}>;

// ── CPB Ignore Rules ──────────────────────────────────────────────────────────

/**
 * Default ignore patterns for non-Git source trees.
 *
 * These mirror the common patterns from the project's .gitignore plus
 * additional CPB-specific runtime directories.  Patterns use glob-style
 * matching where:
 *   - `*` matches any characters except `/`
 *   - `**` matches any path segments
 *   - Leading `/` anchors to the source root
 *   - Trailing `/` means directory only
 *
 * The patterns are evaluated against source-root-relative paths using
 * forward slashes.
 */
const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  // ── Dependencies ────────────────────────────────────────────────────────
  "node_modules/",

  // ── Build outputs ───────────────────────────────────────────────────────
  "dist/",
  "build/",
  "coverage/",
  ".dist/",

  // ── CPB runtime state ──────────────────────────────────────────────────
  "flow-task/",
  "cpb-task/",
  "cpb-test/",
  ".cpb-evaluations/",
  ".cpb-recovery/",
  ".cpb-local-index/",

  // ── Logs and OS files ──────────────────────────────────────────────────
  "*.log",
  ".DS_Store",
  "Thumbs.db",

  // ── Editor/IDE directories ─────────────────────────────────────────────
  ".vscode/",
  ".idea/",

  // ── Version control (non-Git, but be safe) ─────────────────────────────
  ".git/",
  ".hg/",
  ".svn/",

  // ── Temporary files ────────────────────────────────────────────────────
  "*.tmp",
  "*.temp",
  "*.swp",
  "*.swo",
  "*~",

  // ── Environment and secrets ─────────────────────────────────────────────
  ".env",
  ".env.*",

  // ── OS-specific ─────────────────────────────────────────────────────────
  ".Spotlight-V100/",
  ".Trashes/",
  "._*",
];

// ── Pattern Matching ──────────────────────────────────────────────────────────

/**
 * Test whether a relative path matches any of the ignore patterns.
 *
 * The path uses `/` separators and is relative to the source root.
 * Patterns are matched case-sensitively.
 *
 * @param relativePath - Source-root-relative path with `/` separators.
 * @param patterns - Ignore patterns to test against.
 * @returns `true` if the path should be excluded.
 */
export function isPathIgnored(
  relativePath: string,
  patterns: readonly string[],
): boolean {
  const segments = relativePath.split("/");
  const filename = segments[segments.length - 1] ?? "";

  for (const pattern of patterns) {
    if (matchPattern(pattern, relativePath, segments, filename)) {
      return true;
    }
  }
  return false;
}

/**
 * Match a single pattern against a path.
 *
 * Supports:
 *   - Exact filename match: `"node_modules"` matches any `node_modules` segment
 *   - Directory suffix: `"dist/"` matches `dist` as a directory segment
 *   - Extension glob: `"*.log"` matches any file ending in `.log`
 *   - Root anchor: `"/root-only"` matches only at the source root
 *   - Double-star: `"star-star/pattern"` matches at any depth
 */
function matchPattern(
  pattern: string,
  relativePath: string,
  segments: string[],
  filename: string,
): boolean {
  let p = pattern;

  // Root-anchored patterns only match at the top level.
  const isRootAnchored = p.startsWith("/");
  if (isRootAnchored) {
    p = p.slice(1);
  }

  // Directory-only patterns (trailing `/`).
  const isDirOnly = p.endsWith("/");
  if (isDirOnly) {
    p = p.slice(0, -1);
  }

  // Handle `**` prefix: match at any depth.
  if (p.startsWith("**/")) {
    const inner = p.slice(3);
    return matchSimplePattern(inner, relativePath, segments, filename, false);
  }

  // Handle `**` suffix: match any suffix.
  if (p.endsWith("/**")) {
    const prefix = p.slice(0, -3);
    // Check if any segment matches the prefix.
    return segments.some((seg) => matchSimplePattern(prefix, seg, [seg], seg, false));
  }

  // Regular pattern.
  return matchSimplePattern(p, relativePath, segments, filename, isRootAnchored);
}

/**
 * Simple pattern matching without `**` handling.
 */
function matchSimplePattern(
  pattern: string,
  relativePath: string,
  segments: string[],
  filename: string,
  rootAnchored: boolean,
): boolean {
  // If root-anchored, only match against the first segment.
  if (rootAnchored) {
    if (segments.length > 1) return false;
    return matchGlob(pattern, filename);
  }

  // Check if the pattern matches any path segment.
  for (const segment of segments) {
    if (matchGlob(pattern, segment)) {
      return true;
    }
  }

  // Also check against the full relative path for patterns like `*.log`.
  return matchGlob(pattern, relativePath);
}

/**
 * Simple glob matching supporting `*` (any chars except `/`).
 *
 * Does NOT support `?` or character classes — only `*` wildcards.
 */
function matchGlob(pattern: string, text: string): boolean {
  // Exact match.
  if (pattern === text) return true;

  // No wildcard: must be exact.
  if (!pattern.includes("*")) return false;

  // Convert glob to regex.
  const regexStr = "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$";
  try {
    return new RegExp(regexStr).test(text);
  } catch {
    // Invalid pattern — don't match.
    return false;
  }
}

// ── Directory Walking ─────────────────────────────────────────────────────────

/**
 * Recursively walk a directory tree, collecting eligible files.
 *
 * Rules:
 *   - Symbolic links are detected via `lstat` and NEVER followed.
 *   - Only regular files are included in the inventory.
 *   - Directories matching ignore patterns are pruned (not descended).
 *   - File paths are normalized to source-root-relative with `/` separators.
 *
 * @param dirPath - Absolute path to the directory to walk.
 * @param sourceRoot - Absolute canonical source root.
 * @param ignorePatterns - Patterns to exclude.
 * @param signal - Optional abort signal.
 * @returns Accumulated file paths (absolute) and excluded/skipped paths.
 */
async function walkDirectory(
  dirPath: string,
  sourceRoot: string,
  ignorePatterns: readonly string[],
  signal?: AbortSignal,
): Promise<{
  files: string[];
  excluded: string[];
  symlinks: string[];
}> {
  const files: string[] = [];
  const excluded: string[] = [];
  const symlinks: string[] = [];

  const stack: string[] = [dirPath];

  while (stack.length > 0) {
    if (signal?.aborted) {
      throw new LocalCodeIndexUnavailableError("operation_aborted", {
        sourcePath: sourceRoot,
      });
    }

    const current = stack.pop()!;
    const relativePath = path.relative(sourceRoot, current);
    const normalizedRelative = relativePath.split(path.sep).join("/");

    // Check if this directory itself is ignored (skip the root).
    if (normalizedRelative !== "" && isPathIgnored(normalizedRelative, ignorePatterns)) {
      excluded.push(normalizedRelative);
      continue;
    }

    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (err: unknown) {
      // Permission errors or transient failures — skip this directory.
      if ((err as NodeJS.ErrnoException).code === "EACCES" || (err as NodeJS.ErrnoException).code === "EPERM") {
        if (normalizedRelative !== "") {
          excluded.push(`${normalizedRelative} (permission denied)`);
        }
        continue;
      }
      throw err;
    }

    // Sort entries for deterministic ordering.
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (signal?.aborted) {
        throw new LocalCodeIndexUnavailableError("operation_aborted", {
          sourcePath: sourceRoot,
        });
      }

      const entryPath = path.join(current, entry.name);
      const entryRelative = normalizedRelative
        ? `${normalizedRelative}/${entry.name}`
        : entry.name;

      // Check ignore patterns against the entry name and relative path.
      if (isPathIgnored(entryRelative, ignorePatterns)) {
        excluded.push(entryRelative);
        continue;
      }

      // Use lstat to detect symlinks without following them.
      let entryStat;
      try {
        entryStat = await lstat(entryPath);
      } catch (err: unknown) {
        // File might have been deleted between readdir and lstat.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          excluded.push(`${entryRelative} (vanished)`);
          continue;
        }
        throw err;
      }

      if (entryStat.isSymbolicLink()) {
        symlinks.push(entryRelative);
        continue;
      }

      if (entryStat.isDirectory()) {
        stack.push(entryPath);
      } else if (entryStat.isFile()) {
        files.push(entryPath);
      }
      // Skip other file types (sockets, FIFOs, block devices, etc.)
    }
  }

  return { files, excluded, symlinks };
}

// ── File Hashing ──────────────────────────────────────────────────────────────

/**
 * Hash a single file's content using SHA-256, reading through a pinned
 * file descriptor with O_NOFOLLOW.
 *
 * Also captures filesystem metadata (size, mtimeNs, ctimeNs, mode, dev, ino)
 * as planning information.
 *
 * @param absolutePath - Absolute path to the file.
 * @param relativePath - Source-root-relative path with `/` separators.
 * @param sourceRoot - Canonical source root (for error messages).
 * @returns File metadata including content hash.
 */
async function hashFile(
  absolutePath: string,
  relativePath: string,
  sourceRoot: string,
): Promise<DirectoryFileMetadata> {
  // Open with O_NOFOLLOW to reject symlinks at the fd level.
  // We already checked via lstat, but this is defense in depth.
  const O_NOFOLLOW = 0x100; // Platform-independent constant
  const O_RDONLY = 0x0;

  let fh;
  try {
    fh = await open(absolutePath, O_RDONLY | O_NOFOLLOW);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") {
      throw new LocalCodeIndexUnavailableError("source_changed_during_index", {
        sourcePath: absolutePath,
        cause: err,
      });
    }
    throw err;
  }

  try {
    // Get file stats from the open handle (pinned identity).
    const handleStat = await fh.stat({ bigint: true });

    // Read file content.
    const size = Number(handleStat.size);
    const buffer = new Uint8Array(size);
    let totalRead = 0;

    while (totalRead < size) {
      const { bytesRead } = await fh.read(buffer, totalRead, size - totalRead, totalRead);
      if (bytesRead === 0) break; // EOF
      totalRead += bytesRead;
    }

    if (totalRead !== size) {
      throw new LocalCodeIndexUnavailableError("source_changed_during_index", {
        sourcePath: absolutePath,
      });
    }

    // Hash the content.
    const contentId = createHash("sha256").update(buffer).digest("hex");

    return {
      absolutePath,
      relativePath,
      size,
      mtimeNs: handleStat.mtimeNs.toString(),
      ctimeNs: handleStat.ctimeNs.toString(),
      mode: Number(handleStat.mode),
      device: handleStat.dev.toString(),
      inode: handleStat.ino.toString(),
      contentId,
    };
  } finally {
    await fh.close();
  }
}

// ── Main Observer ─────────────────────────────────────────────────────────────

export interface ObserveDirectoryOptions {
  /** Absolute canonical source path. */
  readonly sourcePath: string;

  /**
   * Additional ignore patterns to merge with the defaults.
   * Patterns follow the same syntax as DEFAULT_IGNORE_PATTERNS.
   */
  readonly additionalIgnorePatterns?: readonly string[];

  /** Abort signal for cancellation. */
  readonly signal?: AbortSignal;
}

/**
 * Observe a non-Git source directory and produce a deterministic
 * source-state payload.
 *
 * The observation:
 *   1. Walks the source tree respecting CPB ignore rules.
 *   2. Skips symbolic links (never follows them).
 *   3. Hashes every eligible regular file (SHA-256 of content bytes).
 *   4. Captures filesystem metadata as planning information only.
 *   5. Produces a canonical-hash-stable payload for comparison.
 *
 * The returned structure is compatible with git-observer output so
 * downstream consumers (change-plan, snapshot-store) see one unified
 * source-state shape.
 *
 * @param options - Observation configuration.
 * @returns Deterministic source-state payload.
 *
 * @throws {LocalCodeIndexUnavailableError} with reason `"unsafe_source_path"`
 *   if the source path is invalid or inaccessible.
 * @throws {LocalCodeIndexUnavailableError} with reason `"operation_aborted"`
 *   if the signal fires before completion.
 */
export async function observeDirectory(
  options: ObserveDirectoryOptions,
): Promise<DirectorySourceState> {
  const { sourcePath, signal } = options;

  // Resolve and validate the source path.
  let canonicalSource: string;
  try {
    canonicalSource = await realpath(sourcePath);
  } catch (err: unknown) {
    throw new LocalCodeIndexUnavailableError("unsafe_source_path", {
      sourcePath,
      cause: err,
    });
  }

  // Verify it's a directory.
  let sourceStat;
  try {
    sourceStat = await lstat(canonicalSource);
  } catch (err: unknown) {
    throw new LocalCodeIndexUnavailableError("unsafe_source_path", {
      sourcePath: canonicalSource,
      cause: err,
    });
  }

  if (!sourceStat.isDirectory()) {
    throw new LocalCodeIndexUnavailableError("unsafe_source_path", {
      sourcePath: canonicalSource,
    });
  }

  // Merge ignore patterns.
  const ignorePatterns = [
    ...DEFAULT_IGNORE_PATTERNS,
    ...(options.additionalIgnorePatterns ?? []),
  ];

  // Walk the directory tree.
  const { files, excluded, symlinks } = await walkDirectory(
    canonicalSource,
    canonicalSource,
    ignorePatterns,
    signal,
  );

  // Sort files for deterministic processing order.
  files.sort();

  // Hash each file and build the inventory.
  const inventory: Record<string, DirectoryFileMetadata> = {};

  for (const filePath of files) {
    if (signal?.aborted) {
      throw new LocalCodeIndexUnavailableError("operation_aborted", {
        sourcePath: canonicalSource,
      });
    }

    const relativePath = path.relative(canonicalSource, filePath);
    const normalizedRelative = relativePath.split(path.sep).join("/");

    try {
      const metadata = await hashFile(filePath, normalizedRelative, canonicalSource);
      inventory[normalizedRelative] = metadata;
    } catch (err: unknown) {
      // If the file vanished during hashing, skip it.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        excluded.push(`${normalizedRelative} (vanished during hash)`);
        continue;
      }
      throw err;
    }
  }

  // Sort excluded and symlink lists for determinism.
  excluded.sort();
  symlinks.sort();

  // Build the payload without the canonicalHash field first.
  const observedAt = new Date().toISOString();

  const payloadBase: Omit<DirectorySourceState, "canonicalHash"> = {
    repositoryKind: "non-git",
    sourcePath: canonicalSource,
    inventory,
    excludedPaths: excluded,
    symlinkPaths: symlinks,
    observedAt,
  };

  // Compute canonical hash of the payload (excluding observedAt and the hash itself).
  // We hash the deterministic parts: repositoryKind, sourcePath, inventory, excludedPaths, symlinkPaths.
  const canonicalPayload = {
    repositoryKind: payloadBase.repositoryKind,
    sourcePath: payloadBase.sourcePath,
    inventory: payloadBase.inventory,
    excludedPaths: payloadBase.excludedPaths,
    symlinkPaths: payloadBase.symlinkPaths,
  };
  const canonicalBytes = canonicalStringify(canonicalPayload);
  const canonicalHash = createHash("sha256").update(canonicalBytes, "utf8").digest("hex");

  return {
    ...payloadBase,
    canonicalHash,
  };
}

/**
 * Compare two directory source-state payloads for exact equality.
 *
 * Returns `true` if the inventories are byte-identical (same content IDs,
 * same paths, same metadata).  Used to detect source changes between
 * initial and final observations during publication.
 *
 * @param first - First observation.
 * @param second - Second observation.
 * @returns `true` if both payloads have the same canonical hash.
 */
export function areSourceStatesEqual(
  first: DirectorySourceState,
  second: DirectorySourceState,
): boolean {
  return first.canonicalHash === second.canonicalHash;
}

/**
 * Compute the source key for a non-Git directory.
 *
 * For non-Git directories, both the repository key and worktree key
 * inputs are the same canonical source path.
 *
 * @param canonicalSourcePath - Canonical absolute source path.
 * @returns Source key (SHA-256 hex).
 */
export function computeDirectorySourceKey(
  canonicalSourcePath: string,
): string {
  const REPOSITORY_PREFIX = "cpb-local-index-v2-repository\0";
  const WORKTREE_PREFIX = "cpb-local-index-v2-worktree\0";

  const repositoryKey = createHash("sha256")
    .update(REPOSITORY_PREFIX)
    .update(canonicalSourcePath)
    .digest("hex")
    .slice(0, 32);

  const worktreeKey = createHash("sha256")
    .update(WORKTREE_PREFIX)
    .update(canonicalSourcePath)
    .digest("hex")
    .slice(0, 32);

  const sourceKey = createHash("sha256")
    .update(repositoryKey)
    .update("\0")
    .update(worktreeKey)
    .digest("hex");

  return sourceKey;
}
