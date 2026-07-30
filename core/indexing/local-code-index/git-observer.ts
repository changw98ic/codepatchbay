/**
 * Local Code Index v2 — exact Git inventory and second observation.
 *
 * Runs the approved Git inventory sequence (spec section 8.1) under fixed
 * environment and configuration, produces a deterministic source-state
 * payload, and repeats the complete observation to verify stability.
 *
 * Every Git command uses:
 *   GIT_OPTIONAL_LOCKS=0
 *   GIT_CONFIG_NOSYSTEM=1
 *   GIT_CONFIG_GLOBAL=<platform-null-device>
 *   git -c core.fsmonitor=false
 *       -c core.untrackedCache=false
 *       -c core.ignoreStat=false
 *       -c core.trustctime=true
 *       -c core.checkStat=default
 *       -c diff.external=
 *
 * The implementation rejects the inventory with
 * reason: "unsupported_git_state" when it finds:
 *   - more than one non-zero stage for a path;
 *   - mode 160000 or any submodule state;
 *   - assume-unchanged;
 *   - skip-worktree or sparse-index entries;
 *   - FSMonitor-valid entries;
 *   - a command-backed clean, smudge, or process filter;
 *   - an attribute or materialization configuration that cannot be parsed exactly;
 *   - an external diff requirement;
 *   - a path outside the canonical worktree;
 *   - a symbolic link or unsupported special file.
 *
 * Spec: docs/architecture/local-code-index-v2-spec.md section 8.1
 * Dependencies: node:child_process, node:crypto, node:os, node:path,
 *               contracts.ts, canonical-json.ts.
 */

import { execFile } from "node:child_process";
import { devNull } from "node:os";
import path from "node:path";
import { lstat } from "node:fs/promises";

import { LocalCodeIndexUnavailableError } from "./contracts.js";
import { canonicalStringify } from "./canonical-json.js";

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * Pinned filesystem metadata for an eligible path.
 *
 * Spec section 8.1: "Each persisted path includes a pinned metadata identity."
 * Fields are strings to avoid BigInt serialization ambiguity.
 */
export type PinnedMetadata = Readonly<{
  device: string;
  inode: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  mode: number;
}>;

/**
 * Stage entry from `git ls-files --stage`.
 *
 * A path may have at most one non-zero stage entry; more than one is rejected.
 * Mode 160000 (submodule) is rejected.
 */
export type StageEntry = Readonly<{
  mode: string;
  blobId: string;
  stage: number;
  path: string;
}>;

/**
 * Attribute values for a tracked path.
 *
 * Derived from `git check-attr -z --stdin filter ident working-tree-encoding
 * text eol` for every eligible tracked path.
 */
export type PathAttributes = Readonly<{
  filter: string | null;
  ident: string | null;
  workingTreeEncoding: string | null;
  text: string | null;
  eol: string | null;
}>;

/**
 * Effective materialization configuration from `git config`.
 *
 * Reads repository-local config without includes. Missing values use
 * Git's documented canonical defaults.
 *
 * Note: distinct from the downstream `MaterializationConfig` in change-plan.ts
 * which uses boolean/enum types. This type preserves the raw Git config strings.
 */
export type GitMaterializationConfig = Readonly<{
  /** Effective core.autocrlf (default: "false"). */
  autocrlf: string;
  /** Origin of effective core.autocrlf. */
  autocrlfOrigin: string | null;
  /** Effective core.eol (default: "native"). */
  eol: string;
  /** Origin of effective core.eol. */
  eolOrigin: string | null;
  /** Effective core.attributesFile (default: null). */
  attributesFile: string | null;
  /** Origin of effective core.attributesFile. */
  attributesFileOrigin: string | null;
}>;

/**
 * Filter configuration from `git config`.
 *
 * Each entry records the filter name, the key (clean/smudge/process/required),
 * the value, and the origin file.
 */
export type FilterConfigEntry = Readonly<{
  key: string;
  value: string;
  origin: string;
}>;

/**
 * Porcelain v2 status entry for a single path.
 *
 * `statusCode` is the two-character XY code from porcelain v2 output.
 * `path` is the canonical relative path.
 * `origPath` is present only for renames (R line).
 */
export type PorcelainEntry = Readonly<{
  statusCode: string;
  path: string;
  origPath: string | null;
}>;

/**
 * Entry in the inventory: one eligible tracked or untracked file.
 *
 * Combines stage, attributes, eol info, status, and pinned metadata.
 *
 * For tracked files deleted from the working tree (porcelain status .D),
 * `present` is false and `metadata` is null.  The observer never calls
 * lstat on a Git-proven absent path.
 */
