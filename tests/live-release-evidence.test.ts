import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildSweBenchBatchReport, stableJsonSha256, validateSweBenchBatchReport } from "../scripts/queue-swebench-batch.js";
import { verifyLiveReleaseEvidenceFile, verifyProviderConnectivityEvidence } from "../scripts/verify-live-release-evidence.js";
import { tempRoot, writeJson } from "./helpers.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const referenceTime = "2026-07-20T12:00:00.000Z";
const productFiles = [
  "docs/product/cpb-flagship-product-validation.json",
  "docs/product/evidence/swe-bench-verified-django-13128-dry-run.json",
  "docs/product/evidence/swe-bench-verified-matplotlib-13989-dry-run.json",
  "docs/product/evidence/swe-bench-verified-flask-5014-dry-run.json",
  "docs/product/evidence/swe-bench-real-runs/verified-5-codex-runtime-official-score.json",
  "docs/product/evidence/swe-bench-real-runs/verified-5-codex-runtime-official-score-artifacts/aggregate-report.json",
  "docs/product/evidence/swe-bench-real-runs/verified-5-codex-runtime-official-score-artifacts/official-score-summary.json",
  "docs/product/evidence/swe-bench-real-runs/verified-5-codex-runtime-official-score-artifacts/prediction.jsonl",
  "docs/product/evidence/swe-bench-real-runs/verified-5-codex-runtime-official-score-artifacts/source-patch-manifest.json",
  "docs/product/evidence/swe-bench-real-runs/verified-5-codex-runtime-official-score-artifacts/patches/django__django-13343.patch",
  "docs/product/evidence/swe-bench-real-runs/verified-5-codex-runtime-official-score-artifacts/patches/django__django-13346.patch",
  "docs/product/evidence/swe-bench-real-runs/verified-5-codex-runtime-official-score-artifacts/patches/django__django-13363.patch",
  "docs/product/evidence/swe-bench-real-runs/verified-5-codex-runtime-official-score-artifacts/patches/django__django-13401.patch",
];

function digest(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}

function digestBuffer(raw: Buffer) {
  return createHash("sha256").update(raw).digest("hex");
}

function controlPlaneEvidence(phase: string, role: string, transport: "acp" | "claude-cli" = "acp") {
  const evidence = {
    transport,
    phase,
    role,
    agent: "codex",
    providerKey: "codex",
    agentLaunchObserved: true,
    sessionObserved: true,
    policyVerified: true,
    toolCallCount: 0,
    terminalLaunchCount: 0,
    policySummary: {
      terminalPolicy: "deny",
      permissionRequests: "reject",
      webToolsDisabled: true,
      toolPolicy: {
        allow: [],
        deny: [
          "fs/read_text_file",
          "fs/write_text_file",
          "terminal/create",
          "terminal/kill",
          "terminal/output",
          "terminal/release",
          "terminal/wait_for_exit",
        ],
      },
    },
  };
  return {
    controlPlaneEvidence: evidence,
    controlPlaneEvidenceSha256: stableJsonSha256(evidence),
  };
}

function controlPlaneAuditRef(phase: string, role: string, summary: unknown, outputPath: string) {
  const dir = path.join(path.dirname(outputPath), "control-plane-audit");
  const file = path.join(dir, `${phase}.json`);
  const rawFile = path.join(dir, `${phase}.raw.jsonl`);
  const projectId = "cpb-provider-live-preflight";
  const correlationNonce = "c".repeat(32);
  const jobId = `provider-preflight-${role}-codex-${correlationNonce}`;
  const summaryRecord = summary as Record<string, unknown>;
  const rawLines = [
    JSON.stringify({
      ts: "2026-07-20T10:00:00.000Z",
      event: "agent_launch",
      agent: "codex",
      phase,
      role,
      projectId,
      jobId,
      correlationNonce,
      mcpServers: [],
      mcpServerNames: [],
      livePreflightPolicy: summaryRecord.policySummary,
    }),
    JSON.stringify({ ts: "2026-07-20T10:00:01.000Z", event: "session_new", agent: "codex", phase, role, projectId, jobId, correlationNonce, sessionId: `session-${phase}` }),
  ];
  const raw = `${rawLines.join("\n")}\n`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(rawFile, raw, "utf8");
  const rawBuffer = readFileSync(rawFile);
  const artifact = {
    schemaVersion: 1,
    generator: "scripts/queue-swebench-batch.ts#controlPlaneAuditArtifact",
    generatedAt: "2026-07-20T10:00:02.000Z",
    nonce: correlationNonce,
    jobIdentity: {
      projectId,
      jobId,
      correlationNonce,
      outputPathSha256: digest(outputPath),
      promptSha256: digest(["CPB provider live preflight.", "Do not call tools. Do not inspect files. Reply exactly with: CPB_PROVIDER_PREFLIGHT_OK"].join("\n")),
      sentinelSha256: digest("CPB_PROVIDER_PREFLIGHT_OK"),
    },
    route: {
      phase,
      role,
      agent: "codex",
      providerKey: "codex",
      transport: "acp",
      command: "codex-acp",
    },
    rawStream: {
      path: path.basename(rawFile),
      bytes: rawBuffer.byteLength,
      sha256: digestBuffer(rawBuffer),
      eventCount: rawLines.length,
    },
    events: [
      {
        index: 0,
        ts: "2026-07-20T10:00:00.000Z",
        event: "agent_launch",
        kind: "launch",
        agent: "codex",
        phase,
        role,
        projectId,
        jobId,
        correlationNonce,
        policySummary: summaryRecord.policySummary,
      },
      {
        index: 1,
        ts: "2026-07-20T10:00:01.000Z",
        event: "session_new",
        kind: "session",
        agent: "codex",
        phase,
        role,
        projectId,
        jobId,
        correlationNonce,
        sessionHash: digest(`session-${phase}`),
      },
    ],
    summary,
    summarySha256: stableJsonSha256(summary),
  };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  const buffer = readFileSync(file);
  return {
    path: file,
    bytes: buffer.byteLength,
    sha256: digestBuffer(buffer),
    rawPath: rawFile,
    rawBytes: rawBuffer.byteLength,
    rawSha256: digestBuffer(rawBuffer),
    summarySha256: stableJsonSha256(summary),
  };
}

function codeGraphCleanupProof({
  assignmentId = "assignment-provider-preflight",
  attempt = 1,
  attemptToken = "attempt-token-provider-preflight",
  entryId = "provider-preflight",
  projectId = "proj-provider-preflight",
  jobId = "job-provider-preflight",
  workerId = "w-live-release",
  orchestratorEpoch = 1,
  cleanupAttempt = 1,
}: {
  assignmentId?: string;
  attempt?: number;
  attemptToken?: string;
  entryId?: string;
  projectId?: string;
  jobId?: string;
  workerId?: string;
  orchestratorEpoch?: number;
  cleanupAttempt?: number;
} = {}) {
  return {
    generator: "runtime/worker/managed-worker.ts#stopAssignmentCodeGraphRuntime",
    assignmentId,
    attempt,
    attemptToken,
    entryId,
    projectId,
    jobId,
    workerId,
    orchestratorEpoch,
    context: "before_terminal_publication",
    cleanupAttempt,
    ok: true,
    cleanupVerified: true,
    processTreeStopped: true,
    stateRemoved: true,
    statePath: `/tmp/${assignmentId}/.codegraph/daemon.pid`,
    worktreePath: `/tmp/${assignmentId}`,
    startup: {
      ok: true,
      source: "fake_codegraph_daemon",
      pid: 12345,
      processPid: 12345,
      statePath: `/tmp/${assignmentId}/.codegraph/daemon.pid`,
      startedAt: "2026-07-20T10:00:00.000Z",
      readyAt: "2026-07-20T10:00:01.000Z",
    },
    startupSource: "fake_codegraph_daemon",
    pid: 12345,
    processPid: 12345,
    cleanupStartedAt: "2026-07-20T10:00:02.000Z",
    cleanupCompletedAt: "2026-07-20T10:00:03.000Z",
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableJsonBytes(value: unknown) {
  return Buffer.byteLength(stableJson(value), "utf8");
}

function stableJsonDigest(value: unknown) {
  return digest(stableJson(value));
}

async function copyProductEvidence(root: string) {
  for (const relative of productFiles) {
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(repoRoot, relative), destination);
  }
}

async function writeBundle(root: string, relative: string, value: unknown) {
  const file = path.join(root, relative);
  await writeJson(file, value);
  const raw = await readFile(file, "utf8");
  return digest(raw);
}

async function writeRawArtifact(root: string, relative: string, raw: string) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, raw, "utf8");
  const buffer = await readFile(file);
  return {
    path: relative,
    bytes: buffer.byteLength,
    sha256: digestBuffer(buffer),
  };
}

