#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import type { LooseRecord } from "../shared/types.js";
import {
  controlPlaneAuditReferenceValid,
  stableJsonSha256,
  validateSweBenchBatchReport,
} from "./queue-swebench-batch.js";
import { verifyProductGateEvidenceFile } from "./verify-product-gate.js";

export type LiveReleaseEvidenceViolation = {
  path: string;
  reason: string;
};

export type VerifyLiveReleaseEvidenceOptions = {
  root?: string;
  evidenceFile?: string;
  productEvidenceFile?: string;
  referenceTime?: Date | string | number;
  maxLiveEvidenceAgeDays?: number;
  maxProductEvidenceAgeDays?: number;
  artifactPathRewrite?: ArtifactPathRewrite;
};

export type ArtifactPathRewrite = {
  from: string;
  to: string;
};

export type VerifyProviderConnectivityEvidenceOptions = {
  root?: string;
  referenceTime?: Date | string | number;
  maxLiveEvidenceAgeDays?: number;
  artifactPathRewrite?: ArtifactPathRewrite;
};

export const DEFAULT_LIVE_RELEASE_EVIDENCE_FILE = "docs/product/cpb-live-release-validation.json";
export const DEFAULT_PRODUCT_EVIDENCE_FILE = "docs/product/cpb-flagship-product-validation.json";
const LIVE_EVIDENCE_DIRECTORY = "docs/product/evidence/live-release";
const LIVE_EVIDENCE_RUNS_DIRECTORY = `${LIVE_EVIDENCE_DIRECTORY}/runs`;
const PROVIDER_CONNECTIVITY_BUNDLE_FILE = "provider-connectivity.json";
const DRAFT_PR_REHEARSAL_BUNDLE_FILE = "draft-pr-rehearsal.json";
const DEFAULT_MAX_LIVE_EVIDENCE_AGE_DAYS = 30;
const DEFAULT_MAX_PRODUCT_EVIDENCE_AGE_DAYS = 90;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REHEARSAL_BRANCH_PATTERN = /^cpb-release-rehearsal\/[A-Za-z0-9._-]+$/;
const PROVIDER_PREFLIGHT_GENERATOR = "scripts/queue-swebench-batch.ts#runSweBenchProviderPreflight";
const LIVE_HANDSHAKE_GENERATOR = "scripts/queue-swebench-batch.ts#liveProviderPreflightHandshake";
const DRAFT_PR_REHEARSAL_GENERATOR = "scripts/rehearse-disposable-draft-pr.ts#rehearseDisposableDraftPr";
const CODEGRAPH_CLEANUP_PROOF_GENERATOR = "runtime/worker/managed-worker.ts#stopAssignmentCodeGraphRuntime";
const REQUIRED_PROVIDER_ROUTES = [
  { phase: "plan", role: "planner", agentKey: "planner" },
  { phase: "execute", role: "executor", agentKey: "executor" },
  { phase: "verify", role: "verifier", agentKey: "verifier" },
  { phase: "adversarial_verify", role: "adversarial_verifier", agentKey: "adversarial_verifier" },
] as const;
const REQUIRED_COMPLETED_JOB_PHASES = [
  "prepare_task",
  "plan",
  "execute",
  "verify",
  "adversarial_verify",
] as const;
const REQUIRED_DENY_RULES = [
  "web_tool_denied",
  "read_only_mutation_denied",
  "broad_test_command_denied",
];
const PROVIDER_HANDSHAKE_EVIDENCE_FIELDS = new Set([
  "ok",
  "mode",
  "generator",
  "sentinelVerified",
  "phase",
  "role",
  "agent",
  "providerKey",
  "transport",
  "command",
  "projectId",
  "jobId",
  "correlationNonce",
  "controlPlaneEvidence",
  "controlPlaneEvidenceSha256",
  "controlPlaneAudit",
  "failureKind",
  "error",
]);
const CODEGRAPH_CLEANUP_PROOF_FIELDS = new Set([
  "assignmentId",
  "attempt",
  "attemptToken",
  "cleanupAttempt",
  "cleanupCompletedAt",
  "cleanupStartedAt",
  "cleanupVerified",
  "context",
  "entryId",
  "generator",
  "jobId",
  "ok",
  "orchestratorEpoch",
  "pid",
  "processPid",
  "processTreeStopped",
  "projectId",
  "startup",
  "startupSource",
  "statePath",
  "stateRemoved",
  "workerId",
  "worktreePath",
]);
const CODEGRAPH_CLEANUP_STARTUP_FIELDS = new Set(["ok", "pid", "processPid", "readyAt", "source", "startedAt", "statePath"]);

const REQUIRED_ACP_PREFLIGHT_DENY_TOOLS = [
  "fs/read_text_file",
  "fs/write_text_file",
  "terminal/create",
  "terminal/kill",
  "terminal/output",
  "terminal/release",
  "terminal/wait_for_exit",
];

const REQUIRED_CLAUDE_PREFLIGHT_DENY_TOOLS = [
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "NotebookEdit",
  "Read",
  "WebFetch",
  "WebSearch",
  "Write",
];

function isRecord(value: unknown): value is LooseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function sortedStringValues(value: unknown) {
  return arrayValue(value).map(String).sort();
}

function handshakeControlPlaneEvidenceValid(
  root: string,
  handshake: LooseRecord,
  phase: LooseRecord,
  artifactPathRewrite?: ArtifactPathRewrite,
) {
  if (!nonEmptyString(handshake.controlPlaneEvidenceSha256)) return false;
  if (handshake.controlPlaneEvidenceSha256 !== stableJsonSha256(handshake.controlPlaneEvidence)) return false;
  const proof = isRecord(handshake.controlPlaneEvidence) ? handshake.controlPlaneEvidence : null;
  if (!proof) return false;
  if (proof.transport !== phase.transport
    || proof.phase !== phase.phase
    || proof.role !== phase.role
    || proof.agent !== phase.agent
    || proof.providerKey !== phase.providerKey) {
    return false;
  }
  if (proof.agentLaunchObserved !== true
    || proof.sessionObserved !== true
    || proof.policyVerified !== true
    || Number(proof.toolCallCount) !== 0
    || Number(proof.terminalLaunchCount) !== 0) {
    return false;
  }
  const policy = isRecord(proof.policySummary) ? proof.policySummary : {};
  if (policy.terminalPolicy !== "deny" || policy.permissionRequests !== "reject" || policy.webToolsDisabled !== true) return false;
  const auditValid = controlPlaneAuditReferenceValid(handshake.controlPlaneAudit, proof, {
    phase: String(phase.phase),
    role: String(phase.role),
    agent: String(phase.agent),
    providerKey: String(phase.providerKey),
    transport: phase.transport as "acp" | "claude-cli",
    command: String(handshake.command || phase.command || ""),
    projectId: String(handshake.projectId || ""),
    jobId: String(handshake.jobId || ""),
    correlationNonce: String(handshake.correlationNonce || ""),
    outputPath: String(phase.outputPath || ""),
    outputBytes: Number(phase.outputBytes),
    outputSha256: String(phase.outputSha256 || ""),
    outputContent: handshake,
    artifactBaseDir: root,
    artifactPathRewrite,
  }).valid;
  if (phase.transport === "acp") {
    const deny = sortedStringValues(isRecord(policy.toolPolicy) ? policy.toolPolicy.deny : []);
    return REQUIRED_ACP_PREFLIGHT_DENY_TOOLS.every((tool) => deny.includes(tool))
      && auditValid;
  }
  if (phase.transport === "claude-cli") {
    const deny = sortedStringValues(
      isRecord(policy.settings)
        && isRecord(policy.settings.permissions)
        ? policy.settings.permissions.deny
        : [],
    );
    return sortedStringValues(policy.tools).length === 0
      && sortedStringValues(policy.mcpServers).length === 0
      && policy.slashCommandsDisabled === true
      && REQUIRED_CLAUDE_PREFLIGHT_DENY_TOOLS.every((tool) => deny.includes(tool))
      && auditValid;
  }
  return false;
}

function positiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function positiveSafeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    && new Date(parsed).toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z"));
}

