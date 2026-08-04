import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { canonicalJson, canonicalJsonBytes, isSha256Identifier, sha256Identifier, type CanonicalJsonValue } from "../core/contracts/canonical-json.js";
import {
  assertReleaseHash,
  decodeDraftPrPayload,
  decodeLiveReleasePayload,
  decodeProductPayload,
  hashSignedReleaseObject,
  isCanonicalUtcTimestamp,
  signReleaseObject,
  verifyReleaseObject,
  type ExternalEvidenceKind,
  type ReleaseGateCompletion,
  type ReleaseGateReceipt,
  type ReleaseSigningAuthority,
  type ReleaseVerificationTrust,
  type SignedExternalEvidence,
} from "../core/contracts/release-evidence.js";
import { readBoundedRegularFileNoFollow } from "../core/runtime/durable-directory-lock.js";
import {
  buildReleaseSourceFingerprint,
  verifyReleaseSourceFingerprint,
  type ReleaseSourceFingerprint,
} from "./release-source-fingerprint.js";
import { sanitizeReleaseGateBuffer, sanitizeReleaseGateText } from "./release-redactor.js";

export type ReleaseGateSpec = Readonly<{
  id: string;
  command: readonly string[];
  steps: readonly (readonly string[])[];
}>;

export const REQUIRED_RELEASE_GATES: readonly ReleaseGateSpec[] = Object.freeze([
  { id: "build-node-tests", command: ["npm", "run", "build:node", "&&", "npm", "run", "build:tests"], steps: [["npm", "run", "build:node"], ["npm", "run", "build:tests"]] },
  { id: "typecheck", command: ["npm", "run", "typecheck"], steps: [["npm", "run", "typecheck"]] },
  { id: "strict-engine", command: ["npm", "run", "typecheck:strict:engine"], steps: [["npm", "run", "typecheck:strict:engine"]] },
  { id: "strict-runtime-contracts", command: ["npm", "run", "typecheck:strict:runtime-contracts"], steps: [["npm", "run", "typecheck:strict:runtime-contracts"]] },
  { id: "type-debt-engine", command: ["npm", "run", "typecheck:type-debt:engine"], steps: [["npm", "run", "typecheck:type-debt:engine"]] },
  { id: "test-main", command: ["npm", "run", "test:main"], steps: [["npm", "run", "test:main"]] },
  { id: "test-integration", command: ["npm", "run", "test:integration"], steps: [["npm", "run", "test:integration"]] },
  { id: "dependency-audit", command: ["npm", "run", "verify:dependency-audit"], steps: [["npm", "run", "verify:dependency-audit"]] },
  { id: "patch-integrity", command: ["npm", "run", "verify:patch-integrity"], steps: [["npm", "run", "verify:patch-integrity"]] },
  { id: "commit-size", command: ["npm", "run", "verify:commit-size"], steps: [["npm", "run", "verify:commit-size"]] },
  { id: "v2-release-scan", command: ["npm", "run", "verify:v2-release-scan"], steps: [["npm", "run", "verify:v2-release-scan"]] },
  { id: "enterprise-gate", command: ["npm", "run", "verify:enterprise-gate"], steps: [["npm", "run", "verify:enterprise-gate"]] },
  { id: "docs-contract", command: ["npm", "run", "verify:docs-contract"], steps: [["npm", "run", "verify:docs-contract"]] },
  { id: "product-gate", command: ["npm", "run", "verify:product-gate"], steps: [["npm", "run", "verify:product-gate"]] },
  { id: "live-release-evidence", command: ["npm", "run", "verify:live-release-evidence"], steps: [["npm", "run", "verify:live-release-evidence"]] },
  { id: "release-contracts", command: ["npm", "run", "verify:release-contracts"], steps: [["npm", "run", "verify:release-contracts"]] },
]);

export const REQUIRED_EXTERNAL_EVIDENCE = Object.freeze({
  live_release: "live-release.json",
  draft_pr: "draft-pr.json",
  product: "product.json",
} as const);

export type ReleaseGateSession = Readonly<{
  sourceRoot: string;
  runtimeRoot: string;
  sessionId: string;
  source: ReleaseSourceFingerprint;
  fingerprintRoot: string;
  sessionRoot: string;
}>;

export type WrittenReceipt = Readonly<{
  receipt: ReleaseGateReceipt;
  receiptSha256: string;
  receiptPath: string;
}>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_JSON_BYTES = 128 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

function receiptError(message: string, code = "RELEASE_GATE_RECEIPT_INVALID", details: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, ...details });
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "RELEASE_GATE_RECEIPT_INVALID";
}

function requireSafeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw receiptError(`${label} is invalid`, "RELEASE_GATE_RECEIPT_INVALID", { field: label });
  }
  return value;
}

