import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { constants, lstatSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import {
  readBoundedRegularFileNoFollow,
  type BoundedRegularFileReadHooks,
} from "../runtime/durable-directory-lock.js";
import type { LooseRecord } from "../../shared/types.js";
import {
  resolveArtifactDir,
  resolveArtifactDirForRoot,
  resolveArtifactPath,
  resolveArtifactPathForRoot,
} from "./artifact-paths.js";

type ArtifactWriteInput = {
  project: string;
  jobId: string;
  kind: string;
  content: string;
  metadata?: LooseRecord;
  dataRoot?: string;
  signal?: AbortSignal;
};

type ArtifactHookContext = {
  path: string;
  lockDir: string;
};

export type ArtifactStoreTestHooks = {
  writeOwnerFile?: (context: ArtifactHookContext & { ownerPath: string; content: string }) => void | Promise<void>;
  createTempSuffix?: (context: ArtifactHookContext) => string;
  afterReservation?: (context: ArtifactHookContext) => void | Promise<void>;
  afterTempWrite?: (context: ArtifactHookContext & { tempPath: string }) => void | Promise<void>;
  afterFinalLink?: (context: ArtifactHookContext & { tempPath: string }) => void | Promise<void>;
  beforeDiscardCleanup?: (context: ArtifactHookContext & { tempPath: string }) => void | Promise<void>;
  afterLockQuarantineRename?: (
    context: { lockDir: string; quarantineDir: string },
  ) => void | Promise<void>;
  afterLockOwnerValidation?: (
    context: { lockDir: string; quarantineDir: string; ownerPath: string },
  ) => void | Promise<void>;
  afterTempIsolationRename?: (
    context: { tempPath: string; isolatedPath: string },
  ) => void | Promise<void>;
  beforeTempUnlink?: (
    context: { tempPath: string; isolatedPath: string },
  ) => void | Promise<void>;
  ownerReadHooks?: BoundedRegularFileReadHooks;
  syncFile?: (filePath: string, phase: ArtifactFileFsPhase) => void | Promise<void>;
  syncLockDirectory?: (directory: string, phase: ArtifactFsPhase) => void | Promise<void>;
};

type ArtifactFileFsPhase = "reservation-owner" | "temp-write";

type ArtifactFsPhase =
  | "reservation-mkdir"
  | "reservation-owner"
  | "artifact-link"
  | "temp-isolate"
  | "temp-remove"
  | "quarantine-rename"
  | "remove";

const ARTIFACT_LOCK_OWNER_MAX_BYTES = 64 * 1024;
const ARTIFACT_KIND_MAX_LENGTH = 64;
const ARTIFACT_KIND_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

const artifactStoreTestHookContext = new AsyncLocalStorage<ArtifactStoreTestHooks>();

/**
 * Install hooks for one async call tree. Unlike a mutable module singleton,
 * AsyncLocalStorage keeps concurrent test runs isolated from one another.
 */
export function withArtifactStoreTestHooks<T>(
  hooks: ArtifactStoreTestHooks,
  action: () => T,
): T {
  return artifactStoreTestHookContext.run(hooks, action);
}

type ArtifactReservation = {
  id: string;
  artifactDir: string;
  filePath: string;
  lockDir: string;
  ownerToken: string;
  lockIdentity: ArtifactLockIdentity | null;
};

type ArtifactLockIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
};

type ArtifactPathIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
};

type ArtifactLockOwner = {
  ownerToken: string;
  pid: number;
  createdAt: string;
};

type ArtifactRecord = {
  kind: string;
  id: string;
  name: string;
  path: string;
  bytes: number;
  sha256: string;
  metadata: LooseRecord;
};

export type ArtifactCommitOutcome = {
  committed: true;
  artifact: ArtifactRecord;
  cleanupPending: boolean;
  commitWarnings: unknown[];
  retryCleanup: () => Promise<ArtifactRecord | ArtifactCommitOutcome>;
};

export type ArtifactWriteResult = ArtifactRecord & {
  committed?: true;
  cleanupPending?: boolean;
  commitWarnings?: unknown[];
  retryCleanup?: () => Promise<ArtifactRecord | ArtifactCommitOutcome>;
};

type PreparedArtifactState =
  | "prepared"
  | "committed_cleanup_pending"
  | "committed"
  | "discard_cleanup_pending"
  | "discarded";

function assertValidArtifactKind(kind: unknown): asserts kind is string {
  if (typeof kind === "string"
    && kind.length <= ARTIFACT_KIND_MAX_LENGTH
    && ARTIFACT_KIND_PATTERN.test(kind)) {
    return;
  }
  throw Object.assign(
    new Error(
      "invalid artifact kind: expected 1-64 lowercase ASCII characters starting with a letter, "
      + "with alphanumeric segments separated only by single hyphens or underscores",
    ),
    { code: "ARTIFACT_KIND_INVALID" },
  );
}

function assertArtifactDirectChildPath(
  artifactDir: string,
  candidatePath: string,
  role: "final" | "lock" | "temp",
) {
  const resolvedArtifactDir = path.resolve(artifactDir);
  const resolvedCandidatePath = path.resolve(candidatePath);
  if (path.dirname(resolvedCandidatePath) === resolvedArtifactDir) return candidatePath;
  throw Object.assign(
    new Error(`artifact ${role} path escapes its authoritative directory`),
    {
      code: "ARTIFACT_PATH_OUTSIDE_DIRECTORY",
      artifactDirectory: resolvedArtifactDir,
      artifactPath: resolvedCandidatePath,
    },
  );
}

export async function prepareArtifactWrite(
  cpbRoot: string,
  { project, jobId, kind, content, metadata = {}, dataRoot, signal }: ArtifactWriteInput,
) {
  assertValidArtifactKind(kind);
  throwIfAborted(signal);
  const hooks = artifactStoreTestHookContext.getStore() || {};
  const reservation = await allocateArtifactReservation(cpbRoot, project, kind, { dataRoot, hooks });
  let tempPath: string | undefined;
  try {
    const tempSuffix = hooks.createTempSuffix
      ? hooks.createTempSuffix({ path: reservation.filePath, lockDir: reservation.lockDir })
      : crypto.randomBytes(6).toString("hex");
    tempPath = assertArtifactDirectChildPath(
      reservation.artifactDir,
      path.join(
        reservation.artifactDir,
        `.${kind}-${reservation.id}.${process.pid}.${tempSuffix}.tmp`,
      ),
      "temp",
    );
    await hooks.afterReservation?.({ path: reservation.filePath, lockDir: reservation.lockDir });
    throwIfAborted(signal);
    const artifact = {
      kind,
      id: reservation.id,
      name: `${kind}-${reservation.id}`,
      path: reservation.filePath,
      bytes: Buffer.byteLength(content, "utf8"),
      sha256: sha256(content),
      metadata: { ...metadata, project, jobId, kind },
    };
    return createPreparedArtifact({ artifact, content, tempPath, reservation, signal, hooks });
  } catch (error) {
    await cleanupReservation(
      tempPath,
      null,
      reservation.lockDir,
      reservation.ownerToken,
      reservation.lockIdentity,
      error,
      hooks,
    );
    throw error;
  }
}

