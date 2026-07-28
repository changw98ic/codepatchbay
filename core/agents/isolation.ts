import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getCapability,
  isBuiltinDescriptor,
  type AgentCapability,
} from "./registry.js";

const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
type StringRecord = Record<string, string | undefined>;
type CleanupAgentHomeOptions = {
  maxAgeMs?: number;
  now?: number;
  isLeaseActive?: (jobId: string) => boolean | Promise<boolean>;
  dataRoot?: string | null;
};
type CreateAgentHomeOptions = {
  parentEnv?: StringRecord;
  dataRoot?: string | null;
  isolateTemp?: boolean;
  instanceId?: string | null;
};

type PathGeneration = {
  dev: bigint | number;
  ino: bigint | number;
  size: bigint | number;
  mtimeMs: bigint | number;
  ctimeMs: bigint | number;
  birthtimeMs: bigint | number;
};
type AgentIsolationTestHooks = {
  beforeAuthTargetIsolation?: (context: {
    target: string;
    quarantine: string;
    generation: PathGeneration;
  }) => void | Promise<void>;
  afterAuthTargetIsolation?: (context: {
    target: string;
    quarantine: string;
    generation: PathGeneration;
  }) => void | Promise<void>;
  beforeAgentHomeIsolation?: (context: {
    home: string;
    quarantine: string;
    generation: PathGeneration;
  }) => void | Promise<void>;
  afterAgentHomeIsolation?: (context: {
    home: string;
    quarantine: string;
    generation: PathGeneration;
  }) => void | Promise<void>;
  openDirectory?: (
    directory: string,
    flags: number,
  ) => Promise<Awaited<ReturnType<typeof open>>>;
};

const agentIsolationTestHookStorage = new AsyncLocalStorage<Readonly<AgentIsolationTestHooks>>();

export function __withAgentIsolationTestHooks<T>(
  hooks: AgentIsolationTestHooks,
  run: () => T,
) {
  return agentIsolationTestHookStorage.run(Object.freeze({ ...hooks }), run);
}

function currentAgentIsolationTestHooks() {
  return agentIsolationTestHookStorage.getStore() || {};
}
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const INVALID_RUNTIME_ROOT_SENTINELS = new Set(["undefined", "null"]);
const PRESERVED_HOME_QUARANTINE = /\.quarantine-\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_INHERITED_AUTH_BYTES = 1024 * 1024;
// §6.2 untrusted-descriptor credential filename allowlist. User-registered
// descriptors may only inherit credentials whose basename matches this set;
// anything else is fail-closed before the copy reaches copyRegularFileNoFollow.
const CREDENTIAL_FILENAME_ALLOWLIST = new Set([
  "auth.json",
  ".credentials.json",
  "credentials.json",
]);

export function isolatedAgentToolPath(parentPath = process.env.PATH || "") {
  const preferred = process.platform === "darwin"
    ? [
        "/Applications/Xcode.app/Contents/Developer/usr/bin",
        "/Library/Developer/CommandLineTools/usr/bin",
        "/opt/anaconda3/bin",
        "/opt/conda/bin",
      ]
    : ["/opt/conda/bin"];
  return [...new Set([
    ...preferred.filter((entry) => existsSync(entry)),
    ...String(parentPath).split(path.delimiter).filter(Boolean),
  ])].join(path.delimiter);
}

function resolveSourceCodexHome(parentEnv: StringRecord = {}) {
  if (parentEnv.CODEX_HOME) return path.resolve(parentEnv.CODEX_HOME);
  const home = parentEnv.HOME || os.homedir();
  return home ? path.join(home, ".codex") : null;
}

function resolveSourceHome(parentEnv: StringRecord = {}) {
  return parentEnv.HOME || os.homedir() || null;
}

function pathGeneration(info: Pick<Awaited<ReturnType<typeof lstat>>, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs" | "birthtimeMs">): PathGeneration {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    birthtimeMs: info.birthtimeMs,
  };
}

function samePathGeneration(expected: PathGeneration, actual: PathGeneration) {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && expected.ctimeMs === actual.ctimeMs
    && expected.birthtimeMs === actual.birthtimeMs;
}

function samePathGenerationAcrossRename(expected: PathGeneration, actual: PathGeneration) {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && expected.birthtimeMs === actual.birthtimeMs;
}

function isolationError(message: string, code: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

async function lstatIfExists(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function pathPresence(filePath: string): Promise<boolean | null> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    return errorCode(error) === "ENOENT" ? false : null;
  }
}