function fingerprintDirectoryName(fingerprint: string): string {
  assertReleaseHash(fingerprint, "releaseSourceFingerprint");
  return `sha256-${fingerprint.slice("sha256:".length)}`;
}

function ensureInside(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolvedCandidate;
  throw receiptError(`release evidence path escapes its root: ${candidate}`, "RELEASE_GATE_RECEIPT_INVALID");
}

async function ensureSafeDirectory(baseRoot: string, directory: string): Promise<void> {
  const resolvedBase = path.resolve(baseRoot);
  const resolvedDirectory = ensureInside(resolvedBase, directory);
  await mkdir(resolvedBase, { recursive: true, mode: 0o700 });
  let baseStat = await lstat(resolvedBase, { bigint: true });
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) {
    throw receiptError(`release evidence root is unsafe: ${resolvedBase}`);
  }
  const relative = path.relative(resolvedBase, resolvedDirectory);
  let cursor = resolvedBase;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      await mkdir(cursor, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    baseStat = await lstat(cursor, { bigint: true });
    if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) {
      throw receiptError(`release evidence directory is unsafe: ${cursor}`);
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeImmutableFile(baseRoot: string, filePath: string, bytes: Buffer): Promise<void> {
  const resolvedPath = ensureInside(baseRoot, filePath);
  const parent = path.dirname(resolvedPath);
  await ensureSafeDirectory(baseRoot, parent);
  const noFollow = constants.O_NOFOLLOW;
  if (!Number.isSafeInteger(noFollow) || noFollow === 0) {
    throw receiptError("O_NOFOLLOW is unavailable for release evidence writes");
  }
  const temporaryPath = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  let linked = false;
  try {
    handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, resolvedPath);
    linked = true;
    await unlink(temporaryPath);
    await syncDirectory(parent);
  } catch (cause) {
    if (handle) await handle.close().catch(() => undefined);
    if (!linked) await unlink(temporaryPath).catch(() => undefined);
    throw Object.assign(receiptError(
      linked
        ? `release evidence write committed with ambiguous durability: ${resolvedPath}`
        : `release evidence file already exists or could not be written: ${resolvedPath}`,
      "RELEASE_GATE_RECEIPT_INVALID",
      { path: resolvedPath, committed: linked },
    ), { cause });
  }
}

async function writeImmutableJson(baseRoot: string, filePath: string, value: unknown): Promise<void> {
  await writeImmutableFile(baseRoot, filePath, Buffer.from(`${canonicalJson(value)}\n`, "utf8"));
}

async function readJsonNoFollow(filePath: string): Promise<unknown> {
  const raw = await readBoundedRegularFileNoFollow(filePath, { maxBytes: MAX_JSON_BYTES });
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw Object.assign(receiptError(`release evidence JSON is invalid: ${filePath}`), { cause });
  }
}

type FileGeneration = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

function fileGeneration(stat: BigIntStats): FileGeneration {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

function sameFileGeneration(left: FileGeneration, right: FileGeneration): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function hashRawFileNoFollow(filePath: string): Promise<Readonly<{ bytes: number; sha256: string }>> {
  const beforeStat = await lstat(filePath, { bigint: true });
  if (!beforeStat.isFile() || beforeStat.isSymbolicLink() || beforeStat.size > BigInt(MAX_ARTIFACT_BYTES)) {
    throw receiptError(`release artifact is unsafe or too large: ${filePath}`);
  }
  const before = fileGeneration(beforeStat);
  const noFollow = constants.O_NOFOLLOW;
  if (!Number.isSafeInteger(noFollow) || noFollow === 0) throw receiptError("O_NOFOLLOW is unavailable for release evidence reads");
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileGeneration(before, fileGeneration(opened))) {
      throw receiptError(`release artifact changed before read: ${filePath}`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = fileGeneration(await handle.stat({ bigint: true }));
    if (!sameFileGeneration(before, after) || BigInt(offset) !== before.size) {
      throw receiptError(`release artifact changed during read: ${filePath}`);
    }
    return { bytes: offset, sha256: `sha256:${hash.digest("hex")}` };
  } finally {
    await handle.close();
  }
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw receiptError(`${label} fields are invalid`, "RELEASE_GATE_RECEIPT_INVALID", { actual, expected: wanted });
  }
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw receiptError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw receiptError(`${label} must be a non-empty string array`);
  }
  return value as string[];
}

function requireTimestamp(value: unknown, label: string): string {
  if (!isCanonicalUtcTimestamp(value)) throw receiptError(`${label} must be a canonical UTC timestamp`);
  return value;
}