async function bindProviderArtifacts(root: string, provider: Record<string, unknown>) {
  async function bindPreflightAuditRefs(preflight: unknown, label: string) {
    const phases = Array.isArray((preflight as Record<string, unknown> | undefined)?.phases)
      ? (preflight as { phases: Array<Record<string, unknown>> }).phases
      : [];
    for (const [phaseIndex, phase] of phases.entries()) {
      const handshake = phase.handshake as Record<string, unknown> | undefined;
      const audit = handshake?.controlPlaneAudit as Record<string, unknown> | undefined;
      if (!audit || typeof audit.path !== "string") continue;
      if (audit.path.startsWith("docs/product/evidence/live-release/")
        && typeof phase.outputPath === "string"
        && phase.outputPath.startsWith("docs/product/evidence/live-release/")) continue;
      assert.ok(handshake);
      assert.equal(typeof phase.outputPath, "string");
      assert.equal(typeof audit.rawPath, "string");
      const sourceOutput = path.isAbsolute(String(phase.outputPath))
        ? String(phase.outputPath)
        : path.join(root, String(phase.outputPath));
      const sourceAudit = path.isAbsolute(audit.path) ? audit.path : path.join(root, audit.path);
      const sourceRaw = path.isAbsolute(String(audit.rawPath))
        ? String(audit.rawPath)
        : path.join(root, String(audit.rawPath));
      await writeJson(sourceOutput, handshake);
      const retainedOutput = JSON.parse(await readFile(sourceOutput, "utf8"));
      assert.equal(stableJson(retainedOutput), stableJson(handshake));
      const outputRelative = `docs/product/evidence/live-release/provider-artifacts/preflight/${label}-${phaseIndex}.json`;
      const auditRelative = `docs/product/evidence/live-release/provider-artifacts/control-plane/${label}-${phaseIndex}.json`;
      const rawRelative = `docs/product/evidence/live-release/provider-artifacts/control-plane/${label}-${phaseIndex}.raw.jsonl`;
      const outputDestination = path.join(root, outputRelative);
      const auditDestination = path.join(root, auditRelative);
      const rawDestination = path.join(root, rawRelative);
      await mkdir(path.dirname(outputDestination), { recursive: true });
      await mkdir(path.dirname(auditDestination), { recursive: true });
      await copyFile(sourceRaw, rawDestination);
      const rawBuffer = await readFile(rawDestination);
      const artifact = JSON.parse(await readFile(sourceAudit, "utf8")) as Record<string, unknown>;
      const jobIdentity = artifact.jobIdentity as Record<string, unknown>;
      const rawStream = artifact.rawStream as Record<string, unknown>;
      jobIdentity.outputPathSha256 = digest(outputRelative);
      rawStream.path = path.basename(rawRelative);
      rawStream.bytes = rawBuffer.byteLength;
      rawStream.sha256 = digestBuffer(rawBuffer);
      await writeJson(auditDestination, artifact);
      const auditBuffer = await readFile(auditDestination);
      Object.assign(audit, {
        path: auditRelative,
        bytes: auditBuffer.byteLength,
        sha256: digestBuffer(auditBuffer),
        rawPath: rawRelative,
        rawBytes: rawBuffer.byteLength,
        rawSha256: digestBuffer(rawBuffer),
      });
      phase.outputPath = outputRelative;
      await writeJson(outputDestination, handshake);
      const outputBuffer = await readFile(outputDestination);
      phase.outputBytes = outputBuffer.byteLength;
      phase.outputSha256 = digestBuffer(outputBuffer);
    }
  }
  const sourceManifest = provider.sourceManifest as Record<string, unknown> | undefined;
  await bindPreflightAuditRefs(sourceManifest?.providerPreflight, "source");
  const canonicalPreflight = structuredClone(sourceManifest?.providerPreflight);
  const manifest = provider.manifest as Record<string, unknown> | undefined;
  if (manifest && canonicalPreflight !== undefined) {
    manifest.providerPreflight = structuredClone(canonicalPreflight);
    manifest.hash = stableJsonDigest(sourceManifest);
  }
  if (!Array.isArray(provider.jobs)) return;
  for (const jobValue of provider.jobs) {
    if (jobValue === null || typeof jobValue !== "object") continue;
    const job = jobValue as Record<string, unknown>;
    const actual = (job.providerRoute as Record<string, Record<string, unknown>> | undefined)?.actual;
    if (actual && canonicalPreflight !== undefined) {
      actual.preflight = structuredClone((canonicalPreflight as { phases?: unknown[] }).phases || []);
    }
  }
  for (const [jobIndex, jobValue] of provider.jobs.entries()) {
    if (jobValue === null || typeof jobValue !== "object") continue;
    const job = jobValue as Record<string, unknown>;
    const phaseEvidence = job.phaseEvidence as Record<string, Record<string, unknown>> | undefined;
    if (phaseEvidence && typeof phaseEvidence === "object") {
      for (const [phase, evidence] of Object.entries(phaseEvidence)) {
        if (!evidence || typeof evidence !== "object") continue;
        const relative = `docs/product/evidence/live-release/provider-artifacts/job-${jobIndex}/${phase}.json`;
        if (phase === "prepare_task") {
          const event = {
            event: "riskmap_generated",
            assignmentId: job.assignmentId || `job-${jobIndex}`,
            ok: true,
          };
          await writeJson(path.join(root, relative), event);
          evidence.structuredOutputPath = `${relative}#riskmap_generated`;
          evidence.structuredOutputBytes = stableJsonBytes(event);
          evidence.artifactSha256 = stableJsonDigest(event);
        } else {
          const raw = `${JSON.stringify({ phase, ok: true, assignmentId: job.assignmentId || `job-${jobIndex}` })}\n`;
          const artifact = await writeRawArtifact(root, relative, raw);
          evidence.structuredOutputPath = artifact.path;
          evidence.structuredOutputBytes = artifact.bytes;
          evidence.artifactSha256 = artifact.sha256;
        }
      }
    }
    const patch = job.patch as Record<string, unknown> | undefined;
    if (patch && typeof patch === "object") {
      const relative = `docs/product/evidence/live-release/provider-artifacts/job-${jobIndex}/source.patch`;
      const raw = [
        "diff --git a/django/db/models/expressions.py b/django/db/models/expressions.py",
        "--- a/django/db/models/expressions.py",
        "+++ b/django/db/models/expressions.py",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n");
      const artifact = await writeRawArtifact(root, relative, raw);
      patch.path = artifact.path;
      patch.bytes = artifact.bytes;
      patch.sha256 = artifact.sha256;
    }
  }
  provider.validation = validateSweBenchBatchReport({
    manifest: provider.sourceManifest,
    report: provider,
    artifactBaseDir: root,
  });
}

function validProviderEvidence() {
  const agents = {
    planner: "codex",
    executor: "codex",
    verifier: "codex",
    adversarial_verifier: "codex",
  };
  const routes = [
    ["plan", "planner"],
    ["execute", "executor"],
    ["verify", "verifier"],
    ["adversarial_verify", "adversarial_verifier"],
  ];
  const providerPreflight = {
    schemaVersion: 1,
    generator: "scripts/queue-swebench-batch.ts#runSweBenchProviderPreflight",
    generatedAt: "2026-07-20T10:00:00.000Z",
    ok: true,
    violations: [],
    phases: routes.map(([phase, role]) => {
      const proof = controlPlaneEvidence(phase, role);
      const artifactRoot = mkdtempSync(path.join(os.tmpdir(), "cpb-live-release-preflight-"));
      const outputPath = path.join(artifactRoot, `${phase}.json`);
      const handshake = {
        ok: true,
        mode: "live",
        generator: "scripts/queue-swebench-batch.ts#liveProviderPreflightHandshake",
        sentinelVerified: true,
        phase,
        role,
        agent: "codex",
        providerKey: "codex",
        transport: "acp",
        command: "codex-acp",
        projectId: "cpb-provider-live-preflight",
        jobId: `provider-preflight-${role}-codex-${"c".repeat(32)}`,
        correlationNonce: "c".repeat(32),
        ...proof,
        controlPlaneAudit: controlPlaneAuditRef(phase, role, proof.controlPlaneEvidence, outputPath),
      };
      writeFileSync(outputPath, `${JSON.stringify(handshake, null, 2)}\n`, "utf8");
      const outputBuffer = readFileSync(outputPath);
      return {
        phase,
        role,
        agent: "codex",
        providerKey: "codex",
        transport: "acp",
        command: "codex-acp",
        outputPath,
        outputBytes: outputBuffer.byteLength,
        outputSha256: digestBuffer(outputBuffer),
        denyRules: ["web_tool_denied", "read_only_mutation_denied", "broad_test_command_denied"],
        handshakeOk: true,
        handshake,
        violations: [],
      };
    }),
  };
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-20T10:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    providerPreflightMode: "live",
    agents,
    providerPreflight,
    workerCleanup: {
      workerCleanupEvents: 1,
      forcedKills: 0,
      residualProcesses: 0,
      residualScanOk: true,
      residualScanFailures: [],
      reasons: ["batch_wait_completed"],
      workerIds: ["w-live-release"],
      pids: [12345],
    },
    assignments: [{
      entryId: "provider-preflight",
      projectId: "proj-provider-preflight",
      workerId: "w-live-release",
      record: {
        benchmarkInstanceId: "django__django-13128",
        representativeRepository: "django/django",
        baseCommit: "2d67222472f80f251607ae1b720527afceba06ad",
        datasetRowRef: "https://datasets-server.huggingface.co/rows?dataset=SWE-bench%2FSWE-bench_Verified&config=default&split=test&offset=0&length=1",
      },
      queued: {
        assignmentId: "assignment-provider-preflight",
        attempt: 1,
        attemptToken: "attempt-token-provider-preflight",
        orchestratorEpoch: 1,
      },
    }],
    terminalStates: [{
      assignmentId: "assignment-provider-preflight",
      status: "completed",
      attempt: 1,
      jobId: "job-provider-preflight",
      workerId: "w-live-release",
      orchestratorEpoch: 1,
    }],
  };
  return buildSweBenchBatchReport({
    manifest,
    evidenceByAssignmentId: {
      "assignment-provider-preflight": {
        phaseEvidence: {
          prepare_task: {
            ok: true,
            toolEvents: 1,
            structuredOutputBytes: 192,
            structuredOutputPath: "/tmp/cpb-live-release/prepare-task.json",
            artifactSha256: "4".repeat(64),
            retryCount: 0,
            retryFailureKinds: [],
          },
          plan: {
            ok: true,
            durationMs: 1000,
            structuredOutputBytes: 384,
            structuredOutputPath: "/tmp/cpb-live-release/plan.json",
            artifactSha256: "0".repeat(64),
            retryCount: 0,
            retryFailureKinds: [],
          },
          execute: {
            ok: true,
            durationMs: 1200,
            structuredOutputBytes: 512,
            structuredOutputPath: "/tmp/cpb-live-release/execute.json",
            artifactSha256: "1".repeat(64),
            retryCount: 0,
            retryFailureKinds: [],
          },
          verify: {
            ok: true,
            durationMs: 900,
            structuredOutputBytes: 256,
            structuredOutputPath: "/tmp/cpb-live-release/verify.json",
            artifactSha256: "2".repeat(64),
            retryCount: 0,
            retryFailureKinds: [],
          },
          adversarial_verify: {
            ok: true,
            durationMs: 1100,
            structuredOutputBytes: 320,
            structuredOutputPath: "/tmp/cpb-live-release/adversarial-verify.json",
            artifactSha256: "5".repeat(64),
            retryCount: 0,
            retryFailureKinds: [],
          },
        },
        patch: {
          path: "/tmp/cpb-live-release/django__django-13128.patch",
          sha256: "3".repeat(64),
          bytes: 2048,
          changedFiles: ["django/db/models/expressions.py"],
          changedFileCount: 1,
          applyStatus: "applied",
        },
        regressionEvidence: {
          status: "present",
          canonicalCommandsRun: ["python tests/runtests.py expressions.tests.FTimeDeltaTests.test_date_subtraction"],
          canonicalCommandsMissing: [],
        },
        cleanup: {
          codegraph: codeGraphCleanupProof(),
        },
        jobId: "job-provider-preflight",
      },
    },
    generatedAt: "2026-07-20T10:00:00.000Z",
  });
}