function safeSegment(value: unknown, label: string) {
  const segment = String(value || "").trim();
  if (!SAFE_SEGMENT.test(segment) || segment === "." || segment === "..") {
    throw isolationError(`invalid isolated agent ${label}: ${segment || "<empty>"}`, "CPB_AGENT_HOME_INVALID_SEGMENT", { label, segment });
  }
  return segment;
}

export function resolveAgentHomeRuntimeRoot(value: unknown, label = "runtime root") {
  if (typeof value !== "string" || !value.trim()) {
    throw isolationError(`invalid isolated agent ${label}: <missing>`, "CPB_AGENT_HOME_INVALID_ROOT", {
      label,
      value: null,
    });
  }
  const raw = value.trim();
  const resolved = path.resolve(raw);
  if (
    INVALID_RUNTIME_ROOT_SENTINELS.has(raw.toLowerCase())
    || INVALID_RUNTIME_ROOT_SENTINELS.has(path.basename(resolved).toLowerCase())
  ) {
    throw isolationError(`invalid isolated agent ${label}: ${raw}`, "CPB_AGENT_HOME_INVALID_ROOT", {
      label,
      value: raw,
      resolved,
    });
  }
  return resolved;
}

function sanitizedInstanceSegment(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const segment = raw
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  if (!segment || !SAFE_SEGMENT.test(segment) || segment === "." || segment === "..") {
    throw isolationError(`invalid isolated agent instance id: ${raw}`, "CPB_AGENT_HOME_INVALID_SEGMENT", { label: "instanceId", segment: raw });
  }
  return segment;
}

function assertContained(root: string, candidate: string, label: string) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw isolationError(`${label} escapes isolated agent runtime root: ${resolvedCandidate}`, "CPB_AGENT_HOME_PATH_ESCAPE", {
      root: resolvedRoot,
      candidate: resolvedCandidate,
    });
  }
  return resolvedCandidate;
}

async function isolateOwnedRegularFileNoFollow(filePath: string) {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  const quarantinePath = `${filePath}.quarantine-${Date.now()}-${randomUUID()}`;
  const recoveryPaths = { target: filePath, quarantine: quarantinePath };
  if (info.isSymbolicLink() || !info.isFile()) {
    throw isolationError(`refusing to remove unsafe isolated config path: ${filePath}`, "CPB_AGENT_HOME_UNSAFE_AUTH_TARGET", {
      recoveryPaths,
      committed: false,
      committedPath: null,
      successorPreserved: true,
    });
  }
  const generation = pathGeneration(info);
  const hooks = currentAgentIsolationTestHooks();
  try {
    await hooks.beforeAuthTargetIsolation?.({
      target: filePath,
      quarantine: quarantinePath,
      generation,
    });
    const [current, quarantine] = await Promise.all([
      lstatIfExists(filePath),
      lstatIfExists(quarantinePath),
    ]);
    if (
      !current
      || current.isSymbolicLink()
      || !current.isFile()
      || !samePathGeneration(generation, pathGeneration(current))
      || quarantine
    ) {
      throw isolationError(`isolated config path changed before cleanup isolation: ${filePath}`, "CPB_AGENT_HOME_AUTHORITY_CHANGED", {
        recoveryPaths,
        committed: false,
        committedPath: null,
        successorPreserved: true,
      });
    }
    await rename(filePath, quarantinePath);
  } catch (error) {
    if (errorCode(error) === "CPB_AGENT_HOME_AUTHORITY_CHANGED") throw error;
    throw isolationError(`isolated config could not be safely isolated: ${filePath}`, "CPB_AGENT_HOME_AUTHORITY_CHANGED", {
      recoveryPaths,
      committed: false,
      committedPath: null,
      successorPreserved: true,
      cause: error,
    });
  }

  try {
    await hooks.afterAuthTargetIsolation?.({
      target: filePath,
      quarantine: quarantinePath,
      generation,
    });
    await syncDirectory(path.dirname(filePath));
    const moved = await lstat(quarantinePath);
    if (
      moved.isSymbolicLink()
      || !moved.isFile()
      || !samePathGenerationAcrossRename(generation, pathGeneration(moved))
    ) {
      throw new Error(`isolated config quarantine generation mismatch: ${quarantinePath}`);
    }
    if (await lstatIfExists(filePath)) {
      throw isolationError(`isolated config successor preserved during cleanup: ${filePath}`, "CPB_AGENT_HOME_AUTH_SUCCESSOR_PRESERVED", {
        recoveryPaths,
        committed: true,
        committedPath: quarantinePath,
        quarantinePreserved: true,
        successorPreserved: true,
      });
    }
    const final = await lstat(quarantinePath);
    if (
      final.isSymbolicLink()
      || !final.isFile()
      || !samePathGeneration(pathGeneration(moved), pathGeneration(final))
    ) {
      throw new Error(`isolated config quarantine changed after cleanup isolation: ${quarantinePath}`);
    }
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    if (errorCode(error) === "CPB_AGENT_HOME_AUTH_SUCCESSOR_PRESERVED") throw error;
    throw isolationError(`isolated config cleanup committed with recoverable evidence: ${filePath}`, "CPB_AGENT_HOME_AUTH_CLEANUP_COMMITTED_AMBIGUOUS", {
      recoveryPaths,
      committed: true,
      committedPath: quarantinePath,
      quarantinePreserved: true,
      successorPreserved: await pathPresence(filePath),
      cause: error,
    });
  }
  return true;
}