const RECEIPT_KEYS = [
  "schemaVersion", "sessionId", "sequence", "previousReceiptSha256", "gateId",
  "releaseSourceFingerprint", "indexSnapshotIdAtSessionStart", "command", "cwd",
  "startedAt", "finishedAt", "exitCode", "ok", "stdoutBytes", "stderrBytes",
  "stdoutArtifactPath", "stderrArtifactPath", "stdoutSha256", "stderrSha256",
  "stdoutRedactedSha256", "stderrRedactedSha256",
  "evidence", "signerKeyId", "signatureAlgorithm", "signature",
] as const;

function decodeReceipt(value: unknown, trust: ReleaseVerificationTrust): ReleaseGateReceipt {
  const record = recordValue(value, "release gate receipt");
  exactKeys(record, RECEIPT_KEYS, "release gate receipt");
  verifyReleaseObject(trust, record);
  if (record.schemaVersion !== 2) throw receiptError("release gate receipt schemaVersion must be 2");
  requireSafeId(record.sessionId, "sessionId");
  requireSafeId(record.gateId, "gateId");
  if (!Number.isSafeInteger(record.sequence) || Number(record.sequence) <= 0) throw receiptError("receipt sequence must be a positive integer");
  if (record.previousReceiptSha256 !== null) assertReleaseHash(record.previousReceiptSha256, "previousReceiptSha256");
  assertReleaseHash(record.releaseSourceFingerprint, "releaseSourceFingerprint");
  if (typeof record.indexSnapshotIdAtSessionStart !== "string" || record.indexSnapshotIdAtSessionStart.length === 0) throw receiptError("receipt index snapshot id is missing");
  stringArray(record.command, "command");
  if (typeof record.cwd !== "string" || !path.isAbsolute(record.cwd)) throw receiptError("receipt cwd must be absolute");
  const startedAt = requireTimestamp(record.startedAt, "startedAt");
  const finishedAt = requireTimestamp(record.finishedAt, "finishedAt");
  if (Date.parse(finishedAt) < Date.parse(startedAt)) throw receiptError("receipt finishedAt precedes startedAt");
  if (!Number.isSafeInteger(record.exitCode)) throw receiptError("receipt exitCode must be an integer");
  if (typeof record.ok !== "boolean") throw receiptError("receipt ok must be boolean");
  for (const field of ["stdoutBytes", "stderrBytes"] as const) {
    if (!Number.isSafeInteger(record[field]) || Number(record[field]) < 0) throw receiptError(`${field} must be a non-negative integer`);
  }
  for (const field of ["stdoutArtifactPath", "stderrArtifactPath"] as const) {
    if (typeof record[field] !== "string" || record[field].length === 0 || path.isAbsolute(record[field]) || record[field].split(/[\\/]/).includes("..")) {
      throw receiptError(`${field} must be a safe relative path`);
    }
  }
  assertReleaseHash(record.stdoutSha256, "stdoutSha256");
  assertReleaseHash(record.stderrSha256, "stderrSha256");
  assertReleaseHash(record.stdoutRedactedSha256, "stdoutRedactedSha256");
  assertReleaseHash(record.stderrRedactedSha256, "stderrRedactedSha256");
  canonicalJsonBytes(record.evidence);
  return record as unknown as ReleaseGateReceipt;
}

const COMPLETION_KEYS = [
  "schemaVersion", "sessionId", "releaseSourceFingerprint", "indexSnapshotIdAtFinalCheck",
  "requiredGateIds", "orderedReceiptSha256", "externalEvidenceSha256", "completedAt",
  "signerKeyId", "signatureAlgorithm", "signature",
] as const;

function decodeCompletion(value: unknown, trust: ReleaseVerificationTrust): ReleaseGateCompletion {
  const record = recordValue(value, "release gate completion");
  exactKeys(record, COMPLETION_KEYS, "release gate completion");
  verifyReleaseObject(trust, record);
  if (record.schemaVersion !== 1) throw receiptError("release completion schemaVersion must be 1");
  requireSafeId(record.sessionId, "sessionId");
  assertReleaseHash(record.releaseSourceFingerprint, "releaseSourceFingerprint");
  if (typeof record.indexSnapshotIdAtFinalCheck !== "string" || record.indexSnapshotIdAtFinalCheck.length === 0) throw receiptError("completion index snapshot id is missing");
  stringArray(record.requiredGateIds, "requiredGateIds");
  const hashes = stringArray(record.orderedReceiptSha256, "orderedReceiptSha256");
  for (const hash of hashes) assertReleaseHash(hash, "orderedReceiptSha256");
  const external = recordValue(record.externalEvidenceSha256, "externalEvidenceSha256");
  exactKeys(external, Object.keys(REQUIRED_EXTERNAL_EVIDENCE), "externalEvidenceSha256");
  for (const [kind, hash] of Object.entries(external)) assertReleaseHash(hash, `externalEvidenceSha256.${kind}`);
  requireTimestamp(record.completedAt, "completedAt");
  return record as unknown as ReleaseGateCompletion;
}