export type InventoryEntry = Readonly<{
  /** Canonical relative path (forward slashes). */
  path: string;
  /** Stage entry (null for untracked files). */
  stage: StageEntry | null;
  /** Attributes from check-attr. */
  attributes: PathAttributes;
  /** Eol info from ls-files --eol. */
  eolInfo: string;
  /** Status from porcelain v2 (null if clean). */
  porcelain: PorcelainEntry | null;
  /** Whether the file is present in the working tree. */
  present: boolean;
  /** Pinned filesystem metadata (null when present is false). */
  metadata: PinnedMetadata | null;
}>;

/**
 * Complete deterministic source-state payload.
 *
 * Every field is sorted where order is not semantically significant.
 * Canonical JSON serialization produces byte-identical output for
 * identical source state.
 *
 * Spec section 8.1 step 12-13: "reconstructs the complete canonical
 * source-state payload, including repository and HEAD identity, stage
 * entries, attributes, materialization configuration and origins,
 * porcelain status, untracked paths, and pinned filesystem metadata".
 */
export type SourceStatePayload = Readonly<{
  /** Canonical absolute source path. */
  sourcePath: string;
  /** Absolute path to the Git common directory. */
  commonDir: string;
  /** Git object format ("sha1" or "sha256"). */
  objectFormat: string;
  /** HEAD commit hash (null if no commits). */
  headCommit: string | null;
  /** Current branch name (null if detached HEAD). */
  branch: string | null;
  /** Effective materialization configuration. */
  materializationConfig: GitMaterializationConfig;
  /** Filter configuration entries (sorted by key). */
  filterConfigs: readonly FilterConfigEntry[];
  /** Inventory entries (sorted by canonical path). */
  entries: readonly InventoryEntry[];
}>;

/**
 * Result of a source observation.
 *
 * Spec section 8.1: "Return { state: clean or changed, payload }."
 */
export type GitObservationResult = Readonly<{
  state: "clean" | "changed";
  payload: SourceStatePayload;
}>;

// ── Git command execution ──────────────────────────────────────────────────────

/**
 * Fixed environment for all Git commands.
 *
 * Disables optional locks, system config, and global config.
 */
function buildGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
  };
}

/**
 * Fixed Git arguments prepended to every command.
 *
 * Disables fsmonitor, untracked cache, ignoreStat, enables trustctime,
 * sets checkStat=default, and clears external diff.
 */
const FIXED_GIT_ARGS: readonly string[] = [
  "-c", "core.fsmonitor=false",
  "-c", "core.untrackedCache=false",
  "-c", "core.ignoreStat=false",
  "-c", "core.trustctime=true",
  "-c", "core.checkStat=default",
  "-c", "diff.external=",
];

/**
 * Execute a Git command and return its stdout.
 *
 * @param cwd Working directory for the command.
 * @param args Arguments after the fixed configuration flags.
 * @param options.maxBuffer Maximum stdout bytes (default 50 MiB).
 * @param options.stdin Optional stdin data to pipe into the command.
 * @returns stdout as a string.
 * @throws LocalCodeIndexUnavailableError on non-zero exit or signal.
 */
async function git(
  cwd: string,
  args: readonly string[],
  options?: Readonly<{ maxBuffer?: number; stdin?: string }>,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      "git",
      [...FIXED_GIT_ARGS, ...args],
      {
        cwd,
        env: buildGitEnv(),
        maxBuffer: options?.maxBuffer ?? 50 * 1024 * 1024,
        encoding: "utf8",
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new LocalCodeIndexUnavailableError("unsupported_git_state", {
              sourcePath: cwd,
              cause: new Error(
                `git ${args[0]} failed (exit ${error.code ?? "?"}): ${stderr ?? ""}`.trim(),
              ),
            }),
          );
          return;
        }
        resolve(stdout);
      },
    );

    if (options?.stdin !== undefined) {
      child.stdin?.write(options.stdin);
      child.stdin?.end();
    }
  });
}

/**
 * Execute a Git command that uses NUL-delimited output (-z).
 *
 * Returns the raw stdout buffer split on NUL bytes, filtering empty
 * trailing entries.
 */
