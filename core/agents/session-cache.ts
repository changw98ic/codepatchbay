import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";

import type { LooseRecord } from "../../shared/types.js";
import { runtimeDataPath } from "../paths.js";
import {
  readBoundedRegularFileNoFollow,
  withDurableDirectoryLock,
  type BoundedRegularFileReadHooks,
} from "../runtime/durable-directory-lock.js";

const CACHE_DIR_NAME = "session-cache";
const SESSION_CACHE_FORMAT = "cpb-session-cache/v1";
const SESSION_CACHE_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const LOCK_TTL_MS = 10_000;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

type SessionCacheRemovalPhase = "write-temp-remove" | "write-replace" | "clear-remove" | "cleanup-remove";
type SessionCacheSyncPhase =
  | "write-commit"
  | "write-temp-isolate"
  | "write-temp-retire"
  | "write-temp-delete"
  | "write-replace-isolate"
  | "clear-isolate"
  | "cleanup-isolate";

type SessionFileGeneration = {
  dev: bigint | number;
  ino: bigint | number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
};

type SessionFileOwner = {
  format: string | null;
  generation: string | null;
  agent: string;
  conversationKey: string;
};

type SessionFileAuthority = {
  filePath: string;
  generation: SessionFileGeneration;
  sha256: string;
  owner: SessionFileOwner;
};

export type SessionCacheTestHooks = {
  syncDirectory?: (directory: string, phase: SessionCacheSyncPhase) => void | Promise<void>;
  openDirectory?: (
    directory: string,
    flags: number,
  ) => Promise<Awaited<ReturnType<typeof open>>>;
  readFile?: BoundedRegularFileReadHooks;
  beforeWritePublish?: (context: {
    filePath: string;
    tempPath: string;
    predecessorRecoveryPath: string | null;
  }) => void | Promise<void>;
  beforeRemovalIsolation?: (context: {
    canonicalPath: string;
    isolatedPath: string;
    phase: SessionCacheRemovalPhase;
  }) => void | Promise<void>;
  afterRemovalValidation?: (context: {
    canonicalPath: string;
    isolatedPath: string;
    phase: SessionCacheRemovalPhase;
  }) => void | Promise<void>;
  beforePublishedTempRemoval?: (context: {
    filePath: string;
    tempPath: string;
    isolatedPath: string;
  }) => void | Promise<void>;
};

const sessionCacheTestHookStorage = new AsyncLocalStorage<SessionCacheTestHooks>();

export function withSessionCacheTestHooks<T>(hooks: SessionCacheTestHooks, action: () => T): T {
  return sessionCacheTestHookStorage.run(hooks, action);
}

function finiteNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeDataRoot(value: unknown) {
  return typeof value === "string" && value ? path.resolve(value) : "";
}

function cacheDir(cpbRoot: string, { dataRoot }: LooseRecord = {}) {
  const root = normalizeDataRoot(dataRoot);
  return root ? path.join(root, CACHE_DIR_NAME) : runtimeDataPath(cpbRoot, CACHE_DIR_NAME);
}

function normalizeConversationKey(value: unknown) {
  return typeof value === "string" && value ? value : "";
}

function cacheEntryName(agent: string, conversationKey = "") {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agent) || agent.includes("..")) {
    throw Object.assign(new Error(`invalid session cache agent: ${agent}`), { code: "SESSION_CACHE_AGENT_INVALID" });
  }
  if (!conversationKey) return agent;
  const digest = createHash("sha256").update(conversationKey).digest("hex");
  return `${agent}--conversation-${digest}`;
}

function sessionFile(cpbRoot: string, agent: string, conversationKey = "", options: LooseRecord = {}) {
  return path.join(cacheDir(cpbRoot, options), `${cacheEntryName(agent, conversationKey)}.json`);
}

function lockDir(cpbRoot: string, agent: string, conversationKey = "", options: LooseRecord = {}) {
  return path.join(cacheDir(cpbRoot, options), `${cacheEntryName(agent, conversationKey)}.lock`);
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

function sessionFileGeneration(info: SessionFileGeneration): SessionFileGeneration {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    birthtimeMs: info.birthtimeMs,
  };
}

function sameSessionFileGeneration(expected: SessionFileGeneration, actual: SessionFileGeneration) {
  return String(expected.dev) === String(actual.dev)
    && String(expected.ino) === String(actual.ino)
    && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && expected.ctimeMs === actual.ctimeMs
    && expected.birthtimeMs === actual.birthtimeMs;
}

// A same-directory rename can legitimately advance ctime. The remaining
// generation plus the content digest and record owner still pin the moved file.
function sameMovedSessionFileGeneration(expected: SessionFileGeneration, actual: SessionFileGeneration) {
  return String(expected.dev) === String(actual.dev)
    && String(expected.ino) === String(actual.ino)
    && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && expected.birthtimeMs === actual.birthtimeMs;
}

function sameLinkedSessionAuthority(expected: SessionFileAuthority, actual: SessionFileAuthority) {
  return sameMovedSessionFileGeneration(expected.generation, actual.generation)
    && expected.sha256 === actual.sha256
    && sameSessionFileOwner(expected.owner, actual.owner);
}

function sessionFileOwner(record: LooseRecord): SessionFileOwner {
  return {
    format: typeof record.format === "string" ? record.format : null,
    generation: typeof record.generation === "string" ? record.generation : null,
    agent: String(record.agent || ""),
    conversationKey: normalizeConversationKey(record.conversationKey),
  };
}

function sameSessionFileOwner(expected: SessionFileOwner, actual: SessionFileOwner) {
  return expected.format === actual.format
    && expected.generation === actual.generation
    && expected.agent === actual.agent
    && expected.conversationKey === actual.conversationKey;
}

