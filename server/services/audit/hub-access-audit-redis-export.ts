import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename } from "node:fs/promises";
import path from "node:path";

import { readBoundedRegularFileNoFollow } from "../../../core/runtime/durable-directory-lock.js";
import type { HubRedisStateBackend } from "../../../shared/hub-state-redis.js";
import { fsyncDirectory, writeJsonDurableAtomic } from "../../../shared/hub-maintenance.js";
import { captureRedisHubAccessAudit, verifyHubAccessAuditFile } from "./hub-access-audit.js";

const EXPORT_FORMAT = "cpb-hub-redis-access-audit-export/v1";
const MANIFEST_FILE = "manifest.json";
const LOG_FILE = "http-access.jsonl";
const MANIFEST_MAX_BYTES = 64 * 1024;

type ExportSignature = { algorithm: "hmac-sha256"; value: string } | null;

type PathGeneration = {
  dev: bigint | number;
  ino: bigint | number;
  size: bigint | number;
  mtimeMs: bigint | number;
  ctimeMs: bigint | number;
  birthtimeMs: bigint | number;
};

type RedisAuditExportTestHooks = {
  syncDirectory?: (directory: string, operation: string) => void | Promise<void>;
  afterOutputReserved?: (context: { output: string; stage: string }) => void | Promise<void>;
  afterCanonicalParentAuthorityCaptured?: (context: {
    parent: string;
    output: string;
    stage: string;
  }) => void | Promise<void>;
  beforeStageRename?: (context: { output: string; stage: string }) => void | Promise<void>;
  afterPublicationAuthorityCheck?: (context: {
    output: string;
    stage: string;
    parent: string;
  }) => void | Promise<void>;
  afterStageRename?: (context: { output: string; stage: string }) => void | Promise<void>;
  afterManifestPreflight?: (context: { input: string; manifestPath: string }) => void | Promise<void>;
  afterLogPreflight?: (context: { input: string; logPath: string }) => void | Promise<void>;
  beforeVerifyAuditFile?: (context: { input: string; logPath: string }) => void | Promise<void>;
  beforeCleanupIsolation?: (context: {
    canonicalPath: string;
    isolatedPath: string;
    kind: "stage" | "reservation";
  }) => void | Promise<void>;
};

const redisAuditExportTestHookStorage = new AsyncLocalStorage<RedisAuditExportTestHooks>();

export type RedisAuditExportManifest = {
  format: typeof EXPORT_FORMAT;
  exportId: string;
  createdAt: string;
  backendIdentityFingerprint: string;
  recordCount: number;
  lastSequence: number;
  lastHash: string;
  sizeBytes: number;
  maxBytes: number;
  log: { path: typeof LOG_FILE; sha256: string; sizeBytes: number };
  manifestHash: string;
  signature: ExportSignature;
};

function exportError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

export async function withRedisAuditExportTestHooks<T>(
  hooks: RedisAuditExportTestHooks,
  fn: () => Promise<T>,
) {
  const parent = redisAuditExportTestHookStorage.getStore() || {};
  return redisAuditExportTestHookStorage.run({ ...parent, ...hooks }, fn);
}

async function syncExportDirectory(directory: string, operation: string) {
  await redisAuditExportTestHookStorage.getStore()?.syncDirectory?.(directory, operation);
  await fsyncDirectory(directory);
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

function noFollowFlag(filePath: string) {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_UNSAFE", `no-follow file opens are unavailable: ${filePath}`);
  }
  return constants.O_NOFOLLOW;
}

function exclusiveNoFollowWriteFlags(filePath: string) {
  return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(filePath);
}

function pathGeneration(info: Awaited<ReturnType<typeof lstat>>): PathGeneration {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    birthtimeMs: info.birthtimeMs,
  };
}

async function generationFor(target: string) {
  return pathGeneration(await lstat(target));
}

function sameGeneration(left: PathGeneration, right: PathGeneration) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && String(left.size) === String(right.size)
    && String(left.mtimeMs) === String(right.mtimeMs)
    && String(left.ctimeMs) === String(right.ctimeMs)
    && String(left.birthtimeMs) === String(right.birthtimeMs);
}

function sameGenerationAcrossRename(left: PathGeneration, right: PathGeneration) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && String(left.size) === String(right.size)
    && String(left.mtimeMs) === String(right.mtimeMs)
    && String(left.birthtimeMs) === String(right.birthtimeMs);
}

function sameDirectoryIdentity(left: PathGeneration, right: PathGeneration) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && String(left.birthtimeMs) === String(right.birthtimeMs);
}