async function gitZ(
  cwd: string,
  args: readonly string[],
  options?: Readonly<{ maxBuffer?: number; stdin?: string }>,
): Promise<string[]> {
  const stdout = await git(cwd, args, options);
  // Split on NUL, filter empty trailing entries.
  const parts = stdout.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

// ── Parsing helpers ────────────────────────────────────────────────────────────

/**
 * Normalize a path to use forward slashes and be relative to the source root.
 *
 * Rejects paths that escape the source root.
 */
function normalizePath(input: string, sourcePath: string): string {
  // Convert backslashes to forward slashes (Windows Git may emit them).
  const forward = input.replace(/\\/g, "/");
  // Resolve relative to source path.
  const resolved = path.resolve(sourcePath, forward);
  const rel = path.relative(sourcePath, resolved);
  // Reject paths outside the source root.
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new LocalCodeIndexUnavailableError("unsupported_git_state", {
      sourcePath,
    });
  }
  return rel;
}

/**
 * Parse a NUL-delimited check-attr output line.
 *
 * Format: `<path>\0<attr>\0<info>\0<path>\0<attr>\0<info>\0...`
 * Each triplet is (path, attribute-name, attribute-value).
 *
 * Returns a map from normalized path to its attribute values.
 */
function parseCheckAttrOutput(
  parts: string[],
  sourcePath: string,
): Map<string, PathAttributes> {
  const attrs = new Map<string, PathAttributes>();

  // check-attr produces triplets: path, attribute, info
  if (parts.length % 3 !== 0) {
    throw new LocalCodeIndexUnavailableError("unsupported_git_state", {
      sourcePath,
    });
  }

  for (let i = 0; i < parts.length; i += 3) {
    const rawPath = parts[i]!;
    const attrName = parts[i + 1]!;
    const attrValue = parts[i + 2]!;

    const normalized = normalizePath(rawPath, sourcePath);
    const existing = attrs.get(normalized) ?? {
      filter: null,
      ident: null,
      workingTreeEncoding: null,
      text: null,
      eol: null,
    };

    const effectiveValue = attrValue === "unspecified" ? null : attrValue;

    switch (attrName) {
      case "filter":
        attrs.set(normalized, { ...existing, filter: effectiveValue });
        break;
      case "ident":
        attrs.set(normalized, { ...existing, ident: effectiveValue });
        break;
      case "working-tree-encoding":
        attrs.set(normalized, {
          ...existing,
          workingTreeEncoding: effectiveValue,
        });
        break;
      case "text":
        attrs.set(normalized, { ...existing, text: effectiveValue });
        break;
      case "eol":
        attrs.set(normalized, { ...existing, eol: effectiveValue });
        break;
      default:
        // Ignore unknown attributes.
        break;
    }
  }

  return attrs;
}

/**
 * Parse a NUL-delimited ls-files --eol output line.
 *
 * Format: `i/<info> w/<info> attr/<attrs>\t<path>\0...`
 * Each entry is tab-separated: metadata and path.
 *
 * Returns a map from normalized path to its eol info string.
 */
function parseEolOutput(
  parts: string[],
  sourcePath: string,
): Map<string, string> {
  const result = new Map<string, string>();

  for (const part of parts) {
    if (!part) continue;
    const tabIndex = part.indexOf("\t");
    if (tabIndex < 0) continue;

    const info = part.substring(0, tabIndex);
    const rawPath = part.substring(tabIndex + 1);
    const normalized = normalizePath(rawPath, sourcePath);
    result.set(normalized, info);
  }

  return result;
}

/**
 * Parse a NUL-delimited ls-files --stage output.
 *
 * Format: `<mode> <blob> <stage>\t<path>\0...`
 * Rejects more than one non-zero stage per path and mode 160000 (submodule).
 *
 * Returns a map from normalized path to its stage entry.
 */
function parseStageOutput(
  parts: string[],
  sourcePath: string,
): Map<string, StageEntry> {
  const stages = new Map<string, StageEntry>();

  for (const part of parts) {
    if (!part) continue;
    const tabIndex = part.indexOf("\t");
    if (tabIndex < 0) continue;

    const meta = part.substring(0, tabIndex);
    const rawPath = part.substring(tabIndex + 1);
    const metaParts = meta.split(" ");
    if (metaParts.length !== 3) {
      throw new LocalCodeIndexUnavailableError("unsupported_git_state", {
        sourcePath,
      });
    }

    const [mode, blobId, stageStr] = metaParts as [string, string, string];
    const stage = parseInt(stageStr, 10);

    if (mode === "160000") {
      throw new LocalCodeIndexUnavailableError("unsupported_git_state", {
        sourcePath,
      });
    }

    const normalized = normalizePath(rawPath, sourcePath);
    const existing = stages.get(normalized);

    // Reject more than one non-zero stage for a path.
    if (existing !== undefined && (stage !== 0 || existing.stage !== 0)) {
      throw new LocalCodeIndexUnavailableError("unsupported_git_state", {
        sourcePath,
      });
    }

    stages.set(normalized, { mode, blobId, stage, path: normalized });
  }

  return stages;
}