function referenceTimeMs(referenceTime: Date | string | number) {
  if (referenceTime instanceof Date) return referenceTime.getTime();
  if (typeof referenceTime === "number") return referenceTime;
  return Date.parse(referenceTime);
}

function timestampViolations(
  value: unknown,
  pathName: string,
  referenceTime: Date | string | number,
  maxAgeDays: number,
) {
  const violations: LiveReleaseEvidenceViolation[] = [];
  if (!isIsoTimestamp(value)) {
    return [{ path: pathName, reason: "must be a valid ISO timestamp" }];
  }
  const referenceMs = referenceTimeMs(referenceTime);
  if (!Number.isFinite(referenceMs)) {
    return [{ path: "referenceTime", reason: "must be a valid timestamp" }];
  }
  const observedMs = Date.parse(value);
  if (observedMs > referenceMs + 5 * 60 * 1000) {
    violations.push({ path: pathName, reason: "must not be more than five minutes in the future" });
  }
  if (referenceMs - observedMs > maxAgeDays * 24 * 60 * 60 * 1000) {
    violations.push({ path: pathName, reason: `must be no older than ${maxAgeDays} days` });
  }
  return violations;
}

function sha256(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}

function sha256Buffer(raw: Buffer) {
  return createHash("sha256").update(raw).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableJsonEqual(left: unknown, right: unknown) {
  return stableJson(left) === stableJson(right);
}

function stableJsonBytes(value: unknown) {
  return Buffer.byteLength(stableJson(value), "utf8");
}

function repoRelativePath(root: string, value: unknown, pathName: string) {
  if (!nonEmptyString(value)) {
    return {
      violation: { path: pathName, reason: "must reference a repository-local JSON evidence file" },
      relative: null,
    };
  }
  const relative = value.trim().replaceAll("\\", "/");
  if (path.isAbsolute(relative) || relative.startsWith("../") || relative.includes("/../") || !relative.endsWith(".json")) {
    return {
      violation: { path: pathName, reason: "must reference a repository-local JSON evidence file" },
      relative: null,
    };
  }
  const resolved = path.resolve(root, relative);
  const back = path.relative(root, resolved);
  if (back.startsWith("..") || path.isAbsolute(back)) {
    return {
      violation: { path: pathName, reason: "must stay inside the repository root" },
      relative: null,
    };
  }
  return { violation: null, relative };
}

function artifactReference(value: unknown, pathName: string) {
  if (!nonEmptyString(value)) {
    return {
      violation: { path: pathName, reason: "must reference an auditable artifact file" },
      artifactPath: null,
      fragment: null,
    };
  }
  const raw = value.trim();
  const hashIndex = raw.indexOf("#");
  const artifactPath = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? null : raw.slice(hashIndex + 1);
  if (!nonEmptyString(artifactPath) || (hashIndex !== -1 && !nonEmptyString(fragment))) {
    return {
      violation: { path: pathName, reason: "must reference an auditable artifact file" },
      artifactPath: null,
      fragment: null,
    };
  }
  return { violation: null, artifactPath, fragment };
}

function rewriteArtifactPath(artifactPath: string, rewrite?: ArtifactPathRewrite) {
  if (!rewrite) return artifactPath;
  const normalized = artifactPath.replaceAll("\\", "/");
  const from = rewrite.from.replaceAll("\\", "/").replace(/\/+$/g, "");
  const to = rewrite.to.replaceAll("\\", "/").replace(/\/+$/g, "");
  if (!from || !to) return artifactPath;
  if (normalized === from) return to;
  if (normalized.startsWith(`${from}/`)) return `${to}${normalized.slice(from.length)}`;
  return artifactPath;
}

async function resolveBoundArtifactFile(
  root: string,
  artifactPath: string,
  pathName: string,
  rewrite?: ArtifactPathRewrite,
) {
  const rewrittenArtifactPath = rewriteArtifactPath(artifactPath, rewrite);
  const normalized = artifactPath.replaceAll("\\", "/");
  const rewrittenNormalized = rewrittenArtifactPath.replaceAll("\\", "/");
  const lexical = path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(root, normalized);
  const lexicalRelative = path.relative(path.resolve(root), lexical);
  if (lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) {
    return {
      violation: { path: pathName, reason: "must stay inside the live release evidence root" },
      realFile: null,
    };
  }
  const lexicalEvidenceRelative = lexicalRelative.replaceAll("\\", "/");
  if (!lexicalEvidenceRelative.startsWith(`${LIVE_EVIDENCE_DIRECTORY}/`)) {
    return {
      violation: { path: pathName, reason: `must be stored under ${LIVE_EVIDENCE_DIRECTORY}/` },
      realFile: null,
    };
  }
  if (normalized !== rewrittenNormalized && !lexicalEvidenceRelative.startsWith(`${LIVE_EVIDENCE_RUNS_DIRECTORY}/`)) {
    return {
      violation: { path: pathName, reason: `rewritten artifact paths must originate under ${LIVE_EVIDENCE_RUNS_DIRECTORY}` },
      realFile: null,
    };
  }
  const stagingLexical = path.isAbsolute(rewrittenNormalized)
    ? path.resolve(rewrittenNormalized)
    : path.resolve(root, rewrittenNormalized);
  const stagingRelative = path.relative(path.resolve(root), stagingLexical);
  if (stagingRelative.startsWith("..") || path.isAbsolute(stagingRelative)) {
    return {
      violation: { path: pathName, reason: "must stay inside the live release evidence root after artifact path rewrite" },
      realFile: null,
    };
  }
  const stagingEvidenceRelative = stagingRelative.replaceAll("\\", "/");
  if (!stagingEvidenceRelative.startsWith(`${LIVE_EVIDENCE_DIRECTORY}/`)) {
    return {
      violation: { path: pathName, reason: `must remain stored under ${LIVE_EVIDENCE_DIRECTORY}/ after artifact path rewrite` },
      realFile: null,
    };
  }
  try {
    const entry = await lstat(stagingLexical);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      return {
        violation: { path: pathName, reason: "must reference a non-symlink regular artifact file" },
        realFile: null,
      };
    }
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(stagingLexical)]);
    const realRelative = path.relative(realRoot, realFile);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      return {
        violation: { path: pathName, reason: "must not escape the live release evidence root through a symlink" },
        realFile: null,
      };
    }
    const realEvidenceRelative = realRelative.replaceAll("\\", "/");
    if (!realEvidenceRelative.startsWith(`${LIVE_EVIDENCE_DIRECTORY}/`)) {
      return {
        violation: { path: pathName, reason: "must not escape the live release evidence root through a symlink" },
        realFile: null,
      };
    }
    return { violation: null, realFile };
  } catch (error: unknown) {
    const code = isRecord(error) ? error.code : null;
    return {
      violation: {
        path: pathName,
        reason: code === "ENOENT" ? "referenced artifact does not exist" : "referenced artifact could not be read",
      },
      realFile: null,
    };
  }
}

function matchingFragmentValue(value: unknown, fragment: string): unknown {
  if (!isRecord(value)) return null;
  const candidates = [
    value.event,
    value.type,
    value.kind,
    value.name,
    isRecord(value.event) ? value.event.type : null,
    isRecord(value.event) ? value.event.kind : null,
    isRecord(value.payload) ? value.payload.event : null,
    isRecord(value.payload) ? value.payload.type : null,
    isRecord(value.payload) ? value.payload.kind : null,
  ];
  return candidates.includes(fragment) ? value : null;
}

function parseJsonOrJsonlFragment(raw: string, fragment: string) {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const direct = matchingFragmentValue(parsed, fragment);
    if (direct) return direct;
    if (Array.isArray(parsed)) {
      return parsed.find((item) => matchingFragmentValue(item, fragment)) || null;
    }
  } catch {
    // Fall through to JSONL parsing.
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      const matching = matchingFragmentValue(parsed, fragment);
      if (matching) return matching;
    } catch {
      // Ignore malformed non-matching lines; the fragment must be found below.
    }
  }
  return null;
}