async function copyRegularFileNoFollow(source: string, target: string, maxBytes: number = MAX_INHERITED_AUTH_BYTES) {
  const effectiveMaxBytes = Math.min(
    Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : MAX_INHERITED_AUTH_BYTES,
    MAX_INHERITED_AUTH_BYTES,
  );
  let sourceInfo;
  try {
    sourceInfo = await lstat(source);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw isolationError(`refusing to inherit unsafe auth source: ${source}`, "CPB_AGENT_HOME_UNSAFE_AUTH_SOURCE", {
      recoveryPaths: { source, target },
    });
  }
  if (sourceInfo.size > effectiveMaxBytes) {
    throw isolationError(`refusing oversized auth source: ${source}`, "CPB_AGENT_HOME_AUTH_TOO_LARGE", {
      recoveryPaths: { source, target },
    });
  }
  const sourceGeneration = pathGeneration(sourceInfo);

  try {
    const targetInfo = await lstat(target);
    if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
      throw isolationError(`refusing to replace unsafe isolated auth target: ${target}`, "CPB_AGENT_HOME_UNSAFE_AUTH_TARGET", {
        recoveryPaths: { source, target },
      });
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw isolationError("strict no-follow opens are unavailable for isolated auth copy", "CPB_AGENT_HOME_NOFOLLOW_UNAVAILABLE", {
      recoveryPaths: { source, target },
    });
  }
  let sourceHandle: Awaited<ReturnType<typeof open>> | null = null;
  let targetHandle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedSource = await sourceHandle.stat();
    if (!openedSource.isFile() || !samePathGeneration(sourceGeneration, pathGeneration(openedSource))) {
      throw isolationError(`auth source changed while opening: ${source}`, "CPB_AGENT_HOME_AUTHORITY_CHANGED", {
        recoveryPaths: { source, target },
      });
    }
    targetHandle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remaining = effectiveMaxBytes + 1 - total;
      if (remaining <= 0) {
        throw isolationError(`refusing oversized auth source: ${source}`, "CPB_AGENT_HOME_AUTH_TOO_LARGE", {
          recoveryPaths: { source, target },
        });
      }
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await sourceHandle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > effectiveMaxBytes || total > openedSource.size) {
        throw isolationError(`auth source changed while reading: ${source}`, "CPB_AGENT_HOME_AUTHORITY_CHANGED", {
          recoveryPaths: { source, target },
        });
      }
      chunks.push(chunk.subarray(0, bytesRead));
      const observedSource = await sourceHandle.stat();
      if (!observedSource.isFile() || !samePathGeneration(sourceGeneration, pathGeneration(observedSource))) {
        throw isolationError(`auth source changed while reading: ${source}`, "CPB_AGENT_HOME_AUTHORITY_CHANGED", {
          recoveryPaths: { source, target },
        });
      }
    }
    await targetHandle.writeFile(Buffer.concat(chunks, total));
    await targetHandle.sync();
    const afterSource = await sourceHandle.stat();
    if (!afterSource.isFile() || !samePathGeneration(sourceGeneration, pathGeneration(afterSource))) {
      throw isolationError(`auth source changed while copying: ${source}`, "CPB_AGENT_HOME_AUTHORITY_CHANGED", {
        recoveryPaths: { source, target },
      });
    }
    await chmod(target, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return true;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw isolationError(`refusing symlink during isolated auth copy: ${source}`, "CPB_AGENT_HOME_UNSAFE_AUTH_SOURCE", {
        recoveryPaths: { source, target },
        cause: error,
      });
    }
    throw error;
  } finally {
    await targetHandle?.close().catch(() => undefined);
    await sourceHandle?.close().catch(() => undefined);
  }
  return true;
}

