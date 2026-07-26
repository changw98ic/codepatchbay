import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, statfs } from "node:fs/promises";
import path from "node:path";

import {
  fsyncDirectory,
  acquireHubMaintenance,
  removeDurable,
  writeJsonDurableAtomic,
} from "../../../shared/hub-maintenance.js";
import { readHubLiveness } from "../hub/hub-registry.js";
import {
  verifyHubAccessAudit,
  verifyHubAccessAuditFile,
} from "./hub-access-audit.js";

const ARCHIVE_FORMAT = "cpb-hub-access-audit-archive/v1";
const ARCHIVE_JOURNAL_FORMAT = "cpb-hub-access-audit-archive-journal/v1";
const ARCHIVE_STAGE_FORMAT = "cpb-hub-access-audit-archive-stage/v1";
const ARCHIVE_LOG_NAME = "http-access.jsonl";
const ARCHIVE_MANIFEST_NAME = "manifest.json";
const ARCHIVE_JOURNAL_NAME = "http-access.archive.json";
const MAX_METADATA_BYTES = 64 * 1024;
const MIN_SIGNING_KEY_BYTES = 32;
const DEFAULT_MINIMUM_FREE_BYTES = 256 * 1024 * 1024;
const EMPTY_SHA256 = createHash("sha256").digest("hex");

type FileGeneration = {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
};

type ArchiveIoHooks = {
  afterOpen?: (context: { filePath: string; size: number }) => void | Promise<void>;
  afterChunk?: (context: { filePath: string; bytesRead: number; totalBytes: number }) => void | Promise<void>;
  beforePathGenerationCheck?: (context: { filePath: string; totalBytes: number }) => void | Promise<void>;
  beforeStageIsolation?: (context: { stage: string; quarantinePath: string }) => void | Promise<void>;
  afterArchiveValidation?: (context: { archiveRoot: string }) => void | Promise<void>;
  beforeDurableRemoval?: (context: { filePath: string; quarantinePath: string }) => void | Promise<void>;
};

type ArchiveSignature = {
  algorithm: "hmac-sha256";
  value: string;
};

type ArchiveManifestPayload = {
  format: typeof ARCHIVE_FORMAT;
  archiveId: string;
  createdAt: string;
  sourceHubRootHash: string;
  logFile: typeof ARCHIVE_LOG_NAME;
  sizeBytes: number;
  sha256: string;
  recordCount: number;
  lastSequence: number;
  lastHash: string;
};

export type HubAccessAuditArchiveManifest = ArchiveManifestPayload & {
  manifestHash: string;
  signature: ArchiveSignature | null;
};

type ArchiveJournal = {
  format: typeof ARCHIVE_JOURNAL_FORMAT;
  operationId: string;
  createdAt: string;
  sourceHubRootHash: string;
  output: string;
  stage: string;
  sourceSizeBytes: number;
  sourceSha256: string;
  recordCount: number;
  lastSequence: number;
  lastHash: string;
  manifestHash: string;
  stageGeneration: FileGeneration | null;
};

type ArchiveStageOwner = {
  format: typeof ARCHIVE_STAGE_FORMAT;
  operationId: string;
  sourceHubRootHash: string;
  output: string;
  createdAt: string;
  stageGeneration: FileGeneration | null;
};

type ArchivePhase = "prepared" | "stage_owned" | "stage_created" | "staged" | "published";

type ArchiveOptions = {
  hubRoot: string;
  output: string;
  signingKey?: string;
  maxBytes?: number | string;
  minimumFreeBytes?: number | string;
  faultInjector?: (phase: ArchivePhase) => void | Promise<void>;
  hooksForTest?: ArchiveIoHooks;
};

type VerifyArchiveOptions = {
  signingKey?: string;
  requireSignature?: boolean;
  hooksForTest?: ArchiveIoHooks;
};

type RecoverArchiveOptions = {
  hubRoot: string;
  signingKey?: string;
  hooksForTest?: ArchiveIoHooks;
};

function errnoCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

function archiveError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

function generationOf(info: Stats): FileGeneration {
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    birthtimeMs: info.birthtimeMs,
  };
}

function sameGeneration(left: FileGeneration, right: FileGeneration) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs;
}

function sameGenerationAcrossRename(left: FileGeneration, right: FileGeneration) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.birthtimeMs === right.birthtimeMs;
}

function requiredNoFollowFlag() {
  if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
    throw archiveError(
      "Hub access-audit archive requires filesystem no-follow support",
      "HUB_ACCESS_AUDIT_ARCHIVE_NOFOLLOW_UNAVAILABLE",
    );
  }
  return constants.O_NOFOLLOW;
}

function recoveryPathList(error: unknown) {
  if (!error || typeof error !== "object" || !("recoveryPaths" in error)) return [];
  const value = (error as { recoveryPaths?: unknown }).recoveryPaths;
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  if (value && typeof value === "object") {
    return Object.values(value).filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

function committedArchiveError(error: unknown, output: string, recoveryPaths: string[]) {
  const candidate = error instanceof Error ? error : new Error(String(error));
  return Object.assign(candidate, {
    committed: true,
    committedPath: output,
    recoveryPaths: [...new Set([output, ...recoveryPaths, ...recoveryPathList(error)])],
  });
}

function committedIsolationError(error: unknown, committedPath: string, recoveryPaths: string[]) {
  const candidate = error instanceof Error ? error : new Error(String(error));
  return Object.assign(candidate, {
    committed: true,
    committedPath,
    quarantinePreserved: true,
    recoveryPaths: [...new Set([committedPath, ...recoveryPaths, ...recoveryPathList(error)])],
  });
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

function isWithin(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} field set mismatch`);
  }
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("archive canonical JSON refuses non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new Error(`archive canonical JSON refuses ${typeof value}`);
}

function sha256Text(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeSigningKey(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || /\s/.test(value) || Buffer.byteLength(value, "utf8") < MIN_SIGNING_KEY_BYTES) {
    throw new Error(`audit archive signing key must contain at least ${MIN_SIGNING_KEY_BYTES} non-whitespace bytes`);
  }
  return Buffer.from(value, "utf8");
}

function normalizeMinimumFreeBytes(value: unknown) {
  const configured = value === undefined ? process.env.CPB_HUB_MIN_FREE_BYTES : value;
  if (configured === undefined || configured === "") return DEFAULT_MINIMUM_FREE_BYTES;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("CPB_HUB_MIN_FREE_BYTES must be a non-negative safe integer");
  }
  return parsed;
}

async function assertArchiveCapacity(output: string, payloadBytes: number, minimumFreeBytes: number) {
  const filesystem = await statfs(path.dirname(output));
  const availableBytes = BigInt(filesystem.bavail) * BigInt(filesystem.bsize);
  const requiredBytes = BigInt(payloadBytes) + BigInt(minimumFreeBytes);
  if (availableBytes < requiredBytes) {
    throw archiveError(
      `insufficient free space for Hub access-audit archive: need ${requiredBytes} bytes, have ${availableBytes}`,
      "HUB_ACCESS_AUDIT_ARCHIVE_INSUFFICIENT_SPACE",
    );
  }
}

function hmacManifestHash(manifestHash: string, key: Buffer) {
  return createHmac("sha256", key).update(manifestHash, "utf8").digest("hex");
}

function constantTimeHexEqual(left: string, right: string) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function fileFingerprint(info: Stats) {
  return `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

function assertPrivateFileInfo(info: Stats, filePath: string, label: string) {
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a real file: ${filePath}`);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible by group or other users: ${filePath}`);
  }
}

function assertPrivateDirectoryInfo(info: Stats, directory: string, label: string) {
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory: ${directory}`);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible by group or other users: ${directory}`);
  }
}

