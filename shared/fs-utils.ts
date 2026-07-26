import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

type FsUtilsTestHooks = {
  open?: typeof open;
  rename?: typeof rename;
  syncParentDirectory?: (dirPath: string) => Promise<void>;
};

const defaultHooks: Required<FsUtilsTestHooks> = {
  open,
  rename,
  syncParentDirectory: syncDirectory,
};

const hookStorage = new AsyncLocalStorage<Required<FsUtilsTestHooks>>();

export class JsonAtomicDurabilityError extends Error {
  readonly code = "CPB_JSON_WRITE_COMMITTED";
  readonly committed = true;
  readonly renameCommitted: boolean;
  readonly publicationKind: "rename" | "exclusive-create";
  readonly committedPath: string;
  readonly recoveryPaths: readonly string[];

  constructor(
    filePath: string,
    cause: unknown,
    options: {
      publicationKind?: "rename" | "exclusive-create";
      renameCommitted?: boolean;
    } = {},
  ) {
    const publicationKind = options.publicationKind ?? "rename";
    super(publicationKind === "rename"
      ? `atomic JSON write for ${filePath} was renamed, but parent directory fsync failed`
      : `write-once JSON creation for ${filePath} was published, but parent directory fsync failed`);
    this.name = "JsonAtomicDurabilityError";
    this.publicationKind = publicationKind;
    this.renameCommitted = options.renameCommitted ?? publicationKind === "rename";
    this.committedPath = filePath;
    this.recoveryPaths = [filePath];
    this.cause = cause;
  }
}

export class JsonWriteRecoveryError extends Error {
  readonly code = "CPB_JSON_WRITE_RECOVERY_REQUIRED";
  readonly committed: false | null;
  readonly renameCommitted: false | null;
  readonly successorPreserved: boolean;
  readonly recoveryPaths: readonly string[];

  constructor(
    message: string,
    recoveryPaths: readonly string[],
    cause: unknown,
    options: {
      committed?: false | null;
      renameCommitted?: false | null;
      successorPreserved?: boolean;
    } = {},
  ) {
    super(message, { cause });
    this.name = "JsonWriteRecoveryError";
    this.committed = options.committed === undefined ? false : options.committed;
    this.renameCommitted = options.renameCommitted === undefined ? false : options.renameCommitted;
    this.successorPreserved = options.successorPreserved ?? false;
    this.recoveryPaths = [...new Set(recoveryPaths)];
  }
}

export async function withFsUtilsTestHooks<T>(
  replacements: FsUtilsTestHooks,
  fn: () => Promise<T>,
): Promise<T> {
  const inherited = hookStorage.getStore() ?? defaultHooks;
  return await hookStorage.run({ ...inherited, ...replacements }, fn);
}

function currentHooks() {
  return hookStorage.getStore() ?? defaultHooks;
}

function jsonContent(data: unknown) {
  return typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`;
}

function tempPathFor(filePath: string) {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${randomUUID()}`);
}

function openNoFollowFlags(exclusive: boolean) {
  if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
    throw Object.assign(new Error("O_NOFOLLOW is unavailable; refusing unsafe JSON file publication"), {
      code: "CPB_NOFOLLOW_UNAVAILABLE",
    });
  }
  return constants.O_WRONLY
    | constants.O_CREAT
    | constants.O_NOFOLLOW
    | (exclusive ? constants.O_EXCL : 0);
}

function codeOf(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}

type FileGeneration = {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
};

function fileGeneration(info: BigIntStats): FileGeneration {
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    size: info.size,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
    birthtimeNs: info.birthtimeNs,
  };
}

function sameFileGenerationAcrossRename(left: FileGeneration, right: FileGeneration) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.birthtimeNs === right.birthtimeNs;
}

function sameFileGeneration(left: FileGeneration, right: FileGeneration) {
  return sameFileGenerationAcrossRename(left, right)
    && left.ctimeNs === right.ctimeNs;
}

async function handleGeneration(fh: FileHandle) {
  return fileGeneration(await fh.stat({ bigint: true }));
}