function createPreparedArtifact({
  artifact,
  content,
  tempPath,
  reservation,
  signal,
  hooks,
}: {
  artifact: ArtifactRecord;
  content: string;
  tempPath: string;
  reservation: ArtifactReservation;
  signal?: AbortSignal;
  hooks: ArtifactStoreTestHooks;
}) {
  const { kind, id } = artifact;
  const { filePath, lockDir, ownerToken, lockIdentity } = reservation;
  let tempIdentity: ArtifactPathIdentity | null = null;
  let state: PreparedArtifactState = "prepared";
  let discardCause: unknown;
  let operation: {
    kind: "commit" | "discard";
    promise: Promise<unknown>;
    token: object;
  } | null = null;
  let publicationDurabilityPending = false;
  let reservationCleanupPending = true;

  function discardedError() {
    const error = new Error(`artifact reservation ${kind}-${id} was discarded`);
    (error as Error & { cause?: unknown }).cause = discardCause;
    return error;
  }

  function startOperation<T>(kind: "commit" | "discard", action: () => Promise<T>): Promise<T> {
    const token = {};
    const promise = Promise.resolve().then(action);
    operation = { kind, promise, token };
    void promise.then(
      () => { if (operation?.token === token) operation = null; },
      () => { if (operation?.token === token) operation = null; },
    );
    return promise;
  }

  function committedOutcome(cleanupPending: boolean, commitWarnings: unknown[]): ArtifactCommitOutcome {
    return {
      committed: true,
      artifact,
      cleanupPending,
      commitWarnings,
      retryCleanup: commitArtifact,
    };
  }

  async function settleCommittedCleanup(commitWarnings: unknown[] = []): Promise<ArtifactRecord | ArtifactCommitOutcome> {
    const warnings = [...commitWarnings];
    if (publicationDurabilityPending) {
      try {
        await syncArtifactLockDirectory(path.dirname(filePath), "artifact-link", hooks);
        publicationDurabilityPending = false;
      } catch (error) {
        warnings.push(artifactCommittedDurabilityAmbiguity(
          "artifact hard link committed but parent directory durability is ambiguous",
          "ARTIFACT_LINK_COMMITTED_DURABILITY_AMBIGUOUS",
          filePath,
          [filePath, tempPath, path.dirname(filePath)],
          error,
        ));
      }
    }
    if (reservationCleanupPending) {
      try {
        await cleanupCommittedReservation(tempPath, tempIdentity, lockDir, ownerToken, lockIdentity, hooks);
        reservationCleanupPending = false;
      } catch (error) {
        warnings.push(error);
      }
    }
    const cleanupPending = publicationDurabilityPending || reservationCleanupPending;
    state = cleanupPending ? "committed_cleanup_pending" : "committed";
    if (warnings.length > 0) return committedOutcome(cleanupPending, warnings);
    return artifact;
  }

  async function finishDiscardCleanup() {
    await cleanupReservation(tempPath, tempIdentity, lockDir, ownerToken, lockIdentity, discardCause, hooks);
    state = "discarded";
  }

  async function publishAndCleanup() {
    const commitWarnings: unknown[] = [];
    try {
      throwIfAborted(signal);
      await mkdir(path.dirname(filePath), { recursive: true });
      await ensurePathAbsent(filePath);
      tempIdentity = await writeArtifactFileExclusiveDurable(tempPath, content, "temp-write", hooks, signal);
      await hooks.afterTempWrite?.({ path: filePath, tempPath, lockDir });
      throwIfAborted(signal);
      await ensurePathAbsent(filePath);
      await link(tempPath, filePath);
      // No awaited work may occur between a successful hard link and this
      // transition: from this point forward cleanup must never report a false
      // pre-commit failure or remove a concurrently-created successor.
      state = "committed_cleanup_pending";
      publicationDurabilityPending = true;
      try {
        tempIdentity = await artifactTempIdentity(tempPath);
      } catch (error) {
        commitWarnings.push(artifactTempError(
          `artifact temp could not be repinned after publication: ${tempPath}`,
          "ARTIFACT_TEMP_REPIN_UNSAFE",
          tempPath,
          error,
        ));
      }
    } catch (error) {
      tempIdentity = tempIdentityFromError(error) ?? tempIdentity;
      discardCause = isAbortSignalAborted(signal) && !isAbortError(error)
        ? artifactAbortError(signal)
        : error;
      state = "discard_cleanup_pending";
      await finishDiscardCleanup();
      throw discardCause;
    }

    // The hard link is the publication linearization point. Abort observed
    // after this line cannot turn a published artifact into an API failure.
    try {
      await hooks.afterFinalLink?.({ path: filePath, tempPath, lockDir });
    } catch (error) {
      commitWarnings.push(error);
    }
    return settleCommittedCleanup(commitWarnings);
  }

  async function commitArtifact(): Promise<ArtifactRecord | ArtifactCommitOutcome> {
    while (true) {
      if (state === "committed") return artifact;
      if (state === "discarded") throw discardedError();
      if (operation) {
        const current = operation;
        if (current.kind === "commit") {
          return current.promise as Promise<ArtifactRecord | ArtifactCommitOutcome>;
        }
        try {
          await current.promise;
        } catch {
          // Re-evaluate the durable state; a failed cleanup remains pending.
        }
        continue;
      }
      if (state === "prepared") {
        return startOperation("commit", publishAndCleanup);
      }
      if (state === "committed_cleanup_pending") {
        return startOperation("commit", () => settleCommittedCleanup());
      }
      if (state === "discard_cleanup_pending") {
        await startOperation("discard", finishDiscardCleanup);
        throw discardedError();
      }
    }
  }

  async function discardArtifact(): Promise<void | ArtifactCommitOutcome> {
    while (true) {
      if (state === "committed" || state === "discarded") return;
      if (operation) {
        const current = operation;
        if (current.kind === "discard") return current.promise as Promise<void>;
        try {
          const result = await current.promise;
          if (isArtifactCommitOutcome(result)) return result;
        } catch {
          // Re-evaluate and retry cleanup without ever re-publishing.
        }
        continue;
      }
      if (state === "committed_cleanup_pending") {
        const result = await startOperation("commit", () => settleCommittedCleanup());
        return isArtifactCommitOutcome(result) ? result : undefined;
      }
      if (state === "prepared") state = "discard_cleanup_pending";
      return startOperation("discard", async () => {
        let hookError: unknown;
        try {
          await hooks.beforeDiscardCleanup?.({ path: filePath, tempPath, lockDir });
        } catch (error) {
          hookError = error;
          discardCause ??= error;
        }
        await finishDiscardCleanup();
        if (hookError !== undefined) throw hookError;
      });
    }
  }

  return {
    artifact,
    commit: commitArtifact,
    discard: discardArtifact,
  };
}

