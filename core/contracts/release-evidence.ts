import {
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from "node:crypto";

import {
  canonicalJsonBytes,
  isSha256Identifier,
  sha256Identifier,
  type CanonicalJsonValue,
} from "./canonical-json.js";

export type ExternalEvidenceKind = "live_release" | "draft_pr" | "product";

export type SignedExternalEvidence = Readonly<{
  schemaVersion: 1;
  kind: ExternalEvidenceKind;
  releaseSourceFingerprint: string;
  generatedAt: string;
  expiresAt: string;
  payload: CanonicalJsonValue;
  payloadSha256: string;
  signerKeyId: string;
  signatureAlgorithm: "Ed25519";
  signature: string;
}>;

export type ReleaseGateReceipt = Readonly<{
  schemaVersion: 2;
  sessionId: string;
  sequence: number;
  previousReceiptSha256: string | null;
  gateId: string;
  releaseSourceFingerprint: string;
  indexSnapshotIdAtSessionStart: string;
  command: readonly string[];
  cwd: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  ok: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutArtifactPath: string;
  stderrArtifactPath: string;
  stdoutSha256: string;
  stderrSha256: string;
  stdoutRedactedSha256: string;
  stderrRedactedSha256: string;
  evidence: CanonicalJsonValue;
  signerKeyId: string;
  signatureAlgorithm: "Ed25519";
  signature: string;
}>;

export type ReleaseGateCompletion = Readonly<{
  schemaVersion: 1;
  sessionId: string;
  releaseSourceFingerprint: string;
  indexSnapshotIdAtFinalCheck: string;
  requiredGateIds: readonly string[];
  orderedReceiptSha256: readonly string[];
  externalEvidenceSha256: Readonly<Record<string, string>>;
  completedAt: string;
  signerKeyId: string;
  signatureAlgorithm: "Ed25519";
  signature: string;
}>;

const signingAuthorityBrand: unique symbol = Symbol("ReleaseSigningAuthority");
const verificationTrustBrand: unique symbol = Symbol("ReleaseVerificationTrust");

export type ReleaseSigningAuthority = Readonly<{
  keyId: string;
  signCanonical(value: unknown): string;
  [signingAuthorityBrand]: true;
}>;

export type ReleaseVerificationTrust = Readonly<{
  keyId: string;
  verifyCanonical(value: unknown, signature: string): boolean;
  [verificationTrustBrand]: true;
}>;

export type ReleaseSignatureFields = Readonly<{
  signerKeyId: string;
  signatureAlgorithm: "Ed25519";
  signature: string;
}>;

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function releaseEvidenceError(message: string, code: string, details: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, ...details });
}

function requireKeyId(value: unknown, code: string): string {
  if (typeof value !== "string" || !KEY_ID_PATTERN.test(value)) {
    throw releaseEvidenceError("release signing key id is invalid", code, { key: "signerKeyId" });
  }
  return value;
}

function decodeBase64Url(value: unknown, label: string, code: string): Buffer {
  if (typeof value !== "string" || !BASE64URL_PATTERN.test(value) || value.includes("=")) {
    throw releaseEvidenceError(`${label} must be unpadded base64url`, code, { key: label });
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0 || decoded.toString("base64url") !== value) {
    throw releaseEvidenceError(`${label} has a non-canonical base64url encoding`, code, { key: label });
  }
  return decoded;
}