function validDraftPrEvidence() {
  return {
    schemaVersion: 1,
    generator: "scripts/rehearse-disposable-draft-pr.ts#rehearseDisposableDraftPr",
    generatedAt: "2026-07-20T10:05:00.000Z",
    ok: true,
    mode: "live",
    target: {
      repository: "cpb-validation/disposable-release-target",
      repositoryId: "R_42",
      baseBranch: "main",
      disposable: true,
      markerVerified: true,
      markerPath: ".cpb-disposable-target.json",
      markerSha: "b".repeat(40),
    },
    branch: "cpb-release-rehearsal/20260720T100500Z",
    pullRequest: {
      number: 17,
      url: "https://github.com/cpb-validation/disposable-release-target/pull/17",
      draft: true,
      state: "closed",
    },
    cleanup: {
      pullRequestClosed: true,
      branchDeleted: true,
    },
    operations: [
      { name: "origin.verify", repository: "source/repo", targetRepository: "cpb-validation/disposable-release-target", different: true },
      { name: "github.auth.verify", authenticated: true },
      { name: "repository.verify", repository: "cpb-validation/disposable-release-target", repositoryId: "R_42", baseBranch: "main" },
      { name: "marker.verify", repository: "cpb-validation/disposable-release-target", baseBranch: "main", path: ".cpb-disposable-target.json", sha: "b".repeat(40), purpose: "codepatchbay-release-rehearsal" },
      { name: "branch.create.verify", repository: "cpb-validation/disposable-release-target", branch: "cpb-release-rehearsal/20260720T100500Z", baseSha: "c".repeat(40) },
      { name: "payload.write.verify", repository: "cpb-validation/disposable-release-target", branch: "cpb-release-rehearsal/20260720T100500Z", path: ".cpb-release-rehearsals/20260720T100500Z.json", sha: "d".repeat(40) },
      { name: "pull_request.create.verify", repository: "cpb-validation/disposable-release-target", branch: "cpb-release-rehearsal/20260720T100500Z", baseBranch: "main", number: 17, url: "https://github.com/cpb-validation/disposable-release-target/pull/17", draft: true, state: "open" },
      { name: "pull_request.read.verify", repository: "cpb-validation/disposable-release-target", branch: "cpb-release-rehearsal/20260720T100500Z", number: 17, url: "https://github.com/cpb-validation/disposable-release-target/pull/17", draft: true, state: "open" },
      { name: "pull_request.close.verify", repository: "cpb-validation/disposable-release-target", number: 17, state: "closed" },
      { name: "branch.delete.verify", repository: "cpb-validation/disposable-release-target", branch: "cpb-release-rehearsal/20260720T100500Z", deleted: true },
    ],
    violations: [],
  };
}