export async function writeArtifact(cpbRoot: string, input: ArtifactWriteInput): Promise<ArtifactWriteResult> {
  const prepared = await prepareArtifactWrite(cpbRoot, input);
  const result = await prepared.commit();
  if (!isArtifactCommitOutcome(result)) return result;
  return {
    ...result.artifact,
    committed: true as const,
    cleanupPending: result.cleanupPending,
    commitWarnings: result.commitWarnings,
    retryCleanup: result.retryCleanup,
  };
}

export function isArtifactCommitOutcome(value: unknown): value is ArtifactCommitOutcome {
  return Boolean(
    value
    && typeof value === "object"
    && "committed" in value
    && value.committed === true
    && "artifact" in value,
  );
}

async function allocateArtifactReservation(
  cpbRoot: string,
  project: string,
  kind: string,
  {
    dataRoot,
    ownerToken = crypto.randomUUID(),
    hooks,
  }: { dataRoot?: string; ownerToken?: string; hooks: ArtifactStoreTestHooks },
): Promise<ArtifactReservation> {
  const artifactDir = dataRoot
    ? resolveArtifactDirForRoot(dataRoot, kind)
    : resolveArtifactDir(cpbRoot, project, kind);
  await mkdir(artifactDir, { recursive: true });
  await assertArtifactDirectoryAuthority(artifactDir);

  const candidates: string[] = [];
  const base = Date.now();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    candidates.push(String(base + attempt).slice(-6));
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    candidates.push(crypto.randomBytes(3).toString("hex"));
  }

  for (const id of candidates) {
    const filePath = assertArtifactDirectChildPath(
      artifactDir,
      dataRoot
        ? resolveArtifactPathForRoot(dataRoot, kind, id)
        : resolveArtifactPath(cpbRoot, project, kind, id),
      "final",
    );
    const lockDir = assertArtifactDirectChildPath(
      artifactDir,
      path.join(artifactDir, `.lock-${kind}-${id}`),
      "lock",
    );
    const reservation: ArtifactReservation = {
      id,
      artifactDir,
      filePath,
      lockDir,
      ownerToken,
      lockIdentity: null,
    };
    if (await tryReserveArtifactId(reservation, hooks)) {
      return reservation;
    }
  }
  throw new Error(`unable to allocate artifact id for ${kind} without overwriting existing artifacts`);
}

function sha256(content: string) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

async function writeArtifactFileExclusiveDurable(
  filePath: string,
  content: string,
  phase: ArtifactFileFsPhase,
  hooks: ArtifactStoreTestHooks,
  signal?: AbortSignal,
): Promise<ArtifactPathIdentity> {
  throwIfAborted(signal);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let primaryError: unknown = null;
  let fileIdentity: ArtifactPathIdentity | null = null;
  try {
    handle = await open(filePath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    const opened = await handle.stat();
    if (!opened.isFile() || opened.isSymbolicLink()) {
      throw artifactTempError(`artifact ${phase} path is not a pinned regular file: ${filePath}`, "ARTIFACT_TEMP_UNSAFE_PATH", filePath);
    }
    fileIdentity = artifactIdentityFromStats(opened);
    throwIfAborted(signal);
    if (hooks.syncFile) await hooks.syncFile(filePath, phase);
    else await handle.sync();
  } catch (error) {
    primaryError = fileIdentity
      ? Object.assign(error instanceof Error ? error : new Error(String(error)), { artifactTempIdentity: fileIdentity })
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
    throw new AggregateError(
      [primaryError, closeError],
      `artifact ${phase} write and close failed: ${filePath}`,
      { cause: primaryError },
    );
  }
  if (closeError) throw closeError;
  if (!fileIdentity) {
    throw artifactTempError(`artifact ${phase} write did not produce a pinned file identity: ${filePath}`, "ARTIFACT_TEMP_UNSAFE_PATH", filePath);
  }
  return fileIdentity;
}

function artifactLockOwnerError(
  message: string,
  code: string,
  ownerPath: string,
  lockDir: string,
  cause?: unknown,
) {
  return Object.assign(
    new Error(message, cause === undefined ? undefined : { cause }),
    {
      code,
      recoveryPaths: [...new Set([ownerPath, lockDir, path.dirname(ownerPath), path.dirname(lockDir)])],
    },
  );
}

async function readArtifactLockOwner(
  ownerPath: string,
  lockDir: string,
  hooks: ArtifactStoreTestHooks,
): Promise<ArtifactLockOwner> {
  let raw: string;
  try {
    raw = await readBoundedRegularFileNoFollow(ownerPath, {
      maxBytes: ARTIFACT_LOCK_OWNER_MAX_BYTES,
      hooks: hooks.ownerReadHooks,
    });
  } catch (error) {
    throw artifactLockOwnerError(
      `artifact lock owner cannot be read safely: ${ownerPath}`,
      "ARTIFACT_LOCK_OWNER_READ_UNSAFE",
      ownerPath,
      lockDir,
      error,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw artifactLockOwnerError(
      `artifact lock owner JSON is malformed: ${ownerPath}`,
      "ARTIFACT_LOCK_OWNER_INVALID",
      ownerPath,
      lockDir,
      error,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw artifactLockOwnerError(
      `artifact lock owner is not a JSON object: ${ownerPath}`,
      "ARTIFACT_LOCK_OWNER_INVALID",
      ownerPath,
      lockDir,
    );
  }
  const owner = parsed as Partial<ArtifactLockOwner>;
  const createdAtMs = typeof owner.createdAt === "string" ? Date.parse(owner.createdAt) : Number.NaN;
  if (typeof owner.ownerToken !== "string" || !owner.ownerToken
    || typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
    || !Number.isFinite(createdAtMs)
    || new Date(createdAtMs).toISOString() !== owner.createdAt) {
    throw artifactLockOwnerError(
      `artifact lock owner is malformed: ${ownerPath}`,
      "ARTIFACT_LOCK_OWNER_INVALID",
      ownerPath,
      lockDir,
    );
  }
  return owner as ArtifactLockOwner;
}

async function tryReserveArtifactId(
  reservation: ArtifactReservation,
  hooks: ArtifactStoreTestHooks,
) {
  const { filePath, lockDir, ownerToken } = reservation;
  let lockCreated = false;
  let preserveLockEvidence = false;
  const ownerPath = path.join(lockDir, "owner.json");
  try {
    await mkdir(lockDir);
    lockCreated = true;
    reservation.lockIdentity = await artifactLockIdentity(lockDir);
    try {
      await syncArtifactLockDirectory(path.dirname(lockDir), "reservation-mkdir", hooks);
    } catch (error) {
      throw artifactCommittedDurabilityAmbiguity(
        "artifact reservation directory was created but parent durability is ambiguous",
        "ARTIFACT_RESERVATION_MKDIR_COMMITTED_DURABILITY_AMBIGUOUS",
        lockDir,
        [lockDir, path.dirname(lockDir)],
        error,
      );
    }
    const content = JSON.stringify({ ownerToken, pid: process.pid, createdAt: new Date().toISOString() });
    if (hooks.writeOwnerFile) {
      await hooks.writeOwnerFile({ path: filePath, lockDir, ownerPath, content });
    } else {
      await writeArtifactFileExclusiveDurable(ownerPath, content, "reservation-owner", hooks);
    }
    let owner: ArtifactLockOwner;
    try {
      owner = await readArtifactLockOwner(ownerPath, lockDir, hooks);
    } catch (error) {
      preserveLockEvidence = true;
      throw error;
    }
    if (owner.ownerToken !== ownerToken) {
      preserveLockEvidence = true;
      throw artifactLockOwnerError(
        `artifact reservation owner changed before publication: ${ownerPath}`,
        "ARTIFACT_LOCK_OWNER_MISMATCH",
        ownerPath,
        lockDir,
      );
    }
    try {
      reservation.lockIdentity = await artifactLockIdentity(lockDir);
      await syncArtifactLockDirectory(lockDir, "reservation-owner", hooks);
      reservation.lockIdentity = await artifactLockIdentity(lockDir);
    } catch (error) {
      throw artifactCommittedDurabilityAmbiguity(
        "artifact reservation owner was published but directory durability is ambiguous",
        "ARTIFACT_LOCK_OWNER_COMMITTED_DURABILITY_AMBIGUOUS",
        ownerPath,
        [ownerPath, lockDir, path.dirname(lockDir)],
        error,
      );
    }
  } catch (error) {
    const code = errorCode(error);
    if (!lockCreated && code === "EEXIST") return false;
    if (lockCreated && !preserveLockEvidence) {
      const ownerRequired = await pathExists(ownerPath);
      try {
        await runArtifactCleanup(error, [() => cleanupOwnedLock(
          lockDir,
          ownerToken,
          reservation.lockIdentity,
          { ownerRequired, hooks },
        )]);
      } catch (cleanupError) {
        if (!isIgnorableArtifactLockQuarantinePreservation(cleanupError)) throw cleanupError;
      }
      if (code === "EEXIST") return false;
    }
    throw error;
  }

  try {
    if (await pathExists(filePath)) {
      try {
        await cleanupOwnedLock(lockDir, ownerToken, reservation.lockIdentity, { hooks });
      } catch (error) {
        if (!isIgnorableArtifactLockQuarantinePreservation(error)) throw error;
      }
      return false;
    }
    return true;
  } catch (error) {
    await runArtifactCleanup(error, [() => cleanupOwnedLock(lockDir, ownerToken, reservation.lockIdentity, { hooks })]);
    throw error;
  }
}

async function ensurePathAbsent(filePath: string) {
  if (await pathExists(filePath)) {
    throw new Error(`artifact already exists at ${filePath}; refusing to overwrite`);
  }
}

async function pathExists(filePath: string) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function artifactIdentityFromStats(stats: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}): ArtifactPathIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    birthtimeMs: stats.birthtimeMs,
  };
}

