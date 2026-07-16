import { createHash, createHmac, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

import type { HubRedisStateBackend } from "../../../shared/hub-state-redis.js";
import { fsyncDirectory, writeJsonDurableAtomic } from "../../../shared/hub-maintenance.js";
import { captureRedisHubAccessAudit, verifyHubAccessAuditFile } from "./hub-access-audit.js";

const EXPORT_FORMAT = "cpb-hub-redis-access-audit-export/v1";
const MANIFEST_FILE = "manifest.json";
const LOG_FILE = "http-access.jsonl";

type ExportSignature = { algorithm: "hmac-sha256"; value: string } | null;

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

async function exists(target: string) {
  try { await lstat(target); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function privateFile(target: string, label: string) {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", `${label} must be a real file`);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", `${label} must be private`);
  }
  return info;
}

export async function exportRedisHubAccessAudit(options: {
  backend: HubRedisStateBackend;
  hubRoot: string;
  output: string;
  maxBytes?: number | string;
  signingKey?: string;
}) {
  const output = path.resolve(options.output);
  const hubRoot = path.resolve(options.hubRoot);
  const relative = path.relative(hubRoot, output);
  if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "audit export must be outside the Hub root");
  }
  if (await exists(output)) throw exportError("HUB_ACCESS_AUDIT_EXPORT_EXISTS", "audit export output already exists");
  const parent = path.dirname(output);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "audit export parent must be a real directory");
  }
  const canonicalParent = await realpath(parent);
  const stage = path.join(canonicalParent, `.${path.basename(output)}.stage-${randomUUID()}`);
  const key = signingKey(options.signingKey);
  await mkdir(stage, { mode: 0o700 });
  try {
    const capture = await captureRedisHubAccessAudit(options.backend, { maxBytes: options.maxBytes });
    const log = capture.serializedRecords.length > 0 ? `${capture.serializedRecords.join("\n")}\n` : "";
    if (Buffer.byteLength(log, "utf8") !== capture.verified.sizeBytes) {
      throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "captured audit byte count is inconsistent");
    }
    const logPath = path.join(stage, LOG_FILE);
    const handle = await open(logPath, "wx", 0o600);
    try {
      await handle.writeFile(log, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
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
    await fsyncDirectory(stage);
    await rename(stage, output);
    await fsyncDirectory(canonicalParent);
    return { output, manifest };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyRedisHubAccessAuditExport(options: {
  input: string;
  signingKey?: string;
  requireSignature?: boolean;
}) {
  const input = path.resolve(options.input);
  const directory = await lstat(input);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "audit export must be a real directory");
  }
  const manifestPath = path.join(input, MANIFEST_FILE);
  const manifestInfo = await privateFile(manifestPath, "audit export manifest");
  if (manifestInfo.size > 64 * 1024) throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "audit export manifest is too large");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as RedisAuditExportManifest;
  if (manifest.format !== EXPORT_FORMAT || manifest.log?.path !== LOG_FILE
    || !Number.isSafeInteger(manifest.recordCount) || manifest.recordCount < 0
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
  const logInfo = await privateFile(logPath, "audit export log");
  if (logInfo.size !== manifest.log.sizeBytes || logInfo.size !== manifest.sizeBytes || logInfo.size > manifest.maxBytes) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "audit export log size mismatch");
  }
  const log = await readFile(logPath, "utf8");
  if (createHash("sha256").update(log, "utf8").digest("hex") !== manifest.log.sha256) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "audit export log digest mismatch");
  }
  const records = log ? log.trimEnd().split("\n") : [];
  if (records.length !== manifest.recordCount) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "audit export record count mismatch");
  }
  const verifiedLog = await verifyHubAccessAuditFile(logPath, { maxBytes: manifest.maxBytes });
  if (verifiedLog.recordCount !== manifest.recordCount || verifiedLog.lastHash !== manifest.lastHash
    || verifiedLog.sizeBytes !== manifest.sizeBytes) {
    throw exportError("HUB_ACCESS_AUDIT_EXPORT_INVALID", "audit export hash chain does not match its manifest");
  }
  return { input, manifest, signatureVerified: Boolean(manifest.signature && key) };
}
