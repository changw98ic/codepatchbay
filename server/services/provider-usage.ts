/**
 * Provider Usage — JSONL-based phase-level usage tracking.
 *
 * Records provider usage per phase to {hubRoot}/providers/usage.jsonl.
 * Phase-level (not per-call): runJob() enqueues after each phase completes.
 *
 * Write: _internalAppendUsageLine (delegate + tests only — production callers use quota-delegate-client.js)
 * Read:  readProviderUsage, readProviderUsageRollup, readSystemUsageRollup
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { mkdir, lstat, open } from "node:fs/promises";
import path from "node:path";
import { isRecord, type LooseRecord } from "../../shared/types.js";
import { providerFamilyFor } from "../../core/agents/outcome-routing.js";
import {
  readBoundedRegularFileNoFollow,
  type BoundedRegularFileReadHooks,
} from "../../core/runtime/durable-directory-lock.js";

const USAGE_FILE = "usage.jsonl";
const PROVIDER_USAGE_MAX_BYTES = 4 * 1024 * 1024;
const PROVIDER_USAGE_READ_MAX_ATTEMPTS = 5;

export type UsageRecord = LooseRecord & {
  providerKey: string;
  agent?: string;
  jobId?: string | null;
  taskCategory?: string | null;
  phase?: string | null;
  role?: string | null;
  phaseStatus?: string | null;
  failureKind?: string | null;
  retryCount?: number | null;
  phaseRetryCount?: number | null;
  jobRetryCount?: number | null;
  isRetry?: boolean | null;
  recordedAt?: string | null;
  status: string;
  usage?: LooseRecord & {
    calls?: number | null;
    totalTokens?: number | null;
    tokens?: number | null;
    costUsd?: number | null;
    tokenSource?: string | null;
  } | null;
  fallback?: LooseRecord & {
    used?: boolean | null;
  } | null;
  quota?: LooseRecord & {
    status?: string | null;
  } | null;
  durationMs?: number;
};

type JsonRecord = {
  [key: string]: unknown;
};

type ProviderRollup = JsonRecord & {
  providerKey: string;
  calls: number;
  ok: number;
  errors: number;
  rateLimited: number;
  llmCalls: number;
  tokens: number | null;
  reportedTokens: number;
  reportedTokenCalls: number;
  unreportedTokenCalls: number;
  tokenCoverage: number | null;
  tokenSource: string | null;
  tokenSources: string[];
  unreportedTokenSources: string[];
  costUsd: number | null;
  reportedCostUsd: number;
  reportedCostCalls: number;
  unreportedCostCalls: number;
  costCoverage: number | null;
  fallbacks: number;
  quotaEvents: number;
  totalDurationMs: number;
};

type FileGeneration = {
  dev: number | bigint;
  ino: number | bigint;
  size: number | bigint;
  mtimeMs: number | bigint;
  ctimeMs: number | bigint;
  birthtimeMs: number | bigint;
};

type DirectoryAuthority = {
  dirPath: string;
  generation: FileGeneration;
};

export interface ProviderUsagePersistenceHooks {
  readHooks?: BoundedRegularFileReadHooks;
  beforeAppendOpen?: (context: { filePath: string; record: UsageRecord }) => void | Promise<void>;
  afterAppendOpen?: (context: { filePath: string; record: UsageRecord }) => void | Promise<void>;
  afterAppendWrite?: (context: {
    filePath: string;
    record: UsageRecord;
    bytesWritten: number;
  }) => void | Promise<void>;
  beforeDirectorySync?: (context: {
    directory: string;
    phase: "providers-create" | "before-append" | "after-append";
  }) => void | Promise<void>;
}

const providerUsagePersistenceHookStorage = new AsyncLocalStorage<Readonly<ProviderUsagePersistenceHooks>>();

export async function withProviderUsagePersistenceHooksForTests<T>(
  hooks: ProviderUsagePersistenceHooks,
  operation: () => Promise<T>,
) {
  const inherited = providerUsagePersistenceHookStorage.getStore();
  const readHooks = inherited?.readHooks || hooks.readHooks
    ? Object.freeze({ ...inherited?.readHooks, ...hooks.readHooks })
    : undefined;
  return await providerUsagePersistenceHookStorage.run(
    Object.freeze({ ...inherited, ...hooks, ...(readHooks ? { readHooks } : {}) }),
    operation,
  );
}

function currentProviderUsagePersistenceHooks() {
  return providerUsagePersistenceHookStorage.getStore();
}

class ProviderUsageContractError extends Error {
  code: string;

  constructor(message: string, cause?: unknown, code = "PROVIDER_USAGE_CONTRACT_INVALID") {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProviderUsageContractError";
    this.code = code;
  }
}

function providerUsageLocation(filePath: string, lineNumber: number | null) {
  return lineNumber === null ? `${filePath} before append` : `${filePath} at line ${lineNumber}`;
}

function invalidProviderUsage(filePath: string, lineNumber: number | null, detail: string): never {
  throw new ProviderUsageContractError(
    `provider usage contract invalid in ${providerUsageLocation(filePath, lineNumber)}: ${detail}`,
  );
}

function validateNullableStringField(
  record: LooseRecord,
  field: string,
  filePath: string,
  lineNumber: number | null,
) {
  const value = record[field];
  if (value !== undefined && value !== null && typeof value !== "string") {
    invalidProviderUsage(filePath, lineNumber, `${field} must be a string or null when present`);
  }
}

function validateNullableNonNegativeNumberField(
  record: LooseRecord,
  field: string,
  filePath: string,
  lineNumber: number | null,
  integer = false,
) {
  const value = record[field];
  if (value === undefined || value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    invalidProviderUsage(
      filePath,
      lineNumber,
      `${field} must be a non-negative ${integer ? "integer" : "finite number"} or null when present`,
    );
  }
}

function validateProviderUsageRecord(value: unknown, filePath: string, lineNumber: number | null): UsageRecord {
  if (!isRecord(value)) invalidProviderUsage(filePath, lineNumber, "expected an object");
  if (typeof value.providerKey !== "string" || !value.providerKey.trim()) {
    invalidProviderUsage(filePath, lineNumber, "providerKey must be a non-empty string");
  }
  if (typeof value.status !== "string" || !value.status.trim()) {
    invalidProviderUsage(filePath, lineNumber, "status must be a non-empty string");
  }

  for (const field of [
    "agent",
    "jobId",
    "taskCategory",
    "phase",
    "role",
    "phaseStatus",
    "failureKind",
    "recordedAt",
  ]) {
    validateNullableStringField(value, field, filePath, lineNumber);
  }
  for (const field of ["retryCount", "phaseRetryCount", "jobRetryCount"]) {
    validateNullableNonNegativeNumberField(value, field, filePath, lineNumber, true);
  }
  if (value.isRetry !== undefined && value.isRetry !== null && typeof value.isRetry !== "boolean") {
    invalidProviderUsage(filePath, lineNumber, "isRetry must be a boolean or null when present");
  }
  validateNullableNonNegativeNumberField(value, "durationMs", filePath, lineNumber);

  if (value.usage !== undefined && value.usage !== null) {
    if (!isRecord(value.usage)) invalidProviderUsage(filePath, lineNumber, "usage must be an object or null when present");
    for (const field of ["calls", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens", "tokens", "toolCalls", "functionCalls"]) {
      validateNullableNonNegativeNumberField(value.usage, field, filePath, lineNumber, true);
    }
    validateNullableNonNegativeNumberField(value.usage, "costUsd", filePath, lineNumber);
    validateNullableStringField(value.usage, "tokenSource", filePath, lineNumber);
  }

  if (value.fallback !== undefined && value.fallback !== null) {
    if (!isRecord(value.fallback)) invalidProviderUsage(filePath, lineNumber, "fallback must be an object or null when present");
    if (value.fallback.used !== undefined && value.fallback.used !== null && typeof value.fallback.used !== "boolean") {
      invalidProviderUsage(filePath, lineNumber, "fallback.used must be a boolean or null when present");
    }
  }

  if (value.quota !== undefined && value.quota !== null) {
    if (!isRecord(value.quota)) invalidProviderUsage(filePath, lineNumber, "quota must be an object or null when present");
    validateNullableStringField(value.quota, "status", filePath, lineNumber);
  }

  return value as UsageRecord;
}

export function _internalValidateProviderUsageInput(value: unknown): LooseRecord {
  return validateProviderUsageRecord(value, "quota delegate usage command", null);
}

function parseProviderUsageLine(line: string, filePath: string, lineNumber: number): UsageRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new ProviderUsageContractError(
      `provider usage contract invalid in ${filePath} at line ${lineNumber}: invalid JSON`,
      err,
    );
  }
  return validateProviderUsageRecord(parsed, filePath, lineNumber);
}

function isMissingFileError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? Math.floor(number) : fallback;
}

function coverage(reported: number, total: number): number | null {
  return total > 0 ? reported / total : null;
}

function sortedStrings(values: Set<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function usageFilePath(hubRoot: string) {
  return path.join(path.resolve(hubRoot), "providers", USAGE_FILE);
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

function providerUsageDirectoryError(message: string, cause?: unknown) {
  return Object.assign(
    new ProviderUsageContractError(message, cause, "PROVIDER_USAGE_DIRECTORY_UNSAFE"),
    { code: "PROVIDER_USAGE_DIRECTORY_UNSAFE" },
  );
}

function sameDirectoryIdentity(left: DirectoryAuthority, right: DirectoryAuthority) {
  return left.generation.dev === right.generation.dev
    && left.generation.ino === right.generation.ino
    && left.generation.birthtimeMs === right.generation.birthtimeMs;
}

async function readDirectoryAuthority(dirPath: string) {
  let info;
  try {
    info = await lstat(dirPath);
  } catch (error) {
    throw providerUsageDirectoryError(`provider usage directory is unavailable: ${dirPath}`, error);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw providerUsageDirectoryError(`provider usage path is not a safe directory: ${dirPath}`);
  }
  return { dirPath, generation: fileGenerationFromStat(info) } satisfies DirectoryAuthority;
}

function strictDirectoryOpenFlags(dirPath: string) {
  if (
    typeof constants.O_NOFOLLOW !== "number"
    || constants.O_NOFOLLOW === 0
    || typeof constants.O_DIRECTORY !== "number"
    || constants.O_DIRECTORY === 0
  ) {
    throw providerUsageDirectoryError(`strict directory open flags are unavailable: ${dirPath}`);
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY;
}

async function repinDirectoryAuthority(authority: DirectoryAuthority) {
  const current = await readDirectoryAuthority(authority.dirPath);
  if (!sameDirectoryIdentity(authority, current)) {
    throw providerUsageDirectoryError(`provider usage directory identity changed: ${authority.dirPath}`);
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(authority.dirPath, strictDirectoryOpenFlags(authority.dirPath));
  } catch (error) {
    throw providerUsageDirectoryError(`provider usage directory could not be pinned safely: ${authority.dirPath}`, error);
  }
  let primaryError: unknown = null;
  try {
    const opened = await handle.stat();
    const afterPath = await readDirectoryAuthority(authority.dirPath);
    if (
      !opened.isDirectory()
      || opened.dev !== current.generation.dev
      || opened.ino !== current.generation.ino
      || opened.birthtimeMs !== current.generation.birthtimeMs
      || !sameDirectoryIdentity(current, afterPath)
    ) {
      throw providerUsageDirectoryError(`provider usage directory changed while pinning: ${authority.dirPath}`);
    }
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown = null;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError) {
    const primary = asError(primaryError);
    if (closeError) {
      throw Object.assign(
        new AggregateError([primary, asError(closeError)], primary.message, { cause: primary }),
        { code: errorCode(primary) || "PROVIDER_USAGE_DIRECTORY_UNSAFE", primaryError: primary, closeError },
      );
    }
    throw primary;
  }
  if (closeError) throw closeError;
  return current;
}

async function ensureSafeProviderDirectory(hubRoot: string, create: boolean) {
  const rootPath = path.resolve(hubRoot);
  let root: DirectoryAuthority;
  try {
    root = await readDirectoryAuthority(rootPath);
  } catch (error) {
    if (!create && isMissingFileError((error as Error & { cause?: unknown }).cause)) return null;
    throw error;
  }
  const providersPath = path.join(rootPath, "providers");
  let created = false;
  if (create) {
    try {
      await mkdir(providersPath, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  let providers: DirectoryAuthority;
  try {
    providers = await readDirectoryAuthority(providersPath);
  } catch (error) {
    if (!create && isMissingFileError((error as Error & { cause?: unknown }).cause)) return null;
    throw error;
  }
  await repinDirectoryAuthority(root);
  await repinDirectoryAuthority(providers);
  return { root, providers, created };
}

async function syncDirectory(
  authority: DirectoryAuthority,
  phase: "providers-create" | "before-append" | "after-append",
  hooks?: Readonly<ProviderUsagePersistenceHooks>,
) {
  await hooks?.beforeDirectorySync?.({ directory: authority.dirPath, phase });
  const before = await repinDirectoryAuthority(authority);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      authority.dirPath,
      strictDirectoryOpenFlags(authority.dirPath),
    );
  } catch (error) {
    throw providerUsageDirectoryError(`provider usage directory could not be opened safely: ${authority.dirPath}`, error);
  }
  let primaryError: unknown = null;
  try {
    const opened = await handle.stat();
    if (
      !opened.isDirectory()
      || opened.dev !== before.generation.dev
      || opened.ino !== before.generation.ino
      || opened.birthtimeMs !== before.generation.birthtimeMs
    ) {
      throw providerUsageDirectoryError(`provider usage directory changed while opening: ${authority.dirPath}`);
    }
    await handle.sync();
    const afterDescriptor = await handle.stat();
    const afterPath = await readDirectoryAuthority(authority.dirPath);
    if (
      !afterDescriptor.isDirectory()
      || afterDescriptor.dev !== opened.dev
      || afterDescriptor.ino !== opened.ino
      || afterDescriptor.birthtimeMs !== opened.birthtimeMs
      || !sameDirectoryIdentity(before, afterPath)
    ) {
      throw providerUsageDirectoryError(`provider usage directory changed during sync: ${authority.dirPath}`);
    }
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown = null;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError) {
    const primary = asError(primaryError);
    if (closeError) {
      throw Object.assign(
        new AggregateError([primary, asError(closeError)], primary.message, { cause: primary }),
        { code: errorCode(primary) || "PROVIDER_USAGE_DIRECTORY_UNSAFE", primaryError: primary, closeError },
      );
    }
    throw primary;
  }
  if (closeError) throw closeError;
}

function fileGenerationFromStat(stat: Awaited<ReturnType<typeof lstat>>): FileGeneration {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    birthtimeMs: stat.birthtimeMs,
  };
}

async function fileGeneration(filePath: string): Promise<FileGeneration | null> {
  try {
    const stat = await lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ProviderUsageContractError(`provider usage contract invalid in ${filePath}: expected a regular file`);
    }
    return fileGenerationFromStat(stat);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function sameFileGeneration(left: FileGeneration | null, right: FileGeneration | null) {
  return left === null || right === null
    ? left === right
    : left.dev === right.dev
      && left.ino === right.ino
      && left.size === right.size
      && left.mtimeMs === right.mtimeMs
      && left.ctimeMs === right.ctimeMs
      && left.birthtimeMs === right.birthtimeMs;
}

function noFollowFlag(filePath: string) {
  if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
    throw new ProviderUsageContractError(`provider usage contract invalid in ${filePath}: no-follow opens are unavailable`);
  }
  return constants.O_NOFOLLOW;
}

function mergeReadHooks(
  hooks: Readonly<ProviderUsagePersistenceHooks> | undefined,
  captureGeneration: (filePath: string) => Promise<void>,
): BoundedRegularFileReadHooks {
  const userHooks = hooks?.readHooks;
  return {
    afterOpen: userHooks?.afterOpen,
    afterChunk: userHooks?.afterChunk,
    beforePathGenerationCheck: async (context) => {
      await userHooks?.beforePathGenerationCheck?.(context);
      await captureGeneration(context.filePath);
    },
  };
}

function delayForStableRead(attempt: number) {
  const delayMs = Math.min(8, 2 ** Math.max(0, attempt - 1));
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function readUsageFileNoFollow(
  hubRoot: string,
  filePath: string,
  hooks?: Readonly<ProviderUsagePersistenceHooks>,
): Promise<{ content: string; generation: FileGeneration | null }> {
  noFollowFlag(filePath);
  const safeDirectory = await ensureSafeProviderDirectory(hubRoot, false);
  if (!safeDirectory) return { content: "", generation: null };
  let lastGenerationError: unknown = null;
  for (let attempt = 1; attempt <= PROVIDER_USAGE_READ_MAX_ATTEMPTS; attempt += 1) {
    let generation: FileGeneration | null = null;
    await repinDirectoryAuthority(safeDirectory.providers);
    try {
      const content = await readBoundedRegularFileNoFollow(filePath, {
        maxBytes: PROVIDER_USAGE_MAX_BYTES,
        hooks: mergeReadHooks(hooks, async (readPath) => {
          generation = await fileGeneration(readPath);
        }),
      });
      await repinDirectoryAuthority(safeDirectory.providers);
      return { content, generation };
    } catch (error) {
      if (isMissingFileError(error)) {
        await repinDirectoryAuthority(safeDirectory.providers);
        return { content: "", generation: null };
      }
      if (errorCode(error) === "BOUNDED_FILE_UNSAFE") {
        throw new ProviderUsageContractError(
          `provider usage contract invalid in ${filePath}: expected a regular no-follow file`,
          error,
        );
      }
      if (errorCode(error) === "BOUNDED_FILE_TOO_LARGE") {
        throw new ProviderUsageContractError(
          `provider usage contract invalid in ${filePath}: file exceeded the bounded read limit`,
          error,
        );
      }
      if (errorCode(error) !== "BOUNDED_FILE_CHANGED") throw error;
      lastGenerationError = error;
      if (attempt < PROVIDER_USAGE_READ_MAX_ATTEMPTS) {
        await delayForStableRead(attempt);
        continue;
      }
      throw Object.assign(
        new ProviderUsageContractError(
          `provider usage in ${filePath} could not reach a stable generation after ${attempt} attempts`,
          lastGenerationError,
          "PROVIDER_USAGE_READ_UNSTABLE",
        ),
        {
          code: "PROVIDER_USAGE_READ_UNSTABLE",
          attempts: attempt,
          maxAttempts: PROVIDER_USAGE_READ_MAX_ATTEMPTS,
          committed: false,
          recoveryPaths: [filePath, safeDirectory.providers.dirPath],
        },
      );
    }
  }
  throw new ProviderUsageContractError(
    `provider usage in ${filePath} exhausted its stable-read attempts`,
    lastGenerationError,
    "PROVIDER_USAGE_READ_UNSTABLE",
  );
}

function parseProviderUsageContent(content: string, filePath: string) {
  const records: UsageRecord[] = [];
  for (const [index, line] of content.split("\n").entries()) {
    if (!line.trim()) continue;
    records.push(parseProviderUsageLine(line, filePath, index + 1));
  }
  return records;
}

function providerUsageSourceChangedError(filePath: string, record: UsageRecord) {
  const dirPath = path.dirname(filePath);
  return Object.assign(
    new ProviderUsageContractError(
      `provider usage in ${filePath} changed before append publication; successor preserved`,
      undefined,
      "PROVIDER_USAGE_SOURCE_CHANGED",
    ),
    {
      code: "PROVIDER_USAGE_SOURCE_CHANGED",
      committed: false,
      providerKey: record.providerKey,
      recoveryPaths: [filePath, dirPath],
    },
  );
}

function providerUsageAppendPathChangedError(filePath: string) {
  return Object.assign(
    new ProviderUsageContractError(
      `provider usage append reached a non-canonical generation in ${filePath}`,
      undefined,
      "PROVIDER_USAGE_APPEND_PATH_CHANGED",
    ),
    { code: "PROVIDER_USAGE_APPEND_PATH_CHANGED" },
  );
}

async function inspectCanonicalUsageCommit(
  filePath: string,
  authority: DirectoryAuthority,
  committedGeneration: FileGeneration | null,
) {
  await repinDirectoryAuthority(authority);
  const generation = await fileGeneration(filePath);
  await repinDirectoryAuthority(authority);
  return {
    generation,
    committedPath: committedGeneration && sameFileGeneration(committedGeneration, generation)
      ? filePath
      : null,
  };
}

function providerUsageAppendNotStartedError(filePath: string, record: UsageRecord, error: unknown) {
  return Object.assign(asError(error), {
    committed: false,
    commitState: "not-started",
    committedPath: null,
    providerKey: record.providerKey,
    recoveryPaths: [filePath, path.dirname(filePath)],
    residualPaths: [],
    bytesWritten: 0,
  });
}

async function appendUsageRecordDurably(
  hubRoot: string,
  filePath: string,
  record: UsageRecord,
  sourceGeneration: FileGeneration | null,
  hooks?: Readonly<ProviderUsagePersistenceHooks>,
) {
  const dirPath = path.dirname(filePath);
  const line = `${JSON.stringify(record)}\n`;
  const lineBuffer = Buffer.from(line, "utf8");
  let safeDirectory: NonNullable<Awaited<ReturnType<typeof ensureSafeProviderDirectory>>>;
  let flags: number;
  try {
    const preparedDirectory = await ensureSafeProviderDirectory(hubRoot, true);
    if (!preparedDirectory) {
      throw providerUsageDirectoryError(`provider usage directory could not be created safely: ${dirPath}`);
    }
    safeDirectory = preparedDirectory;
    if (safeDirectory.created) {
      await syncDirectory(safeDirectory.root, "providers-create", hooks);
    }
    await syncDirectory(safeDirectory.providers, "before-append", hooks);
    await hooks?.beforeAppendOpen?.({ filePath, record });
    await repinDirectoryAuthority(safeDirectory.providers);
    flags = constants.O_WRONLY
      | constants.O_APPEND
      | noFollowFlag(filePath)
      | (sourceGeneration === null ? constants.O_CREAT | constants.O_EXCL : 0);
  } catch (error) {
    throw providerUsageAppendNotStartedError(filePath, record, error);
  }
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let writeAttempted = false;
  let bytesWritten = 0;
  let primaryError: unknown = null;
  let openedGeneration: FileGeneration | null = null;
  let committedGeneration: FileGeneration | null = null;
  let canonicalGeneration: FileGeneration | null = null;
  let committedPath: string | null = null;
  const cleanupErrors: Error[] = [];
  try {
    handle = await open(filePath, flags, 0o600);
    const opened = await handle.stat();
    openedGeneration = fileGenerationFromStat(opened);
    if (!opened.isFile() || (sourceGeneration !== null && !sameFileGeneration(sourceGeneration, openedGeneration))) {
      throw providerUsageSourceChangedError(filePath, record);
    }
    const initialPathGeneration = await fileGeneration(filePath);
    if (!sameFileGeneration(openedGeneration, initialPathGeneration)) {
      throw providerUsageSourceChangedError(filePath, record);
    }
    if (Number(opened.size) + lineBuffer.byteLength > PROVIDER_USAGE_MAX_BYTES) {
      throw new ProviderUsageContractError(
        `provider usage append would exceed the ${PROVIDER_USAGE_MAX_BYTES} byte bounded read limit in ${filePath}`,
      );
    }
    await hooks?.afterAppendOpen?.({ filePath, record });
    await repinDirectoryAuthority(safeDirectory.providers);
    const retainedPathGeneration = await fileGeneration(filePath);
    if (!sameFileGeneration(openedGeneration, retainedPathGeneration)) {
      throw providerUsageSourceChangedError(filePath, record);
    }
    writeAttempted = true;
    const result = await handle.write(lineBuffer, 0, lineBuffer.byteLength, null);
    bytesWritten = result.bytesWritten;
    if (bytesWritten !== lineBuffer.byteLength) {
      throw Object.assign(
        new Error(`provider usage append wrote ${bytesWritten} of ${lineBuffer.byteLength} bytes`),
        { code: "PROVIDER_USAGE_APPEND_PARTIAL" },
      );
    }
    await hooks?.afterAppendWrite?.({ filePath, record, bytesWritten });
    await handle.sync();
  } catch (error) {
    if (sourceGeneration === null && errorCode(error) === "EEXIST") {
      primaryError = providerUsageSourceChangedError(filePath, record);
    } else if (["ELOOP", "EMLINK"].includes(errorCode(error))) {
      primaryError = new ProviderUsageContractError(
        `provider usage contract invalid in ${filePath}: expected a regular no-follow file`,
        error,
      );
    } else {
      primaryError = error;
    }
  }
  if (handle && bytesWritten > 0) {
    try {
      const committed = await handle.stat();
      committedGeneration = fileGenerationFromStat(committed);
      canonicalGeneration = await fileGeneration(filePath);
      await repinDirectoryAuthority(safeDirectory.providers);
      if (committed.isFile() && sameFileGeneration(committedGeneration, canonicalGeneration)) {
        committedPath = filePath;
      } else if (!primaryError) {
        primaryError = providerUsageAppendPathChangedError(filePath);
      }
    } catch (error) {
      cleanupErrors.push(asError(error));
      if (!primaryError) primaryError = error;
    }
  }
  let closeError: unknown = null;
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      closeError = error;
    }
  }
  if (bytesWritten > 0) {
    canonicalGeneration = null;
    committedPath = null;
    try {
      const inspected = await inspectCanonicalUsageCommit(
        filePath,
        safeDirectory.providers,
        committedGeneration,
      );
      canonicalGeneration = inspected.generation;
      committedPath = inspected.committedPath;
      if (!committedPath && !primaryError) {
        primaryError = providerUsageAppendPathChangedError(filePath);
      }
    } catch (error) {
      committedPath = null;
      cleanupErrors.push(asError(error));
      if (!primaryError) primaryError = error;
    }
  }
  if (primaryError) {
    const primary = asError(primaryError);
    const secondary = [...cleanupErrors, ...(closeError ? [asError(closeError)] : [])];
    const aggregate = secondary.length > 0
      ? new AggregateError([primary, ...secondary], primary.message, { cause: primary })
      : primary;
    const committed = bytesWritten > 0;
    throw Object.assign(aggregate, {
      code: committed
        ? "PROVIDER_USAGE_APPEND_COMMITTED_DURABILITY_AMBIGUOUS"
        : ((primary as NodeJS.ErrnoException).code || "PROVIDER_USAGE_APPEND_FAILED"),
      primaryError: primary,
      cleanupErrors: secondary,
      committed,
      commitState: committed ? "committed" : (writeAttempted ? "unknown" : "not-started"),
      committedPath,
      providerKey: record.providerKey,
      recoveryPaths: [filePath, dirPath],
      residualPaths: canonicalGeneration ? [filePath] : [],
      bytesWritten,
      expectedBytes: lineBuffer.byteLength,
      expectedSourceGeneration: sourceGeneration,
      openedFileIdentity: openedGeneration,
      committedFileIdentity: committedGeneration,
      canonicalFileIdentity: canonicalGeneration,
    });
  }
  if (closeError) {
    const committed = bytesWritten > 0;
    throw Object.assign(asError(closeError), {
      code: committed ? "PROVIDER_USAGE_APPEND_COMMITTED_DURABILITY_AMBIGUOUS" : "PROVIDER_USAGE_APPEND_FAILED",
      committed,
      commitState: committed ? "committed" : (writeAttempted ? "unknown" : "not-started"),
      committedPath,
      providerKey: record.providerKey,
      recoveryPaths: [filePath, dirPath],
      residualPaths: canonicalGeneration ? [filePath] : [],
      bytesWritten,
      expectedBytes: lineBuffer.byteLength,
      expectedSourceGeneration: sourceGeneration,
      openedFileIdentity: openedGeneration,
      committedFileIdentity: committedGeneration,
      canonicalFileIdentity: canonicalGeneration,
    });
  }
  let publicationError: unknown = null;
  try {
    await syncDirectory(safeDirectory.providers, "after-append", hooks);
    canonicalGeneration = null;
    committedPath = null;
    const inspected = await inspectCanonicalUsageCommit(
      filePath,
      safeDirectory.providers,
      committedGeneration,
    );
    canonicalGeneration = inspected.generation;
    committedPath = inspected.committedPath;
    if (!committedPath) throw providerUsageAppendPathChangedError(filePath);
  } catch (error) {
    publicationError = error;
    canonicalGeneration = null;
    committedPath = null;
    try {
      const inspected = await inspectCanonicalUsageCommit(
        filePath,
        safeDirectory.providers,
        committedGeneration,
      );
      canonicalGeneration = inspected.generation;
      committedPath = inspected.committedPath;
    } catch (inspectionError) {
      publicationError = new AggregateError(
        [asError(error), asError(inspectionError)],
        asError(error).message,
        { cause: error },
      );
    }
  }
  if (publicationError) {
    throw Object.assign(asError(publicationError), {
      code: "PROVIDER_USAGE_APPEND_COMMITTED_DURABILITY_AMBIGUOUS",
      committed: true,
      commitState: "committed",
      committedPath,
      providerKey: record.providerKey,
      recoveryPaths: [filePath, dirPath],
      residualPaths: canonicalGeneration ? [filePath] : [],
      bytesWritten,
      expectedBytes: lineBuffer.byteLength,
      expectedSourceGeneration: sourceGeneration,
      openedFileIdentity: openedGeneration,
      committedFileIdentity: committedGeneration,
      canonicalFileIdentity: canonicalGeneration,
    });
  }
}

/**
 * Low-level JSONL append. Internal — only quota-delegate.js and tests should call.
 * Production callers must use quota-delegate-client.delegateEnqueueProviderUsage().
 * @param {string} hubRoot
 * @param {object} record — already-normalized entry
 */
