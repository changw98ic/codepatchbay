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

export type SignedExternalEvidence = Readonly<{
  schemaVersion: 1;
  kind: "live_release" | "verified_5" | "draft_pr" | "product";
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