async function pathGeneration(filePath: string): Promise<FileGeneration | null> {
  try {
    return fileGeneration(await lstat(filePath, { bigint: true }));
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
}

function aggregateErrors(primary: unknown, secondary: unknown[], message: string) {
  if (secondary.length === 0) throw primary;
  const aggregate = new AggregateError([primary, ...secondary], message, { cause: primary });
  if (primary && typeof primary === "object") {
    const metadata = primary as {
      code?: unknown;
      committed?: unknown;
      committedPath?: unknown;
      recoveryPaths?: unknown;
      renameCommitted?: unknown;
      publicationKind?: unknown;
      successorPreserved?: unknown;
    };
    Object.assign(aggregate, {
      ...(typeof metadata.code === "string" ? { code: metadata.code } : {}),
      ...(typeof metadata.committed === "boolean" || metadata.committed === null
        ? { committed: metadata.committed }
        : {}),
      ...(typeof metadata.committedPath === "string" ? { committedPath: metadata.committedPath } : {}),
      ...(Array.isArray(metadata.recoveryPaths) ? { recoveryPaths: metadata.recoveryPaths } : {}),
      ...(typeof metadata.renameCommitted === "boolean" || metadata.renameCommitted === null
        ? { renameCommitted: metadata.renameCommitted }
        : {}),
      ...(metadata.publicationKind === "rename" || metadata.publicationKind === "exclusive-create"
        ? { publicationKind: metadata.publicationKind }
        : {}),
      ...(typeof metadata.successorPreserved === "boolean"
        ? { successorPreserved: metadata.successorPreserved }
        : {}),
    });
  }
  throw aggregate;
}

async function closeHandle(fh: FileHandle | null) {
  if (!fh) return [];
  try {
    await fh.close();
    return [];
  } catch (error) {
    return [error];
  }
}

function directoryOpenFlags() {
  if (
    typeof constants.O_NOFOLLOW !== "number"
    || constants.O_NOFOLLOW === 0
    || typeof constants.O_DIRECTORY !== "number"
    || constants.O_DIRECTORY === 0
  ) {
    throw Object.assign(new Error("safe directory flags are unavailable"), {
      code: "CPB_DIRECTORY_SYNC_UNSAFE",
    });
  }
  return constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
}

function isPathWithin(candidate: string, ancestor: string) {
  const relative = path.relative(ancestor, candidate);
  return relative === ""
    || (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function trustedDirectoryAnchor(dirPath: string) {
  const absolute = path.resolve(dirPath);
  const candidates = [path.resolve(process.cwd()), path.resolve(tmpdir())]
    .filter((candidate) => isPathWithin(absolute, candidate))
    .sort((left, right) => right.length - left.length);
  return candidates[0] ?? path.parse(absolute).root;
}

async function assertNoSymlinkDirectoryComponents(dirPath: string) {
  const absolute = path.resolve(dirPath);
  const anchor = trustedDirectoryAnchor(absolute);
  let current = absolute;

  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw Object.assign(new Error(`refusing unsafe directory component: ${current}`), {
          code: "CPB_DIRECTORY_SYNC_UNSAFE",
        });
      }
    } catch (error) {
      if (codeOf(error) !== "ENOENT") throw error;
    }

    if (current === anchor) return;
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function ensureSafeDirectory(dirPath: string) {
  await assertNoSymlinkDirectoryComponents(dirPath);
  await mkdir(dirPath, { recursive: true });
  await assertNoSymlinkDirectoryComponents(dirPath);
  await assertSafeDirectory(dirPath);
}

async function assertSafeDirectory(dirPath: string) {
  let dir: FileHandle | null = null;
  let primary: unknown;
  let hasPrimary = false;
  const secondary: unknown[] = [];

  try {
    dir = await open(dirPath, directoryOpenFlags());
    const info = await dir.stat();
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw Object.assign(new Error(`refusing unsafe parent directory: ${dirPath}`), {
        code: "CPB_DIRECTORY_SYNC_UNSAFE",
      });
    }
  } catch (error) {
    primary = error;
    hasPrimary = true;
  } finally {
    secondary.push(...await closeHandle(dir));
  }

  if (hasPrimary) aggregateErrors(primary, secondary, `failed to validate directory ${dirPath}`);
  if (secondary.length > 0) throw secondary[0];
}

async function syncDirectory(dirPath: string) {
  let dir: FileHandle | null = null;
  let primary: unknown;
  let hasPrimary = false;
  const secondary: unknown[] = [];

  try {
    dir = await open(dirPath, directoryOpenFlags());
    const info = await dir.stat();
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw Object.assign(new Error(`refusing to fsync unsafe directory handle: ${dirPath}`), {
        code: "CPB_DIRECTORY_SYNC_UNSAFE",
      });
    }
    await dir.sync();
  } catch (error) {
    primary = error;
    hasPrimary = true;
  } finally {
    secondary.push(...await closeHandle(dir));
  }

  if (hasPrimary) aggregateErrors(primary, secondary, `failed to fsync directory ${dirPath}`);
  if (secondary.length > 0) throw secondary[0];
}