function isInsideOrEqual(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === ""
    || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function nearestExistingDirectoryAncestor(target: string) {
  let candidate = path.resolve(target);
  for (;;) {
    try {
      const info = await lstat(candidate);
      if (candidate === path.resolve(target) && info.isSymbolicLink()) {
        throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "audit export parent must be a real directory");
      }
      const canonical = await realpath(candidate);
      const canonicalInfo = await lstat(canonical);
      if (canonicalInfo.isSymbolicLink() || !canonicalInfo.isDirectory()) {
        throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "audit export parent ancestor must resolve to a real directory");
      }
      return { requested: candidate, canonical, generation: pathGeneration(canonicalInfo) };
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function ensureCanonicalOutputParent(
  requestedParent: string,
  outputName: string,
  canonicalHubRoot: string,
) {
  const ancestor = await nearestExistingDirectoryAncestor(requestedParent);
  const relative = path.relative(ancestor.requested, requestedParent);
  const components = relative.split(path.sep).filter(Boolean);
  if (components.some((component) => component === "." || component === "..")) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "audit export parent traversal is invalid");
  }
  const prospectiveParent = path.join(ancestor.canonical, ...components);
  const prospectiveOutput = path.join(prospectiveParent, outputName);
  if (isInsideOrEqual(canonicalHubRoot, prospectiveOutput)) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "audit export canonical path must be outside the Hub root");
  }

  let current = ancestor.canonical;
  let currentGeneration = ancestor.generation;
  for (const component of components) {
    const child = path.join(current, component);
    let childInfo: Awaited<ReturnType<typeof lstat>>;
    try {
      childInfo = await lstat(child);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      await mkdir(child, { mode: 0o700 });
      childInfo = await lstat(child);
    }
    const parentAfter = await lstat(current);
    if (
      parentAfter.isSymbolicLink()
      || !parentAfter.isDirectory()
      || !sameDirectoryIdentity(currentGeneration, pathGeneration(parentAfter))
      || childInfo.isSymbolicLink()
      || !childInfo.isDirectory()
      || await realpath(child) !== child
    ) {
      throw exportError("HUB_ACCESS_AUDIT_EXPORT_CHANGED", `audit export parent authority changed while creating ${child}`);
    }
    current = child;
    currentGeneration = pathGeneration(childInfo);
  }
  if (await realpath(current) !== prospectiveParent) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_CHANGED", "audit export canonical parent changed during creation");
  }
  return prospectiveParent;
}

function assertSameGeneration(expected: PathGeneration, actual: PathGeneration, label: string) {
  if (!sameGeneration(expected, actual)) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_CHANGED", `${label} changed during verification`);
  }
}

async function assertSameDirectoryIdentity(expected: PathGeneration, directory: string, label: string) {
  const info = await lstat(directory);
  if (
    info.isSymbolicLink()
    || !info.isDirectory()
    || !sameDirectoryIdentity(expected, pathGeneration(info))
    || await realpath(directory) !== directory
  ) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_CHANGED", `${label} authority changed`);
  }
  return info;
}

function committedPublicationError(output: string, parent: string, cause: unknown, outputVerified: boolean) {
  return Object.assign(
    exportError(
      "HUB_ACCESS_AUDIT_EXPORT_COMMITTED_AMBIGUOUS",
      `audit export committed with ambiguous parent-directory durability: ${output}`,
    ),
    {
      cause,
      committed: true,
      committedPath: outputVerified ? output : null,
      originalEvidence: outputVerified ? "verified" : "unknown",
      ...(outputVerified
        ? { recoveryPaths: { output }, attemptedPaths: { parent } }
        : { successorPreserved: true, attemptedPaths: { output, parent } }),
    },
  );
}

function committedExportOperationError(output: string, parent: string, cause: unknown, outputVerified: boolean) {
  return Object.assign(
    exportError(
      "HUB_ACCESS_AUDIT_EXPORT_COMMITTED_AMBIGUOUS",
      `audit export publication committed but a post-commit operation failed: ${output}`,
    ),
    {
      cause,
      primaryError: cause,
      committed: true,
      committedPath: outputVerified ? output : null,
      originalEvidence: outputVerified ? "verified" : "unknown",
      ...(outputVerified
        ? { recoveryPaths: { output }, attemptedPaths: { parent } }
        : { successorPreserved: true, attemptedPaths: { output, parent } }),
    },
  );
}

type CleanupKind = "stage" | "reservation";

type PreservedCleanupDirectory = {
  kind: CleanupKind;
  path: string;
  generation: PathGeneration;
};

function cleanupSuccessorError(kind: CleanupKind, canonicalPath: string, cause?: unknown) {
  const stage = kind === "stage";
  return Object.assign(
    exportError(
      stage ? "HUB_ACCESS_AUDIT_EXPORT_STAGE_SUCCESSOR_PRESERVED" : "HUB_ACCESS_AUDIT_EXPORT_SUCCESSOR_PRESERVED",
      `audit export ${stage ? "stage" : "reservation"} successor preserved: ${canonicalPath}`,
    ),
    {
      ...(cause === undefined ? {} : { cause }),
      committed: false,
      cleanupCommitted: false,
      successorPreserved: true,
      attemptedPaths: { [kind]: canonicalPath },
    },
  );
}