function sessionCacheUnsafe(filePath: string, cause: unknown) {
  return Object.assign(new Error(`unsafe session cache file: ${filePath}`, { cause }), {
    code: "SESSION_CACHE_UNSAFE",
  });
}

function removalRecoveryPaths(canonicalPath: string, isolatedPath?: string) {
  return [...new Set([
    canonicalPath,
    ...(isolatedPath ? [isolatedPath] : []),
    path.dirname(canonicalPath),
  ])];
}

function removalGenerationConflict(
  authority: SessionFileAuthority,
  isolatedPath: string,
  committed: boolean,
  cause?: unknown,
) {
  return Object.assign(new Error(
    committed
      ? `session cache generation changed after isolation; recovery evidence preserved: ${isolatedPath}`
      : `session cache generation changed before isolation; successor preserved: ${authority.filePath}`,
    cause === undefined ? undefined : { cause },
  ), {
    code: "SESSION_CACHE_REMOVE_GENERATION_CONFLICT",
    committed,
    removalCommitted: false,
    committedPath: committed ? isolatedPath : null,
    quarantinePreserved: committed,
    successorPreserved: !committed,
    recoveryPaths: removalRecoveryPaths(authority.filePath, committed ? isolatedPath : undefined),
    expectedGeneration: {
      ...authority.generation,
      dev: String(authority.generation.dev),
      ino: String(authority.generation.ino),
      owner: authority.owner,
    },
  });
}

function sessionCacheDirectoryError(directory: string, cause?: unknown) {
  return Object.assign(new Error(
    `unsafe session cache directory: ${directory}`,
    cause === undefined ? undefined : { cause },
  ), {
    code: "SESSION_CACHE_DIRECTORY_UNSAFE",
    committed: false,
    recoveryPaths: [directory],
  });
}

function strictDirectoryOpenFlags() {
  if (
    typeof constants.O_NOFOLLOW !== "number"
    || constants.O_NOFOLLOW === 0
    || typeof constants.O_DIRECTORY !== "number"
    || constants.O_DIRECTORY === 0
  ) {
    throw sessionCacheDirectoryError("<unsupported-platform>");
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY;
}

function sameDirectoryIdentity(
  expected: { dev: bigint | number; ino: bigint | number; birthtimeMs: number },
  actual: { dev: bigint | number; ino: bigint | number; birthtimeMs: number },
) {
  return String(expected.dev) === String(actual.dev)
    && String(expected.ino) === String(actual.ino)
    && expected.birthtimeMs === actual.birthtimeMs;
}

async function isTrustedDarwinRootAlias(component: string) {
  if (process.platform !== "darwin" || !["/etc", "/tmp", "/var"].includes(component)) return false;
  try {
    return await realpath(component) === `/private${component}`;
  } catch {
    return false;
  }
}

async function assertSafeDirectoryChain(directory: string) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      if (await isTrustedDarwinRootAlias(current)) continue;
      throw sessionCacheDirectoryError(current);
    }
    if (!info.isDirectory()) throw sessionCacheDirectoryError(current);
  }
}

async function ensureSafeSessionDirectory(directory: string) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(current);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== "EEXIST") throw mkdirError;
      }
      info = await lstat(current);
    }
    if (info.isSymbolicLink()) {
      if (await isTrustedDarwinRootAlias(current)) continue;
      throw sessionCacheDirectoryError(current);
    }
    if (!info.isDirectory()) throw sessionCacheDirectoryError(current);
  }
  await assertSafeDirectoryChain(directory);
}

