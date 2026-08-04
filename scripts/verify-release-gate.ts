#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createReleaseSigningAuthority,
  createReleaseVerificationTrust,
  type ReleaseSigningAuthority,
  type ReleaseVerificationTrust,
} from "../core/contracts/release-evidence.js";
import {
  initializeReleaseGateSession,
  REQUIRED_RELEASE_GATES,
  verifyReleaseReadiness,
  verifySignedExternalEvidenceSet,
  writeSignedReleaseGateCompletion,
  writeSignedReleaseGateReceipt,
  type CodeIndexInspector,
  type CodeIndexStatus,
  type ReleaseGateSession,
  type ReleaseGateSpec,
  type WrittenReceipt,
} from "./release-gate-receipts.js";
import { verifyReleaseSourceFingerprint } from "./release-source-fingerprint.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const PASS = "\x1b[0;32mPASS\x1b[0m";
const FAIL = "\x1b[0;31mFAIL\x1b[0m";
const RELEASE_KEY_ENV = new Set([
  "CPB_RELEASE_GATE_SIGNING_KEY",
  "CPB_RELEASE_GATE_SIGNING_KEY_ID",
  "CPB_RELEASE_GATE_TRUSTED_PUBLIC_KEY",
  "CPB_RELEASE_GATE_TRUSTED_KEY_ID",
]);

export type GateExecutionResult = Readonly<{
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}>;

export type GateExecutor = (
  gate: ReleaseGateSpec,
  context: Readonly<{ cwd: string; env: NodeJS.ProcessEnv }>,
) => Promise<GateExecutionResult>;

function gateError(message: string, code: string, details: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, ...details });
}

export function sanitizeReleaseGateChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  for (const key of RELEASE_KEY_ENV) delete childEnv[key];
  childEnv.CPB_WORKER_DISPATCH_ENABLED = "0";
  return childEnv;
}

