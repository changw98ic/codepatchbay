import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import {
  fsyncDirectory,
  removeDurable,
  writeJsonDurableAtomic,
} from "../../../shared/hub-maintenance.js";
import type { HubRedisStateBackend, RedisAccessAuditHead } from "../../../shared/hub-state-redis.js";

const AUDIT_FORMAT = "cpb-hub-access-audit/v1";
const PENDING_FORMAT = "cpb-hub-access-audit-pending/v1";
const GENESIS_HASH = "0".repeat(64);
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const MIN_MAX_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_AUDIT_PATH_BYTES = 4096;

export type HubAuditOutcome =
  | "allowed"
  | "mutation_intent"
  | "authentication_denied"
  | "authorization_denied"
  | "not_found"
  | "error";

export type HubAccessAuditInput = {
  requestId: string;
  method: string;
  path: string;
  statusCode: number;
  outcome: HubAuditOutcome;
  principalId?: string | null;
  principalSource?: string | null;
  remoteAddress?: string | null;
  requiredScope?: string | null;
  errorCode?: string | null;
  durationMs: number;
};

export type HubAccessAuditRecord = {
  format: typeof AUDIT_FORMAT;
  sequence: number;
  timestamp: string;
  requestId: string;
  method: string;
  path: string;
  pathTruncated: boolean;
  statusCode: number;
  outcome: HubAuditOutcome;
  principalId: string | null;
  principalSource: string | null;
  remoteAddress: string | null;
  requiredScope: string | null;
  errorCode: string | null;
  durationMs: number;
  previousHash: string;
  hash: string;
};

type AuditState = {
  filePath: string;
  pendingPath: string;
  recordCount: number;
  lastSequence: number;
  lastHash: string;
  sizeBytes: number;
  fileIdentity: string | null;
  fileFingerprint: string | null;
  maxBytes: number;
};

type PendingRecord = {
  format: typeof PENDING_FORMAT;
  record: HubAccessAuditRecord;
};

type AuditOptions = {
  hubRoot: string;
  maxBytes?: number | string;
  redisBackend?: HubRedisStateBackend | null;
};

function errnoCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
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

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} field set mismatch`);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("audit canonical JSON refuses non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new Error(`audit canonical JSON refuses ${typeof value}`);
}

function hashRecordPayload(record: Omit<HubAccessAuditRecord, "hash">) {
  return createHash("sha256").update(canonicalJson(record), "utf8").digest("hex");
}

function withoutHash(record: HubAccessAuditRecord): Omit<HubAccessAuditRecord, "hash"> {
  const { hash: _hash, ...payload } = record;
  return payload;
}

function normalizeMaxBytes(value: unknown) {
  const configured = value === undefined ? process.env.CPB_HUB_ACCESS_AUDIT_MAX_BYTES : value;
  if (configured === undefined || configured === "") return DEFAULT_MAX_BYTES;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_MAX_BYTES) {
    throw new Error(`CPB_HUB_ACCESS_AUDIT_MAX_BYTES must be a safe integer of at least ${MIN_MAX_BYTES}`);
  }
  return parsed;
}

function fileIdentity(info: Stats) {
  return `${info.dev}:${info.ino}`;
}

function fileFingerprint(info: Stats) {
  return `${fileIdentity(info)}:${info.mode}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

function auditPaths(hubRoot: string) {
  const directory = path.join(path.resolve(hubRoot), "audit");
  return {
    directory,
    filePath: path.join(directory, "http-access.jsonl"),
    pendingPath: path.join(directory, "http-access.pending.json"),
    archiveJournalPath: path.join(directory, "http-access.archive.json"),
  };
}

async function assertPrivateRealFile(filePath: string, label: string) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a real file: ${filePath}`);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible by group or other users: ${filePath}`);
  }
  return info;
}

