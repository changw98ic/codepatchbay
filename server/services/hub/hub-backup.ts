import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, createReadStream, fstatSync, lstatSync, renameSync, type Stats } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  statfs,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { recordValue, type LooseRecord } from "../../../shared/types.js";
import {
  acquireHubMaintenance,
  fsyncDirectory,
  hubRestoreJournalPath,
  recoverStaleHubMaintenance,
  removeDurable,
  writeJsonDurableAtomic,
} from "../../../shared/hub-maintenance.js";
import { readLeaderStatus } from "../../orchestrator/leader-lock.js";
import { listProjects, readHubLiveness } from "./hub-registry.js";
import {
  openPinnedHubRedisStateBackend,
  type HubRedisStateBackend,
  type RedisLogicalSnapshot,
} from "../../../shared/hub-state-redis.js";
import { captureProcessIdentity, sameProcessIdentity, type ProcessIdentity } from "../../../core/runtime/process-tree.js";
import {
  readBoundedRegularFileNoFollow,
  type BoundedRegularFileReadHooks,
} from "../../../core/runtime/durable-directory-lock.js";

const BACKUP_FORMAT = "cpb-hub-backup/v1";
const MAX_BACKUP_ENTRIES = 500_000;
const MAX_MANIFEST_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_PATH_BYTES = 4096;
const MAX_MANIFEST_PATH_DEPTH = 256;
const MAX_REDIS_SNAPSHOT_BYTES = 300 * 1024 * 1024;
const DEFAULT_MINIMUM_FREE_BYTES = 256 * 1024 * 1024;
const COPY_SPACE_FIXED_OVERHEAD_BYTES = 16 * 1024 * 1024;
const COPY_SPACE_PER_ENTRY_BYTES = 8 * 1024;
const MAX_OFFLINE_RECORD_BYTES = 1024 * 1024;
const MAX_BACKUP_STAGE_OWNER_BYTES = 64 * 1024;
const MAX_RESTORE_JOURNAL_BYTES = 1024 * 1024;
const MAX_DIGEST_FILE_BYTES = 4096;
const OPERATION_TOKEN_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

type HubBackupMetadataReadKind =
  | "offline-record"
  | "backup-stage-owner"
  | "restore-journal"
  | "redis-rollback"
  | "redis-artifact"
  | "backup-manifest"
  | "backup-digest"
  | "redis-snapshot";

type HubBackupTestHooks = {
  readHooks?: Partial<Record<HubBackupMetadataReadKind, BoundedRegularFileReadHooks>>;
  beforeFileFsyncOpen?: (context: { filePath: string }) => void | Promise<void>;
  beforeDirectoryAuthorityOpen?: (context: { directoryPath: string; label: string }) => void | Promise<void>;
  beforeOwnedStageRemoval?: (context: { stagePath: string; ownerPath: string }) => void | Promise<void>;
  beforeOwnedStageIsolation?: (context: { stagePath: string; ownerPath: string; quarantinePath: string }) => void | Promise<void>;
  afterOwnedStageIsolation?: (context: { stagePath: string; ownerPath: string; quarantinePath: string }) => void | Promise<void>;
  beforeOwnedStageFinalCheck?: (context: { stagePath: string; ownerPath: string; quarantinePath: string }) => void | Promise<void>;
  beforeOwnedStageOwnerCleanup?: (context: { stagePath: string; ownerPath: string; quarantinePath: string }) => void | Promise<void>;
  afterOwnedStageOwnerCleanup?: (context: { stagePath: string; ownerPath: string; quarantinePath: string }) => void | Promise<void>;
  beforeBackupStageCreate?: (context: { stagePath: string; ownerPath: string }) => void | Promise<void>;
  beforeRestoreStageRemoval?: (context: { stagePath: string; journalPath: string }) => void | Promise<void>;
  beforeRestoreStageIsolation?: (context: { stagePath: string; journalPath: string; quarantinePath: string }) => void | Promise<void>;
  afterRestoreStageIsolation?: (context: { stagePath: string; journalPath: string; quarantinePath: string }) => void | Promise<void>;
  beforeRestoreStageFinalCheck?: (context: { stagePath: string; journalPath: string; quarantinePath: string }) => void | Promise<void>;
  beforeRestoreJournalCleanupAfterStageIsolation?: (context: { stagePath: string; journalPath: string; quarantinePath: string }) => void | Promise<void>;
  afterRestoreJournalCleanupAfterStageIsolation?: (context: { stagePath: string; journalPath: string; quarantinePath: string }) => void | Promise<void>;
  beforeRestoreJournalFirstCreate?: (context: { journalPath: string }) => void | Promise<void>;
  beforeRestoreJournalUpdatePublish?: (context: { journalPath: string; tempPath: string }) => void | Promise<void>;
  beforeDirectoryNoClobberPublish?: (context: {
    sourcePath: string;
    destinationPath: string;
    carrierPath: string;
  }) => void | Promise<void>;
  beforeRollbackRestore?: (context: { canonicalPath: string; rollbackPath: string; journalPath: string }) => void | Promise<void>;
  beforeRestoreStagePublish?: (context: { canonicalPath: string; stagePath: string; journalPath: string }) => void | Promise<void>;
  beforeRestoreTargetMove?: (context: { targetPath: string; rollbackPath: string; journalPath: string }) => void | Promise<void>;
  afterRedisSnapshotRepin?: (context: { filePath: string }) => void | Promise<void>;
  beforeRedisSnapshotFinalIsolation?: (context: { filePath: string; quarantinePath: string }) => void | Promise<void>;
  beforeFinishRedisRestoreRecovery?: (context: { journalPath: string; hasRedisSession: boolean }) => void | Promise<void>;
  syncDirectory?: (context: { directory: string; operation: string }) => void | Promise<void>;
};

const hubBackupTestHookStorage = new AsyncLocalStorage<Readonly<HubBackupTestHooks>>();

export async function withHubBackupTestHooksForTests<T>(
  hooks: HubBackupTestHooks,
  operation: () => Promise<T>,
) {
  const inherited = hubBackupTestHookStorage.getStore();
  const readHooks = inherited?.readHooks || hooks.readHooks
    ? Object.freeze({ ...inherited?.readHooks, ...hooks.readHooks })
    : undefined;
  return await hubBackupTestHookStorage.run(
    Object.freeze({ ...inherited, ...hooks, ...(readHooks ? { readHooks } : {}) }),
    operation,
  );
}

function currentHubBackupTestHooks() {
  return hubBackupTestHookStorage.getStore();
}

type PathGeneration = {
  dev: bigint | number;
  ino: bigint | number;
  size: bigint | number;
  mtimeMs: bigint | number;
  ctimeMs: bigint | number;
  birthtimeMs: bigint | number;
};

type PersistedPathGeneration = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
};

type FileAuthority = {
  filePath: string;
  generation: PathGeneration;
  mode: number;
  sha256: string;
  maxBytes: number;
  kind: HubBackupMetadataReadKind;
};

type DirectoryAuthority = {
  directoryPath: string;
  generation: PathGeneration;
};

type HeldDirectoryAuthority = DirectoryAuthority & {
  handle: Awaited<ReturnType<typeof open>>;
};

type DirectoryIsolationEvidence = {
  quarantinePath: string;
  generation: PathGeneration;
  sourceAuthority: HeldDirectoryAuthority;
  parentAuthority?: HeldDirectoryAuthority;
  parentGeneration?: PathGeneration;
};

type BackupEntryType = "directory" | "file";

export type HubBackupEntry = {
  rootId: string;
  path: string;
  type: BackupEntryType;
  mode: number;
  mtimeMs: number;
  size?: number;
  sha256?: string;
};

export type HubBackupRoot = {
  id: string;
  kind: "hub" | "project-runtime";
  projectId?: string;
  sourcePath: string;
  mode: number;
  entryCount: number;
};

export type HubBackupManifest = {
  format: typeof BACKUP_FORMAT;
  snapshotId: string;
  createdAt: string;
  sourceHubRoot: string;
  roots: HubBackupRoot[];
  entries: HubBackupEntry[];
  fileCount: number;
  totalBytes: number;
  redisSnapshot?: HubBackupRedisSnapshot;
};

export type HubBackupRedisSnapshot = {
  format: "cpb-hub-redis-logical-snapshot/v1";
  rootId: "hub";
  path: string;
  backendIdentityFingerprint: string;
  capturedAt: string;
  logicalSha256: string;
  fileSha256: string;
};

type SourceNode = {
  path: string;
  type: BackupEntryType;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
  size: number;
};

type SourceRoot = {
  id: string;
  kind: HubBackupRoot["kind"];
  projectId?: string;
  sourcePath: string;
};

type InspectedSourceRoot = {
  source: SourceRoot;
  rootInfo: Stats;
  nodes: SourceNode[];
};

type BackupStageOwner = {
  format: "cpb-hub-backup-stage/v2";
  operationToken: string;
  stageGeneration: PersistedPathGeneration;
  hubRoot: string;
  output: string;
  createdAt: string;
};

type VerifiedBackup = {
  backupRoot: string;
  manifest: HubBackupManifest;
};

type BackupVerificationOptions = {
  signingKey?: string;
  requireSignature?: boolean;
  allowUnsignedDev?: boolean;
};

function errnoCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

function pathGeneration(info: Stats): PathGeneration {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    birthtimeMs: info.birthtimeMs,
  };
}

function persistPathGeneration(generation: PathGeneration): PersistedPathGeneration {
  const persisted = Object.fromEntries(Object.entries(generation).map(([key, value]) => [key, Number(value)])) as PersistedPathGeneration;
  if (
    !Number.isSafeInteger(persisted.dev)
    || !Number.isSafeInteger(persisted.ino)
    || !Number.isSafeInteger(persisted.size)
    || [persisted.mtimeMs, persisted.ctimeMs, persisted.birthtimeMs].some((value) => !Number.isFinite(value))
  ) {
    throw Object.assign(new Error("filesystem generation cannot be persisted exactly"), {
      code: "HUB_BACKUP_GENERATION_UNSAFE",
    });
  }
  return persisted;
}

function parsePersistedPathGeneration(value: unknown): PersistedPathGeneration | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = ["dev", "ino", "size", "mtimeMs", "ctimeMs", "birthtimeMs"] as const;
  if (Object.keys(record).length !== keys.length) return null;
  if (
    ["dev", "ino", "size"].some((key) => !Number.isSafeInteger(record[key]) || Number(record[key]) < 0)
    || ["mtimeMs", "ctimeMs", "birthtimeMs"].some((key) => typeof record[key] !== "number" || !Number.isFinite(record[key]))
  ) return null;
  return Object.fromEntries(keys.map((key) => [key, Number(record[key])])) as PersistedPathGeneration;
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

function sameDirectoryLineage(expected: PathGeneration, actual: PathGeneration) {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.birthtimeMs === actual.birthtimeMs;
}

async function recoveryPathHasAuthority(candidatePath: string) {
  if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) return false;
  let before: Stats;
  try {
    before = await lstat(candidatePath);
  } catch {
    return false;
  }
  if (before.isSymbolicLink() || (!before.isFile() && !before.isDirectory())) return false;
  if (before.isDirectory()
    && (typeof constants.O_DIRECTORY !== "number" || constants.O_DIRECTORY === 0)) return false;

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let opened: Stats | null = null;
  let openedMatches = false;
  try {
    const flags = constants.O_RDONLY
      | constants.O_NOFOLLOW
      | (before.isDirectory() ? constants.O_DIRECTORY : 0);
    handle = await open(candidatePath, flags);
    opened = await handle.stat();
    openedMatches = before.isFile() === opened.isFile()
      && before.isDirectory() === opened.isDirectory()
      && samePathGeneration(pathGeneration(before), pathGeneration(opened));
  } catch {
    openedMatches = false;
  }
  if (handle) {
    try {
      await handle.close();
    } catch {
      return false;
    }
  }
  if (!opened || !openedMatches) return false;

  try {
    const after = await lstat(candidatePath);
    return !after.isSymbolicLink()
      && before.isFile() === after.isFile()
      && before.isDirectory() === after.isDirectory()
      && samePathGeneration(pathGeneration(opened), pathGeneration(after));
  } catch {
    return false;
  }
}

async function recoveryMetadata(candidates: Record<string, string>) {
  const recoveryPaths: Record<string, string> = {};
  const attemptedPaths: Record<string, string> = {};
  for (const [key, candidatePath] of Object.entries(candidates)) {
    if (await recoveryPathHasAuthority(candidatePath)) recoveryPaths[key] = candidatePath;
    else attemptedPaths[key] = candidatePath;
  }
  return { recoveryPaths, attemptedPaths };
}

async function authorityChanged(label: string, targetPath: string, candidates: Record<string, string>) {
  const metadata = await recoveryMetadata(candidates);
  return Object.assign(new Error(`${label} authority changed before mutation: ${targetPath}`), {
    code: "HUB_BACKUP_AUTHORITY_CHANGED",
    committed: false,
    committedPath: null,
    ...metadata,
  });
}

function hasCommittedMetadata(error: unknown): error is Error & {
  committed: true;
  committedPath: string;
  recoveryPaths: Record<string, string>;
} {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    committed?: unknown;
    committedPath?: unknown;
    recoveryPaths?: unknown;
  };
  return value.committed === true
    && typeof value.committedPath === "string"
    && value.committedPath.length > 0
    && Boolean(value.recoveryPaths)
    && typeof value.recoveryPaths === "object"
    && !Array.isArray(value.recoveryPaths);
}

function isExplicitlyUncommitted(error: unknown) {
  return Boolean(error && typeof error === "object" && (error as { committed?: unknown }).committed === false);
}

function isRestorePublicationCommitted(error: unknown, targetPath: string) {
  if (!hasCommittedMetadata(error) || error.committedPath !== targetPath) return false;
  return [
    "HUB_RESTORE_STAGE_PUBLISH_COMMITTED_AMBIGUOUS",
    "HUB_RESTORE_COMMITTED_AMBIGUOUS",
  ].includes(errnoCode(error));
}

function recoveryPathsFromError(error: unknown) {
  if (!error || typeof error !== "object") return {};
  const value = error as { recoveryPaths?: unknown; attemptedPaths?: unknown };
  const entries = (candidate: unknown) => candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? Object.entries(candidate).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    : [];
  return Object.fromEntries([
    ...entries(value.attemptedPaths),
    ...entries(value.recoveryPaths),
  ]);
}

async function committedAmbiguityError({
  code,
  message,
  committedPath,
  recoveryPaths,
  cause,
  forcedAttemptedPaths = [],
}: {
  code: "HUB_BACKUP_COMMITTED_AMBIGUOUS" | "HUB_RESTORE_COMMITTED_AMBIGUOUS";
  message: string;
  committedPath: string;
  recoveryPaths: Record<string, string>;
  cause: unknown;
  forcedAttemptedPaths?: string[];
}) {
  const forced = new Set(forcedAttemptedPaths);
  const metadata = await recoveryMetadata(
    Object.fromEntries(Object.entries(recoveryPaths).filter(([, candidatePath]) => !forced.has(candidatePath))),
  );
  for (const [key, candidatePath] of Object.entries(recoveryPaths)) {
    if (forced.has(candidatePath)) metadata.attemptedPaths[key] = candidatePath;
  }
  return Object.assign(new Error(message, { cause }), {
    code,
    committed: true as const,
    committedPath,
    ...metadata,
  });
}

async function incompleteCleanupError({
  code,
  message,
  recoveryPaths,
  primaryError,
  cleanupErrors,
}: {
  code: string;
  message: string;
  recoveryPaths: Record<string, string>;
  primaryError: unknown;
  cleanupErrors: unknown[];
}) {
  const errors = [primaryError, ...cleanupErrors].filter((error) => error !== null && error !== undefined);
  const metadata = await recoveryMetadata(recoveryPaths);
  return Object.assign(new AggregateError(errors, message, { cause: primaryError || cleanupErrors[0] }), {
    code,
    committed: false,
    committedPath: null,
    ...metadata,
    primaryError,
    cleanupErrors,
  });
}

async function readPinnedMetadata(
  filePath: string,
  maxBytes: number,
  kind: HubBackupMetadataReadKind,
): Promise<{ raw: string; authority: FileAuthority }> {
  const before = await lstat(filePath);
  const raw = await readBoundedRegularFileNoFollow(filePath, {
    maxBytes,
    hooks: currentHubBackupTestHooks()?.readHooks?.[kind],
  });
  const after = await lstat(filePath);
  const beforeGeneration = pathGeneration(before);
  const afterGeneration = pathGeneration(after);
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || !after.isFile()
    || after.isSymbolicLink()
    || !samePathGeneration(beforeGeneration, afterGeneration)
  ) {
    throw Object.assign(new Error(`metadata path changed during pinned read: ${filePath}`), {
      code: "BOUNDED_FILE_CHANGED",
    });
  }
  return {
    raw,
    authority: {
      filePath,
      generation: afterGeneration,
      mode: after.mode,
      sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
      maxBytes,
      kind,
    },
  };
}

async function repinFileAuthority(authority: FileAuthority, label: string, recoveryPaths: Record<string, string>) {
  let pinned;
  try {
    pinned = await readPinnedMetadata(authority.filePath, authority.maxBytes, authority.kind);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") throw await authorityChanged(label, authority.filePath, recoveryPaths);
    throw error;
  }
  if (
    !samePathGeneration(authority.generation, pinned.authority.generation)
    || authority.sha256 !== pinned.authority.sha256
  ) {
    throw await authorityChanged(label, authority.filePath, recoveryPaths);
  }
}

async function readDirectoryAuthority(directoryPath: string, label: string): Promise<DirectoryAuthority> {
  if (
    typeof constants.O_NOFOLLOW !== "number"
    || constants.O_NOFOLLOW === 0
    || typeof constants.O_DIRECTORY !== "number"
    || constants.O_DIRECTORY === 0
  ) {
    throw Object.assign(new Error(`strict no-follow directory opens are unavailable for ${label}: ${directoryPath}`), {
      code: "HUB_BACKUP_DIRECTORY_UNSAFE",
    });
  }
  const before = await lstat(directoryPath);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw Object.assign(new Error(`${label} must be a real directory: ${directoryPath}`), {
      code: "HUB_BACKUP_DIRECTORY_UNSAFE",
    });
  }
  await currentHubBackupTestHooks()?.beforeDirectoryAuthorityOpen?.({ directoryPath, label });
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let primaryError: unknown = null;
  let generation: PathGeneration | null = null;
  try {
    handle = await open(directoryPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    const opened = await handle.stat();
    if (
      !opened.isDirectory()
      || opened.isSymbolicLink()
      || !samePathGeneration(pathGeneration(before), pathGeneration(opened))
    ) {
      throw Object.assign(new Error(`${label} directory authority changed while opening: ${directoryPath}`), {
        code: "HUB_BACKUP_DIRECTORY_UNSAFE",
      });
    }
    generation = pathGeneration(opened);
  } catch (error) {
    primaryError = ["ELOOP", "EMLINK", "ENOTDIR"].includes(errnoCode(error))
      ? Object.assign(new Error(`${label} directory authority rejected unsafe path: ${directoryPath}`, { cause: error }), {
        code: "HUB_BACKUP_DIRECTORY_UNSAFE",
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
      new AggregateError([primaryError, closeError], `${label} directory authority open and close failed: ${directoryPath}`, {
        cause: primaryError,
      }),
      { code: errnoCode(primaryError) || "HUB_BACKUP_DIRECTORY_UNSAFE", primaryError, closeError },
    );
  }
  if (closeError) throw closeError;
  if (!generation) {
    throw Object.assign(new Error(`${label} directory authority was not captured: ${directoryPath}`), {
      code: "HUB_BACKUP_DIRECTORY_UNSAFE",
    });
  }
  return { directoryPath, generation };
}

async function readOptionalDirectoryAuthority(directoryPath: string, label: string) {
  try {
    return await readDirectoryAuthority(directoryPath, label);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function repinDirectoryAuthority(
  authority: DirectoryAuthority,
  label: string,
  recoveryPaths: Record<string, string>,
) {
  let observed;
  try {
    observed = await readDirectoryAuthority(authority.directoryPath, label);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") throw await authorityChanged(label, authority.directoryPath, recoveryPaths);
    throw error;
  }
  if (!samePathGeneration(authority.generation, observed.generation)) {
    throw await authorityChanged(label, authority.directoryPath, recoveryPaths);
  }
}

async function repinDirectoryLineage(
  authority: DirectoryAuthority,
  label: string,
  recoveryPaths: Record<string, string>,
) {
  let observed;
  try {
    observed = await readDirectoryAuthority(authority.directoryPath, label);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") throw await authorityChanged(label, authority.directoryPath, recoveryPaths);
    throw error;
  }
  if (!sameDirectoryLineage(authority.generation, observed.generation)) {
    throw await authorityChanged(label, authority.directoryPath, recoveryPaths);
  }
}

async function runNoClobberDirectoryMove(sourcePath: string, destinationPath: string) {
  const executable = process.platform === "win32" ? null : "/bin/mv";
  if (!executable) {
    throw Object.assign(new Error("atomic no-clobber directory publication is unavailable on this platform"), {
      code: "HUB_BACKUP_NO_CLOBBER_UNAVAILABLE",
    });
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ["-n", sourcePath, destinationPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`no-clobber directory move failed (${code ?? signal}): ${stderr.trim()}`), {
        code: "HUB_BACKUP_NO_CLOBBER_MOVE_FAILED",
      }));
    });
  });
}