function runRawCommand(
  command: readonly string[],
  context: Readonly<{ cwd: string; env: NodeJS.ProcessEnv; echo?: boolean }>,
): Promise<GateExecutionResult> {
  if (command.length === 0) throw gateError("release gate command is empty", "RELEASE_GATE_COMMAND_INVALID");
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: context.cwd,
      env: context.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      const bytes = Buffer.from(chunk);
      stdout.push(bytes);
      if (context.echo !== false) process.stdout.write(bytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const bytes = Buffer.from(chunk);
      stderr.push(bytes);
      if (context.echo !== false) process.stderr.write(bytes);
    });
    child.once("error", (error) => {
      const bytes = Buffer.from(`${error.message}\n`, "utf8");
      stderr.push(bytes);
      if (context.echo !== false) process.stderr.write(bytes);
      resolve({ exitCode: 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    child.once("close", (code) => {
      resolve({
        exitCode: Number.isInteger(code) ? Number(code) : 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

export const executeReleaseGate: GateExecutor = async (gate, context) => {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  for (const step of gate.steps) {
    const result = await runRawCommand(step, { ...context, echo: true });
    stdout.push(result.stdout);
    stderr.push(result.stderr);
    if (result.exitCode !== 0) {
      return { exitCode: result.exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
    }
  }
  return { exitCode: 0, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
};

async function codeIndexSnapshotId(sourceRoot: string, env: NodeJS.ProcessEnv): Promise<string> {
  const launcher = path.join(sourceRoot, "cpb");
  let status = await runRawCommand([launcher, "code-index", "status", "-s", sourceRoot, "--json"], {
    cwd: sourceRoot,
    env,
    echo: false,
  });
  let parsed: any = null;
  try {
    parsed = JSON.parse(status.stdout.toString("utf8"));
  } catch {}
  if (status.exitCode !== 0 || parsed?.available !== true || parsed?.fresh !== true || parsed?.exact !== true) {
    const built = await runRawCommand([launcher, "code-index", "build", "-s", sourceRoot, "--json"], {
      cwd: sourceRoot,
      env,
      echo: false,
    });
    if (built.exitCode !== 0) {
      throw gateError("Local Code Index refresh failed before release gate", "RELEASE_GATE_INDEX_INVALID", {
        stderr: built.stderr.toString("utf8").slice(0, 4_096),
      });
    }
    status = await runRawCommand([launcher, "code-index", "status", "-s", sourceRoot, "--json"], {
      cwd: sourceRoot,
      env,
      echo: false,
    });
    try {
      parsed = JSON.parse(status.stdout.toString("utf8"));
    } catch {
      parsed = null;
    }
  }
  const snapshotId = parsed?.ref?.snapshotId;
  if (status.exitCode !== 0 || parsed?.available !== true || parsed?.fresh !== true || parsed?.exact !== true || typeof snapshotId !== "string" || !snapshotId) {
    throw gateError("Local Code Index must be available, fresh, and exact for release", "RELEASE_GATE_INDEX_INVALID");
  }
  return snapshotId;
}

function defaultSessionId(): string {
  return `gate-${new Date().toISOString().replace(/[^0-9]/g, "")}-${randomUUID()}`;
}

export async function runReleaseGateSession(input: Readonly<{
  sourceRoot: string;
  runtimeRoot: string;
  authority: ReleaseSigningAuthority;
  trust: ReleaseVerificationTrust;
  env?: NodeJS.ProcessEnv;
  sessionId?: string;
  execute?: GateExecutor;
  inspectIndex?: (sourceRoot: string, env: NodeJS.ProcessEnv) => Promise<string>;
  inspectCodeIndex?: CodeIndexInspector;
  now?: () => Date;
}>): Promise<Readonly<{
  ok: boolean;
  session: ReleaseGateSession;
  receipts: readonly WrittenReceipt[];
  report: Readonly<Record<string, unknown>> | null;
}>> {
  if (input.authority.keyId !== input.trust.keyId) {
    throw gateError("release signing authority does not match pinned verification trust", "RELEASE_GATE_RECEIPT_INVALID");
  }
  const sourceRoot = path.resolve(input.sourceRoot);
  const runtimeRoot = path.resolve(input.runtimeRoot);
  const childEnv = sanitizeReleaseGateChildEnv(input.env || process.env);
  const inspectIndex = input.inspectIndex || codeIndexSnapshotId;
  const execute = input.execute || executeReleaseGate;
  const now = input.now || (() => new Date());
  const indexSnapshotIdAtSessionStart = await inspectIndex(sourceRoot, childEnv);
  const session = await initializeReleaseGateSession({
    sourceRoot,
    runtimeRoot,
    sessionId: input.sessionId || defaultSessionId(),
  });
  childEnv.CPB_ROOT = runtimeRoot;
  childEnv.CPB_RELEASE_SOURCE_FINGERPRINT = session.source.releaseSourceFingerprint;
  childEnv.CPB_RELEASE_GATE_SESSION_ID = session.sessionId;
  const receipts: WrittenReceipt[] = [];
  let previousReceiptSha256: string | null = null;

  for (let index = 0; index < REQUIRED_RELEASE_GATES.length; index += 1) {
    const gate = REQUIRED_RELEASE_GATES[index];
    await verifyReleaseSourceFingerprint(session.source, { root: sourceRoot });
    process.stdout.write(`\nRelease gate ${index + 1}/${REQUIRED_RELEASE_GATES.length}: ${gate.id}\n`);
    const startedAt = now().toISOString();
    let result = await execute(gate, { cwd: sourceRoot, env: childEnv });
    let sourceUnchanged = true;
    try {
      await verifyReleaseSourceFingerprint(session.source, { root: sourceRoot });
    } catch (error) {
      sourceUnchanged = false;
      result = {
        exitCode: 1,
        stdout: result.stdout,
        stderr: Buffer.concat([
          result.stderr,
          Buffer.from(`RELEASE_SOURCE_CHANGED: ${error instanceof Error ? error.message : String(error)}\n`, "utf8"),
        ]),
      };
    }
    const finishedAt = now().toISOString();
    const written = await writeSignedReleaseGateReceipt({
      session,
      authority: input.authority,
      gate,
      sequence: index + 1,
      previousReceiptSha256,
      indexSnapshotIdAtSessionStart,
      startedAt,
      finishedAt,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      evidence: { sourceUnchanged },
    });
    receipts.push(written);
    previousReceiptSha256 = written.receiptSha256;
    process.stdout.write(`${result.exitCode === 0 ? PASS : FAIL} ${gate.id}\n`);
    if (result.exitCode !== 0) return { ok: false, session, receipts, report: null };
  }

  const indexSnapshotIdAtFinalCheck = await inspectIndex(sourceRoot, childEnv);
  await verifyReleaseSourceFingerprint(session.source, { root: sourceRoot });
  const externalEvidenceSha256 = await verifySignedExternalEvidenceSet({
    runtimeRoot,
    releaseSourceFingerprint: session.source.releaseSourceFingerprint,
    trust: input.trust,
    referenceTime: now(),
  });
  await writeSignedReleaseGateCompletion({
    session,
    authority: input.authority,
    indexSnapshotIdAtFinalCheck,
    receiptHashes: receipts.map((receipt) => receipt.receiptSha256),
    externalEvidenceSha256,
    completedAt: now().toISOString(),
  });
  const report = await verifyReleaseReadiness({
    sourceRoot,
    runtimeRoot,
    trust: input.trust,
    releaseSourceFingerprint: session.source.releaseSourceFingerprint,
    sessionId: session.sessionId,
    referenceTime: now(),
    inspectCodeIndex: input.inspectCodeIndex || ((root: string): Promise<CodeIndexStatus> => {
      // Reuse the session's inspectIndex to obtain the snapshot id, then wrap
      // it in a full CodeIndexStatus.  This mirrors the default production
      // path while remaining consistent with injected test mocks.
      return inspectIndex(root, childEnv).then((snapshotId) => ({
        available: true,
        fresh: true,
        exact: true,
        coverage: "symbol-level",
        ref: { snapshotId },
      }));
    }),
  });
  return { ok: report.ready === true, session, receipts, report };
}

async function main(): Promise<void> {
  if (process.env.CPB_CHECKLIST_DECOMPOSE === "0") {
    throw gateError("CPB_CHECKLIST_DECOMPOSE=0 is not allowed for the release gate", "RELEASE_GATE_POLICY_INVALID");
  }
  if (process.env.CPB_AGENT_ISOLATE_HOME === "0") {
    throw gateError("CPB_AGENT_ISOLATE_HOME=0 is not allowed for the release gate", "RELEASE_GATE_POLICY_INVALID");
  }
  const authority = createReleaseSigningAuthority({
    keyId: process.env.CPB_RELEASE_GATE_SIGNING_KEY_ID || "",
    privateKeyBase64Url: process.env.CPB_RELEASE_GATE_SIGNING_KEY || "",
  });
  const trust = createReleaseVerificationTrust({
    keyId: process.env.CPB_RELEASE_GATE_TRUSTED_KEY_ID || "",
    publicKeyBase64Url: process.env.CPB_RELEASE_GATE_TRUSTED_PUBLIC_KEY || "",
  });
  const runtimeRoot = path.resolve(process.env.CPB_ROOT || path.join(os.homedir(), ".cpb"));
  const result = await runReleaseGateSession({
    sourceRoot: REPO_ROOT,
    runtimeRoot,
    authority,
    trust,
  });
  process.stdout.write(`${JSON.stringify({
    ok: result.ok,
    sessionId: result.session.sessionId,
    releaseSourceFingerprint: result.session.source.releaseSourceFingerprint,
    receiptCount: result.receipts.length,
    report: result.report,
  }, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "RELEASE_GATE_FAILED";
    process.stderr.write(`${FAIL} ${code}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
