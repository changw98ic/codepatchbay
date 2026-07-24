import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord, type LooseRecord } from "../../shared/types.js";
import {
  readBoundedRegularFileNoFollow,
  type BoundedRegularFileReadHooks,
} from "../../core/runtime/durable-directory-lock.js";
import { constants } from "node:fs";
/**
 * Provider Quota — centralised provider availability state.
 *
 * Central source of truth for provider health, quota exhaustion, and
 * back-off scheduling.
 *
 * Durable file: {hubRoot}/providers/quotas.json
 */

import { lstat, mkdir, open, rename } from "node:fs/promises";
import path from "node:path";

// ─── Status Enum ────────────────────────────────────────────────────
export const QuotaStatus = Object.freeze({
  AVAILABLE: "available",
  RATE_LIMITED: "rate_limited",
  WINDOW_EXHAUSTED: "window_exhausted",
  WEEKLY_EXHAUSTED: "weekly_exhausted",
  AUTH_ERROR: "auth_error",
  UNKNOWN: "unknown",
});

const PROVIDER_UNAVAILABLE_STATUSES: readonly string[] = Object.freeze([
  QuotaStatus.RATE_LIMITED,
  QuotaStatus.WINDOW_EXHAUSTED,
  QuotaStatus.WEEKLY_EXHAUSTED,
  QuotaStatus.AUTH_ERROR,
  QuotaStatus.UNKNOWN,
]);

type ProviderQuotaEntry = LooseRecord & {
  providerKey?: string;
  agent?: string;
  variant?: string | null;
  status: string;
  nextEligibleAt?: number | null;
  source?: string;
  confidence?: number;
  reason?: string;
  updatedAt?: string;
  mutationId?: string;
  commandDigest?: string;
};

type ProviderQuotaMap = Record<string, ProviderQuotaEntry>;

type ProviderQuotaRead = {
  quotas: ProviderQuotaMap;
  sourcePath: string | null;
  sourceGeneration: FileGeneration | null;
  canonicalGeneration: FileGeneration | null;
};

interface ProviderQuotaPersistenceHooks {
  readHooks?: BoundedRegularFileReadHooks;
  beforeRename?: (context: { filePath: string; tempPath: string; providerKey: string; entry: ProviderQuotaEntry }) => void | Promise<void>;
  afterRename?: (context: { filePath: string; tempPath: string; providerKey: string; entry: ProviderQuotaEntry }) => void | Promise<void>;
}

const providerQuotaPersistenceHookStorage = new AsyncLocalStorage<ProviderQuotaPersistenceHooks>();

export function withProviderQuotaPersistenceHooksForTests<T>(
  hooks: ProviderQuotaPersistenceHooks,
  action: () => T,
): T {
  const parent = providerQuotaPersistenceHookStorage.getStore() || {};
  return providerQuotaPersistenceHookStorage.run({ ...parent, ...hooks }, action);
}

class ProviderQuotaContractError extends Error {
  code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProviderQuotaContractError";
    this.code = code;
  }
}

type FileGeneration = {
  dev: number | bigint;
  ino: number | bigint;
  size: number | bigint;
  mtimeMs: number | bigint;
  ctimeMs: number | bigint;
  birthtimeMs: number | bigint;
};

const PROVIDER_QUOTAS_MAX_BYTES = 1024 * 1024;

// ─── Error ──────────────────────────────────────────────────────────
export class ProviderQuotaError extends Error {
  providerKey: string;
  agent: string;
  variant: string | null;
  status: string;
  nextEligibleAt: number | null;
  source: string;
  confidence: number;
  reason: string;
  phase: string | null;
  role: string | null;

  /**
   * @param {string} message
   * @param {object} opts
   * @param {string} opts.providerKey
   * @param {string} opts.agent
   * @param {string} [opts.variant]
   * @param {string} opts.status        - one of QuotaStatus
   * @param {number} [opts.nextEligibleAt] - unix ms
   * @param {string} [opts.source]
   * @param {number} [opts.confidence]  - 0..1
   * @param {string} [opts.reason]
   * @param {string} [opts.phase]
   * @param {string} [opts.role]
   */
  constructor(message: string, opts: {
    providerKey: string;
    agent: string;
    variant?: string | null;
    status: string;
    nextEligibleAt?: number | null;
    source?: string;
    confidence?: number;
    reason?: string;
    phase?: string | null;
    role?: string | null;
  }) {
    super(redactSecrets(message));
    this.name = "ProviderQuotaError";
    this.providerKey = opts.providerKey;
    this.agent = opts.agent;
    this.variant = opts.variant || null;
    this.status = opts.status;
    this.nextEligibleAt = opts.nextEligibleAt ?? null;
    this.source = opts.source || "provider-quota";
    this.confidence = opts.confidence ?? 1;
    this.reason = redactSecrets(opts.reason || message);
    this.phase = opts.phase || null;
    this.role = opts.role || null;
  }
}