function decodeEd25519PrivateKey(value: unknown): KeyObject {
  const code = "RELEASE_GATE_SIGNING_AUTHORITY_UNAVAILABLE";
  const der = decodeBase64Url(value, "CPB_RELEASE_GATE_SIGNING_KEY", code);
  if (der.length !== ED25519_PKCS8_PREFIX.length + 32 || !der.subarray(0, ED25519_PKCS8_PREFIX.length).equals(ED25519_PKCS8_PREFIX)) {
    throw releaseEvidenceError("release signing key must be canonical Ed25519 PKCS#8 DER", code);
  }
  try {
    const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    const roundTrip = key.export({ format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ed25519" || !Buffer.from(roundTrip).equals(der)) {
      throw new Error("Ed25519 PKCS#8 key did not round-trip exactly");
    }
    return key;
  } catch (cause) {
    throw Object.assign(releaseEvidenceError("release signing key is not valid canonical Ed25519 PKCS#8 DER", code), { cause });
  }
}

function decodeEd25519PublicKey(value: unknown): KeyObject {
  const code = "RELEASE_GATE_RECEIPT_INVALID";
  const der = decodeBase64Url(value, "CPB_RELEASE_GATE_TRUSTED_PUBLIC_KEY", code);
  if (der.length !== ED25519_SPKI_PREFIX.length + 32 || !der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    throw releaseEvidenceError("release trusted key must be canonical Ed25519 SPKI DER", code);
  }
  try {
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    const roundTrip = key.export({ format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519" || !Buffer.from(roundTrip).equals(der)) {
      throw new Error("Ed25519 SPKI key did not round-trip exactly");
    }
    return key;
  } catch (cause) {
    throw Object.assign(releaseEvidenceError("release trusted key is not valid canonical Ed25519 SPKI DER", code), { cause });
  }
}

function decodeSignature(value: unknown): Buffer {
  const decoded = decodeBase64Url(value, "signature", "RELEASE_GATE_RECEIPT_INVALID");
  if (decoded.length !== 64) {
    throw releaseEvidenceError("Ed25519 signature must contain exactly 64 bytes", "RELEASE_GATE_RECEIPT_INVALID");
  }
  return decoded;
}

export function createReleaseSigningAuthority(input: Readonly<{
  keyId: string;
  privateKeyBase64Url: string;
}>): ReleaseSigningAuthority {
  const keyId = requireKeyId(input.keyId, "RELEASE_GATE_SIGNING_AUTHORITY_UNAVAILABLE");
  const privateKey = decodeEd25519PrivateKey(input.privateKeyBase64Url);
  return Object.freeze({
    keyId,
    signCanonical(value: unknown): string {
      return signBytes(null, canonicalJsonBytes(value), privateKey).toString("base64url");
    },
    [signingAuthorityBrand]: true as const,
  });
}

export function createReleaseVerificationTrust(input: Readonly<{
  keyId: string;
  publicKeyBase64Url: string;
}>): ReleaseVerificationTrust {
  const keyId = requireKeyId(input.keyId, "RELEASE_GATE_RECEIPT_INVALID");
  const publicKey = decodeEd25519PublicKey(input.publicKeyBase64Url);
  return Object.freeze({
    keyId,
    verifyCanonical(value: unknown, signature: string): boolean {
      return verifyBytes(null, canonicalJsonBytes(value), publicKey, decodeSignature(signature));
    },
    [verificationTrustBrand]: true as const,
  });
}

function assertUnsignedRecord(value: unknown): asserts value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw releaseEvidenceError("release signed value must be an object", "RELEASE_GATE_RECEIPT_INVALID");
  }
  const record = value as Record<string, unknown>;
  for (const key of ["signerKeyId", "signatureAlgorithm", "signature"]) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      throw releaseEvidenceError(`unsigned release value must not contain ${key}`, "RELEASE_GATE_RECEIPT_INVALID", { key });
    }
  }
}

export function signReleaseObject<T extends Readonly<Record<string, unknown>>>(
  authority: ReleaseSigningAuthority,
  unsigned: T,
): Readonly<T & ReleaseSignatureFields> {
  assertUnsignedRecord(unsigned);
  const signable = {
    ...unsigned,
    signerKeyId: authority.keyId,
    signatureAlgorithm: "Ed25519" as const,
  };
  return Object.freeze({
    ...signable,
    signature: authority.signCanonical(signable),
  });
}

export function verifyReleaseObject<T extends Readonly<Record<string, unknown>>>(
  trust: ReleaseVerificationTrust,
  signed: T & Partial<ReleaseSignatureFields>,
): asserts signed is T & ReleaseSignatureFields {
  if (signed === null || typeof signed !== "object" || Array.isArray(signed)) {
    throw releaseEvidenceError("signed release value must be an object", "RELEASE_GATE_RECEIPT_INVALID");
  }
  const signerKeyId = requireKeyId(signed.signerKeyId, "RELEASE_GATE_RECEIPT_INVALID");
  if (signerKeyId !== trust.keyId) {
    throw releaseEvidenceError("release signer does not match the pinned trusted key", "RELEASE_GATE_RECEIPT_INVALID", {
      expectedSignerKeyId: trust.keyId,
      actualSignerKeyId: signerKeyId,
    });
  }
  if (signed.signatureAlgorithm !== "Ed25519") {
    throw releaseEvidenceError("release signature algorithm must be Ed25519", "RELEASE_GATE_RECEIPT_INVALID");
  }
  const signature = typeof signed.signature === "string" ? signed.signature : "";
  const { signature: _signature, ...signable } = signed as Record<string, unknown>;
  if (!trust.verifyCanonical(signable, signature)) {
    throw releaseEvidenceError("release signature verification failed", "RELEASE_GATE_RECEIPT_INVALID");
  }
}