type LiveReleaseEvidenceOptions = {
  provider?: Record<string, unknown>;
  draftPr?: Record<string, unknown>;
  generatedAt?: string;
};

async function writeValidEvidence(root: string, {
  provider = validProviderEvidence(),
  draftPr = validDraftPrEvidence(),
  generatedAt = "2026-07-20T10:10:00.000Z",
}: LiveReleaseEvidenceOptions = {}) {
  await copyProductEvidence(root);
  await bindProviderArtifacts(root, provider);
  const runId = "20260720T101000Z";
  const providerRef = `docs/product/evidence/live-release/runs/${runId}/provider-connectivity.json`;
  const draftRef = `docs/product/evidence/live-release/runs/${runId}/draft-pr-rehearsal.json`;
  const productRef = "docs/product/cpb-flagship-product-validation.json";
  const providerSha = await writeBundle(root, providerRef, provider);
  const draftSha = await writeBundle(root, draftRef, draftPr);
  const productSha = digest(await readFile(path.join(root, productRef), "utf8"));
  await writeJson(path.join(root, "docs/product/cpb-live-release-validation.json"), {
    schemaVersion: 1,
    generatedAt,
    providerConnectivity: { evidenceBundleRef: providerRef, sha256: providerSha },
    draftPrRehearsal: { evidenceBundleRef: draftRef, sha256: draftSha },
    productEvidence: { evidenceBundleRef: productRef, sha256: productSha },
  });
}

async function rewriteProviderEvidence(root: string, mutate: (provider: Record<string, unknown>) => Promise<void> | void) {
  const providerRef = "docs/product/evidence/live-release/runs/20260720T101000Z/provider-connectivity.json";
  const manifestFile = path.join(root, "docs/product/cpb-live-release-validation.json");
  const providerFile = path.join(root, providerRef);
  const provider = JSON.parse(await readFile(providerFile, "utf8")) as Record<string, unknown>;
  await mutate(provider);
  const providerSha = await writeBundle(root, providerRef, provider);
  const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as Record<string, Record<string, unknown>>;
  manifest.providerConnectivity.sha256 = providerSha;
  await writeJson(manifestFile, manifest);
}

test("live release evidence accepts fresh hashed provider, disposable draft PR, and product bundles", async () => {
  const root = await tempRoot("cpb-live-release-valid");
  await writeValidEvidence(root);

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, true);
  assert.equal(result.productRecordCount, 3);
  assert.equal(result.officialScoreBundleCount, 1);
  assert.deepEqual(result.violations, []);
});

test("exported provider connectivity helper shares final verifier rules and preserves rewrite fail-closed order", async () => {
  const root = await tempRoot("cpb-live-release-provider-helper");
  await writeValidEvidence(root);
  const providerFile = path.join(root, "docs/product/evidence/live-release/runs/20260720T101000Z/provider-connectivity.json");
  const provider = JSON.parse(await readFile(providerFile, "utf8"));

  const accepted = await verifyProviderConnectivityEvidence(provider, { root, referenceTime });
  assert.equal(accepted.ok, true);

  const forged = structuredClone(provider);
  const phase = ((forged.manifest as Record<string, unknown>).providerPreflight as { phases: Array<Record<string, unknown>> }).phases[0];
  phase.outputPath = "scripts/forged-provider-output.json";
  const rejected = await verifyProviderConnectivityEvidence(forged, {
    root,
    referenceTime,
    artifactPathRewrite: {
      from: "scripts",
      to: "docs/product/evidence/live-release/provider-artifacts/preflight",
    },
  });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.violations.some((item) => item.path === "providerConnectivity.phases[0].output.path"
    && /docs\/product\/evidence\/live-release/.test(item.reason)));
});

test("live release evidence rejects noncanonical or cross-run provider and draft bundle references", async () => {
  const noncanonicalRoot = await tempRoot("cpb-live-release-noncanonical-bundle");
  await writeValidEvidence(noncanonicalRoot);
  const noncanonicalManifestFile = path.join(noncanonicalRoot, "docs/product/cpb-live-release-validation.json");
  const noncanonicalManifest = JSON.parse(await readFile(noncanonicalManifestFile, "utf8"));
  const providerRef = String(noncanonicalManifest.providerConnectivity.evidenceBundleRef);
  const oldProviderRef = "docs/product/evidence/live-release/provider-preflight.json";
  await copyFile(path.join(noncanonicalRoot, providerRef), path.join(noncanonicalRoot, oldProviderRef));
  noncanonicalManifest.providerConnectivity.evidenceBundleRef = oldProviderRef;
  noncanonicalManifest.providerConnectivity.sha256 = digest(await readFile(path.join(noncanonicalRoot, oldProviderRef), "utf8"));
  await writeJson(noncanonicalManifestFile, noncanonicalManifest);

  const noncanonical = await verifyLiveReleaseEvidenceFile({ root: noncanonicalRoot, referenceTime });
  assert.equal(noncanonical.ok, false);
  assert.ok(noncanonical.violations.some((item) => item.path === "providerConnectivity.evidenceBundleRef"
    && /runs\/<run-id>\/provider-connectivity\.json/.test(item.reason)));

  const crossRunRoot = await tempRoot("cpb-live-release-cross-run-bundle");
  await writeValidEvidence(crossRunRoot);
  const crossRunManifestFile = path.join(crossRunRoot, "docs/product/cpb-live-release-validation.json");
  const crossRunManifest = JSON.parse(await readFile(crossRunManifestFile, "utf8"));
  const draftRef = String(crossRunManifest.draftPrRehearsal.evidenceBundleRef);
  const crossRunDraftRef = "docs/product/evidence/live-release/runs/other-run/draft-pr-rehearsal.json";
  await mkdir(path.dirname(path.join(crossRunRoot, crossRunDraftRef)), { recursive: true });
  await copyFile(path.join(crossRunRoot, draftRef), path.join(crossRunRoot, crossRunDraftRef));
  crossRunManifest.draftPrRehearsal.evidenceBundleRef = crossRunDraftRef;
  crossRunManifest.draftPrRehearsal.sha256 = digest(await readFile(path.join(crossRunRoot, crossRunDraftRef), "utf8"));
  await writeJson(crossRunManifestFile, crossRunManifest);

  const crossRun = await verifyLiveReleaseEvidenceFile({ root: crossRunRoot, referenceTime });
  assert.equal(crossRun.ok, false);
  assert.ok(crossRun.violations.some((item) => item.path === "draftPrRehearsal.evidenceBundleRef"
    && /same canonical live-release run directory/.test(item.reason)));
});

test("live release evidence rejects CodeGraph cleanup proof identity drift from source manifest authority", async () => {
  const identityMutations = [
    { field: "assignmentId", value: "other-assignment", pattern: /assignment identity|source manifest assignment identity/ },
    { field: "attempt", value: 2, pattern: /attempt identity|source manifest attempt identity/ },
    { field: "attemptToken", value: "other-token", pattern: /attempt token|source manifest attempt token/ },
    { field: "entryId", value: "other-entry", pattern: /entry identity|source manifest entry identity/ },
    { field: "projectId", value: "other-project", pattern: /project identity|source manifest project identity/ },
    { field: "jobId", value: "other-job", pattern: /job identity|terminal job identity/ },
    { field: "workerId", value: "other-worker", pattern: /worker identity|source manifest worker identity/ },
    { field: "orchestratorEpoch", value: 2, pattern: /orchestrator epoch|source manifest orchestrator epoch/ },
  ] as const;

  for (const mutation of identityMutations) {
    const root = await tempRoot(`cpb-live-release-cleanup-${mutation.field}`);
    const provider = validProviderEvidence();
    ((provider.jobs[0] as Record<string, Record<string, unknown>>).cleanup.codegraph as Record<string, unknown>)[mutation.field] = mutation.value;
    await writeValidEvidence(root, { provider });

    const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

    assert.equal(result.ok, false, mutation.field);
    assert.match(result.violations.map((item) => item.reason).join("\n"), mutation.pattern, mutation.field);
  }
});