async function syncDirectory(directory: string) {
  if (
    typeof constants.O_NOFOLLOW !== "number"
    || constants.O_NOFOLLOW === 0
    || typeof constants.O_DIRECTORY !== "number"
    || constants.O_DIRECTORY === 0
  ) {
    throw isolationError(`strict directory opens are unavailable: ${directory}`, "CPB_AGENT_HOME_DIRECTORY_UNSAFE", {
      recoveryPaths: { directory },
    });
  }
  const before = await lstat(directory);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw isolationError(`refusing unsafe directory sync target: ${directory}`, "CPB_AGENT_HOME_DIRECTORY_UNSAFE", {
      recoveryPaths: { directory },
    });
  }
  const generation = pathGeneration(before);
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY;
  const openDirectory = currentAgentIsolationTestHooks().openDirectory || open;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let primaryError: unknown = null;
  try {
    handle = await openDirectory(directory, flags);
    const opened = await handle.stat();
    if (!opened.isDirectory() || !samePathGeneration(generation, pathGeneration(opened))) {
      throw isolationError(`directory changed while opening for sync: ${directory}`, "CPB_AGENT_HOME_DIRECTORY_UNSAFE", {
        recoveryPaths: { directory },
      });
    }
    await handle.sync();
    const [afterDescriptor, afterPath] = await Promise.all([
      handle.stat(),
      lstat(directory),
    ]);
    if (
      !afterDescriptor.isDirectory()
      || afterPath.isSymbolicLink()
      || !afterPath.isDirectory()
      || !samePathGeneration(generation, pathGeneration(afterDescriptor))
      || !samePathGeneration(generation, pathGeneration(afterPath))
    ) {
      throw isolationError(`directory changed during sync: ${directory}`, "CPB_AGENT_HOME_DIRECTORY_UNSAFE", {
        recoveryPaths: { directory },
      });
    }
  } catch (error) {
    primaryError = ["ELOOP", "EMLINK", "ENOTDIR"].includes(errorCode(error))
      ? isolationError(`refusing unsafe directory sync target: ${directory}`, "CPB_AGENT_HOME_DIRECTORY_UNSAFE", {
          recoveryPaths: { directory },
          cause: error,
        })
      : error;
  }
  let closeError: unknown = null;
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      closeError = error;
    }
  }
  if (primaryError) {
    if (!closeError) throw primaryError;
    throw Object.assign(
      new AggregateError([primaryError, closeError], `directory sync and close failed: ${directory}`, {
        cause: primaryError,
      }),
      { code: errorCode(primaryError) || "CPB_AGENT_HOME_DIRECTORY_UNSAFE", primaryError, closeError },
    );
  }
  if (closeError) throw closeError;
}

async function isolateAgentHomeDirectory(jobDir: string, generation: PathGeneration) {
  const quarantineDir = `${jobDir}.quarantine-${Date.now()}-${randomUUID()}`;
  const recoveryPaths = { home: jobDir, quarantine: quarantineDir };
  const hooks = currentAgentIsolationTestHooks();
  try {
    await hooks.beforeAgentHomeIsolation?.({
      home: jobDir,
      quarantine: quarantineDir,
      generation,
    });
    const [current, quarantine] = await Promise.all([
      lstatIfExists(jobDir),
      lstatIfExists(quarantineDir),
    ]);
    if (
      !current
      || !current.isDirectory()
      || current.isSymbolicLink()
      || !samePathGeneration(generation, pathGeneration(current))
      || quarantine
    ) {
      throw isolationError(`agent home changed before cleanup isolation: ${jobDir}`, "CPB_AGENT_HOME_AUTHORITY_CHANGED", {
        recoveryPaths,
        committed: false,
        committedPath: null,
        successorPreserved: true,
      });
    }
    await rename(jobDir, quarantineDir);
  } catch (error) {
    if (errorCode(error) === "CPB_AGENT_HOME_AUTHORITY_CHANGED") throw error;
    throw isolationError(`agent home could not be safely isolated: ${jobDir}`, "CPB_AGENT_HOME_AUTHORITY_CHANGED", {
      recoveryPaths,
      committed: false,
      committedPath: null,
      successorPreserved: true,
      cause: error,
    });
  }
  try {
    await hooks.afterAgentHomeIsolation?.({
      home: jobDir,
      quarantine: quarantineDir,
      generation,
    });
    await syncDirectory(path.dirname(jobDir));
    const moved = await lstat(quarantineDir);
    if (!moved.isDirectory() || moved.isSymbolicLink() || !samePathGenerationAcrossRename(generation, pathGeneration(moved))) {
      throw new Error(`agent home quarantine generation mismatch: ${quarantineDir}`);
    }
    if (await lstatIfExists(jobDir)) {
      throw isolationError(`agent home successor preserved during cleanup: ${jobDir}`, "CPB_AGENT_HOME_SUCCESSOR_PRESERVED", {
        recoveryPaths,
        committed: true,
        committedPath: quarantineDir,
        quarantinePreserved: true,
        successorPreserved: true,
      });
    }
    const final = await lstat(quarantineDir);
    if (!final.isDirectory() || final.isSymbolicLink() || !samePathGeneration(pathGeneration(moved), pathGeneration(final))) {
      throw new Error(`agent home quarantine changed after cleanup isolation: ${quarantineDir}`);
    }
    await syncDirectory(path.dirname(jobDir));
  } catch (error) {
    if (errorCode(error) === "CPB_AGENT_HOME_SUCCESSOR_PRESERVED") throw error;
    throw isolationError(`agent home cleanup isolation committed with recoverable evidence: ${jobDir}`, "CPB_AGENT_HOME_CLEANUP_COMMITTED_AMBIGUOUS", {
      recoveryPaths,
      committed: true,
      committedPath: quarantineDir,
      quarantinePreserved: true,
      successorPreserved: await pathPresence(jobDir),
      cause: error,
    });
  }
  return quarantineDir;
}