export function hashSignedReleaseObject(value: Readonly<Record<string, unknown>>): string {
  return sha256Identifier(canonicalJsonBytes(value));
}

export function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function assertReleaseHash(value: unknown, field: string): asserts value is string {
  if (!isSha256Identifier(value)) {
    throw releaseEvidenceError(`${field} must use sha256:<64 lowercase hex>`, "RELEASE_GATE_RECEIPT_INVALID", { field });
  }
}

// ---------------------------------------------------------------------------
// Strongly-typed payload decoders for signed external evidence.
// Each decoder mirrors the output schema of the corresponding verifier script:
//   - decodeLiveReleasePayload  ↔ scripts/verify-live-release-evidence.ts#verifyLiveReleaseEvidence
//   - decodeDraftPrPayload      ↔ scripts/verify-live-release-evidence.ts#draftPrRehearsalViolations
//   - decodeProductPayload      ↔ scripts/verify-product-gate.ts#verifyProductGateEvidenceFile
// ---------------------------------------------------------------------------

const DRAFT_PR_GENERATOR = "scripts/rehearse-disposable-draft-pr.ts#rehearseDisposableDraftPr";
const REHEARSAL_BRANCH_PATTERN = /^cpb-release-rehearsal\/[A-Za-z0-9._-]+$/;
const HEX40_PATTERN = /^[0-9a-f]{40}$/i;
const GITHUB_PR_URL_PATTERN = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;
const DRAFT_PR_OPERATION_NAMES = [
  "origin.verify",
  "github.auth.verify",
  "repository.verify",
  "marker.verify",
  "branch.create.verify",
  "payload.write.verify",
  "pull_request.create.verify",
  "pull_request.read.verify",
  "pull_request.close.verify",
  "branch.delete.verify",
] as const;

