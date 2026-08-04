import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createReleaseSigningAuthority,
  createReleaseVerificationTrust,
} from "../core/contracts/release-evidence.js";
import type { CanonicalJsonValue } from "../core/contracts/canonical-json.js";
import {
  initializeReleaseGateSession,
  REQUIRED_EXTERNAL_EVIDENCE,
  REQUIRED_RELEASE_GATES,
  verifyReleaseReadiness,
  writeSignedExternalEvidence,
  writeSignedReleaseGateCompletion,
  writeSignedReleaseGateReceipt,
  type CodeIndexInspector,
  type CodeIndexStatus,
  type ReleaseGateSession,
} from "../scripts/release-gate-receipts.js";

const INDEX_SNAPSHOT_FINAL = "idx-release-final";

function okCodeIndexInspector(snapshotId = INDEX_SNAPSHOT_FINAL): CodeIndexInspector {
  return async () => ({
    available: true,
    fresh: true,
    exact: true,
    coverage: "symbol-level",
    ref: { snapshotId },
  });
}

function signingFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = "release-test-authority";
  return {
    authority: createReleaseSigningAuthority({
      keyId,
      privateKeyBase64Url: Buffer.from(privateKey.export({ format: "der", type: "pkcs8" })).toString("base64url"),
    }),
    trust: createReleaseVerificationTrust({
      keyId,
      publicKeyBase64Url: Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("base64url"),
    }),
  };
}

async function sourceFixture(t: test.TestContext) {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-release-session-source-"));
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-release-session-runtime-"));
  t.after(async () => {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  });
  await mkdir(path.join(sourceRoot, "scripts"));
  await writeFile(path.join(sourceRoot, "package.json"), '{"name":"release-session","version":"1.0.0"}\n');
  await writeFile(path.join(sourceRoot, "scripts", "main.ts"), "export const ready = true;\n");
  return { sourceRoot, runtimeRoot };
}

// ---- Strongly-typed evidence payloads (mirror verifier outputs) ----

function liveReleasePayload() {
  return {
    ok: true,
    providerEvidenceFile: "docs/product/evidence/live-release/provider-connectivity.json",
    draftPrEvidenceFile: "docs/product/evidence/live-release/draft-pr-rehearsal.json",
    productEvidenceFile: "docs/product/cpb-flagship-product-validation.json",
    productRecordCount: 3,
    officialScoreBundleCount: 1,
    violations: [],
  };
}

function draftPrPayload() {
  return {
    schemaVersion: 1,
    generator: "scripts/rehearse-disposable-draft-pr.ts#rehearseDisposableDraftPr",
    ok: true,
    mode: "live",
    violations: [],
    target: {
      repository: "cpb-test/release-target",
      disposable: true,
      markerVerified: true,
      repositoryId: "R_kgAAA",
      markerPath: ".cpb-disposable-target.json",
      markerSha: "a1b2c3d4e5".repeat(4),
    },
    branch: "cpb-release-rehearsal/test-run",
    pullRequest: {
      number: 42,
      url: "https://github.com/cpb-test/release-target/pull/42",
      draft: true,
      state: "closed",
    },
    cleanup: {
      pullRequestClosed: true,
      branchDeleted: true,
    },
    operations: [
      { name: "origin.verify" },
      { name: "github.auth.verify" },
      { name: "repository.verify" },
      { name: "marker.verify" },
      { name: "branch.create.verify" },
      { name: "payload.write.verify" },
      { name: "pull_request.create.verify" },
      { name: "pull_request.read.verify" },
      { name: "pull_request.close.verify" },
      { name: "branch.delete.verify" },
    ],
  };
}

function productPayload() {
  return {
    ok: true,
    recordCount: 3,
    supplementalOfficialScoreBundleCount: 1,
    violations: [],
  };
}

function evidencePayloadFor(kind: string) {
  if (kind === "live_release") return liveReleasePayload();
  if (kind === "draft_pr") return draftPrPayload();
  if (kind === "product") return productPayload();
  throw new Error(`unknown evidence kind ${kind}`);
}

