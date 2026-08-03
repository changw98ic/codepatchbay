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
import {
  REQUIRED_EXTERNAL_EVIDENCE,
  REQUIRED_RELEASE_GATES,
  writeSignedExternalEvidence,
} from "../scripts/release-gate-receipts.js";
import { buildReleaseSourceFingerprint } from "../scripts/release-source-fingerprint.js";
import {
  runReleaseGateSession,
  sanitizeReleaseGateChildEnv,
} from "../scripts/verify-release-gate.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const runtimeScript = path.join(repoRoot, "dist", "scripts", "verify-release-gate.js");

function keys() {
  const pair = generateKeyPairSync("ed25519");
  const keyId = "runner-test-authority";
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

async function fixture(t: test.TestContext) {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-gate-runner-source-"));
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-gate-runner-runtime-"));
  t.after(async () => {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  });
  await mkdir(path.join(sourceRoot, "scripts"));
  await writeFile(path.join(sourceRoot, "package.json"), '{"name":"runner","version":"1.0.0"}\n');
  await writeFile(path.join(sourceRoot, "scripts", "main.ts"), "export const runner = true;\n");
  return { sourceRoot, runtimeRoot };
}

test("release gate has one fixed ordered set of 17 gates", () => {
  assert.deepEqual(REQUIRED_RELEASE_GATES.map((gate) => gate.id), [
    "build-node-tests",
    "typecheck",
    "strict-engine",
    "strict-runtime-contracts",
    "type-debt-engine",
    "test-main",
    "test-integration",
    "test-specialized",
    "dependency-audit",
    "patch-integrity",
    "commit-size",
    "v2-release-scan",
    "enterprise-gate",
    "docs-contract",
    "product-gate",
    "live-release-evidence",
    "release-contracts",
  ]);
});

test("release gate child environment never receives signing or trusted key material", () => {
  const sanitized = sanitizeReleaseGateChildEnv({
    PATH: process.env.PATH,
    CPB_RELEASE_GATE_SIGNING_KEY: "private",
    CPB_RELEASE_GATE_SIGNING_KEY_ID: "private-id",
    CPB_RELEASE_GATE_TRUSTED_PUBLIC_KEY: "public",
    CPB_RELEASE_GATE_TRUSTED_KEY_ID: "public-id",
  });
  assert.equal(sanitized.PATH, process.env.PATH);
  assert.equal(sanitized.CPB_WORKER_DISPATCH_ENABLED, "0");
  for (const key of [
    "CPB_RELEASE_GATE_SIGNING_KEY",
    "CPB_RELEASE_GATE_SIGNING_KEY_ID",
    "CPB_RELEASE_GATE_TRUSTED_PUBLIC_KEY",
    "CPB_RELEASE_GATE_TRUSTED_KEY_ID",
  ]) assert.equal(sanitized[key], undefined);
});

test("release gate runner writes and directly verifies a complete signed session", async (t) => {
  const roots = await fixture(t);
  const signing = keys();
  const source = await buildReleaseSourceFingerprint({ root: roots.sourceRoot });
  const externalHashes: string[] = [];
  for (const kind of Object.keys(REQUIRED_EXTERNAL_EVIDENCE) as (keyof typeof REQUIRED_EXTERNAL_EVIDENCE)[]) {
    const written = await writeSignedExternalEvidence({
      runtimeRoot: roots.runtimeRoot,
      releaseSourceFingerprint: source.releaseSourceFingerprint,
      authority: signing.authority,
      kind,
      generatedAt: "2026-08-03T00:00:00.000Z",
      expiresAt: "2026-09-02T00:00:00.000Z",
      payload: { kind, ok: true },
    });
    externalHashes.push(written.evidenceSha256);
  }
  assert.equal(externalHashes.length, 4);
  const observedEnvs: NodeJS.ProcessEnv[] = [];
  const result = await runReleaseGateSession({
    ...roots,
    ...signing,
    sessionId: "runner-session-success",
    now: () => new Date("2026-08-04T00:00:00.000Z"),
    env: {
      CPB_RELEASE_GATE_SIGNING_KEY: "must-not-leak",
      CPB_RELEASE_GATE_TRUSTED_PUBLIC_KEY: "must-not-leak",
    },
    inspectIndex: async () => "idx-runner-test",
    execute: async (gate, context) => {
      observedEnvs.push(context.env);
      return { exitCode: 0, stdout: Buffer.from(`${gate.id}\n`), stderr: Buffer.alloc(0) };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.receipts.length, 17);
  assert.equal(result.report?.ready, true);
  assert.ok(observedEnvs.every((env) => env.CPB_RELEASE_GATE_SIGNING_KEY === undefined));
  await readFile(path.join(result.session.sessionRoot, "completion.json"), "utf8");
});

test("release gate runner preserves the failed receipt and stops without completion", async (t) => {
  const roots = await fixture(t);
  const signing = keys();
  const result = await runReleaseGateSession({
    ...roots,
    ...signing,
    sessionId: "runner-session-failure",
    now: () => new Date("2026-08-04T00:00:00.000Z"),
    inspectIndex: async () => "idx-runner-test",
    execute: async () => ({ exitCode: 7, stdout: Buffer.alloc(0), stderr: Buffer.from("failed\n") }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0].receipt.exitCode, 7);
  await assert.rejects(readFile(path.join(result.session.sessionRoot, "completion.json")), { code: "ENOENT" });
});

test("release gate executable rejects unsafe policy before reading signing keys", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [runtimeScript], {
      cwd: repoRoot,
      env: { ...process.env, CPB_CHECKLIST_DECOMPOSE: "0" },
    }),
    (error: any) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /RELEASE_GATE_POLICY_INVALID.*CPB_CHECKLIST_DECOMPOSE=0/);
      return true;
    },
  );
});