// ─── Secret Redaction ───────────────────────────────────────────────
export function redactSecrets(text: unknown) {
  if (!text) return "";
  return String(text)
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/Authorization:\s*\S+/gi, "Authorization: [REDACTED]")
    .replace(/api[_-]?key=\S+/gi, "api_key=[REDACTED]")
    .replace(/sk-\S+/gi, "sk-[REDACTED]")
    .replace(/OPENAI_API_KEY=\S+/gi, "OPENAI_API_KEY=[REDACTED]")
    .replace(/ANTHROPIC_API_KEY=\S+/gi, "ANTHROPIC_API_KEY=[REDACTED]")
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .slice(0, 500);
}

// ─── Persistence ────────────────────────────────────────────────────
function quotasFilePath(hubRoot: string) {
  return path.join(hubRoot, "providers", "quotas.json");
}

function legacyRateLimitsFilePath(hubRoot: string) {
  return path.join(hubRoot, "providers", "rate-limits.json");
}

function invalidQuotaEntry(filePath: string, providerKey: string, detail: string): never {
  throw new ProviderQuotaContractError(
    "PROVIDER_QUOTA_ENTRY_CONTRACT_INVALID",
    `provider quota entry '${providerKey}' in ${filePath} is invalid: ${detail}`,
  );
}

function validateProviderQuotaEntry(value: unknown, providerKey: string, filePath: string): ProviderQuotaEntry {
  if (!isRecord(value)) invalidQuotaEntry(filePath, providerKey, "expected an object");

  if (value.providerKey !== undefined && (typeof value.providerKey !== "string" || !value.providerKey.trim())) {
    invalidQuotaEntry(filePath, providerKey, "providerKey must be a non-empty string when present");
  }
  if (typeof value.providerKey === "string" && value.providerKey !== providerKey) {
    invalidQuotaEntry(filePath, providerKey, `providerKey must match the canonical map key '${providerKey}'`);
  }
  if (value.agent !== undefined && typeof value.agent !== "string") {
    invalidQuotaEntry(filePath, providerKey, "agent must be a string when present");
  }
  if (value.variant !== undefined && value.variant !== null && typeof value.variant !== "string") {
    invalidQuotaEntry(filePath, providerKey, "variant must be a string or null when present");
  }
  if (typeof value.status !== "string" || !(Object.values(QuotaStatus) as string[]).includes(value.status)) {
    invalidQuotaEntry(filePath, providerKey, `status is required and must be one of ${Object.values(QuotaStatus).join(", ")}`);
  }
  if (value.nextEligibleAt !== undefined && value.nextEligibleAt !== null) {
    if (typeof value.nextEligibleAt !== "number" || !Number.isFinite(value.nextEligibleAt) || value.nextEligibleAt < 0) {
      invalidQuotaEntry(filePath, providerKey, "nextEligibleAt must be a non-negative finite number or null when present");
    }
  }
  if (value.source !== undefined && typeof value.source !== "string") {
    invalidQuotaEntry(filePath, providerKey, "source must be a string when present");
  }
  if (value.confidence !== undefined) {
    if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
      invalidQuotaEntry(filePath, providerKey, "confidence must be a finite number from 0 to 1 when present");
    }
  }
  if (value.reason !== undefined && typeof value.reason !== "string") {
    invalidQuotaEntry(filePath, providerKey, "reason must be a string when present");
  }
  if (value.updatedAt !== undefined && typeof value.updatedAt !== "string") {
    invalidQuotaEntry(filePath, providerKey, "updatedAt must be a string when present");
  }
  if (value.mutationId !== undefined && typeof value.mutationId !== "string") {
    invalidQuotaEntry(filePath, providerKey, "mutationId must be a string when present");
  }
  if (value.commandDigest !== undefined && typeof value.commandDigest !== "string") {
    invalidQuotaEntry(filePath, providerKey, "commandDigest must be a string when present");
  }

  return value as ProviderQuotaEntry;
}