async function privateCleanupIsolationPath(parent: string, canonicalPath: string, kind: CleanupKind) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = path.join(
      parent,
      `.${path.basename(canonicalPath)}.${kind}-preserved.${randomUUID()}.recovery`,
    );
    try {
      await lstat(candidate);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return candidate;
      throw error;
    }
  }
  throw exportError(
    "HUB_ACCESS_AUDIT_EXPORT_RECOVERY_PATH_EXHAUSTED",
    `could not allocate a private audit export recovery path for ${canonicalPath}`,
  );
}

async function preserveDirectoryIfSameGeneration(
  canonicalPath: string,
  expected: PathGeneration | null,
  kind: CleanupKind,
  hooks: RedisAuditExportTestHooks,
  cleanupErrors: unknown[],
): Promise<PreservedCleanupDirectory | null> {
  if (!expected) return null;
  const parent = path.dirname(canonicalPath);
  const hookPath = path.join(parent, `.${path.basename(canonicalPath)}.${kind}-hook-${randomUUID()}.recovery`);
  try {
    await hooks.beforeCleanupIsolation?.({ canonicalPath, isolatedPath: hookPath, kind });
    const currentInfo = await lstat(canonicalPath);
    if (currentInfo.isSymbolicLink() || !currentInfo.isDirectory()) {
      cleanupErrors.push(cleanupSuccessorError(kind, canonicalPath));
      return null;
    }
    const current = pathGeneration(currentInfo);
    if (!sameGeneration(expected, current)) {
      cleanupErrors.push(cleanupSuccessorError(kind, canonicalPath));
      return null;
    }
    const isolatedPath = await privateCleanupIsolationPath(parent, canonicalPath, kind);
    const finalInfo = await lstat(canonicalPath);
    if (finalInfo.isSymbolicLink() || !finalInfo.isDirectory() || !sameGeneration(current, pathGeneration(finalInfo))) {
      cleanupErrors.push(cleanupSuccessorError(kind, canonicalPath));
      return null;
    }
    await rename(canonicalPath, isolatedPath);
    let syncError: unknown = null;
    try {
      await syncExportDirectory(parent, `preserve-${kind}`);
    } catch (error) {
      syncError = error;
    }
    let movedInfo: Awaited<ReturnType<typeof lstat>>;
    try {
      movedInfo = await lstat(isolatedPath);
    } catch (error) {
      cleanupErrors.push(cleanupSuccessorError(kind, canonicalPath, error));
      if (syncError) cleanupErrors.push(syncError);
      return null;
    }
    if (
      movedInfo.isSymbolicLink()
      || !movedInfo.isDirectory()
      || !sameGenerationAcrossRename(current, pathGeneration(movedInfo))
    ) {
      cleanupErrors.push(cleanupSuccessorError(kind, canonicalPath));
      if (syncError) cleanupErrors.push(syncError);
      return null;
    }
    if (syncError) {
      cleanupErrors.push(Object.assign(
        exportError(
          "HUB_ACCESS_AUDIT_EXPORT_RECOVERY_DURABILITY_AMBIGUOUS",
          `audit export ${kind} preservation has ambiguous durability: ${isolatedPath}`,
        ),
        {
          cause: syncError,
          committed: false,
          cleanupCommitted: true,
          preservationDurabilityAmbiguous: true,
          attemptedPaths: { [kind]: isolatedPath, parent },
        },
      ));
    }
    return { kind, path: isolatedPath, generation: pathGeneration(movedInfo) };
  } catch (error) {
    if (errorCode(error) !== "ENOENT") cleanupErrors.push(error);
    return null;
  }
}

async function revalidatePreservedCleanupDirectories(
  candidates: PreservedCleanupDirectory[],
  cleanupErrors: unknown[],
) {
  const verified: PreservedCleanupDirectory[] = [];
  for (const candidate of candidates) {
    try {
      const current = await lstat(candidate.path);
      if (
        current.isSymbolicLink()
        || !current.isDirectory()
        || !sameGeneration(candidate.generation, pathGeneration(current))
      ) {
        cleanupErrors.push(Object.assign(
          exportError(
            "HUB_ACCESS_AUDIT_EXPORT_RECOVERY_CHANGED",
            `audit export preserved ${candidate.kind} changed before recovery could be reported: ${candidate.path}`,
          ),
          {
            committed: false,
            cleanupCommitted: true,
            quarantinePreserved: false,
            successorPreserved: true,
            attemptedPaths: { [candidate.kind]: candidate.path },
          },
        ));
        continue;
      }
      verified.push(candidate);
    } catch (error) {
      cleanupErrors.push(Object.assign(
        exportError(
          "HUB_ACCESS_AUDIT_EXPORT_RECOVERY_CHANGED",
          `audit export preserved ${candidate.kind} could not be revalidated: ${candidate.path}`,
        ),
        {
          cause: error,
          committed: false,
          cleanupCommitted: true,
          quarantinePreserved: false,
          successorPreserved: true,
          attemptedPaths: { [candidate.kind]: candidate.path },
        },
      ));
    }
  }
  return verified;
}