/**
 * Atomic JSON write with file and parent-directory fsync.
 * If JsonAtomicDurabilityError is thrown, the rename has committed but the
 * parent directory durability is ambiguous.
 */
export async function writeJsonAtomic(filePath: string, data: unknown) {
  const content = jsonContent(data);
  const dirPath = path.dirname(filePath);
  const tmp = tempPathFor(filePath);
  let fh: FileHandle | null = null;
  let primary: unknown;
  let hasPrimary = false;
  const secondary: unknown[] = [];
  let renameCommitted = false;
  let renameStateUnknown = false;
  let temporaryCreated = false;
  let temporaryGeneration: FileGeneration | null = null;
  const activeHooks = currentHooks();

  await ensureSafeDirectory(dirPath);

  try {
    fh = await activeHooks.open(tmp, openNoFollowFlags(true), 0o600);
    temporaryCreated = true;
    await fh.writeFile(content, "utf8");
    await fh.sync();
    temporaryGeneration = await handleGeneration(fh);
    const closeErrors = await closeHandle(fh);
    fh = null;
    if (closeErrors.length > 0) throw closeErrors[0];
    await assertSafeDirectory(dirPath);
    try {
      await activeHooks.rename(tmp, filePath);
    } catch (error) {
      try {
        const [sourceGeneration, destinationGeneration] = await Promise.all([
          pathGeneration(tmp),
          pathGeneration(filePath),
        ]);
        renameCommitted = sourceGeneration === null
          && destinationGeneration !== null
          && temporaryGeneration !== null
          && sameFileGenerationAcrossRename(temporaryGeneration, destinationGeneration);
        renameStateUnknown = !renameCommitted
          && !(sourceGeneration !== null
            && temporaryGeneration !== null
            && sameFileGeneration(temporaryGeneration, sourceGeneration));
      } catch (inspectionError) {
        renameStateUnknown = true;
        secondary.push(inspectionError);
      }
      throw error;
    }
    renameCommitted = true;
    await activeHooks.syncParentDirectory(dirPath);
  } catch (error) {
    primary = renameCommitted
      ? new JsonAtomicDurabilityError(filePath, error)
      : error;
    hasPrimary = true;
  } finally {
    secondary.push(...await closeHandle(fh));
  }

  if (hasPrimary && !renameCommitted) {
    primary = new JsonWriteRecoveryError(
      renameStateUnknown
        ? `atomic JSON write publication state is ambiguous; manual recovery is required: ${filePath}`
        : temporaryCreated
          ? `atomic JSON write failed before publication; temporary generation retained: ${tmp}`
          : `atomic JSON write failed before a temporary generation was created: ${filePath}`,
      temporaryCreated ? [tmp, filePath] : [filePath],
      primary,
      renameStateUnknown ? { committed: null, renameCommitted: null } : undefined,
    );
  }

  if (hasPrimary) {
    aggregateErrors(primary, secondary, `failed atomic JSON write for ${filePath}`);
  }
}

/**
 * Write-once: fails if file already exists (O_EXCL).
 * Returns true if written, false if already exists.
 * Use for result files that must not be overwritten.
 */