async function safeSessionDirectoryExists(directory: string) {
  try {
    await assertSafeDirectoryChain(directory);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(
  directory: string,
  phase: SessionCacheSyncPhase,
  hooks: SessionCacheTestHooks,
) {
  await hooks.syncDirectory?.(directory, phase);
  await assertSafeDirectoryChain(directory);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let primaryError: unknown = null;
  try {
    const before = await lstat(directory);
    if (before.isSymbolicLink() || !before.isDirectory()) throw sessionCacheDirectoryError(directory);
    handle = await (hooks.openDirectory || open)(directory, strictDirectoryOpenFlags());
    const opened = await handle.stat();
    if (!opened.isDirectory() || !sameDirectoryIdentity(before, opened)) {
      throw sessionCacheDirectoryError(directory);
    }
    await handle.sync();
    const [afterDescriptor, afterPath] = await Promise.all([handle.stat(), lstat(directory)]);
    if (
      !afterDescriptor.isDirectory()
      || afterPath.isSymbolicLink()
      || !afterPath.isDirectory()
      || !sameDirectoryIdentity(before, afterDescriptor)
      || !sameDirectoryIdentity(before, afterPath)
    ) throw sessionCacheDirectoryError(directory);
    await assertSafeDirectoryChain(directory);
  } catch (error) {
    primaryError = ["ELOOP", "EMLINK", "ENOTDIR"].includes(errorCode(error))
      ? sessionCacheDirectoryError(directory, error)
      : error;
  }
  let closeError: unknown = null;
  if (handle) {
    try { await handle.close(); } catch (error) { closeError = error; }
  }
  if (primaryError) {
    if (!closeError) throw primaryError;
    throw new AggregateError([primaryError, closeError], `session cache directory sync and close failed: ${directory}`, {
      cause: primaryError,
    });
  }
  if (closeError) throw closeError;
}

function nestedRecoveryPaths(error: unknown, seen = new Set<unknown>()): string[] {
  if (!error || typeof error !== "object" || seen.has(error)) return [];
  seen.add(error);
  const candidate = error as {
    recoveryPaths?: unknown;
    cleanupErrors?: unknown;
    errors?: unknown;
    cause?: unknown;
  };
  return [...new Set([
    ...(Array.isArray(candidate.recoveryPaths)
      ? candidate.recoveryPaths.filter((value): value is string => typeof value === "string")
      : []),
    ...(Array.isArray(candidate.cleanupErrors)
      ? candidate.cleanupErrors.flatMap((nested) => nestedRecoveryPaths(nested, seen))
      : []),
    ...(error instanceof AggregateError
      ? error.errors.flatMap((nested) => nestedRecoveryPaths(nested, seen))
      : []),
    ...nestedRecoveryPaths(candidate.cause, seen),
  ])];
}

function nestedCommitted(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  const candidate = error as {
    committed?: unknown;
    cleanupErrors?: unknown;
    cause?: unknown;
  };
  return candidate.committed === true
    || (Array.isArray(candidate.cleanupErrors)
      && candidate.cleanupErrors.some((nested) => nestedCommitted(nested, seen)))
    || (error instanceof AggregateError && error.errors.some((nested) => nestedCommitted(nested, seen)))
    || nestedCommitted(candidate.cause, seen);
}

function nestedMetadataTrue(
  error: unknown,
  key: "cleanupCommitted" | "removalCommitted" | "quarantinePreserved" | "successorPreserved" | "tempPreserved",
  seen = new Set<unknown>(),
): boolean {
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  const candidate = error as Record<string, unknown> & {
    cleanupErrors?: unknown;
    cause?: unknown;
  };
  return candidate[key] === true
    || (Array.isArray(candidate.cleanupErrors)
      && candidate.cleanupErrors.some((nested) => nestedMetadataTrue(nested, key, seen)))
    || (error instanceof AggregateError
      && error.errors.some((nested) => nestedMetadataTrue(nested, key, seen)))
    || nestedMetadataTrue(candidate.cause, key, seen);
}

function isolationSyncPhase(phase: SessionCacheRemovalPhase): SessionCacheSyncPhase {
  if (phase === "write-temp-remove") return "write-temp-isolate";
  if (phase === "write-replace") return "write-replace-isolate";
  if (phase === "clear-remove") return "clear-isolate";
  return "cleanup-isolate";
}

async function repinSessionFileAuthority(
  authority: SessionFileAuthority,
  filePath: string,
  {
    moved = false,
    committed = moved,
    recoveryAuthority = authority,
  }: {
    moved?: boolean;
    committed?: boolean;
    recoveryAuthority?: SessionFileAuthority;
  } = {},
) {
  let current: Awaited<ReturnType<typeof readSessionFile>>;
  try {
    current = await readSessionFile(filePath);
  } catch (error) {
    throw removalGenerationConflict(recoveryAuthority, filePath, committed, error);
  }
  const generationMatches = moved
    ? sameMovedSessionFileGeneration(authority.generation, current.authority.generation)
    : sameSessionFileGeneration(authority.generation, current.authority.generation);
  if (
    !generationMatches
    || authority.sha256 !== current.authority.sha256
    || !sameSessionFileOwner(authority.owner, current.authority.owner)
  ) {
    throw removalGenerationConflict(recoveryAuthority, filePath, committed);
  }
  return current;
}

async function removeSessionAuthorityDurable(
  authority: SessionFileAuthority,
  phase: SessionCacheRemovalPhase,
  hooks: SessionCacheTestHooks,
) {
  const canonicalPath = authority.filePath;
  const isolatedPath = path.join(
    path.dirname(canonicalPath),
    `.${path.basename(canonicalPath)}.${phase}.${randomUUID()}.recovery`,
  );
  await hooks.beforeRemovalIsolation?.({ canonicalPath, isolatedPath, phase });
  await repinSessionFileAuthority(authority, canonicalPath);

  try {
    await rename(canonicalPath, isolatedPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw removalGenerationConflict(authority, isolatedPath, false, error);
    }
    throw error;
  }

  try {
    await syncDirectory(path.dirname(canonicalPath), isolationSyncPhase(phase), hooks);
  } catch (error) {
    throw Object.assign(new Error(
      `session cache isolation committed with ambiguous durability: ${canonicalPath}`,
      { cause: error },
    ), {
      code: "SESSION_CACHE_REMOVE_ISOLATED_AMBIGUOUS",
      primaryError: error,
      cleanupErrors: [],
      committed: true,
      removalCommitted: false,
      committedPath: isolatedPath,
      quarantinePreserved: true,
      recoveryPaths: removalRecoveryPaths(canonicalPath, isolatedPath),
    });
  }

  const moved = await repinSessionFileAuthority(authority, isolatedPath, { moved: true });
  await hooks.afterRemovalValidation?.({ canonicalPath, isolatedPath, phase });
  await repinSessionFileAuthority(moved.authority, isolatedPath, {
    committed: true,
    recoveryAuthority: authority,
  });
  return isolatedPath;
}

function publicationGenerationConflict(
  filePath: string,
  tempPath: string,
  predecessorRecoveryPath: string,
  cause?: unknown,
) {
  return Object.assign(new Error(
    `session cache publication authority changed: ${filePath}`,
    cause === undefined ? undefined : { cause },
  ), {
    code: "SESSION_CACHE_PUBLISH_GENERATION_CONFLICT",
    committed: true,
    publicationKind: "hard-link",
    publicationCommitted: true,
    committedPath: filePath,
    tempPreserved: true,
    quarantinePreserved: Boolean(predecessorRecoveryPath),
    successorPreserved: true,
    recoveryPaths: [
      filePath,
      tempPath,
      path.dirname(filePath),
      ...(predecessorRecoveryPath ? [predecessorRecoveryPath] : []),
    ],
  });
}

function publishedTempRecoveryPaths(
  filePath: string,
  tempPath: string,
  isolatedPath: string,
  predecessorRecoveryPath: string,
) {
  return [...new Set([
    filePath,
    tempPath,
    ...(isolatedPath ? [isolatedPath] : []),
    path.dirname(filePath),
    ...(predecessorRecoveryPath ? [predecessorRecoveryPath] : []),
  ])];
}

function publishedTempGenerationConflict(
  filePath: string,
  tempPath: string,
  isolatedPath: string,
  predecessorRecoveryPath: string,
  cleanupCommitted: boolean,
  expected: SessionFileAuthority,
  cause?: unknown,
) {
  return Object.assign(new Error(
    cleanupCommitted
      ? `published session-cache temp generation changed after isolation; recovery evidence preserved: ${isolatedPath}`
      : `published session-cache temp generation changed before isolation; successor preserved: ${tempPath}`,
    cause === undefined ? undefined : { cause },
  ), {
    code: "SESSION_CACHE_TEMP_RETIRE_GENERATION_CONFLICT",
    committed: true,
    publicationKind: "hard-link",
    publicationCommitted: true,
    cleanupCommitted,
    removalCommitted: false,
    committedPath: filePath,
    ...(cleanupCommitted ? { cleanupCommittedPath: isolatedPath } : {}),
    tempPreserved: !cleanupCommitted,
    quarantinePreserved: cleanupCommitted,
    successorPreserved: true,
    recoveryPaths: publishedTempRecoveryPaths(
      filePath,
      tempPath,
      cleanupCommitted ? isolatedPath : "",
      predecessorRecoveryPath,
    ),
    expectedGeneration: {
      ...expected.generation,
      dev: String(expected.generation.dev),
      ino: String(expected.generation.ino),
      owner: expected.owner,
    },
  });
}

function publishedTempRetirementAmbiguous(
  code: "SESSION_CACHE_TEMP_RETIRE_ISOLATED_AMBIGUOUS" | "SESSION_CACHE_TEMP_RETIRE_COMMITTED_AMBIGUOUS",
  filePath: string,
  tempPath: string,
  isolatedPath: string,
  predecessorRecoveryPath: string,
  removalCommitted: boolean,
  cause: unknown,
) {
  return Object.assign(new Error(
    removalCommitted
      ? `published session-cache temp deletion committed with ambiguous durability: ${filePath}`
      : `published session-cache temp isolation committed with ambiguous durability: ${isolatedPath}`,
    { cause },
  ), {
    code,
    primaryError: cause,
    cleanupErrors: [],
    committed: true,
    publicationKind: "hard-link",
    publicationCommitted: true,
    cleanupCommitted: true,
    removalCommitted,
    committedPath: filePath,
    ...(!removalCommitted ? { cleanupCommittedPath: isolatedPath } : {}),
    tempPreserved: false,
    quarantinePreserved: !removalCommitted,
    recoveryPaths: publishedTempRecoveryPaths(
      filePath,
      tempPath,
      removalCommitted ? "" : isolatedPath,
      predecessorRecoveryPath,
    ),
  });
}

function publishedTempCanonicalConflict(
  filePath: string,
  tempPath: string,
  predecessorRecoveryPath: string,
  cause?: unknown,
) {
  return Object.assign(new Error(
    `published session-cache authority changed after temp retirement: ${filePath}`,
    cause === undefined ? undefined : { cause },
  ), {
    code: "SESSION_CACHE_TEMP_RETIRE_CANONICAL_CONFLICT",
    committed: true,
    publicationKind: "hard-link",
    publicationCommitted: true,
    cleanupCommitted: true,
    removalCommitted: true,
    committedPath: filePath,
    tempPreserved: false,
    quarantinePreserved: false,
    successorPreserved: true,
    recoveryPaths: publishedTempRecoveryPaths(filePath, tempPath, "", predecessorRecoveryPath),
  });
}

async function readPublishedTempAuthority(
  expected: SessionFileAuthority,
  filePath: string,
  tempPath: string,
  isolatedPath: string,
  predecessorRecoveryPath: string,
  cleanupCommitted: boolean,
  hooks: SessionCacheTestHooks,
  { moved = false }: { moved?: boolean } = {},
) {
  let current: Awaited<ReturnType<typeof readSessionFile>>;
  try {
    current = await readSessionFile(cleanupCommitted ? isolatedPath : tempPath, hooks.readFile);
  } catch (error) {
    throw publishedTempGenerationConflict(
      filePath,
      tempPath,
      isolatedPath,
      predecessorRecoveryPath,
      cleanupCommitted,
      expected,
      error,
    );
  }
  const generationMatches = moved
    ? sameMovedSessionFileGeneration(expected.generation, current.authority.generation)
    : sameSessionFileGeneration(expected.generation, current.authority.generation);
  if (
    !generationMatches
    || expected.sha256 !== current.authority.sha256
    || !sameSessionFileOwner(expected.owner, current.authority.owner)
  ) {
    throw publishedTempGenerationConflict(
      filePath,
      tempPath,
      isolatedPath,
      predecessorRecoveryPath,
      cleanupCommitted,
      expected,
    );
  }
  return current;
}

async function unusedPublishedTempIsolationPath(parent: string, filePath: string) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = path.join(
      parent,
      `.${path.basename(filePath)}.write-temp-retire.${randomUUID()}.recovery`,
    );
    try {
      await lstat(candidate);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return candidate;
      throw error;
    }
  }
  throw Object.assign(new Error(`could not allocate a private session-cache temp retirement path: ${filePath}`), {
    code: "SESSION_CACHE_TEMP_RETIRE_PATH_EXHAUSTED",
    committed: true,
    publicationCommitted: true,
    cleanupCommitted: false,
    removalCommitted: false,
    committedPath: filePath,
    recoveryPaths: [filePath, parent],
  });
}