const EXTERNAL_KEYS = [
  "schemaVersion", "kind", "releaseSourceFingerprint", "generatedAt", "expiresAt", "payload",
  "payloadSha256", "signerKeyId", "signatureAlgorithm", "signature",
] as const;

function decodeExternalEvidence(value: unknown, trust: ReleaseVerificationTrust, referenceTime: Date): SignedExternalEvidence {
  const record = recordValue(value, "signed external evidence");
  exactKeys(record, EXTERNAL_KEYS, "signed external evidence");
  verifyReleaseObject(trust, record);
  if (record.schemaVersion !== 1) {
    throw receiptError("external evidence schemaVersion must be 1", "RELEASE_GATE_RECEIPT_INVALID", { field: "schemaVersion" });
  }
  if (typeof record.kind !== "string" || !(record.kind in REQUIRED_EXTERNAL_EVIDENCE)) {
    throw receiptError("external evidence kind is not a registered evidence type", "RELEASE_GATE_RECEIPT_INVALID", { field: "kind" });
  }
  assertReleaseHash(record.releaseSourceFingerprint, "releaseSourceFingerprint");
  const generatedAt = requireTimestamp(record.generatedAt, "generatedAt");
  const expiresAt = requireTimestamp(record.expiresAt, "expiresAt");
  const generatedMs = Date.parse(generatedAt);
  const expiresMs = Date.parse(expiresAt);
  const maxValidityMs = 30 * 24 * 60 * 60 * 1000;
  if (
    generatedMs >= expiresMs
    || expiresMs - generatedMs > maxValidityMs
    || referenceTime.getTime() < generatedMs
    || referenceTime.getTime() >= expiresMs
  ) {
    throw receiptError("external evidence is expired or has an invalid validity window");
  }
  canonicalJsonBytes(record.payload);
  assertReleaseHash(record.payloadSha256, "payloadSha256");
  if (record.payloadSha256 !== sha256Identifier(canonicalJsonBytes(record.payload))) throw receiptError("external evidence payload hash does not match payload");
  // Dispatch to the strongly-typed payload decoder for this evidence kind.
  switch (record.kind as ExternalEvidenceKind) {
    case "live_release":
      decodeLiveReleasePayload(record.payload);
      break;
    case "draft_pr":
      decodeDraftPrPayload(record.payload);
      break;
    case "product":
      decodeProductPayload(record.payload);
      break;
    default:
      throw receiptError(`external evidence kind ${record.kind} has no payload decoder`, "RELEASE_GATE_RECEIPT_INVALID", { field: "kind" });
  }
  return record as unknown as SignedExternalEvidence;
}

function releasePaths(runtimeRoot: string, fingerprint: string, sessionId?: string) {
  const evidenceRoot = path.join(path.resolve(runtimeRoot), "release-evidence");
  const fingerprintRoot = path.join(evidenceRoot, fingerprintDirectoryName(fingerprint));
  return {
    evidenceRoot,
    fingerprintRoot,
    externalRoot: path.join(fingerprintRoot, "external"),
    sessionRoot: sessionId ? path.join(fingerprintRoot, requireSafeId(sessionId, "sessionId")) : null,
  };
}

export async function initializeReleaseGateSession(input: Readonly<{
  sourceRoot: string;
  runtimeRoot: string;
  sessionId: string;
}>): Promise<ReleaseGateSession> {
  const sourceRoot = path.resolve(input.sourceRoot);
  const runtimeRoot = path.resolve(input.runtimeRoot);
  const sessionId = requireSafeId(input.sessionId, "sessionId");
  const source = await buildReleaseSourceFingerprint({ root: sourceRoot });
  const paths = releasePaths(runtimeRoot, source.releaseSourceFingerprint, sessionId);
  if (!paths.sessionRoot) throw receiptError("session root was not resolved");
  await ensureSafeDirectory(runtimeRoot, path.join(paths.sessionRoot, "gates"));
  await ensureSafeDirectory(runtimeRoot, path.join(paths.sessionRoot, "artifacts"));
  await writeImmutableJson(runtimeRoot, path.join(paths.sessionRoot, "source-manifest.json"), {
    ...source.manifest,
    releaseSourceFingerprint: source.releaseSourceFingerprint,
  });
  return {
    sourceRoot,
    runtimeRoot,
    sessionId,
    source,
    fingerprintRoot: paths.fingerprintRoot,
    sessionRoot: paths.sessionRoot,
  };
}