export async function writeJsonOnce(filePath: string, data: unknown) {
  const content = jsonContent(data);
  const dirPath = path.dirname(filePath);
  let fh: FileHandle | null = null;
  let primary: unknown;
  let hasPrimary = false;
  const secondary: unknown[] = [];
  let created = false;
  let createdGeneration: FileGeneration | null = null;
  const activeHooks = currentHooks();

  await ensureSafeDirectory(dirPath);

  try {
    fh = await activeHooks.open(filePath, openNoFollowFlags(true), 0o600);
    created = true;
    await fh.writeFile(content, "utf8");
    await fh.sync();
    createdGeneration = await handleGeneration(fh);
  } catch (err) {
    if (!created && codeOf(err) === "EEXIST") return false;
    primary = err;
    hasPrimary = true;
  } finally {
    if (fh && created && createdGeneration === null) {
      try {
        createdGeneration = await handleGeneration(fh);
      } catch (error) {
        if (hasPrimary) secondary.push(error);
        else {
          primary = error;
          hasPrimary = true;
        }
      }
    }
    const closeErrors = await closeHandle(fh);
    if (!hasPrimary && closeErrors.length > 0) {
      primary = closeErrors.shift();
      hasPrimary = true;
    }
    secondary.push(...closeErrors);
  }

  if (hasPrimary && created) {
    let successorPreserved = false;
    try {
      const currentGeneration = await pathGeneration(filePath);
      successorPreserved = currentGeneration !== null
        && createdGeneration !== null
        && !sameFileGeneration(createdGeneration, currentGeneration);
    } catch (inspectionError) {
      secondary.push(inspectionError);
    }
    primary = new JsonWriteRecoveryError(
      successorPreserved
        ? `write-once JSON publication failed after the path was replaced; successor preserved: ${filePath}`
        : `write-once JSON publication failed; manual recovery is required: ${filePath}`,
      [filePath],
      primary,
      { successorPreserved },
    );
  }

  if (hasPrimary) {
    aggregateErrors(primary, secondary, `failed write-once JSON write for ${filePath}`);
  }

  const verifyCreatedGeneration = async () => {
    const currentGeneration = await pathGeneration(filePath);
    if (
      createdGeneration === null
      || currentGeneration === null
      || !sameFileGeneration(createdGeneration, currentGeneration)
    ) {
      const successorPreserved = currentGeneration !== null;
      throw new JsonWriteRecoveryError(
        successorPreserved
          ? `write-once JSON path was replaced before durability confirmation; successor preserved: ${filePath}`
          : `write-once JSON path disappeared before durability confirmation: ${filePath}`,
        [filePath],
        Object.assign(new Error(`write-once generation changed: ${filePath}`), {
          code: "CPB_JSON_GENERATION_REPLACED",
        }),
        { successorPreserved },
      );
    }
  };

  await assertSafeDirectory(dirPath);
  await verifyCreatedGeneration();

  try {
    await activeHooks.syncParentDirectory(dirPath);
  } catch (error) {
    let currentGeneration: FileGeneration | null = null;
    let inspectionError: unknown;
    let inspectionFailed = false;
    try {
      currentGeneration = await pathGeneration(filePath);
    } catch (caught) {
      inspectionError = caught;
      inspectionFailed = true;
    }
    if (
      inspectionFailed
      || createdGeneration === null
      || currentGeneration === null
      || !sameFileGeneration(createdGeneration, currentGeneration)
    ) {
      const successorPreserved = currentGeneration !== null;
      const cause = inspectionFailed
        ? new AggregateError(
          [error, inspectionError],
          `parent fsync and generation inspection failed for ${filePath}`,
          { cause: error },
        )
        : error;
      throw new JsonWriteRecoveryError(
        successorPreserved
          ? `write-once JSON path was replaced while parent durability was ambiguous; successor preserved: ${filePath}`
          : `write-once JSON path disappeared while parent durability was ambiguous: ${filePath}`,
        [filePath],
        cause,
        { committed: null, successorPreserved },
      );
    }
    throw new JsonAtomicDurabilityError(filePath, error, {
      publicationKind: "exclusive-create",
      renameCommitted: false,
    });
  }

  await verifyCreatedGeneration();

  return true;
}