async function artifactTempIdentity(filePath: string): Promise<ArtifactPathIdentity> {
  const fileStat = await lstat(filePath);
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw artifactTempError(`artifact temp path is not a real file: ${filePath}`, "ARTIFACT_TEMP_UNSAFE_PATH", filePath);
  }
  return artifactIdentityFromStats(fileStat);
}

function sameArtifactPathIdentity(
  expected: ArtifactPathIdentity | null,
  actual: ArtifactPathIdentity,
) {
  return Boolean(expected
    && expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && expected.ctimeMs === actual.ctimeMs
    && expected.birthtimeMs === actual.birthtimeMs);
}

function sameRenamedArtifactPathIdentity(
  expected: ArtifactPathIdentity | null,
  actual: ArtifactPathIdentity,
) {
  return Boolean(expected
    && expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && expected.birthtimeMs === actual.birthtimeMs);
}

function artifactTempError(message: string, code: string, filePath: string, cause?: unknown) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    code,
    recoveryPaths: [filePath, path.dirname(filePath)],
  });
}

function tempIdentityFromError(error: unknown): ArtifactPathIdentity | null {
  if (!error || typeof error !== "object" || !("artifactTempIdentity" in error)) return null;
  const identity = error.artifactTempIdentity as Partial<ArtifactPathIdentity>;
  return typeof identity.dev === "number"
    && typeof identity.ino === "number"
    && typeof identity.size === "number"
    && typeof identity.mtimeMs === "number"
    && typeof identity.ctimeMs === "number"
    && typeof identity.birthtimeMs === "number"
    ? identity as ArtifactPathIdentity
    : null;
}

async function preserveTempCleanupEvidence(
  tempPath: string,
  isolatedPath: string,
  actualIdentity: ArtifactPathIdentity | null,
  expectedIdentity: ArtifactPathIdentity | null,
  primary: unknown,
): Promise<never> {
  let canonicalState: "missing" | "present" | "unavailable" = "missing";
  let canonicalStateError: unknown;
  try {
    await lstat(tempPath);
    canonicalState = "present";
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      canonicalState = "unavailable";
      canonicalStateError = error;
    }
  }

  const successorPreserved = canonicalState === "present";
  const code = successorPreserved
    ? "ARTIFACT_TEMP_SUCCESSOR_PRESERVED"
    : "ARTIFACT_TEMP_ISOLATION_PRESERVED";
  const recoveryPaths = [isolatedPath, tempPath, path.dirname(tempPath)];
  const preservationError = Object.assign(
    new Error(
      successorPreserved
        ? `artifact temp successor and isolated temp preserved: ${tempPath}`
        : `artifact isolated temp preserved: ${isolatedPath}`,
      { cause: canonicalStateError ?? primary },
    ),
    {
      code,
      committed: true,
      committedPath: isolatedPath,
      recoveryPaths,
      successorPreserved,
      tempPreserved: true,
      residualPath: isolatedPath,
      preservedPath: isolatedPath,
      canonicalPath: tempPath,
      canonicalState,
      actualIdentity,
      expectedIdentity,
    },
  );
  throw artifactLockAggregate(
    primary,
    [preservationError],
    successorPreserved
      ? `artifact temp cleanup preserved without removing successor: ${tempPath}`
      : `artifact temp cleanup preserved isolated generation: ${isolatedPath}`,
    {
      code,
      committed: true,
      committedPath: isolatedPath,
      recoveryPaths,
      successorPreserved,
      tempPreserved: true,
      residualPath: isolatedPath,
      preservedPath: isolatedPath,
      canonicalPath: tempPath,
      canonicalState,
      actualIdentity,
      expectedIdentity,
    },
  );
}