async function assertPrivateRealFile(filePath: string, label: string) {
  const info = await lstat(filePath);
  assertPrivateFileInfo(info, filePath, label);
  return info;
}

async function assertPrivateRealDirectory(directory: string, label: string) {
  const info = await lstat(directory);
  assertPrivateDirectoryInfo(info, directory, label);
  return info;
}

async function lstatIfExists(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function readJsonBounded(filePath: string, label: string, hooks?: ArchiveIoHooks) {
  const linkInfo = await assertPrivateRealFile(filePath, label);
  if (linkInfo.size > MAX_METADATA_BYTES) throw new Error(`${label} exceeds ${MAX_METADATA_BYTES} bytes`);
  const handle = await open(filePath, constants.O_RDONLY | requiredNoFollowFlag());
  try {
    const before = await handle.stat();
    assertPrivateFileInfo(before, filePath, label);
    const beforeGeneration = generationOf(before);
    if (!sameGeneration(generationOf(linkInfo), beforeGeneration)) throw new Error(`${label} changed before open`);
    await hooks?.afterOpen?.({ filePath, size: before.size });
    const buffer = Buffer.alloc(MAX_METADATA_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const result = await handle.read(buffer, total, buffer.length - total, total);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
      await hooks?.afterChunk?.({ filePath, bytesRead: result.bytesRead, totalBytes: total });
    }
    if (total > MAX_METADATA_BYTES) throw new Error(`${label} exceeds ${MAX_METADATA_BYTES} bytes`);
    const after = await handle.stat();
    assertPrivateFileInfo(after, filePath, label);
    const afterGeneration = generationOf(after);
    if (!sameGeneration(beforeGeneration, afterGeneration)) throw new Error(`${label} changed during read`);
    await hooks?.beforePathGenerationCheck?.({ filePath, totalBytes: total });
    const finalPathInfo = await assertPrivateRealFile(filePath, label);
    if (!sameGeneration(afterGeneration, generationOf(finalPathInfo))) {
      throw new Error(`${label} path generation changed during read`);
    }
    return {
      value: JSON.parse(buffer.subarray(0, total).toString("utf8")),
      generation: afterGeneration,
    };
  } finally {
    await handle.close();
  }
}

async function hashPrivateFile(filePath: string, label: string, maxBytes: number, hooks?: ArchiveIoHooks) {
  const linkInfo = await assertPrivateRealFile(filePath, label);
  if (linkInfo.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  const handle = await open(filePath, constants.O_RDONLY | requiredNoFollowFlag());
  try {
    const before = await handle.stat();
    assertPrivateFileInfo(before, filePath, label);
    const beforeGeneration = generationOf(before);
    if (!sameGeneration(generationOf(linkInfo), beforeGeneration)) throw new Error(`${label} changed before open`);
    await hooks?.afterOpen?.({ filePath, size: before.size });
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (result.bytesRead === 0) throw new Error(`${label} ended before its declared size`);
      hash.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
      await hooks?.afterChunk?.({ filePath, bytesRead: result.bytesRead, totalBytes: offset });
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
    if (extra.bytesRead !== 0) throw new Error(`${label} grew during hashing`);
    const after = await handle.stat();
    assertPrivateFileInfo(after, filePath, label);
    const afterGeneration = generationOf(after);
    if (!sameGeneration(beforeGeneration, afterGeneration)) throw new Error(`${label} changed during hashing`);
    await hooks?.beforePathGenerationCheck?.({ filePath, totalBytes: offset });
    const finalPathInfo = await assertPrivateRealFile(filePath, label);
    if (!sameGeneration(afterGeneration, generationOf(finalPathInfo))) {
      throw new Error(`${label} path generation changed during hashing`);
    }
    return {
      sizeBytes: offset,
      sha256: hash.digest("hex"),
      fingerprint: fileFingerprint(after),
      generation: afterGeneration,
    };
  } finally {
    await handle.close();
  }
}

async function copyPrivateFileWithHash(
  source: string,
  destination: string,
  maxBytes: number,
  hooks?: ArchiveIoHooks,
) {
  const linkInfo = await assertPrivateRealFile(source, "Hub access-audit log");
  if (linkInfo.size > maxBytes) throw new Error(`Hub access-audit log exceeds ${maxBytes} bytes`);
  const noFollow = requiredNoFollowFlag();
  const sourceHandle = await open(source, constants.O_RDONLY | noFollow);
  let destinationHandle: Awaited<ReturnType<typeof open>> | null = null;
  let primaryError: Error | null = null;
  try {
    const before = await sourceHandle.stat();
    assertPrivateFileInfo(before, source, "Hub access-audit log");
    const beforeGeneration = generationOf(before);
    if (!sameGeneration(generationOf(linkInfo), beforeGeneration)) {
      throw new Error("Hub access-audit log changed before archive copy");
    }
    await hooks?.afterOpen?.({ filePath: source, size: before.size });
    destinationHandle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const result = await sourceHandle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (result.bytesRead === 0) throw new Error("Hub access-audit log ended during archive copy");
      hash.update(buffer.subarray(0, result.bytesRead));
      let written = 0;
      while (written < result.bytesRead) {
        const output = await destinationHandle.write(buffer, written, result.bytesRead - written, offset + written);
        if (output.bytesWritten === 0) throw new Error("Hub access-audit archive copy made no write progress");
        written += output.bytesWritten;
      }
      offset += result.bytesRead;
      await hooks?.afterChunk?.({ filePath: source, bytesRead: result.bytesRead, totalBytes: offset });
    }
    const extra = await sourceHandle.read(Buffer.alloc(1), 0, 1, offset);
    if (extra.bytesRead !== 0) throw new Error("Hub access-audit log grew during archive copy");
    const after = await sourceHandle.stat();
    assertPrivateFileInfo(after, source, "Hub access-audit log");
    const afterGeneration = generationOf(after);
    if (!sameGeneration(beforeGeneration, afterGeneration)) {
      throw new Error("Hub access-audit log changed during archive copy");
    }
    await hooks?.beforePathGenerationCheck?.({ filePath: source, totalBytes: offset });
    const finalSourceInfo = await assertPrivateRealFile(source, "Hub access-audit log");
    if (!sameGeneration(afterGeneration, generationOf(finalSourceInfo))) {
      throw new Error("Hub access-audit log path generation changed during archive copy");
    }
    await destinationHandle.sync();
    const destinationInfo = await destinationHandle.stat();
    assertPrivateFileInfo(destinationInfo, destination, "Hub access-audit archive copy");
    const destinationGeneration = generationOf(destinationInfo);
    const finalDestinationInfo = await assertPrivateRealFile(destination, "Hub access-audit archive copy");
    if (!sameGeneration(destinationGeneration, generationOf(finalDestinationInfo))) {
      throw new Error("Hub access-audit archive copy path generation changed before publication");
    }
    return {
      sizeBytes: offset,
      sha256: hash.digest("hex"),
      sourceFingerprint: fileFingerprint(after),
      sourceGeneration: afterGeneration,
    };
  } catch (error) {
    const candidate = error instanceof Error ? error : new Error(String(error));
    primaryError = Object.assign(candidate, {
      recoveryPaths: [...new Set([destination, path.dirname(destination), ...recoveryPathList(error)])],
    });
    throw primaryError;
  } finally {
    const closeErrors: unknown[] = [];
    try {
      await sourceHandle.close();
    } catch (error) {
      closeErrors.push(error);
    }
    try {
      await destinationHandle?.close();
    } catch (error) {
      closeErrors.push(error);
    }
    if (closeErrors.length > 0) {
      if (primaryError) Object.assign(primaryError, { cleanupErrors: closeErrors });
      else throw new AggregateError(closeErrors, "Hub access-audit archive copy close failed");
    }
  }
}

function hubRootHash(hubRoot: string) {
  return sha256Text(path.resolve(hubRoot));
}

function auditPaths(hubRoot: string) {
  const directory = path.join(path.resolve(hubRoot), "audit");
  return {
    directory,
    log: path.join(directory, ARCHIVE_LOG_NAME),
    journal: path.join(directory, ARCHIVE_JOURNAL_NAME),
  };
}

function stagePath(hubRoot: string, output: string) {
  const digest = sha256Text(`${path.resolve(hubRoot)}\0${path.resolve(output)}`).slice(0, 16);
  return path.join(path.dirname(output), `.${path.basename(output)}.cpb-audit-stage-${digest}`);
}

function stageOwnerPath(stage: string) {
  return `${stage}.owner.json`;
}

async function canonicalHubRoot(hubRoot: string) {
  return realpath(path.resolve(hubRoot));
}

async function canonicalOutput(hubRoot: string, output: string) {
  const requested = path.resolve(output);
  await mkdir(path.dirname(requested), { recursive: true });
  const parent = await realpath(path.dirname(requested));
  const resolved = path.join(parent, path.basename(requested));
  if (isWithin(hubRoot, resolved)) throw new Error("audit archive output must be outside the Hub root");
  return resolved;
}

function buildManifest(payload: ArchiveManifestPayload, signingKey: Buffer | null): HubAccessAuditArchiveManifest {
  const manifestHash = sha256Text(canonicalJson(payload));
  return {
    ...payload,
    manifestHash,
    signature: signingKey
      ? { algorithm: "hmac-sha256", value: hmacManifestHash(manifestHash, signingKey) }
      : null,
  };
}

function validateManifest(raw: unknown, signingKey: Buffer | null, requireSignature: boolean) {
  const value = recordValue(raw, "Hub access-audit archive manifest");
  exactKeys(value, [
    "format", "archiveId", "createdAt", "sourceHubRootHash", "logFile", "sizeBytes",
    "sha256", "recordCount", "lastSequence", "lastHash", "manifestHash", "signature",
  ], "Hub access-audit archive manifest");
  const payload: ArchiveManifestPayload = {
    format: ARCHIVE_FORMAT,
    archiveId: String(value.archiveId || ""),
    createdAt: String(value.createdAt || ""),
    sourceHubRootHash: String(value.sourceHubRootHash || ""),
    logFile: ARCHIVE_LOG_NAME,
    sizeBytes: Number(value.sizeBytes),
    sha256: String(value.sha256 || ""),
    recordCount: Number(value.recordCount),
    lastSequence: Number(value.lastSequence),
    lastHash: String(value.lastHash || ""),
  };
  if (value.format !== ARCHIVE_FORMAT || value.logFile !== ARCHIVE_LOG_NAME) throw new Error("unsupported Hub access-audit archive format");
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(payload.archiveId)) {
    throw new Error("invalid Hub access-audit archive id");
  }
  if (!Number.isFinite(Date.parse(payload.createdAt)) || new Date(payload.createdAt).toISOString() !== payload.createdAt) {
    throw new Error("invalid Hub access-audit archive timestamp");
  }
  if (!/^[a-f0-9]{64}$/.test(payload.sourceHubRootHash) || !/^[a-f0-9]{64}$/.test(payload.sha256) || !/^[a-f0-9]{64}$/.test(payload.lastHash)) {
    throw new Error("invalid Hub access-audit archive hash field");
  }
  if (!Number.isSafeInteger(payload.sizeBytes) || payload.sizeBytes <= 0) throw new Error("invalid Hub access-audit archive size");
  if (!Number.isSafeInteger(payload.recordCount) || payload.recordCount <= 0 || payload.lastSequence !== payload.recordCount) {
    throw new Error("invalid Hub access-audit archive record count");
  }
  const manifestHash = String(value.manifestHash || "");
  if (!constantTimeHexEqual(manifestHash, sha256Text(canonicalJson(payload)))) {
    throw new Error("Hub access-audit archive manifest hash mismatch");
  }

  let signature: ArchiveSignature | null = null;
  if (value.signature !== null) {
    const rawSignature = recordValue(value.signature, "Hub access-audit archive signature");
    exactKeys(rawSignature, ["algorithm", "value"], "Hub access-audit archive signature");
    signature = {
      algorithm: "hmac-sha256",
      value: String(rawSignature.value || ""),
    };
    if (rawSignature.algorithm !== "hmac-sha256" || !/^[a-f0-9]{64}$/.test(signature.value)) {
      throw new Error("invalid Hub access-audit archive signature");
    }
  }
  if (!signature && (requireSignature || signingKey)) throw new Error("Hub access-audit archive signature is required");
  if (requireSignature && !signingKey) throw new Error("Hub access-audit archive signature verification key is required");
  if (signature && signingKey && !constantTimeHexEqual(signature.value, hmacManifestHash(manifestHash, signingKey))) {
    throw new Error("Hub access-audit archive signature mismatch");
  }
  return {
    ...payload,
    manifestHash,
    signature,
  } satisfies HubAccessAuditArchiveManifest;
}