async function completeSession(t: test.TestContext) {
  const roots = await sourceFixture(t);
  const keys = signingFixture();
  const session = await initializeReleaseGateSession({
    ...roots,
    sessionId: "gate-session-001",
  });
  const generatedAt = "2026-08-03T00:00:00.000Z";
  const expiresAt = "2026-09-02T00:00:00.000Z";
  const externalEvidenceSha256 = {} as Record<keyof typeof REQUIRED_EXTERNAL_EVIDENCE, string>;
  for (const kind of Object.keys(REQUIRED_EXTERNAL_EVIDENCE) as (keyof typeof REQUIRED_EXTERNAL_EVIDENCE)[]) {
    const written = await writeSignedExternalEvidence({
      runtimeRoot: roots.runtimeRoot,
      releaseSourceFingerprint: session.source.releaseSourceFingerprint,
      authority: keys.authority,
      kind,
      generatedAt,
      expiresAt,
      payload: evidencePayloadFor(kind),
    });
    externalEvidenceSha256[kind] = written.evidenceSha256;
  }

  const receiptHashes: string[] = [];
  let previousReceiptSha256: string | null = null;
  for (let index = 0; index < REQUIRED_RELEASE_GATES.length; index += 1) {
    const written = await writeSignedReleaseGateReceipt({
      session,
      authority: keys.authority,
      gate: REQUIRED_RELEASE_GATES[index],
      sequence: index + 1,
      previousReceiptSha256,
      indexSnapshotIdAtSessionStart: "idx-release-start",
      startedAt: `2026-08-03T00:00:${String(index).padStart(2, "0")}.000Z`,
      finishedAt: `2026-08-03T00:00:${String(index).padStart(2, "0")}.001Z`,
      exitCode: 0,
      stdout: Buffer.from(`ok ${REQUIRED_RELEASE_GATES[index].id}\n`),
      stderr: Buffer.alloc(0),
      evidence: { checked: true },
    });
    receiptHashes.push(written.receiptSha256);
    previousReceiptSha256 = written.receiptSha256;
  }
  await writeSignedReleaseGateCompletion({
    session,
    authority: keys.authority,
    indexSnapshotIdAtFinalCheck: INDEX_SNAPSHOT_FINAL,
    receiptHashes,
    externalEvidenceSha256,
    completedAt: "2026-08-03T00:01:00.000Z",
  });
  return { ...roots, ...keys, session };
}

async function reportFor(
  fixture: Awaited<ReturnType<typeof completeSession>>,
  inspectCodeIndex?: CodeIndexInspector,
) {
  return verifyReleaseReadiness({
    sourceRoot: fixture.sourceRoot,
    runtimeRoot: fixture.runtimeRoot,
    trust: fixture.trust,
    releaseSourceFingerprint: fixture.session.source.releaseSourceFingerprint,
    sessionId: fixture.session.sessionId,
    referenceTime: new Date("2026-08-04T00:00:00.000Z"),
    inspectCodeIndex: inspectCodeIndex || okCodeIndexInspector(),
  });
}

async function reportForSession(
  fixture: Awaited<ReturnType<typeof completeSession>>,
  sessionId: string,
) {
  return verifyReleaseReadiness({
    sourceRoot: fixture.sourceRoot,
    runtimeRoot: fixture.runtimeRoot,
    trust: fixture.trust,
    releaseSourceFingerprint: fixture.session.source.releaseSourceFingerprint,
    sessionId,
    referenceTime: new Date("2026-08-04T00:00:00.000Z"),
    inspectCodeIndex: okCodeIndexInspector(),
  });
}

function receiptPath(session: ReleaseGateSession, index: number) {
  const gate = REQUIRED_RELEASE_GATES[index];
  return path.join(session.sessionRoot, "gates", `${String(index + 1).padStart(4, "0")}-${gate.id}.json`);
}

test("signed release session verifies all 16 gates, receipt chain, artifacts, and external evidence", async (t) => {
  const fixture = await completeSession(t);
  const report = await reportFor(fixture);
  assert.equal(report.ready, true);
  assert.equal((report.requiredGateIds as unknown[]).length, 16);
  assert.equal(Object.keys(report.gates as object).length, 16);
});

test("release readiness rejects a tampered signed receipt", async (t) => {
  const fixture = await completeSession(t);
  const target = receiptPath(fixture.session, 3);
  const receipt = JSON.parse(await readFile(target, "utf8"));
  receipt.ok = false;
  await writeFile(target, `${JSON.stringify(receipt)}\n`);
  const report = await reportFor(fixture);
  assert.equal(report.ready, false);
  assert.equal((report.error as { code: string }).code, "RELEASE_GATE_RECEIPT_INVALID");
});