async function readPrivateFileBounded(filePath: string, label: string, maxBytes: number) {
  const linkInfo = await assertPrivateRealFile(filePath, label);
  if (linkInfo.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  const handle = await open(filePath, "r");
  try {
    const before = await handle.stat();
    if (fileFingerprint(linkInfo) !== fileFingerprint(before)) throw new Error(`${label} changed before it was opened`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
    const after = await handle.stat();
    if (fileFingerprint(before) !== fileFingerprint(after)) throw new Error(`${label} changed while it was being read`);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function stringOrNull(value: unknown, label: string, maxBytes = 256) {
  if (value === null) return null;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes || /[\r\n]/.test(value)) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function validateAuditRecord(
  raw: unknown,
  expectedSequence: number,
  expectedPreviousHash: string,
): HubAccessAuditRecord {
  const value = recordValue(raw, "Hub access-audit record");
  assertExactKeys(value, [
    "format", "sequence", "timestamp", "requestId", "method", "path", "pathTruncated",
    "statusCode", "outcome", "principalId", "principalSource", "remoteAddress",
    "requiredScope", "errorCode", "durationMs", "previousHash", "hash",
  ], "Hub access-audit record");
  const sequence = Number(value.sequence);
  const timestamp = String(value.timestamp || "");
  const timestampMs = Date.parse(timestamp);
  const requestId = String(value.requestId || "");
  const method = String(value.method || "");
  const requestPath = String(value.path || "");
  const statusCode = Number(value.statusCode);
  const outcome = value.outcome as HubAuditOutcome;
  const durationMs = Number(value.durationMs);
  const previousHash = String(value.previousHash || "");
  const hash = String(value.hash || "");
  if (!Number.isSafeInteger(sequence) || sequence !== expectedSequence) throw new Error(`Hub access-audit sequence mismatch at ${expectedSequence}`);
  if (!Number.isFinite(timestampMs) || new Date(timestampMs).toISOString() !== timestamp) throw new Error(`invalid Hub access-audit timestamp at sequence ${sequence}`);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(requestId)) {
    throw new Error(`invalid Hub access-audit requestId at sequence ${sequence}`);
  }
  if (!/^[!#$%&'*+.^_`|~0-9A-Z-]{1,32}$/.test(method)) throw new Error(`invalid Hub access-audit method at sequence ${sequence}`);
  if (!requestPath.startsWith("/") || Buffer.byteLength(requestPath, "utf8") > MAX_AUDIT_PATH_BYTES || /[\r\n?#]/.test(requestPath)) {
    throw new Error(`invalid Hub access-audit path at sequence ${sequence}`);
  }
  if (typeof value.pathTruncated !== "boolean") throw new Error(`invalid Hub access-audit pathTruncated at sequence ${sequence}`);
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) throw new Error(`invalid Hub access-audit status at sequence ${sequence}`);
  if (!["allowed", "mutation_intent", "authentication_denied", "authorization_denied", "not_found", "error"].includes(outcome)) {
    throw new Error(`invalid Hub access-audit outcome at sequence ${sequence}`);
  }
  const principalId = stringOrNull(value.principalId, `principalId at sequence ${sequence}`, 256);
  const principalSource = stringOrNull(value.principalSource, `principalSource at sequence ${sequence}`, 64);
  const remoteAddress = stringOrNull(value.remoteAddress, `remoteAddress at sequence ${sequence}`, 256);
  const requiredScope = stringOrNull(value.requiredScope, `requiredScope at sequence ${sequence}`, 64);
  const errorCode = stringOrNull(value.errorCode, `errorCode at sequence ${sequence}`, 128);
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) throw new Error(`invalid Hub access-audit duration at sequence ${sequence}`);
  if (previousHash !== expectedPreviousHash || !/^[a-f0-9]{64}$/.test(previousHash)) {
    throw new Error(`Hub access-audit previous hash mismatch at sequence ${sequence}`);
  }
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`invalid Hub access-audit hash at sequence ${sequence}`);
  const record: HubAccessAuditRecord = {
    format: AUDIT_FORMAT,
    sequence,
    timestamp,
    requestId,
    method,
    path: requestPath,
    pathTruncated: value.pathTruncated,
    statusCode,
    outcome,
    principalId,
    principalSource,
    remoteAddress,
    requiredScope,
    errorCode,
    durationMs,
    previousHash,
    hash,
  };
  if (value.format !== AUDIT_FORMAT || hashRecordPayload(withoutHash(record)) !== hash) {
    throw new Error(`Hub access-audit hash mismatch at sequence ${sequence}`);
  }
  return record;
}

async function verifyAuditFile(filePath: string, pendingPath: string, maxBytes: number): Promise<AuditState> {
  if (!await pathExists(filePath)) {
    return {
      filePath,
      pendingPath,
      recordCount: 0,
      lastSequence: 0,
      lastHash: GENESIS_HASH,
      sizeBytes: 0,
      fileIdentity: null,
      fileFingerprint: null,
      maxBytes,
    };
  }
  const linkInfo = await assertPrivateRealFile(filePath, "Hub access-audit log");
  if (linkInfo.size > maxBytes) throw new Error(`Hub access-audit log exceeds ${maxBytes} bytes`);
  const handle = await open(filePath, "r");
  try {
    const before = await handle.stat();
    if (fileFingerprint(linkInfo) !== fileFingerprint(before)) throw new Error("Hub access-audit log changed before verification opened it");
    if (before.size > 0) {
      const last = Buffer.alloc(1);
      const read = await handle.read(last, 0, 1, before.size - 1);
      if (read.bytesRead !== 1 || last[0] !== 0x0a) throw new Error("Hub access-audit log has a truncated final record");
    }
    let sequence = 0;
    let previousHash = GENESIS_HASH;
    const lines = createInterface({ input: handle.createReadStream({ encoding: "utf8", autoClose: false }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line || Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) throw new Error(`invalid Hub access-audit line at sequence ${sequence + 1}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid Hub access-audit JSON at sequence ${sequence + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const record = validateAuditRecord(parsed, sequence + 1, previousHash);
      sequence = record.sequence;
      previousHash = record.hash;
    }
    const after = await handle.stat();
    if (fileFingerprint(before) !== fileFingerprint(after)) throw new Error("Hub access-audit log changed during verification");
    return {
      filePath,
      pendingPath,
      recordCount: sequence,
      lastSequence: sequence,
      lastHash: previousHash,
      sizeBytes: after.size,
      fileIdentity: fileIdentity(after),
      fileFingerprint: fileFingerprint(after),
      maxBytes,
    };
  } finally {
    await handle.close();
  }
}

async function readPending(pendingPath: string): Promise<PendingRecord | null> {
  if (!await pathExists(pendingPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readPrivateFileBounded(
      pendingPath,
      "Hub access-audit pending record",
      MAX_RECORD_BYTES * 2,
    ));
  } catch (error) {
    throw new Error(`invalid Hub access-audit pending record: ${error instanceof Error ? error.message : String(error)}`);
  }
  const value = recordValue(parsed, "Hub access-audit pending record");
  assertExactKeys(value, ["format", "record"], "Hub access-audit pending record");
  if (value.format !== PENDING_FORMAT) throw new Error("unsupported Hub access-audit pending format");
  return { format: PENDING_FORMAT, record: value.record as HubAccessAuditRecord };
}

async function lastNewlineOffset(handle: Awaited<ReturnType<typeof open>>, size: number) {
  let cursor = size;
  const chunkSize = 64 * 1024;
  while (cursor > 0) {
    const start = Math.max(0, cursor - chunkSize);
    const buffer = Buffer.alloc(cursor - start);
    const result = await handle.read(buffer, 0, buffer.length, start);
    const index = buffer.subarray(0, result.bytesRead).lastIndexOf(0x0a);
    if (index >= 0) return start + index;
    cursor = start;
  }
  return -1;
}

async function repairPendingPartialTail(filePath: string, pending: PendingRecord | null) {
  if (!pending || !await pathExists(filePath)) return;
  const linkInfo = await assertPrivateRealFile(filePath, "Hub access-audit log");
  const handle = await open(filePath, "r+");
  try {
    const info = await handle.stat();
    if (fileIdentity(linkInfo) !== fileIdentity(info)) throw new Error("Hub access-audit log changed before tail recovery");
    if (info.size === 0) return;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, info.size - 1);
    if (last[0] === 0x0a) return;
    const newline = await lastNewlineOffset(handle, info.size);
    const partialStart = newline + 1;
    const partial = Buffer.alloc(info.size - partialStart);
    await handle.read(partial, 0, partial.length, partialStart);
    const expected = Buffer.from(`${JSON.stringify(pending.record)}\n`, "utf8");
    if (!expected.subarray(0, partial.length).equals(partial)) {
      throw new Error("Hub access-audit truncated tail does not match its pending record");
    }
    await handle.truncate(partialStart);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function appendRecordLine(
  state: AuditState,
  record: HubAccessAuditRecord,
  { pendingAlreadyDurable = false }: { pendingAlreadyDurable?: boolean } = {},
) {
  const line = `${JSON.stringify(record)}\n`;
  const lineBytes = Buffer.byteLength(line, "utf8");
  if (lineBytes > MAX_RECORD_BYTES) throw new Error(`Hub access-audit record exceeds ${MAX_RECORD_BYTES} bytes`);
  if (state.sizeBytes + lineBytes > state.maxBytes) {
    throw Object.assign(new Error(`Hub access-audit log reached its ${state.maxBytes} byte limit`), {
      code: "HUB_ACCESS_AUDIT_FULL",
    });
  }
  const existed = await pathExists(state.filePath);
  const handle = await open(state.filePath, "a+", 0o600);
  try {
    const before = await handle.stat();
    const linkInfo = await assertPrivateRealFile(state.filePath, "Hub access-audit log");
    if (!before.isFile() || (process.platform !== "win32" && (before.mode & 0o077) !== 0)) {
      throw new Error("Hub access-audit log is not a private regular file");
    }
    if (fileIdentity(linkInfo) !== fileIdentity(before)) throw new Error("Hub access-audit log changed before append opened it");
    if (
      before.size !== state.sizeBytes
      || (state.fileIdentity && fileIdentity(before) !== state.fileIdentity)
      || (state.fileFingerprint && fileFingerprint(before) !== state.fileFingerprint)
    ) {
      throw new Error("Hub access-audit log changed outside the active writer");
    }
    if (!pendingAlreadyDurable) {
      const pending: PendingRecord = { format: PENDING_FORMAT, record };
      if (await pathExists(state.pendingPath)) throw new Error("Hub access-audit pending record already exists");
      await writeJsonDurableAtomic(state.pendingPath, pending);
    }
    const written = await handle.write(line, null, "utf8");
    if (written.bytesWritten !== lineBytes) throw new Error("Hub access-audit append was incomplete");
    await handle.sync();
    const after = await handle.stat();
    if (after.size !== before.size + lineBytes) throw new Error("Hub access-audit size did not advance atomically");
    state.sizeBytes = after.size;
    state.fileIdentity = fileIdentity(after);
    state.fileFingerprint = fileFingerprint(after);
    state.lastSequence = record.sequence;
    state.recordCount = record.sequence;
    state.lastHash = record.hash;
    if (!existed) await fsyncDirectory(path.dirname(state.filePath));
    await removeDurable(state.pendingPath);
  } finally {
    await handle.close();
  }
}

async function recoverPending(state: AuditState, pending: PendingRecord | null) {
  if (!pending) return state;
  if (pending.record.sequence === state.lastSequence && pending.record.hash === state.lastHash) {
    await removeDurable(state.pendingPath);
    return state;
  }
  const record = validateAuditRecord(pending.record, state.lastSequence + 1, state.lastHash);
  await appendRecordLine(state, record, { pendingAlreadyDurable: true });
  return state;
}

function createRecord(input: HubAccessAuditInput, state: Pick<AuditState, "lastSequence" | "lastHash">): HubAccessAuditRecord {
  const rawPath = String(input.path || "/").split(/[?#]/, 1)[0] || "/";
  let requestPath = rawPath;
  let pathTruncated = false;
  while (Buffer.byteLength(requestPath, "utf8") > MAX_AUDIT_PATH_BYTES) {
    requestPath = requestPath.slice(0, -1);
    pathTruncated = true;
  }
  const payload: Omit<HubAccessAuditRecord, "hash"> = {
    format: AUDIT_FORMAT,
    sequence: state.lastSequence + 1,
    timestamp: new Date().toISOString(),
    requestId: input.requestId || randomUUID(),
    method: String(input.method || "UNKNOWN").toUpperCase(),
    path: requestPath.startsWith("/") ? requestPath : `/${requestPath}`,
    pathTruncated,
    statusCode: input.statusCode,
    outcome: input.outcome,
    principalId: input.principalId || null,
    principalSource: input.principalSource || null,
    remoteAddress: input.remoteAddress || null,
    requiredScope: input.requiredScope || null,
    errorCode: input.errorCode || null,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    previousHash: state.lastHash,
  };
  return { ...payload, hash: hashRecordPayload(payload) };
}

async function captureRedisAudit(backend: HubRedisStateBackend, maxBytes: number) {
  const head = await backend.readAccessAuditHead();
  const serializedRecords = await backend.readAccessAuditRecords(head.sequence);
  let lastHash = GENESIS_HASH;
  let sizeBytes = 0;
  for (let index = 0; index < serializedRecords.length; index += 1) {
    const serialized = serializedRecords[index];
    if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
      throw new Error(`Redis Hub access-audit record ${index + 1} exceeds ${MAX_RECORD_BYTES} bytes`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new Error(`Redis Hub access-audit record ${index + 1} is not valid JSON`);
    }
    const record = validateAuditRecord(parsed, index + 1, lastHash);
    lastHash = record.hash;
    sizeBytes += Buffer.byteLength(serialized, "utf8") + 1;
  }
  if (head.sequence !== serializedRecords.length || head.hash !== lastHash || head.sizeBytes !== sizeBytes) {
    throw Object.assign(new Error("Redis Hub access-audit head does not match its Stream"), { code: "HUB_ACCESS_AUDIT_INVALID" });
  }
  if (head.maxBytes !== null && head.maxBytes !== maxBytes) {
    throw Object.assign(new Error("Redis Hub access-audit capacity policy differs from this Hub"), {
      code: "HUB_ACCESS_AUDIT_POLICY_MISMATCH",
    });
  }
  return { verified: {
    filePath: `redis:${backend.identityFingerprint}`,
    pendingPath: null,
    recordCount: head.sequence,
    lastSequence: head.sequence,
    lastHash: head.hash,
    sizeBytes: head.sizeBytes,
    maxBytes,
    backend: "redis-stream" as const,
  }, serializedRecords };
}

async function verifyRedisAudit(backend: HubRedisStateBackend, maxBytes: number) {
  return (await captureRedisAudit(backend, maxBytes)).verified;
}

async function openRedisHubAccessAudit(backend: HubRedisStateBackend, maxBytes: number) {
  const verified = await verifyRedisAudit(backend, maxBytes);
  let head: RedisAccessAuditHead = {
    sequence: verified.lastSequence,
    hash: verified.lastHash,
    sizeBytes: verified.sizeBytes,
    maxBytes: verified.recordCount > 0 ? maxBytes : null,
  };
  let queue = Promise.resolve();
  let fatal: unknown = null;
  let closed = false;
  return {
    filePath: verified.filePath,
    append(input: HubAccessAuditInput) {
      const operation = queue.then(async () => {
        if (closed) throw new Error("Hub access-audit writer is closed");
        if (fatal) throw fatal;
        try {
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const record = createRecord(input, { lastSequence: head.sequence, lastHash: head.hash });
            validateAuditRecord(record, head.sequence + 1, head.hash);
            const serialized = JSON.stringify(record);
            if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
              throw new Error(`Hub access-audit record exceeds ${MAX_RECORD_BYTES} bytes`);
            }
            const result = await backend.appendAccessAudit(
              head.sequence, head.hash, record.hash, serialized, maxBytes,
            );
            head = {
              sequence: result.sequence,
              hash: result.hash,
              sizeBytes: result.sizeBytes,
              maxBytes: result.maxBytes,
            };
            if (result.committed) return record;
          }
          throw Object.assign(new Error("Redis Hub access-audit CAS retry limit exceeded"), { code: "HUB_ACCESS_AUDIT_CONFLICT" });
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
          if (code !== "HUB_ACCESS_AUDIT_CONFLICT" && code !== "HUB_STATE_BACKEND_UNAVAILABLE") fatal = error;
          throw error;
        }
      });
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    },
    status() {
      return {
        filePath: verified.filePath,
        recordCount: head.sequence,
        lastSequence: head.sequence,
        lastHash: head.hash,
        sizeBytes: head.sizeBytes,
        maxBytes,
        healthy: fatal === null,
        backend: "redis-stream" as const,
      };
    },
    async close() {
      closed = true;
      await queue;
    },
  };
}

async function assertRedisAuditCutoverSafe(hubRoot: string) {
  const paths = auditPaths(hubRoot);
  if (await pathExists(paths.directory)) {
    const directory = await lstat(paths.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw Object.assign(new Error("local Hub access-audit directory is unsafe"), { code: "HUB_ACCESS_AUDIT_MIGRATION_REQUIRED" });
    }
  }
  if (await pathExists(paths.pendingPath) || await pathExists(paths.archiveJournalPath)) {
    throw Object.assign(
      new Error("local Hub access-audit recovery must complete before Redis audit cutover"),
      { code: "HUB_ACCESS_AUDIT_MIGRATION_REQUIRED" },
    );
  }
  if (await pathExists(paths.filePath)) {
    const info = await assertPrivateRealFile(paths.filePath, "Hub access-audit log");
    if (info.size > 0) {
      throw Object.assign(
        new Error("non-empty local Hub access-audit log must be archived before Redis audit cutover"),
        { code: "HUB_ACCESS_AUDIT_MIGRATION_REQUIRED" },
      );
    }
  }
}

export async function verifyHubAccessAudit(options: AuditOptions) {
  const paths = auditPaths(options.hubRoot);
  if (await pathExists(paths.archiveJournalPath)) {
    throw Object.assign(
      new Error(`Hub access-audit archive recovery is required: ${paths.archiveJournalPath}`),
      { code: "HUB_ACCESS_AUDIT_ARCHIVE_RECOVERY_REQUIRED" },
    );
  }
  if (await pathExists(paths.pendingPath)) {
    throw new Error(`Hub access-audit pending recovery is required: ${paths.pendingPath}`);
  }
  return verifyAuditFile(paths.filePath, paths.pendingPath, normalizeMaxBytes(options.maxBytes));
}

export async function verifyRedisHubAccessAudit(
  redisBackend: HubRedisStateBackend,
  { maxBytes }: { maxBytes?: number | string } = {},
) {
  return verifyRedisAudit(redisBackend, normalizeMaxBytes(maxBytes));
}

export async function captureRedisHubAccessAudit(
  redisBackend: HubRedisStateBackend,
  { maxBytes }: { maxBytes?: number | string } = {},
) {
  return captureRedisAudit(redisBackend, normalizeMaxBytes(maxBytes));
}

export async function verifyHubAccessAuditFile(
  filePath: string,
  { maxBytes }: { maxBytes?: number | string } = {},
) {
  const resolved = path.resolve(filePath);
  return verifyAuditFile(resolved, "", normalizeMaxBytes(maxBytes));
}

export async function inspectHubAccessAuditUsage(options: AuditOptions) {
  if (options.redisBackend) {
    const verified = await verifyRedisAudit(options.redisBackend, normalizeMaxBytes(options.maxBytes));
    return {
      ...verified,
      pending: false,
      archivePending: false,
      usagePercent: Math.min(100, (verified.sizeBytes / verified.maxBytes) * 100),
      remainingBytes: Math.max(0, verified.maxBytes - verified.sizeBytes),
    };
  }
  const paths = auditPaths(options.hubRoot);
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const pending = await pathExists(paths.pendingPath);
  const archivePending = await pathExists(paths.archiveJournalPath);
  let sizeBytes = 0;
  if (await pathExists(paths.filePath)) {
    sizeBytes = (await assertPrivateRealFile(paths.filePath, "Hub access-audit log")).size;
  }
  return {
    filePath: paths.filePath,
    pendingPath: paths.pendingPath,
    pending,
    archiveJournalPath: paths.archiveJournalPath,
    archivePending,
    sizeBytes,
    maxBytes,
    usagePercent: maxBytes === 0 ? 100 : Math.min(100, (sizeBytes / maxBytes) * 100),
    remainingBytes: Math.max(0, maxBytes - sizeBytes),
  };
}

export async function openHubAccessAudit(options: AuditOptions) {
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  if (options.redisBackend) {
    await assertRedisAuditCutoverSafe(options.hubRoot);
    return openRedisHubAccessAudit(options.redisBackend, maxBytes);
  }
  const paths = auditPaths(options.hubRoot);
  if (!await pathExists(paths.directory)) await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(paths.directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error(`Hub access-audit directory must be a real directory: ${paths.directory}`);
  }
  await chmod(paths.directory, 0o700);
  if (await pathExists(paths.archiveJournalPath)) {
    const { recoverHubAccessAuditArchive } = await import("./hub-access-audit-archive.js");
    await recoverHubAccessAuditArchive({
      hubRoot: options.hubRoot,
      signingKey: process.env.CPB_HUB_ACCESS_AUDIT_ARCHIVE_SIGNING_KEY,
    });
  }
  const pending = await readPending(paths.pendingPath);
  await repairPendingPartialTail(paths.filePath, pending);
  const state = await verifyAuditFile(paths.filePath, paths.pendingPath, maxBytes);
  await recoverPending(state, pending);

  let queue = Promise.resolve();
  let fatal: unknown = null;
  let closed = false;
  return {
    filePath: paths.filePath,
    append(input: HubAccessAuditInput) {
      const operation = queue.then(async () => {
        if (closed) throw new Error("Hub access-audit writer is closed");
        if (fatal) throw fatal;
        const record = createRecord(input, state);
        validateAuditRecord(record, state.lastSequence + 1, state.lastHash);
        try {
          await appendRecordLine(state, record);
          return record;
        } catch (error) {
          fatal = error;
          throw error;
        }
      });
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    },
    status() {
      return {
        filePath: state.filePath,
        recordCount: state.recordCount,
        lastSequence: state.lastSequence,
        lastHash: state.lastHash,
        sizeBytes: state.sizeBytes,
        maxBytes: state.maxBytes,
        healthy: fatal === null,
      };
    },
    async close() {
      closed = true;
      await queue;
    },
  };
}