test("live release evidence rejects non-native numeric CodeGraph cleanup identities", async () => {
  const numericMutations = [
    { field: "attempt", value: "1", path: "providerConnectivity.jobs[0].cleanup.codegraph.attempt" },
    { field: "cleanupAttempt", value: "1", path: "providerConnectivity.jobs[0].cleanup.codegraph.cleanupAttempt" },
    { field: "orchestratorEpoch", value: "1", path: "providerConnectivity.jobs[0].cleanup.codegraph.orchestratorEpoch" },
    { field: "pid", value: "12345", path: "providerConnectivity.jobs[0].cleanup.codegraph.pid" },
    { field: "processPid", value: 0, path: "providerConnectivity.jobs[0].cleanup.codegraph.processPid" },
    { field: "startup.pid", value: "12345", path: "providerConnectivity.jobs[0].cleanup.codegraph.startup.pid" },
    { field: "startup.processPid", value: null, path: "providerConnectivity.jobs[0].cleanup.codegraph.startup.processPid" },
  ] as const;

  for (const mutation of numericMutations) {
    const root = await tempRoot(`cpb-live-release-cleanup-number-${mutation.field.replace(".", "-")}`);
    const provider = validProviderEvidence();
    const proof = ((provider.jobs[0] as Record<string, Record<string, unknown>>).cleanup.codegraph as Record<string, unknown>);
    if (mutation.field.startsWith("startup.")) {
      (proof.startup as Record<string, unknown>)[mutation.field.split(".")[1]] = mutation.value;
    } else {
      proof[mutation.field] = mutation.value;
    }
    await writeValidEvidence(root, { provider });

    const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

    assert.equal(result.ok, false, mutation.field);
    assert.ok(result.violations.some((item) => item.path === mutation.path), mutation.field);
  }
});

test("live release evidence rejects invalid or conflicting numeric authority values", async () => {
  const invalidRoot = await tempRoot("cpb-live-release-authority-string-attempt");
  const invalidProvider = validProviderEvidence();
  const invalidSourceManifest = invalidProvider.sourceManifest as Record<string, unknown>;
  (((invalidSourceManifest.assignments as Array<Record<string, unknown>>)[0]).queued as Record<string, unknown>).attempt = null;
  await writeValidEvidence(invalidRoot, { provider: invalidProvider });

  const invalid = await verifyLiveReleaseEvidenceFile({ root: invalidRoot, referenceTime });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.violations.some((item) => item.path === "providerConnectivity.jobs[0].cleanup.codegraph.attempt"
    && /authority values must be native positive safe integers/.test(item.reason)));

  const jobCountRoot = await tempRoot("cpb-live-release-authority-job-attempt-count");
  const jobCountProvider = validProviderEvidence();
  (jobCountProvider.jobs[0] as Record<string, unknown>).attempts = { count: 2 };
  await writeValidEvidence(jobCountRoot, { provider: jobCountProvider });

  const jobCount = await verifyLiveReleaseEvidenceFile({ root: jobCountRoot, referenceTime });
  assert.equal(jobCount.ok, false);
  assert.ok(jobCount.violations.some((item) => item.path === "providerConnectivity.jobs[0].cleanup.codegraph.attempt"
    && /authority values must agree/.test(item.reason)));

  const conflictRoot = await tempRoot("cpb-live-release-authority-conflict-epoch");
  const conflictProvider = validProviderEvidence();
  const conflictSourceManifest = conflictProvider.sourceManifest as Record<string, unknown>;
  (((conflictSourceManifest.assignments as Array<Record<string, unknown>>)[0]).queued as Record<string, unknown>).orchestratorEpoch = 1;
  ((conflictSourceManifest.terminalStates as Array<Record<string, unknown>>)[0]).orchestratorEpoch = 2;
  await writeValidEvidence(conflictRoot, { provider: conflictProvider });

  const conflict = await verifyLiveReleaseEvidenceFile({ root: conflictRoot, referenceTime });
  assert.equal(conflict.ok, false);
  assert.ok(conflict.violations.some((item) => item.path === "providerConnectivity.jobs[0].cleanup.codegraph.orchestratorEpoch"
    && /authority values must agree/.test(item.reason)));
});

test("live release evidence fails closed when cleanup proof lacks source epoch authority", async () => {
  const root = await tempRoot("cpb-live-release-cleanup-missing-epoch");
  const provider = validProviderEvidence();
  const sourceManifest = provider.sourceManifest as Record<string, unknown>;
  const assignment = (sourceManifest.assignments as Array<Record<string, unknown>>)[0];
  delete (assignment.queued as Record<string, unknown>).orchestratorEpoch;
  delete assignment.orchestratorEpoch;
  delete ((sourceManifest.terminalStates as Array<Record<string, unknown>>)[0]).orchestratorEpoch;
  await writeValidEvidence(root, { provider });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.jobs[0].cleanup.codegraph.orchestratorEpoch"));
});

test("live release evidence rejects top-level live bundle symlinks that resolve outside live release evidence", async () => {
  const root = await tempRoot("cpb-live-release-bundle-symlink");
  await writeValidEvidence(root);
  const providerRef = "docs/product/evidence/live-release/runs/20260720T101000Z/provider-connectivity.json";
  const outsideRef = "docs/product/evidence/provider-preflight.json";
  const raw = await readFile(path.join(root, providerRef), "utf8");
  await mkdir(path.dirname(path.join(root, outsideRef)), { recursive: true });
  await writeFile(path.join(root, outsideRef), raw, "utf8");
  await rm(path.join(root, providerRef));
  await symlink(
    path.relative(path.dirname(path.join(root, providerRef)), path.join(root, outsideRef)),
    path.join(root, providerRef),
  );

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.evidenceBundleRef"
    && /non-symlink/.test(item.reason)));
});

test("live release evidence rejects in-prefix symlink aliases for canonical run bundles", async () => {
  const root = await tempRoot("cpb-live-release-run-bundle-alias");
  await writeValidEvidence(root);
  const manifestFile = path.join(root, "docs/product/cpb-live-release-validation.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const providerRef = String(manifest.providerConnectivity.evidenceBundleRef);
  const targetRef = "docs/product/evidence/live-release/runs/20260720T101000Z/provider-target.json";
  await copyFile(path.join(root, providerRef), path.join(root, targetRef));
  await rm(path.join(root, providerRef));
  await symlink("provider-target.json", path.join(root, providerRef));
  manifest.providerConnectivity.sha256 = digest(await readFile(path.join(root, targetRef), "utf8"));
  await writeJson(manifestFile, manifest);

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.evidenceBundleRef"
    && /non-symlink/.test(item.reason)));
});

test("live release evidence fails closed when the manifest is missing", async () => {
  const root = await tempRoot("cpb-live-release-missing");
  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.equal(result.missingEvidence, true);
  assert.match(result.violations[0].reason, /missing live release validation evidence/);
});

test("live release evidence rejects unsafe evidenceFile paths before reading JSON", async () => {
  const root = await tempRoot("cpb-live-release-evidence-file-path");
  await writeValidEvidence(root);

  const absolute = await verifyLiveReleaseEvidenceFile({
    root,
    evidenceFile: path.join(root, "docs/product/cpb-live-release-validation.json"),
    referenceTime,
  });
  assert.equal(absolute.ok, false);
  assert.match(absolute.violations[0].reason, /repository-local JSON path/);

  const outside = await verifyLiveReleaseEvidenceFile({
    root,
    evidenceFile: "../cpb-live-release-validation.json",
    referenceTime,
  });
  assert.equal(outside.ok, false);
  assert.match(outside.violations[0].reason, /repository-local JSON path/);

  const defaultEvidenceFile = path.join(root, "docs/product/cpb-live-release-validation.json");
  const outsideRoot = await tempRoot("cpb-live-release-evidence-file-symlink-target");
  const outsideFile = path.join(outsideRoot, "cpb-live-release-validation.json");
  await copyFile(defaultEvidenceFile, outsideFile);
  await rm(defaultEvidenceFile);
  await symlink(outsideFile, defaultEvidenceFile);

  const symlinkResult = await verifyLiveReleaseEvidenceFile({ root, referenceTime });
  assert.equal(symlinkResult.ok, false);
  assert.match(symlinkResult.violations[0].reason, /non-symlink regular file/);
});