test("release readiness rejects missing or reordered receipt slots", async (t) => {
  const missingFixture = await completeSession(t);
  await rm(receiptPath(missingFixture.session, 5));
  assert.equal((await reportFor(missingFixture)).ready, false);

  const reorderedFixture = await completeSession(t);
  const leftPath = receiptPath(reorderedFixture.session, 1);
  const rightPath = receiptPath(reorderedFixture.session, 2);
  const [left, right] = await Promise.all([readFile(leftPath), readFile(rightPath)]);
  await writeFile(leftPath, right);
  await writeFile(rightPath, left);
  assert.equal((await reportFor(reorderedFixture)).ready, false);
});

test("release readiness rejects source changes and external evidence tampering", async (t) => {
  const changedSource = await completeSession(t);
  await writeFile(path.join(changedSource.sourceRoot, "scripts", "main.ts"), "export const ready = false;\n");
  const sourceReport = await reportFor(changedSource);
  assert.equal(sourceReport.ready, false);
  assert.equal((sourceReport.error as { code: string }).code, "RELEASE_SOURCE_CHANGED");

  const changedEvidence = await completeSession(t);
  const externalPath = path.join(
    changedEvidence.session.fingerprintRoot,
    "external",
    REQUIRED_EXTERNAL_EVIDENCE.product,
  );
  const evidence = JSON.parse(await readFile(externalPath, "utf8"));
  evidence.payload.ok = false;
  await writeFile(externalPath, `${JSON.stringify(evidence)}\n`);
  assert.equal((await reportFor(changedEvidence)).ready, false);
});

test("release readiness rejects artifact, completion, and old-session substitution", async (t) => {
  const changedArtifact = await completeSession(t);
  await writeFile(
    path.join(changedArtifact.session.sessionRoot, "artifacts", `0001-${REQUIRED_RELEASE_GATES[0].id}.stdout`),
    "substituted output\n",
  );
  const artifactReport = await reportFor(changedArtifact);
  assert.equal(artifactReport.ready, false);
  assert.equal((artifactReport.error as { code: string }).code, "RELEASE_GATE_RECEIPT_INVALID");

  const changedCompletion = await completeSession(t);
  const completionPath = path.join(changedCompletion.session.sessionRoot, "completion.json");
  const completion = JSON.parse(await readFile(completionPath, "utf8"));
  completion.requiredGateIds = [...completion.requiredGateIds].reverse();
  await writeFile(completionPath, `${JSON.stringify(completion)}\n`);
  const completionReport = await reportFor(changedCompletion);
  assert.equal(completionReport.ready, false);
  assert.equal((completionReport.error as { code: string }).code, "RELEASE_GATE_RECEIPT_INVALID");

  const oldSession = await completeSession(t);
  const oldSessionReport = await reportForSession(oldSession, "gate-session-previous");
  assert.equal(oldSessionReport.ready, false);
});

// ---------------------------------------------------------------------------
// Negative regression: payload decoder failures (v2 receipt schema)
// ---------------------------------------------------------------------------

async function overwriteEvidence(
  fixture: Awaited<ReturnType<typeof completeSession>>,
  kind: keyof typeof REQUIRED_EXTERNAL_EVIDENCE,
  payload: CanonicalJsonValue,
): Promise<void> {
  // writeImmutableFile refuses to overwrite; remove the existing file first
  // so the new (tampered) payload can be written and properly signed.
  const externalPath = path.join(fixture.session.fingerprintRoot, "external", REQUIRED_EXTERNAL_EVIDENCE[kind]);
  await rm(externalPath, { force: true });
  await writeSignedExternalEvidence({
    runtimeRoot: fixture.runtimeRoot,
    releaseSourceFingerprint: fixture.session.source.releaseSourceFingerprint,
    authority: fixture.authority,
    kind,
    generatedAt: "2026-08-03T00:00:00.000Z",
    expiresAt: "2026-09-02T00:00:00.000Z",
    payload,
  });
}

test("release readiness rejects product payload with missing field", async (t) => {
  const fixture = await completeSession(t);
  // Omit recordCount from the product payload.
  await overwriteEvidence(fixture, "product", {
    ok: true,
    supplementalOfficialScoreBundleCount: 1,
    violations: [],
  });
  const report = await reportFor(fixture);
  assert.equal(report.ready, false);
  assert.equal((report.error as { code: string }).code, "RELEASE_EVIDENCE_PAYLOAD_INVALID");
});