/**
 * Substitute a `$CODEX_HOME` / `$HOME` prefix from `parentEnv` into an inherit
 * template path. `$CODEX_HOME` resolves via `resolveSourceCodexHome` so the
 * env-aware codex root (`CODEX_HOME` ‖ `$HOME/.codex`) is honored; falling back
 * to `$HOME` for everything else. Bare paths (no prefix) are returned as-is and
 * get containment-checked later by the caller.
 */
function substituteInheritPath(template: string, parentEnv: StringRecord): string {
  if (template.startsWith("$CODEX_HOME/")) {
    const root = resolveSourceCodexHome(parentEnv);
    if (!root) {
      throw isolationError(
        `cannot resolve $CODEX_HOME for inherit path: ${template}`,
        "CPB_AGENT_HOME_INHERIT_SOURCE_UNRESOLVED",
        { template },
      );
    }
    return path.join(root, template.slice("$CODEX_HOME/".length));
  }
  if (template.startsWith("$HOME/")) {
    const home = resolveSourceHome(parentEnv);
    if (!home) {
      throw isolationError(
        `cannot resolve $HOME for inherit path: ${template}`,
        "CPB_AGENT_HOME_INHERIT_SOURCE_UNRESOLVED",
        { template },
      );
    }
    return path.join(home, template.slice("$HOME/".length));
  }
  return template;
}

/**
 * Resolve a `to` / quarantineFile template against the isolated HOME, requiring
 * the result to stay strictly inside `targetHome`. `$HOME/` (and a bare
 * `$HOME`) are rewritten to `targetHome`; bare relative paths are joined under
 * `targetHome`; absolute paths and `..` escapes are fail-closed regardless of
 * descriptor trust level — `O_NOFOLLOW` only blocks symlink traversal, not
 * absolute-path escapes, so the containment check is explicit (§6.2).
 */
function resolveInheritTarget(toTemplate: string, targetHome: string): string {
  let rel: string;
  if (toTemplate === "$HOME") {
    rel = ".";
  } else if (toTemplate.startsWith("$HOME/")) {
    rel = toTemplate.slice("$HOME/".length);
  } else {
    rel = toTemplate;
  }
  const resolved = path.resolve(targetHome, rel);
  assertContained(targetHome, resolved, "isolated agent HOME inherit target");
  return resolved;
}

/**
 * §6.2 untrusted-descriptor source gate. The resolved `from` must (1) sit
 * inside a trusted env root (`$CODEX_HOME` ‖ `$HOME/.codex`, or `$HOME` for
 * other families) and (2) carry a credential allowlist basename. Any violation
 * is fail-closed before the copy reaches `copyRegularFileNoFollow`. Builtin
 * descriptors bypass this gate (their `from`/`to` are CPB-authored).
 */