async function artifactBindingViolations(
  root: string,
  artifactPathValue: unknown,
  bytesValue: unknown,
  shaValue: unknown,
  pathName: string,
  artifactPathRewrite?: ArtifactPathRewrite,
) {
  const violations: LiveReleaseEvidenceViolation[] = [];
  const ref = artifactReference(artifactPathValue, `${pathName}.path`);
  if (ref.violation || !ref.artifactPath) {
    if (ref.violation) violations.push(ref.violation);
    return violations;
  }
  const expectedBytes = Number(bytesValue);
  if (!Number.isFinite(expectedBytes) || expectedBytes <= 0) {
    violations.push({ path: `${pathName}.bytes`, reason: "must be a positive byte count" });
  }
  const expectedSha = nonEmptyString(shaValue) ? shaValue.trim() : "";
  if (!SHA256_PATTERN.test(expectedSha)) {
    violations.push({ path: `${pathName}.sha256`, reason: "must be a lowercase SHA-256 digest" });
  }
  const resolved = await resolveBoundArtifactFile(root, ref.artifactPath, `${pathName}.path`, artifactPathRewrite);
  if (resolved.violation || !resolved.realFile) {
    if (resolved.violation) violations.push(resolved.violation);
    return violations;
  }
  let raw: Buffer;
  try {
    raw = await readFile(resolved.realFile);
  } catch {
    violations.push({ path: `${pathName}.path`, reason: "referenced artifact could not be read" });
    return violations;
  }
  let actualBytes = raw.byteLength;
  let actualSha = sha256Buffer(raw);
  if (ref.fragment) {
    const fragmentValue = parseJsonOrJsonlFragment(raw.toString("utf8"), ref.fragment);
    if (fragmentValue === null) {
      violations.push({ path: `${pathName}.path`, reason: "referenced artifact fragment does not exist" });
      return violations;
    }
    actualBytes = stableJsonBytes(fragmentValue);
    actualSha = stableJsonSha256(fragmentValue);
  }
  if (Number.isFinite(expectedBytes) && expectedBytes > 0 && expectedBytes !== actualBytes) {
    violations.push({ path: `${pathName}.bytes`, reason: "does not match the referenced artifact" });
  }
  if (SHA256_PATTERN.test(expectedSha) && expectedSha !== actualSha) {
    violations.push({ path: `${pathName}.sha256`, reason: "does not match the referenced artifact" });
  }
  return violations;
}

async function readLocalJsonBundle(
  root: string,
  ref: unknown,
  expectedSha: unknown,
  pathName: string,
  { requiredPrefix }: { requiredPrefix?: string } = {},
) {
  const violations: LiveReleaseEvidenceViolation[] = [];
  const normalized = repoRelativePath(root, ref, `${pathName}.evidenceBundleRef`);
  if (normalized.violation || !normalized.relative) {
    if (normalized.violation) violations.push(normalized.violation);
    return { value: null, relative: null, canonicalRelative: null, realFile: null, sha256: null, violations };
  }
  if (requiredPrefix && !normalized.relative.startsWith(`${requiredPrefix}/`)) {
    violations.push({
      path: `${pathName}.evidenceBundleRef`,
      reason: `must be stored under ${requiredPrefix}/`,
    });
  }
  if (!nonEmptyString(expectedSha) || !SHA256_PATTERN.test(expectedSha.trim())) {
    violations.push({ path: `${pathName}.sha256`, reason: "must be a lowercase SHA-256 digest" });
  }

  const resolved = path.resolve(root, normalized.relative);
  let raw: string;
  try {
    const entry = await lstat(resolved);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      violations.push({ path: `${pathName}.evidenceBundleRef`, reason: "must reference a non-symlink regular evidence bundle file" });
      return { value: null, relative: normalized.relative, canonicalRelative: null, realFile: null, sha256: null, violations };
    }
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(resolved)]);
    const realRelative = path.relative(realRoot, realFile);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      violations.push({ path: `${pathName}.evidenceBundleRef`, reason: "must not escape the repository through a symlink" });
      return { value: null, relative: normalized.relative, canonicalRelative: null, realFile: null, sha256: null, violations };
    }
    const realEvidenceRelative = realRelative.replaceAll("\\", "/");
    if (requiredPrefix && !realEvidenceRelative.startsWith(`${requiredPrefix}/`)) {
      violations.push({
        path: `${pathName}.evidenceBundleRef`,
        reason: `must not escape ${requiredPrefix}/ through a symlink`,
      });
      return { value: null, relative: normalized.relative, canonicalRelative: realEvidenceRelative, realFile, sha256: null, violations };
    }
    raw = await readFile(realFile, "utf8");
    const actualSha = sha256(raw);
    if (nonEmptyString(expectedSha) && actualSha !== expectedSha.trim()) {
      violations.push({ path: `${pathName}.sha256`, reason: "does not match the referenced evidence bundle" });
    }
    try {
      return {
        value: JSON.parse(raw) as unknown,
        relative: normalized.relative,
        canonicalRelative: realEvidenceRelative,
        realFile,
        sha256: actualSha,
        violations,
      };
    } catch {
      violations.push({ path: `${pathName}.evidenceBundleRef`, reason: "referenced evidence bundle is not valid JSON" });
      return { value: null, relative: normalized.relative, canonicalRelative: realEvidenceRelative, realFile, sha256: actualSha, violations };
    }
  } catch (error: unknown) {
    const code = isRecord(error) ? error.code : null;
    violations.push({
      path: `${pathName}.evidenceBundleRef`,
      reason: code === "ENOENT" ? "referenced evidence bundle does not exist" : "referenced evidence bundle could not be read",
    });
    return { value: null, relative: normalized.relative, canonicalRelative: null, realFile: null, sha256: null, violations };
  }
}

function providerPreflightReport(bundle: unknown) {
  if (!isRecord(bundle)
    || bundle.schemaVersion !== 1
    || !isRecord(bundle.sourceManifest)
    || !isRecord(bundle.manifest)
    || !isRecord(bundle.manifest.providerPreflight)
    || !isRecord(bundle.summary)
    || !Array.isArray(bundle.jobs)
    || !isRecord(bundle.validation)) return null;
  return {
    report: bundle,
    sourceManifest: bundle.sourceManifest,
    manifest: bundle.manifest,
    summary: bundle.summary,
    preflight: bundle.manifest.providerPreflight,
  };
}

function testLikeChangedFile(filePath: string) {
  const normalized = filePath.replace(/\\/g, "/");
  return /(^|\/)tests?\//i.test(normalized)
    || /(^|\/)test_[^/]+\.py$/i.test(normalized)
    || /(^|\/)[^/]+\.test\.[cm]?[jt]sx?$/i.test(normalized)
    || /(^|\/)[^/]+\.spec\.[cm]?[jt]sx?$/i.test(normalized);
}

function fixtureLikePath(filePath: string) {
  return /(^|\/)(__snapshots__|snapshots?|fixtures?|fakes?|mocks?|testdata|golden)(\/|$)/i.test(filePath)
    || /\.(snap|snapshot)$/i.test(filePath);
}

function hasReleaseSourcePatchEvidence(job: LooseRecord) {
  const patch = isRecord(job.patch) ? job.patch : {};
  const changedFiles = arrayValue(patch.changedFiles)
    .map(String)
    .map((filePath) => filePath.trim())
    .filter(Boolean);
  const sourceChangedFiles = changedFiles.filter((filePath) => !testLikeChangedFile(filePath) && !fixtureLikePath(filePath));
  return nonEmptyString(patch.path)
    && SHA256_PATTERN.test(String(patch.sha256))
    && positiveNumber(patch.bytes)
    && Number(patch.changedFileCount) === changedFiles.length
    && sourceChangedFiles.length > 0;
}

function hasReleaseRegressionEvidence(job: LooseRecord) {
  const regressionEvidence = isRecord(job.regressionEvidence) ? job.regressionEvidence : {};
  const status = String(regressionEvidence.status || "");
  const commands = arrayValue(regressionEvidence.canonicalCommandsRun)
    .map(String)
    .filter(Boolean);
  return new Set(["present", "valid", "justified", "no-test-justified"]).has(status)
    && commands.length > 0;
}