export async function writeSignedReleaseGateReceipt(input: Readonly<{
  session: ReleaseGateSession;
  authority: ReleaseSigningAuthority;
  gate: ReleaseGateSpec;
  sequence: number;
  previousReceiptSha256: string | null;
  indexSnapshotIdAtSessionStart: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  evidence?: CanonicalJsonValue;
}>): Promise<WrittenReceipt> {
  requireSafeId(input.gate.id, "gateId");
  if (!Number.isSafeInteger(input.sequence) || input.sequence <= 0) throw receiptError("receipt sequence must be positive");
  if (input.previousReceiptSha256 !== null) assertReleaseHash(input.previousReceiptSha256, "previousReceiptSha256");
  requireTimestamp(input.startedAt, "startedAt");
  requireTimestamp(input.finishedAt, "finishedAt");
  const basename = `${String(input.sequence).padStart(4, "0")}-${input.gate.id}`;
  const stdoutArtifactPath = `artifacts/${basename}.stdout`;
  const stderrArtifactPath = `artifacts/${basename}.stderr`;
  // Sanitize stdout/stderr before writing to disk so absolute paths, tokens,
  // and secrets never land in the release artifact store.  The raw sha256 is
  // computed in-memory (pre-redaction) and signed into the receipt; only the
  // redacted bytes touch disk.
  const redactorCtx = { sourceRoot: input.session.sourceRoot, runtimeRoot: input.session.runtimeRoot };
  const stdoutRedacted = sanitizeReleaseGateBuffer(input.stdout, redactorCtx);
  const stderrRedacted = sanitizeReleaseGateBuffer(input.stderr, redactorCtx);
  await writeImmutableFile(input.session.runtimeRoot, path.join(input.session.sessionRoot, stdoutArtifactPath), stdoutRedacted);
  await writeImmutableFile(input.session.runtimeRoot, path.join(input.session.sessionRoot, stderrArtifactPath), stderrRedacted);

  const unsigned = {
    schemaVersion: 2 as const,
    sessionId: input.session.sessionId,
    sequence: input.sequence,
    previousReceiptSha256: input.previousReceiptSha256,
    gateId: input.gate.id,
    releaseSourceFingerprint: input.session.source.releaseSourceFingerprint,
    indexSnapshotIdAtSessionStart: input.indexSnapshotIdAtSessionStart,
    command: [...input.gate.command],
    cwd: input.session.sourceRoot,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    exitCode: input.exitCode,
    ok: input.exitCode === 0,
    stdoutBytes: input.stdout.byteLength,
    stderrBytes: input.stderr.byteLength,
    stdoutArtifactPath,
    stderrArtifactPath,
    stdoutSha256: sha256Identifier(input.stdout),
    stderrSha256: sha256Identifier(input.stderr),
    stdoutRedactedSha256: sha256Identifier(stdoutRedacted),
    stderrRedactedSha256: sha256Identifier(stderrRedacted),
    evidence: input.evidence ?? null,
  };
  const receipt = signReleaseObject(input.authority, unsigned) as ReleaseGateReceipt;
  const receiptPath = path.join(input.session.sessionRoot, "gates", `${basename}.json`);
  await writeImmutableJson(input.session.runtimeRoot, receiptPath, receipt);
  return { receipt, receiptSha256: hashSignedReleaseObject(receipt), receiptPath };
}

export async function writeSignedExternalEvidence(input: Readonly<{
  runtimeRoot: string;
  releaseSourceFingerprint: string;
  authority: ReleaseSigningAuthority;
  kind: ExternalEvidenceKind;
  generatedAt: string;
  expiresAt: string;
  payload: CanonicalJsonValue;
}>): Promise<Readonly<{ evidence: SignedExternalEvidence; evidenceSha256: string; evidencePath: string }>> {
  requireTimestamp(input.generatedAt, "generatedAt");
  requireTimestamp(input.expiresAt, "expiresAt");
  if (Date.parse(input.generatedAt) >= Date.parse(input.expiresAt)) throw receiptError("external evidence validity window is invalid");
  const paths = releasePaths(input.runtimeRoot, input.releaseSourceFingerprint);
  const unsigned = {
    schemaVersion: 1 as const,
    kind: input.kind,
    releaseSourceFingerprint: input.releaseSourceFingerprint,
    generatedAt: input.generatedAt,
    expiresAt: input.expiresAt,
    payload: input.payload,
    payloadSha256: sha256Identifier(canonicalJsonBytes(input.payload)),
  };
  const evidence = signReleaseObject(input.authority, unsigned) as SignedExternalEvidence;
  const evidencePath = path.join(paths.externalRoot, REQUIRED_EXTERNAL_EVIDENCE[input.kind]);
  await writeImmutableJson(input.runtimeRoot, evidencePath, evidence);
  return { evidence, evidenceSha256: hashSignedReleaseObject(evidence), evidencePath };
}