const appendQueues = new Map<string, Promise<UsageRecord | null>>();

async function appendUsageLine(
  hubRoot: string,
  record: LooseRecord,
  hooks?: Readonly<ProviderUsagePersistenceHooks>,
) {
  const filePath = usageFilePath(hubRoot);
  const validated = validateProviderUsageRecord(record, filePath, null);
  const { content, generation } = await readUsageFileNoFollow(hubRoot, filePath, hooks);
  const existing = parseProviderUsageContent(content, filePath);
  if (typeof validated.mutationId === "string" && typeof validated.commandDigest === "string") {
    const duplicate = existing.find((entry) => (
      entry.mutationId === validated.mutationId
      && entry.commandDigest === validated.commandDigest
    ));
    if (duplicate) return duplicate;
    const conflict = existing.find((entry) => entry.mutationId === validated.mutationId);
    if (conflict) {
      throw new ProviderUsageContractError(
        `provider usage mutationId conflict in ${filePath}: ${validated.mutationId}`,
      );
    }
  }
  await appendUsageRecordDurably(hubRoot, filePath, validated, generation, hooks);
  return validated;
}

export function _internalAppendUsageLine(hubRoot: string, record: LooseRecord) {
  const filePath = usageFilePath(hubRoot);
  const hooks = currentProviderUsagePersistenceHooks();
  const previous = appendQueues.get(filePath) || Promise.resolve(null);
  const next = previous.then(() => appendUsageLine(hubRoot, record, hooks));
  const tracked = next.then(() => null, () => null);
  appendQueues.set(filePath, tracked);
  void tracked.finally(() => {
    if (appendQueues.get(filePath) === tracked) appendQueues.delete(filePath);
  });
  return next;
}