function validateFileGeneration(raw: unknown, label: string): FileGeneration | null {
  if (raw === null) return null;
  const value = recordValue(raw, label);
  exactKeys(value, [
    "dev", "ino", "mode", "size", "mtimeMs", "ctimeMs", "birthtimeMs",
  ], label);
  if (["dev", "ino", "mode", "size", "mtimeMs", "ctimeMs", "birthtimeMs"]
    .some((key) => typeof value[key] !== "number")) {
    throw new Error(`invalid ${label}`);
  }
  const generation = {
    dev: value.dev as number,
    ino: value.ino as number,
    mode: value.mode as number,
    size: value.size as number,
    mtimeMs: value.mtimeMs as number,
    ctimeMs: value.ctimeMs as number,
    birthtimeMs: value.birthtimeMs as number,
  };
  if (
    !Number.isSafeInteger(generation.dev)
    || generation.dev < 0
    || !Number.isSafeInteger(generation.ino)
    || generation.ino < 0
    || !Number.isSafeInteger(generation.mode)
    || generation.mode < 0
    || !Number.isSafeInteger(generation.size)
    || generation.size < 0
    || !Number.isFinite(generation.mtimeMs)
    || !Number.isFinite(generation.ctimeMs)
    || !Number.isFinite(generation.birthtimeMs)
  ) throw new Error(`invalid ${label}`);
  return generation;
}