test("live release evidence rejects a forged provider success without live phases", async () => {
  const root = await tempRoot("cpb-live-release-forged-provider");
  await writeValidEvidence(root, {
    provider: { schemaVersion: 1, generatedAt: "2026-07-20T10:00:00.000Z", ok: true, phases: [] },
  });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.evidenceBundleRef"));
});

test("live release evidence rejects a provider summary without an auditable batch report", async () => {
  const root = await tempRoot("cpb-live-release-provider-summary-only");
  const full = validProviderEvidence();
  await writeValidEvidence(root, {
    provider: {
      schemaVersion: full.schemaVersion,
      generatedAt: full.generatedAt,
      manifest: full.manifest,
      summary: full.summary,
    },
  });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.report"));
});

test("live release evidence rejects a provider report without completed batch terminal states", async () => {
  const root = await tempRoot("cpb-live-release-provider-nonterminal");
  const valid = validProviderEvidence();
  const provider = buildSweBenchBatchReport({
    manifest: {
      ...valid.sourceManifest,
      terminalStates: [],
    },
    generatedAt: "2026-07-20T10:00:00.000Z",
  });
  await writeValidEvidence(root, { provider });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.report"
    || item.path === "providerConnectivity.validation"));
});

test("live release evidence rejects provider unavailable jobs as release evidence", async () => {
  const root = await tempRoot("cpb-live-release-provider-unavailable");
  const valid = validProviderEvidence();
  const sourceManifest = structuredClone(valid.sourceManifest);
  sourceManifest.terminalStates = [{
    assignmentId: "assignment-provider-preflight",
    status: "failed",
    failureKind: "provider_unavailable",
    attempt: 1,
  }];
  const provider = buildSweBenchBatchReport({
    manifest: sourceManifest,
    generatedAt: "2026-07-20T10:00:00.000Z",
  });
  await writeValidEvidence(root, { provider });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.jobs[0].failureKind"));
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.jobs"));
});

test("live release evidence rejects completed jobs that retain a failure kind", async () => {
  const root = await tempRoot("cpb-live-release-completed-failure-kind");
  const provider = validProviderEvidence();
  (provider.jobs[0] as Record<string, unknown>).failureKind = "artifact_invalid";
  await writeValidEvidence(root, { provider });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.jobs[0].failureKind"));
});

test("live release evidence rejects completed jobs with an empty changed-file list", async () => {
  const root = await tempRoot("cpb-live-release-empty-changed-files");
  const provider = validProviderEvidence();
  const patch = (provider.jobs[0] as Record<string, unknown>).patch as Record<string, unknown>;
  patch.changedFiles = [];
  patch.changedFileCount = 0;
  await writeValidEvidence(root, { provider });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.jobs[0].patch"
    && /non-test, non-fixture changed file/.test(item.reason)));
});

test("live release evidence rejects a completed job with a missing required phase", async () => {
  const root = await tempRoot("cpb-live-release-missing-required-phase");
  const provider = validProviderEvidence();
  const phaseEvidence = (provider.jobs[0] as Record<string, unknown>).phaseEvidence as Record<string, unknown>;
  delete phaseEvidence.adversarial_verify;
  await writeValidEvidence(root, { provider });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.jobs[0].phaseEvidence.adversarial_verify"
    && /successful completed phase/.test(item.reason)));
});

test("live release evidence rejects a completed job with a failed required phase", async () => {
  const root = await tempRoot("cpb-live-release-failed-required-phase");
  const provider = validProviderEvidence();
  const phaseEvidence = (provider.jobs[0] as Record<string, unknown>).phaseEvidence as Record<string, Record<string, unknown>>;
  phaseEvidence.verify.ok = false;
  await writeValidEvidence(root, { provider });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.jobs[0].phaseEvidence.verify"
    && /successful completed phase/.test(item.reason)));
});

test("live release evidence rejects missing completed phase artifact files", async () => {
  const root = await tempRoot("cpb-live-release-missing-phase-artifact");
  await writeValidEvidence(root);
  await rewriteProviderEvidence(root, (provider) => {
    const job = (provider.jobs as Array<Record<string, unknown>>)[0];
    const phaseEvidence = job.phaseEvidence as Record<string, Record<string, unknown>>;
    phaseEvidence.execute.structuredOutputPath = "docs/product/evidence/live-release/provider-artifacts/job-0/missing-execute.json";
  });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.jobs[0].phaseEvidence.execute.structuredOutput.path"
    && /does not exist/.test(item.reason)));
});

test("live release evidence rejects phase artifact digests that do not match file content", async () => {
  const root = await tempRoot("cpb-live-release-phase-artifact-digest");
  await writeValidEvidence(root);
  await rewriteProviderEvidence(root, (provider) => {
    const job = (provider.jobs as Array<Record<string, unknown>>)[0];
    const phaseEvidence = job.phaseEvidence as Record<string, Record<string, unknown>>;
    phaseEvidence.execute.artifactSha256 = "0".repeat(64);
  });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.jobs[0].phaseEvidence.execute.structuredOutput.sha256"
    && /referenced artifact/.test(item.reason)));
});

test("live release evidence rejects tampered provider preflight output artifacts", async () => {
  const root = await tempRoot("cpb-live-release-preflight-output-tamper");
  await writeValidEvidence(root);
  const provider = JSON.parse(await readFile(path.join(root, "docs/product/evidence/live-release/runs/20260720T101000Z/provider-connectivity.json"), "utf8"));
  const phase = provider.manifest.providerPreflight.phases[0];
  await writeJson(path.join(root, phase.outputPath), { ok: false });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.phases[0].output.bytes"
    || item.path === "providerConnectivity.phases[0].output.sha256"));
});

test("live release evidence rejects job preflight output path divergence from manifest", async () => {
  const root = await tempRoot("cpb-live-release-job-preflight-output-divergence");
  await writeValidEvidence(root);
  await rewriteProviderEvidence(root, (provider) => {
    const job = (provider.jobs as Array<Record<string, unknown>>)[0];
    const jobPreflight = (((job.providerRoute as Record<string, Record<string, unknown>>).actual)
      .preflight as Array<Record<string, unknown>>);
    jobPreflight[0].outputPath = jobPreflight[1].outputPath;
  });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.jobs[0].providerRoute.actual.preflight"
    && /manifest providerPreflight\.phases/.test(item.reason)));
});

test("live release evidence rejects job preflight audit reference divergence from manifest", async () => {
  const root = await tempRoot("cpb-live-release-job-preflight-audit-divergence");
  await writeValidEvidence(root);
  await rewriteProviderEvidence(root, (provider) => {
    const job = (provider.jobs as Array<Record<string, unknown>>)[0];
    const jobPreflight = (((job.providerRoute as Record<string, Record<string, unknown>>).actual)
      .preflight as Array<Record<string, unknown>>);
    const firstHandshake = jobPreflight[0].handshake as Record<string, unknown>;
    const secondHandshake = jobPreflight[1].handshake as Record<string, unknown>;
    firstHandshake.controlPlaneAudit = structuredClone(secondHandshake.controlPlaneAudit);
  });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.jobs[0].providerRoute.actual.preflight"
    && /manifest providerPreflight\.phases/.test(item.reason)));
});

test("live release evidence rejects provider preflight output artifacts outside the live evidence root", async () => {
  const root = await tempRoot("cpb-live-release-preflight-output-outside");
  await writeValidEvidence(root);
  await rewriteProviderEvidence(root, async (provider) => {
    const phase = ((provider.manifest as Record<string, unknown>).providerPreflight as { phases: Array<Record<string, unknown>> }).phases[0];
    const outsidePath = "scripts/provider-preflight-output.json";
    await writeJson(path.join(root, outsidePath), phase.handshake);
    const raw = await readFile(path.join(root, outsidePath));
    phase.outputPath = outsidePath;
    phase.outputBytes = raw.byteLength;
    phase.outputSha256 = digestBuffer(raw);
  });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.phases[0].output.path"
    && /docs\/product\/evidence\/live-release/.test(item.reason)));
});