async function removeArtifactTempDurable(
  filePath: string | undefined,
  expectedIdentity: ArtifactPathIdentity | null,
  ownerToken: string,
  hooks: ArtifactStoreTestHooks,
) {
  if (!filePath) return;
  const isolatedPath = `${filePath}.cleanup-${ownerToken}`;
  let isolatedIdentity: ArtifactPathIdentity | null = null;
  let removed = false;
  try {
    if (!await pathExists(isolatedPath)) {
      let currentIdentity: ArtifactPathIdentity;
      try {
        currentIdentity = await artifactTempIdentity(filePath);
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          await syncArtifactLockDirectory(path.dirname(filePath), "temp-remove", hooks);
          return;
        }
        throw error;
      }
      if (!sameArtifactPathIdentity(expectedIdentity, currentIdentity)) {
        await preserveTempCleanupEvidence(filePath, isolatedPath, currentIdentity, expectedIdentity, Object.assign(
          new Error(`artifact temp identity mismatch: ${filePath}`),
          { code: "ARTIFACT_TEMP_IDENTITY_MISMATCH" },
        ));
      }
      await rename(filePath, isolatedPath);
      isolatedIdentity = await artifactTempIdentity(isolatedPath);
      if (!sameRenamedArtifactPathIdentity(currentIdentity, isolatedIdentity)) {
        await preserveTempCleanupEvidence(filePath, isolatedPath, isolatedIdentity, currentIdentity, Object.assign(
          new Error(`artifact temp identity changed during isolation: ${filePath}`),
          { code: "ARTIFACT_TEMP_IDENTITY_MISMATCH" },
        ));
      }
      await syncArtifactLockDirectory(path.dirname(filePath), "temp-isolate", hooks);
      try {
        await hooks.afterTempIsolationRename?.({ tempPath: filePath, isolatedPath });
      } catch (error) {
        await preserveTempCleanupEvidence(filePath, isolatedPath, isolatedIdentity, isolatedIdentity, error);
      }
    } else {
      isolatedIdentity = await artifactTempIdentity(isolatedPath);
      if (!sameRenamedArtifactPathIdentity(expectedIdentity, isolatedIdentity)) {
        await preserveTempCleanupEvidence(filePath, isolatedPath, isolatedIdentity, expectedIdentity, Object.assign(
          new Error(`artifact isolated temp identity mismatch: ${isolatedPath}`),
          { code: "ARTIFACT_TEMP_IDENTITY_MISMATCH" },
        ));
      }
    }

    const finalIdentity = await artifactTempIdentity(isolatedPath);
    if (!sameArtifactPathIdentity(isolatedIdentity, finalIdentity)) {
      await preserveTempCleanupEvidence(filePath, isolatedPath, finalIdentity, isolatedIdentity, Object.assign(
        new Error(`artifact isolated temp identity changed before unlink: ${isolatedPath}`),
        { code: "ARTIFACT_TEMP_IDENTITY_MISMATCH" },
      ));
    }
    await hooks.beforeTempUnlink?.({ tempPath: filePath, isolatedPath });
    const unlinkIdentity = await artifactTempIdentity(isolatedPath);
    if (!sameArtifactPathIdentity(finalIdentity, unlinkIdentity)) {
      await preserveTempCleanupEvidence(filePath, isolatedPath, unlinkIdentity, finalIdentity, Object.assign(
        new Error(`artifact isolated temp identity changed after unlink hook: ${isolatedPath}`),
        { code: "ARTIFACT_TEMP_IDENTITY_MISMATCH" },
      ));
    }
    await unlink(isolatedPath);
    removed = true;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  try {
    // Also sync an already-absent isolated path on retry: the previous unlink
    // may have committed before its parent fsync failed.
    await syncArtifactLockDirectory(path.dirname(filePath), "temp-remove", hooks);
  } catch (error) {
    throw artifactCommittedDurabilityAmbiguity(
      removed
        ? "artifact isolated temp file was removed but parent durability is ambiguous"
        : "artifact isolated temp file is absent but parent durability remains ambiguous",
      "ARTIFACT_TEMP_REMOVE_COMMITTED_DURABILITY_AMBIGUOUS",
      isolatedPath,
      [isolatedPath, filePath, path.dirname(filePath)],
      error,
    );
  }
}

async function cleanupReservation(
  tempPath: string | undefined,
  tempIdentity: ArtifactPathIdentity | null,
  lockDir: string,
  ownerToken: string,
  lockIdentity: ArtifactLockIdentity | null,
  cause?: unknown,
  hooks: ArtifactStoreTestHooks = {},
) {
  await runArtifactCleanup(cause, [
    () => removeArtifactTempDurable(tempPath, tempIdentity, ownerToken, hooks),
    async () => {
      try {
        await cleanupOwnedLock(lockDir, ownerToken, lockIdentity, { hooks });
      } catch (error) {
        if (!isIgnorableArtifactLockQuarantinePreservation(error)) throw error;
      }
    },
  ]);
}

async function cleanupCommittedReservation(
  tempPath: string,
  tempIdentity: ArtifactPathIdentity | null,
  lockDir: string,
  ownerToken: string,
  lockIdentity: ArtifactLockIdentity | null,
  hooks: ArtifactStoreTestHooks,
) {
  await runArtifactCleanup(undefined, [
    () => removeArtifactTempDurable(tempPath, tempIdentity, ownerToken, hooks),
    () => cleanupOwnedLock(lockDir, ownerToken, lockIdentity, { hooks }),
  ]);
}

async function artifactLockIdentity(lockDir: string): Promise<ArtifactLockIdentity> {
  const lockStat = await lstat(lockDir);
  if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
    throw Object.assign(new Error(`artifact lock path is not a real directory: ${lockDir}`), {
      code: "ARTIFACT_LOCK_UNSAFE_PATH",
      recoveryPaths: [lockDir],
    });
  }
  return {
    dev: lockStat.dev,
    ino: lockStat.ino,
    size: lockStat.size,
    mtimeMs: lockStat.mtimeMs,
    ctimeMs: lockStat.ctimeMs,
    birthtimeMs: lockStat.birthtimeMs,
  };
}