function validateJournal(raw: unknown, hubRoot: string): ArchiveJournal {
  const value = recordValue(raw, "Hub access-audit archive journal");
  exactKeys(value, [
    "format", "operationId", "createdAt", "sourceHubRootHash", "output", "stage",
    "sourceSizeBytes", "sourceSha256", "recordCount", "lastSequence", "lastHash", "manifestHash",
    "stageGeneration",
  ], "Hub access-audit archive journal");
  const journal = {
    ...value,
    stageGeneration: validateFileGeneration(value.stageGeneration, "Hub access-audit archive stage generation"),
  } as unknown as ArchiveJournal;
  if (
    journal.format !== ARCHIVE_JOURNAL_FORMAT
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(journal.operationId)
    || !Number.isFinite(Date.parse(journal.createdAt))
    || new Date(journal.createdAt).toISOString() !== journal.createdAt
    || journal.sourceHubRootHash !== hubRootHash(hubRoot)
    || path.resolve(journal.output) !== journal.output
    || journal.stage !== stagePath(hubRoot, journal.output)
    || isWithin(hubRoot, journal.output)
    || !Number.isSafeInteger(journal.sourceSizeBytes)
    || journal.sourceSizeBytes <= 0
    || !/^[a-f0-9]{64}$/.test(journal.sourceSha256)
    || !Number.isSafeInteger(journal.recordCount)
    || journal.recordCount <= 0
    || journal.lastSequence !== journal.recordCount
    || !/^[a-f0-9]{64}$/.test(journal.lastHash)
    || !/^[a-f0-9]{64}$/.test(journal.manifestHash)
  ) {
    throw new Error("invalid Hub access-audit archive journal");
  }
  return journal;
}

function validateStageOwner(raw: unknown, journal: ArchiveJournal): ArchiveStageOwner {
  const value = recordValue(raw, "Hub access-audit archive stage owner");
  exactKeys(value, [
    "format", "operationId", "sourceHubRootHash", "output", "createdAt", "stageGeneration",
  ], "Hub access-audit archive stage owner");
  const owner = {
    ...value,
    stageGeneration: validateFileGeneration(value.stageGeneration, "Hub access-audit archive owner stage generation"),
  } as unknown as ArchiveStageOwner;
  if (
    owner.format !== ARCHIVE_STAGE_FORMAT
    || owner.operationId !== journal.operationId
    || owner.sourceHubRootHash !== journal.sourceHubRootHash
    || owner.output !== journal.output
    || !Number.isFinite(Date.parse(owner.createdAt))
  ) throw new Error("Hub access-audit archive stage ownership mismatch");
  return owner;
}

async function assertOffline(hubRoot: string) {
  const liveness = await readHubLiveness(hubRoot);
  if (liveness.alive) {
    throw archiveError(`Hub access-audit archive requires an offline Hub; pid ${liveness.pid} is alive`, "HUB_ACCESS_AUDIT_ARCHIVE_REQUIRES_OFFLINE");
  }
  if (liveness.reason === "read-error") {
    throw archiveError(
      `cannot prove Hub is offline because liveness state is unreadable: ${String(liveness.error || "unknown error")}`,
      "HUB_ACCESS_AUDIT_ARCHIVE_REQUIRES_OFFLINE",
    );
  }
}

async function resetLiveLog(
  hubRoot: string,
  expectedGeneration: FileGeneration,
  hooks?: ArchiveIoHooks,
) {
  const paths = auditPaths(hubRoot);
  await assertPrivateRealDirectory(paths.directory, "Hub access-audit directory");
  const quarantinePath = await removeDurablePinned(paths.log, expectedGeneration, hooks);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      paths.log,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | requiredNoFollowFlag(),
      0o600,
    );
  } catch (error) {
    const candidate = error instanceof Error ? error : new Error(String(error));
    throw Object.assign(candidate, {
      successorPreserved: errnoCode(error) === "EEXIST",
      recoveryPaths: [paths.log, ...(quarantinePath ? [quarantinePath] : [])],
    });
  }
  let emptyGeneration: FileGeneration;
  let writeError: unknown = null;
  try {
    await handle.sync();
    const opened = await handle.stat();
    assertPrivateFileInfo(opened, paths.log, "Hub access-audit reset log");
    emptyGeneration = generationOf(opened);
    if (emptyGeneration.size !== 0) throw new Error("Hub access-audit reset log is not empty");
    const boundPath = await assertPrivateRealFile(paths.log, "Hub access-audit reset log");
    if (!sameGeneration(emptyGeneration, generationOf(boundPath))) {
      throw preservationError(
        `Hub access-audit reset log generation changed before close: ${paths.log}`,
        [paths.log, ...(quarantinePath ? [quarantinePath] : [])],
      );
    }
  } catch (error) {
    writeError = quarantinePath
      ? committedIsolationError(error, quarantinePath, [paths.log])
      : error;
  }
  let closeError: unknown = null;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  if (writeError) {
    if (closeError && writeError instanceof Error) Object.assign(writeError, { cleanupErrors: [closeError] });
    throw writeError;
  }
  if (closeError) {
    throw quarantinePath
      ? committedIsolationError(closeError, quarantinePath, [paths.log])
      : closeError;
  }
  try {
    await fsyncDirectory(paths.directory);
    const durable = await assertPrivateRealFile(paths.log, "Hub access-audit reset log");
    if (!sameGeneration(emptyGeneration, generationOf(durable))) {
      throw preservationError(
        `Hub access-audit reset log generation changed after publication: ${paths.log}`,
        [paths.log, ...(quarantinePath ? [quarantinePath] : [])],
      );
    }
  } catch (error) {
    throw quarantinePath
      ? committedIsolationError(error, quarantinePath, [paths.log])
      : error;
  }
  return quarantinePath;
}

async function sourceState(hubRoot: string, maxBytes: number, hooks?: ArchiveIoHooks) {
  const log = auditPaths(hubRoot).log;
  if (!await pathExists(log)) return { sizeBytes: 0, sha256: EMPTY_SHA256, generation: null };
  return hashPrivateFile(log, "Hub access-audit log", maxBytes, hooks);
}

function preservationError(message: string, recoveryPaths: string[], details: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), {
    code: "HUB_ACCESS_AUDIT_ARCHIVE_GENERATION_RACE",
    committed: false,
    successorPreserved: true,
    recoveryPaths,
    ...details,
  });
}