test("live release evidence rejects symlinked provider preflight output artifacts", async () => {
  const root = await tempRoot("cpb-live-release-preflight-output-symlink");
  const outside = await tempRoot("cpb-live-release-preflight-output-symlink-target");
  await writeValidEvidence(root);
  await rewriteProviderEvidence(root, async (provider) => {
    const phase = ((provider.manifest as Record<string, unknown>).providerPreflight as { phases: Array<Record<string, unknown>> }).phases[0];
    const outsideFile = path.join(outside, "output.json");
    await writeJson(outsideFile, phase.handshake);
    const raw = await readFile(outsideFile);
    const relative = "docs/product/evidence/live-release/provider-artifacts/preflight/symlink.json";
    await symlink(outsideFile, path.join(root, relative));
    phase.outputPath = relative;
    phase.outputBytes = raw.byteLength;
    phase.outputSha256 = digestBuffer(raw);
  });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.phases[0].output.path"
    && /non-symlink/.test(item.reason)));
});

test("live release evidence rejects arbitrary control-plane output path digests", async () => {
  const root = await tempRoot("cpb-live-release-control-plane-output-digest");
  await writeValidEvidence(root);
  await rewriteProviderEvidence(root, async (provider) => {
    const phase = ((provider.manifest as Record<string, unknown>).providerPreflight as { phases: Array<Record<string, unknown>> }).phases[0];
    const handshake = phase.handshake as Record<string, unknown>;
    const audit = handshake.controlPlaneAudit as Record<string, unknown>;
    const auditFile = path.join(root, String(audit.path));
    const artifact = JSON.parse(await readFile(auditFile, "utf8")) as Record<string, Record<string, unknown>>;
    artifact.jobIdentity.outputPathSha256 = "0".repeat(64);
    await writeJson(auditFile, artifact);
    const auditRaw = await readFile(auditFile);
    audit.bytes = auditRaw.byteLength;
    audit.sha256 = digestBuffer(auditRaw);
    await writeJson(path.join(root, String(phase.outputPath)), handshake);
    const outputRaw = await readFile(path.join(root, String(phase.outputPath)));
    phase.outputBytes = outputRaw.byteLength;
    phase.outputSha256 = digestBuffer(outputRaw);
  });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.phases[0].handshake.controlPlaneEvidence"));
});

test("live release evidence rejects patch artifact paths that escape through symlinks", async () => {
  const root = await tempRoot("cpb-live-release-patch-symlink");
  await writeValidEvidence(root);
  const outsideRoot = await tempRoot("cpb-live-release-patch-outside");
  const outsidePatch = await writeRawArtifact(outsideRoot, "outside.patch", "diff --git a/x b/x\n");
  const symlinkPath = "docs/product/evidence/live-release/provider-artifacts/job-0/escape.patch";
  await symlink(path.join(outsideRoot, outsidePatch.path), path.join(root, symlinkPath));
  await rewriteProviderEvidence(root, (provider) => {
    const job = (provider.jobs as Array<Record<string, unknown>>)[0];
    const patch = job.patch as Record<string, unknown>;
    patch.path = symlinkPath;
    patch.bytes = outsidePatch.bytes;
    patch.sha256 = outsidePatch.sha256;
  });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.jobs[0].patch.path"
    && /symlink/.test(item.reason)));
});

test("live release evidence rejects artifact paths outside the live release evidence directory", async () => {
  const root = await tempRoot("cpb-live-release-source-as-artifact");
  await writeValidEvidence(root);
  const sourceArtifact = await writeRawArtifact(root, "scripts/not-release-artifact.json", "{\"ok\":true}\n");
  await rewriteProviderEvidence(root, (provider) => {
    const job = (provider.jobs as Array<Record<string, unknown>>)[0];
    const phaseEvidence = job.phaseEvidence as Record<string, Record<string, unknown>>;
    phaseEvidence.execute.structuredOutputPath = sourceArtifact.path;
    phaseEvidence.execute.structuredOutputBytes = sourceArtifact.bytes;
    phaseEvidence.execute.artifactSha256 = sourceArtifact.sha256;
  });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.jobs[0].phaseEvidence.execute.structuredOutput.path"
    && /docs\/product\/evidence\/live-release/.test(item.reason)));
});

test("live release evidence rejects retries and retained retry failure kinds", async () => {
  const root = await tempRoot("cpb-live-release-retry-evidence");
  const provider = validProviderEvidence();
  const phaseEvidence = (provider.jobs[0] as Record<string, unknown>).phaseEvidence as Record<string, Record<string, unknown>>;
  phaseEvidence.execute.retryCount = 1;
  phaseEvidence.execute.retryFailureKinds = ["agent_unavailable"];
  await writeValidEvidence(root, { provider });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.jobs[0].phaseEvidence.execute.retryCount"));
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.jobs[0].phaseEvidence.execute.retryFailureKinds"));
});

test("live release evidence rejects missing or non-first CodeGraph cleanup proof", async () => {
  const missingRoot = await tempRoot("cpb-live-release-missing-codegraph-cleanup");
  const missingProvider = validProviderEvidence();
  delete (((missingProvider.jobs[0] as Record<string, unknown>).cleanup as Record<string, unknown>).codegraph);
  await writeValidEvidence(missingRoot, { provider: missingProvider });

  const missing = await verifyLiveReleaseEvidenceFile({ root: missingRoot, referenceTime });
  assert.equal(missing.ok, false);
  assert.ok(missing.violations.some((item) => item.path === "providerConnectivity.jobs[0].cleanup.codegraph"
    && /CodeGraph cleanup proof/.test(item.reason)));

  const retryRoot = await tempRoot("cpb-live-release-retried-codegraph-cleanup");
  const retryProvider = validProviderEvidence();
  const proof = (((retryProvider.jobs[0] as Record<string, unknown>).cleanup as Record<string, unknown>).codegraph as Record<string, unknown>);
  proof.cleanupAttempt = 2;
  await writeValidEvidence(retryRoot, { provider: retryProvider });

  const retry = await verifyLiveReleaseEvidenceFile({ root: retryRoot, referenceTime });
  assert.equal(retry.ok, false);
  assert.ok(retry.violations.some((item) => item.path === "providerConnectivity.jobs[0].cleanup.codegraph.cleanupAttempt"));
});

test("live release evidence rejects provider reports with multiple representative jobs", async () => {
  const root = await tempRoot("cpb-live-release-multi-job");
  const valid = validProviderEvidence();
  const sourceManifest = structuredClone(valid.sourceManifest);
  sourceManifest.count = 2;
  (sourceManifest.assignments as Array<Record<string, unknown>>).push({
    record: {
      benchmarkInstanceId: "flask__flask-5014",
      representativeRepository: "pallets/flask",
      baseCommit: "a".repeat(40),
      datasetRowRef: "https://datasets-server.huggingface.co/rows?dataset=SWE-bench%2FSWE-bench_Verified&config=default&split=test&offset=1&length=1",
    },
    queued: { assignmentId: "assignment-provider-partial", attempt: 1 },
  });
  (sourceManifest.terminalStates as Array<Record<string, unknown>>).push({
    assignmentId: "assignment-provider-partial",
    status: "completed",
    attempt: 1,
  });
  const validJob = valid.jobs[0] as Record<string, unknown>;
  const completeEvidence = {
    phaseEvidence: structuredClone(validJob.phaseEvidence),
    patch: structuredClone(validJob.patch),
    regressionEvidence: structuredClone(validJob.regressionEvidence),
  };
  const provider = buildSweBenchBatchReport({
    manifest: sourceManifest,
    evidenceByAssignmentId: {
      "assignment-provider-preflight": completeEvidence,
      "assignment-provider-partial": structuredClone(completeEvidence),
    },
    generatedAt: "2026-07-20T10:00:00.000Z",
  });
  await writeValidEvidence(root, { provider });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.jobs"
    && /exactly one representative provider job/.test(item.reason)));
});