export async function writeSignedReleaseGateCompletion(input: Readonly<{
  session: ReleaseGateSession;
  authority: ReleaseSigningAuthority;
  indexSnapshotIdAtFinalCheck: string;
  receiptHashes: readonly string[];
  externalEvidenceSha256: Readonly<Record<ExternalEvidenceKind, string>>;
  completedAt: string;
}>): Promise<ReleaseGateCompletion> {
  await verifyReleaseSourceFingerprint(input.session.source, { root: input.session.sourceRoot });
  if (input.receiptHashes.length !== REQUIRED_RELEASE_GATES.length) throw receiptError("completion does not contain all required receipts");
  for (const hash of input.receiptHashes) assertReleaseHash(hash, "orderedReceiptSha256");
  exactKeys(input.externalEvidenceSha256 as Record<string, unknown>, Object.keys(REQUIRED_EXTERNAL_EVIDENCE), "externalEvidenceSha256");
  for (const hash of Object.values(input.externalEvidenceSha256)) assertReleaseHash(hash, "externalEvidenceSha256");
  requireTimestamp(input.completedAt, "completedAt");
  const completion = signReleaseObject(input.authority, {
    schemaVersion: 1 as const,
    sessionId: input.session.sessionId,
    releaseSourceFingerprint: input.session.source.releaseSourceFingerprint,
    indexSnapshotIdAtFinalCheck: input.indexSnapshotIdAtFinalCheck,
    requiredGateIds: REQUIRED_RELEASE_GATES.map((gate) => gate.id),
    orderedReceiptSha256: [...input.receiptHashes],
    externalEvidenceSha256: { ...input.externalEvidenceSha256 },
    completedAt: input.completedAt,
  }) as ReleaseGateCompletion;
  await writeImmutableJson(input.session.runtimeRoot, path.join(input.session.sessionRoot, "completion.json"), completion);
  return completion;
}

async function verifyExternalEvidence(input: Readonly<{
  runtimeRoot: string;
  releaseSourceFingerprint: string;
  trust: ReleaseVerificationTrust;
  referenceTime: Date;
}>): Promise<Record<ExternalEvidenceKind, string>> {
  const paths = releasePaths(input.runtimeRoot, input.releaseSourceFingerprint);
  const hashes = {} as Record<ExternalEvidenceKind, string>;
  for (const [kind, filename] of Object.entries(REQUIRED_EXTERNAL_EVIDENCE) as [ExternalEvidenceKind, string][]) {
    const evidence = decodeExternalEvidence(await readJsonNoFollow(path.join(paths.externalRoot, filename)), input.trust, input.referenceTime);
    if (evidence.kind !== kind || evidence.releaseSourceFingerprint !== input.releaseSourceFingerprint) {
      throw receiptError(`external evidence ${filename} is bound to the wrong kind or source`);
    }
    hashes[kind] = hashSignedReleaseObject(evidence);
  }
  return hashes;
}

export async function verifySignedExternalEvidenceSet(input: Readonly<{
  runtimeRoot: string;
  releaseSourceFingerprint: string;
  trust: ReleaseVerificationTrust;
  referenceTime?: Date;
}>): Promise<Readonly<Record<ExternalEvidenceKind, string>>> {
  return verifyExternalEvidence({
    ...input,
    runtimeRoot: path.resolve(input.runtimeRoot),
    referenceTime: input.referenceTime || new Date(),
  });
}

// ---------------------------------------------------------------------------
// Code index recheck support for release readiness verification.
// ---------------------------------------------------------------------------

export type CodeIndexStatus = Readonly<{
  available: boolean;
  fresh: boolean;
  exact: boolean;
  coverage: string;
  ref: Readonly<{ snapshotId: string }>;
}>;

export type CodeIndexInspector = (sourceRoot: string) => Promise<CodeIndexStatus>;

const execFileAsync = promisify(execFile);