async function removeDurablePinned(
  filePath: string,
  expectedGeneration: FileGeneration,
  hooks?: ArchiveIoHooks,
) {
  let quarantinePath: string | null = null;
  await removeDurable(filePath, {
    beforeRename: async (context) => {
      quarantinePath = context.quarantinePath;
      await hooks?.beforeDurableRemoval?.({ filePath, quarantinePath: context.quarantinePath });
      const current = await lstatIfExists(filePath);
      if (!current) {
        throw preservationError(`durable removal source disappeared before isolation: ${filePath}`, [filePath]);
      }
      assertPrivateFileInfo(current, filePath, "Hub access-audit archive recovery metadata");
      if (!sameGeneration(expectedGeneration, generationOf(current))) {
        throw preservationError(
          `durable removal source generation changed before isolation: ${filePath}`,
          [filePath, context.quarantinePath],
        );
      }
      if (await lstatIfExists(context.quarantinePath)) {
        throw preservationError(
          `durable removal quarantine successor already exists; preserving it: ${context.quarantinePath}`,
          [filePath, context.quarantinePath],
        );
      }
    },
  });
  const successor = await lstatIfExists(filePath);
  if (successor) {
    throw preservationError(
      `durable removal preserved a successor at the canonical path: ${filePath}`,
      [filePath, ...(quarantinePath ? [quarantinePath] : [])],
      quarantinePath
        ? { committed: true, committedPath: quarantinePath, quarantinePreserved: true }
        : {},
    );
  }
  return quarantinePath;
}

async function isolateStage(
  journal: ArchiveJournal,
  owner: ArchiveStageOwner | null,
  signingKey: string | undefined,
  hooks?: ArchiveIoHooks,
) {
  const stageInfo = await lstatIfExists(journal.stage);
  if (!stageInfo) return null;
  assertPrivateDirectoryInfo(stageInfo, journal.stage, "Hub access-audit archive stage");
  const observedGeneration = generationOf(stageInfo);
  const journalAuthorizes = Boolean(
    journal.stageGeneration && sameGeneration(journal.stageGeneration, observedGeneration),
  );
  const ownerAuthorizes = Boolean(
    owner?.stageGeneration && sameGeneration(owner.stageGeneration, observedGeneration),
  );
  if (!journalAuthorizes && !ownerAuthorizes) {
    throw preservationError(
      `Hub access-audit archive stage generation is not owned; preserving it: ${journal.stage}`,
      [journal.stage, stageOwnerPath(journal.stage)],
    );
  }
  if (!owner && journalAuthorizes) {
    const staged = await verifyHubAccessAuditArchive(journal.stage, { signingKey });
    if (staged.manifest.manifestHash !== journal.manifestHash) {
      throw preservationError(
        "Hub access-audit archive refuses mismatched stage cleanup",
        [journal.stage],
      );
    }
    const postValidation = await assertPrivateRealDirectory(journal.stage, "Hub access-audit archive stage");
    if (!sameGeneration(observedGeneration, generationOf(postValidation))) {
      throw preservationError(
        `Hub access-audit archive stage changed during cleanup validation: ${journal.stage}`,
        [journal.stage],
      );
    }
  }

  const quarantinePath = `${journal.stage}.removed-${Date.now()}-${randomUUID()}`;
  await hooks?.beforeStageIsolation?.({ stage: journal.stage, quarantinePath });
  if (await lstatIfExists(quarantinePath)) {
    throw preservationError(
      `Hub access-audit archive stage quarantine successor already exists; preserving it: ${quarantinePath}`,
      [journal.stage, quarantinePath],
    );
  }
  const preRename = await lstatIfExists(journal.stage);
  if (!preRename || !preRename.isDirectory() || preRename.isSymbolicLink()
    || !sameGeneration(observedGeneration, generationOf(preRename))) {
    throw preservationError(
      `Hub access-audit archive stage generation changed before isolation: ${journal.stage}`,
      [journal.stage, quarantinePath],
    );
  }
  await rename(journal.stage, quarantinePath);
  const quarantined = await lstatIfExists(quarantinePath);
  if (!quarantined || !quarantined.isDirectory() || quarantined.isSymbolicLink()
    || !sameGenerationAcrossRename(observedGeneration, generationOf(quarantined))) {
    throw preservationError(
      `Hub access-audit archive stage changed during isolation; quarantine preserved: ${quarantinePath}`,
      [journal.stage, quarantinePath],
      { committed: true, committedPath: quarantinePath, quarantinePreserved: true },
    );
  }
  const successor = await lstatIfExists(journal.stage);
  if (successor) {
    throw preservationError(
      `Hub access-audit archive stage successor preserved after isolation: ${journal.stage}`,
      [journal.stage, quarantinePath],
      { committed: true, committedPath: quarantinePath, quarantinePreserved: true },
    );
  }
  try {
    await fsyncDirectory(path.dirname(journal.stage));
  } catch (error) {
    const candidate = error instanceof Error ? error : new Error(String(error));
    throw Object.assign(candidate, {
      committed: true,
      committedPath: quarantinePath,
      quarantinePreserved: true,
      recoveryPaths: [journal.stage, quarantinePath],
    });
  }
  const finalQuarantine = await lstatIfExists(quarantinePath);
  if (!finalQuarantine
    || !sameGeneration(generationOf(quarantined), generationOf(finalQuarantine))) {
    throw preservationError(
      `Hub access-audit archive stage quarantine changed after isolation: ${quarantinePath}`,
      [journal.stage, quarantinePath],
      { committed: true, committedPath: quarantinePath, quarantinePreserved: true },
    );
  }
  return quarantinePath;
}

async function removeStage(
  journal: ArchiveJournal,
  signingKey: string | undefined,
  hooks?: ArchiveIoHooks,
) {
  const ownerPath = stageOwnerPath(journal.stage);
  const ownerPathInfo = await lstatIfExists(ownerPath);
  let owner: ArchiveStageOwner | null = null;
  let ownerGeneration: FileGeneration | null = null;
  if (ownerPathInfo) {
    const ownerRead = await readJsonBounded(
      ownerPath,
      "Hub access-audit archive stage owner",
      hooks,
    );
    owner = validateStageOwner(ownerRead.value, journal);
    ownerGeneration = ownerRead.generation;
  }
  const stageQuarantine = await isolateStage(journal, owner, signingKey, hooks);
  let ownerQuarantine: string | null = null;
  try {
    ownerQuarantine = ownerGeneration
      ? await removeDurablePinned(ownerPath, ownerGeneration, hooks)
      : null;
  } catch (error) {
    if (stageQuarantine) {
      throw committedIsolationError(error, stageQuarantine, [journal.stage, ownerPath]);
    }
    throw error;
  }
  return [stageQuarantine, ownerQuarantine].filter((entry): entry is string => Boolean(entry));
}