test("live release evidence rejects an omitted source provider preflight mode", async () => {
  const root = await tempRoot("cpb-live-release-provider-mode-omitted");
  const valid = validProviderEvidence();
  const sourceManifest = structuredClone(valid.sourceManifest);
  delete (sourceManifest as Record<string, unknown>).providerPreflightMode;
  const validJob = valid.jobs[0] as Record<string, unknown>;
  const provider = buildSweBenchBatchReport({
    manifest: sourceManifest,
    evidenceByAssignmentId: {
      "assignment-provider-preflight": {
        phaseEvidence: structuredClone(validJob.phaseEvidence),
        patch: structuredClone(validJob.patch),
        regressionEvidence: structuredClone(validJob.regressionEvidence),
      },
    },
    generatedAt: "2026-07-20T10:00:00.000Z",
  });
  await writeValidEvidence(root, { provider });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.sourceManifest.providerPreflightMode"));
});

test("live release evidence rejects structural source provider preflight mode", async () => {
  const root = await tempRoot("cpb-live-release-provider-mode-structural");
  const valid = validProviderEvidence();
  const sourceManifest = structuredClone(valid.sourceManifest);
  sourceManifest.providerPreflightMode = "structural";
  const validJob = valid.jobs[0] as Record<string, unknown>;
  const provider = buildSweBenchBatchReport({
    manifest: sourceManifest,
    evidenceByAssignmentId: {
      "assignment-provider-preflight": {
        phaseEvidence: structuredClone(validJob.phaseEvidence),
        patch: structuredClone(validJob.patch),
        regressionEvidence: structuredClone(validJob.regressionEvidence),
      },
    },
    generatedAt: "2026-07-20T10:00:00.000Z",
  });
  await writeValidEvidence(root, { provider });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.sourceManifest.providerPreflightMode"));
});

test("live release evidence rejects CodeGraph unavailable jobs as release evidence", async () => {
  const root = await tempRoot("cpb-live-release-codegraph-unavailable");
  const valid = validProviderEvidence();
  const sourceManifest = structuredClone(valid.sourceManifest);
  sourceManifest.terminalStates = [{
    assignmentId: "assignment-provider-preflight",
    status: "failed",
    failureKind: "codegraph_unavailable",
    attempt: 1,
  }];
  const provider = buildSweBenchBatchReport({
    manifest: sourceManifest,
    generatedAt: "2026-07-20T10:00:00.000Z",
  });
  await writeValidEvidence(root, { provider });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.jobs[0].failureKind"));
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.jobs"));
});

test("live release evidence rejects provider reports that retain launch arguments", async () => {
  const root = await tempRoot("cpb-live-release-provider-launch-args");
  const valid = validProviderEvidence();
  const sourceManifest = structuredClone(valid.sourceManifest);
  const secret = "github_pat_report_argument_must_not_persist";
  const providerPreflight = sourceManifest.providerPreflight as {
    phases: Array<Record<string, unknown>>;
  };
  providerPreflight.phases[0].args = ["--token", secret];
  const provider = buildSweBenchBatchReport({
    manifest: sourceManifest,
    generatedAt: "2026-07-20T10:00:00.000Z",
  });
  await writeValidEvidence(root, { provider });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => /must not retain launch arguments/.test(item.reason)));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("live release evidence rejects nested handshake launch and raw fields", async () => {
  const root = await tempRoot("cpb-live-release-provider-handshake-raw");
  const valid = validProviderEvidence();
  const sourceManifest = structuredClone(valid.sourceManifest);
  const secret = "github_pat_nested_handshake_must_not_persist";
  const providerPreflight = sourceManifest.providerPreflight as {
    phases: Array<{ handshake: Record<string, unknown> }>;
  };
  providerPreflight.phases[0].handshake.env = { GITHUB_TOKEN: secret };
  providerPreflight.phases[0].handshake.rawOutput = secret;
  const provider = buildSweBenchBatchReport({
    manifest: sourceManifest,
    generatedAt: "2026-07-20T10:00:00.000Z",
  });
  await writeValidEvidence(root, { provider });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => /must not retain launch arguments/.test(item.reason)));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("live release evidence rejects forged control-plane handshake proof", async (t) => {
  const cases: Array<{
    name: string;
    mutate: (handshake: Record<string, unknown>) => void;
  }> = [
    {
      name: "missing launch",
      mutate: (handshake) => {
        const proof = { ...(handshake.controlPlaneEvidence as Record<string, unknown>), agentLaunchObserved: false };
        handshake.controlPlaneEvidence = proof;
        handshake.controlPlaneEvidenceSha256 = stableJsonSha256(proof);
      },
    },
    {
      name: "wrong hash",
      mutate: (handshake) => {
        handshake.controlPlaneEvidenceSha256 = "0".repeat(64);
      },
    },
    {
      name: "non-zero terminal",
      mutate: (handshake) => {
        const proof = { ...(handshake.controlPlaneEvidence as Record<string, unknown>), terminalLaunchCount: 1 };
        handshake.controlPlaneEvidence = proof;
        handshake.controlPlaneEvidenceSha256 = stableJsonSha256(proof);
      },
    },
    {
      name: "incomplete policy",
      mutate: (handshake) => {
        const proof = { ...(handshake.controlPlaneEvidence as Record<string, unknown>) };
        proof.policySummary = { terminalPolicy: "deny", permissionRequests: "reject", webToolsDisabled: true };
        handshake.controlPlaneEvidence = proof;
        handshake.controlPlaneEvidenceSha256 = stableJsonSha256(proof);
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const root = await tempRoot(`cpb-live-release-control-plane-${fixture.name.replace(/\W+/g, "-")}`);
      const valid = validProviderEvidence();
      const sourceManifest = structuredClone(valid.sourceManifest);
      const providerPreflight = sourceManifest.providerPreflight as {
        phases: Array<{ handshake: Record<string, unknown> }>;
      };
      fixture.mutate(providerPreflight.phases[0].handshake);
      const provider = buildSweBenchBatchReport({
        manifest: sourceManifest,
        generatedAt: "2026-07-20T10:00:00.000Z",
      });
      await writeValidEvidence(root, { provider });

      const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

      assert.equal(result.ok, false);
      assert.ok(result.violations.some((item) => item.path.endsWith(".handshake.controlPlaneEvidence")));
    });
  }
});

test("live release evidence rejects a digest that does not bind the referenced bundle", async () => {
  const root = await tempRoot("cpb-live-release-digest");
  await writeValidEvidence(root);
  const manifestFile = path.join(root, "docs/product/cpb-live-release-validation.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.providerConnectivity.sha256 = "0".repeat(64);
  await writeJson(manifestFile, manifest);

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "providerConnectivity.sha256"));
});

test("live release evidence rejects draft PR evidence without disposable cleanup proof", async () => {
  const root = await tempRoot("cpb-live-release-unsafe-pr");
  const draftPr = validDraftPrEvidence();
  draftPr.target.disposable = false;
  draftPr.cleanup.branchDeleted = false;
  await writeValidEvidence(root, { draftPr });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => item.path === "draftPrRehearsal.target"));
  assert.ok(result.violations.some((item) => item.path === "draftPrRehearsal.cleanup"));
});

test("live release evidence rejects stale live rehearsal inputs", async () => {
  const root = await tempRoot("cpb-live-release-stale");
  const provider = validProviderEvidence();
  provider.generatedAt = "2026-05-01T10:00:00.000Z";
  await writeValidEvidence(root, {
    provider,
    generatedAt: "2026-05-01T10:10:00.000Z",
  });

  const result = await verifyLiveReleaseEvidenceFile({ root, referenceTime });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((item) => /no older than 30 days/.test(item.reason)));
});