async function retirePublishedTempDurable(
  filePath: string,
  tempPath: string,
  publishedAuthority: SessionFileAuthority,
  predecessorRecoveryPath: string,
  hooks: SessionCacheTestHooks,
) {
  const parent = path.dirname(filePath);
  let linkedTemp = await readPublishedTempAuthority(
    publishedAuthority,
    filePath,
    tempPath,
    "",
    predecessorRecoveryPath,
    false,
    hooks,
  );
  let canonical = await readSessionFile(filePath, hooks.readFile);
  if (!sameSessionFileGeneration(linkedTemp.authority.generation, canonical.authority.generation)
    || linkedTemp.authority.sha256 !== canonical.authority.sha256
    || !sameSessionFileOwner(linkedTemp.authority.owner, canonical.authority.owner)) {
    throw publishedTempGenerationConflict(
      filePath,
      tempPath,
      "",
      predecessorRecoveryPath,
      false,
      linkedTemp.authority,
    );
  }

  await assertSafeDirectoryChain(parent);
  linkedTemp = await readPublishedTempAuthority(
    linkedTemp.authority,
    filePath,
    tempPath,
    "",
    predecessorRecoveryPath,
    false,
    hooks,
  );
  canonical = await readSessionFile(filePath, hooks.readFile);
  if (!sameSessionFileGeneration(linkedTemp.authority.generation, canonical.authority.generation)
    || linkedTemp.authority.sha256 !== canonical.authority.sha256
    || !sameSessionFileOwner(linkedTemp.authority.owner, canonical.authority.owner)) {
    throw publishedTempGenerationConflict(
      filePath,
      tempPath,
      "",
      predecessorRecoveryPath,
      false,
      linkedTemp.authority,
    );
  }

  // Allocate the private destination only after every pre-rename hook and
  // authority check so no deterministic replacement window is exposed.
  const isolatedPath = await unusedPublishedTempIsolationPath(parent, filePath);
  try {
    await rename(tempPath, isolatedPath);
  } catch (error) {
    throw publishedTempGenerationConflict(
      filePath,
      tempPath,
      isolatedPath,
      predecessorRecoveryPath,
      false,
      linkedTemp.authority,
      error,
    );
  }
  try {
    await syncDirectory(parent, "write-temp-retire", hooks);
  } catch (error) {
    throw publishedTempRetirementAmbiguous(
      "SESSION_CACHE_TEMP_RETIRE_ISOLATED_AMBIGUOUS",
      filePath,
      tempPath,
      isolatedPath,
      predecessorRecoveryPath,
      false,
      error,
    );
  }

  const isolated = await readPublishedTempAuthority(
    linkedTemp.authority,
    filePath,
    tempPath,
    isolatedPath,
    predecessorRecoveryPath,
    true,
    hooks,
    { moved: true },
  );
  let canonicalAfterIsolation: Awaited<ReturnType<typeof readSessionFile>>;
  try {
    canonicalAfterIsolation = await readSessionFile(filePath, hooks.readFile);
  } catch (error) {
    throw publishedTempGenerationConflict(
      filePath,
      tempPath,
      isolatedPath,
      predecessorRecoveryPath,
      true,
      isolated.authority,
      error,
    );
  }
  if (!sameSessionFileGeneration(isolated.authority.generation, canonicalAfterIsolation.authority.generation)
    || isolated.authority.sha256 !== canonicalAfterIsolation.authority.sha256
    || !sameSessionFileOwner(isolated.authority.owner, canonicalAfterIsolation.authority.owner)) {
    throw publishedTempGenerationConflict(
      filePath,
      tempPath,
      isolatedPath,
      predecessorRecoveryPath,
      true,
      isolated.authority,
    );
  }

  await hooks.beforePublishedTempRemoval?.({ filePath, tempPath, isolatedPath });
  const finalIsolated = await readPublishedTempAuthority(
    isolated.authority,
    filePath,
    tempPath,
    isolatedPath,
    predecessorRecoveryPath,
    true,
    hooks,
  );
  let finalCanonical: Awaited<ReturnType<typeof readSessionFile>>;
  try {
    finalCanonical = await readSessionFile(filePath, hooks.readFile);
  } catch (error) {
    throw publishedTempGenerationConflict(
      filePath,
      tempPath,
      isolatedPath,
      predecessorRecoveryPath,
      true,
      finalIsolated.authority,
      error,
    );
  }
  if (!sameSessionFileGeneration(finalIsolated.authority.generation, finalCanonical.authority.generation)
    || finalIsolated.authority.sha256 !== finalCanonical.authority.sha256
    || !sameSessionFileOwner(finalIsolated.authority.owner, finalCanonical.authority.owner)) {
    throw publishedTempGenerationConflict(
      filePath,
      tempPath,
      isolatedPath,
      predecessorRecoveryPath,
      true,
      finalIsolated.authority,
    );
  }

  try {
    // The canonical authority and this private random isolation name were both
    // re-pinned immediately above. Canonical cache paths are never unlinked.
    await unlink(isolatedPath);
  } catch (error) {
    throw publishedTempGenerationConflict(
      filePath,
      tempPath,
      isolatedPath,
      predecessorRecoveryPath,
      true,
      finalIsolated.authority,
      error,
    );
  }
  try {
    await syncDirectory(parent, "write-temp-delete", hooks);
  } catch (error) {
    throw publishedTempRetirementAmbiguous(
      "SESSION_CACHE_TEMP_RETIRE_COMMITTED_AMBIGUOUS",
      filePath,
      tempPath,
      isolatedPath,
      predecessorRecoveryPath,
      true,
      error,
    );
  }

  let confirmedCanonical: Awaited<ReturnType<typeof readSessionFile>>;
  try {
    confirmedCanonical = await readSessionFile(filePath, hooks.readFile);
  } catch (error) {
    throw publishedTempCanonicalConflict(filePath, tempPath, predecessorRecoveryPath, error);
  }
  if (!sameLinkedSessionAuthority(finalCanonical.authority, confirmedCanonical.authority)) {
    throw publishedTempCanonicalConflict(filePath, tempPath, predecessorRecoveryPath);
  }
}