async function preserveUncommittedExportDirectories(options: {
  parent: string;
  parentIdentity: PathGeneration;
  stage: string;
  stageGeneration: PathGeneration | null;
  output: string;
  outputReservationGeneration: PathGeneration | null;
  hooks: RedisAuditExportTestHooks;
  cleanupErrors: unknown[];
}) {
  const {
    parent,
    parentIdentity,
    stage,
    stageGeneration,
    output,
    outputReservationGeneration,
    hooks,
    cleanupErrors,
  } = options;
  try {
    await assertSameDirectoryIdentity(parentIdentity, parent, "audit export cleanup parent");
  } catch (error) {
    cleanupErrors.push(error);
    return [];
  }
  const candidates = [
    await preserveDirectoryIfSameGeneration(stage, stageGeneration, "stage", hooks, cleanupErrors),
    await preserveDirectoryIfSameGeneration(output, outputReservationGeneration, "reservation", hooks, cleanupErrors),
  ].filter((entry): entry is PreservedCleanupDirectory => entry !== null);
  try {
    await assertSameDirectoryIdentity(parentIdentity, parent, "audit export cleanup parent after preservation");
  } catch (error) {
    cleanupErrors.push(error);
    return [];
  }
  return revalidatePreservedCleanupDirectories(candidates, cleanupErrors);
}

function failedExportWithCleanup(
  primaryError: unknown,
  cleanupErrors: unknown[],
  preserved: PreservedCleanupDirectory[],
) {
  const recoveryPaths = Object.fromEntries(preserved.map((entry) => [entry.kind, entry.path]));
  const code = errorCode(primaryError) || "HUB_ACCESS_AUDIT_EXPORT_FAILED";
  const message = primaryError instanceof Error ? primaryError.message : "audit Redis export failed";
  const common = {
    code,
    primaryError,
    cleanupErrors,
    committed: false,
    cleanupCommitted: preserved.length > 0,
    quarantinePreserved: preserved.length > 0,
    ...(preserved.length > 0 ? { recoveryPaths } : {}),
  };
  if (cleanupErrors.length > 0) {
    return Object.assign(
      new AggregateError(
        [primaryError, ...cleanupErrors],
        "audit Redis export failed and cleanup could not prove every recovery authority",
        { cause: primaryError },
      ),
      common,
    );
  }
  return Object.assign(new Error(message, { cause: primaryError }), common);
}

async function readPrivateFilePinned(
  filePath: string,
  label: string,
  maxBytes: number,
  afterPreflight?: () => void | Promise<void>,
) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", `${label} must be a real file`);
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", `${label} must be private`);
  }
  if (info.size > maxBytes) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", `${label} is too large`);
  }
  const generation = pathGeneration(info);
  await afterPreflight?.();
  let raw = "";
  try {
    raw = await readBoundedRegularFileNoFollow(filePath, { maxBytes });
  } catch (error) {
    const code = errorCode(error);
    if (code === "BOUNDED_FILE_TOO_LARGE") {
      throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", `${label} is too large`);
    }
    if (String(code).startsWith("BOUNDED_FILE_")) {
      throw exportError("HUB_ACCESS_AUDIT_EXPORT_CHANGED", `${label} changed or is unsafe`);
    }
    throw error;
  }
  const after = await lstat(filePath);
  if (!after.isFile() || after.isSymbolicLink()) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", `${label} must remain a real file`);
  }
  assertSameGeneration(generation, pathGeneration(after), label);
  return { raw, generation, sizeBytes: after.size };
}

type ExportFileAuthority = {
  generation: PathGeneration;
  sha256: string;
  sizeBytes: number;
};

type ExportTreeAuthority = {
  directory: PathGeneration;
  manifest: ExportFileAuthority;
  log: ExportFileAuthority;
};

function exportFileAuthority(read: Awaited<ReturnType<typeof readPrivateFilePinned>>): ExportFileAuthority {
  return {
    generation: read.generation,
    sha256: createHash("sha256").update(read.raw, "utf8").digest("hex"),
    sizeBytes: read.sizeBytes,
  };
}

function sameExportFileAuthority(expected: ExportFileAuthority, actual: ExportFileAuthority) {
  return sameGeneration(expected.generation, actual.generation)
    && expected.sha256 === actual.sha256
    && expected.sizeBytes === actual.sizeBytes;
}