function assertTrustedInheritSource(fromResolved: string, parentEnv: StringRecord): void {
  const trustedRoots: string[] = [];
  const codexRoot = resolveSourceCodexHome(parentEnv);
  if (codexRoot) trustedRoots.push(path.resolve(codexRoot));
  const homeRoot = resolveSourceHome(parentEnv);
  if (homeRoot) trustedRoots.push(path.resolve(homeRoot));

  let insideTrusted = false;
  for (const root of trustedRoots) {
    const rel = path.relative(root, path.resolve(fromResolved));
    if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      insideTrusted = true;
      break;
    }
  }
  if (!insideTrusted) {
    throw isolationError(
      `refusing inherit source outside trusted env root: ${fromResolved}`,
      "CPB_AGENT_HOME_UNTRUSTED_INHERIT_SOURCE",
      { from: fromResolved },
    );
  }
  const filename = path.basename(fromResolved);
  if (!CREDENTIAL_FILENAME_ALLOWLIST.has(filename)) {
    throw isolationError(
      `refusing inherit of non-credential file: ${filename}`,
      "CPB_AGENT_HOME_UNTRUSTED_INHERIT_FILE",
      { from: fromResolved, filename },
    );
  }
}

export type InheritFileEntry = { from: string; to: string; maxBytes?: number };
type ResolvedInheritEntry = { fromResolved: string; toResolved: string; maxBytes: number };

/**
 * Resolve + gate a single `quarantineFiles` entry against `targetHome` (pure
 * path math, no I/O). Throws fail-closed if the entry is malformed or its
 * resolved target escapes `targetHome` (§6.2 `to` containment).
 */
function resolveQuarantineEntry(entry: unknown, targetHome: string): string {
  if (typeof entry !== "string" || !entry) {
    throw isolationError(
      "quarantineFiles entry must be a non-empty string",
      "CPB_AGENT_HOME_INHERIT_ENTRY_INVALID",
    );
  }
  return resolveInheritTarget(entry, targetHome);
}

/**
 * Resolve + gate a single `inheritFiles` entry (pure path math, no I/O).
 * Substitutes `$CODEX_HOME`/`$HOME` into `from`, canonicalizes `to` under
 * `targetHome`, clamps `maxBytes` to `MAX_INHERITED_AUTH_BYTES`, and — for
 * untrusted descriptors — runs the §6.2 source gate (trusted-env-root +
 * credential-filename allowlist). Throws fail-closed on any violation.
 */
function resolveInheritEntry(
  entry: unknown,
  parentEnv: StringRecord,
  targetHome: string,
  { trusted }: { trusted: boolean },
): ResolvedInheritEntry {
  if (!entry || typeof entry !== "object") {
    throw isolationError(
      "inheritFiles entry must be an object with from/to",
      "CPB_AGENT_HOME_INHERIT_ENTRY_INVALID",
    );
  }
  const record = entry as { from?: unknown; to?: unknown; maxBytes?: unknown };
  const from = typeof record.from === "string" ? record.from : "";
  const to = typeof record.to === "string" ? record.to : "";
  if (!from || !to) {
    throw isolationError(
      "inheritFiles entry missing from/to",
      "CPB_AGENT_HOME_INHERIT_ENTRY_INVALID",
    );
  }
  const declaredMax = typeof record.maxBytes === "number" && Number.isFinite(record.maxBytes) && record.maxBytes > 0
    ? Math.floor(record.maxBytes)
    : MAX_INHERITED_AUTH_BYTES;
  const maxBytes = Math.min(declaredMax, MAX_INHERITED_AUTH_BYTES);

  const fromResolved = substituteInheritPath(from, parentEnv);
  const toResolved = resolveInheritTarget(to, targetHome);

  if (!trusted) {
    assertTrustedInheritSource(fromResolved, parentEnv);
  }
  return { fromResolved, toResolved, maxBytes };
}

/**
 * Validate every `inheritFiles` / `quarantineFiles` entry declared by a
 * descriptor against the §6.2 security gate WITHOUT performing any copy or
 * isolation (no filesystem I/O). Shared between `inheritFilesIntoHome` (runtime
 * copy) and `registerDescriptor` (registration-time validation) so the gate has
 * a single source of truth. Throws fail-closed on the first violation.
 *
 * `targetHome` is any concrete directory used to validate `to` containment;
 * because `$HOME` / `$HOME/...` templates are rewritten relative to it and
 * absolute / `..` escapes are rejected by `assertContained`, the accept/reject
 * decision for a template is identical regardless of which concrete root is
 * supplied — callers that have no real isolated HOME yet (registration) may
 * pass a placeholder directory.
 */