async function recoverUnlocked(hubRoot: string, signingKey?: string, hooks?: ArchiveIoHooks) {
  const paths = auditPaths(hubRoot);
  if (!await pathExists(paths.journal)) return { recovered: false as const, outcome: "none" as const };
  const journalRead = await readJsonBounded(paths.journal, "Hub access-audit archive journal", hooks);
  const journal = validateJournal(journalRead.value, hubRoot);
  const maxBytes = Math.max(64 * 1024, journal.sourceSizeBytes);
  const current = await sourceState(hubRoot, maxBytes, hooks);
  const recoveryPaths = [
    paths.journal,
    journal.stage,
    stageOwnerPath(journal.stage),
    paths.log,
  ];

  if (await pathExists(journal.output)) {
    let liveLogQuarantine: string | null = null;
    let stageRecoveryPaths: string[] = [];
    try {
      const verified = await verifyHubAccessAuditArchive(journal.output, {
        signingKey,
        requireSignature: Boolean(signingKey),
        hooksForTest: hooks,
      });
      const publishedInfo = await assertPrivateRealDirectory(
        journal.output,
        "published Hub access-audit archive",
      );
      if (!journal.stageGeneration
        || !sameGenerationAcrossRename(journal.stageGeneration, generationOf(publishedInfo))) {
        throw archiveError(
          "published Hub access-audit archive generation does not match its journal",
          "HUB_ACCESS_AUDIT_ARCHIVE_RECOVERY_CONFLICT",
        );
      }
      const publishedGeneration = generationOf(publishedInfo);
      if (
        verified.manifest.manifestHash !== journal.manifestHash
        || verified.manifest.sha256 !== journal.sourceSha256
        || verified.manifest.lastHash !== journal.lastHash
        || verified.manifest.recordCount !== journal.recordCount
      ) {
        throw archiveError("published Hub access-audit archive does not match its journal", "HUB_ACCESS_AUDIT_ARCHIVE_RECOVERY_CONFLICT");
      }
      if (current.sizeBytes === 0 && current.sha256 === EMPTY_SHA256) {
        // The source reset committed before the process stopped.
      } else if (current.sizeBytes === journal.sourceSizeBytes && current.sha256 === journal.sourceSha256) {
        const preResetOutput = await assertPrivateRealDirectory(
          journal.output,
          "published Hub access-audit archive",
        );
        if (!sameGeneration(publishedGeneration, generationOf(preResetOutput))) {
          throw archiveError(
            "published Hub access-audit archive changed before source reset",
            "HUB_ACCESS_AUDIT_ARCHIVE_RECOVERY_CONFLICT",
          );
        }
        if (!current.generation) throw new Error("live Hub access-audit log generation is unavailable during recovery");
        liveLogQuarantine = await resetLiveLog(hubRoot, current.generation, hooks);
      } else {
        throw archiveError("live Hub access-audit log diverged after archive publication", "HUB_ACCESS_AUDIT_ARCHIVE_RECOVERY_CONFLICT");
      }
      stageRecoveryPaths = await removeStage(journal, signingKey, hooks);
      const finalOutput = await assertPrivateRealDirectory(
        journal.output,
        "published Hub access-audit archive",
      );
      if (!sameGeneration(publishedGeneration, generationOf(finalOutput))) {
        throw archiveError(
          "published Hub access-audit archive changed before recovery cleanup",
          "HUB_ACCESS_AUDIT_ARCHIVE_RECOVERY_CONFLICT",
        );
      }
      let journalQuarantine: string | null = null;
      try {
        journalQuarantine = await removeDurablePinned(paths.journal, journalRead.generation, hooks);
      } catch (error) {
        const committedPath = stageRecoveryPaths[0] || liveLogQuarantine;
        if (committedPath) {
          throw committedIsolationError(
            error,
            committedPath,
            [paths.journal, ...stageRecoveryPaths, ...(liveLogQuarantine ? [liveLogQuarantine] : [])],
          );
        }
        throw error;
      }
      return {
        recovered: true as const,
        outcome: "completed" as const,
        output: journal.output,
        recoveryPaths: [
          ...(liveLogQuarantine ? [liveLogQuarantine] : []),
          ...stageRecoveryPaths,
          ...(journalQuarantine ? [journalQuarantine] : []),
        ],
      };
    } catch (error) {
      throw committedArchiveError(
        error,
        journal.output,
        [
          ...recoveryPaths,
          ...(liveLogQuarantine ? [liveLogQuarantine] : []),
          ...stageRecoveryPaths,
        ],
      );
    }
  }

  if (current.sizeBytes !== journal.sourceSizeBytes || current.sha256 !== journal.sourceSha256) {
    throw archiveError("live Hub access-audit log diverged before archive publication", "HUB_ACCESS_AUDIT_ARCHIVE_RECOVERY_CONFLICT");
  }
  const stageRecoveryPaths = await removeStage(journal, signingKey, hooks);
  let journalQuarantine: string | null = null;
  try {
    journalQuarantine = await removeDurablePinned(paths.journal, journalRead.generation, hooks);
  } catch (error) {
    if (stageRecoveryPaths[0]) {
      throw committedIsolationError(
        error,
        stageRecoveryPaths[0],
        [paths.journal, ...stageRecoveryPaths],
      );
    }
    throw error;
  }
  return {
    recovered: true as const,
    outcome: "rolled_back" as const,
    output: journal.output,
    recoveryPaths: [...stageRecoveryPaths, ...(journalQuarantine ? [journalQuarantine] : [])],
  };
}

export async function verifyHubAccessAuditArchive(input: string, options: VerifyArchiveOptions = {}) {
  const requestedRoot = path.resolve(input);
  const requestedInfo = await lstat(requestedRoot);
  assertPrivateDirectoryInfo(requestedInfo, requestedRoot, "Hub access-audit archive");
  const rootGeneration = generationOf(requestedInfo);
  const archiveRoot = await realpath(requestedRoot);
  const canonicalInfo = await lstat(archiveRoot);
  if (!sameGeneration(rootGeneration, generationOf(canonicalInfo))) {
    throw new Error(`Hub access-audit archive identity changed while opening: ${requestedRoot}`);
  }
  const privateInfo = await assertPrivateRealDirectory(archiveRoot, "Hub access-audit archive");
  if (!sameGeneration(rootGeneration, generationOf(privateInfo))) {
    throw new Error(`Hub access-audit archive generation changed while opening: ${requestedRoot}`);
  }
  const entries = (await readdir(archiveRoot)).sort();
  if (JSON.stringify(entries) !== JSON.stringify([ARCHIVE_LOG_NAME, ARCHIVE_MANIFEST_NAME].sort())) {
    throw new Error("Hub access-audit archive file set mismatch");
  }
  const signingKey = normalizeSigningKey(options.signingKey);
  const manifestPath = path.join(archiveRoot, ARCHIVE_MANIFEST_NAME);
  const manifestRead = await readJsonBounded(
    manifestPath,
    "Hub access-audit archive manifest",
    options.hooksForTest,
  );
  const manifest = validateManifest(
    manifestRead.value,
    signingKey,
    Boolean(options.requireSignature),
  );
  const logPath = path.join(archiveRoot, ARCHIVE_LOG_NAME);
  const digest = await hashPrivateFile(
    logPath,
    "Hub access-audit archive log",
    manifest.sizeBytes,
    options.hooksForTest,
  );
  if (digest.sizeBytes !== manifest.sizeBytes || !constantTimeHexEqual(digest.sha256, manifest.sha256)) {
    throw new Error("Hub access-audit archive log hash or size mismatch");
  }
  const log = await verifyHubAccessAuditFile(logPath, { maxBytes: Math.max(64 * 1024, manifest.sizeBytes) });
  const postVerificationLog = await assertPrivateRealFile(logPath, "Hub access-audit archive log");
  if (!sameGeneration(digest.generation, generationOf(postVerificationLog))) {
    throw new Error("Hub access-audit archive log generation changed during record validation");
  }
  if (
    log.recordCount !== manifest.recordCount
    || log.lastSequence !== manifest.lastSequence
    || log.lastHash !== manifest.lastHash
  ) throw new Error("Hub access-audit archive log summary mismatch");
  await options.hooksForTest?.afterArchiveValidation?.({ archiveRoot });
  const finalManifest = await assertPrivateRealFile(manifestPath, "Hub access-audit archive manifest");
  const finalLog = await assertPrivateRealFile(logPath, "Hub access-audit archive log");
  if (!sameGeneration(manifestRead.generation, generationOf(finalManifest))) {
    throw new Error("Hub access-audit archive manifest generation changed after validation");
  }
  if (!sameGeneration(digest.generation, generationOf(finalLog))) {
    throw new Error("Hub access-audit archive log generation changed after validation");
  }
  const finalCanonicalRoot = await realpath(requestedRoot);
  const finalRequestedRoot = await assertPrivateRealDirectory(requestedRoot, "Hub access-audit archive");
  const finalArchiveRoot = await assertPrivateRealDirectory(archiveRoot, "Hub access-audit archive");
  if (
    finalCanonicalRoot !== archiveRoot
    || !sameGeneration(rootGeneration, generationOf(finalRequestedRoot))
    || !sameGeneration(rootGeneration, generationOf(finalArchiveRoot))
  ) throw new Error("Hub access-audit archive generation changed after validation");
  return {
    archiveRoot,
    manifest,
    log: {
      recordCount: log.recordCount,
      lastSequence: log.lastSequence,
      lastHash: log.lastHash,
      sizeBytes: log.sizeBytes,
      sha256: digest.sha256,
    },
    signatureVerified: Boolean(manifest.signature && signingKey),
  };
}