function sameArtifactLockIdentity(
  expected: ArtifactLockIdentity | null,
  actual: ArtifactLockIdentity,
) {
  return Boolean(expected
    && expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && expected.ctimeMs === actual.ctimeMs
    && expected.birthtimeMs === actual.birthtimeMs);
}

function sameRenamedArtifactLockIncarnation(
  expected: ArtifactLockIdentity | null,
  actual: ArtifactLockIdentity,
) {
  return Boolean(expected
    && expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.birthtimeMs === actual.birthtimeMs);
}

async function cleanupOwnedLock(
  lockDir: string,
  ownerToken: string,
  expectedIdentity: ArtifactLockIdentity | null,
  {
    ownerRequired = true,
    hooks = {},
  }: { ownerRequired?: boolean; hooks?: ArtifactStoreTestHooks } = {},
) {
  const quarantineDir = `${lockDir}.cleanup-${ownerToken}`;
  let preRenameIdentity: ArtifactLockIdentity | null = null;
  if (!await pathExists(quarantineDir)) {
    try {
      preRenameIdentity = await artifactLockIdentity(lockDir);
      if (!sameRenamedArtifactLockIncarnation(expectedIdentity, preRenameIdentity)) {
        await preserveQuarantinedLock(lockDir, quarantineDir, Object.assign(
          new Error(`artifact lock identity mismatch: ${lockDir}`),
          { code: "ARTIFACT_LOCK_IDENTITY_MISMATCH", quarantineDir },
        ));
      }
      // Moving first ensures a newly-created successor at lockDir is never
      // deleted. Only the owner-specific quarantine can be removed below.
      await rename(lockDir, quarantineDir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        try {
          // A prior cleanup attempt may have removed the quarantine and then
          // failed its parent fsync. Re-syncing the observed-absent state is
          // what lets retryCleanup resolve that durability ambiguity.
          await syncArtifactLockDirectory(path.dirname(lockDir), "remove", hooks);
        } catch (syncError) {
          throw artifactCommittedDurabilityAmbiguity(
            "artifact lock is absent but parent durability remains ambiguous",
            "ARTIFACT_LOCK_REMOVE_COMMITTED_DURABILITY_AMBIGUOUS",
            lockDir,
            [lockDir, path.dirname(lockDir)],
            syncError,
          );
        }
        return;
      }
      throw error;
    }
    try {
      await syncArtifactLockDirectory(path.dirname(lockDir), "quarantine-rename", hooks);
    } catch (error) {
      throw artifactCommittedDurabilityAmbiguity(
        "artifact lock quarantine rename committed but parent durability is ambiguous",
        "ARTIFACT_LOCK_QUARANTINE_COMMITTED_DURABILITY_AMBIGUOUS",
        quarantineDir,
        [lockDir, quarantineDir, path.dirname(lockDir)],
        error,
      );
    }
    try {
      await hooks.afterLockQuarantineRename?.({ lockDir, quarantineDir });
    } catch (error) {
      await preserveQuarantinedLock(lockDir, quarantineDir, error);
    }
  }

  const quarantinedIdentity = await artifactLockIdentity(quarantineDir).catch((error) => (
    preserveQuarantinedLock(lockDir, quarantineDir, error)
  ));
  const identityMatches = preRenameIdentity
    ? sameRenamedArtifactLockIncarnation(preRenameIdentity, quarantinedIdentity)
    : sameArtifactLockIdentity(expectedIdentity, quarantinedIdentity);
  if (!identityMatches) {
    await preserveQuarantinedLock(lockDir, quarantineDir, Object.assign(
      new Error(`artifact lock identity mismatch: ${lockDir}`),
      { code: "ARTIFACT_LOCK_IDENTITY_MISMATCH", quarantineDir },
    ));
  }
  const ownerPath = path.join(quarantineDir, "owner.json");
  let finalOwnerIdentity: ArtifactPathIdentity | null = null;
  if (ownerRequired) {
    let owner: ArtifactLockOwner | null = null;
    try {
      owner = await readArtifactLockOwner(ownerPath, lockDir, hooks);
      finalOwnerIdentity = artifactIdentityFromStats(lstatSync(ownerPath));
    } catch (error) {
      await preserveQuarantinedLock(lockDir, quarantineDir, asArtifactLockError(error));
    }
    if (owner?.ownerToken !== ownerToken) {
      await preserveQuarantinedLock(lockDir, quarantineDir, Object.assign(
        new Error(`artifact lock owner mismatch: ${lockDir}`),
        { code: "ARTIFACT_LOCK_OWNER_MISMATCH", quarantineDir },
      ));
    }
  }
  try {
    await hooks.afterLockOwnerValidation?.({ lockDir, quarantineDir, ownerPath });
  } catch (error) {
    await preserveQuarantinedLock(lockDir, quarantineDir, error);
  }
  const finalQuarantinedIdentity = await artifactLockIdentity(quarantineDir).catch((error) => (
    preserveQuarantinedLock(lockDir, quarantineDir, error)
  ));
  if (!sameArtifactLockIdentity(quarantinedIdentity, finalQuarantinedIdentity)) {
    await preserveQuarantinedLock(lockDir, quarantineDir, Object.assign(
      new Error(`artifact lock identity changed after owner validation: ${lockDir}`),
      { code: "ARTIFACT_LOCK_IDENTITY_MISMATCH", quarantineDir },
    ));
  }

  // Re-read the owner after the final test hook. Directory metadata detects
  // whole-entry replacement, while this second descriptor-pinned read detects
  // an in-place owner mutation that would otherwise leave the directory inode
  // unchanged.
  if (ownerRequired) {
    let owner: ArtifactLockOwner | null = null;
    try {
      owner = await readArtifactLockOwner(ownerPath, lockDir, hooks);
    } catch (error) {
      await preserveQuarantinedLock(lockDir, quarantineDir, asArtifactLockError(error));
    }
    if (owner?.ownerToken !== ownerToken) {
      await preserveQuarantinedLock(lockDir, quarantineDir, Object.assign(
        new Error(`artifact lock owner changed before removal: ${lockDir}`),
        { code: "ARTIFACT_LOCK_OWNER_MISMATCH", quarantineDir },
      ));
    }
  }

  try {
    await removeValidatedArtifactLockQuarantine({
      lockDir,
      quarantineDir,
      ownerPath,
      ownerRequired,
      expectedIdentity: finalQuarantinedIdentity,
      expectedOwnerIdentity: finalOwnerIdentity,
      hooks,
    });
  } catch (error) {
    if ((error as { committed?: unknown })?.committed === true) throw error;
    await preserveQuarantinedLock(lockDir, quarantineDir, error);
  }
}