async function moveDirectoryNoClobber(
  authority: DirectoryAuthority,
  destinationPath: string,
  label: string,
  recoveryPaths: Record<string, string>,
) {
  const sourcePath = authority.directoryPath;
  if (path.dirname(sourcePath) !== path.dirname(destinationPath)) {
    throw new Error(`${label} no-clobber move requires sibling paths`);
  }
  const parentPath = path.dirname(sourcePath);
  const carrierPath = path.join(parentPath, `.cpb-publish-${randomUUID()}`);
  const carrierSourcePath = path.join(carrierPath, path.basename(destinationPath));
  await mkdir(carrierPath, { recursive: false, mode: 0o700 });
  const parentAuthority = await openHeldDirectoryAuthority(parentPath, `${label} parent`);
  const carrierAuthority = await openHeldDirectoryAuthority(carrierPath, `${label} publication carrier`);
  const sourceAuthority = await openHeldDirectoryAuthority(sourcePath, label, authority.generation);
  let moved: DirectoryAuthority | null = null;
  let movedIntoCarrier = false;
  let operationError: unknown = null;
  try {
    try {
      lstatSync(destinationPath);
      throw Object.assign(new Error(`${label} destination successor preserved: ${destinationPath}`), {
        code: "HUB_BACKUP_SUCCESSOR_PRESERVED",
        committed: false,
        committedPath: null,
        successorPreserved: true,
        recoveryPaths: Object.fromEntries(
          Object.entries(recoveryPaths).filter(([, candidatePath]) => candidatePath === sourcePath),
        ),
        attemptedPaths: {
          destination: destinationPath,
          ...Object.fromEntries(
            Object.entries(recoveryPaths).filter(([, candidatePath]) => candidatePath !== sourcePath),
          ),
        },
      });
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
    const sourceDescriptor = fstatSync(sourceAuthority.handle.fd);
    const sourceCurrent = lstatSync(sourcePath);
    const carrierDescriptor = fstatSync(carrierAuthority.handle.fd);
    const carrierCurrent = lstatSync(carrierPath);
    try {
      lstatSync(carrierSourcePath);
      throw new Error(`${label} publication carrier child unexpectedly exists: ${carrierSourcePath}`);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
    if (
      !sourceDescriptor.isDirectory()
      || !sourceCurrent.isDirectory()
      || sourceCurrent.isSymbolicLink()
      || !samePathGeneration(authority.generation, pathGeneration(sourceDescriptor))
      || !samePathGeneration(authority.generation, pathGeneration(sourceCurrent))
      || !carrierDescriptor.isDirectory()
      || !carrierCurrent.isDirectory()
      || carrierCurrent.isSymbolicLink()
      || !samePathGeneration(carrierAuthority.generation, pathGeneration(carrierDescriptor))
      || !samePathGeneration(carrierAuthority.generation, pathGeneration(carrierCurrent))
    ) {
      throw Object.assign(new Error(`${label} authority changed before publication carrier isolation`), {
        code: "HUB_BACKUP_AUTHORITY_CHANGED",
      });
    }
    renameSync(sourcePath, carrierSourcePath);
    movedIntoCarrier = true;

    // The source basename is now exactly the destination basename. `mv -n`
    // publishes it into the parent without ever replacing an occupied entry.
    await currentHubBackupTestHooks()?.beforeDirectoryNoClobberPublish?.({
      sourcePath: carrierSourcePath,
      destinationPath,
      carrierPath,
    });
    await runNoClobberDirectoryMove(carrierSourcePath, parentPath);
    let carrierSourceCurrent: Stats | null = null;
    try {
      carrierSourceCurrent = lstatSync(carrierSourcePath);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
    if (carrierSourceCurrent) {
      throw Object.assign(new Error(`${label} destination successor preserved: ${destinationPath}`), {
        code: "HUB_BACKUP_SUCCESSOR_PRESERVED",
        committed: false,
        committedPath: null,
        successorPreserved: true,
        recoveryPaths: { publicationSource: carrierSourcePath },
        attemptedPaths: {
          destination: destinationPath,
          ...Object.fromEntries(Object.entries(recoveryPaths).map(([key, candidatePath]) => [key, candidatePath])),
        },
      });
    }
    const descriptor = fstatSync(sourceAuthority.handle.fd);
    const destination = lstatSync(destinationPath);
    const parentDescriptor = fstatSync(parentAuthority.handle.fd);
    const parentCurrent = lstatSync(parentPath);
    if (
      !descriptor.isDirectory()
      || !destination.isDirectory()
      || destination.isSymbolicLink()
      || !samePathGenerationAcrossRename(authority.generation, pathGeneration(descriptor))
      || !samePathGenerationAcrossRename(authority.generation, pathGeneration(destination))
      || !parentDescriptor.isDirectory()
      || !parentCurrent.isDirectory()
      || parentCurrent.isSymbolicLink()
      || !sameDirectoryLineage(parentAuthority.generation, pathGeneration(parentDescriptor))
      || !sameDirectoryLineage(parentAuthority.generation, pathGeneration(parentCurrent))
      || !samePathGeneration(pathGeneration(parentDescriptor), pathGeneration(parentCurrent))
    ) {
      throw Object.assign(new Error(`${label} authority changed during no-clobber publication`), {
        code: "HUB_BACKUP_AUTHORITY_CHANGED",
        committed: true,
        committedPath: destinationPath,
      });
    }
    moved = { directoryPath: destinationPath, generation: pathGeneration(destination) };
  } catch (error) {
    const metadata = error && typeof error === "object" && "recoveryPaths" in error
      ? {
        recoveryPaths: (error as { recoveryPaths: Record<string, string> }).recoveryPaths,
        attemptedPaths: (error as { attemptedPaths?: Record<string, string> }).attemptedPaths || {},
      }
      : await recoveryMetadata({
        ...recoveryPaths,
        ...(movedIntoCarrier ? { publicationSource: carrierSourcePath } : {}),
      });
    operationError = Object.assign(error instanceof Error ? error : new Error(String(error)), {
      ...(error && typeof error === "object" && "committed" in error ? {} : {
        committed: false,
        committedPath: null,
      }),
      ...metadata,
    });
  }
  const closeErrors: unknown[] = [];
  for (const held of [sourceAuthority, carrierAuthority, parentAuthority]) {
    try {
      await held.handle.close();
    } catch (error) {
      closeErrors.push(error);
    }
  }
  if (operationError) {
    if (closeErrors.length === 0) throw operationError;
    throw Object.assign(
      new AggregateError([operationError, ...closeErrors], `${label} publication and authority close failed`, {
        cause: operationError,
      }),
      Object.fromEntries(Object.entries(operationError)),
      { primaryError: operationError, closeErrors },
    );
  }
  if (closeErrors.length > 0) {
    throw Object.assign(new AggregateError(closeErrors, `${label} authority close failed`, { cause: closeErrors[0] }), {
      code: "HUB_BACKUP_DIRECTORY_CLOSE_FAILED",
      committed: Boolean(moved),
      committedPath: moved?.directoryPath || null,
      ...(await recoveryMetadata(recoveryPaths)),
    });
  }
  if (!moved) throw new Error(`${label} no-clobber move completed without authority`);
  try {
    await rmdir(carrierPath);
  } catch (error) {
    throw Object.assign(new Error(`${label} published but its private carrier could not be removed: ${carrierPath}`, { cause: error }), {
      code: "HUB_BACKUP_PUBLICATION_CARRIER_CLEANUP_FAILED",
      committed: true,
      committedPath: destinationPath,
      ...(await recoveryMetadata({ ...recoveryPaths, destination: destinationPath, carrier: carrierPath })),
    });
  }
  return moved;
}

async function openHeldDirectoryAuthority(
  directoryPath: string,
  label: string,
  expectedGeneration?: PathGeneration,
): Promise<HeldDirectoryAuthority> {
  if (
    typeof constants.O_NOFOLLOW !== "number"
    || constants.O_NOFOLLOW === 0
    || typeof constants.O_DIRECTORY !== "number"
    || constants.O_DIRECTORY === 0
  ) {
    throw Object.assign(new Error(`strict no-follow directory opens are unavailable for ${label}: ${directoryPath}`), {
      code: "HUB_BACKUP_DIRECTORY_UNSAFE",
    });
  }
  const before = await lstat(directoryPath);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw Object.assign(new Error(`${label} must be a real directory: ${directoryPath}`), {
      code: "HUB_BACKUP_DIRECTORY_UNSAFE",
    });
  }

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(directoryPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    const opened = await handle.stat();
    const after = await lstat(directoryPath);
    const openedGeneration = pathGeneration(opened);
    if (
      !opened.isDirectory()
      || opened.isSymbolicLink()
      || !after.isDirectory()
      || after.isSymbolicLink()
      || !samePathGeneration(pathGeneration(before), openedGeneration)
      || !samePathGeneration(openedGeneration, pathGeneration(after))
      || (expectedGeneration && !samePathGeneration(expectedGeneration, openedGeneration))
    ) {
      throw Object.assign(new Error(`${label} directory authority changed while opening: ${directoryPath}`), {
        code: "HUB_BACKUP_AUTHORITY_CHANGED",
      });
    }
    return { directoryPath, generation: openedGeneration, handle };
  } catch (error) {
    let closeError: unknown = null;
    if (handle) {
      try {
        await handle.close();
      } catch (caught) {
        closeError = caught;
      }
    }
    const primaryError = ["ELOOP", "EMLINK", "ENOTDIR"].includes(errnoCode(error))
      ? Object.assign(new Error(`${label} directory authority rejected unsafe path: ${directoryPath}`, { cause: error }), {
        code: "HUB_BACKUP_DIRECTORY_UNSAFE",
      })
      : error;
    if (!closeError) throw primaryError;
    throw Object.assign(
      new AggregateError([primaryError, closeError], `${label} directory authority open and close failed: ${directoryPath}`, {
        cause: primaryError,
      }),
      { code: errnoCode(primaryError) || "HUB_BACKUP_DIRECTORY_UNSAFE", primaryError, closeError },
    );
  }
}

function heldDirectoryPathMatches(
  authority: HeldDirectoryAuthority,
  expectedGeneration: PathGeneration,
  candidatePath: string,
) {
  try {
    const descriptor = fstatSync(authority.handle.fd);
    const current = lstatSync(candidatePath);
    return descriptor.isDirectory()
      && current.isDirectory()
      && !current.isSymbolicLink()
      && samePathGeneration(expectedGeneration, pathGeneration(descriptor))
      && samePathGeneration(expectedGeneration, pathGeneration(current));
  } catch {
    return false;
  }
}

function pathExistsNoFollowSync(candidatePath: string) {
  try {
    lstatSync(candidatePath);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    return true;
  }
}

async function directoryIsolationMetadata({
  candidates,
  bindings,
  forcedAttemptedPaths = [],
}: {
  candidates: Record<string, string>;
  bindings: Array<{
    candidatePath: string;
    authority: HeldDirectoryAuthority;
    generation: PathGeneration;
  }>;
  forcedAttemptedPaths?: string[];
}) {
  const forced = new Set(forcedAttemptedPaths);
  const boundPaths = new Set(bindings.map((binding) => binding.candidatePath));
  const genericCandidates = Object.fromEntries(
    Object.entries(candidates).filter(([, candidatePath]) => !boundPaths.has(candidatePath) && !forced.has(candidatePath)),
  );
  const metadata = await recoveryMetadata(genericCandidates);
  for (const [key, candidatePath] of Object.entries(candidates)) {
    const binding = bindings.find((candidate) => candidate.candidatePath === candidatePath);
    if (forced.has(candidatePath)) {
      metadata.attemptedPaths[key] = candidatePath;
    } else if (binding) {
      if (heldDirectoryPathMatches(binding.authority, binding.generation, candidatePath)) {
        metadata.recoveryPaths[key] = candidatePath;
      } else {
        metadata.attemptedPaths[key] = candidatePath;
      }
    }
  }
  return metadata;
}

async function committedStageIsolationError(
  label: string,
  code: string,
  stagePath: string,
  quarantinePath: string,
  recoveryPaths: Record<string, string>,
  cause: unknown,
  evidence: DirectoryIsolationEvidence | null,
  forcedAttemptedPaths: string[] = [],
) {
  const candidates = { ...recoveryPaths, quarantine: quarantinePath };
  const parentPath = path.dirname(stagePath);
  const attemptedPaths = [stagePath, ...(!evidence ? [quarantinePath] : []), ...forcedAttemptedPaths];
  const metadata = await directoryIsolationMetadata({
    candidates,
    bindings: evidence ? [
      {
        candidatePath: quarantinePath,
        authority: evidence.sourceAuthority,
        generation: evidence.generation,
      },
      ...(evidence.parentAuthority && evidence.parentGeneration ? [{
        candidatePath: parentPath,
        authority: evidence.parentAuthority,
        generation: evidence.parentGeneration,
      }] : []),
    ] : [],
    forcedAttemptedPaths: attemptedPaths,
  });
  const successorPreservedByCause = Boolean(
    cause
    && typeof cause === "object"
    && "successorPreserved" in cause
    && (cause as { successorPreserved?: unknown }).successorPreserved === true,
  );
  const successorPreserved = successorPreservedByCause
    || attemptedPaths.some(pathExistsNoFollowSync)
    || (!metadata.recoveryPaths.quarantine && pathExistsNoFollowSync(quarantinePath));
  return Object.assign(new Error(`${label} isolation committed with recoverable evidence: ${stagePath}`, { cause }), {
    code,
    committed: true,
    committedPath: quarantinePath,
    quarantinePreserved: metadata.recoveryPaths.quarantine === quarantinePath,
    ...(successorPreserved ? { successorPreserved: true } : {}),
    ...metadata,
  });
}

async function isolateDirectoryPreserveOnly({
  authority,
  label,
  quarantineLabel,
  recoveryPaths,
  syncOperation,
  committedCode,
  beforeRename,
  afterRename,
  beforeFinalCheck,
}: {
  authority: DirectoryAuthority;
  label: string;
  quarantineLabel: string;
  recoveryPaths: Record<string, string>;
  syncOperation: string;
  committedCode: string;
  beforeRename?: (context: { stagePath: string; quarantinePath: string }) => void | Promise<void>;
  afterRename?: (context: { stagePath: string; quarantinePath: string }) => void | Promise<void>;
  beforeFinalCheck?: (context: { stagePath: string; quarantinePath: string }) => void | Promise<void>;
}) {
  const stagePath = authority.directoryPath;
  const parentPath = path.dirname(stagePath);
  const quarantinePath = `${stagePath}.${quarantineLabel}-${Date.now()}-${randomUUID()}`;
  const context = { stagePath, quarantinePath };
  let parentAuthority: HeldDirectoryAuthority | null = null;
  let sourceAuthority: HeldDirectoryAuthority | null = null;
  let renamed = false;
  let movedGeneration: PathGeneration | null = null;
  let movedParentGeneration: PathGeneration | null = null;

  const preIsolationMetadata = async () => directoryIsolationMetadata({
    candidates: { ...recoveryPaths, quarantine: quarantinePath },
    bindings: [
      ...(sourceAuthority ? [{
        candidatePath: stagePath,
        authority: sourceAuthority,
        generation: authority.generation,
      }] : []),
      ...(parentAuthority ? [{
        candidatePath: parentPath,
        authority: parentAuthority,
        generation: parentAuthority.generation,
      }] : []),
    ],
    forcedAttemptedPaths: [
      quarantinePath,
      ...(!sourceAuthority ? [stagePath] : []),
      ...(!parentAuthority ? [parentPath] : []),
    ],
  });

  const captureCurrentSync = () => {
    if (!parentAuthority || !sourceAuthority) throw new Error(`${label} held authority is unavailable`);
    const parentDescriptor = fstatSync(parentAuthority.handle.fd);
    const parentCurrent = lstatSync(parentPath);
    const sourceDescriptor = fstatSync(sourceAuthority.handle.fd);
    let sourceCurrent: Stats | null = null;
    try {
      sourceCurrent = lstatSync(stagePath);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
    let quarantineCurrent: Stats | null = null;
    try {
      quarantineCurrent = lstatSync(quarantinePath);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
    return { parentDescriptor, parentCurrent, sourceDescriptor, sourceCurrent, quarantineCurrent };
  };

  const validateCommittedSync = (movedGeneration: PathGeneration, parentGeneration: PathGeneration) => {
    if (!parentAuthority || !sourceAuthority) throw new Error(`${label} held authority is unavailable`);
    const parentDescriptor = fstatSync(parentAuthority.handle.fd);
    const parentCurrent = lstatSync(parentPath);
    const sourceDescriptor = fstatSync(sourceAuthority.handle.fd);
    const quarantineCurrent = lstatSync(quarantinePath);
    let successor: Stats | null = null;
    try {
      successor = lstatSync(stagePath);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
    if (successor) {
      throw Object.assign(new Error(`${label} canonical successor preserved during isolation: ${stagePath}`), {
        code: "HUB_BACKUP_STAGE_SUCCESSOR_PRESERVED",
        successorPreserved: true,
      });
    }
    if (
      !parentDescriptor.isDirectory()
      || !parentCurrent.isDirectory()
      || parentCurrent.isSymbolicLink()
      || !sameDirectoryLineage(parentAuthority.generation, pathGeneration(parentDescriptor))
      || !samePathGeneration(parentGeneration, pathGeneration(parentDescriptor))
      || !samePathGeneration(parentGeneration, pathGeneration(parentCurrent))
    ) {
      throw new Error(`${label} parent authority changed after isolation: ${parentPath}`);
    }
    if (
      !sourceDescriptor.isDirectory()
      || !quarantineCurrent.isDirectory()
      || quarantineCurrent.isSymbolicLink()
      || !samePathGeneration(movedGeneration, pathGeneration(sourceDescriptor))
      || !samePathGeneration(movedGeneration, pathGeneration(quarantineCurrent))
    ) {
      throw new Error(`${label} quarantine generation mismatch: ${quarantinePath}`);
    }
  };

  let result: DirectoryIsolationEvidence | null = null;
  let operationError: unknown = null;
  try {
    parentAuthority = await openHeldDirectoryAuthority(parentPath, `${label} parent`);
    sourceAuthority = await openHeldDirectoryAuthority(stagePath, label, authority.generation);
    await beforeRename?.(context);

    try {
      // The callback return, all pathname/descriptor checks, the no-clobber
      // decision, and rename execute without another callback or await.
      const current = captureCurrentSync();
      if (current.quarantineCurrent) {
        throw Object.assign(new Error(`${label} quarantine destination already exists: ${quarantinePath}`), {
          code: "HUB_BACKUP_STAGE_QUARANTINE_CONFLICT",
          committed: false,
          committedPath: null,
          successorPreserved: true,
        });
      }
      if (
        !current.parentDescriptor.isDirectory()
        || !current.parentCurrent.isDirectory()
        || current.parentCurrent.isSymbolicLink()
        || !samePathGeneration(parentAuthority.generation, pathGeneration(current.parentDescriptor))
        || !samePathGeneration(parentAuthority.generation, pathGeneration(current.parentCurrent))
      ) {
        throw Object.assign(new Error(`${label} parent authority changed before isolation: ${parentPath}`), {
          code: "HUB_BACKUP_AUTHORITY_CHANGED",
          committed: false,
          committedPath: null,
        });
      }
      if (
        !current.sourceCurrent
        || !current.sourceDescriptor.isDirectory()
        || !current.sourceCurrent.isDirectory()
        || current.sourceCurrent.isSymbolicLink()
        || !samePathGeneration(authority.generation, pathGeneration(current.sourceDescriptor))
        || !samePathGeneration(authority.generation, pathGeneration(current.sourceCurrent))
      ) {
        throw Object.assign(new Error(`${label} authority changed before isolation: ${stagePath}`), {
          code: "HUB_BACKUP_AUTHORITY_CHANGED",
          committed: false,
          committedPath: null,
        });
      }
      renameSync(stagePath, quarantinePath);
      renamed = true;
    } catch (error) {
      if (renamed) throw error;
      const metadata = await preIsolationMetadata();
      if (errnoCode(error) === "ENOENT") {
        throw Object.assign(new Error(`${label} authority disappeared before isolation: ${stagePath}`, { cause: error }), {
          code: "HUB_BACKUP_AUTHORITY_CHANGED",
          committed: false,
          committedPath: null,
          ...metadata,
        });
      }
      if (error && typeof error === "object" && "committed" in error) {
        Object.assign(error, metadata);
        throw error;
      }
      if (errnoCode(error) === "HUB_BACKUP_AUTHORITY_CHANGED") {
        throw Object.assign(error, {
          committed: false,
          committedPath: null,
          ...metadata,
        });
      }
      throw Object.assign(new Error(`${label} isolation failed before rename: ${stagePath}`, { cause: error }), {
        code: errnoCode(error) || "HUB_BACKUP_STAGE_ISOLATION_FAILED",
        committed: false,
        committedPath: null,
        ...metadata,
      });
    }

    const movedDescriptor = fstatSync(sourceAuthority.handle.fd);
    movedGeneration = pathGeneration(movedDescriptor);
    const movedInfo = lstatSync(quarantinePath);
    const parentDescriptor = fstatSync(parentAuthority.handle.fd);
    movedParentGeneration = pathGeneration(parentDescriptor);
    const parentCurrent = lstatSync(parentPath);
    if (
      !movedDescriptor.isDirectory()
      || !movedInfo.isDirectory()
      || movedInfo.isSymbolicLink()
      || !samePathGenerationAcrossRename(authority.generation, pathGeneration(movedDescriptor))
      || !samePathGenerationAcrossRename(authority.generation, pathGeneration(movedInfo))
      || !parentDescriptor.isDirectory()
      || !parentCurrent.isDirectory()
      || parentCurrent.isSymbolicLink()
      || !sameDirectoryLineage(parentAuthority.generation, pathGeneration(parentDescriptor))
      || !sameDirectoryLineage(parentAuthority.generation, pathGeneration(parentCurrent))
      || !samePathGeneration(pathGeneration(parentDescriptor), pathGeneration(parentCurrent))
    ) {
      throw new Error(`${label} authority changed during isolation: ${stagePath}`);
    }
    await syncBackupDirectory(parentPath, syncOperation);
    validateCommittedSync(movedGeneration, movedParentGeneration);
    await afterRename?.(context);
    validateCommittedSync(movedGeneration, movedParentGeneration);
    await beforeFinalCheck?.(context);
    validateCommittedSync(movedGeneration, movedParentGeneration);
    await syncBackupDirectory(parentPath, syncOperation);
    validateCommittedSync(movedGeneration, movedParentGeneration);
    if (!movedGeneration || !sourceAuthority || !parentAuthority || !movedParentGeneration) {
      throw new Error(`${label} isolation evidence was not captured`);
    }
    result = {
      quarantinePath,
      generation: movedGeneration,
      sourceAuthority,
      parentAuthority,
      parentGeneration: movedParentGeneration,
    };
  } catch (error) {
    if (renamed) {
      const evidence = sourceAuthority && movedGeneration ? {
        quarantinePath,
        generation: movedGeneration,
        sourceAuthority,
        ...(parentAuthority && movedParentGeneration ? {
          parentAuthority,
          parentGeneration: movedParentGeneration,
        } : {}),
      } : null;
      operationError = await committedStageIsolationError(
        label,
        committedCode,
        stagePath,
        quarantinePath,
        recoveryPaths,
        error,
        evidence,
      );
    } else if (error && typeof error === "object" && "committed" in error) {
      operationError = error;
    } else {
      const metadata = await preIsolationMetadata();
      operationError = Object.assign(error instanceof Error ? error : new Error(String(error)), {
        committed: false,
        committedPath: null,
        ...metadata,
      });
    }
  }

  const closeErrors: unknown[] = [];
  if ((operationError || !result) && parentAuthority) {
    try {
      await parentAuthority.handle.close();
    } catch (error) {
      closeErrors.push(error);
    }
  }
  if ((operationError || closeErrors.length > 0 || !result) && sourceAuthority) {
    try {
      await sourceAuthority.handle.close();
    } catch (error) {
      closeErrors.push(error);
    }
  }
  if (closeErrors.length > 0) {
    const closeFailure = new AggregateError(closeErrors, `${label} held authority close failed: ${stagePath}`, {
      cause: closeErrors[0],
    });
    if (renamed) {
      const cause = operationError
        ? new AggregateError([operationError, closeFailure], `${label} isolation and authority close failed`, {
          cause: operationError,
        })
        : closeFailure;
      throw await committedStageIsolationError(
        label,
        committedCode,
        stagePath,
        quarantinePath,
        recoveryPaths,
        cause,
        null,
      );
    }
    if (operationError) {
      const metadata = operationError && typeof operationError === "object"
        ? Object.fromEntries(Object.entries(operationError))
        : {};
      throw Object.assign(
        new AggregateError([operationError, closeFailure], `${label} isolation and authority close failed`, {
          cause: operationError,
        }),
        metadata,
        { code: errnoCode(operationError) || "HUB_BACKUP_STAGE_ISOLATION_FAILED", primaryError: operationError, closeErrors },
      );
    }
    throw Object.assign(closeFailure, {
      code: "HUB_BACKUP_STAGE_AUTHORITY_CLOSE_FAILED",
      committed: false,
      committedPath: null,
      ...(await recoveryMetadata(recoveryPaths)),
    });
  }
  if (operationError) throw operationError;
  if (!result) throw new Error(`${label} isolation completed without retained evidence`);
  return result;
}

async function finishRetainedDirectoryIsolation({
  evidence,
  label,
  committedCode,
  stagePath,
  recoveryPaths,
  forcedAttemptedPaths,
  operation,
}: {
  evidence: DirectoryIsolationEvidence;
  label: string;
  committedCode: string;
  stagePath: string;
  recoveryPaths: Record<string, string>;
  forcedAttemptedPaths: string[];
  operation: () => Promise<void>;
}) {
  const validateRetainedEvidence = () => {
    if (!evidence.parentAuthority || !evidence.parentGeneration) {
      throw new Error(`${label} retained parent authority is unavailable`);
    }
    if (!heldDirectoryPathMatches(evidence.sourceAuthority, evidence.generation, evidence.quarantinePath)) {
      throw new Error(`${label} retained quarantine authority changed: ${evidence.quarantinePath}`);
    }
    const parentDescriptor = fstatSync(evidence.parentAuthority.handle.fd);
    const parentCurrent = lstatSync(path.dirname(stagePath));
    if (
      !parentDescriptor.isDirectory()
      || !parentCurrent.isDirectory()
      || parentCurrent.isSymbolicLink()
      || !sameDirectoryLineage(evidence.parentGeneration, pathGeneration(parentDescriptor))
      || !sameDirectoryLineage(evidence.parentGeneration, pathGeneration(parentCurrent))
      || !samePathGeneration(pathGeneration(parentDescriptor), pathGeneration(parentCurrent))
    ) {
      throw new Error(`${label} retained parent authority changed: ${path.dirname(stagePath)}`);
    }
    try {
      lstatSync(stagePath);
      throw Object.assign(new Error(`${label} canonical successor appeared after retained cleanup: ${stagePath}`), {
        successorPreserved: true,
      });
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
  };

  let operationCause: unknown = null;
  try {
    await operation();
  } catch (error) {
    operationCause = error;
  }
  try {
    validateRetainedEvidence();
  } catch (validationError) {
    operationCause = operationCause
      ? new AggregateError([operationCause, validationError], `${label} cleanup and retained evidence validation failed`, {
        cause: operationCause,
      })
      : validationError;
  }

  let operationError: unknown = null;
  if (operationCause) {
    operationError = await committedStageIsolationError(
      label,
      committedCode,
      stagePath,
      evidence.quarantinePath,
      recoveryPaths,
      operationCause,
      evidence,
      forcedAttemptedPaths,
    );
  }

  const closeErrors: unknown[] = [];
  for (const authority of [evidence.sourceAuthority, evidence.parentAuthority].filter(Boolean) as HeldDirectoryAuthority[]) {
    try {
      await authority.handle.close();
    } catch (error) {
      closeErrors.push(error);
    }
  }
  if (operationError) {
    if (closeErrors.length === 0) throw operationError;
    const metadata = operationError && typeof operationError === "object"
      ? Object.fromEntries(Object.entries(operationError))
      : {};
    throw Object.assign(
      new AggregateError([operationError, ...closeErrors], `${label} partial cleanup and evidence close failed`, {
        cause: operationError,
      }),
      metadata,
      { code: committedCode, primaryError: operationError, closeErrors },
    );
  }
  if (closeErrors.length > 0) {
    throw await committedStageIsolationError(
      label,
      committedCode,
      stagePath,
      evidence.quarantinePath,
      recoveryPaths,
      new AggregateError(closeErrors, `${label} retained authority close failed`, { cause: closeErrors[0] }),
      null,
      forcedAttemptedPaths,
    );
  }
}

async function syncBackupDirectory(directory: string, operation: string) {
  await currentHubBackupTestHooks()?.syncDirectory?.({ directory, operation });
  await fsyncDirectory(directory);
}

function normalizeSigningKey(value: unknown) {
  const key = String(value || "");
  if (!key) return "";
  if (key.trim() !== key || /\s/.test(key) || Buffer.byteLength(key, "utf8") < 32) {
    throw new Error("CPB Hub backup signing key must contain at least 32 non-whitespace bytes");
  }
  return key;
}

async function pathExists(filePath: string) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function assertRealDirectory(filePath: string, label: string) {
  const info = await lstat(filePath);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${filePath}`);
  }
  return info;
}

async function assertRealFile(filePath: string, label: string) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a real file: ${filePath}`);
  }
  return info;
}

function isWithin(parent: string, candidate: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function safeManifestPath(value: unknown) {
  const text = String(value || "");
  const parts = text.split("/");
  if (
    !text
    || Buffer.byteLength(text, "utf8") > MAX_MANIFEST_PATH_BYTES
    || parts.length > MAX_MANIFEST_PATH_DEPTH
    || text.includes("\\")
    || text.startsWith("/")
    || parts.some((part) => !part || part === "." || part === ".." || Buffer.byteLength(part, "utf8") > 255)
  ) {
    throw new Error(`unsafe backup manifest path: ${text || "<empty>"}`);
  }
  return text;
}

function nativePath(root: string, relative: string) {
  return path.join(root, ...safeManifestPath(relative).split("/"));
}

async function sha256File(filePath: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function fsyncFile(filePath: string) {
  if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
    throw Object.assign(new Error(`strict no-follow file opens are unavailable for fsync: ${filePath}`), {
      code: "BOUNDED_FILE_UNSAFE",
    });
  }
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw Object.assign(new Error(`fsync requires a regular file: ${filePath}`), {
      code: "BOUNDED_FILE_UNSAFE",
    });
  }
  await currentHubBackupTestHooks()?.beforeFileFsyncOpen?.({ filePath });
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let primaryError: unknown = null;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.isSymbolicLink() || !samePathGeneration(pathGeneration(before), pathGeneration(opened))) {
      throw Object.assign(new Error(`file changed while opening for fsync: ${filePath}`), {
        code: "BOUNDED_FILE_CHANGED",
      });
    }
    await handle.sync();
  } catch (error) {
    primaryError = ["ELOOP", "EMLINK"].includes(errnoCode(error))
      ? Object.assign(new Error(`symbolic-link file rejected during fsync: ${filePath}`, { cause: error }), {
        code: "BOUNDED_FILE_UNSAFE",
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
      new AggregateError([primaryError, closeError], `file fsync and close failed: ${filePath}`, {
        cause: primaryError,
      }),
      { code: errnoCode(primaryError) || "BOUNDED_FILE_READ_FAILED", primaryError, closeError },
    );
  }
  if (closeError) throw closeError;
}

async function writeJsonExclusiveDurable(
  filePath: string,
  value: unknown,
  kind: HubBackupMetadataReadKind,
  maxBytes: number,
) {
  if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
    throw Object.assign(new Error(`strict no-follow exclusive create is unavailable: ${filePath}`), {
      code: "BOUNDED_FILE_UNSAFE",
    });
  }
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(raw, "utf8") > maxBytes) throw new Error(`durable JSON exceeds its size limit: ${filePath}`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let primaryError: unknown = null;
  try {
    handle = await open(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(raw, "utf8");
    await handle.sync();
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown = null;
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      closeError = error;
    }
  }
  if (primaryError || closeError) {
    const cause = primaryError && closeError
      ? new AggregateError([primaryError, closeError], `exclusive durable JSON write and close failed: ${filePath}`, {
        cause: primaryError,
      })
      : primaryError || closeError;
    throw Object.assign(new Error(`exclusive durable JSON create failed: ${filePath}`, { cause }), {
      code: errnoCode(primaryError || closeError) || "DURABLE_JSON_CREATE_FAILED",
      committed: false,
      committedPath: null,
      ...(await recoveryMetadata({ file: filePath })),
    });
  }
  try {
    await fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    throw Object.assign(new Error(`exclusive durable JSON create has ambiguous parent durability: ${filePath}`, { cause: error }), {
      code: "DURABLE_JSON_CREATE_COMMITTED_AMBIGUOUS",
      committed: true,
      committedPath: filePath,
      ...(await recoveryMetadata({ file: filePath })),
    });
  }
  return (await readPinnedMetadata(filePath, maxBytes, kind)).authority;
}

async function updatePinnedJsonDurableInPlace(
  authority: FileAuthority,
  value: unknown,
  beforeMutation?: (context: { filePath: string }) => void | Promise<void>,
) {
  const filePath = authority.filePath;
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(raw, "utf8") > authority.maxBytes) {
    throw new Error(`durable JSON exceeds its size limit: ${filePath}`);
  }
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let operationError: unknown = null;
  try {
    const before = await lstat(filePath);
    handle = await open(filePath, constants.O_RDWR | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || !opened.isFile()
      || !samePathGeneration(authority.generation, pathGeneration(before))
      || !samePathGeneration(authority.generation, pathGeneration(opened))
    ) {
      throw await authorityChanged("durable JSON", filePath, { file: filePath });
    }
    await beforeMutation?.({ filePath });
    const descriptor = fstatSync(handle.fd);
    const current = lstatSync(filePath);
    if (
      !descriptor.isFile()
      || !current.isFile()
      || current.isSymbolicLink()
      || !samePathGeneration(authority.generation, pathGeneration(descriptor))
      || !samePathGeneration(authority.generation, pathGeneration(current))
    ) {
      throw await authorityChanged("durable JSON", filePath, { file: filePath });
    }
    // Mutating the held predecessor descriptor cannot overwrite a pathname
    // successor installed after the CAS check.
    await handle.truncate(0);
    await handle.writeFile(raw, "utf8");
    await handle.sync();
    const updatedDescriptor = fstatSync(handle.fd);
    const updatedCurrent = lstatSync(filePath);
    if (
      !updatedDescriptor.isFile()
      || !updatedCurrent.isFile()
      || updatedCurrent.isSymbolicLink()
      || !samePathGeneration(pathGeneration(updatedDescriptor), pathGeneration(updatedCurrent))
    ) {
      throw Object.assign(new Error(`durable JSON successor preserved during descriptor update: ${filePath}`), {
        code: "HUB_BACKUP_AUTHORITY_CHANGED",
        committed: false,
        committedPath: null,
        successorPreserved: true,
        ...(await recoveryMetadata({ file: filePath })),
      });
    }
  } catch (error) {
    operationError = error;
  }
  let closeError: unknown = null;
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      closeError = error;
    }
  }
  if (operationError) {
    if (!closeError) throw operationError;
    throw Object.assign(
      new AggregateError([operationError, closeError], `durable JSON CAS update and close failed: ${filePath}`, {
        cause: operationError,
      }),
      Object.fromEntries(Object.entries(operationError)),
      { primaryError: operationError, closeError },
    );
  }
  if (closeError) throw closeError;
  await fsyncDirectory(path.dirname(filePath));
  return (await readPinnedMetadata(filePath, authority.maxBytes, authority.kind)).authority;
}