export async function recoverHubAccessAuditArchive(options: RecoverArchiveOptions) {
  const requestedHubRoot = path.resolve(options.hubRoot);
  if (!await pathExists(requestedHubRoot)) {
    return { recovered: false as const, outcome: "none" as const };
  }
  const hubRoot = await canonicalHubRoot(requestedHubRoot);
  if (!await pathExists(auditPaths(hubRoot).journal)) {
    return { recovered: false as const, outcome: "none" as const };
  }
  const maintenance = await acquireHubMaintenance(hubRoot, "Hub access-audit archive recovery");
  let result: Awaited<ReturnType<typeof recoverUnlocked>> | undefined;
  let operationError: unknown = null;
  try {
    await assertOffline(hubRoot);
    result = await recoverUnlocked(hubRoot, options.signingKey, options.hooksForTest);
  } catch (error) {
    operationError = error;
  }
  let releaseError: unknown = null;
  try {
    if (!await maintenance.release()) {
      releaseError = new Error(`Hub access-audit archive recovery lost maintenance lock ownership: ${maintenance.lockPath}`);
    }
  } catch (error) {
    releaseError = error;
  }
  if (operationError) {
    if (releaseError && operationError instanceof Error) {
      Object.assign(operationError, {
        cleanupErrors: [releaseError],
        recoveryPaths: [...new Set([...recoveryPathList(operationError), maintenance.lockPath])],
      });
    }
    throw operationError;
  }
  if (releaseError) {
    throw result?.outcome === "completed" && result.output
      ? committedArchiveError(releaseError, result.output, [
        auditPaths(hubRoot).journal,
        auditPaths(hubRoot).log,
        maintenance.lockPath,
      ])
      : releaseError;
  }
  if (!result) throw new Error("Hub access-audit archive recovery completed without a result");
  return result;
}