async function removeValidatedArtifactLockQuarantine({
  lockDir,
  quarantineDir,
  ownerPath,
  ownerRequired,
  expectedIdentity,
  expectedOwnerIdentity,
  hooks,
}: {
  lockDir: string;
  quarantineDir: string;
  ownerPath: string;
  ownerRequired: boolean;
  expectedIdentity: ArtifactLockIdentity;
  expectedOwnerIdentity: ArtifactPathIdentity | null;
  hooks: ArtifactStoreTestHooks;
}) {
  // A canonical successor means the quarantined predecessor is still needed
  // as recovery evidence. Never remove either generation in that state.
  try {
    lstatSync(lockDir);
    throw Object.assign(new Error(`artifact lock successor appeared before quarantine removal: ${lockDir}`), {
      code: "ARTIFACT_LOCK_SUCCESSOR_PRESENT",
      quarantineDir,
    });
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  try {
    // Keep the final generation check, bounded namespace inspection, owner
    // unlink, and empty-directory removal in one synchronous turn. This closes
    // the in-process check/use window exposed by an awaited recursive removal;
    // rmdir also fails closed if any unexpected recovery entry is present.
    const finalDirectory = artifactIdentityFromStats(lstatSync(quarantineDir));
    if (!sameArtifactLockIdentity(expectedIdentity, finalDirectory)) {
      throw Object.assign(new Error(`artifact lock quarantine changed before removal: ${quarantineDir}`), {
        code: "ARTIFACT_LOCK_IDENTITY_MISMATCH",
        quarantineDir,
      });
    }
    const entries = readdirSync(quarantineDir).sort();
    const expectedEntries = ownerRequired ? [path.basename(ownerPath)] : [];
    if (entries.length !== expectedEntries.length
      || entries.some((entry, index) => entry !== expectedEntries[index])) {
      throw Object.assign(new Error(`artifact lock quarantine contains unexpected recovery evidence: ${quarantineDir}`), {
        code: "ARTIFACT_LOCK_QUARANTINE_NOT_EMPTY",
        quarantineDir,
        entries,
      });
    }
    if (ownerRequired) {
      const owner = lstatSync(ownerPath);
      if (!owner.isFile()
        || owner.isSymbolicLink()
        || !sameArtifactPathIdentity(expectedOwnerIdentity, artifactIdentityFromStats(owner))) {
        throw Object.assign(new Error(`artifact lock owner changed before removal: ${ownerPath}`), {
          code: "ARTIFACT_LOCK_OWNER_READ_UNSAFE",
          quarantineDir,
        });
      }
      unlinkSync(ownerPath);
    }
    rmdirSync(quarantineDir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw Object.assign(new Error(`artifact lock quarantine disappeared before verified removal: ${quarantineDir}`, {
        cause: error,
      }), {
        code: "ARTIFACT_LOCK_IDENTITY_MISMATCH",
        quarantineDir,
      });
    }
    throw error;
  }

  try {
    await syncArtifactLockDirectory(path.dirname(lockDir), "remove", hooks);
  } catch (error) {
    throw artifactCommittedDurabilityAmbiguity(
      "artifact lock quarantine was removed but parent durability is ambiguous",
      "ARTIFACT_LOCK_REMOVE_COMMITTED_DURABILITY_AMBIGUOUS",
      quarantineDir,
      [lockDir, quarantineDir, path.dirname(lockDir)],
      error,
    );
  }
}

async function preserveQuarantinedLock(
  lockDir: string,
  quarantineDir: string,
  primary: unknown,
): Promise<never> {
  // Node does not expose a portable dirfd-relative openat/renameat2 primitive.
  // Reconstructing entries through `lockDir/...` after any path observation
  // would therefore retain a check/use window in which an unrelated successor
  // directory could replace the canonical name. Preserve the quarantined
  // generation as the recovery receipt and fail closed instead of ever writing
  // through that mutable path.
  let canonicalState: "missing" | "present" | "unavailable" = "missing";
  let canonicalStateError: unknown;
  try {
    await lstat(lockDir);
    canonicalState = "present";
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      canonicalState = "unavailable";
      canonicalStateError = error;
    }
  }

  const successorPreserved = canonicalState === "present";
  const recoveryPaths = [quarantineDir, lockDir, path.dirname(lockDir)];
  const code = successorPreserved
    ? "ARTIFACT_LOCK_SUCCESSOR_PRESERVED"
    : canonicalState === "missing"
      ? "ARTIFACT_LOCK_QUARANTINE_PRESERVED"
      : "ARTIFACT_LOCK_CANONICAL_STATE_UNAVAILABLE";
  const preservationError = Object.assign(
    new Error(
      successorPreserved
        ? `artifact lock successor and quarantine preserved: ${lockDir}`
        : canonicalState === "missing"
          ? `artifact lock quarantine preserved with canonical path absent: ${quarantineDir}`
          : `artifact lock quarantine preserved because canonical state is unavailable: ${lockDir}`,
      { cause: canonicalStateError ?? primary },
    ),
    {
      code,
      committed: true,
      committedPath: quarantineDir,
      recoveryPaths,
      successorPreserved,
      quarantinePreserved: true,
      residualPath: quarantineDir,
      preservedPath: quarantineDir,
      canonicalPath: lockDir,
      canonicalState,
    },
  );
  throw artifactLockAggregate(
    primary,
    [preservationError],
    successorPreserved
      ? `artifact lock quarantine preserved without overwriting successor: ${lockDir}`
      : `artifact lock quarantine preserved without path reconstruction: ${lockDir}`,
    {
      code,
      committed: true,
      committedPath: quarantineDir,
      recoveryPaths,
      successorPreserved,
      quarantinePreserved: true,
      residualPath: quarantineDir,
      preservedPath: quarantineDir,
      canonicalPath: lockDir,
      canonicalState,
    },
  );
}