function normalizeMinimumFreeBytes(value: unknown) {
  const configured = value === undefined
    ? process.env.CPB_HUB_MIN_FREE_BYTES
    : value;
  if (configured === undefined || configured === "") return DEFAULT_MINIMUM_FREE_BYTES;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("CPB_HUB_MIN_FREE_BYTES must be a non-negative safe integer");
  }
  return parsed;
}

function estimatedCopyBytes(payloadBytes: bigint, entryCount: number) {
  return payloadBytes
    + BigInt(entryCount) * BigInt(COPY_SPACE_PER_ENTRY_BYTES)
    + BigInt(COPY_SPACE_FIXED_OVERHEAD_BYTES);
}

async function assertCopySpaceAvailable({
  directory,
  operation,
  payloadBytes,
  entryCount,
  minimumFreeBytes,
}: {
  directory: string;
  operation: string;
  payloadBytes: bigint;
  entryCount: number;
  minimumFreeBytes: unknown;
}) {
  const reserveBytes = BigInt(normalizeMinimumFreeBytes(minimumFreeBytes));
  const copyBytes = estimatedCopyBytes(payloadBytes, entryCount);
  let availableBytes: bigint;
  try {
    const filesystem = await statfs(directory, { bigint: true });
    availableBytes = filesystem.bavail * filesystem.bsize;
  } catch (error) {
    throw new Error(
      `cannot determine free disk space for ${operation} at ${directory}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const requiredBytes = copyBytes + reserveBytes;
  if (availableBytes < requiredBytes) {
    throw Object.assign(
      new Error(
        `insufficient disk space for ${operation} at ${directory}: `
        + `requires ${requiredBytes} available bytes (${copyBytes} copy estimate + ${reserveBytes} reserve), `
        + `found ${availableBytes}`,
      ),
      {
        code: "HUB_BACKUP_INSUFFICIENT_SPACE",
        availableBytes: availableBytes.toString(),
        copyBytes: copyBytes.toString(),
        requiredBytes: requiredBytes.toString(),
        reserveBytes: reserveBytes.toString(),
      },
    );
  }
  return { availableBytes, copyBytes, requiredBytes, reserveBytes };
}

async function walkRoot(root: string) {
  const nodes: SourceNode[] = [];
  async function visit(relativeDir: string) {
    const directory = relativeDir ? nativePath(root, relativeDir) : root;
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const relative = relativeDir ? `${relativeDir}/${child.name}` : child.name;
      const absolute = path.join(directory, child.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`backup refuses symbolic link: ${absolute}`);
      if (info.isDirectory()) {
        nodes.push({
          path: relative,
          type: "directory",
          mode: info.mode & 0o777,
          mtimeMs: info.mtimeMs,
          ctimeMs: info.ctimeMs,
          dev: info.dev,
          ino: info.ino,
          size: 0,
        });
        await visit(relative);
      } else if (info.isFile()) {
        nodes.push({
          path: relative,
          type: "file",
          mode: info.mode & 0o777,
          mtimeMs: info.mtimeMs,
          ctimeMs: info.ctimeMs,
          dev: info.dev,
          ino: info.ino,
          size: info.size,
        });
      } else {
        throw new Error(`backup refuses non-file entry: ${absolute}`);
      }
      if (nodes.length > MAX_BACKUP_ENTRIES) {
        throw new Error(`Hub backup exceeds the ${MAX_BACKUP_ENTRIES} entry safety limit`);
      }
    }
  }
  await visit("");
  return nodes;
}

function fingerprint(nodes: SourceNode[]) {
  return JSON.stringify(nodes.map((node) => [
    node.path,
    node.type,
    node.mode,
    node.mtimeMs,
    node.ctimeMs,
    node.dev,
    node.ino,
    node.size,
  ]));
}

function rootFingerprint(info: Stats) {
  return JSON.stringify([
    info.mode & 0o777,
    info.mtimeMs,
    info.ctimeMs,
    info.dev,
    info.ino,
  ]);
}

async function inspectSourceRoot(source: SourceRoot): Promise<InspectedSourceRoot> {
  const rootInfo = await lstat(source.sourcePath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`backup root must be a real directory: ${source.sourcePath}`);
  }
  const nodes = await walkRoot(source.sourcePath);
  return { source, rootInfo, nodes };
}

async function copySourceRoot(inspected: InspectedSourceRoot, destination: string) {
  const { source, rootInfo, nodes: before } = inspected;
  await mkdir(destination, { recursive: false, mode: 0o700 });
  await chmod(destination, 0o700);
  const entries: HubBackupEntry[] = [];

  for (const node of before) {
    const sourcePath = nativePath(source.sourcePath, node.path);
    const targetPath = nativePath(destination, node.path);
    if (node.type === "directory") {
      await mkdir(targetPath, { recursive: false, mode: 0o700 });
      await chmod(targetPath, 0o700);
    } else {
      await copyFile(sourcePath, targetPath);
      await chmod(targetPath, node.mode);
      await utimes(targetPath, new Date(node.mtimeMs), new Date(node.mtimeMs));
      await fsyncFile(targetPath);
    }
    entries.push({
      rootId: source.id,
      path: node.path,
      type: node.type,
      mode: node.mode,
      mtimeMs: node.mtimeMs,
      ...(node.type === "file" ? {
        size: node.size,
        sha256: await sha256File(targetPath),
      } : {}),
    });
  }
  for (const node of before.filter((item) => item.type === "directory").reverse()) {
    const targetPath = nativePath(destination, node.path);
    await chmod(targetPath, node.mode);
    await utimes(targetPath, new Date(node.mtimeMs), new Date(node.mtimeMs));
    await fsyncDirectory(targetPath);
  }
  await chmod(destination, rootInfo.mode & 0o777);
  await fsyncDirectory(destination);

  return {
    root: {
      id: source.id,
      kind: source.kind,
      ...(source.projectId ? { projectId: source.projectId } : {}),
      sourcePath: source.sourcePath,
      mode: rootInfo.mode & 0o777,
      entryCount: entries.length,
    } satisfies HubBackupRoot,
    entries,
    sourceFingerprint: fingerprint(before),
    sourceRootFingerprint: rootFingerprint(rootInfo),
  };
}

async function assertSourceUnchanged(
  source: SourceRoot,
  expectedFingerprint: string,
  expectedRootFingerprint: string,
  copiedEntries: HubBackupEntry[],
) {
  const currentRootInfo = await lstat(source.sourcePath);
  if (
    !currentRootInfo.isDirectory()
    || currentRootInfo.isSymbolicLink()
    || rootFingerprint(currentRootInfo) !== expectedRootFingerprint
  ) {
    throw new Error(`backup source root changed while snapshotting: ${source.sourcePath}`);
  }
  const currentNodes = await walkRoot(source.sourcePath);
  const current = fingerprint(currentNodes);
  if (current !== expectedFingerprint) {
    throw new Error(`backup source changed while snapshotting: ${source.sourcePath}`);
  }
  const copiedByPath = new Map(copiedEntries.map((entry) => [entry.path, entry]));
  for (const node of currentNodes) {
    if (node.type !== "file") continue;
    const copied = copiedByPath.get(node.path);
    const digest = await sha256File(nativePath(source.sourcePath, node.path));
    if (!copied?.sha256 || digest !== copied.sha256) {
      throw new Error(`backup source content changed while snapshotting: ${source.sourcePath}/${node.path}`);
    }
  }
}

function processIdentityFromRecord(value: unknown, expectedPid?: number): ProcessIdentity | null {
  const candidate = recordValue(value);
  const pid = Number(candidate.pid);
  const capturedAt = typeof candidate.capturedAt === "string" ? candidate.capturedAt : "";
  const processGroupId = Number(candidate.processGroupId);
  if (
    !Number.isSafeInteger(pid)
    || pid <= 0
    || (expectedPid !== undefined && pid !== expectedPid)
    || typeof candidate.birthId !== "string"
    || candidate.birthId.length === 0
    || candidate.incarnation !== `${pid}:${candidate.birthId}`
    || !capturedAt
    || !Number.isFinite(Date.parse(capturedAt))
    || new Date(Date.parse(capturedAt)).toISOString() !== capturedAt
    || candidate.birthIdPrecision !== "exact"
    || (candidate.processGroupId !== undefined
      && (!Number.isSafeInteger(processGroupId) || processGroupId <= 0))
  ) return null;
  return {
    pid,
    birthId: candidate.birthId,
    incarnation: candidate.incarnation,
    capturedAt,
    birthIdPrecision: "exact",
    ...(candidate.processGroupId === undefined ? {} : { processGroupId }),
  };
}

function processOfflineProof(record: LooseRecord | null | undefined, label: string) {
  if (!record) return null;
  const pid = Number(record.pid || record.runnerPid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const identity = processIdentityFromRecord(record.processIdentity || record.ownerIdentity, pid);
  if (!identity) return `${label} pid ${pid} lacks process identity`;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (errnoCode(error) === "ESRCH") return null;
    return `${label} pid ${pid} liveness is unverified: ${error instanceof Error ? error.message : String(error)}`;
  }
  const current = captureProcessIdentity(pid, { strict: true });
  if (!current || !sameProcessIdentity(identity, current)) {
    return `${label} pid ${pid} identity mismatched`;
  }
  return `${label} pid ${pid} is alive`;
}

async function readOptionalJsonRecord(filePath: string, label: string) {
  try {
    const parsed = JSON.parse((await readPinnedMetadata(filePath, MAX_OFFLINE_RECORD_BYTES, "offline-record")).raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return recordValue(parsed);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    if (errnoCode(error).startsWith("BOUNDED_FILE_")) throw error;
    throw new Error(`invalid ${label} record at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readJsonRegistryStrict(
  directory: string,
  acceptsName: (name: string) => boolean,
  label: string,
) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw new Error(`cannot inspect ${label} directory at ${directory}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const records: LooseRecord[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!acceptsName(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`${label} record must be a real file: ${filePath}`);
    }
    const record = await readOptionalJsonRecord(filePath, label);
    if (!record) throw new Error(`${label} record disappeared during offline validation: ${filePath}`);
    records.push(record);
  }
  return records;
}

export async function assertHubBackupOffline(
  _cpbRoot: string,
  hubRoot: string,
  projectRuntimeRoots: string[],
  redisBackend: HubRedisStateBackend | null = null,
) {
  const reasons: string[] = [];
  const liveness = await readHubLiveness(hubRoot);
  if (liveness.alive && (!Number.isSafeInteger(liveness.pid) || !liveness.processIdentity)) {
    throw new Error(`cannot prove Hub is offline because its liveness state is unsafe: ${String(liveness.reason || liveness.error || "unknown state")}`);
  }
  if (liveness.alive) reasons.push(`Hub server pid ${liveness.pid} is alive`);
  if (!liveness.alive && liveness.reason === "read-error") {
    throw new Error(`cannot prove Hub is offline because its liveness state is unreadable: ${String(liveness.error || "unknown error")}`);
  }
  const leader = await readLeaderStatus(hubRoot);
  if (leader.status === "running") reasons.push(`orchestrator leader ${leader.hubId || leader.pid || "unknown"} is active`);

  const orchestrator = await readOptionalJsonRecord(path.join(hubRoot, "state", "orchestrator.json"), "orchestrator state");
  const orchestratorProof = processOfflineProof(orchestrator, "orchestrator");
  if (orchestratorProof) reasons.push(orchestratorProof);
  const delegate = await readOptionalJsonRecord(path.join(hubRoot, "providers", "delegate", "delegate.lock"), "quota delegate lock");
  const delegateProof = processOfflineProof(delegate, "quota delegate");
  if (delegateProof) reasons.push(delegateProof);

  const workers = await readJsonRegistryStrict(
    path.join(hubRoot, "workers", "registry"),
    (name) => name.startsWith("worker-") && name.endsWith(".json"),
    "worker registry",
  );
  for (const worker of workers) {
    const workerProof = processOfflineProof(worker, `worker ${worker.workerId || "unknown"}`);
    if (workerProof) reasons.push(workerProof);
  }

  if (redisBackend) {
    for (const { field, record } of await redisBackend.scanStateRecords("worker:")) {
      const worker = record.data && typeof record.data === "object" && !Array.isArray(record.data)
        ? record.data as LooseRecord
        : null;
      if (!worker || typeof worker.workerId !== "string" || !worker.workerId || typeof worker.status !== "string") {
        throw Object.assign(new Error(`cannot prove Hub is offline because Redis worker state is malformed: ${field}`), {
          code: "HUB_STATE_RECORD_INVALID",
        });
      }
      if (!["exited", "exhausted"].includes(worker.status)) {
        reasons.push(`Redis worker ${worker.workerId} is ${worker.status}`);
      }
    }
  }

  for (const dataRoot of projectRuntimeRoots) {
    const entries = await readJsonRegistryStrict(
      path.join(dataRoot, "processes"),
      (name) => name.endsWith(".json"),
      "project process registry",
    );
    for (const entry of entries) {
      const entryProof = processOfflineProof(entry, `project runtime process under ${dataRoot}`);
      if (entryProof) reasons.push(entryProof);
      const childLabel = `project runtime child process under ${dataRoot}`;
      const rawChildPids = Array.isArray(entry.childPids) ? entry.childPids : [];
      if (entry.childPids !== undefined && !Array.isArray(entry.childPids)) {
        reasons.push(`${childLabel} has an invalid child PID registry`);
      }
      const rawChildIdentities = Array.isArray(entry.childIdentities) ? entry.childIdentities : [];
      const childIdentities: ProcessIdentity[] = [];
      for (const value of rawChildIdentities) {
        const identity = processIdentityFromRecord(value);
        if (!identity) {
          reasons.push(`${childLabel} lacks process identity`);
        } else {
          childIdentities.push(identity);
        }
      }
      const checkedIncarnations = new Set<string>();
      for (const value of rawChildPids) {
        if (!Number.isSafeInteger(value) || Number(value) <= 0) {
          reasons.push(`${childLabel} has an invalid child PID`);
          continue;
        }
        const childPid = Number(value);
        const matchingIdentities = childIdentities.filter((identity) => identity.pid === childPid);
        if (matchingIdentities.length !== 1) {
          reasons.push(`${childLabel} pid ${childPid} lacks process identity`);
          continue;
        }
        const identity = matchingIdentities[0];
        checkedIncarnations.add(identity.incarnation);
        const childProof = processOfflineProof({ pid: childPid, processIdentity: identity }, childLabel);
        if (childProof) reasons.push(childProof);
      }
      for (const identity of childIdentities) {
        if (checkedIncarnations.has(identity.incarnation)) continue;
        const childProof = processOfflineProof({ pid: identity.pid, processIdentity: identity }, childLabel);
        if (childProof) reasons.push(childProof);
      }
    }
  }

  if (reasons.length > 0) {
    throw new Error(`Hub backup/restore requires an offline control plane:\n- ${reasons.join("\n- ")}`);
  }
}

async function localProjectsForBackup(hubRoot: string) {
  const registryPath = path.join(path.resolve(hubRoot), "projects.json");
  let raw = "";
  try {
    raw = (await readPinnedMetadata(registryPath, MAX_MANIFEST_BYTES, "offline-record")).raw;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  }
  const registry = recordValue(JSON.parse(raw));
  const projects = recordValue(registry.projects || {});
  return Object.values(projects);
}

async function sourceRootsForBackup(hubRoot: string, { localOnly = false }: { localOnly?: boolean } = {}) {
  const resolvedHubRoot = path.resolve(hubRoot);
  const roots: SourceRoot[] = [{ id: "hub", kind: "hub", sourcePath: resolvedHubRoot }];
  const projectRuntimeRoots: string[] = [];
  const projectIds = new Set<string>();
  for (const project of localOnly ? await localProjectsForBackup(hubRoot) : await listProjects(hubRoot)) {
    const record = recordValue(project);
    const projectId = String(record.id || "").trim();
    const runtimeRoot = typeof record.projectRuntimeRoot === "string" ? path.resolve(record.projectRuntimeRoot) : "";
    if (!projectId || !runtimeRoot) throw new Error(`registered project is missing id or projectRuntimeRoot: ${JSON.stringify(record)}`);
    if (projectIds.has(projectId)) throw new Error(`duplicate project id in Hub registry: ${projectId}`);
    if (!isWithin(resolvedHubRoot, runtimeRoot)) {
      throw new Error(`project runtime root escapes Hub backup boundary: ${projectId} (${runtimeRoot})`);
    }
    let runtimeInfo;
    try {
      runtimeInfo = await lstat(runtimeRoot);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") {
        throw new Error(`registered project runtime root is missing: ${projectId} (${runtimeRoot})`);
      }
      throw error;
    }
    if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink()) {
      throw new Error(`registered project runtime root must be a real directory: ${projectId} (${runtimeRoot})`);
    }
    projectIds.add(projectId);
    projectRuntimeRoots.push(runtimeRoot);
  }
  return { roots, projectRuntimeRoots };
}

function manifestJson(manifest: HubBackupManifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function cleanRedisLogicalSnapshotArtifacts(hubRoot: string) {
  const resolved = path.resolve(hubRoot);
  let names: string[];
  try {
    names = await readdir(resolved);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return;
    throw new Error(`Hub Redis logical snapshot artifacts could not be inspected: ${resolved}`, { cause: error });
  }
  for (const name of names) {
    if (!/^\.cpb-redis-logical-snapshot-[a-f0-9-]{36}\.json$/.test(name)) continue;
    const filePath = path.join(resolved, name);
    const pinned = await readPinnedMetadata(filePath, MAX_REDIS_SNAPSHOT_BYTES, "redis-artifact");
    await removePinnedRedisSnapshotArtifact(pinned.authority);
  }
}

async function isolatePinnedFilePreserveOnly(
  authority: FileAuthority,
  label: string,
  candidates: Record<string, string>,
  afterRepin?: (context: { filePath: string }) => void | Promise<void>,
  beforeFinalIsolation?: (context: { filePath: string; quarantinePath: string }) => void | Promise<void>,
) {
  const filePath = authority.filePath;
  const parent = path.dirname(filePath);
  const parentLabel = `${label} parent`;
  const recoveryPaths = { ...candidates, parent };
  const parentAuthority = await readDirectoryAuthority(parent, parentLabel);
  await repinFileAuthority(authority, label, recoveryPaths);
  await afterRepin?.({ filePath });
  await repinDirectoryLineage(parentAuthority, parentLabel, recoveryPaths);
  try {
    const isolation = await removeDurable(filePath, {
      beforeRename: async () => {
        await repinDirectoryLineage(parentAuthority, parentLabel, recoveryPaths);
        await repinFileAuthority(authority, label, recoveryPaths);
      },
      beforeFinalRename: beforeFinalIsolation,
      syncParentDirectory: async (directory) => {
        if (directory !== parent) {
          throw await authorityChanged(parentLabel, directory, recoveryPaths);
        }
        await repinDirectoryLineage(parentAuthority, parentLabel, recoveryPaths);
        await fsyncDirectory(directory);
        await repinDirectoryLineage(parentAuthority, parentLabel, recoveryPaths);
      },
    });
    await repinDirectoryLineage(parentAuthority, parentLabel, recoveryPaths);
    return isolation;
  } catch (error) {
    const cause = error && typeof error === "object" && "cause" in error
      ? (error as { cause?: unknown }).cause
      : null;
    if (errnoCode(cause) === "HUB_BACKUP_AUTHORITY_CHANGED") {
      throw cause;
    }
    if (error && typeof error === "object") {
      Object.assign(error, await recoveryMetadata({ ...recoveryPathsFromError(error), parent }));
    }
    throw error;
  }
}

async function removePinnedRedisSnapshotArtifact(authority: FileAuthority) {
  await isolatePinnedFilePreserveOnly(
    authority,
    "Hub Redis logical snapshot artifact",
    { artifact: authority.filePath },
    (context) => currentHubBackupTestHooks()?.afterRedisSnapshotRepin?.(context),
    (context) => currentHubBackupTestHooks()?.beforeRedisSnapshotFinalIsolation?.(context),
  );
}

export async function _internalCleanupRedisSnapshotArtifactForTests(filePath: string) {
  await fsyncFile(filePath);
  await fsyncDirectory(path.dirname(filePath));
  const authority = (await readPinnedMetadata(
    filePath,
    MAX_REDIS_SNAPSHOT_BYTES,
    "redis-artifact",
  )).authority;
  await removePinnedRedisSnapshotArtifact(authority);
}

function parseRedisLogicalSnapshot(raw: string, metadata: HubBackupRedisSnapshot): RedisLogicalSnapshot {
  if (Buffer.byteLength(raw, "utf8") > MAX_REDIS_SNAPSHOT_BYTES) throw new Error("Hub Redis logical snapshot exceeds its size limit");
  const value = recordValue(JSON.parse(raw));
  if (
    value.format !== "cpb-hub-redis-logical-snapshot/v1"
    || value.backendIdentityFingerprint !== metadata.backendIdentityFingerprint
    || value.capturedAt !== metadata.capturedAt
    || !Array.isArray(value.hashFields)
    || !Array.isArray(value.jobStreams)
    || typeof value.sha256 !== "string"
    || value.sha256 !== metadata.logicalSha256
  ) {
    throw new Error("Hub Redis logical snapshot metadata mismatch");
  }
  const hashFields: Array<[string, string]> = [];
  const fieldNames = new Set<string>();
  for (const tuple of value.hashFields) {
    if (!Array.isArray(tuple) || tuple.length !== 2 || typeof tuple[0] !== "string" || typeof tuple[1] !== "string"
      || fieldNames.has(tuple[0]) || tuple[0].startsWith("maintenance") || tuple[0] === "leaderToken") {
      throw new Error("Hub Redis logical snapshot contains an invalid hash field");
    }
    fieldNames.add(tuple[0]);
    hashFields.push([tuple[0], tuple[1]]);
  }
  if (hashFields.length > MAX_BACKUP_ENTRIES
    || JSON.stringify(hashFields.map(([field]) => field)) !== JSON.stringify([...fieldNames].sort())) {
    throw new Error("Hub Redis logical snapshot hash fields are not canonical");
  }
  const jobStreams: RedisLogicalSnapshot["jobStreams"] = [];
  const streamFields = new Set<string>();
  let eventCount = 0;
  for (const item of value.jobStreams) {
    const stream = recordValue(item);
    const field = String(stream.field || "");
    if (!field.startsWith("job:") || !fieldNames.has(field) || streamFields.has(field) || !Array.isArray(stream.events)
      || !stream.events.every((event) => typeof event === "string")) {
      throw new Error("Hub Redis logical snapshot contains an invalid job stream");
    }
    streamFields.add(field);
    eventCount += stream.events.length;
    if (eventCount > MAX_BACKUP_ENTRIES) throw new Error("Hub Redis logical snapshot contains too many events");
    jobStreams.push({ field, events: [...stream.events] as string[] });
  }
  const expectedJobFields = hashFields.filter(([field]) => field.startsWith("job:")).map(([field]) => field);
  if (JSON.stringify([...streamFields]) !== JSON.stringify(expectedJobFields)) {
    throw new Error("Hub Redis logical snapshot job stream set is incomplete");
  }
  const snapshotBody = {
    format: "cpb-hub-redis-logical-snapshot/v1" as const,
    backendIdentityFingerprint: metadata.backendIdentityFingerprint,
    capturedAt: metadata.capturedAt,
    hashFields,
    jobStreams,
  };
  const logicalSha256 = createHash("sha256").update(JSON.stringify(snapshotBody), "utf8").digest("hex");
  if (logicalSha256 !== metadata.logicalSha256) throw new Error("Hub Redis logical snapshot digest mismatch");
  return { ...snapshotBody, sha256: logicalSha256 };
}

type CreateHubBackupOptions = {
  cpbRoot: string;
  hubRoot: string;
  output: string;
  signingKey?: string;
  allowUnsignedDev?: boolean;
  minimumFreeBytes?: number;
  redisSnapshot?: HubBackupRedisSnapshot;
  redisBackend?: HubRedisStateBackend | null;
  localOnly?: boolean;
  beforeCommit?: () => Promise<void>;
};

function backupStagePaths(hubRoot: string, outputRoot: string) {
  const resolvedHubRoot = path.resolve(hubRoot);
  const resolvedOutput = path.resolve(outputRoot);
  const digest = createHash("sha256")
    .update(`${resolvedHubRoot}\0${resolvedOutput}`)
    .digest("hex")
    .slice(0, 16);
  const stage = path.join(path.dirname(resolvedOutput), `.${path.basename(resolvedOutput)}.cpb-stage-${digest}`);
  return { stage, owner: `${stage}.owner.json` };
}

async function readBackupStageOwner(ownerPath: string, hubRoot: string, outputRoot: string) {
  const pinned = await readPinnedMetadata(ownerPath, MAX_BACKUP_STAGE_OWNER_BYTES, "backup-stage-owner");
  let value: LooseRecord;
  try {
    value = recordValue(JSON.parse(pinned.raw));
  } catch (error) {
    throw new Error(`invalid Hub backup stage owner at ${ownerPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const expectedHubRoot = path.resolve(hubRoot);
  const expectedOutput = path.resolve(outputRoot);
  const stageGeneration = parsePersistedPathGeneration(value.stageGeneration);
  if (
    value.format !== "cpb-hub-backup-stage/v2"
    || typeof value.operationToken !== "string"
    || !OPERATION_TOKEN_RE.test(value.operationToken)
    || !stageGeneration
    || value.hubRoot !== expectedHubRoot
    || value.output !== expectedOutput
    || !Number.isFinite(Date.parse(String(value.createdAt || "")))
  ) {
    throw new Error(`Hub backup refuses unowned or mismatched stage cleanup: ${ownerPath}`);
  }
  return {
    owner: { ...value, stageGeneration } as BackupStageOwner,
    authority: pinned.authority,
  };
}

async function cleanOwnedBackupStage(hubRoot: string, outputRoot: string, expectedOperationToken?: string) {
  const paths = backupStagePaths(hubRoot, outputRoot);
  const stageExists = await pathExists(paths.stage);
  const ownerExists = await pathExists(paths.owner);
  if (!stageExists && !ownerExists) return paths;
  if (!ownerExists) {
    throw new Error(`Hub backup refuses to remove an unowned stage directory: ${paths.stage}`);
  }
  const owned = await readBackupStageOwner(paths.owner, hubRoot, outputRoot);
  if (expectedOperationToken && owned.owner.operationToken !== expectedOperationToken) {
    throw await authorityChanged("Hub backup stage owner", paths.owner, { stage: paths.stage, owner: paths.owner });
  }
  if (stageExists) {
    const observedStage = await readDirectoryAuthority(paths.stage, "Hub backup stage");
    if (!samePathGeneration(owned.owner.stageGeneration, observedStage.generation)) {
      throw await authorityChanged("Hub backup stage owner generation", paths.stage, {
        stage: paths.stage,
        owner: paths.owner,
      });
    }
    await currentHubBackupTestHooks()?.beforeOwnedStageRemoval?.({ stagePath: paths.stage, ownerPath: paths.owner });
    await repinFileAuthority(owned.authority, "Hub backup stage owner", { stage: paths.stage, owner: paths.owner });
    await repinDirectoryAuthority(observedStage, "Hub backup stage", { stage: paths.stage, owner: paths.owner });
    const recoveryPaths = { stage: paths.stage, owner: paths.owner, parent: path.dirname(paths.stage) };
    const isolated = await isolateDirectoryPreserveOnly({
      authority: observedStage,
      label: "Hub backup stage",
      quarantineLabel: "backup-stage-quarantine",
      recoveryPaths,
      syncOperation: "backup-stage-quarantine",
      committedCode: "HUB_BACKUP_STAGE_REMOVE_COMMITTED_AMBIGUOUS",
      beforeRename: ({ stagePath, quarantinePath }) => currentHubBackupTestHooks()?.beforeOwnedStageIsolation?.({
        stagePath,
        ownerPath: paths.owner,
        quarantinePath,
      }),
      afterRename: ({ stagePath, quarantinePath }) => currentHubBackupTestHooks()?.afterOwnedStageIsolation?.({
        stagePath,
        ownerPath: paths.owner,
        quarantinePath,
      }),
      beforeFinalCheck: ({ stagePath, quarantinePath }) => currentHubBackupTestHooks()?.beforeOwnedStageFinalCheck?.({
        stagePath,
        ownerPath: paths.owner,
        quarantinePath,
      }),
    });
    await finishRetainedDirectoryIsolation({
      evidence: isolated,
      label: "Hub backup stage",
      committedCode: "HUB_BACKUP_STAGE_REMOVE_COMMITTED_AMBIGUOUS",
      stagePath: paths.stage,
      recoveryPaths,
      forcedAttemptedPaths: [paths.owner],
      operation: async () => {
        await currentHubBackupTestHooks()?.beforeOwnedStageOwnerCleanup?.({
          stagePath: paths.stage,
          ownerPath: paths.owner,
          quarantinePath: isolated.quarantinePath,
        });
        await isolatePinnedFilePreserveOnly(
          owned.authority,
          "Hub backup stage owner",
          { owner: paths.owner },
        );
        await currentHubBackupTestHooks()?.afterOwnedStageOwnerCleanup?.({
          stagePath: paths.stage,
          ownerPath: paths.owner,
          quarantinePath: isolated.quarantinePath,
        });
      },
    });
    return paths;
  }
  await isolatePinnedFilePreserveOnly(
    owned.authority,
    "Hub backup stage owner",
    { owner: paths.owner },
  );
  return paths;
}

export async function createHubBackupUnlocked({
  cpbRoot,
  hubRoot,
  output,
  signingKey: signingKeyInput,
  allowUnsignedDev = false,
  minimumFreeBytes,
  redisSnapshot,
  redisBackend = null,
  localOnly = false,
  beforeCommit,
}: CreateHubBackupOptions) {
  const resolvedHubRoot = path.resolve(hubRoot);
  const outputRoot = path.resolve(output);
  const { roots, projectRuntimeRoots } = await sourceRootsForBackup(resolvedHubRoot, { localOnly });
  if (roots.some((root) => isWithin(root.sourcePath, outputRoot))) {
    throw new Error("backup output must be outside every backed-up root");
  }
  if (await pathExists(outputRoot)) {
    const completedStage = backupStagePaths(resolvedHubRoot, outputRoot);
    if (!await pathExists(completedStage.stage) && await pathExists(completedStage.owner)) {
      const owned = await readBackupStageOwner(completedStage.owner, resolvedHubRoot, outputRoot);
      await isolatePinnedFilePreserveOnly(
        owned.authority,
        "Hub backup published stage owner",
        { owner: completedStage.owner, output: outputRoot },
      );
    }
    throw new Error(`backup output already exists: ${outputRoot}`);
  }
  await assertHubBackupOffline(cpbRoot, resolvedHubRoot, projectRuntimeRoots, redisBackend);

  const parent = path.dirname(outputRoot);
  const signingKey = normalizeSigningKey(signingKeyInput);
  if (!signingKey && !allowUnsignedDev) {
    throw new Error("CPB_HUB_BACKUP_SIGNING_KEY is required; unsigned backups need explicit development opt-in");
  }
  await mkdir(parent, { recursive: true });
  const inspectedRoots: InspectedSourceRoot[] = [];
  let payloadBytes = 0n;
  let entryCount = 0;
  for (const root of roots) {
    const inspected = await inspectSourceRoot(root);
    inspectedRoots.push(inspected);
    entryCount += inspected.nodes.length;
    payloadBytes += inspected.nodes.reduce(
      (sum, node) => sum + (node.type === "file" ? BigInt(node.size) : 0n),
      0n,
    );
  }
  if (payloadBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Hub backup payload exceeds the safe manifest byte limit");
  }
  const stagePaths = await cleanOwnedBackupStage(resolvedHubRoot, outputRoot);
  await assertCopySpaceAvailable({
    directory: parent,
    operation: "Hub backup",
    payloadBytes,
    entryCount,
    minimumFreeBytes,
  });
  const stage = stagePaths.stage;
  await currentHubBackupTestHooks()?.beforeBackupStageCreate?.({ stagePath: stage, ownerPath: stagePaths.owner });
  await mkdir(stage, { recursive: false, mode: 0o700 });
  const createdStage = await readDirectoryAuthority(stage, "Hub backup stage");
  const stageOwner: BackupStageOwner = {
    format: "cpb-hub-backup-stage/v2",
    operationToken: randomUUID(),
    stageGeneration: persistPathGeneration(createdStage.generation),
    hubRoot: resolvedHubRoot,
    output: outputRoot,
    createdAt: new Date().toISOString(),
  };
  let stageOwnerAuthority = await writeJsonExclusiveDurable(
    stagePaths.owner,
    stageOwner,
    "backup-stage-owner",
    MAX_BACKUP_STAGE_OWNER_BYTES,
  );
  const copied: Array<Awaited<ReturnType<typeof copySourceRoot>>> = [];
  let published = false;
  try {
    await repinDirectoryAuthority(createdStage, "Hub backup stage", { stage, owner: stagePaths.owner });
    await mkdir(path.join(stage, "data"), { recursive: false, mode: 0o700 });
    await mkdir(path.join(stage, "data", "roots"), { recursive: false, mode: 0o700 });
    for (const inspected of inspectedRoots) {
      copied.push(await copySourceRoot(inspected, path.join(stage, "data", "roots", inspected.source.id)));
    }
    for (let index = 0; index < roots.length; index += 1) {
      await assertSourceUnchanged(
        roots[index],
        copied[index].sourceFingerprint,
        copied[index].sourceRootFingerprint,
        copied[index].entries,
      );
    }

    const entries = copied.flatMap((item) => item.entries)
      .sort((a, b) => `${a.rootId}/${a.path}`.localeCompare(`${b.rootId}/${b.path}`));
    const manifest: HubBackupManifest = {
      format: BACKUP_FORMAT,
      snapshotId: randomUUID(),
      createdAt: new Date().toISOString(),
      sourceHubRoot: resolvedHubRoot,
      roots: copied.map((item) => item.root),
      entries,
      fileCount: entries.filter((entry) => entry.type === "file").length,
      totalBytes: entries.reduce((sum, entry) => sum + (entry.size || 0), 0),
      ...(redisSnapshot ? { redisSnapshot } : {}),
    };
    const rawManifest = manifestJson(manifest);
    if (Buffer.byteLength(rawManifest, "utf8") > MAX_MANIFEST_BYTES) {
      throw new Error(`Hub backup manifest exceeds the ${MAX_MANIFEST_BYTES} byte safety limit`);
    }
    const manifestDigest = createHash("sha256").update(rawManifest).digest("hex");
    await writeFile(path.join(stage, "manifest.json"), rawManifest, { encoding: "utf8", mode: 0o600 });
    await writeFile(path.join(stage, "manifest.sha256"), `${manifestDigest}  manifest.json\n`, { encoding: "utf8", mode: 0o600 });
    if (signingKey) {
      const signature = createHmac("sha256", signingKey).update(rawManifest).digest("hex");
      await writeFile(path.join(stage, "manifest.hmac-sha256"), `${signature}  manifest.json\n`, { encoding: "utf8", mode: 0o600 });
    }
    await fsyncFile(path.join(stage, "manifest.json"));
    await fsyncFile(path.join(stage, "manifest.sha256"));
    if (signingKey) await fsyncFile(path.join(stage, "manifest.hmac-sha256"));
    await fsyncDirectory(path.join(stage, "data", "roots"));
    await fsyncDirectory(path.join(stage, "data"));
    await fsyncDirectory(stage);
    await verifyHubBackup(stage, { signingKey, requireSignature: Boolean(signingKey), allowUnsignedDev });
    await assertHubBackupOffline(cpbRoot, resolvedHubRoot, projectRuntimeRoots, redisBackend);
    const commitStage = await readDirectoryAuthority(stage, "Hub backup stage");
    const finalizedStageOwner: BackupStageOwner = {
      ...stageOwner,
      stageGeneration: persistPathGeneration(commitStage.generation),
    };
    stageOwnerAuthority = await updatePinnedJsonDurableInPlace(stageOwnerAuthority, finalizedStageOwner);
    const commitOwner = await readBackupStageOwner(stagePaths.owner, resolvedHubRoot, outputRoot);
    if (commitOwner.owner.operationToken !== stageOwner.operationToken) {
      throw await authorityChanged("Hub backup stage owner", stagePaths.owner, { stage, owner: stagePaths.owner });
    }
    if (!samePathGeneration(commitOwner.owner.stageGeneration, commitStage.generation)) {
      throw await authorityChanged("Hub backup stage owner generation", stage, { stage, owner: stagePaths.owner });
    }
    if (beforeCommit) await beforeCommit();
    await repinFileAuthority(commitOwner.authority, "Hub backup stage owner", { stage, owner: stagePaths.owner });
    await repinDirectoryAuthority(commitStage, "Hub backup stage", { stage, owner: stagePaths.owner });
    try {
      await moveDirectoryNoClobber(
        commitStage,
        outputRoot,
        "Hub backup output",
        { stage, owner: stagePaths.owner, output: outputRoot },
      );
      published = true;
    } catch (error) {
      if (hasCommittedMetadata(error) && error.committedPath === outputRoot) published = true;
      throw error;
    }
    try {
      await syncBackupDirectory(parent, "backup-publish");
    } catch (error) {
      throw Object.assign(new Error(`Hub backup publish committed with ambiguous durability: ${outputRoot}`, { cause: error }), {
        code: "HUB_BACKUP_PUBLISH_COMMITTED_AMBIGUOUS",
        committed: true,
        committedPath: outputRoot,
        ...(await recoveryMetadata({ output: outputRoot })),
      });
    }
    await isolatePinnedFilePreserveOnly(
      commitOwner.authority,
      "Hub backup published stage owner",
      { owner: stagePaths.owner, output: outputRoot },
    );
    return { output: outputRoot, manifest };
  } catch (error) {
    if (published) {
      let cleanupError: unknown = null;
      try {
        await cleanOwnedBackupStage(resolvedHubRoot, outputRoot, stageOwner.operationToken);
      } catch (caught) {
        cleanupError = caught;
      }
      if (!cleanupError && hasCommittedMetadata(error)) throw error;
      const cause = cleanupError
        ? new AggregateError([error, cleanupError], `Hub backup publication failed and owner cleanup is incomplete: ${outputRoot}`, {
          cause: error,
        })
        : error;
      throw await committedAmbiguityError({
        code: "HUB_BACKUP_COMMITTED_AMBIGUOUS",
        message: `Hub backup is published but post-commit finalization failed: ${outputRoot}`,
        committedPath: outputRoot,
        recoveryPaths: {
          ...recoveryPathsFromError(error),
          ...recoveryPathsFromError(cleanupError),
          output: outputRoot,
          owner: stagePaths.owner,
        },
        cause,
        forcedAttemptedPaths: cleanupError ? [stagePaths.owner] : [],
      });
    }
    try {
      const currentStage = await readOptionalDirectoryAuthority(stage, "Hub backup failed stage");
      if (currentStage && sameDirectoryLineage(createdStage.generation, currentStage.generation)) {
        stageOwnerAuthority = await updatePinnedJsonDurableInPlace(stageOwnerAuthority, {
          ...stageOwner,
          stageGeneration: persistPathGeneration(currentStage.generation),
        });
      }
    } catch {
      // The cleanup path below performs the authoritative fail-closed check.
    }
    try {
      await cleanOwnedBackupStage(resolvedHubRoot, outputRoot, stageOwner.operationToken);
    } catch (cleanupError) {
      throw await incompleteCleanupError({
        code: "HUB_BACKUP_CLEANUP_FAILED",
        message: `Hub backup failed and its owned stage could not be cleaned: ${stage}`,
        recoveryPaths: { stage, owner: stagePaths.owner },
        primaryError: error,
        cleanupErrors: [cleanupError],
      });
    }
    throw error;
  }
}

export async function createHubBackup(options: CreateHubBackupOptions) {
  const redis = await openPinnedHubRedisStateBackend({
    configFile: process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE,
    hubRoot: options.hubRoot,
  });
  const maintenance = await acquireHubMaintenance(options.hubRoot, "Hub backup");
  const redisToken = redis ? `backup-${randomUUID()}` : null;
  const redisTtlMs = 3_600_000;
  let redisSnapshotPath: string | null = null;
  let redisSnapshotAuthority: FileAuthority | null = null;
  let redisOwned = false;
  let renewTimer: NodeJS.Timeout | null = null;
  let renewInFlight = false;
  let renewalError: unknown = null;
  let result: Awaited<ReturnType<typeof createHubBackupUnlocked>> | null = null;
  let operationError: unknown = null;
  let committedPath: string | null = null;
  try {
    if (!redis || !redisToken) {
      result = await createHubBackupUnlocked(options);
    } else {
      const acquired = await redis.acquireMaintenance(redisToken, "Hub backup", redisTtlMs);
      if (!acquired.acquired) {
        throw Object.assign(new Error("another Hub Redis maintenance operation is active"), { code: "HUB_MAINTENANCE_ACTIVE" });
      }
      redisOwned = true;
      renewTimer = setInterval(() => {
        if (renewInFlight || renewalError) return;
        renewInFlight = true;
        void redis.renewMaintenance(redisToken, redisTtlMs)
          .then((renewed) => {
            if (!renewed.acquired) renewalError = Object.assign(new Error("Hub Redis maintenance lease was lost"), { code: "HUB_MAINTENANCE_ACTIVE" });
          })
          .catch((error) => { renewalError = error; })
          .finally(() => { renewInFlight = false; });
      }, 60_000);
      renewTimer.unref();

      await cleanRedisLogicalSnapshotArtifacts(options.hubRoot);

      const snapshot: RedisLogicalSnapshot = await redis.exportSnapshot(redisToken);
      const relativePath = `.cpb-redis-logical-snapshot-${randomUUID()}.json`;
      redisSnapshotPath = path.join(path.resolve(options.hubRoot), relativePath);
      const serialized = `${JSON.stringify(snapshot)}\n`;
      await writeFile(redisSnapshotPath, serialized, { encoding: "utf8", mode: 0o600 });
      await fsyncFile(redisSnapshotPath);
      await fsyncDirectory(path.resolve(options.hubRoot));
      const pinnedSnapshot = await readPinnedMetadata(
        redisSnapshotPath,
        MAX_REDIS_SNAPSHOT_BYTES,
        "redis-artifact",
      );
      if (pinnedSnapshot.raw !== serialized) {
        throw await authorityChanged("Hub Redis logical snapshot artifact", redisSnapshotPath, {
          artifact: redisSnapshotPath,
        });
      }
      redisSnapshotAuthority = pinnedSnapshot.authority;
      const redisSnapshot: HubBackupRedisSnapshot = {
        format: snapshot.format,
        rootId: "hub",
        path: relativePath,
        backendIdentityFingerprint: snapshot.backendIdentityFingerprint,
        capturedAt: snapshot.capturedAt,
        logicalSha256: snapshot.sha256,
        fileSha256: pinnedSnapshot.authority.sha256,
      };
      result = await createHubBackupUnlocked({
        ...options,
        redisSnapshot,
        redisBackend: redis,
        beforeCommit: async () => {
          if (renewalError) throw renewalError;
          const status = await redis.readMaintenance();
          if (!status.active || status.token !== redisToken) {
            throw Object.assign(new Error("Hub Redis maintenance lease was lost before backup commit"), { code: "HUB_MAINTENANCE_ACTIVE" });
          }
        },
      });
    }
    committedPath = result.output;
  } catch (error) {
    operationError = error;
    if (hasCommittedMetadata(error)) committedPath = error.committedPath;
  }

  if (renewTimer) clearInterval(renewTimer);
  const cleanupErrors: unknown[] = [];
  if (redisSnapshotPath) {
    if (redisSnapshotAuthority) {
      try {
        await removePinnedRedisSnapshotArtifact(redisSnapshotAuthority);
      } catch (error) {
        cleanupErrors.push(error);
      }
    } else {
      try {
        if (await pathExists(redisSnapshotPath)) {
          cleanupErrors.push(Object.assign(new Error(`Hub Redis logical snapshot artifact was preserved without deletion authority: ${redisSnapshotPath}`), {
            code: "HUB_REDIS_SNAPSHOT_CLEANUP_UNVERIFIED",
            committed: false,
            committedPath: null,
            ...(await recoveryMetadata({ artifact: redisSnapshotPath })),
          }));
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (redis && redisToken && redisOwned) {
    try {
      const status = await redis.readMaintenance();
      if (!status.active || status.token !== redisToken || !(await redis.releaseMaintenance(redisToken))) {
        throw new Error("Hub backup lost Redis maintenance lock ownership");
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    if (!(await maintenance.release())) {
      throw new Error(`Hub backup lost maintenance lock ownership: ${maintenance.lockPath}`);
    }
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (cleanupErrors.length > 0) {
    const recoveryPaths = {
      ...recoveryPathsFromError(operationError),
      ...(committedPath ? { output: committedPath } : {}),
      ...(redisSnapshotPath ? { redisSnapshot: redisSnapshotPath } : {}),
      maintenance: maintenance.lockPath,
    };
    const cause = operationError
      ? new AggregateError([operationError, ...cleanupErrors], "Hub backup operation and finalization both failed", {
        cause: operationError,
      })
      : cleanupErrors.length === 1
        ? cleanupErrors[0]
        : new AggregateError(cleanupErrors, "Hub backup finalization failed", { cause: cleanupErrors[0] });
    if (committedPath) {
      throw await committedAmbiguityError({
        code: "HUB_BACKUP_COMMITTED_AMBIGUOUS",
        message: `Hub backup is published but lease or artifact finalization failed: ${committedPath}`,
        committedPath,
        recoveryPaths,
        cause,
      });
    }
    throw await incompleteCleanupError({
      code: "HUB_BACKUP_CLEANUP_FAILED",
      message: "Hub backup failed and finalization is incomplete",
      recoveryPaths,
      primaryError: operationError,
      cleanupErrors,
    });
  }
  if (operationError) throw operationError;
  if (!result) throw new Error("Hub backup completed without a result");
  return result;
}

function parseManifest(raw: string): HubBackupManifest {
  const value = recordValue(JSON.parse(raw));
  if (value.format !== BACKUP_FORMAT) throw new Error(`unsupported Hub backup format: ${String(value.format || "missing")}`);
  if (!Array.isArray(value.roots) || !Array.isArray(value.entries)) throw new Error("invalid Hub backup manifest collections");
  const snapshotId = String(value.snapshotId || "");
  const createdAt = String(value.createdAt || "");
  const sourceHubRoot = String(value.sourceHubRoot || "");
  if (!snapshotId || !Number.isFinite(Date.parse(createdAt)) || !path.isAbsolute(sourceHubRoot)) {
    throw new Error("invalid Hub backup manifest identity");
  }
  const rawRoots = value.roots.map((item) => recordValue(item));
  if (value.entries.length > MAX_BACKUP_ENTRIES) {
    throw new Error(`Hub backup exceeds the ${MAX_BACKUP_ENTRIES} entry safety limit`);
  }
  const rawEntries = value.entries.map((item) => recordValue(item));
  const roots: HubBackupRoot[] = [];
  const rootIds = new Set<string>();
  for (const rawRoot of rawRoots) {
    const id = String(rawRoot.id || "");
    const kind = rawRoot.kind === "hub" ? "hub" : rawRoot.kind === "project-runtime" ? "project-runtime" : null;
    const projectId = typeof rawRoot.projectId === "string" ? rawRoot.projectId : undefined;
    const sourcePath = String(rawRoot.sourcePath || "");
    const mode = Number(rawRoot.mode);
    const entryCount = Number(rawRoot.entryCount);
    if (!/^(hub|project-[a-f0-9]{20})$/.test(id) || rootIds.has(id)) {
      throw new Error(`invalid or duplicate Hub backup root id: ${id}`);
    }
    rootIds.add(id);
    if (!kind || !path.isAbsolute(sourcePath)) throw new Error(`invalid backup root metadata: ${id}`);
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error(`invalid root mode: ${id}`);
    if (!Number.isSafeInteger(entryCount) || entryCount < 0 || entryCount > MAX_BACKUP_ENTRIES) throw new Error(`invalid root entry count: ${id}`);
    if (kind === "project-runtime" && !projectId) throw new Error(`project runtime root lacks projectId: ${id}`);
    roots.push({ id, kind, ...(projectId ? { projectId } : {}), sourcePath, mode, entryCount });
  }
  if (roots.length !== 1 || roots[0].id !== "hub" || roots[0].kind !== "hub") {
    throw new Error("Hub backup v1 must contain exactly one Hub root");
  }
  const entries: HubBackupEntry[] = [];
  const entryKeys = new Set<string>();
  for (const rawEntry of rawEntries) {
    const rootId = String(rawEntry.rootId || "");
    const entryPath = safeManifestPath(rawEntry.path);
    const type = rawEntry.type === "directory" ? "directory" : rawEntry.type === "file" ? "file" : null;
    const mode = Number(rawEntry.mode);
    const mtimeMs = Number(rawEntry.mtimeMs);
    const size = rawEntry.size === undefined ? undefined : Number(rawEntry.size);
    const sha256 = rawEntry.sha256 === undefined ? undefined : String(rawEntry.sha256);
    if (!rootIds.has(rootId)) throw new Error(`backup entry references unknown root: ${rootId}`);
    const key = `${rootId}/${entryPath}`;
    if (entryKeys.has(key)) throw new Error(`duplicate backup entry: ${key}`);
    entryKeys.add(key);
    if (!type) throw new Error(`invalid backup entry type: ${key}`);
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777 || !Number.isFinite(mtimeMs)) throw new Error(`invalid backup entry metadata: ${key}`);
    if (type === "file" && (!Number.isSafeInteger(size) || Number(size) < 0 || !/^[a-f0-9]{64}$/.test(String(sha256 || "")))) {
      throw new Error(`invalid backup file metadata: ${key}`);
    }
    entries.push({
      rootId,
      path: entryPath,
      type,
      mode,
      mtimeMs,
      ...(type === "file" ? { size, sha256 } : {}),
    });
  }
  for (const root of roots) {
    if (entries.filter((entry) => entry.rootId === root.id).length !== Number(root.entryCount)) {
      throw new Error(`backup root entry count mismatch: ${root.id}`);
    }
  }
  const fileCount = Number(value.fileCount);
  const totalBytes = Number(value.totalBytes);
  if (!Number.isSafeInteger(fileCount) || fileCount < 0 || !Number.isSafeInteger(totalBytes) || totalBytes < 0) {
    throw new Error("invalid Hub backup manifest totals");
  }
  let redisSnapshot: HubBackupRedisSnapshot | undefined;
  if (value.redisSnapshot !== undefined) {
    const rawSnapshot = recordValue(value.redisSnapshot);
    const snapshotPath = safeManifestPath(rawSnapshot.path);
    const backendIdentityFingerprint = String(rawSnapshot.backendIdentityFingerprint || "");
    const capturedAt = String(rawSnapshot.capturedAt || "");
    const logicalSha256 = String(rawSnapshot.logicalSha256 || "");
    const fileSha256 = String(rawSnapshot.fileSha256 || "");
    const snapshotEntry = entries.find((entry) => entry.rootId === "hub" && entry.path === snapshotPath && entry.type === "file");
    if (
      rawSnapshot.format !== "cpb-hub-redis-logical-snapshot/v1"
      || rawSnapshot.rootId !== "hub"
      || !/^[a-f0-9]{64}$/.test(backendIdentityFingerprint)
      || !Number.isFinite(Date.parse(capturedAt))
      || new Date(Date.parse(capturedAt)).toISOString() !== capturedAt
      || !/^[a-f0-9]{64}$/.test(logicalSha256)
      || !/^[a-f0-9]{64}$/.test(fileSha256)
      || !snapshotEntry
      || snapshotEntry.sha256 !== fileSha256
    ) {
      throw new Error("invalid Hub Redis snapshot manifest metadata");
    }
    redisSnapshot = {
      format: "cpb-hub-redis-logical-snapshot/v1",
      rootId: "hub",
      path: snapshotPath,
      backendIdentityFingerprint,
      capturedAt,
      logicalSha256,
      fileSha256,
    };
  }
  return {
    format: BACKUP_FORMAT,
    snapshotId,
    createdAt,
    sourceHubRoot,
    roots,
    entries,
    fileCount,
    totalBytes,
    ...(redisSnapshot ? { redisSnapshot } : {}),
  };
}

async function verifySnapshotRoot(rootPath: string, root: HubBackupRoot, expected: HubBackupEntry[]) {
  const info = await lstat(rootPath);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`backup data root is not a real directory: ${root.id}`);
  if ((info.mode & 0o777) !== root.mode) throw new Error(`backup data root mode mismatch: ${root.id}`);
  const actual = await walkRoot(rootPath);
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
  if (actualByPath.size !== expectedByPath.size) throw new Error(`backup data entry count mismatch: ${root.id}`);
  for (const [relative, entry] of expectedByPath) {
    const found = actualByPath.get(relative);
    if (!found || found.type !== entry.type) throw new Error(`backup data entry missing or changed: ${root.id}/${relative}`);
    if (found.mode !== entry.mode) throw new Error(`backup data entry mode mismatch: ${root.id}/${relative}`);
    if (entry.type === "file") {
      if (found.size !== entry.size) throw new Error(`backup file size mismatch: ${root.id}/${relative}`);
      const digest = await sha256File(nativePath(rootPath, relative));
      if (digest !== entry.sha256) throw new Error(`backup file checksum mismatch: ${root.id}/${relative}`);
    }
  }
}

export async function verifyHubBackup(input: string, options: BackupVerificationOptions = {}): Promise<VerifiedBackup> {
  const backupRoot = path.resolve(input);
  await assertRealDirectory(backupRoot, "Hub backup");
  const signingKey = normalizeSigningKey(options.signingKey);
  const topLevel = (await readdir(backupRoot)).sort();
  const hasSignature = topLevel.includes("manifest.hmac-sha256");
  if ((options.requireSignature || Boolean(signingKey) || options.allowUnsignedDev !== true) && !hasSignature) {
    throw new Error("Hub backup signature is required but missing");
  }
  const expectedTopLevel = ["data", ...(hasSignature ? ["manifest.hmac-sha256"] : []), "manifest.json", "manifest.sha256"].sort();
  if (JSON.stringify(topLevel) !== JSON.stringify(expectedTopLevel)) throw new Error("Hub backup top-level file set mismatch");
  const dataRoot = path.join(backupRoot, "data");
  const dataRoots = path.join(dataRoot, "roots");
  const manifestPath = path.join(backupRoot, "manifest.json");
  const checksumPath = path.join(backupRoot, "manifest.sha256");
  await assertRealDirectory(dataRoot, "Hub backup data directory");
  await assertRealDirectory(dataRoots, "Hub backup roots directory");
  const manifestInfo = await assertRealFile(manifestPath, "Hub backup manifest");
  if (manifestInfo.size > MAX_MANIFEST_BYTES) {
    throw new Error(`Hub backup manifest exceeds the ${MAX_MANIFEST_BYTES} byte safety limit`);
  }
  await assertRealFile(checksumPath, "Hub backup manifest checksum");
  if (hasSignature) await assertRealFile(path.join(backupRoot, "manifest.hmac-sha256"), "Hub backup signature");
  const dataEntries = (await readdir(dataRoot)).sort();
  if (JSON.stringify(dataEntries) !== JSON.stringify(["roots"])) throw new Error("Hub backup data directory set mismatch");
  const rawManifest = (await readPinnedMetadata(manifestPath, MAX_MANIFEST_BYTES, "backup-manifest")).raw;
  const checksumText = (await readPinnedMetadata(checksumPath, MAX_DIGEST_FILE_BYTES, "backup-digest")).raw.trim();
  const expectedManifestDigest = checksumText.match(/^([a-f0-9]{64})  manifest\.json$/)?.[1];
  if (!expectedManifestDigest) throw new Error("invalid Hub backup manifest checksum file");
  const actualManifestDigest = createHash("sha256").update(rawManifest).digest("hex");
  if (actualManifestDigest !== expectedManifestDigest) throw new Error("Hub backup manifest checksum mismatch");
  if (hasSignature) {
    if (!signingKey) throw new Error("signed Hub backup requires CPB_HUB_BACKUP_SIGNING_KEY for verification");
    const signatureText = (await readPinnedMetadata(
      path.join(backupRoot, "manifest.hmac-sha256"),
      MAX_DIGEST_FILE_BYTES,
      "backup-digest",
    )).raw.trim();
    const expectedSignature = signatureText.match(/^([a-f0-9]{64})  manifest\.json$/)?.[1];
    if (!expectedSignature) throw new Error("invalid Hub backup signature file");
    const actualSignature = createHmac("sha256", signingKey).update(rawManifest).digest("hex");
    if (!timingSafeEqual(Buffer.from(actualSignature, "hex"), Buffer.from(expectedSignature, "hex"))) {
      throw new Error("Hub backup signature mismatch");
    }
  }
  const manifest = parseManifest(rawManifest);

  const actualRootIds = (await readdir(dataRoots)).sort();
  const expectedRootIds = manifest.roots.map((root) => root.id).sort();
  if (JSON.stringify(actualRootIds) !== JSON.stringify(expectedRootIds)) throw new Error("Hub backup root set mismatch");
  for (const root of manifest.roots) {
    await verifySnapshotRoot(
      path.join(dataRoots, root.id),
      root,
      manifest.entries.filter((entry) => entry.rootId === root.id),
    );
  }
  if (manifest.redisSnapshot) {
    const snapshotPath = nativePath(path.join(dataRoots, "hub"), manifest.redisSnapshot.path);
    const snapshotInfo = await assertRealFile(snapshotPath, "Hub Redis logical snapshot");
    if (snapshotInfo.size > MAX_REDIS_SNAPSHOT_BYTES) throw new Error("Hub Redis logical snapshot exceeds its size limit");
    parseRedisLogicalSnapshot(
      (await readPinnedMetadata(snapshotPath, MAX_REDIS_SNAPSHOT_BYTES, "redis-snapshot")).raw,
      manifest.redisSnapshot,
    );
  }
  const fileCount = manifest.entries.filter((entry) => entry.type === "file").length;
  const totalBytes = manifest.entries.reduce((sum, entry) => sum + (entry.size || 0), 0);
  if (fileCount !== manifest.fileCount || totalBytes !== manifest.totalBytes) throw new Error("Hub backup manifest totals mismatch");
  return { backupRoot, manifest };
}

async function redisSnapshotFromVerifiedBackup(verified: VerifiedBackup) {
  const metadata = verified.manifest.redisSnapshot;
  if (!metadata) return null;
  const snapshotPath = nativePath(path.join(verified.backupRoot, "data", "roots", "hub"), metadata.path);
  return parseRedisLogicalSnapshot(
    (await readPinnedMetadata(snapshotPath, MAX_REDIS_SNAPSHOT_BYTES, "redis-snapshot")).raw,
    metadata,
  );
}

async function readRedisRollbackSnapshotFile(filePath: string, expectedSha256: string) {
  const pinned = await readPinnedMetadata(
    filePath,
    MAX_REDIS_SNAPSHOT_BYTES,
    "redis-rollback",
  );
  if (process.platform !== "win32" && (pinned.authority.mode & 0o077) !== 0) {
    throw new Error("Hub Redis rollback snapshot must be private");
  }
  const parsed = JSON.parse(pinned.raw) as RedisLogicalSnapshot;
  if (parsed.sha256 !== expectedSha256) throw new Error("Hub Redis rollback snapshot digest mismatch");
  return { snapshot: parsed, authority: pinned.authority };
}

export async function _internalReadRedisRollbackSnapshotForTests(filePath: string, expectedSha256: string) {
  return (await readRedisRollbackSnapshotFile(filePath, expectedSha256)).snapshot;
}

async function readRedisRollbackSnapshot(journal: HubRestoreJournal) {
  if (!journal.redis) return null;
  return readRedisRollbackSnapshotFile(journal.redis.rollbackSnapshotPath, journal.redis.rollbackLogicalSha256);
}

type RedisRestoreRecoverySession = {
  backend: HubRedisStateBackend;
  token: string;
  rollback: RedisLogicalSnapshot;
  rollbackAuthority: FileAuthority;
  target: RedisLogicalSnapshot;
};

async function openRedisRestoreRecoverySession(journal: HubRestoreJournal, signingKey?: string): Promise<RedisRestoreRecoverySession | null> {
  if (!journal.redis) return null;
  const backend = await openPinnedHubRedisStateBackend({
    configFile: process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE,
    hubRoot: journal.hubRoot,
  });
  if (!backend || backend.identityFingerprint !== journal.redis.backendIdentityFingerprint) {
    throw Object.assign(new Error("Hub Redis restore recovery backend identity is unavailable or changed"), {
      code: "HUB_STATE_BACKEND_IDENTITY_CHANGED",
    });
  }
  const acquired = await backend.acquireMaintenance(journal.redis.maintenanceToken, "Hub restore recovery", 3_600_000);
  if (!acquired.acquired) throw Object.assign(new Error("another Hub Redis maintenance operation is active"), { code: "HUB_MAINTENANCE_ACTIVE" });
  const rollback = await readRedisRollbackSnapshot(journal);
  if (!rollback) throw new Error("Hub Redis restore recovery rollback snapshot is missing");
  const verified = await verifyHubBackup(journal.input, {
    signingKey,
    requireSignature: journal.signatureRequired,
    allowUnsignedDev: !journal.signatureRequired,
  });
  const target = await redisSnapshotFromVerifiedBackup(verified);
  if (!target || target.sha256 !== journal.redis.targetLogicalSha256) {
    throw new Error("Hub Redis restore recovery target snapshot is missing or changed");
  }
  return {
    backend,
    token: journal.redis.maintenanceToken,
    rollback: rollback.snapshot,
    rollbackAuthority: rollback.authority,
    target,
  };
}

async function finishRedisRestoreRecovery(journal: HubRestoreJournal, session: RedisRestoreRecoverySession | null) {
  await currentHubBackupTestHooks()?.beforeFinishRedisRestoreRecovery?.({
    journalPath: hubRestoreJournalPath(journal.hubRoot),
    hasRedisSession: Boolean(session),
  });
  if (!session || !journal.redis) return false;
  const rollbackIsolation = await isolatePinnedFilePreserveOnly(
    session.rollbackAuthority,
    "Hub Redis rollback snapshot",
    { rollbackSnapshot: journal.redis.rollbackSnapshotPath },
  );
  const status = await session.backend.readMaintenance();
  if (!status.active || status.token !== session.token || !(await session.backend.releaseMaintenance(session.token))) {
    let quarantineVerified = false;
    if (rollbackIsolation) {
      try {
        const current = lstatSync(rollbackIsolation.quarantinePath);
        quarantineVerified = current.isFile()
          && !current.isSymbolicLink()
          && samePathGeneration(rollbackIsolation.generation, pathGeneration(current));
      } catch {
        quarantineVerified = false;
      }
    }
    throw Object.assign(new Error("Hub Redis restore recovery lost maintenance lock ownership"), {
      code: "HUB_MAINTENANCE_ACTIVE",
      committed: true,
      committedPath: rollbackIsolation?.quarantinePath || journal.redis.rollbackSnapshotPath,
      ...(quarantineVerified ? {
        quarantinePreserved: true,
        recoveryPaths: { rollbackSnapshot: rollbackIsolation?.quarantinePath as string },
        attemptedPaths: { rollbackSnapshot: journal.redis.rollbackSnapshotPath },
      } : {
        successorPreserved: Boolean(rollbackIsolation),
        recoveryPaths: {},
        attemptedPaths: {
          rollbackSnapshot: journal.redis.rollbackSnapshotPath,
          ...(rollbackIsolation ? { rollbackQuarantine: rollbackIsolation.quarantinePath } : {}),
        },
      }),
    });
  }
  return true;
}

async function applyRedisRecoverySnapshot(
  journal: HubRestoreJournal,
  session: RedisRestoreRecoverySession,
  kind: "rollback" | "target",
) {
  await repinRestoreJournal(journal);
  if (kind === "rollback" && journal.redis) {
    await repinFileAuthority(session.rollbackAuthority, "Hub Redis rollback snapshot", {
      rollbackSnapshot: journal.redis.rollbackSnapshotPath,
      journal: hubRestoreJournalPath(journal.hubRoot),
    });
  }
  await session.backend.restoreSnapshot(session.token, session[kind]);
}

async function copyBackupRoot(source: string, destination: string, root: HubBackupRoot, entries: HubBackupEntry[]) {
  await mkdir(destination, { recursive: false, mode: 0o700 });
  await chmod(destination, 0o700);
  for (const entry of entries) {
    const sourcePath = nativePath(source, entry.path);
    const targetPath = nativePath(destination, entry.path);
    if (entry.type === "directory") {
      await mkdir(targetPath, { recursive: false, mode: 0o700 });
      await chmod(targetPath, 0o700);
    } else {
      await copyFile(sourcePath, targetPath);
      await chmod(targetPath, entry.mode);
      await utimes(targetPath, new Date(entry.mtimeMs), new Date(entry.mtimeMs));
      await fsyncFile(targetPath);
    }
  }
  for (const entry of entries.filter((item) => item.type === "directory").reverse()) {
    const targetPath = nativePath(destination, entry.path);
    await chmod(targetPath, entry.mode);
    await utimes(targetPath, new Date(entry.mtimeMs), new Date(entry.mtimeMs));
    await fsyncDirectory(targetPath);
  }
  await chmod(destination, root.mode);
  await fsyncDirectory(destination);
  await verifySnapshotRoot(destination, root, entries);
}

type RestoreHubBackupOptions = {
  cpbRoot: string;
  hubRoot: string;
  input: string;
  force?: boolean;
  signingKey?: string;
  requireSignature?: boolean;
  allowUnsignedDev?: boolean;
  minimumFreeBytes?: number;
  redisBackend?: HubRedisStateBackend | null;
  redisToken?: string | null;
  maintenanceToken?: string | null;
  faultInjector?: (phase: "redis_before_commit" | "redis_after_commit" | "filesystem_after_target_rename") => void | Promise<void>;
};

type RestoreJournalPhase = "staged" | "redis_restoring" | "redis_restored" | "target_moved" | "committed";

type RedisRestoreJournal = {
  backendIdentityFingerprint: string;
  maintenanceToken: string;
  rollbackSnapshotPath: string;
  rollbackLogicalSha256: string;
  targetLogicalSha256: string;
};

type HubRestoreJournal = {
  format: "cpb-hub-restore/v1";
  operationToken: string;
  snapshotId: string;
  input: string;
  hubRoot: string;
  targetPath: string;
  stagePath: string;
  stageGeneration: PersistedPathGeneration | null;
  rollbackPath: string | null;
  rollbackGeneration: PersistedPathGeneration | null;
  targetExisted: boolean;
  signatureRequired: boolean;
  maintenanceToken: string | null;
  redis: RedisRestoreJournal | null;
  phase: RestoreJournalPhase;
  createdAt: string;
  updatedAt: string;
};

function restoreRecoveryPaths(journal: HubRestoreJournal) {
  return {
    canonical: journal.targetPath,
    journal: hubRestoreJournalPath(journal.hubRoot),
    stage: journal.stagePath,
    ...(journal.rollbackPath ? { rollback: journal.rollbackPath } : {}),
    ...(journal.redis ? { redisRollbackSnapshot: journal.redis.rollbackSnapshotPath } : {}),
  };
}

const restoreJournalAuthorities = new WeakMap<HubRestoreJournal, FileAuthority>();

function restoreStagePrefix(hubRoot: string) {
  const resolved = path.resolve(hubRoot);
  return path.join(path.dirname(resolved), `.${path.basename(resolved)}.restore-stage-`);
}

function restoreRollbackPrefix(hubRoot: string) {
  return `${path.resolve(hubRoot)}.pre-restore-`;
}

function redisRestoreRollbackPrefix(hubRoot: string) {
  const resolved = path.resolve(hubRoot);
  return path.join(path.dirname(resolved), `.${path.basename(resolved)}.redis-rollback-`);
}

function parseRestoreJournal(raw: string, expectedHubRoot: string): HubRestoreJournal {
  const value = recordValue(JSON.parse(raw));
  const hubRoot = path.resolve(expectedHubRoot);
  const input = String(value.input || "");
  const targetPath = String(value.targetPath || "");
  const stagePath = String(value.stagePath || "");
  const stageGeneration = value.stageGeneration === null || value.stageGeneration === undefined
    ? null
    : parsePersistedPathGeneration(value.stageGeneration);
  const rollbackPath = value.rollbackPath === null ? null : String(value.rollbackPath || "");
  const rollbackGeneration = value.rollbackGeneration === null || value.rollbackGeneration === undefined
    ? null
    : parsePersistedPathGeneration(value.rollbackGeneration);
  const phase = value.phase === "staged" || value.phase === "redis_restoring" || value.phase === "redis_restored"
    || value.phase === "target_moved" || value.phase === "committed"
    ? value.phase
    : null;
  const rawRedis = value.redis === null || value.redis === undefined ? null : recordValue(value.redis);
  const maintenanceToken = value.maintenanceToken === null || value.maintenanceToken === undefined
    ? null
    : String(value.maintenanceToken || "");
  let redis: RedisRestoreJournal | null = null;
  if (rawRedis) {
    const rollbackSnapshotPath = String(rawRedis.rollbackSnapshotPath || "");
    if (!/^[a-f0-9]{64}$/.test(String(rawRedis.backendIdentityFingerprint || ""))
      || typeof rawRedis.maintenanceToken !== "string" || rawRedis.maintenanceToken.length < 16
      || !rollbackSnapshotPath.startsWith(redisRestoreRollbackPrefix(hubRoot))
      || path.dirname(rollbackSnapshotPath) !== path.dirname(hubRoot)
      || !/^[a-f0-9]{64}$/.test(String(rawRedis.rollbackLogicalSha256 || ""))
      || !/^[a-f0-9]{64}$/.test(String(rawRedis.targetLogicalSha256 || ""))) {
      throw new Error(`invalid Hub Redis restore journal: ${hubRestoreJournalPath(hubRoot)}`);
    }
    redis = {
      backendIdentityFingerprint: String(rawRedis.backendIdentityFingerprint),
      maintenanceToken: String(rawRedis.maintenanceToken),
      rollbackSnapshotPath,
      rollbackLogicalSha256: String(rawRedis.rollbackLogicalSha256),
      targetLogicalSha256: String(rawRedis.targetLogicalSha256),
    };
  }
  if (
    value.format !== "cpb-hub-restore/v1"
    || typeof value.operationToken !== "string"
    || !OPERATION_TOKEN_RE.test(value.operationToken)
    || String(value.hubRoot || "") !== hubRoot
    || targetPath !== hubRoot
    || !path.isAbsolute(input)
    || isWithin(hubRoot, input)
    || isWithin(input, hubRoot)
    || !stagePath.startsWith(restoreStagePrefix(hubRoot))
    || path.dirname(stagePath) !== path.dirname(hubRoot)
    || (value.stageGeneration !== null && value.stageGeneration !== undefined && !stageGeneration)
    || (rollbackPath !== null && (!rollbackPath.startsWith(restoreRollbackPrefix(hubRoot)) || path.dirname(rollbackPath) !== path.dirname(hubRoot)))
    || (value.rollbackGeneration !== null && value.rollbackGeneration !== undefined && !rollbackGeneration)
    || (value.targetExisted === true && rollbackPath === null)
    || (value.targetExisted !== true && rollbackPath !== null)
    || (value.targetExisted !== true && rollbackGeneration !== null)
    || typeof value.signatureRequired !== "boolean"
    || (maintenanceToken !== null && maintenanceToken.length < 16)
    || !phase
    || ((phase === "redis_restoring" || phase === "redis_restored") && !redis)
    || !String(value.snapshotId || "")
    || !Number.isFinite(Date.parse(String(value.createdAt || "")))
    || !Number.isFinite(Date.parse(String(value.updatedAt || "")))
  ) {
    throw new Error(`invalid Hub restore journal: ${hubRestoreJournalPath(hubRoot)}`);
  }
  return {
    format: "cpb-hub-restore/v1",
    operationToken: value.operationToken,
    snapshotId: String(value.snapshotId),
    input: path.resolve(input),
    hubRoot,
    targetPath,
    stagePath,
    stageGeneration,
    rollbackPath,
    rollbackGeneration,
    targetExisted: value.targetExisted === true,
    signatureRequired: value.signatureRequired,
    maintenanceToken,
    redis,
    phase,
    createdAt: String(value.createdAt),
    updatedAt: String(value.updatedAt),
  };
}

async function readRestoreJournal(hubRoot: string) {
  const journalPath = hubRestoreJournalPath(hubRoot);
  try {
    const pinned = await readPinnedMetadata(journalPath, MAX_RESTORE_JOURNAL_BYTES, "restore-journal");
    const journal = parseRestoreJournal(pinned.raw, hubRoot);
    restoreJournalAuthorities.set(journal, pinned.authority);
    return journal;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function repinRestoreJournal(journal: HubRestoreJournal) {
  const authority = restoreJournalAuthorities.get(journal);
  const journalPath = hubRestoreJournalPath(journal.hubRoot);
  if (!authority) throw await authorityChanged("Hub restore journal", journalPath, { journal: journalPath });
  await repinFileAuthority(authority, "Hub restore journal", { journal: journalPath });
}

async function removeRestoreJournal(journal: HubRestoreJournal) {
  const journalPath = hubRestoreJournalPath(journal.hubRoot);
  const authority = restoreJournalAuthorities.get(journal);
  if (!authority) throw await authorityChanged("Hub restore journal", journalPath, { journal: journalPath });
  await isolatePinnedFilePreserveOnly(
    authority,
    "Hub restore journal",
    { journal: journalPath },
  );
}

async function writeRestoreJournal(
  journal: HubRestoreJournal,
  phase: RestoreJournalPhase,
  patch: Partial<Pick<HubRestoreJournal, "stageGeneration" | "rollbackGeneration">> = {},
) {
  const next = { ...journal, ...patch, phase, updatedAt: new Date().toISOString() };
  const journalPath = hubRestoreJournalPath(journal.hubRoot);
  const currentAuthority = restoreJournalAuthorities.get(journal);
  if (!currentAuthority) {
    await currentHubBackupTestHooks()?.beforeRestoreJournalFirstCreate?.({ journalPath });
    await writeJsonExclusiveDurable(
      journalPath,
      next,
      "restore-journal",
      MAX_RESTORE_JOURNAL_BYTES,
    );
  } else {
    await updatePinnedJsonDurableInPlace(
      currentAuthority,
      next,
      ({ filePath }) => currentHubBackupTestHooks()?.beforeRestoreJournalUpdatePublish?.({
        journalPath: filePath,
        tempPath: `${filePath}.descriptor-update`,
      }),
    );
  }
  const persisted = await readRestoreJournal(journal.hubRoot);
  if (
    !persisted
    || persisted.operationToken !== next.operationToken
    || persisted.snapshotId !== next.snapshotId
    || persisted.phase !== next.phase
    || persisted.updatedAt !== next.updatedAt
    || (persisted.stageGeneration === null) !== (next.stageGeneration === null)
    || (persisted.stageGeneration && next.stageGeneration
      && !samePathGeneration(persisted.stageGeneration, next.stageGeneration))
    || (persisted.rollbackGeneration === null) !== (next.rollbackGeneration === null)
    || (persisted.rollbackGeneration && next.rollbackGeneration
      && !samePathGeneration(persisted.rollbackGeneration, next.rollbackGeneration))
  ) {
    throw await authorityChanged("Hub restore journal", journalPath, {
      journal: journalPath,
    });
  }
  return persisted;
}

async function removeRestoreStage(journal: HubRestoreJournal, observedStage: DirectoryAuthority) {
  const stagePath = observedStage.directoryPath;
  const journalPath = hubRestoreJournalPath(journal.hubRoot);
  const recoveryPaths = { stage: stagePath, journal: journalPath, parent: path.dirname(stagePath) };
  await repinRestoreJournal(journal);
  await repinDirectoryAuthority(observedStage, "Hub restore stage", recoveryPaths);
  await currentHubBackupTestHooks()?.beforeRestoreStageRemoval?.({
    stagePath,
    journalPath,
  });
  await repinRestoreJournal(journal);
  await repinDirectoryAuthority(observedStage, "Hub restore stage", recoveryPaths);
  const isolated = await isolateDirectoryPreserveOnly({
    authority: observedStage,
    label: "Hub restore stage",
    quarantineLabel: "restore-stage-quarantine",
    recoveryPaths,
    syncOperation: "restore-stage-quarantine",
    committedCode: "HUB_RESTORE_STAGE_REMOVE_COMMITTED_AMBIGUOUS",
    beforeRename: ({ stagePath: currentStagePath, quarantinePath }) => currentHubBackupTestHooks()?.beforeRestoreStageIsolation?.({
      stagePath: currentStagePath,
      journalPath,
      quarantinePath,
    }),
    afterRename: ({ stagePath: currentStagePath, quarantinePath }) => currentHubBackupTestHooks()?.afterRestoreStageIsolation?.({
      stagePath: currentStagePath,
      journalPath,
      quarantinePath,
    }),
    beforeFinalCheck: ({ stagePath: currentStagePath, quarantinePath }) => currentHubBackupTestHooks()?.beforeRestoreStageFinalCheck?.({
      stagePath: currentStagePath,
      journalPath,
      quarantinePath,
    }),
  });
  await finishRetainedDirectoryIsolation({
    evidence: isolated,
    label: "Hub restore stage",
    committedCode: "HUB_RESTORE_STAGE_REMOVE_COMMITTED_AMBIGUOUS",
    stagePath,
    recoveryPaths,
    forcedAttemptedPaths: [journalPath],
    operation: async () => {
      await currentHubBackupTestHooks()?.beforeRestoreJournalCleanupAfterStageIsolation?.({
        stagePath,
        journalPath,
        quarantinePath: isolated.quarantinePath,
      });
      await removeRestoreJournal(journal);
      await currentHubBackupTestHooks()?.afterRestoreJournalCleanupAfterStageIsolation?.({
        stagePath,
        journalPath,
        quarantinePath: isolated.quarantinePath,
      });
    },
  });
}

async function verifyRestoredTarget(journal: HubRestoreJournal, signingKey?: string) {
  const verified = await verifyHubBackup(journal.input, {
    signingKey,
    requireSignature: journal.signatureRequired,
    allowUnsignedDev: !journal.signatureRequired,
  });
  if (verified.manifest.snapshotId !== journal.snapshotId) {
    throw new Error(`restore journal snapshot mismatch: expected ${journal.snapshotId}`);
  }
  const root = verified.manifest.roots[0];
  await verifySnapshotRoot(
    journal.targetPath,
    root,
    verified.manifest.entries.filter((entry) => entry.rootId === root.id),
  );
}

async function successorPreservedError(
  journal: HubRestoreJournal,
  reason: unknown,
  candidates: Record<string, string> = {
    canonical: journal.targetPath,
    ...(journal.rollbackPath ? { rollback: journal.rollbackPath } : {}),
  },
) {
  const metadata = await recoveryMetadata(candidates);
  return Object.assign(new Error(
    `Hub restore preserved a canonical successor and rollback state: ${journal.targetPath}`,
    { cause: reason },
  ), {
    code: "HUB_RESTORE_SUCCESSOR_PRESERVED",
    committed: false,
    committedPath: null,
    ...metadata,
    successorPreserved: true,
  });
}

async function restoreGenerationMismatchError(
  journal: HubRestoreJournal,
  label: "stage" | "rollback" | "canonical",
  candidatePath: string,
  candidates = restoreRecoveryPaths(journal),
) {
  const metadata = await recoveryMetadata(
    Object.fromEntries(Object.entries(candidates).filter(([, value]) => value !== candidatePath)),
  );
  return Object.assign(new Error(`Hub restore ${label} generation is not bound to its journal: ${candidatePath}`), {
    code: "HUB_RESTORE_GENERATION_MISMATCH",
    committed: false,
    committedPath: null,
    successorPreserved: true,
    ...metadata,
    attemptedPaths: { ...metadata.attemptedPaths, [label]: candidatePath },
  });
}

function journalGenerationMatches(
  expected: PersistedPathGeneration | null,
  actual: DirectoryAuthority,
  acrossRename = false,
) {
  if (!expected) return false;
  return acrossRename
    ? samePathGenerationAcrossRename(expected, actual.generation)
    : samePathGeneration(expected, actual.generation);
}

async function preserveInvalidReplacement(journal: HubRestoreJournal, reason: unknown): Promise<never> {
  await repinRestoreJournal(journal);
  throw await successorPreservedError(journal, reason);
}

async function restoreRollbackToCanonical(journal: HubRestoreJournal, rollback: DirectoryAuthority) {
  const rollbackPath = rollback.directoryPath;
  const journalPath = hubRestoreJournalPath(journal.hubRoot);
  const recoveryPaths = { canonical: journal.targetPath, rollback: rollbackPath };
  if (!journalGenerationMatches(journal.rollbackGeneration, rollback)) {
    throw await restoreGenerationMismatchError(journal, "rollback", rollbackPath);
  }
  await currentHubBackupTestHooks()?.beforeRollbackRestore?.({
    canonicalPath: journal.targetPath,
    rollbackPath,
    journalPath,
  });
  await repinRestoreJournal(journal);
  await repinDirectoryAuthority(rollback, "Hub restore rollback", recoveryPaths);
  try {
    await moveDirectoryNoClobber(
      rollback,
      journal.targetPath,
      "Hub restore rollback",
      { ...recoveryPaths, journal: journalPath },
    );
  } catch (error) {
    if (errnoCode(error) === "HUB_BACKUP_SUCCESSOR_PRESERVED") {
      throw await successorPreservedError(journal, error, { ...recoveryPaths, ...recoveryPathsFromError(error) });
    }
    throw error;
  }
  try {
    await syncBackupDirectory(path.dirname(journal.targetPath), "rollback-restore");
  } catch (error) {
    throw Object.assign(new Error(`Hub rollback restore committed with ambiguous durability: ${journal.targetPath}`, { cause: error }), {
      code: "HUB_RESTORE_ROLLBACK_COMMITTED_AMBIGUOUS",
      committed: true,
      committedPath: journal.targetPath,
      ...(await recoveryMetadata({ canonical: journal.targetPath })),
    });
  }
}

async function moveRestoreTargetToRollback(
  journal: HubRestoreJournal,
  target: DirectoryAuthority,
  rollbackPath: string,
) {
  const journalPath = hubRestoreJournalPath(journal.hubRoot);
  const recoveryPaths = { target: journal.targetPath, rollback: rollbackPath, journal: journalPath };
  await currentHubBackupTestHooks()?.beforeRestoreTargetMove?.({ targetPath: journal.targetPath, rollbackPath, journalPath });
  await repinRestoreJournal(journal);
  await repinDirectoryAuthority(target, "Hub restore target", recoveryPaths);
  let moved: DirectoryAuthority;
  try {
    moved = await moveDirectoryNoClobber(
      target,
      rollbackPath,
      "Hub restore target",
      recoveryPaths,
    );
  } catch (error) {
    if (errnoCode(error) === "HUB_BACKUP_SUCCESSOR_PRESERVED") {
      throw await authorityChanged("Hub restore rollback destination", rollbackPath, {
        ...recoveryPaths,
        ...recoveryPathsFromError(error),
      });
    }
    throw error;
  }
  try {
    await syncBackupDirectory(path.dirname(journal.targetPath), "restore-target-move");
  } catch (error) {
    let journalUpdateError: unknown = null;
    try {
      await writeRestoreJournal(journal, "target_moved", {
        rollbackGeneration: persistPathGeneration(moved.generation),
      });
    } catch (caught) {
      journalUpdateError = caught;
    }
    const cause = journalUpdateError
      ? new AggregateError([error, journalUpdateError], "restore target move durability and journal update failed", {
        cause: error,
      })
      : error;
    throw Object.assign(new Error(`Hub restore target move committed with ambiguous durability: ${rollbackPath}`, { cause: error }), {
      code: "HUB_RESTORE_TARGET_MOVE_COMMITTED_AMBIGUOUS",
      committed: true,
      committedPath: rollbackPath,
      ...(await recoveryMetadata({ rollback: rollbackPath, journal: journalPath })),
      cause,
    });
  }
  return moved;
}

async function publishRestoreStage(
  journal: HubRestoreJournal,
  stage: DirectoryAuthority,
) {
  const journalPath = hubRestoreJournalPath(journal.hubRoot);
  const recoveryPaths = {
    canonical: journal.targetPath,
    stage: stage.directoryPath,
    journal: journalPath,
    ...(journal.rollbackPath ? { rollback: journal.rollbackPath } : {}),
  };
  if (!journalGenerationMatches(journal.stageGeneration, stage)) {
    throw await restoreGenerationMismatchError(journal, "stage", stage.directoryPath);
  }
  await currentHubBackupTestHooks()?.beforeRestoreStagePublish?.({
    canonicalPath: journal.targetPath,
    stagePath: stage.directoryPath,
    journalPath,
  });
  await repinRestoreJournal(journal);
  await repinDirectoryAuthority(stage, "Hub restore stage", recoveryPaths);
  try {
    await moveDirectoryNoClobber(
      stage,
      journal.targetPath,
      "Hub restore stage",
      recoveryPaths,
    );
  } catch (error) {
    if (errnoCode(error) === "HUB_BACKUP_SUCCESSOR_PRESERVED") {
      throw await successorPreservedError(journal, error, {
        ...recoveryPaths,
        ...recoveryPathsFromError(error),
      });
    }
    throw error;
  }
  try {
    await syncBackupDirectory(path.dirname(journal.targetPath), "restore-stage-publish");
  } catch (error) {
    throw Object.assign(new Error(`Hub restore stage publish committed with ambiguous durability: ${journal.targetPath}`, { cause: error }), {
      code: "HUB_RESTORE_STAGE_PUBLISH_COMMITTED_AMBIGUOUS",
      committed: true,
      committedPath: journal.targetPath,
      ...(await recoveryMetadata({
        canonical: journal.targetPath,
        journal: journalPath,
        ...(journal.rollbackPath ? { rollback: journal.rollbackPath } : {}),
      })),
    });
  }
}

async function recoverRestoreJournalCore(
  journal: HubRestoreJournal,
  signingKey: string | undefined,
  redisSession: RedisRestoreRecoverySession | null,
) {
  const target = await readOptionalDirectoryAuthority(journal.targetPath, "interrupted restore target");
  const stage = await readOptionalDirectoryAuthority(journal.stagePath, "interrupted restore stage");
  const rollback = journal.rollbackPath
    ? await readOptionalDirectoryAuthority(journal.rollbackPath, "interrupted restore rollback")
    : null;

  if (stage && !journalGenerationMatches(journal.stageGeneration, stage)) {
    throw await restoreGenerationMismatchError(journal, "stage", journal.stagePath);
  }
  if (rollback && !journalGenerationMatches(journal.rollbackGeneration, rollback)) {
    throw await restoreGenerationMismatchError(journal, "rollback", rollback.directoryPath);
  }
  if (
    target
    && !stage
    && (journal.phase === "target_moved" || journal.phase === "committed")
    && !journalGenerationMatches(journal.stageGeneration, target, true)
  ) {
    throw await restoreGenerationMismatchError(journal, "canonical", journal.targetPath);
  }

  if (journal.phase === "staged" || journal.phase === "redis_restoring" || journal.phase === "redis_restored") {
    if (journal.phase !== "staged" && redisSession) {
      await applyRedisRecoverySnapshot(journal, redisSession, "rollback");
    }
    if (journal.targetExisted && target && rollback) {
      throw await successorPreservedError(journal, new Error("staged restore has both canonical and rollback roots"));
    }
    if (journal.targetExisted && !target) {
      if (!rollback) {
        throw new Error("interrupted restore lost both the target and rollback root");
      }
      await restoreRollbackToCanonical(journal, rollback);
    } else if (!journal.targetExisted && target) {
      throw new Error("interrupted restore journal says the target was absent but a target now exists");
    }
    if (stage) await removeRestoreStage(journal, stage);
    else await removeRestoreJournal(journal);
    return { recovered: true, outcome: "rolled_back" as const, snapshotId: journal.snapshotId };
  }

  if (journal.phase === "target_moved") {
    if (target && !stage) {
      if (journal.targetExisted && !rollback) {
        throw new Error("committed replacement exists but its required rollback root is missing");
      }
      try {
        await verifyRestoredTarget(journal, signingKey);
        if (redisSession) await applyRedisRecoverySnapshot(journal, redisSession, "target");
      } catch (error) {
        if (redisSession) await applyRedisRecoverySnapshot(journal, redisSession, "rollback");
        return preserveInvalidReplacement(journal, error);
      }
      const committed = await writeRestoreJournal(journal, "committed");
      await removeRestoreJournal(committed);
      return { recovered: true, outcome: "committed" as const, snapshotId: journal.snapshotId };
    }
    if (target && stage) {
      throw await successorPreservedError(journal, new Error("interrupted restore has both a canonical target and uncommitted stage"));
    }
    if (journal.targetExisted) {
      if (!rollback) {
        throw new Error("interrupted restore cannot reapply the missing rollback root");
      }
      await restoreRollbackToCanonical(journal, rollback);
    }
    if (redisSession) await applyRedisRecoverySnapshot(journal, redisSession, "rollback");
    if (stage) await removeRestoreStage(journal, stage);
    else await removeRestoreJournal(journal);
    return { recovered: true, outcome: "rolled_back" as const, snapshotId: journal.snapshotId };
  }

  if (!target || stage) {
    throw new Error("committed restore journal does not match the filesystem state");
  }
  if (journal.targetExisted && !rollback) {
    throw new Error("committed restore journal is missing its required rollback root");
  }
  try {
    await verifyRestoredTarget(journal, signingKey);
    if (redisSession) await applyRedisRecoverySnapshot(journal, redisSession, "target");
  } catch (error) {
    if (redisSession) await applyRedisRecoverySnapshot(journal, redisSession, "rollback");
    return preserveInvalidReplacement(journal, error);
  }
  await removeRestoreJournal(journal);
  return { recovered: true, outcome: "committed" as const, snapshotId: journal.snapshotId };
}

async function recoverRestoreJournalUnlocked(
  journal: HubRestoreJournal,
  signingKey?: string,
  onRedisMaintenanceReleased?: () => void,
) {
  let redisSession: RedisRestoreRecoverySession | null;
  try {
    redisSession = await openRedisRestoreRecoverySession(journal, signingKey);
  } catch (error) {
    if (journal.phase === "committed") {
      throw await committedAmbiguityError({
        code: "HUB_RESTORE_COMMITTED_AMBIGUOUS",
        message: `Hub restore is committed but Redis recovery could not start: ${journal.targetPath}`,
        committedPath: journal.targetPath,
        recoveryPaths: restoreRecoveryPaths(journal),
        cause: error,
      });
    }
    throw error;
  }
  let result: Awaited<ReturnType<typeof recoverRestoreJournalCore>>;
  try {
    result = await recoverRestoreJournalCore(journal, signingKey, redisSession);
  } catch (error) {
    if (journal.phase === "committed" && !isExplicitlyUncommitted(error)) {
      throw await committedAmbiguityError({
        code: "HUB_RESTORE_COMMITTED_AMBIGUOUS",
        message: `Hub restore journal is committed but filesystem recovery failed: ${journal.targetPath}`,
        committedPath: journal.targetPath,
        recoveryPaths: restoreRecoveryPaths(journal),
        cause: error,
      });
    }
    throw error;
  }
  try {
    const redisMaintenanceReleased = await finishRedisRestoreRecovery(journal, redisSession);
    if (redisMaintenanceReleased) onRedisMaintenanceReleased?.();
  } catch (error) {
    if (result.outcome === "committed") {
      throw await committedAmbiguityError({
        code: "HUB_RESTORE_COMMITTED_AMBIGUOUS",
        message: `Hub restore recovery committed but Redis finalization failed: ${journal.targetPath}`,
        committedPath: journal.targetPath,
        recoveryPaths: { ...restoreRecoveryPaths(journal), ...recoveryPathsFromError(error) },
        cause: error,
      });
    }
    throw Object.assign(await incompleteCleanupError({
      code: "HUB_RESTORE_RECOVERY_CLEANUP_FAILED",
      message: `Hub restore rollback completed but Redis finalization failed: ${journal.targetPath}`,
      recoveryPaths: { ...restoreRecoveryPaths(journal), ...recoveryPathsFromError(error) },
      primaryError: null,
      cleanupErrors: [error],
    }), { recoveryOutcome: "rolled_back" as const });
  }
  return result;
}

async function restoreHubBackupUnlocked({
  cpbRoot,
  hubRoot,
  input,
  force = false,
  signingKey,
  requireSignature = false,
  allowUnsignedDev = false,
  minimumFreeBytes,
  redisBackend = null,
  redisToken = null,
  maintenanceToken = null,
  faultInjector,
}: RestoreHubBackupOptions, onRedisMaintenanceReleased?: () => void) {
  const verified = await verifyHubBackup(input, { signingKey, requireSignature, allowUnsignedDev });
  const targetRedisSnapshot = await redisSnapshotFromVerifiedBackup(verified);
  if (redisBackend && (!targetRedisSnapshot || !redisToken)) {
    throw Object.assign(new Error("Redis-aware Hub restore requires an embedded logical snapshot and maintenance token"), {
      code: "HUB_RESTORE_REDIS_SNAPSHOT_REQUIRED",
    });
  }
  if (!redisBackend && targetRedisSnapshot) {
    throw Object.assign(new Error("Redis-backed Hub backup requires Redis configuration during restore"), {
      code: "HUB_RESTORE_REDIS_CONFIGURATION_REQUIRED",
    });
  }
  if (redisBackend && targetRedisSnapshot
    && targetRedisSnapshot.backendIdentityFingerprint !== redisBackend.identityFingerprint) {
    throw Object.assign(new Error("Redis restore target identity does not match the backup"), {
      code: "HUB_STATE_BACKEND_IDENTITY_CHANGED",
    });
  }
  const resolvedHubRoot = path.resolve(hubRoot);
  if (isWithin(resolvedHubRoot, verified.backupRoot) || isWithin(verified.backupRoot, resolvedHubRoot)) {
    throw new Error(`backup input and restore target must not overlap: ${resolvedHubRoot}`);
  }
  const root = verified.manifest.roots[0];
  const currentRuntimeRoots = (await listProjects(resolvedHubRoot))
    .map((project) => recordValue(project).projectRuntimeRoot)
    .filter((value): value is string => typeof value === "string")
    .map((value) => path.resolve(value));
  await assertHubBackupOffline(
    cpbRoot,
    resolvedHubRoot,
    currentRuntimeRoots,
    redisBackend,
  );

  const targetExisted = await pathExists(resolvedHubRoot);
  const initialTarget = targetExisted
    ? await readDirectoryAuthority(resolvedHubRoot, "restore target")
    : null;
  if (targetExisted && !force) throw new Error("restore would replace 1 existing root(s); rerun with --force");

  const parent = path.dirname(resolvedHubRoot);
  await mkdir(parent, { recursive: true });
  await assertCopySpaceAvailable({
    directory: parent,
    operation: "Hub restore",
    payloadBytes: BigInt(verified.manifest.totalBytes),
    entryCount: verified.manifest.entries.length,
    minimumFreeBytes,
  });
  const stagePath = `${restoreStagePrefix(resolvedHubRoot)}${randomUUID()}`;
  const rollbackPath = targetExisted ? `${restoreRollbackPrefix(resolvedHubRoot)}${Date.now()}-${randomUUID()}` : null;
  const dataRoots = path.join(verified.backupRoot, "data", "roots");
  let rollbackRedisSnapshot: RedisLogicalSnapshot | null = null;
  let redisRollbackPath: string | null = null;
  let redisRollbackAuthority: FileAuthority | null = null;
  if (redisBackend && redisToken && targetRedisSnapshot) {
    rollbackRedisSnapshot = await redisBackend.exportSnapshot(redisToken);
    redisRollbackPath = `${redisRestoreRollbackPrefix(resolvedHubRoot)}${verified.manifest.snapshotId}-${randomUUID()}.json`;
    await writeJsonDurableAtomic(redisRollbackPath, rollbackRedisSnapshot);
    redisRollbackAuthority = (await readPinnedMetadata(
      redisRollbackPath,
      MAX_REDIS_SNAPSHOT_BYTES,
      "redis-rollback",
    )).authority;
  }
  let journal: HubRestoreJournal = {
    format: "cpb-hub-restore/v1",
    operationToken: randomUUID(),
    snapshotId: verified.manifest.snapshotId,
    input: verified.backupRoot,
    hubRoot: resolvedHubRoot,
    targetPath: resolvedHubRoot,
    stagePath,
    stageGeneration: null,
    rollbackPath,
    rollbackGeneration: null,
    targetExisted,
    signatureRequired: !allowUnsignedDev || requireSignature || Boolean(normalizeSigningKey(signingKey)),
    maintenanceToken,
    redis: redisBackend && redisToken && targetRedisSnapshot && rollbackRedisSnapshot && redisRollbackPath ? {
      backendIdentityFingerprint: redisBackend.identityFingerprint,
      maintenanceToken: redisToken,
      rollbackSnapshotPath: redisRollbackPath,
      rollbackLogicalSha256: rollbackRedisSnapshot.sha256,
      targetLogicalSha256: targetRedisSnapshot.sha256,
    } : null,
    phase: "staged",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  let journalCreated = false;
  let stagedRoot: DirectoryAuthority | null = null;
  let restoreCommitted = false;
  const result = () => ({
    input: verified.backupRoot,
    snapshotId: verified.manifest.snapshotId,
    restoredRoots: [{
      id: root.id,
      projectId: root.projectId || null,
      targetPath: resolvedHubRoot,
      rollbackPath,
    }],
  });
  try {
    journal = await writeRestoreJournal(journal, "staged");
    journalCreated = true;
    await copyBackupRoot(
      path.join(dataRoots, root.id),
      stagePath,
      root,
      verified.manifest.entries.filter((entry) => entry.rootId === root.id),
    );
    stagedRoot = await readDirectoryAuthority(stagePath, "Hub restore stage");
    journal = await writeRestoreJournal(journal, "staged", {
      stageGeneration: persistPathGeneration(stagedRoot.generation),
    });

    if (redisBackend && redisToken && targetRedisSnapshot) {
      journal = await writeRestoreJournal(journal, "redis_restoring");
      await faultInjector?.("redis_before_commit");
      await redisBackend.restoreSnapshot(redisToken, targetRedisSnapshot);
      await faultInjector?.("redis_after_commit");
      journal = await writeRestoreJournal(journal, "redis_restored");
    }

    if (targetExisted && rollbackPath && initialTarget) {
      const movedRollback = await moveRestoreTargetToRollback(journal, initialTarget, rollbackPath);
      journal = await writeRestoreJournal(journal, "target_moved", {
        rollbackGeneration: persistPathGeneration(movedRollback.generation),
      });
    } else {
      journal = await writeRestoreJournal(journal, "target_moved");
    }

    if (!stagedRoot) throw new Error("Hub restore stage authority is unavailable before publication");
    await publishRestoreStage(journal, stagedRoot);
    restoreCommitted = true;
    await faultInjector?.("filesystem_after_target_rename");
    journal = await writeRestoreJournal(journal, "committed");
    await removeRestoreJournal(journal);
    if (redisRollbackPath && redisRollbackAuthority) {
      await isolatePinnedFilePreserveOnly(
        redisRollbackAuthority,
        "Hub Redis rollback snapshot",
        { rollbackSnapshot: redisRollbackPath },
      );
    }
    return result();
  } catch (error) {
    const publicationCommitted = restoreCommitted || isRestorePublicationCommitted(error, resolvedHubRoot);
    let rolledBackJournal: HubRestoreJournal | null = null;
    if (journalCreated) {
      try {
        const authoritative = await readRestoreJournal(resolvedHubRoot);
        if (!authoritative) throw new Error("restore journal disappeared during recovery");
        const recovery = await recoverRestoreJournalUnlocked(
          authoritative,
          signingKey,
          onRedisMaintenanceReleased,
        );
        if (recovery.outcome === "committed") return result();
        rolledBackJournal = authoritative;
      } catch (recoveryError) {
        const cause = new AggregateError(
          [error, recoveryError],
          `Hub restore failed and automatic recovery is incomplete; inspect ${hubRestoreJournalPath(resolvedHubRoot)}`,
          { cause: error },
        );
        if (isExplicitlyUncommitted(recoveryError)) {
          const metadata = await recoveryMetadata({
            ...restoreRecoveryPaths(journal),
            ...recoveryPathsFromError(recoveryError),
          });
          throw Object.assign(cause, {
            code: errnoCode(recoveryError) || "HUB_RESTORE_RECOVERY_CLEANUP_FAILED",
            committed: false,
            committedPath: null,
            recoveryOutcome: "rolled_back" as const,
            primaryError: error,
            recoveryError,
            cleanupErrors: recoveryError && typeof recoveryError === "object" && "cleanupErrors" in recoveryError
              ? (recoveryError as { cleanupErrors?: unknown }).cleanupErrors
              : [recoveryError],
            ...metadata,
          });
        }
        if (publicationCommitted || isRestorePublicationCommitted(recoveryError, resolvedHubRoot)) {
          throw await committedAmbiguityError({
            code: "HUB_RESTORE_COMMITTED_AMBIGUOUS",
            message: `Hub restore target is committed but automatic finalization is incomplete: ${resolvedHubRoot}`,
            committedPath: resolvedHubRoot,
            recoveryPaths: restoreRecoveryPaths(journal),
            cause,
          });
        }
        throw cause;
      }
      if (rolledBackJournal) {
        const metadata = await recoveryMetadata(restoreRecoveryPaths(rolledBackJournal));
        const primaryMessage = error instanceof Error ? error.message : String(error);
        throw Object.assign(new Error(`Hub restore failed (${primaryMessage}) and automatic recovery rolled back the target: ${resolvedHubRoot}`, {
          cause: error,
        }), {
          code: "HUB_RESTORE_FAILED_ROLLED_BACK",
          committed: false,
          committedPath: null,
          recoveryOutcome: "rolled_back" as const,
          primaryError: error,
          ...metadata,
        });
      }
    } else {
      if (redisRollbackPath && redisRollbackAuthority) {
        try {
          await isolatePinnedFilePreserveOnly(
            redisRollbackAuthority,
            "Hub Redis rollback snapshot",
            { rollbackSnapshot: redisRollbackPath },
          );
        } catch (cleanupError) {
          throw await incompleteCleanupError({
            code: "HUB_RESTORE_CLEANUP_FAILED",
            message: `Hub restore failed before journaling and Redis rollback cleanup is incomplete: ${resolvedHubRoot}`,
            recoveryPaths: { canonical: resolvedHubRoot, rollbackSnapshot: redisRollbackPath },
            primaryError: error,
            cleanupErrors: [cleanupError],
          });
        }
      }
    }
    if (publicationCommitted) {
      throw await committedAmbiguityError({
        code: "HUB_RESTORE_COMMITTED_AMBIGUOUS",
        message: `Hub restore target is committed but finalization failed: ${resolvedHubRoot}`,
        committedPath: resolvedHubRoot,
        recoveryPaths: restoreRecoveryPaths(journal),
        cause: error,
      });
    }
    throw error;
  }
}

export async function recoverInterruptedHubRestore({
  hubRoot,
  signingKey,
}: {
  hubRoot: string;
  signingKey?: string;
}) {
  const resolvedHubRoot = path.resolve(hubRoot);
  const pending = await readRestoreJournal(resolvedHubRoot);
  if (!pending) {
    await recoverStaleHubMaintenance(resolvedHubRoot);
    await cleanRedisLogicalSnapshotArtifacts(resolvedHubRoot);
    return { recovered: false as const };
  }
  const maintenance = await acquireHubMaintenance(resolvedHubRoot, "Hub restore recovery", {
    allowRestoreJournal: true,
  });
  let result: Awaited<ReturnType<typeof recoverRestoreJournalUnlocked>> | { recovered: false } | null = null;
  let operationError: unknown = null;
  let committedPath: string | null = pending.phase === "committed" ? resolvedHubRoot : null;
  try {
    const authoritative = await readRestoreJournal(resolvedHubRoot);
    if (!authoritative) {
      result = { recovered: false as const };
    } else {
      result = await recoverRestoreJournalUnlocked(authoritative, signingKey);
      if (result.outcome === "committed") committedPath = resolvedHubRoot;
    }
  } catch (error) {
    operationError = error;
    if (hasCommittedMetadata(error)) committedPath = error.committedPath;
  }
  let releaseError: unknown = null;
  try {
    if (!(await maintenance.release())) {
      throw new Error(`Hub restore recovery lost maintenance lock ownership: ${maintenance.lockPath}`);
    }
  } catch (error) {
    releaseError = error;
  }
  if (releaseError) {
    const recoveryPaths = {
      ...recoveryPathsFromError(operationError),
      ...restoreRecoveryPaths(pending),
      maintenance: maintenance.lockPath,
    };
    const cause = operationError
      ? new AggregateError([operationError, releaseError], "Hub restore recovery and maintenance release both failed", {
        cause: operationError,
      })
      : releaseError;
    if (committedPath) {
      throw await committedAmbiguityError({
        code: "HUB_RESTORE_COMMITTED_AMBIGUOUS",
        message: `Hub restore recovery committed but maintenance release failed: ${committedPath}`,
        committedPath,
        recoveryPaths,
        cause,
      });
    }
    throw await incompleteCleanupError({
      code: "HUB_RESTORE_RECOVERY_CLEANUP_FAILED",
      message: `Hub restore recovery maintenance release failed: ${resolvedHubRoot}`,
      recoveryPaths,
      primaryError: operationError,
      cleanupErrors: [releaseError],
    });
  }
  if (operationError) {
    if (committedPath && !hasCommittedMetadata(operationError) && !isExplicitlyUncommitted(operationError)) {
      throw await committedAmbiguityError({
        code: "HUB_RESTORE_COMMITTED_AMBIGUOUS",
        message: `Hub restore recovery is committed but failed before finalization: ${committedPath}`,
        committedPath,
        recoveryPaths: {
          ...restoreRecoveryPaths(pending),
          maintenance: maintenance.lockPath,
        },
        cause: operationError,
      });
    }
    throw operationError;
  }
  if (!result) throw new Error("Hub restore recovery completed without a result");
  return result;
}

export async function restoreHubBackup(options: RestoreHubBackupOptions) {
  const redis = await openPinnedHubRedisStateBackend({
    configFile: process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE,
    hubRoot: options.hubRoot,
  });
  const resolvedHubRoot = path.resolve(options.hubRoot);
  const resolvedInput = path.resolve(options.input);
  if (isWithin(resolvedHubRoot, resolvedInput) || isWithin(resolvedInput, resolvedHubRoot)) {
    throw new Error(`backup input and restore target must not overlap: ${resolvedHubRoot}`);
  }
  await recoverInterruptedHubRestore({ hubRoot: resolvedHubRoot, signingKey: options.signingKey });
  const maintenance = await acquireHubMaintenance(options.hubRoot, "Hub restore");
  const redisToken = redis ? `restore-${randomUUID()}` : null;
  let redisOwned = false;
  let result: Awaited<ReturnType<typeof restoreHubBackupUnlocked>> | null = null;
  let operationError: unknown = null;
  let committedPath: string | null = null;
  try {
    if (redis && redisToken) {
      const acquired = await redis.acquireMaintenance(redisToken, "Hub restore", 3_600_000);
      if (!acquired.acquired) {
        throw Object.assign(new Error("another Hub Redis maintenance operation is active"), { code: "HUB_MAINTENANCE_ACTIVE" });
      }
      redisOwned = true;
    }
    result = await restoreHubBackupUnlocked({
      ...options,
      redisBackend: redis,
      redisToken,
      maintenanceToken: maintenance.owner.ownerToken,
    }, () => {
      redisOwned = false;
    });
    committedPath = resolvedHubRoot;
  } catch (error) {
    operationError = error;
    if (hasCommittedMetadata(error)) committedPath = error.committedPath;
  }

  const cleanupErrors: unknown[] = [];
  if (redis && redisToken && redisOwned) {
    try {
      const journalPresent = await pathExists(hubRestoreJournalPath(resolvedHubRoot));
      if (journalPresent && committedPath) {
        throw new Error("Hub restore committed while its recovery journal path remains occupied; Redis maintenance is retained");
      }
      if (!journalPresent) {
        const status = await redis.readMaintenance();
        if (!status.active || status.token !== redisToken || !(await redis.releaseMaintenance(redisToken))) {
          throw new Error("Hub restore lost Redis maintenance lock ownership");
        }
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    if (!(await maintenance.release())) {
      throw new Error(`Hub restore lost maintenance lock ownership: ${maintenance.lockPath}`);
    }
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (cleanupErrors.length > 0) {
    const recoveryPaths = {
      ...recoveryPathsFromError(operationError),
      canonical: resolvedHubRoot,
      input: resolvedInput,
      journal: hubRestoreJournalPath(resolvedHubRoot),
      maintenance: maintenance.lockPath,
      ...(result?.restoredRoots[0]?.rollbackPath
        ? { rollback: String(result.restoredRoots[0].rollbackPath) }
        : {}),
    };
    const cause = operationError
      ? new AggregateError([operationError, ...cleanupErrors], "Hub restore operation and finalization both failed", {
        cause: operationError,
      })
      : cleanupErrors.length === 1
        ? cleanupErrors[0]
        : new AggregateError(cleanupErrors, "Hub restore finalization failed", { cause: cleanupErrors[0] });
    if (committedPath) {
      throw await committedAmbiguityError({
        code: "HUB_RESTORE_COMMITTED_AMBIGUOUS",
        message: `Hub restore is committed but lease finalization failed: ${committedPath}`,
        committedPath,
        recoveryPaths,
        cause,
      });
    }
    throw await incompleteCleanupError({
      code: "HUB_RESTORE_CLEANUP_FAILED",
      message: `Hub restore failed and lease finalization is incomplete: ${resolvedHubRoot}`,
      recoveryPaths,
      primaryError: operationError,
      cleanupErrors,
    });
  }
  if (operationError) throw operationError;
  if (!result) throw new Error("Hub restore completed without a result");
  return result;
}