// ─── Read API ───────────────────────────────────────────────────────

/**
 * Read all usage records from the JSONL log.
 * @param {string} hubRoot
 * @returns {Promise<Array>}
 */
export async function readProviderUsage(hubRoot: string): Promise<UsageRecord[]> {
  const filePath = usageFilePath(hubRoot);
  const { content } = await readUsageFileNoFollow(hubRoot, filePath, currentProviderUsagePersistenceHooks());
  return parseProviderUsageContent(content, filePath);
}

/**
 * Provider-level rollup: calls, successes, failures, tokens per provider.
 * @param {string} hubRoot
 * @returns {Promise<Object>} keyed by providerKey
 */
export async function readProviderUsageRollup(hubRoot: string): Promise<Record<string, ProviderRollup>> {
  const records = await readProviderUsage(hubRoot);
  const rollup: Record<string, ProviderRollup> = {};
  const sourcesByProvider = new Map<string, Set<string>>();
  const missingSourcesByProvider = new Map<string, Set<string>>();

  for (const r of records) {
    const key = r.providerKey || "unknown";
    if (!rollup[key]) {
      rollup[key] = {
        providerKey: key,
        agent: r.agent,
        calls: 0,
        ok: 0,
        errors: 0,
        rateLimited: 0,
        llmCalls: 0,
        tokens: 0,
        reportedTokens: 0,
        reportedTokenCalls: 0,
        unreportedTokenCalls: 0,
        tokenCoverage: null,
        tokenSource: null,
        tokenSources: [],
        unreportedTokenSources: [],
        costUsd: 0,
        reportedCostUsd: 0,
        reportedCostCalls: 0,
        unreportedCostCalls: 0,
        costCoverage: null,
        fallbacks: 0,
        quotaEvents: 0,
        totalDurationMs: 0,
      };
      sourcesByProvider.set(key, new Set());
      missingSourcesByProvider.set(key, new Set());
    }
    const u = rollup[key];
    u.calls += 1;
    if (r.status === "ok") u.ok += 1;
    else if (r.status === "rate_limited" || r.status === "fallback") u.rateLimited += 1;
    else u.errors += 1;
    const llmCalls = nonNegativeInt(r.usage?.calls, 1);
    const totalTokens = finiteNumber(r.usage?.totalTokens) ?? finiteNumber(r.usage?.tokens);
    const costUsd = finiteNumber(r.usage?.costUsd);
    const tokenSource = typeof r.usage?.tokenSource === "string" && r.usage.tokenSource.trim()
      ? r.usage.tokenSource.trim()
      : "unspecified";
    u.llmCalls += llmCalls;
    if (llmCalls > 0 && totalTokens !== null) {
      u.reportedTokens += totalTokens;
      u.reportedTokenCalls += llmCalls;
      sourcesByProvider.get(key)?.add(tokenSource);
    } else if (llmCalls > 0) {
      u.unreportedTokenCalls += llmCalls;
      missingSourcesByProvider.get(key)?.add(tokenSource);
    }
    if (llmCalls > 0 && costUsd !== null) {
      u.reportedCostUsd += costUsd;
      u.reportedCostCalls += llmCalls;
    } else if (llmCalls > 0) {
      u.unreportedCostCalls += llmCalls;
    }
    if (r.fallback?.used) u.fallbacks += 1;
    if (r.quota?.status != null) u.quotaEvents += 1;
    const durationMs = finiteNumber(r.durationMs);
    if (durationMs !== null) u.totalDurationMs += durationMs;
  }

  for (const [key, provider] of Object.entries(rollup)) {
    provider.tokenCoverage = coverage(provider.reportedTokenCalls, provider.llmCalls);
    provider.costCoverage = coverage(provider.reportedCostCalls, provider.llmCalls);
    provider.tokens = provider.unreportedTokenCalls === 0 ? provider.reportedTokens : null;
    provider.costUsd = provider.unreportedCostCalls === 0 ? provider.reportedCostUsd : null;
    provider.tokenSources = sortedStrings(sourcesByProvider.get(key) || new Set());
    provider.unreportedTokenSources = sortedStrings(missingSourcesByProvider.get(key) || new Set());
    provider.tokenSource = provider.tokenSources.length === 1
      ? provider.tokenSources[0]
      : provider.tokenSources.length > 1 ? "mixed" : null;
  }

  return rollup;
}