async function completedJobPhaseEvidenceViolations(
  root: string,
  job: LooseRecord,
  jobPath: string,
  artifactPathRewrite?: ArtifactPathRewrite,
) {
  const violations: LiveReleaseEvidenceViolation[] = [];
  const phaseEvidence = isRecord(job.phaseEvidence) ? job.phaseEvidence : {};
  for (const phase of REQUIRED_COMPLETED_JOB_PHASES) {
    const evidence = isRecord(phaseEvidence[phase]) ? phaseEvidence[phase] : {};
    const phasePath = `${jobPath}.phaseEvidence.${phase}`;
    if (evidence.ok !== true) {
      violations.push({ path: phasePath, reason: "must record a successful completed phase" });
    }
    if (!nonEmptyString(evidence.structuredOutputPath)
      || !positiveNumber(evidence.structuredOutputBytes)
      || !SHA256_PATTERN.test(String(evidence.artifactSha256))) {
      violations.push({
        path: phasePath,
        reason: "must include an auditable structured output path, positive byte count, and SHA-256 digest",
      });
    }
    violations.push(...await artifactBindingViolations(
      root,
      evidence.structuredOutputPath,
      evidence.structuredOutputBytes,
      evidence.artifactSha256,
      `${phasePath}.structuredOutput`,
      artifactPathRewrite,
    ));
    if (nonEmptyString(evidence.failureKind)) {
      violations.push({ path: `${phasePath}.failureKind`, reason: "successful phase evidence must not retain a failure kind" });
    }
  }
  return violations;
}

function completedJobRetryViolations(job: LooseRecord, jobPath: string) {
  const violations: LiveReleaseEvidenceViolation[] = [];
  if (positiveNumber(job.retryCount)) {
    violations.push({ path: `${jobPath}.retryCount`, reason: "release evidence must come from a zero-retry completed job" });
  }
  if (arrayValue(job.retryFailureKinds).length > 0) {
    violations.push({ path: `${jobPath}.retryFailureKinds`, reason: "release evidence must not retain retry failure kinds" });
  }
  const phaseEvidence = isRecord(job.phaseEvidence) ? job.phaseEvidence : {};
  for (const [phase, value] of Object.entries(phaseEvidence)) {
    const evidence = isRecord(value) ? value : {};
    if (positiveNumber(evidence.retryCount)) {
      violations.push({
        path: `${jobPath}.phaseEvidence.${phase}.retryCount`,
        reason: "release evidence must come from a zero-retry completed phase",
      });
    }
    if (arrayValue(evidence.retryFailureKinds).length > 0) {
      violations.push({
        path: `${jobPath}.phaseEvidence.${phase}.retryFailureKinds`,
        reason: "release evidence must not retain retry failure kinds",
      });
    }
  }
  return violations;
}

