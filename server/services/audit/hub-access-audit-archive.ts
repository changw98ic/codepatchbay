import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, statfs } from "node:fs/promises";
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
};

type ArchiveStageOwner = {
  format: typeof ARCHIVE_STAGE_FORMAT;
  operationId: string;
  sourceHubRootHash: string;
  output: string;
  createdAt: string;
};

type ArchivePhase = "prepared" | "stage_owned" | "stage_created" | "staged" | "published";

type ArchiveOptions = {
  hubRoot: string;
  output: string;
  signingKey?: string;
  maxBytes?: number | string;
  minimumFreeBytes?: number | string;
  faultInjector?: (phase: ArchivePhase) => void | Promise<void>;
};

type VerifyArchiveOptions = {
  signingKey?: string;
  requireSignature?: boolean;
};

type RecoverArchiveOptions = {
  hubRoot: string;
  signingKey?: string;
};

function errnoCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

function archiveError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
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

function fileFingerprint(info: Awaited<ReturnType<typeof lstat>>) {
  return `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

async function assertPrivateRealFile(filePath: string, label: string) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a real file: ${filePath}`);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible by group or other users: ${filePath}`);
  }
  return info;
}

async function assertPrivateRealDirectory(directory: string, label: string) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory: ${directory}`);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible by group or other users: ${directory}`);
  }
  return info;
}

async function readJsonBounded(filePath: string, label: string) {
  const linkInfo = await assertPrivateRealFile(filePath, label);
  if (linkInfo.size > MAX_METADATA_BYTES) throw new Error(`${label} exceeds ${MAX_METADATA_BYTES} bytes`);
  const handle = await open(filePath, "r");
  try {
    const before = await handle.stat();
    if (fileFingerprint(linkInfo) !== fileFingerprint(before)) throw new Error(`${label} changed before open`);
    const buffer = Buffer.alloc(MAX_METADATA_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const result = await handle.read(buffer, total, buffer.length - total, total);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
    }
    if (total > MAX_METADATA_BYTES) throw new Error(`${label} exceeds ${MAX_METADATA_BYTES} bytes`);
    const after = await handle.stat();
    if (fileFingerprint(before) !== fileFingerprint(after)) throw new Error(`${label} changed during read`);
    return JSON.parse(buffer.subarray(0, total).toString("utf8"));
  } finally {
    await handle.close();
  }
}

async function hashPrivateFile(filePath: string, label: string, maxBytes: number) {
  const linkInfo = await assertPrivateRealFile(filePath, label);
  if (linkInfo.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  const handle = await open(filePath, "r");
  try {
    const before = await handle.stat();
    if (fileFingerprint(linkInfo) !== fileFingerprint(before)) throw new Error(`${label} changed before open`);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (result.bytesRead === 0) throw new Error(`${label} ended before its declared size`);
      hash.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
    if (extra.bytesRead !== 0) throw new Error(`${label} grew during hashing`);
    const after = await handle.stat();
    if (fileFingerprint(before) !== fileFingerprint(after)) throw new Error(`${label} changed during hashing`);
    return { sizeBytes: offset, sha256: hash.digest("hex"), fingerprint: fileFingerprint(after) };
  } finally {
    await handle.close();
  }
}

async function copyPrivateFileWithHash(source: string, destination: string, maxBytes: number) {
  const linkInfo = await assertPrivateRealFile(source, "Hub access-audit log");
  if (linkInfo.size > maxBytes) throw new Error(`Hub access-audit log exceeds ${maxBytes} bytes`);
  const sourceHandle = await open(source, "r");
  let destinationHandle: Awaited<ReturnType<typeof open>> | null = null;
  let complete = false;
  try {
    const before = await sourceHandle.stat();
    if (fileFingerprint(linkInfo) !== fileFingerprint(before)) throw new Error("Hub access-audit log changed before archive copy");
    destinationHandle = await open(destination, "wx", 0o600);
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
    }
    const extra = await sourceHandle.read(Buffer.alloc(1), 0, 1, offset);
    if (extra.bytesRead !== 0) throw new Error("Hub access-audit log grew during archive copy");
    const after = await sourceHandle.stat();
    if (fileFingerprint(before) !== fileFingerprint(after)) throw new Error("Hub access-audit log changed during archive copy");
    await destinationHandle.sync();
    complete = true;
    return { sizeBytes: offset, sha256: hash.digest("hex"), sourceFingerprint: fileFingerprint(after) };
  } finally {
    await sourceHandle.close();
    await destinationHandle?.close().catch(() => undefined);
    if (!complete) await rm(destination, { force: true }).catch(() => undefined);
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

function validateJournal(raw: unknown, hubRoot: string): ArchiveJournal {
  const value = recordValue(raw, "Hub access-audit archive journal");
  exactKeys(value, [
    "format", "operationId", "createdAt", "sourceHubRootHash", "output", "stage",
    "sourceSizeBytes", "sourceSha256", "recordCount", "lastSequence", "lastHash", "manifestHash",
  ], "Hub access-audit archive journal");
  const journal = value as unknown as ArchiveJournal;
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
  exactKeys(value, ["format", "operationId", "sourceHubRootHash", "output", "createdAt"], "Hub access-audit archive stage owner");
  const owner = value as unknown as ArchiveStageOwner;
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

async function resetLiveLog(hubRoot: string) {
  const paths = auditPaths(hubRoot);
  await assertPrivateRealDirectory(paths.directory, "Hub access-audit directory");
  const temporary = path.join(paths.directory, `.${ARCHIVE_LOG_NAME}.${process.pid}.${randomUUID()}.reset`);
  const handle = await open(temporary, "wx", 0o600);
  let closed = false;
  let renamed = false;
  try {
    await handle.sync();
    await handle.close();
    closed = true;
    await rename(temporary, paths.log);
    renamed = true;
    await fsyncDirectory(paths.directory);
  } finally {
    if (!closed) await handle.close().catch(() => undefined);
    if (!renamed) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function sourceState(hubRoot: string, maxBytes: number) {
  const log = auditPaths(hubRoot).log;
  if (!await pathExists(log)) return { sizeBytes: 0, sha256: EMPTY_SHA256 };
  return hashPrivateFile(log, "Hub access-audit log", maxBytes);
}

async function removeStage(journal: ArchiveJournal, signingKey: string | undefined) {
  const ownerPath = stageOwnerPath(journal.stage);
  const ownerExists = await pathExists(ownerPath);
  if (ownerExists) {
    validateStageOwner(await readJsonBounded(ownerPath, "Hub access-audit archive stage owner"), journal);
  }
  if (await pathExists(journal.stage)) {
    await assertPrivateRealDirectory(journal.stage, "Hub access-audit archive stage");
    if (!ownerExists) {
      const staged = await verifyHubAccessAuditArchive(journal.stage, { signingKey });
      if (staged.manifest.manifestHash !== journal.manifestHash) {
        throw new Error("Hub access-audit archive refuses mismatched stage cleanup");
      }
    }
    await rm(journal.stage, { recursive: true, force: true });
    await fsyncDirectory(path.dirname(journal.stage));
  }
  if (ownerExists) await removeDurable(ownerPath);
}

async function recoverUnlocked(hubRoot: string, signingKey?: string) {
  const paths = auditPaths(hubRoot);
  if (!await pathExists(paths.journal)) return { recovered: false as const, outcome: "none" as const };
  const journal = validateJournal(
    await readJsonBounded(paths.journal, "Hub access-audit archive journal"),
    hubRoot,
  );
  const maxBytes = Math.max(64 * 1024, journal.sourceSizeBytes);
  const current = await sourceState(hubRoot, maxBytes);

  if (await pathExists(journal.output)) {
    const verified = await verifyHubAccessAuditArchive(journal.output, {
      signingKey,
      requireSignature: Boolean(signingKey),
    });
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
      await resetLiveLog(hubRoot);
    } else {
      throw archiveError("live Hub access-audit log diverged after archive publication", "HUB_ACCESS_AUDIT_ARCHIVE_RECOVERY_CONFLICT");
    }
    await removeStage(journal, signingKey);
    await removeDurable(paths.journal);
    return { recovered: true as const, outcome: "completed" as const, output: journal.output };
  }

  if (current.sizeBytes !== journal.sourceSizeBytes || current.sha256 !== journal.sourceSha256) {
    throw archiveError("live Hub access-audit log diverged before archive publication", "HUB_ACCESS_AUDIT_ARCHIVE_RECOVERY_CONFLICT");
  }
  await removeStage(journal, signingKey);
  await removeDurable(paths.journal);
  return { recovered: true as const, outcome: "rolled_back" as const, output: journal.output };
}

export async function verifyHubAccessAuditArchive(input: string, options: VerifyArchiveOptions = {}) {
  const requestedRoot = path.resolve(input);
  const requestedInfo = await lstat(requestedRoot);
  if (!requestedInfo.isDirectory() || requestedInfo.isSymbolicLink()) {
    throw new Error(`Hub access-audit archive must be a real directory: ${requestedRoot}`);
  }
  const archiveRoot = await realpath(requestedRoot);
  const canonicalInfo = await lstat(archiveRoot);
  if (canonicalInfo.dev !== requestedInfo.dev || canonicalInfo.ino !== requestedInfo.ino) {
    throw new Error(`Hub access-audit archive identity changed while opening: ${requestedRoot}`);
  }
  await assertPrivateRealDirectory(archiveRoot, "Hub access-audit archive");
  const entries = (await readdir(archiveRoot)).sort();
  if (JSON.stringify(entries) !== JSON.stringify([ARCHIVE_LOG_NAME, ARCHIVE_MANIFEST_NAME].sort())) {
    throw new Error("Hub access-audit archive file set mismatch");
  }
  const signingKey = normalizeSigningKey(options.signingKey);
  const manifest = validateManifest(
    await readJsonBounded(path.join(archiveRoot, ARCHIVE_MANIFEST_NAME), "Hub access-audit archive manifest"),
    signingKey,
    Boolean(options.requireSignature),
  );
  const logPath = path.join(archiveRoot, ARCHIVE_LOG_NAME);
  const digest = await hashPrivateFile(logPath, "Hub access-audit archive log", manifest.sizeBytes);
  if (digest.sizeBytes !== manifest.sizeBytes || !constantTimeHexEqual(digest.sha256, manifest.sha256)) {
    throw new Error("Hub access-audit archive log hash or size mismatch");
  }
  const log = await verifyHubAccessAuditFile(logPath, { maxBytes: Math.max(64 * 1024, manifest.sizeBytes) });
  if (
    log.recordCount !== manifest.recordCount
    || log.lastSequence !== manifest.lastSequence
    || log.lastHash !== manifest.lastHash
  ) throw new Error("Hub access-audit archive log summary mismatch");
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
  const hubRoot = await canonicalHubRoot(options.hubRoot);
  if (!await pathExists(auditPaths(hubRoot).journal)) {
    return { recovered: false as const, outcome: "none" as const };
  }
  const maintenance = await acquireHubMaintenance(hubRoot, "Hub access-audit archive recovery");
  try {
    await assertOffline(hubRoot);
    return await recoverUnlocked(hubRoot, options.signingKey);
  } finally {
    if (!await maintenance.release()) {
      throw new Error(`Hub access-audit archive recovery lost maintenance lock ownership: ${maintenance.lockPath}`);
    }
  }
}

export async function createHubAccessAuditArchive(options: ArchiveOptions) {
  const hubRoot = await canonicalHubRoot(options.hubRoot);
  const output = await canonicalOutput(hubRoot, options.output);
  const signingKey = normalizeSigningKey(options.signingKey);
  const maintenance = await acquireHubMaintenance(hubRoot, "Hub access-audit archive");
  try {
    await assertOffline(hubRoot);
    await recoverUnlocked(hubRoot, options.signingKey);
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
    const sourceDigest = await hashPrivateFile(verified.filePath, "Hub access-audit log", verified.maxBytes);
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
    };
    const paths = auditPaths(hubRoot);
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
    };
    await writeJsonDurableAtomic(ownerPath, owner);
    await options.faultInjector?.("stage_owned");
    await mkdir(stage, { mode: 0o700 });
    await fsyncDirectory(path.dirname(stage));
    await options.faultInjector?.("stage_created");
    const copied = await copyPrivateFileWithHash(verified.filePath, path.join(stage, ARCHIVE_LOG_NAME), verified.maxBytes);
    if (
      copied.sizeBytes !== sourceDigest.sizeBytes
      || copied.sha256 !== sourceDigest.sha256
      || copied.sourceFingerprint !== sourceDigest.fingerprint
    ) throw new Error("Hub access-audit archive copy does not match the verified source");
    await writeJsonDurableAtomic(path.join(stage, ARCHIVE_MANIFEST_NAME), manifest);
    await fsyncDirectory(stage);
    await removeDurable(ownerPath);
    await verifyHubAccessAuditArchive(stage, {
      signingKey: options.signingKey,
      requireSignature: Boolean(signingKey),
    });
    await options.faultInjector?.("staged");

    await rename(stage, output);
    await fsyncDirectory(path.dirname(output));
    await options.faultInjector?.("published");

    const current = await sourceState(hubRoot, verified.maxBytes);
    if (current.sizeBytes !== journal.sourceSizeBytes || current.sha256 !== journal.sourceSha256) {
      throw archiveError("live Hub access-audit log changed before reset", "HUB_ACCESS_AUDIT_ARCHIVE_RECOVERY_CONFLICT");
    }
    await resetLiveLog(hubRoot);
    await removeDurable(paths.journal);
    return { output, manifest };
  } finally {
    if (!await maintenance.release()) {
      throw new Error(`Hub access-audit archive lost maintenance lock ownership: ${maintenance.lockPath}`);
    }
  }
}