const DEFAULT_CODE_INDEX_INSPECTOR: CodeIndexInspector = async (sourceRoot: string): Promise<CodeIndexStatus> => {
  const launcher = path.join(sourceRoot, "cpb");
  let stdout: string;
  try {
    const result = await execFileAsync(launcher, ["code-index", "status", "-s", sourceRoot, "--json"], {
      cwd: sourceRoot,
      maxBuffer: 4 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    throw receiptError(
      "Local Code Index status could not be inspected for release readiness verification",
      "RELEASE_GATE_INDEX_STALE",
      { reason: error instanceof Error ? error.message : String(error) },
    );
  }
  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw receiptError("Local Code Index status output is not valid JSON", "RELEASE_GATE_INDEX_STALE");
  }
  return {
    available: parsed?.available === true,
    fresh: parsed?.fresh === true,
    exact: parsed?.exact === true,
    coverage: typeof parsed?.coverage === "string" ? parsed.coverage : "file-inventory-only",
    ref: { snapshotId: typeof parsed?.ref?.snapshotId === "string" ? parsed.ref.snapshotId : "" },
  };
};

async function verifySessionOrThrow(input: Readonly<{
  sourceRoot: string;
  runtimeRoot: string;
  trust: ReleaseVerificationTrust;
  releaseSourceFingerprint: string;
  sessionId: string;
  referenceTime: Date;
  inspectCodeIndex?: CodeIndexInspector;
}>): Promise<Readonly<{
  completion: ReleaseGateCompletion;
  receipts: readonly ReleaseGateReceipt[];
  externalEvidenceSha256: Readonly<Record<ExternalEvidenceKind, string>>;
}>> {
  const source = await buildReleaseSourceFingerprint({ root: input.sourceRoot });
  if (source.releaseSourceFingerprint !== input.releaseSourceFingerprint) {
    throw receiptError("release source fingerprint no longer matches the gate session", "RELEASE_SOURCE_CHANGED", {
      expected: input.releaseSourceFingerprint,
      actual: source.releaseSourceFingerprint,
    });
  }
  const paths = releasePaths(input.runtimeRoot, input.releaseSourceFingerprint, input.sessionId);
  if (!paths.sessionRoot) throw receiptError("release session root is missing");
  const manifestFile = recordValue(await readJsonNoFollow(path.join(paths.sessionRoot, "source-manifest.json")), "source manifest");
  const storedFingerprint = manifestFile.releaseSourceFingerprint;
  const { releaseSourceFingerprint: _stored, ...storedManifest } = manifestFile;
  if (
    storedFingerprint !== input.releaseSourceFingerprint
    || sha256Identifier(canonicalJsonBytes(storedManifest)) !== input.releaseSourceFingerprint
    || canonicalJson(storedManifest) !== canonicalJson(source.manifest)
  ) {
    throw receiptError("stored source manifest does not match the release source fingerprint");
  }

  const expectedReceiptFiles = REQUIRED_RELEASE_GATES.map((gate, index) => (
    `${String(index + 1).padStart(4, "0")}-${gate.id}.json`
  ));
  const actualReceiptFiles = (await readdir(path.join(paths.sessionRoot, "gates"))).sort();
  if (canonicalJson(actualReceiptFiles) !== canonicalJson([...expectedReceiptFiles].sort())) {
    throw receiptError("release gate receipt set is incomplete or contains unregistered files", "RELEASE_GATE_RECEIPT_INVALID", {
      expected: expectedReceiptFiles,
      actual: actualReceiptFiles,
    });
  }

  const receipts: ReleaseGateReceipt[] = [];
  const receiptHashes: string[] = [];
  let previousReceiptSha256: string | null = null;
  let indexSnapshotIdAtSessionStart: string | null = null;
  for (let index = 0; index < REQUIRED_RELEASE_GATES.length; index += 1) {
    const gate = REQUIRED_RELEASE_GATES[index];
    const receipt = decodeReceipt(await readJsonNoFollow(path.join(paths.sessionRoot, "gates", expectedReceiptFiles[index])), input.trust);
    if (
      receipt.sessionId !== input.sessionId
      || receipt.sequence !== index + 1
      || receipt.gateId !== gate.id
      || receipt.releaseSourceFingerprint !== input.releaseSourceFingerprint
      || canonicalJson(receipt.command) !== canonicalJson(gate.command)
      || path.resolve(receipt.cwd) !== path.resolve(input.sourceRoot)
      || receipt.previousReceiptSha256 !== previousReceiptSha256
      || !receipt.ok
      || receipt.exitCode !== 0
    ) {
      throw receiptError(`release gate receipt ${gate.id} does not match its required slot`);
    }
    const artifactBase = `${String(index + 1).padStart(4, "0")}-${gate.id}`;
    if (
      receipt.stdoutArtifactPath !== `artifacts/${artifactBase}.stdout`
      || receipt.stderrArtifactPath !== `artifacts/${artifactBase}.stderr`
    ) {
      throw receiptError(`release gate receipt ${gate.id} uses unexpected artifact paths`);
    }
    if (indexSnapshotIdAtSessionStart === null) indexSnapshotIdAtSessionStart = receipt.indexSnapshotIdAtSessionStart;
    if (receipt.indexSnapshotIdAtSessionStart !== indexSnapshotIdAtSessionStart) throw receiptError("release receipts use different initial index snapshots");
    // Artifact files on disk contain the REDACTED bytes.  Verify against the
    // redacted sha256; the raw stdoutSha256/stderrSha256 are trusted from the
    // signed receipt (raw bytes are never persisted to disk).
    const stdout = await hashRawFileNoFollow(ensureInside(paths.sessionRoot, path.join(paths.sessionRoot, receipt.stdoutArtifactPath)));
    const stderr = await hashRawFileNoFollow(ensureInside(paths.sessionRoot, path.join(paths.sessionRoot, receipt.stderrArtifactPath)));
    if (
      stdout.sha256 !== receipt.stdoutRedactedSha256
      || stderr.sha256 !== receipt.stderrRedactedSha256
    ) {
      throw receiptError(`release gate artifacts do not match receipt ${gate.id}`);
    }
    const receiptSha256 = hashSignedReleaseObject(receipt);
    receipts.push(receipt);
    receiptHashes.push(receiptSha256);
    previousReceiptSha256 = receiptSha256;
  }

  const completion = decodeCompletion(await readJsonNoFollow(path.join(paths.sessionRoot, "completion.json")), input.trust);
  const requiredGateIds = REQUIRED_RELEASE_GATES.map((gate) => gate.id);
  if (
    completion.sessionId !== input.sessionId
    || completion.releaseSourceFingerprint !== input.releaseSourceFingerprint
    || canonicalJson(completion.requiredGateIds) !== canonicalJson(requiredGateIds)
    || canonicalJson(completion.orderedReceiptSha256) !== canonicalJson(receiptHashes)
  ) {
    throw receiptError("release completion does not bind the verified receipt chain");
  }
  const lastReceipt = receipts[receipts.length - 1];
  if (lastReceipt && Date.parse(completion.completedAt) < Date.parse(lastReceipt.finishedAt)) {
    throw receiptError("release completion precedes the final gate receipt");
  }
  // Index snapshot recheck: the completion recorded the index snapshot id at
  // the final check.  Independently re-verify that the index is still
  // available, fresh, exact, symbol-level, and bound to the same snapshot id.
  const inspectCodeIndex = input.inspectCodeIndex || DEFAULT_CODE_INDEX_INSPECTOR;
  let indexStatus: CodeIndexStatus;
  try {
    indexStatus = await inspectCodeIndex(input.sourceRoot);
  } catch (error) {
    throw receiptError(
      error instanceof Error ? error.message : "Local Code Index recheck failed",
      "RELEASE_GATE_INDEX_STALE",
    );
  }
  if (
    !indexStatus.available
    || !indexStatus.fresh
    || !indexStatus.exact
    || indexStatus.ref.snapshotId !== completion.indexSnapshotIdAtFinalCheck
  ) {
    throw receiptError(
      "Local Code Index is stale or its snapshot id no longer matches the final check binding",
      "RELEASE_GATE_INDEX_STALE",
      {
        expectedSnapshotId: completion.indexSnapshotIdAtFinalCheck,
        actualSnapshotId: indexStatus.ref.snapshotId,
        available: indexStatus.available,
        fresh: indexStatus.fresh,
        exact: indexStatus.exact,
      },
    );
  }
  if (indexStatus.coverage === "file-inventory-only") {
    throw receiptError(
      "Local Code Index coverage is file-inventory-only; release requires symbol-level coverage",
      "RELEASE_GATE_INDEX_COVERAGE_INSUFFICIENT",
      { coverage: indexStatus.coverage },
    );
  }
  const externalEvidenceSha256 = await verifyExternalEvidence(input);
  if (canonicalJson(completion.externalEvidenceSha256) !== canonicalJson(externalEvidenceSha256)) {
    throw receiptError("release completion does not bind the verified external evidence");
  }
  return { completion, receipts, externalEvidenceSha256 };
}

export async function verifyReleaseReadiness(input: Readonly<{
  sourceRoot: string;
  runtimeRoot: string;
  trust: ReleaseVerificationTrust;
  releaseSourceFingerprint: string;
  sessionId: string;
  referenceTime?: Date;
  inspectCodeIndex?: CodeIndexInspector;
}>): Promise<Readonly<Record<string, CanonicalJsonValue>>> {
  try {
    const verified = await verifySessionOrThrow({
      ...input,
      sourceRoot: path.resolve(input.sourceRoot),
      runtimeRoot: path.resolve(input.runtimeRoot),
      referenceTime: input.referenceTime || new Date(),
      inspectCodeIndex: input.inspectCodeIndex,
    });
    return {
      schemaVersion: 2,
      sessionId: input.sessionId,
      releaseSourceFingerprint: input.releaseSourceFingerprint,
      signerKeyId: input.trust.keyId,
      requiredGateIds: REQUIRED_RELEASE_GATES.map((gate) => gate.id),
      gates: Object.fromEntries(verified.receipts.map((receipt) => [receipt.gateId, { ok: true }])),
      ready: true,
      error: null,
    };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const redactedMessage = sanitizeReleaseGateText(rawMessage, {
      sourceRoot: input.sourceRoot,
      runtimeRoot: input.runtimeRoot,
    });
    return {
      schemaVersion: 2,
      sessionId: input.sessionId,
      releaseSourceFingerprint: input.releaseSourceFingerprint,
      signerKeyId: input.trust.keyId,
      requiredGateIds: REQUIRED_RELEASE_GATES.map((gate) => gate.id),
      gates: {},
      ready: false,
      error: {
        code: errorCode(error),
        message: redactedMessage,
      },
    };
  }
}