export function _internalValidateProviderUnavailableInput(
  providerKeyValue: unknown,
  value: unknown,
): LooseRecord {
  if (typeof providerKeyValue !== "string" || !providerKeyValue.trim()) {
    throw new ProviderQuotaContractError(
      "PROVIDER_QUOTA_ENTRY_CONTRACT_INVALID",
      "quota delegate quota command providerKey must be a non-empty string",
    );
  }
  const validated = validateProviderQuotaEntry(value, providerKeyValue, "quota delegate quota command");
  if (!PROVIDER_UNAVAILABLE_STATUSES.includes(validated.status)) {
    invalidQuotaEntry(
      "quota delegate quota command",
      providerKeyValue,
      `status must be one of ${PROVIDER_UNAVAILABLE_STATUSES.join(", ")}`,
    );
  }
  return validated;
}

function validateProviderQuotas(value: unknown, filePath: string): ProviderQuotaMap {
  if (!isRecord(value)) {
    throw new ProviderQuotaContractError(
      "PROVIDER_QUOTAS_CONTRACT_INVALID",
      `provider quotas in ${filePath} must be a keyed object`,
    );
  }

  const quotas: ProviderQuotaMap = {};
  for (const [providerKey, entry] of Object.entries(value)) {
    if (!providerKey.trim()) {
      throw new ProviderQuotaContractError(
        "PROVIDER_QUOTAS_CONTRACT_INVALID",
        `provider quotas in ${filePath} contain an empty provider key`,
      );
    }
    quotas[providerKey] = validateProviderQuotaEntry(entry, providerKey, filePath);
  }
  return quotas;
}

function parseProviderQuotaJson(raw: string, filePath: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ProviderQuotaContractError(
      "PROVIDER_QUOTAS_CONTRACT_INVALID",
      `provider quotas in ${filePath} contain invalid JSON`,
      err,
    );
  }
  return parsed;
}

function parseProviderQuotas(raw: string, filePath: string): ProviderQuotaMap {
  return validateProviderQuotas(parseProviderQuotaJson(raw, filePath), filePath);
}

function validateAndNormalizeLegacyProviderQuotaEntry(
  value: unknown,
  providerKey: string,
  filePath: string,
): ProviderQuotaEntry {
  if (!isRecord(value)) invalidQuotaEntry(filePath, providerKey, "legacy entry must be an object");
  if (typeof value.untilTs !== "string" || !value.untilTs.trim()) {
    invalidQuotaEntry(filePath, providerKey, "legacy untilTs must be a non-empty timestamp string");
  }
  const nextEligibleAt = Date.parse(value.untilTs);
  if (!Number.isFinite(nextEligibleAt) || nextEligibleAt < 0) {
    invalidQuotaEntry(filePath, providerKey, "legacy untilTs must be a valid timestamp");
  }
  if (value.reason !== undefined && typeof value.reason !== "string") {
    invalidQuotaEntry(filePath, providerKey, "legacy reason must be a string when present");
  }

  return {
    ...value,
    providerKey,
    agent: providerKey,
    status: QuotaStatus.RATE_LIMITED,
    nextEligibleAt,
    source: "legacy-rate-limits",
    confidence: 1,
    reason: typeof value.reason === "string" ? value.reason : "",
  } as ProviderQuotaEntry;
}

function validateAndNormalizeLegacyProviderQuotas(value: unknown, filePath: string): ProviderQuotaMap {
  if (!isRecord(value)) {
    throw new ProviderQuotaContractError(
      "PROVIDER_QUOTAS_CONTRACT_INVALID",
      `legacy provider quotas in ${filePath} must be a keyed object`,
    );
  }

  const quotas: ProviderQuotaMap = {};
  for (const [providerKey, entry] of Object.entries(value)) {
    if (!providerKey.trim()) {
      throw new ProviderQuotaContractError(
        "PROVIDER_QUOTAS_CONTRACT_INVALID",
        `legacy provider quotas in ${filePath} contain an empty provider key`,
      );
    }
    quotas[providerKey] = validateAndNormalizeLegacyProviderQuotaEntry(entry, providerKey, filePath);
  }
  return quotas;
}

function parseLegacyProviderQuotas(raw: string, filePath: string): ProviderQuotaMap {
  return validateAndNormalizeLegacyProviderQuotas(parseProviderQuotaJson(raw, filePath), filePath);
}

function isMissingFileError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