async function captureExportTreeAuthority(directory: string, logMaxBytes: number): Promise<ExportTreeAuthority> {
  const beforeInfo = await lstat(directory);
  if (beforeInfo.isSymbolicLink() || !beforeInfo.isDirectory()) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_CHANGED", `audit export directory changed: ${directory}`);
  }
  const before = pathGeneration(beforeInfo);
  const manifest = await readPrivateFilePinned(
    path.join(directory, MANIFEST_FILE),
    "audit export manifest",
    MANIFEST_MAX_BYTES,
  );
  const log = await readPrivateFilePinned(
    path.join(directory, LOG_FILE),
    "audit export log",
    Math.max(logMaxBytes, 1),
  );
  const afterInfo = await lstat(directory);
  if (afterInfo.isSymbolicLink() || !afterInfo.isDirectory()) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_CHANGED", `audit export directory changed: ${directory}`);
  }
  assertSameGeneration(before, pathGeneration(afterInfo), "audit export directory");
  return {
    directory: before,
    manifest: exportFileAuthority(manifest),
    log: exportFileAuthority(log),
  };
}

function sameExportTreeAuthority(
  expected: ExportTreeAuthority,
  actual: ExportTreeAuthority,
  { moved = false }: { moved?: boolean } = {},
) {
  const sameDirectory = moved
    ? sameGenerationAcrossRename(expected.directory, actual.directory)
    : sameGeneration(expected.directory, actual.directory);
  return sameDirectory
    && sameExportFileAuthority(expected.manifest, actual.manifest)
    && sameExportFileAuthority(expected.log, actual.log);
}

function publishChangedError(output: string, parent: string, cause?: unknown) {
  return Object.assign(
    exportError(
      "HUB_ACCESS_AUDIT_EXPORT_PUBLISH_CHANGED",
      `published audit export authority changed; canonical successor preserved: ${output}`,
    ),
    {
      ...(cause === undefined ? {} : { cause }),
      committed: true,
      committedPath: null,
      successorPreserved: true,
      originalEvidence: "unknown",
      attemptedPaths: { output, parent },
    },
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("audit export refuses non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error(`audit export refuses ${typeof value}`);
}

function signingKey(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32 || /\s/.test(value)) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_SIGNING_KEY_INVALID", "audit export signing key must contain at least 32 non-whitespace bytes");
  }
  return Buffer.from(value, "utf8");
}

function manifestPayload(manifest: RedisAuditExportManifest) {
  const { manifestHash: _manifestHash, signature: _signature, ...payload } = manifest;
  return payload;
}

function buildManifest(
  payload: Omit<RedisAuditExportManifest, "manifestHash" | "signature">,
  key: Buffer | null,
): RedisAuditExportManifest {
  const manifestHash = createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
  return {
    ...payload,
    manifestHash,
    signature: key
      ? { algorithm: "hmac-sha256", value: createHmac("sha256", key).update(manifestHash, "utf8").digest("hex") }
      : null,
  };
}