async function syncArtifactLockDirectory(
  directory: string,
  phase: ArtifactFsPhase,
  hooks: ArtifactStoreTestHooks,
) {
  if (hooks.syncLockDirectory) {
    await hooks.syncLockDirectory(directory, phase);
    return;
  }
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let primaryError: unknown = null;
  try {
    const before = await assertArtifactDirectoryAuthority(directory);
    handle = await open(directory, strictArtifactDirectoryOpenFlags());
    const opened = await handle.stat();
    if (!opened.isDirectory() || !sameRenamedArtifactLockIncarnation(before, opened)) {
      throw artifactDirectorySyncError(
        `artifact directory changed while opening for sync: ${directory}`,
        directory,
      );
    }
    await handle.sync();
  } catch (error) {
    primaryError = ["ELOOP", "EMLINK", "ENOTDIR"].includes(errorCode(error))
      ? artifactDirectorySyncError(`artifact directory cannot be synced safely: ${directory}`, directory, error)
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
  if (primaryError && closeError) {
    throw new AggregateError(
      [primaryError, closeError],
      `artifact lock directory fsync and close failed: ${directory}`,
      { cause: primaryError },
    );
  }
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;
}

function strictArtifactDirectoryOpenFlags() {
  if (
    typeof constants.O_NOFOLLOW !== "number"
    || constants.O_NOFOLLOW === 0
    || typeof constants.O_DIRECTORY !== "number"
    || constants.O_DIRECTORY === 0
  ) {
    throw artifactDirectorySyncError(
      "strict no-follow artifact directory opens are unavailable",
      "",
    );
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY;
}

async function assertArtifactDirectoryAuthority(directory: string): Promise<ArtifactLockIdentity> {
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw artifactDirectorySyncError(`artifact directory is not a real directory: ${directory}`, directory);
  }
  return {
    dev: directoryStat.dev,
    ino: directoryStat.ino,
    size: directoryStat.size,
    mtimeMs: directoryStat.mtimeMs,
    ctimeMs: directoryStat.ctimeMs,
    birthtimeMs: directoryStat.birthtimeMs,
  };
}

function artifactDirectorySyncError(message: string, directory: string, cause?: unknown) {
  const recoveryPaths = directory ? [directory, path.dirname(directory)] : [];
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    code: "ARTIFACT_DIRECTORY_SYNC_UNSAFE",
    recoveryPaths,
  });
}

function artifactCommittedDurabilityAmbiguity(
  message: string,
  code: string,
  committedPath: string,
  recoveryPaths: string[],
  cause: unknown,
) {
  return Object.assign(new Error(message, { cause }), {
    code,
    committed: true,
    committedPath,
    recoveryPaths: [...new Set(recoveryPaths)],
  });
}

function artifactLockAggregate(
  primary: unknown,
  errors: unknown[],
  message: string,
  extra: Record<string, unknown> = {},
) {
  const nested = [primary, ...errors];
  const committed = extra.committed === true || nested.some((error) => (
    error && typeof error === "object" && "committed" in error && error.committed === true
  ));
  const recoveryPaths = [...new Set([
    ...(Array.isArray(extra.recoveryPaths) ? extra.recoveryPaths.filter((value): value is string => typeof value === "string") : []),
    ...nested.flatMap((error) => (
      error && typeof error === "object" && "recoveryPaths" in error && Array.isArray(error.recoveryPaths)
        ? error.recoveryPaths.filter((value): value is string => typeof value === "string")
        : []
    )),
  ])];
  return Object.assign(
    new AggregateError([primary, ...errors], message, { cause: primary }),
    {
      primaryError: primary,
      ...extra,
      ...(committed ? { committed: true } : {}),
      ...(recoveryPaths.length > 0 ? { recoveryPaths } : {}),
    },
  );
}

function asArtifactLockError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function isArtifactLockQuarantinePreserved(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && String(error.code) === "ARTIFACT_LOCK_QUARANTINE_PRESERVED") return true;
  const nested = [
    ...(error instanceof AggregateError ? error.errors : []),
    ...("cleanupErrors" in error && Array.isArray(error.cleanupErrors) ? error.cleanupErrors : []),
    ...("errors" in error && Array.isArray(error.errors) ? error.errors : []),
    "cause" in error ? error.cause : undefined,
  ];
  return nested.some(isArtifactLockQuarantinePreserved);
}

function hasArtifactLockUnsafeCause(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  if ([
    "ARTIFACT_LOCK_IDENTITY_MISMATCH",
    "ARTIFACT_LOCK_OWNER_MISMATCH",
    "ARTIFACT_LOCK_OWNER_READ_UNSAFE",
    "ARTIFACT_LOCK_OWNER_INVALID",
    "ARTIFACT_LOCK_UNSAFE_PATH",
  ].includes(code)) {
    return true;
  }
  const nested = [
    ...(error instanceof AggregateError ? error.errors : []),
    ...("cleanupErrors" in error && Array.isArray(error.cleanupErrors) ? error.cleanupErrors : []),
    "cause" in error ? error.cause : undefined,
  ];
  return nested.some(hasArtifactLockUnsafeCause);
}

function isIgnorableArtifactLockQuarantinePreservation(error: unknown) {
  return isArtifactLockQuarantinePreserved(error) && !hasArtifactLockUnsafeCause(error);
}

async function runArtifactCleanup(cause: unknown, actions: Array<() => Promise<void>>) {
  const settled = await Promise.allSettled(actions.map((action) => Promise.resolve().then(action)));
  const cleanupErrors = settled
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (cleanupErrors.length > 0) throw cleanupFailure(cleanupErrors, cause);
}

function cleanupFailure(cleanupErrors: unknown[], cause?: unknown) {
  const cleanupMessage = cleanupErrors
    .map((error) => error instanceof Error ? error.message : String(error))
    .join("; ");
  const hasCause = cause !== undefined;
  const error = new AggregateError(
    hasCause ? [cause, ...cleanupErrors] : cleanupErrors,
    `artifact reservation cleanup failed${cause instanceof Error ? ` after ${cause.message}` : ""}: ${cleanupMessage}`,
  );
  const nested = cause === undefined ? cleanupErrors : [cause, ...cleanupErrors];
  const committed = nested.some((cleanupError) => (
    cleanupError && typeof cleanupError === "object"
    && "committed" in cleanupError && cleanupError.committed === true
  ));
  const recoveryPaths = [...new Set(nested.flatMap((cleanupError) => (
    cleanupError && typeof cleanupError === "object"
      && "recoveryPaths" in cleanupError && Array.isArray(cleanupError.recoveryPaths)
      ? cleanupError.recoveryPaths.filter((value): value is string => typeof value === "string")
      : []
  )))];
  return Object.assign(error, {
    cause,
    cleanupErrors,
    ...(committed ? { committed: true } : {}),
    ...(recoveryPaths.length > 0 ? { recoveryPaths } : {}),
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw artifactAbortError(signal);
}

function artifactAbortError(signal?: AbortSignal) {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const message = reason instanceof Error
    ? reason.message
    : reason !== undefined
      ? String(reason)
      : "artifact write aborted";
  const error = new Error(message);
  error.name = "AbortError";
  (error as Error & { cause?: unknown; code?: string; reason?: unknown }).cause = reason;
  const reasonCode = reason instanceof Error && "code" in reason
    ? (reason as Error & { code?: unknown }).code
    : undefined;
  (error as Error & { code?: string }).code = typeof reasonCode === "string" && reasonCode
    ? reasonCode
    : "ABORT_ERR";
  (error as Error & { reason?: unknown }).reason = reason;
  return error;
}

function isAbortSignalAborted(signal?: AbortSignal) {
  return Boolean(signal?.aborted);
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "";
}