test("release readiness rejects product payload with recordCount < 3", async (t) => {
  const fixture = await completeSession(t);
  await overwriteEvidence(fixture, "product", { ...productPayload(), recordCount: 2 });
  const report = await reportFor(fixture);
  assert.equal(report.ready, false);
  assert.equal((report.error as { code: string }).code, "RELEASE_EVIDENCE_PAYLOAD_INVALID");
});

test("release readiness rejects live_release payload with ok=false", async (t) => {
  const fixture = await completeSession(t);
  await overwriteEvidence(fixture, "live_release", { ...liveReleasePayload(), ok: false });
  const report = await reportFor(fixture);
  assert.equal(report.ready, false);
  assert.equal((report.error as { code: string }).code, "RELEASE_EVIDENCE_PAYLOAD_INVALID");
});

test("release readiness rejects draft_pr payload with wrong generator", async (t) => {
  const fixture = await completeSession(t);
  await overwriteEvidence(fixture, "draft_pr", { ...draftPrPayload(), generator: "wrong" });
  const report = await reportFor(fixture);
  assert.equal(report.ready, false);
  assert.equal((report.error as { code: string }).code, "RELEASE_EVIDENCE_PAYLOAD_INVALID");
});

test("release readiness rejects draft_pr payload with non-live mode", async (t) => {
  const fixture = await completeSession(t);
  await overwriteEvidence(fixture, "draft_pr", { ...draftPrPayload(), mode: "dry-run" });
  const report = await reportFor(fixture);
  assert.equal(report.ready, false);
  assert.equal((report.error as { code: string }).code, "RELEASE_EVIDENCE_PAYLOAD_INVALID");
});

test("release readiness rejects external evidence with unknown kind", async (t) => {
  const fixture = await completeSession(t);
  // Write a signed evidence with a kind that used to exist (verified_5) but
  // is no longer registered. The writeSignedExternalEvidence call won't accept
  // it since kind is typed to ExternalEvidenceKind, so we tamper the file
  // directly and re-sign by manipulating the JSON.
  const externalPath = path.join(fixture.session.fingerprintRoot, "external", REQUIRED_EXTERNAL_EVIDENCE.product);
  const evidence = JSON.parse(await readFile(externalPath, "utf8"));
  evidence.kind = "verified_5";
  await writeFile(externalPath, `${JSON.stringify(evidence)}\n`);
  const report = await reportFor(fixture);
  assert.equal(report.ready, false);
  assert.equal((report.error as { code: string }).code, "RELEASE_GATE_RECEIPT_INVALID");
});

// ---------------------------------------------------------------------------
// Negative regression: index recheck failures
// ---------------------------------------------------------------------------

test("release readiness rejects when index snapshot id does not match final check", async (t) => {
  const fixture = await completeSession(t);
  const report = await reportFor(fixture, okCodeIndexInspector("idx-wrong"));
  assert.equal(report.ready, false);
  assert.equal((report.error as { code: string }).code, "RELEASE_GATE_INDEX_STALE");
});

test("release readiness rejects when index is stale", async (t) => {
  const fixture = await completeSession(t);
  const staleInspector: CodeIndexInspector = async () => ({
    available: true,
    fresh: false,
    exact: true,
    coverage: "symbol-level",
    ref: { snapshotId: INDEX_SNAPSHOT_FINAL },
  });
  const report = await reportFor(fixture, staleInspector);
  assert.equal(report.ready, false);
  assert.equal((report.error as { code: string }).code, "RELEASE_GATE_INDEX_STALE");
});

test("release readiness rejects when index coverage is file-inventory-only", async (t) => {
  const fixture = await completeSession(t);
  const fileOnlyInspector: CodeIndexInspector = async () => ({
    available: true,
    fresh: true,
    exact: true,
    coverage: "file-inventory-only",
    ref: { snapshotId: INDEX_SNAPSHOT_FINAL },
  });
  const report = await reportFor(fixture, fileOnlyInspector);
  assert.equal(report.ready, false);
  assert.equal((report.error as { code: string }).code, "RELEASE_GATE_INDEX_COVERAGE_INSUFFICIENT");
});
