#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createReleaseVerificationTrust, type ReleaseVerificationTrust } from "../core/contracts/release-evidence.js";
import { verifyReleaseReadiness } from "./release-gate-receipts.js";

type ReadinessInput = Readonly<{
  sourceRoot?: string;
  runtimeRoot?: string;
  releaseSourceFingerprint: string;
  sessionId: string;
  trust: ReleaseVerificationTrust;
  referenceTime?: Date;
}>;

export async function buildReleaseReadinessReport(input: ReadinessInput) {
  return verifyReleaseReadiness({
    sourceRoot: path.resolve(input.sourceRoot || process.cwd()),
    runtimeRoot: path.resolve(input.runtimeRoot || path.join(os.homedir(), ".cpb")),
    releaseSourceFingerprint: input.releaseSourceFingerprint,
    sessionId: input.sessionId,
    trust: input.trust,
    referenceTime: input.referenceTime,
  });
}

function option(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const sourceRoot = path.resolve(option(args, "--source-root") || process.env.CPB_RELEASE_SOURCE_ROOT || process.cwd());
  const runtimeRoot = path.resolve(option(args, "--runtime-root") || process.env.CPB_ROOT || path.join(os.homedir(), ".cpb"));
  const releaseSourceFingerprint = option(args, "--fingerprint") || process.env.CPB_RELEASE_SOURCE_FINGERPRINT;
  const sessionId = option(args, "--session") || process.env.CPB_RELEASE_GATE_SESSION_ID;
  if (!releaseSourceFingerprint || !sessionId) {
    throw Object.assign(new Error("release readiness requires --fingerprint and --session"), {
      code: "RELEASE_GATE_RECEIPT_INVALID",
    });
  }
  const trust = createReleaseVerificationTrust({
    keyId: process.env.CPB_RELEASE_GATE_TRUSTED_KEY_ID || "",
    publicKeyBase64Url: process.env.CPB_RELEASE_GATE_TRUSTED_PUBLIC_KEY || "",
  });
  const report = await buildReleaseReadinessReport({
    sourceRoot,
    runtimeRoot,
    releaseSourceFingerprint,
    sessionId,
    trust,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ready) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "RELEASE_GATE_RECEIPT_INVALID";
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
  });
}
