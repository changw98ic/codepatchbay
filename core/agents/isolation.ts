import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
// Authentication is portable across Codex/ACP versions. User-level
// config.toml is not: model, MCP, plugin, and feature settings can target a
// newer Codex than the installed ACP adapter and make every job fail before
// execution. CPB supplies runtime configuration explicitly instead.
const CODEX_SHARED_CONFIG_FILES = ["auth.json"];
const CLAUDE_SHARED_HOME_FILES = [".claude.json"];
const CLAUDE_SHARED_CONFIG_FILES = [".credentials.json", "credentials.json", "auth.json"];
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const INVALID_RUNTIME_ROOT_SENTINELS = new Set(["undefined", "null"]);
const PRESERVED_HOME_QUARANTINE = /\.quarantine-\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_INHERITED_AUTH_BYTES = 1024 * 1024;

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

async function copyRegularFileNoFollow(source: string, target: string) {
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
  if (sourceInfo.size > MAX_INHERITED_AUTH_BYTES) {
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
      const remaining = MAX_INHERITED_AUTH_BYTES + 1 - total;
      if (remaining <= 0) {
        throw isolationError(`refusing oversized auth source: ${source}`, "CPB_AGENT_HOME_AUTH_TOO_LARGE", {
          recoveryPaths: { source, target },
        });
      }
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await sourceHandle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_INHERITED_AUTH_BYTES || total > openedSource.size) {
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

async function maybeCopyFile(source: string, target: string) {
  return copyRegularFileNoFollow(source, target);
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

async function inheritCodexConfig(targetHome: string, parentEnv: StringRecord = {}) {
  const sourceCodexHome = resolveSourceCodexHome(parentEnv);
  const targetCodexHome = path.join(targetHome, ".codex");
  await mkdir(targetCodexHome, { recursive: true });
  if (!sourceCodexHome) return targetCodexHome;

  // Isolate config left by an older CPB run and preserve it for recovery.
  await isolateOwnedRegularFileNoFollow(path.join(targetCodexHome, "config.toml"));

  await Promise.all(CODEX_SHARED_CONFIG_FILES.map(async (fileName) => {
    const source = path.join(sourceCodexHome, fileName);
    const target = path.join(targetCodexHome, fileName);
    return copyRegularFileNoFollow(source, target);
  }));
  return targetCodexHome;
}

async function inheritClaudeConfig(targetHome: string, parentEnv: StringRecord = {}) {
  const sourceHome = resolveSourceHome(parentEnv);
  const targetClaudeHome = path.join(targetHome, ".claude");
  await mkdir(targetClaudeHome, { recursive: true });
  if (!sourceHome) return targetClaudeHome;

  await Promise.all([
    ...CLAUDE_SHARED_HOME_FILES.map((fileName) =>
      maybeCopyFile(
        path.join(sourceHome, fileName),
        path.join(targetHome, fileName),
      )
    ),
    ...CLAUDE_SHARED_CONFIG_FILES.map((fileName) =>
      maybeCopyFile(
        path.join(sourceHome, ".claude", fileName),
        path.join(targetClaudeHome, fileName),
      )
    ),
  ]);
  return targetClaudeHome;
}

function hasProjectJobContext(parentEnv: StringRecord = {}) {
  return Boolean(
    (parentEnv.CPB_ACP_PROJECT || parentEnv.CPB_PROJECT) &&
    (parentEnv.CPB_ACP_JOB_ID || parentEnv.CPB_JOB_ID)
  );
}

function resolveAgentHomeRoot(cpbRoot: string, { dataRoot, parentEnv = {} }: { dataRoot?: string | null; parentEnv?: StringRecord } = {}) {
  const root = dataRoot || parentEnv.CPB_PROJECT_RUNTIME_ROOT;
  if (root) {
    return resolveAgentHomeRuntimeRoot(
      root,
      dataRoot ? "dataRoot" : "CPB_PROJECT_RUNTIME_ROOT",
    );
  }
  if (hasProjectJobContext(parentEnv)) {
    throw new Error("CPB_PROJECT_RUNTIME_ROOT is required for isolated agent HOME in project job context");
  }
  return path.join(resolveAgentHomeRuntimeRoot(cpbRoot, "CPB_ROOT"), "cpb-task");
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
  if (agentName === "codex" && !parentEnv.CODEX_HOME) {
    env.CODEX_HOME = await inheritCodexConfig(baseDir, parentEnv);
  } else if (agentName === "claude") {
    await inheritClaudeConfig(baseDir, parentEnv);
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
