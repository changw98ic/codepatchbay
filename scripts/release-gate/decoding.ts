import path from "node:path";

import { canonicalJsonBytes, sha256Identifier } from "../../core/contracts/canonical-json.js";
import {
  assertReleaseHash,
  decodeDraftPrPayload,
  decodeLiveReleasePayload,
  decodeProductPayload,
  isCanonicalUtcTimestamp,
  verifyReleaseObject,
  type ExternalEvidenceKind,
  type ReleaseGateCompletion,
  type ReleaseGateReceipt,
  type ReleaseVerificationTrust,
  type SignedExternalEvidence,
} from "../../core/contracts/release-evidence.js";
import { receiptError, requireSafeId } from "./storage.js";

// ---------------------------------------------------------------------------
// Registered external evidence kinds.
//
// This map lives in the decoding layer (rather than the public main module)
// because the decoders below validate against it, and the verification layer
// also iterates it. The main entry point re-exports it to preserve the public
// API; defining it here keeps the dependency graph acyclic (main -> decoding,
// never the reverse).
// ---------------------------------------------------------------------------

export const REQUIRED_EXTERNAL_EVIDENCE = Object.freeze({
  live_release: "live-release.json",
  draft_pr: "draft-pr.json",
  product: "product.json",
} as const);

// ---------------------------------------------------------------------------
// Validation helpers (pure value checks; no I/O).
// ---------------------------------------------------------------------------

export function exactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw receiptError(`${label} fields are invalid`, "RELEASE_GATE_RECEIPT_INVALID", { actual, expected: wanted });
  }
}

export function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw receiptError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw receiptError(`${label} must be a non-empty string array`);
  }
  return value as string[];
}

export function requireTimestamp(value: unknown, label: string): string {
  if (!isCanonicalUtcTimestamp(value)) throw receiptError(`${label} must be a canonical UTC timestamp`);
  return value;
}

// ---------------------------------------------------------------------------
// Record key sets + decoders.
// ---------------------------------------------------------------------------

const RECEIPT_KEYS = [
  "schemaVersion", "sessionId", "sequence", "previousReceiptSha256", "gateId",
  "releaseSourceFingerprint", "indexSnapshotIdAtSessionStart", "command", "cwd",
  "startedAt", "finishedAt", "exitCode", "ok", "stdoutBytes", "stderrBytes",
  "stdoutArtifactPath", "stderrArtifactPath", "stdoutSha256", "stderrSha256",
  "stdoutRedactedSha256", "stderrRedactedSha256",
  "evidence", "signerKeyId", "signatureAlgorithm", "signature",
] as const;

export function decodeReceipt(value: unknown, trust: ReleaseVerificationTrust): ReleaseGateReceipt {
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

export function decodeCompletion(value: unknown, trust: ReleaseVerificationTrust): ReleaseGateCompletion {
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

export function decodeExternalEvidence(value: unknown, trust: ReleaseVerificationTrust, referenceTime: Date): SignedExternalEvidence {
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