function payloadError(message: string, details: Record<string, unknown> = {}): Error {
  return releaseEvidenceError(message, "RELEASE_EVIDENCE_PAYLOAD_INVALID", details);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validates a live_release evidence payload, mirroring the output of
 * verifyLiveReleaseEvidence: { ok, providerEvidenceFile, draftPrEvidenceFile,
 * productEvidenceFile, productRecordCount, officialScoreBundleCount, violations }.
 */
export function decodeLiveReleasePayload(payload: unknown): void {
  if (!isPlainRecord(payload)) {
    throw payloadError("live_release payload must be a JSON object");
  }
  if (payload.ok !== true) {
    throw payloadError("live_release payload ok must be true", { field: "ok" });
  }
  for (const field of ["providerEvidenceFile", "draftPrEvidenceFile", "productEvidenceFile"] as const) {
    if (!nonEmptyString(payload[field])) {
      throw payloadError(`live_release payload ${field} must be a non-empty string`, { field });
    }
  }
  const productRecordCount = payload.productRecordCount;
  if (typeof productRecordCount !== "number" || !Number.isFinite(productRecordCount) || productRecordCount < 3) {
    throw payloadError("live_release payload productRecordCount must be >= 3", { field: "productRecordCount" });
  }
  const officialScoreBundleCount = payload.officialScoreBundleCount;
  if (typeof officialScoreBundleCount !== "number" || !Number.isFinite(officialScoreBundleCount) || officialScoreBundleCount < 1) {
    throw payloadError("live_release payload officialScoreBundleCount must be >= 1", { field: "officialScoreBundleCount" });
  }
  if (!Array.isArray(payload.violations) || payload.violations.length !== 0) {
    throw payloadError("live_release payload violations must be an empty array", { field: "violations" });
  }
}

/**
 * Validates a draft_pr evidence payload, mirroring the bundle structure checked
 * by draftPrRehearsalViolations: schemaVersion, generator, ok, mode, violations,
 * target, branch, pullRequest, cleanup, operations.
 */
export function decodeDraftPrPayload(payload: unknown): void {
  if (!isPlainRecord(payload)) {
    throw payloadError("draft_pr payload must be a JSON object");
  }
  if (payload.schemaVersion !== 1) {
    throw payloadError("draft_pr payload schemaVersion must be 1", { field: "schemaVersion" });
  }
  if (payload.generator !== DRAFT_PR_GENERATOR) {
    throw payloadError("draft_pr payload generator must identify the disposable rehearsal generator", { field: "generator" });
  }
  if (payload.ok !== true) {
    throw payloadError("draft_pr payload ok must be true", { field: "ok" });
  }
  if (payload.mode !== "live") {
    throw payloadError("draft_pr payload mode must be 'live'", { field: "mode" });
  }
  if (!Array.isArray(payload.violations) || payload.violations.length !== 0) {
    throw payloadError("draft_pr payload violations must be an empty array", { field: "violations" });
  }

  const target = payload.target;
  if (!isPlainRecord(target)) {
    throw payloadError("draft_pr payload target must be an object", { field: "target" });
  }
  if (!nonEmptyString(target.repository)) {
    throw payloadError("draft_pr payload target.repository must be a non-empty string", { field: "target.repository" });
  }
  if (target.disposable !== true || target.markerVerified !== true) {
    throw payloadError("draft_pr payload target must be disposable and markerVerified", { field: "target" });
  }
  if (!nonEmptyString(target.repositoryId)) {
    throw payloadError("draft_pr payload target.repositoryId must be a non-empty string", { field: "target.repositoryId" });
  }
  if (target.markerPath !== ".cpb-disposable-target.json") {
    throw payloadError("draft_pr payload target.markerPath must be .cpb-disposable-target.json", { field: "target.markerPath" });
  }
  if (!nonEmptyString(target.markerSha) || !HEX40_PATTERN.test(target.markerSha.trim())) {
    throw payloadError("draft_pr payload target.markerSha must be a 40-character hex string", { field: "target.markerSha" });
  }

  if (!nonEmptyString(payload.branch) || !REHEARSAL_BRANCH_PATTERN.test(payload.branch.trim())) {
    throw payloadError("draft_pr payload branch must use the cpb-release-rehearsal/ namespace", { field: "branch" });
  }

  const pullRequest = payload.pullRequest;
  if (!isPlainRecord(pullRequest)) {
    throw payloadError("draft_pr payload pullRequest must be an object", { field: "pullRequest" });
  }
  if (!Number.isInteger(pullRequest.number) || Number(pullRequest.number) <= 0) {
    throw payloadError("draft_pr payload pullRequest.number must be a positive integer", { field: "pullRequest.number" });
  }
  if (!nonEmptyString(pullRequest.url) || !GITHUB_PR_URL_PATTERN.test(pullRequest.url.trim())) {
    throw payloadError("draft_pr payload pullRequest.url must be a GitHub pull request URL", { field: "pullRequest.url" });
  }
  if (pullRequest.draft !== true || pullRequest.state !== "closed") {
    throw payloadError("draft_pr payload pullRequest must be a closed draft", { field: "pullRequest" });
  }

  const cleanup = payload.cleanup;
  if (!isPlainRecord(cleanup)) {
    throw payloadError("draft_pr payload cleanup must be an object", { field: "cleanup" });
  }
  if (cleanup.pullRequestClosed !== true || cleanup.branchDeleted !== true) {
    throw payloadError("draft_pr payload cleanup must prove PR closure and branch deletion", { field: "cleanup" });
  }

  const operations = payload.operations;
  if (!Array.isArray(operations)) {
    throw payloadError("draft_pr payload operations must be an array", { field: "operations" });
  }
  const operationNames = operations.map((op) => isPlainRecord(op) ? op.name : null);
  if (
    operationNames.length !== DRAFT_PR_OPERATION_NAMES.length
    || operationNames.some((name, index) => name !== DRAFT_PR_OPERATION_NAMES[index])
  ) {
    throw payloadError("draft_pr payload operations must contain the complete ordered rehearsal sequence", { field: "operations" });
  }
}

/**
 * Validates a product evidence payload, mirroring the output of
 * verifyProductGateEvidenceFile: { ok, recordCount,
 * supplementalOfficialScoreBundleCount, violations }.
 */
export function decodeProductPayload(payload: unknown): void {
  if (!isPlainRecord(payload)) {
    throw payloadError("product payload must be a JSON object");
  }
  if (payload.ok !== true) {
    throw payloadError("product payload ok must be true", { field: "ok" });
  }
  const recordCount = payload.recordCount;
  if (typeof recordCount !== "number" || !Number.isFinite(recordCount) || recordCount < 3) {
    throw payloadError("product payload recordCount must be >= 3", { field: "recordCount" });
  }
  const supplementalOfficialScoreBundleCount = payload.supplementalOfficialScoreBundleCount;
  if (typeof supplementalOfficialScoreBundleCount !== "number" || !Number.isFinite(supplementalOfficialScoreBundleCount) || supplementalOfficialScoreBundleCount < 1) {
    throw payloadError("product payload supplementalOfficialScoreBundleCount must be >= 1", { field: "supplementalOfficialScoreBundleCount" });
  }
  if (!Array.isArray(payload.violations) || payload.violations.length !== 0) {
    throw payloadError("product payload violations must be an empty array", { field: "violations" });
  }
}