export function assertInheritFilesSafe(
  descriptor: {
    inheritFiles?: InheritFileEntry[];
    quarantineFiles?: string[];
  },
  parentEnv: StringRecord,
  targetHome: string,
  { trusted = false }: { trusted?: boolean } = {},
): void {
  const quarantine = Array.isArray(descriptor.quarantineFiles) ? descriptor.quarantineFiles : [];
  for (const entry of quarantine) {
    resolveQuarantineEntry(entry, targetHome);
  }
  const files = Array.isArray(descriptor.inheritFiles) ? descriptor.inheritFiles : [];
  for (const entry of files) {
    resolveInheritEntry(entry, parentEnv, targetHome, { trusted });
  }
}

/**
 * Descriptor-driven HOME inheritance (B2b, RFC §6.2). Loops generically over
 * `descriptor.inheritFiles` plus `quarantineFiles` instead of branching on
 * `agentName === "codex"` / `=== "claude"` literals.
 *
 * Declared quarantine files are isolated first (so a stale config left by an
 * older CPB run cannot poison the fresh auth copy), then each inherit entry is
 * copied with `O_NOFOLLOW` / `lstat` symlink refusal and the per-file
 * `maxBytes` cap (clamped to `MAX_INHERITED_AUTH_BYTES`).
 *
 * `trusted` selects between builtin descriptors (CPB-authored, source allowlist
 * skipped) and user-registered/auto-discovered descriptors (§6.2 source gate
 * enforced, fail-closed on violation). `to` containment is enforced for both.
 * Gate logic is shared with `assertInheritFilesSafe` (registration-time) via
 * `resolveQuarantineEntry` / `resolveInheritEntry` so the runtime copy path and
 * the registration validation path cannot drift.
 */
export async function inheritFilesIntoHome(
  targetHome: string,
  parentEnv: StringRecord,
  descriptor: {
    inheritFiles?: InheritFileEntry[];
    quarantineFiles?: string[];
  },
  { trusted = false }: { trusted?: boolean } = {},
): Promise<void> {
  const quarantine = Array.isArray(descriptor.quarantineFiles) ? descriptor.quarantineFiles : [];
  for (const entry of quarantine) {
    const target = resolveQuarantineEntry(entry, targetHome);
    await isolateOwnedRegularFileNoFollow(target);
  }

  const files = Array.isArray(descriptor.inheritFiles) ? descriptor.inheritFiles : [];
  for (const entry of files) {
    const { fromResolved, toResolved, maxBytes } = resolveInheritEntry(
      entry,
      parentEnv,
      targetHome,
      { trusted },
    );
    await copyRegularFileNoFollow(fromResolved, toResolved, maxBytes);
  }
}

function resolveAgentHomeRoot(_cpbRoot: string, { dataRoot, parentEnv = {} }: { dataRoot?: string | null; parentEnv?: StringRecord } = {}) {
  const root = dataRoot || parentEnv.CPB_PROJECT_RUNTIME_ROOT;
  if (!root) {
    throw new Error("project runtime root is required for isolated agent HOME");
  }
  return resolveAgentHomeRuntimeRoot(
    root,
    dataRoot ? "dataRoot" : "CPB_PROJECT_RUNTIME_ROOT",
  );
}

/**
 * Create an isolated HOME directory for an agent process.
 * Prevents concurrent agents of the same type from interfering
 * with each other's ~/.claude, ~/.codex, etc.
 *
 * Returns env vars to spread into the child process environment.
 * Codex and Claude receive isolated homes with only provider auth/config files
 * linked from the user's agent home, so ACP adapters can reuse login without
 * sharing mutable session state.
 */