/**
 * Parse ls-files -v output (lowercase flags indicate assume-unchanged,
 * skip-worktree, FSMonitor-valid, etc.).
 *
 * Format: `H <path>\0...` or `S <path>\0...` or `M <path>\0...` etc.
 * Lowercase letters indicate assume-unchanged; S indicates skip-worktree;
 * F indicates FSMonitor-valid.
 *
 * Returns a set of paths that have special flags.
 */
function parseAssumeOutput(
  parts: string[],
  sourcePath: string,
): Set<string> {
  const specialPaths = new Set<string>();

  for (const part of parts) {
    if (!part) continue;

    // git ls-files -v outputs `<flag> <path>` with a single space between
    // the one-character flag and the path.  With -z, each entry is
    // NUL-terminated.  Some older Git versions may use a tab; handle both.
    let flags: string;
    let rawPath: string;
    const tabIndex = part.indexOf("\t");
    if (tabIndex >= 0) {
      flags = part.substring(0, tabIndex);
      rawPath = part.substring(tabIndex + 1);
    } else if (part.length >= 2 && part[1] === " ") {
      // Standard format: single-char flag, space, then path.
      flags = part.substring(0, 1);
      rawPath = part.substring(2);
    } else {
      // Unrecognised format — skip.
      continue;
    }
    const normalized = normalizePath(rawPath, sourcePath);

    // Lowercase flag letters indicate assume-unchanged.
    // 'S' in the flags means skip-worktree.
    // 'F' in the flags means FSMonitor-valid.
    // We check for any lowercase letter (assume-unchanged),
    // 'S' (skip-worktree), or 'F' (FSMonitor-valid).
    const hasLowercase = flags.split("").some(
      (c) => c >= "a" && c <= "z",
    );
    const hasSkipWorktree = flags.includes("S");
    const hasFsmonitor = flags.includes("F");

    if (hasLowercase || hasSkipWorktree || hasFsmonitor) {
      specialPaths.add(normalized);
    }
  }

  return specialPaths;
}

/**
 * Parse ls-files -f output (files not in the index but present in the
 * working tree, i.e., untracked files that would be shown by status).
 *
 * Format: `<path>\0...`
 *
 * Some Git versions (e.g. macOS Apple Git 2.50) emit `-f` entries with
 * the same status-prefix format as `-v`: `<flag> <path>\0`.  When a
 * tab separator is absent but the entry matches the single-char-flag
 * plus-space pattern, the prefix is stripped before normalizing.
 *
 * Returns a set of paths.
 */
function parseForceOutput(
  parts: string[],
  sourcePath: string,
): Set<string> {
  const paths = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    // Some Git versions prefix entries with a single-char status flag
    // followed by a space (same format as ls-files -v).  Strip it.
    let raw = part;
    const tabIndex = part.indexOf("\t");
    if (tabIndex >= 0) {
      raw = part.substring(tabIndex + 1);
    } else if (part.length >= 2 && part[1] === " " && /^[A-Z?]$/i.test(part[0]!)) {
      raw = part.substring(2);
    }
    paths.add(normalizePath(raw, sourcePath));
  }
  return paths;
}

/**
 * Parse git status --porcelain=v2 -z output.
 *
 * Porcelain v2 format:
 *   Ordinary:   `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>\0`
 *   Renamed:    `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>\0`
 *   Unmerged:   `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>\0`
 *   Untracked:  `? <path>\0`
 *   Ignored:    `! <path>\0`
 *
 * We only care about path and status code for the inventory.
 * Unmerged entries are rejected.
 */