export async function createHubAccessAuditArchive(options: ArchiveOptions) {
  const hubRoot = await canonicalHubRoot(options.hubRoot);
  const output = await canonicalOutput(hubRoot, options.output);
  const signingKey = normalizeSigningKey(options.signingKey);
  const maintenance = await acquireHubMaintenance(hubRoot, "Hub access-audit archive");
  const paths = auditPaths(hubRoot);
  let published = false;
  const isolationRecoveryPaths: string[] = [];
  let result: {
    output: string;
    manifest: HubAccessAuditArchiveManifest;
    recoveryPaths: string[];
  } | undefined;
  let operationError: unknown = null;
  try {
    await assertOffline(hubRoot);
    await recoverUnlocked(hubRoot, options.signingKey, options.hooksForTest);
    if (await pathExists(output)) throw new Error(`Hub access-audit archive output already exists: ${output}`);

    const verified = await verifyHubAccessAudit({ hubRoot, maxBytes: options.maxBytes });
    if (verified.recordCount === 0 || verified.sizeBytes === 0) {
      throw archiveError("Hub access-audit log is empty; there is nothing to archive", "HUB_ACCESS_AUDIT_EMPTY");
    }
    await assertArchiveCapacity(
      output,
      verified.sizeBytes,
      normalizeMinimumFreeBytes(options.minimumFreeBytes),
    );
    const sourceDigest = await hashPrivateFile(
      verified.filePath,
      "Hub access-audit log",
      verified.maxBytes,
      options.hooksForTest,
    );
    if (sourceDigest.fingerprint !== verified.fileFingerprint) {
      throw new Error("Hub access-audit log changed between verification and archive hashing");
    }

    const operationId = randomUUID();
    const createdAt = new Date().toISOString();
    const manifest = buildManifest({
      format: ARCHIVE_FORMAT,
      archiveId: operationId,
      createdAt,
      sourceHubRootHash: hubRootHash(hubRoot),
      logFile: ARCHIVE_LOG_NAME,
      sizeBytes: sourceDigest.sizeBytes,
      sha256: sourceDigest.sha256,
      recordCount: verified.recordCount,
      lastSequence: verified.lastSequence,
      lastHash: verified.lastHash,
    }, signingKey);
    const stage = stagePath(hubRoot, output);
    const journal: ArchiveJournal = {
      format: ARCHIVE_JOURNAL_FORMAT,
      operationId,
      createdAt,
      sourceHubRootHash: hubRootHash(hubRoot),
      output,
      stage,
      sourceSizeBytes: sourceDigest.sizeBytes,
      sourceSha256: sourceDigest.sha256,
      recordCount: verified.recordCount,
      lastSequence: verified.lastSequence,
      lastHash: verified.lastHash,
      manifestHash: manifest.manifestHash,
      stageGeneration: null,
    };
    if (await pathExists(stage)) throw new Error(`Hub access-audit archive stage already exists: ${stage}`);
    const ownerPath = stageOwnerPath(stage);
    if (await pathExists(ownerPath)) throw new Error(`Hub access-audit archive stage owner already exists: ${ownerPath}`);
    await writeJsonDurableAtomic(paths.journal, journal);
    await options.faultInjector?.("prepared");

    const owner: ArchiveStageOwner = {
      format: ARCHIVE_STAGE_FORMAT,
      operationId,
      sourceHubRootHash: journal.sourceHubRootHash,
      output,
      createdAt,
      stageGeneration: null,
    };
    await writeJsonDurableAtomic(ownerPath, owner);
    await options.faultInjector?.("stage_owned");
    await mkdir(stage, { mode: 0o700 });
    await fsyncDirectory(path.dirname(stage));
    const initialStage = await assertPrivateRealDirectory(stage, "Hub access-audit archive stage");
    const initialStageGeneration = generationOf(initialStage);
    owner.stageGeneration = initialStageGeneration;
    journal.stageGeneration = initialStageGeneration;
    await writeJsonDurableAtomic(ownerPath, owner);
    await writeJsonDurableAtomic(paths.journal, journal);
    await options.faultInjector?.("stage_created");
    const copied = await copyPrivateFileWithHash(
      verified.filePath,
      path.join(stage, ARCHIVE_LOG_NAME),
      verified.maxBytes,
      options.hooksForTest,
    );
    if (
      copied.sizeBytes !== sourceDigest.sizeBytes
      || copied.sha256 !== sourceDigest.sha256
      || copied.sourceFingerprint !== sourceDigest.fingerprint
      || !sameGeneration(copied.sourceGeneration, sourceDigest.generation)
    ) throw new Error("Hub access-audit archive copy does not match the verified source");
    await writeJsonDurableAtomic(path.join(stage, ARCHIVE_MANIFEST_NAME), manifest);
    await fsyncDirectory(stage);
    const stagedInfo = await assertPrivateRealDirectory(stage, "Hub access-audit archive stage");
    const stagedGeneration = generationOf(stagedInfo);
    owner.stageGeneration = stagedGeneration;
    journal.stageGeneration = stagedGeneration;
    await writeJsonDurableAtomic(ownerPath, owner);
    await writeJsonDurableAtomic(paths.journal, journal);
    const ownerRead = await readJsonBounded(
      ownerPath,
      "Hub access-audit archive stage owner",
      options.hooksForTest,
    );
    validateStageOwner(ownerRead.value, journal);
    const ownerQuarantine = await removeDurablePinned(ownerPath, ownerRead.generation, options.hooksForTest);
    if (ownerQuarantine) isolationRecoveryPaths.push(ownerQuarantine);
    await verifyHubAccessAuditArchive(stage, {
      signingKey: options.signingKey,
      requireSignature: Boolean(signingKey),
      hooksForTest: options.hooksForTest,
    });
    await options.faultInjector?.("staged");

    const prePublishStage = await assertPrivateRealDirectory(stage, "Hub access-audit archive stage");
    if (!journal.stageGeneration
      || !sameGeneration(journal.stageGeneration, generationOf(prePublishStage))) {
      throw preservationError(
        `Hub access-audit archive stage changed before publication: ${stage}`,
        [stage, ownerPath, paths.journal],
      );
    }
    if (await pathExists(output)) throw new Error(`Hub access-audit archive output already exists: ${output}`);
    await rename(stage, output);
    published = true;
    const publishedInfo = await assertPrivateRealDirectory(output, "Hub access-audit archive");
    if (!sameGenerationAcrossRename(generationOf(prePublishStage), generationOf(publishedInfo))) {
      throw preservationError(
        `Hub access-audit archive generation changed during publication: ${output}`,
        [output, stage, ownerPath, paths.journal],
      );
    }
    if (await pathExists(stage)) {
      throw preservationError(
        `Hub access-audit archive stage successor preserved during publication: ${stage}`,
        [output, stage, ownerPath, paths.journal],
      );
    }
    const publishedGeneration = generationOf(publishedInfo);
    await fsyncDirectory(path.dirname(output));
    await options.faultInjector?.("published");
    const publishedVerification = await verifyHubAccessAuditArchive(output, {
      signingKey: options.signingKey,
      requireSignature: Boolean(signingKey),
      hooksForTest: options.hooksForTest,
    });
    if (publishedVerification.manifest.manifestHash !== journal.manifestHash) {
      throw archiveError(
        "published Hub access-audit archive does not match its journal",
        "HUB_ACCESS_AUDIT_ARCHIVE_RECOVERY_CONFLICT",
      );
    }
    const postVerificationOutput = await assertPrivateRealDirectory(output, "Hub access-audit archive");
    if (!sameGeneration(publishedGeneration, generationOf(postVerificationOutput))) {
      throw archiveError(
        "published Hub access-audit archive changed during publication verification",
        "HUB_ACCESS_AUDIT_ARCHIVE_RECOVERY_CONFLICT",
      );
    }

    const current = await sourceState(hubRoot, verified.maxBytes, options.hooksForTest);
    if (current.sizeBytes !== journal.sourceSizeBytes || current.sha256 !== journal.sourceSha256) {
      throw archiveError("live Hub access-audit log changed before reset", "HUB_ACCESS_AUDIT_ARCHIVE_RECOVERY_CONFLICT");
    }
    const preResetOutput = await assertPrivateRealDirectory(output, "Hub access-audit archive");
    if (!sameGeneration(publishedGeneration, generationOf(preResetOutput))) {
      throw archiveError(
        "published Hub access-audit archive changed before source reset",
        "HUB_ACCESS_AUDIT_ARCHIVE_RECOVERY_CONFLICT",
      );
    }
    if (!current.generation) throw new Error("live Hub access-audit log generation is unavailable before reset");
    const liveLogQuarantine = await resetLiveLog(hubRoot, current.generation, options.hooksForTest);
    if (liveLogQuarantine) isolationRecoveryPaths.push(liveLogQuarantine);
    const journalRead = await readJsonBounded(
      paths.journal,
      "Hub access-audit archive journal",
      options.hooksForTest,
    );
    const currentJournal = validateJournal(journalRead.value, hubRoot);
    if (currentJournal.operationId !== journal.operationId
      || currentJournal.manifestHash !== journal.manifestHash
      || !currentJournal.stageGeneration
      || !journal.stageGeneration
      || !sameGeneration(currentJournal.stageGeneration, journal.stageGeneration)) {
      throw preservationError(
        `Hub access-audit archive journal generation changed before cleanup: ${paths.journal}`,
        [output, paths.journal, stage, ownerPath],
      );
    }
    const finalOutput = await assertPrivateRealDirectory(output, "Hub access-audit archive");
    if (!sameGeneration(publishedGeneration, generationOf(finalOutput))) {
      throw archiveError(
        "published Hub access-audit archive changed before transaction cleanup",
        "HUB_ACCESS_AUDIT_ARCHIVE_RECOVERY_CONFLICT",
      );
    }
    const journalQuarantine = await removeDurablePinned(
      paths.journal,
      journalRead.generation,
      options.hooksForTest,
    );
    if (journalQuarantine) isolationRecoveryPaths.push(journalQuarantine);
    result = { output, manifest, recoveryPaths: [...isolationRecoveryPaths] };
  } catch (error) {
    operationError = published
      ? committedArchiveError(error, output, [
        paths.journal,
        stagePath(hubRoot, output),
        stageOwnerPath(stagePath(hubRoot, output)),
        paths.log,
        ...isolationRecoveryPaths,
      ])
      : isolationRecoveryPaths[0]
        ? committedIsolationError(error, isolationRecoveryPaths[0], isolationRecoveryPaths)
        : error;
  }
  let releaseError: unknown = null;
  try {
    if (!await maintenance.release()) {
      releaseError = new Error(`Hub access-audit archive lost maintenance lock ownership: ${maintenance.lockPath}`);
    }
  } catch (error) {
    releaseError = error;
  }
  if (operationError) {
    if (releaseError && operationError instanceof Error) {
      Object.assign(operationError, {
        cleanupErrors: [releaseError],
        recoveryPaths: [...new Set([...recoveryPathList(operationError), maintenance.lockPath])],
      });
    }
    throw operationError;
  }
  if (releaseError) {
    throw published
      ? committedArchiveError(releaseError, output, [paths.journal, paths.log, maintenance.lockPath])
      : releaseError;
  }
  if (!result) throw new Error("Hub access-audit archive completed without a result");
  return result;
}