export async function exportRedisHubAccessAudit(options: {
  backend: HubRedisStateBackend;
  hubRoot: string;
  output: string;
  maxBytes?: number | string;
  signingKey?: string;
}) {
  const hooks = redisAuditExportTestHookStorage.getStore() || {};
  const requestedOutput = path.resolve(options.output);
  const hubRoot = path.resolve(options.hubRoot);
  const relative = path.relative(hubRoot, requestedOutput);
  if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "audit export must be outside the Hub root");
  }
  if (!path.basename(requestedOutput)) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "audit export output must name a directory");
  }
  const requestedParent = path.dirname(requestedOutput);
  const canonicalHubRoot = await realpath(hubRoot);
  const canonicalHubInfo = await lstat(canonicalHubRoot);
  if (canonicalHubInfo.isSymbolicLink() || !canonicalHubInfo.isDirectory()) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "Hub root must resolve to a real directory");
  }
  const canonicalParent = await ensureCanonicalOutputParent(
    requestedParent,
    path.basename(requestedOutput),
    canonicalHubRoot,
  );
  const output = path.join(canonicalParent, path.basename(requestedOutput));
  if (isInsideOrEqual(canonicalHubRoot, output)) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "audit export canonical path must be outside the Hub root");
  }
  const parent = canonicalParent;
  const stage = path.join(canonicalParent, `.${path.basename(output)}.stage-${randomUUID()}`);
  const key = signingKey(options.signingKey);
  let stageGeneration: PathGeneration | null = null;
  let outputReservationGeneration: PathGeneration | null = null;
  let parentGeneration: PathGeneration | null = null;
  let stagedTreeAuthority: ExportTreeAuthority | null = null;
  let stagedLogMaxBytes = 1;
  let committed = false;
  let primaryError: unknown = null;
  const initialParentInfo = await lstat(canonicalParent);
  if (initialParentInfo.isSymbolicLink() || !initialParentInfo.isDirectory()) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_CHANGED", "audit export canonical parent is unsafe");
  }
  const parentIdentity = pathGeneration(initialParentInfo);
  let outputReservationAttempted = false;
  try {
    await hooks.afterCanonicalParentAuthorityCaptured?.({ parent: canonicalParent, output, stage });
    await assertSameDirectoryIdentity(parentIdentity, canonicalParent, "audit export canonical parent");
    await mkdir(stage, { mode: 0o700 });
    const createdStageInfo = await lstat(stage);
    await assertSameDirectoryIdentity(parentIdentity, canonicalParent, "audit export canonical parent after stage creation");
    if (createdStageInfo.isSymbolicLink() || !createdStageInfo.isDirectory()) {
      throw exportError("HUB_ACCESS_AUDIT_EXPORT_CHANGED", "audit export stage creation authority changed");
    }
    stageGeneration = pathGeneration(createdStageInfo);
    await assertSameDirectoryIdentity(parentIdentity, canonicalParent, "audit export canonical parent before reservation");
    outputReservationAttempted = true;
    await mkdir(output, { mode: 0o700 });
    const createdOutputInfo = await lstat(output);
    await assertSameDirectoryIdentity(parentIdentity, canonicalParent, "audit export canonical parent after reservation");
    if (createdOutputInfo.isSymbolicLink() || !createdOutputInfo.isDirectory()) {
      throw exportError("HUB_ACCESS_AUDIT_EXPORT_CHANGED", "audit export reservation authority changed");
    }
    outputReservationGeneration = pathGeneration(createdOutputInfo);
    await syncExportDirectory(canonicalParent, "reserve-output");
    const syncedParentInfo = await assertSameDirectoryIdentity(
      parentIdentity,
      canonicalParent,
      "audit export canonical parent after reservation sync",
    );
    parentGeneration = pathGeneration(syncedParentInfo);
    await hooks.afterOutputReserved?.({ output, stage });
    await assertSameDirectoryIdentity(
      parentIdentity,
      canonicalParent,
      "audit export canonical parent after reservation hook",
    );
    assertSameGeneration(stageGeneration, await generationFor(stage), "audit export stage after reservation hook");
    assertSameGeneration(
      outputReservationGeneration,
      await generationFor(output),
      "audit export output reservation after reservation hook",
    );
    await assertSameDirectoryIdentity(
      parentIdentity,
      canonicalParent,
      "audit export canonical parent after reservation authority recheck",
    );
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    const preserved = await preserveUncommittedExportDirectories({
      parent: canonicalParent,
      parentIdentity,
      stage,
      stageGeneration,
      output,
      outputReservationGeneration,
      hooks,
      cleanupErrors,
    });
    const primary = errorCode(error) === "EEXIST" && outputReservationAttempted
      ? exportError("HUB_ACCESS_AUDIT_EXPORT_EXISTS", "audit export output already exists")
      : error;
    throw failedExportWithCleanup(primary, cleanupErrors, preserved);
  }
  try {
    const capture = await captureRedisHubAccessAudit(options.backend, { maxBytes: options.maxBytes });
    const log = capture.serializedRecords.length > 0 ? `${capture.serializedRecords.join("\n")}\n` : "";
    if (Buffer.byteLength(log, "utf8") !== capture.verified.sizeBytes) {
      throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "captured audit byte count is inconsistent");
    }
    await assertSameDirectoryIdentity(
      parentIdentity,
      canonicalParent,
      "audit export canonical parent before staged log write",
    );
    assertSameGeneration(stageGeneration!, await generationFor(stage), "audit export stage before log write");
    assertSameGeneration(
      outputReservationGeneration!,
      await generationFor(output),
      "audit export output reservation before log write",
    );
    await assertSameDirectoryIdentity(
      parentIdentity,
      canonicalParent,
      "audit export canonical parent at staged log write boundary",
    );
    const logPath = path.join(stage, LOG_FILE);
    const handle = await open(logPath, exclusiveNoFollowWriteFlags(logPath), 0o600);
    try {
      await handle.writeFile(log, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const stageAfterLog = await assertSameDirectoryIdentity(
      stageGeneration!,
      stage,
      "audit export stage after log write",
    );
    await assertSameDirectoryIdentity(
      parentIdentity,
      canonicalParent,
      "audit export canonical parent after staged log write",
    );
    assertSameGeneration(
      outputReservationGeneration!,
      await generationFor(output),
      "audit export output reservation after log write",
    );
    stageGeneration = pathGeneration(stageAfterLog);
    const payload = {
      format: EXPORT_FORMAT,
      exportId: randomUUID(),
      createdAt: new Date().toISOString(),
      backendIdentityFingerprint: options.backend.identityFingerprint,
      recordCount: capture.verified.recordCount,
      lastSequence: capture.verified.lastSequence,
      lastHash: capture.verified.lastHash,
      sizeBytes: capture.verified.sizeBytes,
      maxBytes: capture.verified.maxBytes,
      log: {
        path: LOG_FILE,
        sha256: createHash("sha256").update(log, "utf8").digest("hex"),
        sizeBytes: Buffer.byteLength(log, "utf8"),
      },
    } satisfies Omit<RedisAuditExportManifest, "manifestHash" | "signature">;
    const manifest = buildManifest(payload, key);
    await writeJsonDurableAtomic(path.join(stage, MANIFEST_FILE), manifest);
    await syncExportDirectory(stage, "stage-ready");
    const stageAfterManifest = await assertSameDirectoryIdentity(
      stageGeneration,
      stage,
      "audit export stage after manifest write",
    );
    await assertSameDirectoryIdentity(
      parentIdentity,
      canonicalParent,
      "audit export canonical parent after staged manifest write",
    );
    assertSameGeneration(
      outputReservationGeneration!,
      await generationFor(output),
      "audit export output reservation after manifest write",
    );
    stageGeneration = pathGeneration(stageAfterManifest);
    stagedLogMaxBytes = Math.max(capture.verified.sizeBytes, 1);
    stagedTreeAuthority = await captureExportTreeAuthority(stage, stagedLogMaxBytes);
    await hooks.beforeStageRename?.({ output, stage });
    if (!parentGeneration || !outputReservationGeneration) {
      throw exportError("HUB_ACCESS_AUDIT_EXPORT_CHANGED", "audit export publication authorities are incomplete");
    }
    assertSameGeneration(parentGeneration, pathGeneration(await lstat(parent)), "audit export parent directory");
    assertSameGeneration(outputReservationGeneration, await generationFor(output), "audit export output reservation");
    const finalStagedTree = await captureExportTreeAuthority(stage, stagedLogMaxBytes);
    if (!sameExportTreeAuthority(stagedTreeAuthority, finalStagedTree)) {
      throw exportError("HUB_ACCESS_AUDIT_EXPORT_CHANGED", "audit export staged tree changed before publication");
    }
    stagedTreeAuthority = finalStagedTree;
    await hooks.afterPublicationAuthorityCheck?.({ output, stage, parent: canonicalParent });
    assertSameGeneration(parentGeneration, pathGeneration(await lstat(canonicalParent)), "audit export canonical parent directory");
    assertSameGeneration(outputReservationGeneration, await generationFor(output), "audit export output reservation");
    const postHookStagedTree = await captureExportTreeAuthority(stage, stagedLogMaxBytes);
    if (!sameExportTreeAuthority(stagedTreeAuthority, postHookStagedTree)) {
      throw exportError("HUB_ACCESS_AUDIT_EXPORT_CHANGED", "audit export staged tree changed at publication boundary");
    }
    stagedTreeAuthority = postHookStagedTree;
    await rename(stage, output);
    committed = true;
    await hooks.afterStageRename?.({ output, stage });
    let publishedTree: ExportTreeAuthority;
    try {
      publishedTree = await captureExportTreeAuthority(output, stagedLogMaxBytes);
    } catch (error) {
      throw publishChangedError(output, canonicalParent, error);
    }
    if (!sameExportTreeAuthority(stagedTreeAuthority, publishedTree, { moved: true })) {
      throw publishChangedError(output, canonicalParent);
    }
    try {
      await syncExportDirectory(canonicalParent, "publish-output");
    } catch (error) {
      let outputVerified = false;
      try {
        const current = await captureExportTreeAuthority(output, stagedLogMaxBytes);
        outputVerified = sameExportTreeAuthority(publishedTree, current);
      } catch {
        outputVerified = false;
      }
      throw committedPublicationError(output, canonicalParent, error, outputVerified);
    }
    let confirmedTree: ExportTreeAuthority;
    try {
      confirmedTree = await captureExportTreeAuthority(output, stagedLogMaxBytes);
    } catch (error) {
      throw publishChangedError(output, canonicalParent, error);
    }
    if (!sameExportTreeAuthority(publishedTree, confirmedTree)) {
      throw publishChangedError(output, canonicalParent);
    }
    return { output, manifest };
  } catch (error) {
    primaryError = error;
  }
  if (primaryError) {
    if (committed) {
      const code = errorCode(primaryError);
      if (["HUB_ACCESS_AUDIT_EXPORT_COMMITTED_AMBIGUOUS", "HUB_ACCESS_AUDIT_EXPORT_PUBLISH_CHANGED"].includes(code)) {
        throw primaryError;
      }
      let outputVerified = false;
      if (stagedTreeAuthority) {
        try {
          const current = await captureExportTreeAuthority(output, stagedLogMaxBytes);
          outputVerified = sameExportTreeAuthority(stagedTreeAuthority, current, { moved: true });
        } catch {
          outputVerified = false;
        }
      }
      if (!outputVerified) throw publishChangedError(output, canonicalParent, primaryError);
      throw committedExportOperationError(output, canonicalParent, primaryError, true);
    }
    const cleanupErrors: unknown[] = [];
    const preserved = await preserveUncommittedExportDirectories({
      parent: canonicalParent,
      parentIdentity,
      stage,
      stageGeneration,
      output,
      outputReservationGeneration,
      hooks,
      cleanupErrors,
    });
    throw failedExportWithCleanup(primaryError, cleanupErrors, preserved);
  }
  throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "audit export reached an unreachable publication state");
}

