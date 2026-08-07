import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { canonicalJson, canonicalJsonBytes, sha256Identifier, type CanonicalJsonValue } from "../../core/contracts/canonical-json.js";
import {
  hashSignedReleaseObject,
  type ExternalEvidenceKind,
  type ReleaseGateCompletion,
  type ReleaseGateReceipt,
  type ReleaseVerificationTrust,
} from "../../core/contracts/release-evidence.js";
import { sanitizeReleaseGateText } from "../release-redactor.js";
import { buildReleaseSourceFingerprint } from "../release-source-fingerprint.js";
import { decodeCompletion, decodeExternalEvidence, decodeReceipt, recordValue, REQUIRED_EXTERNAL_EVIDENCE } from "./decoding.js";
import { ensureInside, errorCode, hashRawFileNoFollow, readJsonNoFollow, releasePaths, receiptError } from "./storage.js";

// ---------------------------------------------------------------------------
// Public gate specifications.
//
// REQUIRED_RELEASE_GATES + ReleaseGateSpec are consumed by the verification
// loop below and by the public write entry points in release-gate-receipts.ts.
// They are defined here (rather than in the main module) because the
// verification loop needs them at module scope, and the main module already
// depends on this layer -- so re-exporting from the main module preserves the
// public API without creating an import cycle.
// ---------------------------------------------------------------------------

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
  { id: "docs-contract", command: ["npm", "run", "verify:docs-contract"], steps: [["npm", "run", "verify:docs-contract"]] },
  { id: "product-gate", command: ["npm", "run", "verify:product-gate"], steps: [["npm", "run", "verify:product-gate"]] },
  { id: "live-release-evidence", command: ["npm", "run", "verify:live-release-evidence"], steps: [["npm", "run", "verify:live-release-evidence"]] },
  { id: "release-contracts", command: ["npm", "run", "verify:release-contracts"], steps: [["npm", "run", "verify:release-contracts"]] },
]);

// ---------------------------------------------------------------------------
// External-evidence verification.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Full session verification (throws on any mismatch).
// ---------------------------------------------------------------------------

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