function parsePorcelainOutput(
  parts: string[],
  sourcePath: string,
): Map<string, PorcelainEntry> {
  const entries = new Map<string, PorcelainEntry>();
  let i = 0;

  while (i < parts.length) {
    const line = parts[i]!;
    if (!line) {
      i++;
      continue;
    }

    const kind = line[0];

    if (kind === "1") {
      // Ordinary change: 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const fields = line.split(" ");
      if (fields.length < 9) {
        throw new LocalCodeIndexUnavailableError("unsupported_git_state", {
          sourcePath,
        });
      }
      const statusCode = fields[1]!;
      const rawPath = fields[8]!;
      const normalized = normalizePath(rawPath, sourcePath);
      entries.set(normalized, {
        statusCode,
        path: normalized,
        origPath: null,
      });
      i++;
    } else if (kind === "2") {
      // Renamed: 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
      // Fields: [0]=2 [1]=XY [2]=sub [3]=mH [4]=mI [5]=mW [6]=hH [7]=hI [8]=Xscore [9]=path
      const fields = line.split(" ");
      if (fields.length < 10) {
        throw new LocalCodeIndexUnavailableError("unsupported_git_state", {
          sourcePath,
        });
      }
      const statusCode = fields[1]!;
      const rawPath = fields[9]!;
      const normalized = normalizePath(rawPath, sourcePath);

      // Next part is the original path.
      i++;
      if (i >= parts.length) {
        throw new LocalCodeIndexUnavailableError("unsupported_git_state", {
          sourcePath,
        });
      }
      const origRawPath = parts[i]!;
      const origNormalized = normalizePath(origRawPath, sourcePath);

      entries.set(normalized, {
        statusCode,
        path: normalized,
        origPath: origNormalized,
      });
      i++;
    } else if (kind === "u") {
      // Unmerged entry — reject.
      throw new LocalCodeIndexUnavailableError("unsupported_git_state", {
        sourcePath,
      });
    } else if (kind === "?") {
      // Untracked file.
      const rawPath = line.substring(2);
      const normalized = normalizePath(rawPath, sourcePath);
      entries.set(normalized, {
        statusCode: "??",
        path: normalized,
        origPath: null,
      });
      i++;
    } else if (kind === "!") {
      // Ignored file — skip.
      i++;
    } else {
      // Unknown status line — skip.
      i++;
    }
  }

  return entries;
}

/**
 * Parse git config --null --show-origin output.
 *
 * With --null --show-origin, git emits alternating NUL-delimited records:
 *   `<origin>\0<key>\n<value>\0<origin>\0<key>\n<value>\0...`
 *
 * After gitZ splits on NUL, the parts array alternates between origin
 * strings and key\nvalue strings.  We pair them up.
 *
 * Returns entries as an array of { origin, key, value }.
 */
function parseConfigOutput(
  parts: string[],
  sourcePath: string,
): Array<{ origin: string; key: string; value: string }> {
  const entries: Array<{ origin: string; key: string; value: string }> = [];

  // Parts alternate: origin, key\nvalue, origin, key\nvalue, ...
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const origin = parts[i]!;
    const kv = parts[i + 1]!;
    if (!origin || !kv) continue;

    const newlineIndex = kv.indexOf("\n");
    if (newlineIndex < 0) continue;

    const key = kv.substring(0, newlineIndex);
    const value = kv.substring(newlineIndex + 1);
    entries.push({ origin, key, value });
  }

  return entries;
}

// ── Include detection in local config ──────────────────────────────────────────

/**
 * Read the local git config file and reject include.path and
 * includeIf.*.path entries.
 *
 * Spec section 2.3: "Before commands that can materialize or compare content,
 * the Git adapter reads repository-local configuration without expanding
 * includes. Any include.path or includeIf.*.path entry fails with
 * unsupported_git_state."
 *
 * The raw local config file is read through a bounded no-follow descriptor.
 * Git config uses INI format: [section] followed by key = value lines.
 * A `[include]` section with a `path` key resolves to the dotted key
 * `include.path`.  A `[includeIf "condition"]` section with a `path`
 * key resolves to `includeIf.<condition>.path`.
 */
async function rejectConfigIncludes(
  gitDir: string,
  sourcePath: string,
): Promise<void> {
  const configPath = path.join(gitDir, "config");

  let raw: string;
  try {
    const fs = await import("node:fs/promises");
    const content = await fs.readFile(configPath, "utf8");
    raw = content;
  } catch {
    return;
  }

  // Parse INI-style config to resolve dotted keys from section + key.
  let currentSection: string | null = null;
  const lines = raw.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }

    // Section header: [section] or [section "subsection"]
    const sectionMatch = trimmed.match(/^\[([^\]"]+)(?:\s+"([^"]*)")?\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1]!.toLowerCase();
      continue;
    }

    // Key = value line.  Resolve the dotted key from section + key.
    const kvMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9-]*)\s*=/);
    if (kvMatch && currentSection) {
      const key = kvMatch[1]!.toLowerCase();
      const dotted = `${currentSection}.${key}`;

      // Check for include.path (dotted key).
      if (dotted === "include.path") {
        throw new LocalCodeIndexUnavailableError("unsupported_git_state", {
          sourcePath,
        });
      }

      // Check for includeIf.*.path (dotted key starts with "includeif." and ends with ".path").
      if (currentSection === "includeif" && key === "path") {
        throw new LocalCodeIndexUnavailableError("unsupported_git_state", {
          sourcePath,
        });
      }
    }
  }
}