function unexpectedKeys(value: LooseRecord, allowed: Set<string>) {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function orderedIsoTimestamps(...values: unknown[]) {
  const parsed = values.map((value) => isIsoTimestamp(value) ? Date.parse(String(value)) : NaN);
  return parsed.every(Number.isFinite)
    && parsed.every((value, index) => index === 0 || parsed[index - 1] <= value);
}

function completedJobCodeGraphCleanupViolations(job: LooseRecord, jobPath: string) {
  const violations: LiveReleaseEvidenceViolation[] = [];
  const proofPath = `${jobPath}.cleanup.codegraph`;
  const cleanup = isRecord(job.cleanup) ? job.cleanup : {};
  if (!isRecord(cleanup.codegraph)) {
    return [{ path: proofPath, reason: "must include closed CodeGraph cleanup proof" }];
  }
  const proof = cleanup.codegraph as LooseRecord;
  const startup = isRecord(proof.startup) ? proof.startup as LooseRecord : {};
  if (unexpectedKeys(proof, CODEGRAPH_CLEANUP_PROOF_FIELDS).length > 0
    || unexpectedKeys(startup, CODEGRAPH_CLEANUP_STARTUP_FIELDS).length > 0) {
    violations.push({ path: proofPath, reason: "must use a closed schema" });
  }
  if (proof.generator !== CODEGRAPH_CLEANUP_PROOF_GENERATOR) {
    violations.push({ path: `${proofPath}.generator`, reason: "must identify the managed worker cleanup generator" });
  }
  if (proof.ok !== true || proof.cleanupVerified !== true || proof.processTreeStopped !== true || proof.stateRemoved !== true) {
    violations.push({ path: proofPath, reason: "must prove cleanup, state removal, and process-tree stop" });
  }
  for (const field of ["attempt", "cleanupAttempt", "orchestratorEpoch", "pid", "processPid"]) {
    if (!positiveSafeInteger(proof[field])) {
      violations.push({ path: `${proofPath}.${field}`, reason: "must be a native positive safe integer" });
    }
  }
  for (const field of ["pid", "processPid"]) {
    if (!positiveSafeInteger(startup[field])) {
      violations.push({ path: `${proofPath}.startup.${field}`, reason: "must be a native positive safe integer" });
    }
  }
  // Runtime cleanup can recover with retries; release evidence requires first-cleanup success.
  if (proof.cleanupAttempt !== 1) {
    violations.push({ path: `${proofPath}.cleanupAttempt`, reason: "must be 1" });
  }
  if (proof.context !== "before_terminal_publication") {
    violations.push({ path: `${proofPath}.context`, reason: "must be before_terminal_publication" });
  }
  if (proof.assignmentId !== job.assignmentId || proof.jobId !== job.jobId) {
    violations.push({ path: proofPath, reason: "must match the representative job identity" });
  }
  if (startup.ok !== true
    || startup.source !== proof.startupSource
    || startup.pid !== proof.pid
    || startup.processPid !== proof.processPid
    || startup.statePath !== proof.statePath) {
    violations.push({ path: `${proofPath}.startup`, reason: "must match cleanup pid, process pid, state path, and source" });
  }
  if (!orderedIsoTimestamps(startup.startedAt, startup.readyAt, proof.cleanupStartedAt, proof.cleanupCompletedAt)) {
    violations.push({ path: proofPath, reason: "must have ordered ISO startup and cleanup timestamps" });
  }
  if (!nonEmptyString(proof.statePath) || !nonEmptyString(proof.worktreePath) || !nonEmptyString(startup.source)) {
    violations.push({ path: proofPath, reason: "must include startup readiness source, state path, and worktree path" });
  }
  return violations;
}

function assignmentIdFromSourceAssignment(assignment: unknown) {
  const record = isRecord(assignment) ? assignment : {};
  const queued = isRecord(record.queued) ? record.queued : {};
  return nonEmptyString(queued.assignmentId)
    ? queued.assignmentId
    : nonEmptyString(record.assignmentId)
      ? record.assignmentId
      : "";
}

function definedAuthorityValues(...values: unknown[]) {
  return values.filter((value) => value !== undefined);
}

function completedJobSourceIdentityViolations(
  job: LooseRecord,
  jobPath: string,
  assignment: LooseRecord | null,
  terminalState: LooseRecord | null,
) {
  const violations: LiveReleaseEvidenceViolation[] = [];
  const proofPath = `${jobPath}.cleanup.codegraph`;
  const cleanup = isRecord(job.cleanup) ? job.cleanup : {};
  if (!isRecord(cleanup.codegraph)) return violations;
  const proof = cleanup.codegraph as LooseRecord;
  const sourceAssignment = assignment || {};
  const queued = isRecord(sourceAssignment.queued) ? sourceAssignment.queued : {};
  const state = terminalState || {};
  const requireStringIdentity = (field: string, candidates: unknown[], reason: string) => {
    const present = definedAuthorityValues(...candidates);
    const invalid = present.filter((value) => !nonEmptyString(value));
    if (invalid.length > 0) {
      violations.push({ path: `${proofPath}.${field}`, reason: `all ${field} authority values must be non-empty strings` });
      return;
    }
    const expected = present[0];
    if (!nonEmptyString(expected)) {
      violations.push({ path: `${proofPath}.${field}`, reason: `must have an authoritative ${field} in source manifest or terminal state` });
      return;
    }
    if (present.some((value) => value !== expected)) {
      violations.push({ path: `${proofPath}.${field}`, reason: `all ${field} authority values must agree` });
    } else if (proof[field] !== expected) {
      violations.push({ path: `${proofPath}.${field}`, reason });
    }
  };
  const requireNumberIdentity = (field: string, candidates: unknown[], reason: string) => {
    const present = definedAuthorityValues(...candidates);
    const invalid = present.filter((value) => !positiveSafeInteger(value));
    if (invalid.length > 0) {
      violations.push({ path: `${proofPath}.${field}`, reason: `all ${field} authority values must be native positive safe integers` });
      return;
    }
    const expected = present[0];
    if (!positiveSafeInteger(expected)) {
      violations.push({ path: `${proofPath}.${field}`, reason: `must have an authoritative ${field} in source manifest or terminal state` });
      return;
    }
    if (present.some((value) => value !== expected)) {
      violations.push({ path: `${proofPath}.${field}`, reason: `all ${field} authority values must agree` });
    } else if (proof[field] !== expected) {
      violations.push({ path: `${proofPath}.${field}`, reason });
    }
  };

  requireStringIdentity("assignmentId", [queued.assignmentId, sourceAssignment.assignmentId, state.assignmentId, job.assignmentId], "must match source manifest assignment identity");
  const jobAttempts = isRecord(job.attempts) ? job.attempts : {};
  requireNumberIdentity("attempt", [queued.attempt, sourceAssignment.attempt, sourceAssignment.attempts, state.attempt, state.attempts, job.attempt, jobAttempts.count], "must match source manifest attempt identity");
  requireStringIdentity("attemptToken", [queued.attemptToken, sourceAssignment.attemptToken, state.attemptToken], "must match source manifest attempt token");
  requireStringIdentity("entryId", [sourceAssignment.entryId, queued.entryId, state.entryId], "must match source manifest entry identity");
  requireStringIdentity("projectId", [sourceAssignment.projectId, queued.projectId, state.projectId], "must match source manifest project identity");
  requireStringIdentity("jobId", [state.jobId, job.jobId], "must match terminal job identity");
  requireStringIdentity("workerId", [queued.workerId, sourceAssignment.workerId, state.workerId, job.workerId], "must match source manifest worker identity");
  requireNumberIdentity("orchestratorEpoch", [queued.orchestratorEpoch, sourceAssignment.orchestratorEpoch, state.orchestratorEpoch, job.orchestratorEpoch], "must match source manifest orchestrator epoch");
  return violations;
}

async function completedRepresentativeJobViolations(
  root: string,
  jobs: unknown[],
  expectedProviderPreflightPhases: unknown[],
  sourceAssignments: unknown[],
  sourceTerminalStates: unknown[],
  artifactPathRewrite?: ArtifactPathRewrite,
) {
  const violations: LiveReleaseEvidenceViolation[] = [];
  if (jobs.length !== 1) {
    violations.push({
      path: "providerConnectivity.jobs",
      reason: "must include exactly one representative provider job",
    });
  }
  const assignmentsById = new Map<string, LooseRecord>();
  for (const assignment of sourceAssignments) {
    const assignmentId = assignmentIdFromSourceAssignment(assignment);
    if (assignmentId) assignmentsById.set(assignmentId, isRecord(assignment) ? assignment : {});
  }
  const terminalStatesById = new Map<string, LooseRecord>();
  for (const terminalState of sourceTerminalStates) {
    if (isRecord(terminalState) && nonEmptyString(terminalState.assignmentId)) {
      terminalStatesById.set(terminalState.assignmentId, terminalState);
    }
  }
  let completedJobCount = 0;
  for (const [index, job] of jobs.entries()) {
    if (!isRecord(job)) continue;
    const jobPath = `providerConnectivity.jobs[${index}]`;
    const providerRoute = isRecord(job.providerRoute) ? job.providerRoute : {};
    const actualRoute = isRecord(providerRoute.actual) ? providerRoute.actual : {};
    if (!stableJsonEqual(arrayValue(actualRoute.preflight), expectedProviderPreflightPhases)) {
      violations.push({
        path: `${jobPath}.providerRoute.actual.preflight`,
        reason: "must exactly match manifest providerPreflight.phases",
      });
    }
    if (job.status !== "completed") {
      violations.push({
        path: `${jobPath}.status`,
        reason: "every representative provider job must complete",
      });
    } else {
      completedJobCount += 1;
    }
    if (nonEmptyString(job.failureKind)) {
      violations.push({
        path: `${jobPath}.failureKind`,
        reason: "release evidence must not retain a terminal failure kind",
      });
    }
    if (job.status !== "completed") continue;
    if (!hasReleaseSourcePatchEvidence(job)) {
      violations.push({
        path: `${jobPath}.patch`,
        reason: "must include a hash-bound patch with at least one non-test, non-fixture changed file",
      });
    }
    const patch = isRecord(job.patch) ? job.patch : {};
    violations.push(...await artifactBindingViolations(
      root,
      patch.path,
      patch.bytes,
      patch.sha256,
      `${jobPath}.patch`,
      artifactPathRewrite,
    ));
    if (!hasReleaseRegressionEvidence(job)) {
      violations.push({
        path: `${jobPath}.regressionEvidence`,
        reason: "must include accepted regression status and at least one canonical command",
      });
    }
    violations.push(...await completedJobPhaseEvidenceViolations(root, job, jobPath, artifactPathRewrite));
    violations.push(...completedJobRetryViolations(job, jobPath));
    violations.push(...completedJobCodeGraphCleanupViolations(job, jobPath));
    const assignmentId = nonEmptyString(job.assignmentId) ? job.assignmentId : "";
    violations.push(...completedJobSourceIdentityViolations(
      job,
      jobPath,
      assignmentId ? assignmentsById.get(assignmentId) || null : null,
      assignmentId ? terminalStatesById.get(assignmentId) || null : null,
    ));
  }
  if (completedJobCount !== 1) {
    violations.push({
      path: "providerConnectivity.jobs",
      reason: "must include exactly one completed representative provider job",
    });
  }
  return violations;
}

async function providerConnectivityViolations(
  root: string,
  bundle: unknown,
  referenceTime: Date | string | number,
  maxAgeDays: number,
  artifactPathRewrite?: ArtifactPathRewrite,
) {
  const violations: LiveReleaseEvidenceViolation[] = [];
  if (!isRecord(bundle) || !isRecord(bundle.manifest) || !isRecord(bundle.summary)) {
    return [{
      path: "providerConnectivity.evidenceBundleRef",
      reason: "must contain a complete SWE-bench report with embedded provider preflight evidence",
    }];
  }
  const source = providerPreflightReport(bundle);
  if (!source) {
    return [{
      path: "providerConnectivity.report",
      reason: "must contain the source manifest, jobs, and validation result for an auditable SWE-bench report",
    }];
  }
  const { report, sourceManifest, manifest, summary, preflight } = source;
  const embeddedValidation = isRecord(report.validation) ? report.validation : {};
  const sourceAssignments = arrayValue(sourceManifest.assignments);
  const sourceTerminalStates = arrayValue(sourceManifest.terminalStates);
  if (sourceManifest.providerPreflightMode !== "live") {
    violations.push({
      path: "providerConnectivity.sourceManifest.providerPreflightMode",
      reason: "must be live",
    });
  }
  if (!nonEmptyString(manifest.hash)
    || !SHA256_PATTERN.test(manifest.hash)
    || manifest.hash !== stableJsonSha256(sourceManifest)) {
    violations.push({ path: "providerConnectivity.manifest.hash", reason: "must bind the originating batch manifest" });
  }
  if (manifest.dataset !== "SWE-bench/SWE-bench_Verified"
    || manifest.split !== "test"
    || sourceManifest.dataset !== manifest.dataset
    || sourceManifest.split !== manifest.split) {
    violations.push({ path: "providerConnectivity.manifest", reason: "must identify the SWE-bench Verified test split" });
  }
  if (stableJsonSha256(manifest.agents) !== stableJsonSha256(sourceManifest.agents)
    || stableJsonSha256(preflight) !== stableJsonSha256(sourceManifest.providerPreflight)) {
    violations.push({ path: "providerConnectivity.manifest", reason: "must match the hash-bound source manifest routing" });
  }
  if (sourceAssignments.length === 0
    || arrayValue(report.jobs).length !== sourceAssignments.length
    || manifest.assignmentCount !== sourceAssignments.length
    || summary.totalJobs !== arrayValue(report.jobs).length
    || sourceTerminalStates.length !== sourceAssignments.length
    || summary.terminalJobs !== sourceAssignments.length) {
    violations.push({ path: "providerConnectivity.report", reason: "must contain a non-empty internally consistent batch job set" });
  }
  if (embeddedValidation.valid !== true || arrayValue(embeddedValidation.violations).length > 0) {
    violations.push({ path: "providerConnectivity.validation", reason: "embedded SWE-bench report validation must pass" });
  }
  const independentValidation = validateSweBenchBatchReport({
    manifest: sourceManifest,
    report,
    artifactBaseDir: root,
    artifactPathRewrite,
  });
  if (!independentValidation.valid) {
    violations.push({ path: "providerConnectivity.validation", reason: "independent SWE-bench report validation must pass" });
  }
  const workerCleanup = isRecord(sourceManifest.workerCleanup) ? sourceManifest.workerCleanup : {};
  if (workerCleanup.residualScanOk !== true || Number(workerCleanup.residualProcesses) !== 0 || Number(workerCleanup.forcedKills) !== 0) {
    violations.push({ path: "providerConnectivity.sourceManifest.workerCleanup", reason: "must prove residualScanOk=true, residualProcesses=0, and forcedKills=0" });
  }
  const sourcePreflight = isRecord(sourceManifest.providerPreflight) ? sourceManifest.providerPreflight : {};
  violations.push(...await completedRepresentativeJobViolations(
    root,
    arrayValue(report.jobs),
    arrayValue(sourcePreflight.phases),
    sourceAssignments,
    sourceTerminalStates,
    artifactPathRewrite,
  ));
  if (summary.providerPreflightOk !== true) {
    violations.push({ path: "providerConnectivity.summary.providerPreflightOk", reason: "must be true" });
  }
  violations.push(...timestampViolations(
    report.generatedAt,
    "providerConnectivity.report.generatedAt",
    referenceTime,
    maxAgeDays,
  ));
  if (preflight.schemaVersion !== 1) {
    violations.push({ path: "providerConnectivity.schemaVersion", reason: "must be 1" });
  }
  if (preflight.generator !== PROVIDER_PREFLIGHT_GENERATOR) {
    violations.push({ path: "providerConnectivity.generator", reason: "must identify the CPB provider preflight generator" });
  }
  if (preflight.ok !== true) {
    violations.push({ path: "providerConnectivity.ok", reason: "live provider preflight must pass" });
  }
  violations.push(...timestampViolations(
    preflight.generatedAt,
    "providerConnectivity.generatedAt",
    referenceTime,
    maxAgeDays,
  ));
  if (arrayValue(preflight.violations).length > 0) {
    violations.push({ path: "providerConnectivity.violations", reason: "must be empty" });
  }
  const phases = arrayValue(preflight.phases);
  if (phases.length !== REQUIRED_PROVIDER_ROUTES.length) {
    violations.push({ path: "providerConnectivity.phases", reason: "must contain exactly the four configured live provider routes" });
  }
  const agents = isRecord(manifest.agents) ? manifest.agents : {};
  for (const [index, value] of phases.entries()) {
    const phasePath = `providerConnectivity.phases[${index}]`;
    if (!isRecord(value)) {
      violations.push({ path: phasePath, reason: "must be an object" });
      continue;
    }
    if (!nonEmptyString(value.phase)
      || !nonEmptyString(value.role)
      || !nonEmptyString(value.agent)
      || !nonEmptyString(value.providerKey)
      || (value.transport !== "acp" && value.transport !== "claude-cli")
      || !nonEmptyString(value.command)
      || !nonEmptyString(value.outputPath)
      || !positiveNumber(value.outputBytes)
      || !nonEmptyString(value.outputSha256)
      || !SHA256_PATTERN.test(String(value.outputSha256))) {
      violations.push({ path: phasePath, reason: "must identify phase, role, agent, provider, command, and a bound structured output artifact" });
    }
    if (value.handshakeOk !== true || arrayValue(value.violations).length > 0) {
      violations.push({ path: phasePath, reason: "live provider handshake must pass without violations" });
    }
    const forbiddenEvidenceFields = ["args", "env", "stdout", "stderr", "stdoutTail", "stderrTail"];
    if (forbiddenEvidenceFields.some((field) => field in value)
      || Object.keys(value).some((field) => /^raw/i.test(field))) {
      violations.push({ path: phasePath, reason: "must not retain launch arguments, environment, raw output, or provider streams" });
    }
    violations.push(...await artifactBindingViolations(
      root,
      value.outputPath,
      value.outputBytes,
      value.outputSha256,
      `${phasePath}.output`,
      artifactPathRewrite,
    ));
    const handshake = isRecord(value.handshake) ? value.handshake : null;
    if (!handshake
      || handshake.ok !== true
      || handshake.mode !== "live"
      || handshake.generator !== LIVE_HANDSHAKE_GENERATOR
      || handshake.sentinelVerified !== true
      || !nonEmptyString(handshake.command)) {
      violations.push({ path: `${phasePath}.handshake`, reason: "must be successful live handshake evidence" });
    } else {
      if (handshake.command !== value.command
        || handshake.phase !== value.phase
        || handshake.role !== value.role
        || handshake.agent !== value.agent
        || handshake.providerKey !== value.providerKey
        || handshake.transport !== value.transport) {
        violations.push({ path: `${phasePath}.handshake`, reason: "must match its configured provider route" });
      }
      if (Object.keys(handshake).some((field) => !PROVIDER_HANDSHAKE_EVIDENCE_FIELDS.has(field))) {
        violations.push({
          path: `${phasePath}.handshake`,
          reason: "must not retain launch arguments, environment, raw output, or provider streams",
        });
      }
      if (!handshakeControlPlaneEvidenceValid(root, handshake, value, artifactPathRewrite)) {
        violations.push({
          path: `${phasePath}.handshake.controlPlaneEvidence`,
          reason: "must include hash-bound same-run launch/session policy proof with zero tool and terminal launches",
        });
      }
      const auditRef = isRecord(handshake.controlPlaneAudit) ? handshake.controlPlaneAudit : {};
      violations.push(...await artifactBindingViolations(
        root,
        auditRef.path,
        auditRef.bytes,
        auditRef.sha256,
        `${phasePath}.handshake.controlPlaneAudit`,
        artifactPathRewrite,
      ));
      violations.push(...await artifactBindingViolations(
        root,
        auditRef.rawPath,
        auditRef.rawBytes,
        auditRef.rawSha256,
        `${phasePath}.handshake.controlPlaneAudit.raw`,
        artifactPathRewrite,
      ));
    }
    const denyRules = arrayValue(value.denyRules).map(String);
    if (!REQUIRED_DENY_RULES.every((rule) => denyRules.includes(rule))) {
      violations.push({ path: `${phasePath}.denyRules`, reason: "must include all release safety deny rules" });
    }
  }
  for (const route of REQUIRED_PROVIDER_ROUTES) {
    const configuredAgent = agents[route.agentKey];
    const matching = phases.filter((value) => isRecord(value)
      && value.phase === route.phase
      && value.role === route.role
      && value.agent === configuredAgent);
    if (!nonEmptyString(configuredAgent) || matching.length !== 1) {
      violations.push({
        path: "providerConnectivity.phases",
        reason: `must contain exactly one configured ${route.phase}/${route.role} route`,
      });
    }
  }
  return violations;
}

function draftPrRehearsalViolations(bundle: unknown, referenceTime: Date | string | number, maxAgeDays: number) {
  const violations: LiveReleaseEvidenceViolation[] = [];
  if (!isRecord(bundle)) {
    return [{ path: "draftPrRehearsal.evidenceBundleRef", reason: "must contain draft-PR rehearsal evidence" }];
  }
  if (bundle.schemaVersion !== 1) violations.push({ path: "draftPrRehearsal.schemaVersion", reason: "must be 1" });
  if (bundle.generator !== DRAFT_PR_REHEARSAL_GENERATOR) {
    violations.push({ path: "draftPrRehearsal.generator", reason: "must identify the disposable rehearsal generator" });
  }
  if (bundle.ok !== true) violations.push({ path: "draftPrRehearsal.ok", reason: "live draft-PR rehearsal must pass" });
  if (bundle.mode !== "live") violations.push({ path: "draftPrRehearsal.mode", reason: "must be live" });
  violations.push(...timestampViolations(
    bundle.generatedAt,
    "draftPrRehearsal.generatedAt",
    referenceTime,
    maxAgeDays,
  ));
  if (arrayValue(bundle.violations).length > 0) {
    violations.push({ path: "draftPrRehearsal.violations", reason: "must be empty" });
  }

  const target = isRecord(bundle.target) ? bundle.target : {};
  if (!nonEmptyString(target.repository)) {
    violations.push({ path: "draftPrRehearsal.target.repository", reason: "must identify owner/repository" });
  }
  if (target.disposable !== true || target.markerVerified !== true) {
    violations.push({
      path: "draftPrRehearsal.target",
      reason: "must be an explicitly marked and verified disposable target",
    });
  }
  if (!nonEmptyString(target.repositoryId)) {
    violations.push({ path: "draftPrRehearsal.target.repositoryId", reason: "must identify the verified target repository" });
  }
  if (target.markerPath !== ".cpb-disposable-target.json"
    || !nonEmptyString(target.markerSha)
    || !/^[0-9a-f]{40}$/i.test(target.markerSha)) {
    violations.push({ path: "draftPrRehearsal.target.markerSha", reason: "must bind the disposable marker blob" });
  }
  if (!nonEmptyString(bundle.branch) || !REHEARSAL_BRANCH_PATTERN.test(bundle.branch.trim())) {
    violations.push({ path: "draftPrRehearsal.branch", reason: "must use the cpb-release-rehearsal/ namespace" });
  }

  const pullRequest = isRecord(bundle.pullRequest) ? bundle.pullRequest : {};
  if (!Number.isInteger(pullRequest.number) || Number(pullRequest.number) <= 0) {
    violations.push({ path: "draftPrRehearsal.pullRequest.number", reason: "must be a positive integer" });
  }
  if (!nonEmptyString(pullRequest.url) || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(pullRequest.url.trim())) {
    violations.push({ path: "draftPrRehearsal.pullRequest.url", reason: "must be a GitHub pull request URL" });
  } else if (nonEmptyString(target.repository) && !pullRequest.url.includes(`github.com/${target.repository.trim()}/pull/`)) {
    violations.push({ path: "draftPrRehearsal.pullRequest.url", reason: "must belong to the disposable target repository" });
  }
  if (pullRequest.draft !== true || pullRequest.state !== "closed") {
    violations.push({ path: "draftPrRehearsal.pullRequest", reason: "must prove a draft PR was created and then closed" });
  }

  const cleanup = isRecord(bundle.cleanup) ? bundle.cleanup : {};
  if (cleanup.pullRequestClosed !== true || cleanup.branchDeleted !== true) {
    violations.push({ path: "draftPrRehearsal.cleanup", reason: "must prove PR closure and rehearsal branch deletion" });
  }

  const operations = arrayValue(bundle.operations);
  const expectedOperationNames = [
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
  ];
  const operationNames = operations.map((operation) => isRecord(operation) ? operation.name : null);
  if (operationNames.length !== expectedOperationNames.length
    || operationNames.some((name, index) => name !== expectedOperationNames[index])) {
    violations.push({
      path: "draftPrRehearsal.operations",
      reason: "must contain the complete ordered disposable rehearsal verification sequence",
    });
    return violations;
  }

  const [originOp, authOp, repositoryOp, markerOp, branchOp, payloadOp, createOp, readOp, closeOp, deleteOp]
    = operations.map((operation) => isRecord(operation) ? operation : {});
  const repository = nonEmptyString(target.repository) ? target.repository.trim() : "";
  const branch = nonEmptyString(bundle.branch) ? bundle.branch.trim() : "";
  const prNumber = Number(pullRequest.number);
  const prUrl = nonEmptyString(pullRequest.url) ? pullRequest.url.trim() : "";
  if (originOp.targetRepository !== repository || originOp.repository === repository || originOp.different !== true) {
    violations.push({ path: "draftPrRehearsal.operations[0]", reason: "must prove target differs from origin" });
  }
  if (authOp.authenticated !== true) {
    violations.push({ path: "draftPrRehearsal.operations[1]", reason: "must prove GitHub authentication preflight passed" });
  }
  if (repositoryOp.repository !== repository
    || repositoryOp.repositoryId !== target.repositoryId
    || repositoryOp.baseBranch !== target.baseBranch) {
    violations.push({ path: "draftPrRehearsal.operations[2]", reason: "must match verified target metadata" });
  }
  if (markerOp.repository !== repository
    || markerOp.baseBranch !== target.baseBranch
    || markerOp.path !== target.markerPath
    || markerOp.sha !== target.markerSha
    || markerOp.purpose !== "codepatchbay-release-rehearsal") {
    violations.push({ path: "draftPrRehearsal.operations[3]", reason: "must match the disposable marker version" });
  }
  if (branchOp.repository !== repository
    || branchOp.branch !== branch
    || !nonEmptyString(branchOp.baseSha)
    || !/^[0-9a-f]{40}$/i.test(branchOp.baseSha)) {
    violations.push({ path: "draftPrRehearsal.operations[4]", reason: "must bind the created rehearsal branch" });
  }
  if (payloadOp.repository !== repository
    || payloadOp.branch !== branch
    || !nonEmptyString(payloadOp.path)
    || !payloadOp.path.startsWith(".cpb-release-rehearsals/")
    || !nonEmptyString(payloadOp.sha)
    || !/^[0-9a-f]{40}$/i.test(payloadOp.sha)) {
    violations.push({ path: "draftPrRehearsal.operations[5]", reason: "must bind the rehearsal-only payload" });
  }
  for (const [index, operation] of [[6, createOp], [7, readOp]] as const) {
    if (operation.repository !== repository
      || operation.branch !== branch
      || operation.number !== prNumber
      || operation.url !== prUrl
      || operation.draft !== true
      || operation.state !== "open") {
      violations.push({ path: `draftPrRehearsal.operations[${index}]`, reason: "must match the verified draft PR" });
    }
  }
  if (closeOp.repository !== repository || closeOp.number !== prNumber || closeOp.state !== "closed") {
    violations.push({ path: "draftPrRehearsal.operations[8]", reason: "must prove the draft PR was closed" });
  }
  if (deleteOp.repository !== repository || deleteOp.branch !== branch || deleteOp.deleted !== true) {
    violations.push({ path: "draftPrRehearsal.operations[9]", reason: "must prove the rehearsal branch was deleted" });
  }
  return violations;
}

function evidenceEntry(manifest: LooseRecord, key: string, violations: LiveReleaseEvidenceViolation[]) {
  const value = manifest[key];
  if (!isRecord(value)) {
    violations.push({ path: key, reason: "must be an evidence reference object" });
    return {};
  }
  return value;
}

function liveRunBundleReferenceViolations(
  providerRelative: string | null,
  draftRelative: string | null,
  providerCanonicalRelative: string | null,
  draftCanonicalRelative: string | null,
) {
  const violations: LiveReleaseEvidenceViolation[] = [];
  const parse = (value: string | null, pathName: string, expectedFile: string) => {
    if (!value) {
      violations.push({ path: pathName, reason: "must reference a canonical live-release run bundle" });
      return null;
    }
    const parts = value.split("/");
    const expectedPrefix = LIVE_EVIDENCE_RUNS_DIRECTORY.split("/");
    if (parts.length !== expectedPrefix.length + 2
      || expectedPrefix.some((part, index) => parts[index] !== part)
      || parts[parts.length - 1] !== expectedFile
      || !/^[A-Za-z0-9._-]+$/.test(parts[parts.length - 2])) {
      violations.push({
        path: pathName,
        reason: `must be ${LIVE_EVIDENCE_RUNS_DIRECTORY}/<run-id>/${expectedFile}`,
      });
      return null;
    }
    return {
      runId: parts[parts.length - 2],
      relative: value,
    };
  };
  const provider = parse(providerRelative, "providerConnectivity.evidenceBundleRef", PROVIDER_CONNECTIVITY_BUNDLE_FILE);
  const draft = parse(draftRelative, "draftPrRehearsal.evidenceBundleRef", DRAFT_PR_REHEARSAL_BUNDLE_FILE);
  if (provider && draft && provider.runId !== draft.runId) {
    violations.push({
      path: "draftPrRehearsal.evidenceBundleRef",
      reason: "must be in the same canonical live-release run directory as providerConnectivity",
    });
  }
  if (provider && providerCanonicalRelative !== provider.relative) {
    violations.push({
      path: "providerConnectivity.evidenceBundleRef",
      reason: "must resolve to its exact canonical live-release run bundle without symlink aliasing",
    });
  }
  if (draft && draftCanonicalRelative !== draft.relative) {
    violations.push({
      path: "draftPrRehearsal.evidenceBundleRef",
      reason: "must resolve to its exact canonical live-release run bundle without symlink aliasing",
    });
  }
  return violations;
}

export async function verifyLiveReleaseEvidence(
  evidence: unknown,
  {
    root = process.cwd(),
    productEvidenceFile = DEFAULT_PRODUCT_EVIDENCE_FILE,
    referenceTime = new Date(),
    maxLiveEvidenceAgeDays = DEFAULT_MAX_LIVE_EVIDENCE_AGE_DAYS,
    maxProductEvidenceAgeDays = DEFAULT_MAX_PRODUCT_EVIDENCE_AGE_DAYS,
    artifactPathRewrite,
  }: VerifyLiveReleaseEvidenceOptions = {},
) {
  const violations: LiveReleaseEvidenceViolation[] = [];
  if (!isRecord(evidence)) {
    return { ok: false, violations: [{ path: "$", reason: "must be a JSON object" }] };
  }
  if (evidence.schemaVersion !== 1) violations.push({ path: "schemaVersion", reason: "must be 1" });
  violations.push(...timestampViolations(
    evidence.generatedAt,
    "generatedAt",
    referenceTime,
    maxLiveEvidenceAgeDays,
  ));

  const providerEntry = evidenceEntry(evidence, "providerConnectivity", violations);
  const draftEntry = evidenceEntry(evidence, "draftPrRehearsal", violations);
  const productEntry = evidenceEntry(evidence, "productEvidence", violations);
  const [providerBundle, draftBundle, productBundle] = await Promise.all([
    readLocalJsonBundle(root, providerEntry.evidenceBundleRef, providerEntry.sha256, "providerConnectivity", {
      requiredPrefix: LIVE_EVIDENCE_DIRECTORY,
    }),
    readLocalJsonBundle(root, draftEntry.evidenceBundleRef, draftEntry.sha256, "draftPrRehearsal", {
      requiredPrefix: LIVE_EVIDENCE_DIRECTORY,
    }),
    readLocalJsonBundle(root, productEntry.evidenceBundleRef, productEntry.sha256, "productEvidence"),
  ]);
  violations.push(...providerBundle.violations, ...draftBundle.violations, ...productBundle.violations);
  violations.push(...liveRunBundleReferenceViolations(
    providerBundle.relative,
    draftBundle.relative,
    providerBundle.canonicalRelative,
    draftBundle.canonicalRelative,
  ));

  if (productBundle.relative !== productEvidenceFile) {
    violations.push({
      path: "productEvidence.evidenceBundleRef",
      reason: `must reference ${productEvidenceFile}`,
    });
  }
  violations.push(...(await verifyProviderConnectivityEvidence(providerBundle.value, {
    root,
    referenceTime,
    maxLiveEvidenceAgeDays,
    artifactPathRewrite,
  })).violations);
  violations.push(...draftPrRehearsalViolations(draftBundle.value, referenceTime, maxLiveEvidenceAgeDays));

  let productGate = {
    ok: false,
    recordCount: 0,
    supplementalOfficialScoreBundleCount: 0,
    violations: [] as Array<{ path: string; reason: string }>,
  };
  if (productBundle.value !== null) {
    productGate = await verifyProductGateEvidenceFile(productBundle.value, {
      root,
      referenceTime,
      maxEvidenceAgeDays: maxProductEvidenceAgeDays,
    });
    if (!productGate.ok) {
      violations.push(...productGate.violations.map((violation) => ({
        path: `productEvidence.${violation.path}`,
        reason: violation.reason,
      })));
    }
    if (productGate.recordCount < 3) {
      violations.push({ path: "productEvidence.recordCount", reason: "must contain at least 3 representative records" });
    }
    if (productGate.supplementalOfficialScoreBundleCount < 1) {
      violations.push({
        path: "productEvidence.supplementalOfficialScoreBundles",
        reason: "must contain at least one validated official scorer bundle",
      });
    }
  }

  return {
    ok: violations.length === 0,
    providerEvidenceFile: providerBundle.relative,
    draftPrEvidenceFile: draftBundle.relative,
    productEvidenceFile: productBundle.relative,
    productRecordCount: productGate.recordCount,
    officialScoreBundleCount: productGate.supplementalOfficialScoreBundleCount,
    violations,
  };
}

export async function verifyProviderConnectivityEvidence(
  bundle: unknown,
  {
    root = process.cwd(),
    referenceTime = new Date(),
    maxLiveEvidenceAgeDays = DEFAULT_MAX_LIVE_EVIDENCE_AGE_DAYS,
    artifactPathRewrite,
  }: VerifyProviderConnectivityEvidenceOptions = {},
) {
  const violations = await providerConnectivityViolations(
    root,
    bundle,
    referenceTime,
    maxLiveEvidenceAgeDays,
    artifactPathRewrite,
  );
  return {
    ok: violations.length === 0,
    violations,
  };
}

export async function verifyLiveReleaseEvidenceFile({
  root = process.cwd(),
  evidenceFile = DEFAULT_LIVE_RELEASE_EVIDENCE_FILE,
  ...options
}: VerifyLiveReleaseEvidenceOptions = {}) {
  const normalizedEvidenceFile = nonEmptyString(evidenceFile) ? evidenceFile.trim().replaceAll("\\", "/") : "";
  if (!normalizedEvidenceFile
    || path.isAbsolute(normalizedEvidenceFile)
    || normalizedEvidenceFile.startsWith("../")
    || normalizedEvidenceFile.includes("/../")
    || !normalizedEvidenceFile.endsWith(".json")) {
    return {
      ok: false,
      evidenceFile,
      missingEvidence: false,
      violations: [{
        path: evidenceFile,
        reason: "live release evidence file must be a repository-local JSON path",
      }],
    };
  }
  const resolved = path.resolve(root, normalizedEvidenceFile);
  const lexicalRelative = path.relative(path.resolve(root), resolved);
  if (lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) {
    return {
      ok: false,
      evidenceFile,
      missingEvidence: false,
      violations: [{
        path: evidenceFile,
        reason: "live release evidence file must stay inside the repository root",
      }],
    };
  }
  let raw: string;
  try {
    const entry = await lstat(resolved);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      return {
        ok: false,
        evidenceFile,
        missingEvidence: false,
        violations: [{
          path: evidenceFile,
          reason: "live release evidence file must be a non-symlink regular file",
        }],
      };
    }
    const [realRoot, realEvidence] = await Promise.all([realpath(root), realpath(resolved)]);
    const realRelative = path.relative(realRoot, realEvidence);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      return {
        ok: false,
        evidenceFile,
        missingEvidence: false,
        violations: [{
          path: evidenceFile,
          reason: "live release evidence file must not escape the repository through a symlink",
        }],
      };
    }
    raw = await readFile(realEvidence, "utf8");
  } catch (error: unknown) {
    const missing = isRecord(error) && error.code === "ENOENT";
    return {
      ok: false,
      evidenceFile,
      missingEvidence: missing,
      violations: [{
        path: evidenceFile,
        reason: missing ? "missing live release validation evidence file" : "live release evidence file could not be read",
      }],
    };
  }
  let evidence: unknown;
  try {
    evidence = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      evidenceFile,
      missingEvidence: false,
      violations: [{ path: evidenceFile, reason: "live release evidence file is not valid JSON" }],
    };
  }
  const result = await verifyLiveReleaseEvidence(evidence, { root, ...options });
  return { ...result, evidenceFile, missingEvidence: false };
}

async function main() {
  const evidenceFile = process.argv[2] || DEFAULT_LIVE_RELEASE_EVIDENCE_FILE;
  const result = await verifyLiveReleaseEvidenceFile({ evidenceFile });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
