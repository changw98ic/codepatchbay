import path from "node:path";

import { canonicalJsonBytes, sha256Identifier, type CanonicalJsonValue } from "../core/contracts/canonical-json.js";
import {
  assertReleaseHash,
  hashSignedReleaseObject,
  signReleaseObject,
  type ExternalEvidenceKind,
  type ReleaseGateCompletion,
  type ReleaseGateReceipt,
  type ReleaseSigningAuthority,
  type SignedExternalEvidence,
} from "../core/contracts/release-evidence.js";
import { sanitizeReleaseGateBuffer } from "./release-redactor.js";
import {
  buildReleaseSourceFingerprint,
  verifyReleaseSourceFingerprint,
  type ReleaseSourceFingerprint,
} from "./release-source-fingerprint.js";
import { exactKeys, REQUIRED_EXTERNAL_EVIDENCE, requireTimestamp } from "./release-gate/decoding.js";
import {
  ensureSafeDirectory,
  receiptError,
  releasePaths,
  requireSafeId,
  writeImmutableFile,
  writeImmutableJson,
} from "./release-gate/storage.js";
import { REQUIRED_RELEASE_GATES, type ReleaseGateSpec } from "./release-gate/verification.js";

// ---------------------------------------------------------------------------
// Public re-exports.
//
// The verification + decoding layers own the canonical definitions; this
// module re-exports them so existing callers can keep importing everything
// from "scripts/release-gate-receipts.js" without code changes.
// ---------------------------------------------------------------------------

export { REQUIRED_EXTERNAL_EVIDENCE } from "./release-gate/decoding.js";
export { REQUIRED_RELEASE_GATES, type ReleaseGateSpec } from "./release-gate/verification.js";
export {
  type CodeIndexInspector,
  type CodeIndexStatus,
  verifyReleaseReadiness,
  verifySignedExternalEvidenceSet,
} from "./release-gate/verification.js";

// ---------------------------------------------------------------------------
// Session + receipt types used by the public write entry points.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public write entry points.
// ---------------------------------------------------------------------------

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