// ── Metadata pinning ──────────────────────────────────────────────────────────

/**
 * Pin filesystem metadata for a path using lstat (no-follow).
 *
 * Returns PinnedMetadata with string fields for device, inode, size,
 * mtimeNs, and ctimeNs, plus numeric mode.
 *
 * Spec section 8.1 step 13: "pinned filesystem metadata for every eligible path."
 */
async function pinMetadata(filePath: string): Promise<PinnedMetadata> {
  const st = await lstat(filePath, { bigint: true });

  if (st.isSymbolicLink()) {
    throw new LocalCodeIndexUnavailableError("unsupported_git_state", {
      sourcePath: filePath,
    });
  }

  if (!st.isFile()) {
    throw new LocalCodeIndexUnavailableError("unsupported_git_state", {
      sourcePath: filePath,
    });
  }

  return {
    device: String(st.dev),
    inode: String(st.ino),
    size: String(st.size),
    mtimeNs: String(st.mtimeNs),
    ctimeNs: String(st.ctimeNs),
    mode: Number(st.mode),
  };
}

const MAX_CONCURRENT_METADATA_READS = 64;

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]!, index);
    }
  }));
  return results;
}

// ── Filter config validation ──────────────────────────────────────────────────

/**
 * Validate that no command-backed filters are configured.
 *
 * Spec section 8.1: "a command-backed clean, smudge, or process filter"
 * triggers unsupported_git_state.
 *
 * We accept only "required" as a non-command filter key. Clean, smudge,
 * and process keys indicate command-backed filters.
 */
function rejectCommandBackedFilters(
  filterConfigs: readonly FilterConfigEntry[],
  sourcePath: string,
): void {
  for (const entry of filterConfigs) {
    // The key format is filter.<name>.<type> where type is
    // clean, smudge, process, or required.
    // We reject clean, smudge, and process as command-backed.
    if (
      entry.key.endsWith(".clean") ||
      entry.key.endsWith(".smudge") ||
      entry.key.endsWith(".process")
    ) {
      throw new LocalCodeIndexUnavailableError("unsupported_git_state", {
        sourcePath,
      });
    }
  }
}

// ── Validate attributesFile ───────────────────────────────────────────────────

/**
 * Validate that core.attributesFile, if set, is within the canonical
 * worktree or Git common directory.
 *
 * Spec section 8.1: "An effective core.attributesFile outside the
 * canonical worktree or Git common directory fails with unsupported_git_state."
 */
function validateAttributesFile(
  config: GitMaterializationConfig,
  sourcePath: string,
  commonDir: string,
): void {
  if (config.attributesFile === null) return;

  // Resolve the attributesFile path.
  // Git resolves relative paths against the home directory (which we
  // disabled) and then against the git dir. For simplicity, we check
  // if it's an absolute path within the allowed roots.
  const resolved = path.resolve(config.attributesFile);
  const inSource = !path.relative(sourcePath, resolved).startsWith("..");
  const inCommon = !path.relative(commonDir, resolved).startsWith("..");

  if (!inSource && !inCommon) {
    throw new LocalCodeIndexUnavailableError("unsupported_git_state", {
      sourcePath,
    });
  }
}

// ── Single observation ─────────────────────────────────────────────────────────

/**
 * Run the complete Git inventory sequence once and produce a
 * SourceStatePayload.
 *
 * Spec section 8.1 steps 1-13.
 *
 * @param sourcePath Canonical absolute source path.
 * @returns The complete source-state payload.
 */