/**
 * System-level rollup: aggregate across all providers.
 * @param {string} hubRoot
 * @returns {Promise<object>}
 */
export async function readSystemUsageRollup(hubRoot: string) {
  const providerRollup = await readProviderUsageRollup(hubRoot);
  const providers = Object.values(providerRollup);

  const llmCalls = providers.reduce((sum, provider) => sum + provider.llmCalls, 0);
  const reportedTokenCalls = providers.reduce((sum, provider) => sum + provider.reportedTokenCalls, 0);
  const unreportedTokenCalls = providers.reduce((sum, provider) => sum + provider.unreportedTokenCalls, 0);
  const reportedTokens = providers.reduce((sum, provider) => sum + provider.reportedTokens, 0);
  const reportedCostCalls = providers.reduce((sum, provider) => sum + provider.reportedCostCalls, 0);
  const unreportedCostCalls = providers.reduce((sum, provider) => sum + provider.unreportedCostCalls, 0);
  const reportedCostUsd = providers.reduce((sum, provider) => sum + provider.reportedCostUsd, 0);

  return {
    totalCalls: providers.reduce((s, p) => s + p.calls, 0),
    totalOk: providers.reduce((s, p) => s + p.ok, 0),
    totalErrors: providers.reduce((s, p) => s + p.errors, 0),
    totalRateLimited: providers.reduce((s, p) => s + p.rateLimited, 0),
    llmCalls,
    totalTokens: unreportedTokenCalls === 0 ? reportedTokens : null,
    reportedTokens,
    reportedTokenCalls,
    unreportedTokenCalls,
    tokenCoverage: coverage(reportedTokenCalls, llmCalls),
    totalCostUsd: unreportedCostCalls === 0 ? reportedCostUsd : null,
    reportedCostUsd,
    reportedCostCalls,
    unreportedCostCalls,
    costCoverage: coverage(reportedCostCalls, llmCalls),
    totalFallbacks: providers.reduce((s, p) => s + p.fallbacks, 0),
    totalQuotaEvents: providers.reduce((s, p) => s + p.quotaEvents, 0),
    providerCount: providers.length,
    providers: providerRollup,
  };
}