export async function createAgentHome(cpbRoot: string, agentName: string, jobId: string, {
  parentEnv = {},
  dataRoot = null,
  isolateTemp = false,
  instanceId = null,
}: CreateAgentHomeOptions = {}) {
  const root = resolveAgentHomeRoot(cpbRoot, { dataRoot, parentEnv });
  const safeAgentName = safeSegment(agentName, "agentName");
  const safeJobId = safeSegment(jobId || "default", "jobId");
  const jobDir = assertContained(root, path.join(root, "agent-homes", safeAgentName, safeJobId), "isolated agent HOME");
  const safeInstanceId = sanitizedInstanceSegment(instanceId);
  const baseDir = safeInstanceId ? path.join(jobDir, safeInstanceId) : jobDir;
  assertContained(root, baseDir, "isolated agent HOME");
  await mkdir(baseDir, { recursive: true, mode: 0o700 });

  const configDir = path.join(baseDir, ".config");
  const dataDir = path.join(baseDir, ".local", "share");
  const cacheDir = path.join(baseDir, ".cache");
  const tempDir = path.join(baseDir, ".tmp");

  await mkdir(configDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await mkdir(tempDir, { recursive: true });

  const env: StringRecord = {
    HOME: baseDir,
    XDG_CONFIG_HOME: configDir,
    XDG_DATA_HOME: dataDir,
    XDG_CACHE_HOME: cacheDir,
    // Repository tasks must not inherit developer-specific aliases, hooks, or
    // conditional includes from a host Git config. The isolated HOME already
    // has no config; these variables make that boundary explicit to Git.
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: isolatedAgentToolPath(parentEnv.PATH),
  };
  if (isolateTemp) {
    env.TMPDIR = tempDir;
    env.TMP = tempDir;
    env.TEMP = tempDir;
  }
  // Descriptor-driven HOME inheritance (B2b): every descriptor's
  // inheritFiles/quarantineFiles is looped generically instead of branching on
  // `agentName === "codex"/"claude"` literals. When the registry is not loaded
  // (e.g. focused unit tests that import createAgentHome directly without
  // loadRegistry) no capability is found and nothing is inherited.
  let cap: AgentCapability | null = null;
  try {
    cap = getCapability(agentName);
  } catch {
    cap = null;
  }
  if (cap) {
    let trusted = false;
    try {
      trusted = isBuiltinDescriptor(agentName);
    } catch {
      trusted = false;
    }
    if (cap.inheritFiles.length || cap.quarantineFiles.length) {
      await inheritFilesIntoHome(baseDir, parentEnv, cap, { trusted });
    }
  }
  return env;
}

/**
 * Clean up agent home directories older than CLEANUP_AGE_MS.
 * Safe to call periodically; skips directories that are still in use
 * (checked via the presence of active leases).
 *
 * @param {Function} [opts.isLeaseActive] - Async (jobId) => boolean.
 *   Returns true if the job has a non-stale lease. When provided,
 *   directories with active leases are never deleted regardless of age.
 */
export async function cleanupAgentHomes(cpbRoot: string, { maxAgeMs = CLEANUP_AGE_MS, now = Date.now(), isLeaseActive, dataRoot }: CleanupAgentHomeOptions = {}) {
  const homesRoot = path.join(resolveAgentHomeRoot(cpbRoot, { dataRoot, parentEnv: process.env }), "agent-homes");
  let agents;
  try {
    agents = await readdir(homesRoot);
  } catch {
    return 0;
  }

  const activeCheck = isLeaseActive || (() => false);

  let cleaned = 0;
  for (const agentName of agents) {
    let safeAgentName: string;
    try {
      safeAgentName = safeSegment(agentName, "agentName");
    } catch (error) {
      throw isolationError(`unsafe agent home directory name during cleanup: ${agentName}`, "CPB_AGENT_HOME_UNSAFE_PATH", { cause: error });
    }
    if (safeAgentName !== agentName) {
      throw isolationError(`unsafe agent home alias during cleanup: ${agentName}`, "CPB_AGENT_HOME_UNSAFE_PATH");
    }
    const agentDir = path.join(homesRoot, agentName);
    let jobs;
    try {
      jobs = await readdir(agentDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const jobId of jobs) {
      if (PRESERVED_HOME_QUARANTINE.test(jobId)) continue;
      let safeJobId: string;
      try {
        safeJobId = safeSegment(jobId, "jobId");
      } catch (error) {
        throw isolationError(`unsafe agent job home directory name during cleanup: ${jobId}`, "CPB_AGENT_HOME_UNSAFE_PATH", { cause: error });
      }
      if (safeJobId !== jobId) {
        throw isolationError(`unsafe agent job home alias during cleanup: ${jobId}`, "CPB_AGENT_HOME_UNSAFE_PATH");
      }
      const jobDir = path.join(agentDir, jobId);
      const info = await lstat(jobDir).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!info) continue;
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw isolationError(`unsafe agent home cleanup target: ${jobDir}`, "CPB_AGENT_HOME_UNSAFE_PATH", {
          recoveryPaths: { home: jobDir },
        });
      }
      if (now - info.mtimeMs <= maxAgeMs) continue;

      // Check lease status before deleting
      const active = await activeCheck(jobId);
      if (active) continue;

      await isolateAgentHomeDirectory(jobDir, pathGeneration(info));
      cleaned++;
    }
  }
  return cleaned;
}