async function observeOnce(sourcePath: string): Promise<SourceStatePayload> {
  // These repository identity reads are independent. Run them together so an
  // exact status check pays one process wait instead of five sequential waits.
  const [
    commonDirRaw,
    objectFormatRaw,
    headCommit,
    branch,
    gitDirRaw,
  ] = await Promise.all([
    git(sourcePath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]),
    git(sourcePath, ["rev-parse", "--show-object-format"]),
    git(sourcePath, ["rev-parse", "--verify", "HEAD"])
      .then((value) => value.trim() || null)
      .catch(() => null),
    git(sourcePath, ["symbolic-ref", "--quiet", "--short", "HEAD"])
      .then((value) => value.trim() || null)
      .catch(() => null),
    git(sourcePath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
    ]),
  ]);

  // ── Step 1: git rev-parse --path-format=absolute --git-common-dir ─────────
  const commonDir = commonDirRaw.trim();
  if (!commonDir) {
    throw new LocalCodeIndexUnavailableError("unsupported_git_state", {
      sourcePath,
    });
  }

  // ── Step 2: git rev-parse --show-object-format ───────────────────────────
  const objectFormat = objectFormatRaw.trim();
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new LocalCodeIndexUnavailableError("unsupported_git_state", {
      sourcePath,
    });
  }

  // ── Detect git dir for config include check ──────────────────────────────
  // We need the git dir to find the local config file.
  const gitDir = gitDirRaw.trim();

  // ── Step 3 (config include check): reject includes in local config ───────
  await rejectConfigIncludes(gitDir, sourcePath);

  // The three inventory reads are independent and use the same fixed Git
  // environment, so execute them concurrently.
  const [stageParts, assumeParts, forceParts] = await Promise.all([
    gitZ(sourcePath, ["ls-files", "--stage", "-z"]),
    gitZ(sourcePath, ["ls-files", "-v", "-z"]),
    gitZ(sourcePath, ["ls-files", "-f", "-z"]),
  ]);

  // ── Step 5: git ls-files --stage -z ──────────────────────────────────────
  const stageMap = parseStageOutput(stageParts, sourcePath);

  // ── Step 6: git ls-files -v -z ───────────────────────────────────────────
  const specialPaths = parseAssumeOutput(assumeParts, sourcePath);

  // Reject paths with special flags (assume-unchanged, skip-worktree,
  // FSMonitor-valid).
  for (const p of specialPaths) {
    throw new LocalCodeIndexUnavailableError("unsupported_git_state", {
      sourcePath,
    });
  }

  // ── Step 7: git ls-files -f -z (untracked files) ─────────────────────────
  const untrackedPaths = parseForceOutput(forceParts, sourcePath);

  // ── Collect all eligible tracked paths for check-attr ─────────────────────
  const trackedPaths = [...stageMap.keys()];

  // Start the remaining independent reads before check-attr so their process
  // and I/O time overlaps with attribute evaluation.
  const eolPartsPromise = gitZ(sourcePath, ["ls-files", "--eol", "-z"]);
  const filterConfigPartsPromise = gitZ(sourcePath, [
    "config",
    "--null",
    "--show-origin",
    "--get-regexp",
    "^filter\\..*\\.(clean|smudge|process|required)$",
  ]).catch(() => null);
  const coreConfigPartsPromise = gitZ(sourcePath, [
    "config",
    "--null",
    "--show-origin",
    "--get-regexp",
    "^(core\\.autocrlf|core\\.eol|core\\.attributesFile)$",
  ]).catch(() => null);
  const porcelainPartsPromise = gitZ(sourcePath, [
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);

  // ── Step 8: git check-attr -z --stdin for all eligible tracked paths ─────
  let attrMap = new Map<string, PathAttributes>();
  if (trackedPaths.length > 0) {
    // Pipe paths as NUL-delimited stdin.
    const stdinData = trackedPaths.join("\0") + "\0";
    const attrParts = await gitZ(
      sourcePath,
      ["check-attr", "-z", "--stdin", "filter", "ident", "working-tree-encoding", "text", "eol"],
      { stdin: stdinData },
    );
    attrMap = parseCheckAttrOutput(attrParts, sourcePath);
  }

  // ── Step 9: git ls-files --eol -z ────────────────────────────────────────
  const eolParts = await eolPartsPromise;
  const eolMap = parseEolOutput(eolParts, sourcePath);

  // ── Step 10: git config --null --show-origin --get-regexp '^filter\...' ──
  let filterConfigs: FilterConfigEntry[] = [];
  const filterConfigParts = await filterConfigPartsPromise;
  if (filterConfigParts !== null) {
    const filterEntries = parseConfigOutput(filterConfigParts, sourcePath);
    filterConfigs = filterEntries
      .map((e) => ({ key: e.key, value: e.value, origin: e.origin }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  // Reject command-backed filters.
  rejectCommandBackedFilters(filterConfigs, sourcePath);

  // ── Step 11: git config --null --show-origin for core settings ───────────
  let materializationConfig: GitMaterializationConfig = {
    autocrlf: "false",
    autocrlfOrigin: null,
    eol: "native",
    eolOrigin: null,
    attributesFile: null,
    attributesFileOrigin: null,
  };

  const coreConfigParts = await coreConfigPartsPromise;
  if (coreConfigParts !== null) {
    const coreEntries = parseConfigOutput(coreConfigParts, sourcePath);

    let autocrlf = "false";
    let autocrlfOrigin: string | null = null;
    let eol = "native";
    let eolOrigin: string | null = null;
    let attributesFile: string | null = null;
    let attributesFileOrigin: string | null = null;

    for (const entry of coreEntries) {
      switch (entry.key) {
        case "core.autocrlf":
          autocrlf = entry.value;
          autocrlfOrigin = entry.origin;
          break;
        case "core.eol":
          eol = entry.value;
          eolOrigin = entry.origin;
          break;
        case "core.attributesfile":
          attributesFile = entry.value;
          attributesFileOrigin = entry.origin;
          break;
      }
    }

    materializationConfig = {
      autocrlf,
      autocrlfOrigin,
      eol,
      eolOrigin,
      attributesFile,
      attributesFileOrigin,
    };
  }

  // Validate attributesFile is within allowed roots.
  validateAttributesFile(materializationConfig, sourcePath, commonDir);

  // ── Step 12: git status --porcelain=v2 -z ────────────────────────────────
  const porcelainParts = await porcelainPartsPromise;
  const porcelainMap = parsePorcelainOutput(porcelainParts, sourcePath);

  // ── Step 13: Build inventory entries with pinned metadata ────────────────
  const allPaths = new Set<string>();
  for (const p of trackedPaths) allPaths.add(p);
  for (const p of untrackedPaths) allPaths.add(p);
  for (const p of porcelainMap.keys()) allPaths.add(p);

  const sortedPaths = [...allPaths].sort((a, b) => a.localeCompare(b));
  const entries = await mapWithConcurrency(
    sortedPaths,
    MAX_CONCURRENT_METADATA_READS,
    async (p): Promise<InventoryEntry> => {
    const stage = stageMap.get(p) ?? null;
    const attributes = attrMap.get(p) ?? {
      filter: null,
      ident: null,
      workingTreeEncoding: null,
      text: null,
      eol: null,
    };
    const eolInfo = eolMap.get(p) ?? "";
    const porcelain = porcelainMap.get(p) ?? null;

    // Detect tracked deletion: porcelain status ".D" means worktree-deleted,
    // index-clean.  The file is absent from the working tree — never lstat it.
    const isDeleted = porcelain !== null && porcelain.statusCode === ".D";

    let present: boolean;
    let metadata: PinnedMetadata | null;

    if (isDeleted) {
      present = false;
      metadata = null;
    } else {
      const absPath = path.join(sourcePath, p);
      metadata = await pinMetadata(absPath);
      present = true;
    }

      return {
      path: p,
      stage,
      attributes,
      eolInfo,
      porcelain,
      present,
      metadata,
      };
    },
  );

  return {
    sourcePath,
    commonDir,
    objectFormat,
    headCommit,
    branch,
    materializationConfig,
    filterConfigs,
    entries,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Observe the exact Git source state, then repeat the observation and
 * compare canonical payload bytes.
 *
 * Spec section 8.1: "After building candidate objects and before publishing
 * current, the implementation repeats inventory steps 1 through 13 under
 * the same fixed Git environment and configuration. It reconstructs the
 * complete canonical source-state payload ... and byte-compares it with
 * the initial payload. Any difference restarts the operation once. A
 * second difference fails with source_changed_during_index."
 *
 * This function performs the initial observation and the final observation.
 * It does NOT implement the retry-once logic (that belongs in the service
 * layer). Instead, it returns `{ state: "changed", payload }` when the
 * second observation differs, allowing the caller to decide on retry.
 *
 * @param sourcePath Canonical absolute source path.
 * @returns `{ state: "clean", payload }` when both observations match,
 *   or `{ state: "changed", payload }` when they differ. The `payload`
 *   field always contains the FIRST observation's data (the one that was
 *   being used for candidate building).
 */
export async function observeGitSourceState(
  sourcePath: string,
): Promise<GitObservationResult> {
  // First complete observation.
  const firstPayload = await observeOnce(sourcePath);

  // Serialize to canonical bytes.
  const firstBytes = canonicalStringify(firstPayload);

  // Second complete observation under the same fixed environment.
  const secondPayload = await observeOnce(sourcePath);

  // Serialize to canonical bytes.
  const secondBytes = canonicalStringify(secondPayload);

  // Byte-compare.
  if (firstBytes === secondBytes) {
    return { state: "clean", payload: firstPayload };
  }

  return { state: "changed", payload: firstPayload };
}

/**
 * Perform one complete Git observation.
 *
 * The orchestration service uses this for the initial inventory and performs
 * the mandated second complete observation immediately before publication.
 * Standalone callers should normally use observeGitSourceState, which performs
 * both observations internally.
 */
export async function observeGitSourceStateOnce(
  sourcePath: string,
): Promise<SourceStatePayload> {
  return observeOnce(sourcePath);
}