async function writeSessionAtomic(
  filePath: string,
  value: unknown,
  hooks: SessionCacheTestHooks,
) {
  const parent = path.dirname(filePath);
  await ensureSafeSessionDirectory(parent);
  const tempPath = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(payload, "utf8") > SESSION_CACHE_MAX_BYTES) {
    throw Object.assign(new Error(`session cache record exceeds ${SESSION_CACHE_MAX_BYTES} bytes: ${filePath}`), {
      code: "SESSION_CACHE_TOO_LARGE",
      committed: false,
    });
  }
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let tempCreated = false;
  let tempAuthority: SessionFileAuthority | null = null;
  let publicationCommitted = false;
  let predecessorRecoveryPath = "";
  let primaryError: unknown = null;
  try {
    if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
      throw sessionCacheUnsafe(tempPath, new Error("O_NOFOLLOW is unavailable"));
    }
    handle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    tempCreated = true;
    await handle.writeFile(payload, "utf8");
    await handle.sync();
    const info = await handle.stat();
    if (!info.isFile() || info.isSymbolicLink()) {
      throw sessionCacheUnsafe(tempPath, new Error("temporary cache path is not a regular file"));
    }
    tempAuthority = {
      filePath: tempPath,
      generation: sessionFileGeneration(info),
      sha256: createHash("sha256").update(payload, "utf8").digest("hex"),
      owner: sessionFileOwner(value as LooseRecord),
    };
    await handle.close();
    handle = null;

    let predecessor: Awaited<ReturnType<typeof readSessionFile>> | null = null;
    try {
      predecessor = await readSessionFile(filePath, hooks.readFile);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (predecessor) {
      assertSessionRecordBinding(predecessor.record, filePath, {
        agent: tempAuthority.owner.agent,
        conversationKey: tempAuthority.owner.conversationKey,
      });
      predecessorRecoveryPath = await removeSessionAuthorityDurable(
        predecessor.authority,
        "write-replace",
        hooks,
      );
    }

    await hooks.beforeWritePublish?.({
      filePath,
      tempPath,
      predecessorRecoveryPath: predecessorRecoveryPath || null,
    });
    await repinSessionFileAuthority(tempAuthority, tempPath);
    await assertSafeDirectoryChain(parent);
    try {
      await link(tempPath, filePath);
      publicationCommitted = true;
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        throw Object.assign(new Error(
          `session cache publication refused to overwrite a successor: ${filePath}`,
          { cause: error },
        ), {
          code: "SESSION_CACHE_PUBLISH_CONFLICT",
          committed: Boolean(predecessorRecoveryPath),
          publicationKind: "hard-link",
          publicationCommitted: false,
          committedPath: predecessorRecoveryPath || null,
          tempPreserved: true,
          quarantinePreserved: Boolean(predecessorRecoveryPath),
          successorPreserved: true,
          recoveryPaths: [
            filePath,
            tempPath,
            parent,
            ...(predecessorRecoveryPath ? [predecessorRecoveryPath] : []),
          ],
        });
      }
      throw error;
    }

    const published = await readSessionFile(filePath, hooks.readFile);
    if (!sameLinkedSessionAuthority(tempAuthority, published.authority)) {
      throw publicationGenerationConflict(filePath, tempPath, predecessorRecoveryPath);
    }
    await syncDirectory(parent, "write-commit", hooks);
    const confirmed = await readSessionFile(filePath, hooks.readFile);
    if (
      !sameSessionFileGeneration(published.authority.generation, confirmed.authority.generation)
      || published.authority.sha256 !== confirmed.authority.sha256
      || !sameSessionFileOwner(published.authority.owner, confirmed.authority.owner)
    ) {
      throw publicationGenerationConflict(filePath, tempPath, predecessorRecoveryPath);
    }
    await retirePublishedTempDurable(
      filePath,
      tempPath,
      confirmed.authority,
      predecessorRecoveryPath,
      hooks,
    );
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown = null;
  if (handle) {
    try { await handle.close(); } catch (error) { closeError = error; }
  }
  let cleanupError: unknown = null;
  let cleanupRecoveryPath = "";
  if (!publicationCommitted) {
    if (tempAuthority) {
      try {
        cleanupRecoveryPath = await removeSessionAuthorityDurable(tempAuthority, "write-temp-remove", hooks);
      } catch (error) {
        cleanupError = error;
      }
    } else if (tempCreated) {
      cleanupError = Object.assign(new Error(
        `session cache temporary file could not be safely identified; recovery evidence preserved: ${tempPath}`,
      ), {
        code: "SESSION_CACHE_TEMP_PRESERVED",
        committed: false,
        recoveryPaths: [tempPath, parent],
      });
    }
  }
  const errors = [primaryError, closeError, cleanupError].filter((error) => error !== null);
  if (errors.length === 0) return;
  const cause = errors.length === 1
    ? errors[0]
    : new AggregateError(errors, `session cache write and cleanup failed: ${filePath}`, { cause: primaryError ?? errors[0] });
  const committed = publicationCommitted
    || Boolean(predecessorRecoveryPath)
    || nestedCommitted(primaryError);
  const cleanupCommitted = Boolean(cleanupRecoveryPath)
    || nestedMetadataTrue(primaryError, "cleanupCommitted")
    || nestedMetadataTrue(cleanupError, "cleanupCommitted")
    || nestedCommitted(cleanupError);
  const removalCommitted = nestedMetadataTrue(primaryError, "removalCommitted")
    || nestedMetadataTrue(cleanupError, "removalCommitted");
  const recoveryPaths = [...new Set([
    ...(publicationCommitted ? [filePath, tempPath, parent] : []),
    ...(predecessorRecoveryPath ? [predecessorRecoveryPath] : []),
    ...(cleanupRecoveryPath ? [cleanupRecoveryPath] : []),
    ...errors.flatMap((error) => nestedRecoveryPaths(error)),
  ])];
  throw Object.assign(new Error(
    publicationCommitted
      ? `session cache write committed with ambiguous durability: ${filePath}`
      : `session cache write failed: ${filePath}`,
    { cause },
  ), {
    code: publicationCommitted ? "SESSION_CACHE_COMMITTED_AMBIGUOUS" : "SESSION_CACHE_WRITE_FAILED",
    primaryError,
    cleanupErrors: [closeError, cleanupError].filter((error) => error !== null),
    committed,
    publicationKind: "hard-link",
    publicationCommitted,
    cleanupCommitted,
    ...(removalCommitted ? { removalCommitted: true } : {}),
    ...(cleanupRecoveryPath ? { cleanupCommittedPath: cleanupRecoveryPath } : {}),
    ...(publicationCommitted
      ? { committedPath: filePath }
      : predecessorRecoveryPath || cleanupRecoveryPath
        ? { committedPath: predecessorRecoveryPath || cleanupRecoveryPath }
        : {}),
    ...(cleanupRecoveryPath
      ? { tempPreserved: true }
      : nestedMetadataTrue(primaryError, "tempPreserved")
        ? { tempPreserved: true }
      : publicationCommitted || tempCreated
        ? { tempPreserved: null }
        : {}),
    quarantinePreserved: Boolean(predecessorRecoveryPath)
      || Boolean(cleanupRecoveryPath)
      || nestedMetadataTrue(primaryError, "quarantinePreserved")
      || nestedMetadataTrue(cleanupError, "quarantinePreserved"),
    ...(nestedMetadataTrue(primaryError, "successorPreserved")
      || nestedMetadataTrue(cleanupError, "successorPreserved")
      ? { successorPreserved: true }
      : {}),
    ...(recoveryPaths.length > 0 ? { recoveryPaths } : {}),
  });
}