async function syncDirectory(dirPath: string) {
  if (
    typeof constants.O_NOFOLLOW !== "number"
    || constants.O_NOFOLLOW === 0
    || typeof constants.O_DIRECTORY !== "number"
    || constants.O_DIRECTORY === 0
  ) {
    throw Object.assign(new Error("safe provider quota directory fsync flags are unavailable"), {
      code: "PROVIDER_QUOTA_DIRECTORY_SYNC_UNSAFE",
    });
  }
  const handle = await open(dirPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let primaryError: unknown = null;
  try {
    const info = await handle.stat();
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw Object.assign(new Error(`provider quota parent is not a safe directory: ${dirPath}`), {
        code: "PROVIDER_QUOTA_DIRECTORY_SYNC_UNSAFE",
      });
    }
    await handle.sync();
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
    if (closeError) {
      const primary = asError(primaryError);
      throw new AggregateError([primary, asError(closeError)], primary.message, { cause: primary });
    }
    throw primaryError;
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
      throw new ProviderQuotaContractError(
        "PROVIDER_QUOTAS_CONTRACT_INVALID",
        `provider quotas in ${filePath} must be a regular file`,
      );
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

async function writeFileDurably(filePath: string, content: string) {
  if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
    throw Object.assign(new Error("O_NOFOLLOW is unavailable for provider quota publication"), {
      code: "PROVIDER_QUOTA_NOFOLLOW_UNAVAILABLE",
    });
  }
  const handle = await open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let primaryError: unknown = null;
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
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
    if (closeError) {
      const primary = asError(primaryError);
      throw new AggregateError([primary, asError(closeError)], primary.message, { cause: primary });
    }
    throw primaryError;
  }
  if (closeError) throw closeError;
}

function mergeReadHooks(captureGeneration: (filePath: string) => Promise<void>): BoundedRegularFileReadHooks {
  const userHooks = providerQuotaPersistenceHookStorage.getStore()?.readHooks;
  return {
    afterOpen: userHooks?.afterOpen,
    afterChunk: userHooks?.afterChunk,
    beforePathGenerationCheck: async (context) => {
      await userHooks?.beforePathGenerationCheck?.(context);
      await captureGeneration(context.filePath);
    },
  };
}

async function readFileNoFollow(filePath: string): Promise<{ content: string; generation: FileGeneration | null }> {
  let generation: FileGeneration | null = null;
  try {
    const content = await readBoundedRegularFileNoFollow(filePath, {
      maxBytes: PROVIDER_QUOTAS_MAX_BYTES,
      hooks: mergeReadHooks(async (readPath) => {
        generation = await fileGeneration(readPath);
      }),
    });
    return { content, generation };
  } catch (error) {
    if (isMissingFileError(error)) throw error;
    throw errorCode(error) === "BOUNDED_FILE_UNSAFE"
      ? new ProviderQuotaContractError(
        "PROVIDER_QUOTAS_CONTRACT_INVALID",
        `provider quotas in ${filePath} must be a regular no-follow file`,
        error,
      )
      : errorCode(error) === "BOUNDED_FILE_TOO_LARGE" || errorCode(error) === "BOUNDED_FILE_CHANGED"
        ? new ProviderQuotaContractError(
          "PROVIDER_QUOTAS_CONTRACT_INVALID",
          `provider quotas in ${filePath} changed or exceeded the bounded read limit`,
          error,
        )
        : error;
  }
}

async function readProviderQuotaFile(
  filePath: string,
  parse: (raw: string, sourcePath: string) => ProviderQuotaMap,
): Promise<{ quotas: ProviderQuotaMap; generation: FileGeneration | null }> {
  const { content, generation } = await readFileNoFollow(filePath);
  return { quotas: parse(content, filePath), generation };
}

async function readProviderQuotasForWrite(hubRoot: string): Promise<ProviderQuotaRead> {
  const canonicalPath = quotasFilePath(hubRoot);
  try {
    const { quotas, generation } = await readProviderQuotaFile(canonicalPath, parseProviderQuotas);
    return {
      quotas,
      sourcePath: canonicalPath,
      sourceGeneration: generation,
      canonicalGeneration: generation,
    };
  } catch (err) {
    if (!isMissingFileError(err)) throw err;
    const legacyPath = legacyRateLimitsFilePath(hubRoot);
    try {
      const { quotas, generation } = await readProviderQuotaFile(legacyPath, parseLegacyProviderQuotas);
      return {
        quotas,
        sourcePath: legacyPath,
        sourceGeneration: generation,
        canonicalGeneration: null,
      };
    } catch (legacyErr) {
      if (isMissingFileError(legacyErr)) {
        return {
          quotas: {},
          sourcePath: null,
          sourceGeneration: null,
          canonicalGeneration: null,
        };
      }
      throw legacyErr;
    }
  }
}