/**
 * Outcome metrics for agent routing. This intentionally excludes token and
 * cost data: resource telemetry must not become a proxy for solution quality.
 * Executor verification quality is joined by jobId against the verifier phase.
 */
export async function readAgentRoutingMetrics(hubRoot: string, query: LooseRecord = {}) {
  const records = await readProviderUsage(hubRoot);
  const phase = typeof query.phase === "string" ? query.phase : null;
  const role = typeof query.role === "string" ? query.role : null;
  const taskCategory = typeof query.taskCategory === "string" ? query.taskCategory : "unknown";
  const scoped = records.filter((record) =>
    (!phase || record.phase === phase) && (!role || record.role === role),
  );
  const verifierByJob = new Map<string, boolean>();
  for (const record of records) {
    if (!record.jobId || record.role !== "verifier") continue;
    const passed = record.phaseStatus === "passed" || record.status === "ok";
    verifierByJob.set(record.jobId, (verifierByJob.get(record.jobId) ?? true) && passed);
  }

  const byAgent = new Map<string, UsageRecord[]>();
  for (const record of scoped) {
    const agent = typeof record.agent === "string" && record.agent ? record.agent : null;
    if (!agent) continue;
    const entries = byAgent.get(agent) || [];
    entries.push(record);
    byAgent.set(agent, entries);
  }

  const agents: Record<string, LooseRecord> = {};
  for (const [agent, allEntries] of byAgent) {
    const exactEntries = allEntries.filter((entry) => entry.taskCategory === taskCategory);
    const entries = (exactEntries.length >= 8 ? exactEntries : allEntries).slice(-100);
    const scope = exactEntries.length >= 8 ? "task_category_phase_role" : "phase_role";
    const scopeConfidence = scope === "task_category_phase_role" || taskCategory === "unknown" ? 1 : 0.5;
    let successes = 0;
    let retries = 0;
    let timeouts = 0;
    let verifierRuns = 0;
    let verifierPasses = 0;
    let totalDurationMs = 0;
    const failureKinds: Record<string, number> = {};
    const providerCounts = new Map<string, number>();

    for (const entry of entries) {
      const passed = entry.phaseStatus === "passed" || entry.status === "ok";
      if (passed) successes += 1;
      if (entry.isRetry === true || (finiteNumber(entry.retryCount) ?? 0) > 0) retries += 1;
      if (entry.status === "timeout" || entry.failureKind === "timeout") timeouts += 1;
      const duration = finiteNumber(entry.durationMs);
      if (duration !== null) totalDurationMs += duration;
      if (entry.failureKind) failureKinds[entry.failureKind] = (failureKinds[entry.failureKind] || 0) + 1;
      if (entry.providerKey) providerCounts.set(entry.providerKey, (providerCounts.get(entry.providerKey) || 0) + 1);

      if (role === "executor" && entry.jobId && verifierByJob.has(entry.jobId)) {
        verifierRuns += 1;
        if (verifierByJob.get(entry.jobId)) verifierPasses += 1;
      } else if (role === "verifier") {
        verifierRuns += 1;
        if (passed) verifierPasses += 1;
      }
    }

    const providerKey = [...providerCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] || null;
    agents[agent] = {
      agent,
      providerKey,
      providerFamily: providerFamilyFor(agent, providerKey),
      phase,
      role,
      taskCategory,
      scope,
      scopeConfidence,
      sampleSize: entries.length,
      successes,
      retries,
      timeouts,
      verifierRuns,
      verifierPasses,
      evidenceCoverage: role === "executor"
        ? coverage(verifierRuns, entries.length) ?? 0
        : 1,
      totalDurationMs,
      failureKinds,
    };
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    query: { phase, role, taskCategory },
    historyLimitPerAgent: 100,
    agents,
  };
}