export async function verifyRedisHubAccessAuditExport(options: {
  input: string;
  signingKey?: string;
  requireSignature?: boolean;
}) {
  const hooks = redisAuditExportTestHookStorage.getStore() || {};
  const input = path.resolve(options.input);
  const inputParent = path.dirname(input);
  const inputParentInfo = await lstat(inputParent);
  if (!inputParentInfo.isDirectory() || inputParentInfo.isSymbolicLink()) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "audit export parent must be a real directory");
  }
  const inputParentGeneration = pathGeneration(inputParentInfo);
  const directory = await lstat(input);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "audit export must be a real directory");
  }
  const inputGeneration = pathGeneration(directory);
  const manifestPath = path.join(input, MANIFEST_FILE);
  const manifestRead = await readPrivateFilePinned(
    manifestPath,
    "audit export manifest",
    MANIFEST_MAX_BYTES,
    () => hooks.afterManifestPreflight?.({ input, manifestPath }),
  );
  const manifest = JSON.parse(manifestRead.raw) as RedisAuditExportManifest;
  if (manifest.format !== EXPORT_FORMAT || manifest.log?.path !== LOG_FILE
    || !Number.isSafeInteger(manifest.recordCount) || manifest.recordCount < 0
    || !Number.isSafeInteger(manifest.sizeBytes) || manifest.sizeBytes < 0
    || !Number.isSafeInteger(manifest.maxBytes) || manifest.maxBytes < 0
    || !Number.isSafeInteger(manifest.log.sizeBytes) || manifest.log.sizeBytes < 0
    || manifest.lastSequence !== manifest.recordCount || !/^[a-f0-9]{64}$/.test(manifest.lastHash)
    || !/^[a-f0-9]{64}$/.test(manifest.manifestHash) || !/^[a-f0-9]{64}$/.test(manifest.log.sha256)) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "audit export manifest is invalid");
  }
  const expectedManifestHash = createHash("sha256").update(canonicalJson(manifestPayload(manifest)), "utf8").digest("hex");
  if (manifest.manifestHash !== expectedManifestHash) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "audit export manifest hash mismatch");
  }
  const key = signingKey(options.signingKey);
  if (options.requireSignature && !manifest.signature) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_SIGNATURE_REQUIRED", "audit export signature is required");
  }
  if (manifest.signature) {
    if (!key || manifest.signature.algorithm !== "hmac-sha256") {
      throw exportError("HUB_ACCESS_AUDIT_EXPORT_SIGNATURE_INVALID", "audit export signature cannot be verified");
    }
    const expected = createHmac("sha256", key).update(manifest.manifestHash, "utf8").digest("hex");
    if (manifest.signature.value !== expected) {
      throw exportError("HUB_ACCESS_AUDIT_EXPORT_SIGNATURE_INVALID", "audit export signature is invalid");
    }
  }
  const logPath = path.join(input, LOG_FILE);
  const logRead = await readPrivateFilePinned(
    logPath,
    "audit export log",
    manifest.maxBytes + 1,
    () => hooks.afterLogPreflight?.({ input, logPath }),
  );
  if (logRead.sizeBytes !== manifest.log.sizeBytes || logRead.sizeBytes !== manifest.sizeBytes || logRead.sizeBytes > manifest.maxBytes) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "audit export log size mismatch");
  }
  const log = logRead.raw;
  if (createHash("sha256").update(log, "utf8").digest("hex") !== manifest.log.sha256) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "audit export log digest mismatch");
  }
  const records = log ? log.trimEnd().split("\n") : [];
  if (records.length !== manifest.recordCount) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "audit export record count mismatch");
  }
  assertSameGeneration(inputParentGeneration, await generationFor(inputParent), "audit export input parent directory");
  assertSameGeneration(inputGeneration, await generationFor(input), "audit export input directory");
  await hooks.beforeVerifyAuditFile?.({ input, logPath });
  assertSameGeneration(inputParentGeneration, await generationFor(inputParent), "audit export input parent directory");
  assertSameGeneration(inputGeneration, await generationFor(input), "audit export input directory");
  assertSameGeneration(logRead.generation, await generationFor(logPath), "audit export log");
  const verifiedLog = await verifyHubAccessAuditFile(logPath, { maxBytes: manifest.maxBytes });
  assertSameGeneration(inputParentGeneration, await generationFor(inputParent), "audit export input parent directory");
  assertSameGeneration(inputGeneration, await generationFor(input), "audit export input directory");
  assertSameGeneration(logRead.generation, await generationFor(logPath), "audit export log");
  assertSameGeneration(manifestRead.generation, await generationFor(manifestPath), "audit export manifest");
  if (verifiedLog.recordCount !== manifest.recordCount || verifiedLog.lastHash !== manifest.lastHash
    || verifiedLog.sizeBytes !== manifest.sizeBytes) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "audit export hash chain does not match its manifest");
  }
  return { input, manifest, signatureVerified: Boolean(manifest.signature && key) };
}