export async function readProviderQuotas(hubRoot: string): Promise<ProviderQuotaMap> {
  return (await readProviderQuotasForWrite(hubRoot)).quotas;
}

// In-process write queue to prevent concurrent write corruption
const _writeQueues = new Map<string, Promise<LooseRecord | null>>();

export async function _internalWriteProviderQuota(hubRoot: string, providerKey: string, entry: LooseRecord) {
  const filePath = quotasFilePath(hubRoot);
  const queueKey = filePath;
  const prev = _writeQueues.get(queueKey) || Promise.resolve();
  const next = prev.catch(() => null).then(async () => {
    const persistenceHooks = providerQuotaPersistenceHookStorage.getStore();
    // Re-read latest to avoid clobbering concurrent writes
    const read = await readProviderQuotasForWrite(hubRoot);
    const current = read.quotas;
    current[providerKey] = validateProviderQuotaEntry({
      ...entry,
      reason: redactSecrets(entry.reason),
      providerKey,
      updatedAt: new Date().toISOString(),
    }, providerKey, filePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await syncDirectory(path.dirname(filePath));
    const randomSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tmp = `${filePath}.tmp-${randomSuffix}`;
    let committed = false;
    let primaryError: unknown = null;
    try {
      await writeFileDurably(tmp, `${JSON.stringify(current, null, 2)}\n`);
      await persistenceHooks?.beforeRename?.({
        filePath,
        tempPath: tmp,
        providerKey,
        entry: current[providerKey],
      });
      const currentGeneration = await fileGeneration(filePath);
      const sourceCurrentGeneration = read.sourcePath === null ? null : await fileGeneration(read.sourcePath);
      if (
        !sameFileGeneration(read.canonicalGeneration, currentGeneration)
        || !sameFileGeneration(read.sourceGeneration, sourceCurrentGeneration)
      ) {
        throw Object.assign(
          new ProviderQuotaContractError(
            "PROVIDER_QUOTAS_SOURCE_CHANGED",
            `provider quotas in ${filePath} changed before quota publication; successor preserved`,
          ),
          {
            code: "PROVIDER_QUOTAS_SOURCE_CHANGED",
            committed: false,
            providerKey,
            recoveryPaths: [filePath, tmp, path.dirname(filePath)],
          },
        );
      }
      await rename(tmp, filePath);
      committed = true;
      await persistenceHooks?.afterRename?.({
        filePath,
        tempPath: tmp,
        providerKey,
        entry: current[providerKey],
      });
      await syncDirectory(path.dirname(filePath));
    } catch (error) {
      primaryError = error;
    }
    if (primaryError) {
      const primary = asError(primaryError);
      throw Object.assign(primary, {
        code: committed ? "PROVIDER_QUOTA_WRITE_COMMITTED_DURABILITY_AMBIGUOUS" : (primary as NodeJS.ErrnoException).code,
        committed,
        ...(committed ? { committedPath: filePath } : {}),
        providerKey,
        entry: current[providerKey],
        cleanupErrors: [],
        recoveryPaths: [filePath, tmp, path.dirname(filePath)],
      });
    }
    return current[providerKey];
  });
  _writeQueues.set(queueKey, next.catch(() => null));
  return next;
}

// ─── State Transitions ──────────────────────────────────────────────
interface MarkUnavailableOpts {
  providerKey: string;
  agent: string;
  variant?: string | null;
  status: string;
  nextEligibleAt?: number | null;
  source?: string;
  confidence?: number;
  reason?: string;
  mutationId?: string;
  commandDigest?: string;
}

export async function _internalMarkProviderUnavailable(hubRoot: string, {
  providerKey,
  agent,
  variant,
  status,
  nextEligibleAt,
  source,
  confidence,
  reason,
  mutationId,
  commandDigest,
}: MarkUnavailableOpts) {
  if (!PROVIDER_UNAVAILABLE_STATUSES.includes(status)) {
    throw new Error(`invalid unavailable status: ${status}`);
  }
  return _internalWriteProviderQuota(hubRoot, providerKey, {
    agent,
    variant: variant || null,
    status,
    ...(nextEligibleAt == null ? {} : { nextEligibleAt }),
    source: source || "provider-quota",
    confidence: confidence ?? 1,
    reason: reason || "",
    ...(mutationId ? { mutationId } : {}),
    ...(commandDigest ? { commandDigest } : {}),
  });
}

export async function _internalMarkProviderAvailable(hubRoot: string, providerKey: string) {
  const current = await readProviderQuotas(hubRoot);
  const existing = current[providerKey];
  return _internalWriteProviderQuota(hubRoot, providerKey, {
    agent: existing?.agent || providerKey,
    variant: existing?.variant || null,
    status: QuotaStatus.AVAILABLE,
    source: "mark-available",
    confidence: 1,
    reason: "",
  });
}

// ─── Gate ───────────────────────────────────────────────────────────
interface AssertAvailableOpts {
  providerKey: string;
  agent: string;
  variant?: string;
  phase?: string;
  role?: string;
}

export async function assertProviderAvailable(hubRoot: string, {
  providerKey,
  agent,
  variant,
  phase,
  role,
}: AssertAvailableOpts) {
  const quotas = await readProviderQuotas(hubRoot);
  const entry = quotas[providerKey];
  if (!entry) return; // no entry = never seen = available

  // Auth errors are terminal — don't retry until explicitly cleared
  if (entry.status === QuotaStatus.AUTH_ERROR) {
    throw new ProviderQuotaError(
      `provider ${providerKey} has auth error: ${entry.reason}`,
      {
        providerKey,
        agent,
        variant,
        status: QuotaStatus.AUTH_ERROR,
        source: entry.source,
        confidence: entry.confidence ?? 1,
        reason: entry.reason,
        phase,
        role,
      },
    );
  }

  // Check nextEligibleAt
  if (entry.nextEligibleAt != null) {
    const waitMs = entry.nextEligibleAt - Date.now();
    if (waitMs > 0) {
      throw new ProviderQuotaError(
        `provider ${providerKey} unavailable until ${new Date(entry.nextEligibleAt).toISOString()}: ${entry.reason}`,
        {
          providerKey,
          agent,
          variant,
          status: entry.status,
          nextEligibleAt: entry.nextEligibleAt,
          source: entry.source,
          confidence: entry.confidence ?? 1,
          reason: entry.reason,
          phase,
          role,
        },
      );
    }
    // Expired — treat as available (do not mutate durable state here;
    // delegate owns all writes; stale entries are reconciled by delegate or next write)
    return;
  }

  // Any explicitly unavailable state without a reset stays unavailable until
  // the delegate writes an available state. Missing reset data must not open
  // the provider gate.
  if (entry.status !== QuotaStatus.AVAILABLE && entry.nextEligibleAt == null) {
    throw new ProviderQuotaError(
      `provider ${providerKey} is ${entry.status}: ${entry.reason}`,
      {
        providerKey,
        agent,
        variant,
        status: entry.status,
        source: entry.source,
        confidence: entry.confidence ?? 1,
        reason: entry.reason,
        phase,
        role,
      },
    );
  }
}

// ─── Quota Failure Classification ───────────────────────────────────
const HTTP_RATE_LIMIT = /\b(?:429|529)\b|rate.?limit|too many requests|capacity|overloaded|over.?capacity|访问量过大|模型当前访问量|当前访问量过大|temporar(?:y|ily) unavailable/i;
const RETRY_AFTER_SEC = /(?:reset|retry|after)[^0-9]*(\d+)\s*(?:s|sec|seconds?)/i;
const ISO_DATE = /20\d\d-\d\d-\d\d[T\s]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?/;
const WINDOW_EXHAUST = /window.{0,40}(?:quota|limit|exhaust|reset)|(?:quota|limit|exhaust).{0,40}window|usage.?limit|monthly.?limit|5.?hour/i;
const WEEKLY_EXHAUST = /weekly|week.?limit/i;
const AUTH_FAIL = /(?:unauthorized|invalid api key|invalid token|expired token|authentication failed|auth failed|forbidden.*api key)/i;
const TOKEN_CONTEXT = /context.?length|max.?token|output.?token|token.?limit/i;

/**
 * Parse a reset time from an error message, respecting timezone.
 *
 * @param {string} message
 * @param {string} [timezone] - IANA timezone for naive timestamps (e.g. "Asia/Shanghai")
 * @param {number} [fallbackMs] - fallback wait in ms
 * @returns {number} unix ms
 */
export function parseResetTime(message: string, timezone: string | null, fallbackMs = 60_000): number {
  const text = String(message || "");
  const isoMatch = text.match(ISO_DATE);
  if (isoMatch) {
    let normalized = isoMatch[0].includes("T") ? isoMatch[0] : isoMatch[0].replace(" ", "T");
    const hasTz = /[zZ]|[+-]\d\d:?\d\d$/.test(normalized);
    if (hasTz) {
      // Explicit timezone — parse directly
      const parsed = Date.parse(normalized);
      if (Number.isFinite(parsed)) return parsed;
    } else if (timezone) {
      // Naive timestamp with known timezone — interpret as local time in that zone
      const parsed = parseNaiveTimestamp(normalized, timezone);
      if (Number.isFinite(parsed)) return parsed;
    } else {
      // No timezone, no zone hint — treat as UTC (legacy behavior)
      const parsed = Date.parse(`${normalized}Z`);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  const seconds = text.match(RETRY_AFTER_SEC);
  if (seconds) return Date.now() + Number(seconds[1]) * 1000;
  return Date.now() + fallbackMs;
}

/**
 * Interpret a naive ISO timestamp as local time in the given IANA timezone,
 * then return the equivalent UTC unix ms.
 *
 * e.g. "2026-05-31T12:00:00" in "Asia/Shanghai" → 2026-05-31T04:00:00Z
 */
function parseNaiveTimestamp(isoLocal: string, timezone: string): number {
  // Use Intl to get the UTC offset for the given timezone at that point in time.
  // We try: parse as UTC, then adjust by the offset difference.
  const utcGuess = Date.parse(isoLocal.endsWith("Z") ? isoLocal : `${isoLocal}Z`);
  if (!Number.isFinite(utcGuess)) return NaN;

  // Get the offset in minutes for the target timezone at that UTC moment
  const offsetMinutes = getTimezoneOffsetMinutes(utcGuess, timezone);
  if (offsetMinutes == null) return NaN;

  // The naive time is interpreted as (UTC - offsetMinutes)
  // So UTC = naiveUTC + offsetMinutes * 60_000
  // But we parsed it as UTC, so: realUTC = utcGuess - offsetMinutes * 60_000
  return utcGuess - offsetMinutes * 60_000;
}

function getTimezoneOffsetMinutes(utcMs: number, timezone: string) {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = dtf.formatToParts(new Date(utcMs));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const localMs = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    // offset = local - utc (positive for east of Greenwich)
    return (localMs - utcMs) / 60_000;
  } catch {
    return null;
  }
}

// ─── Classifier ─────────────────────────────────────────────────────
/**
 * Classify an ACP execution error as a quota failure or not.
 *
 * Pipeline:
 *   1. Deterministic parser (message patterns)
 *   2. Provider adapter parser (adapter.parseLimitError)
 *   3. Non-fault classifier (heuristic)
 *   4. Fixed backoff fallback
 *
 * @param {object} opts
 * @param {string} opts.providerKey
 * @param {string} opts.agent
 * @param {string} [opts.variant]
 * @param {Error} opts.error
 * @param {string} [opts.stdout]
 * @param {string} [opts.stderr]
 * @param {object} [opts.adapter] - provider adapter (optional)
 * @returns {Promise<{isQuota: boolean, status?: string, nextEligibleAt?: number, confidence?: number, reason?: string}>}
 */
interface ClassifyFailureOpts {
  providerKey: string;
  agent: string;
  variant?: string;
  error: Error;
  stdout?: string;
  stderr?: string;
  adapter?: {
    timezone?: string;
    parseLimitError?: (args: { error: Error; stdout?: string; stderr?: string }) => Promise<{
      isQuota: boolean;
      status?: string;
      nextEligibleAt?: number;
      confidence?: number;
      reason?: string;
    } | null>;
  };
}

export async function classifyQuotaFailure({ providerKey, agent, variant, error, stdout, stderr, adapter }: ClassifyFailureOpts) {
  const msg = error?.message || String(error || "");
  const combined = `${msg}\n${stderr || ""}\n${stdout || ""}`;

  if (error instanceof ProviderQuotaError) {
    return { isQuota: false };
  }

  // ── Layer 1: Deterministic parser ────────────────────────────────
  if (HTTP_RATE_LIMIT.test(combined)) {
    const timezone = adapter?.timezone || null;
    const nextEligibleAt = parseResetTime(combined, timezone);

    // Check for window / weekly exhaustion
    if (WEEKLY_EXHAUST.test(combined)) {
      return {
        isQuota: true,
        status: QuotaStatus.WEEKLY_EXHAUSTED,
        nextEligibleAt,
        confidence: 0.95,
        reason: `weekly quota exhausted: ${msg.slice(0, 200)}`,
      };
    }
    if (WINDOW_EXHAUST.test(combined)) {
      return {
        isQuota: true,
        status: QuotaStatus.WINDOW_EXHAUSTED,
        nextEligibleAt,
        confidence: 0.95,
        reason: `window quota exhausted: ${msg.slice(0, 200)}`,
      };
    }
    return {
      isQuota: true,
      status: QuotaStatus.RATE_LIMITED,
      nextEligibleAt,
      confidence: 0.9,
      reason: `rate limited: ${msg.slice(0, 200)}`,
    };
  }

  // Auth errors (exclude token/context-length false positives)
  if (AUTH_FAIL.test(msg) && !TOKEN_CONTEXT.test(msg)) {
    return {
      isQuota: true,
      status: QuotaStatus.AUTH_ERROR,
      nextEligibleAt: null,
      confidence: 0.85,
      reason: `auth error: ${msg.slice(0, 200)}`,
    };
  }

  // ── Layer 2: Adapter parser ──────────────────────────────────────
  if (adapter?.parseLimitError) {
    try {
      const adapterResult = await adapter.parseLimitError({ error, stdout, stderr });
      if (adapterResult?.isQuota) {
        return {
          isQuota: true,
          status: adapterResult.status || QuotaStatus.RATE_LIMITED,
          nextEligibleAt: adapterResult.nextEligibleAt ?? parseResetTime(combined, adapter.timezone || null),
          confidence: adapterResult.confidence ?? 0.8,
          reason: adapterResult.reason || `adapter detected quota: ${msg.slice(0, 200)}`,
        };
      }
    } catch {
      // Adapter parser failed — continue to next layer
    }
  }

  // ── Layer 3: Non-fault heuristic ─────────────────────────────────
  // Exhaustion keywords without explicit 429
  if (WINDOW_EXHAUST.test(combined)) {
    return {
      isQuota: true,
      status: QuotaStatus.WINDOW_EXHAUSTED,
      nextEligibleAt: Date.now() + 5 * 60 * 60 * 1000, // 5h default
      confidence: 0.6,
      reason: `possible window exhaustion: ${msg.slice(0, 200)}`,
    };
  }

  // ── Layer 4: Not a quota failure ─────────────────────────────────
  return { isQuota: false };
}

// ─── Fixed Backoff ──────────────────────────────────────────────────
const AMBIGUOUS_BACKOFFS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

/**
 * Compute backoff when all providers are unavailable.
 *
 * @param {object} opts
 * @param {number} [opts.retryAfter]     - explicit Retry-After ms
 * @param {number} [opts.windowReset]    - window reset unix ms
 * @param {number} [opts.weeklyReset]    - weekly reset unix ms
 * @param {number} [opts.ambiguous429Attempt] - 0-indexed attempt for ambiguous 429
 * @returns {{nextEligibleAt: number, reason: string}}
 */
interface FixedBackoffOpts {
  retryAfter?: number;
  windowReset?: number;
  weeklyReset?: number;
  ambiguous429Attempt?: number;
}

export function computeFixedBackoff({ retryAfter, windowReset, weeklyReset, ambiguous429Attempt = 0 }: FixedBackoffOpts) {
  if (retryAfter != null && retryAfter > 0) {
    return { nextEligibleAt: Date.now() + retryAfter, reason: `retry-after ${retryAfter}ms` };
  }
  if (windowReset != null && windowReset > Date.now()) {
    return { nextEligibleAt: windowReset, reason: `window reset at ${new Date(windowReset).toISOString()}` };
  }
  if (weeklyReset != null && weeklyReset > Date.now()) {
    return { nextEligibleAt: weeklyReset, reason: `weekly reset at ${new Date(weeklyReset).toISOString()}` };
  }
  const idx = Math.min(ambiguous429Attempt, AMBIGUOUS_BACKOFFS.length - 1);
  const ms = AMBIGUOUS_BACKOFFS[idx];
  return { nextEligibleAt: Date.now() + ms, reason: `ambiguous backoff attempt ${ambiguous429Attempt}: ${ms}ms` };
}

// ─── List ───────────────────────────────────────────────────────────
export async function listProviderQuotas(hubRoot: string) {
  const quotas = await readProviderQuotas(hubRoot);
  return Object.values(quotas);
}

// ─── Sanitize ───────────────────────────────────────────────────────
export function sanitizeProviderReason(reason: unknown) {
  if (!reason) return "";
  // Strip ANSI escapes, control chars, and limit length
  return String(reason)
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .slice(0, 500);
}

// ── Re-exports from merged modules ──
export { getProviderAdapter } from "./provider-adapters.js";
export { readProviderUsageRollup, readSystemUsageRollup } from "./provider-usage.js";