async function readSessionFile(filePath: string, hooks?: BoundedRegularFileReadHooks) {
  let capturedGeneration: SessionFileGeneration | null = null;
  let raw: string;
  try {
    raw = await readBoundedRegularFileNoFollow(filePath, {
      maxBytes: SESSION_CACHE_MAX_BYTES,
      hooks: {
        afterOpen: hooks?.afterOpen,
        afterChunk: hooks?.afterChunk,
        beforePathGenerationCheck: async (context) => {
          await hooks?.beforePathGenerationCheck?.(context);
          let info: Awaited<ReturnType<typeof lstat>>;
          try {
            info = await lstat(filePath);
          } catch (error) {
            throw sessionCacheUnsafe(filePath, error);
          }
          if (!info.isFile() || info.isSymbolicLink()) {
            throw sessionCacheUnsafe(filePath, new Error("session cache path is not a regular file"));
          }
          capturedGeneration = sessionFileGeneration(info);
        },
      },
    });
  } catch (error) {
    if (errorCode(error).startsWith("BOUNDED_FILE_")) throw sessionCacheUnsafe(filePath, error);
    throw error;
  }
  if (!capturedGeneration) throw sessionCacheUnsafe(filePath, new Error("session cache generation was not captured"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw Object.assign(new Error(`session cache JSON is malformed: ${filePath}`, { cause: error }), {
      code: "SESSION_CACHE_INVALID",
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error(`session cache record is malformed: ${filePath}`), { code: "SESSION_CACHE_INVALID" });
  }
  const record = parsed as LooseRecord;
  if (
    typeof record.agent !== "string"
    || !record.agent
    || typeof record.sessionId !== "string"
    || !record.sessionId
    || typeof record.savedAt !== "string"
    || Number.isNaN(Date.parse(record.savedAt))
    || new Date(Date.parse(record.savedAt)).toISOString() !== record.savedAt
    || (record.conversationKey !== undefined && typeof record.conversationKey !== "string")
    || (record.format !== undefined && record.format !== SESSION_CACHE_FORMAT)
    || (record.format === SESSION_CACHE_FORMAT && (typeof record.generation !== "string" || !UUID_RE.test(record.generation)))
    || (record.format === undefined && record.generation !== undefined)
  ) throw Object.assign(new Error(`session cache record is malformed: ${filePath}`), { code: "SESSION_CACHE_INVALID" });
  return {
    record,
    authority: {
      filePath,
      generation: capturedGeneration,
      sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
      owner: sessionFileOwner(record),
    } satisfies SessionFileAuthority,
  };
}

function assertSessionRecordBinding(
  record: LooseRecord,
  filePath: string,
  expected?: { agent: string; conversationKey: string },
) {
  const owner = sessionFileOwner(record);
  if (
    expected
    && (owner.agent !== expected.agent || owner.conversationKey !== expected.conversationKey)
  ) {
    throw Object.assign(new Error(`session cache owner mismatch: ${filePath}`), { code: "SESSION_CACHE_INVALID" });
  }
  let ownerFileName: string;
  try {
    ownerFileName = `${cacheEntryName(owner.agent, owner.conversationKey)}.json`;
  } catch (error) {
    throw Object.assign(new Error(`session cache owner is malformed: ${filePath}`, { cause: error }), {
      code: "SESSION_CACHE_INVALID",
    });
  }
  if (path.basename(filePath) !== ownerFileName) {
    throw Object.assign(new Error(`session cache owner does not match path: ${filePath}`), {
      code: "SESSION_CACHE_INVALID",
    });
  }
}

/**
 * Save a session ID for an agent (cached lifecycle mode).
 * Explicit conversation keys receive independent durable entries; calls without
 * a key retain the legacy agent-level cache entry.
 */
export async function saveSessionId(cpbRoot: string, agent: string, sessionId: string, meta: LooseRecord = {}) {
  if (typeof sessionId !== "string" || !sessionId) {
    throw Object.assign(new Error("session cache sessionId must be a non-empty string"), {
      code: "SESSION_CACHE_SESSION_INVALID",
    });
  }
  const conversationKey = normalizeConversationKey(meta.conversationKey);
  const cacheOptions = { dataRoot: meta.dataRoot };
  const dir = cacheDir(cpbRoot, cacheOptions);
  const filePath = sessionFile(cpbRoot, agent, conversationKey, cacheOptions);
  const hooks = sessionCacheTestHookStorage.getStore() || {};
  await ensureSafeSessionDirectory(dir);
  const { dataRoot: _dataRoot, conversationKey: _conversationKey, ...persistedMeta } = meta;
  const data = {
    ...persistedMeta,
    format: SESSION_CACHE_FORMAT,
    generation: randomUUID(),
    agent,
    sessionId,
    savedAt: new Date().toISOString(),
    ...(conversationKey ? { conversationKey } : {}),
  };
  await withDurableDirectoryLock(
    lockDir(cpbRoot, agent, conversationKey, cacheOptions),
    () => writeSessionAtomic(filePath, data, hooks),
    { ttlMs: LOCK_TTL_MS },
  );
}

/**
 * Load a cached session ID for an agent.
 * Returns null if no cache exists or if the cache is expired.
 */
export async function loadSessionId(cpbRoot: string, agent: string, {
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = Date.now(),
  conversationKey: requestedConversationKey = "",
  dataRoot,
}: LooseRecord = {}) {
  const conversationKey = normalizeConversationKey(requestedConversationKey);
  const cacheOptions = { dataRoot };
  const effectiveMaxAgeMs = finiteNumber(maxAgeMs, DEFAULT_MAX_AGE_MS);
  const effectiveNow = finiteNumber(now, Date.now());
  const dir = cacheDir(cpbRoot, cacheOptions);
  if (!await safeSessionDirectoryExists(dir)) return null;
  const filePath = sessionFile(cpbRoot, agent, conversationKey, cacheOptions);
  const hooks = sessionCacheTestHookStorage.getStore() || {};
  return withDurableDirectoryLock(
    lockDir(cpbRoot, agent, conversationKey, cacheOptions),
    async () => {
      let data: LooseRecord;
      try {
        const read = await readSessionFile(filePath, hooks.readFile);
        data = read.record;
      } catch (error) {
        if (errorCode(error) === "ENOENT") return null;
        throw error;
      }
      assertSessionRecordBinding(data, filePath, { agent, conversationKey });
      const savedAt = Date.parse(String(data.savedAt));
      if (effectiveNow - savedAt > effectiveMaxAgeMs) return null;
      return data;
    },
    { ttlMs: LOCK_TTL_MS },
  );
}

/**
 * Remove a cached session for an agent.
 */
export async function clearSessionId(cpbRoot: string, agent: string, { conversationKey: requestedConversationKey = "", dataRoot }: LooseRecord = {}) {
  const conversationKey = normalizeConversationKey(requestedConversationKey);
  const cacheOptions = { dataRoot };
  const dir = cacheDir(cpbRoot, cacheOptions);
  if (!await safeSessionDirectoryExists(dir)) return;
  const hooks = sessionCacheTestHookStorage.getStore() || {};
  await withDurableDirectoryLock(
    lockDir(cpbRoot, agent, conversationKey, cacheOptions),
    async () => {
      const filePath = sessionFile(cpbRoot, agent, conversationKey, cacheOptions);
      let read: Awaited<ReturnType<typeof readSessionFile>>;
      try {
        read = await readSessionFile(filePath, hooks.readFile);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return;
        throw error;
      }
      assertSessionRecordBinding(read.record, filePath, { agent, conversationKey });
      await removeSessionAuthorityDurable(read.authority, "clear-remove", hooks);
    },
    { ttlMs: LOCK_TTL_MS },
  );
}

/**
 * Remove all expired cached sessions.
 * Returns the number of entries cleaned.
 */
export async function cleanupSessionCache(cpbRoot: string, { maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now(), dataRoot }: LooseRecord = {}) {
  const effectiveMaxAgeMs = finiteNumber(maxAgeMs, DEFAULT_MAX_AGE_MS);
  const effectiveNow = finiteNumber(now, Date.now());
  const dir = cacheDir(cpbRoot, { dataRoot });
  const hooks = sessionCacheTestHookStorage.getStore() || {};
  let files: string[];
  try {
    await assertSafeDirectoryChain(dir);
    files = await readdir(dir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return 0;
    throw error;
  }

  let cleaned = 0;
  const cleanupErrors: unknown[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const filePath = path.join(dir, f);
    const entryLockDir = path.join(dir, `${f.slice(0, -".json".length)}.lock`);
    try {
      await withDurableDirectoryLock(entryLockDir, async () => {
        let read: Awaited<ReturnType<typeof readSessionFile>>;
        try {
          read = await readSessionFile(filePath, hooks.readFile);
        } catch (error) {
          if (errorCode(error) === "ENOENT") return;
          throw error;
        }
        assertSessionRecordBinding(read.record, filePath);
        const savedAt = Date.parse(String(read.record.savedAt));
        if (effectiveNow - savedAt <= effectiveMaxAgeMs) return;
        await removeSessionAuthorityDurable(read.authority, "cleanup-remove", hooks);
        cleaned += 1;
      }, { ttlMs: LOCK_TTL_MS });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    const recoveryPaths = [...new Set(cleanupErrors.flatMap((error) => nestedRecoveryPaths(error)))];
    throw Object.assign(new AggregateError(cleanupErrors, `session cache cleanup failed for ${cleanupErrors.length} entries`, {
      cause: cleanupErrors[0],
    }), {
      code: "SESSION_CACHE_CLEANUP_FAILED",
      primaryError: cleanupErrors[0],
      cleanupErrors,
      committed: cleanupErrors.some((error) => nestedCommitted(error)),
      ...(recoveryPaths.length > 0 ? { recoveryPaths } : {}),
    });
  }
  return cleaned;
}
