import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  createReleaseSigningAuthority,
  createReleaseVerificationTrust,
} from "../core/contracts/release-evidence.js";
import { buildReleaseReadinessReport } from "../scripts/release-readiness-report.js";
import {
  initializeReleaseGateSession,
  REQUIRED_EXTERNAL_EVIDENCE,
  REQUIRED_RELEASE_GATES,
  verifyReleaseReadiness,
  writeSignedExternalEvidence,
  writeSignedReleaseGateCompletion,
  writeSignedReleaseGateReceipt,
  type CodeIndexInspector,
} from "../scripts/release-gate-receipts.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..", "..");

const OK_INDEX: CodeIndexInspector = async () => ({
  available: true,
  fresh: true,
  exact: true,
  coverage: "symbol-level",
  ref: { snapshotId: "idx-readiness-final" },
});

function keyPair(keyId: string) {
  const pair = generateKeyPairSync("ed25519");
  return {
    authority: createReleaseSigningAuthority({
      keyId,
      privateKeyBase64Url: Buffer.from(pair.privateKey.export({ format: "der", type: "pkcs8" })).toString("base64url"),
    }),
    trust: createReleaseVerificationTrust({
      keyId,
      publicKeyBase64Url: Buffer.from(pair.publicKey.export({ format: "der", type: "spki" })).toString("base64url"),
    }),
  };
}

function evidencePayloadFor(kind: string) {
  if (kind === "live_release") {
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
  if (kind === "draft_pr") {
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
      cleanup: { pullRequestClosed: true, branchDeleted: true },
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
  // product
  return {
    ok: true,
    recordCount: 3,
    supplementalOfficialScoreBundleCount: 1,
    violations: [],
  };
}

async function completedFixture(t: test.TestContext) {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-readiness-source-"));
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-readiness-runtime-"));
  t.after(async () => {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  });
  await mkdir(path.join(sourceRoot, "core"));
  await writeFile(path.join(sourceRoot, "package.json"), '{"name":"readiness","version":"1.0.0"}\n');
  await writeFile(path.join(sourceRoot, "core", "main.ts"), "export const ready = true;\n");
  const signing = keyPair("readiness-authority");
  const session = await initializeReleaseGateSession({ sourceRoot, runtimeRoot, sessionId: "readiness-session" });
  const externalEvidenceSha256 = {} as Record<keyof typeof REQUIRED_EXTERNAL_EVIDENCE, string>;
  for (const kind of Object.keys(REQUIRED_EXTERNAL_EVIDENCE) as (keyof typeof REQUIRED_EXTERNAL_EVIDENCE)[]) {
    const written = await writeSignedExternalEvidence({
      runtimeRoot,
      releaseSourceFingerprint: session.source.releaseSourceFingerprint,
      authority: signing.authority,
      kind,
      generatedAt: "2026-08-03T00:00:00.000Z",
      expiresAt: "2026-09-02T00:00:00.000Z",
      payload: evidencePayloadFor(kind),
    });
    externalEvidenceSha256[kind] = written.evidenceSha256;
  }
  const receiptHashes: string[] = [];
  let previousReceiptSha256: string | null = null;
  for (let index = 0; index < REQUIRED_RELEASE_GATES.length; index += 1) {
    const written = await writeSignedReleaseGateReceipt({
      session,
      authority: signing.authority,
      gate: REQUIRED_RELEASE_GATES[index],
      sequence: index + 1,
      previousReceiptSha256,
      indexSnapshotIdAtSessionStart: "idx-readiness-start",
      startedAt: `2026-08-03T00:00:${String(index).padStart(2, "0")}.000Z`,
      finishedAt: `2026-08-03T00:00:${String(index).padStart(2, "0")}.001Z`,
      exitCode: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
    receiptHashes.push(written.receiptSha256);
    previousReceiptSha256 = written.receiptSha256;
  }
  await writeSignedReleaseGateCompletion({
    session,
    authority: signing.authority,
    indexSnapshotIdAtFinalCheck: "idx-readiness-final",
    receiptHashes,
    externalEvidenceSha256,
    completedAt: "2026-08-03T00:01:00.000Z",
  });
  return { sourceRoot, runtimeRoot, session, ...signing };
}

test("release readiness wrapper reports ready only for the complete signed session", async (t) => {
  const fixture = await completedFixture(t);
  // Call verifyReleaseReadiness directly so we can inject inspectCodeIndex
  // (buildReleaseReadinessReport does not forward it yet).
  const report = await verifyReleaseReadiness({
    sourceRoot: fixture.sourceRoot,
    runtimeRoot: fixture.runtimeRoot,
    releaseSourceFingerprint: fixture.session.source.releaseSourceFingerprint,
    sessionId: fixture.session.sessionId,
    trust: fixture.trust,
    referenceTime: new Date("2026-08-04T00:00:00.000Z"),
    inspectCodeIndex: OK_INDEX,
  });
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.ready, true);
  assert.equal(report.signerKeyId, fixture.trust.keyId);
});

test("release readiness wrapper fails with a different pinned authority", async (t) => {
  const fixture = await completedFixture(t);
  const other = keyPair("other-readiness-authority");
  const report = await verifyReleaseReadiness({
    sourceRoot: fixture.sourceRoot,
    runtimeRoot: fixture.runtimeRoot,
    releaseSourceFingerprint: fixture.session.source.releaseSourceFingerprint,
    sessionId: fixture.session.sessionId,
    trust: other.trust,
    referenceTime: new Date("2026-08-04T00:00:00.000Z"),
    inspectCodeIndex: OK_INDEX,
  });
  assert.equal(report.ready, false);
  assert.equal((report.error as { code: string }).code, "RELEASE_GATE_RECEIPT_INVALID");
});

test("release readiness has no legacy git-status or source-tree evidence path", async () => {
  const source = await readFile(path.join(repoRoot, "scripts", "release-readiness-report.ts"), "utf8");
  assert.doesNotMatch(source, /gitStatus|execFileSync|docs\/product\/cpb-live-release-validation\.json/);
  assert.match(source, /verifyReleaseReadiness/);
});

test("release readiness CLI requires an explicit fingerprint and session", async () => {
  const runtimeScript = path.join(repoRoot, "dist", "scripts", "release-readiness-report.js");
  await assert.rejects(
    execFileAsync(process.execPath, [runtimeScript], {
      cwd: repoRoot,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CPB_RELEASE_"))),
    }),
    (error: any) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /release readiness requires --fingerprint and --session/);
      return true;
    },
  );
});

test("package exposes the signed release readiness entrypoint", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["report:release-readiness"], "npm run build:node && node dist/scripts/release-readiness-report.js");
  assert.match(pkg.scripts["verify:release-gate"], /verify-release-gate\.js/);
  assert.match(pkg.scripts["verify:release-contracts"], /verify-release-contracts\.js/);
});
