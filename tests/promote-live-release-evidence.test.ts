import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import test from "node:test";

import {
  buildSweBenchBatchReport,
  stableJsonSha256,
  validateSweBenchBatchReport,
} from "../scripts/queue-swebench-batch.js";
import { promoteLiveReleaseEvidence } from "../scripts/promote-live-release-evidence.js";
import { captureProcessIdentity } from "../core/runtime/process-tree.js";
import { tempRoot, writeJson } from "./helpers.js";

const repoRoot = path.resolve(
  import.meta.dirname,
  path.basename(path.dirname(import.meta.dirname)) === "dist-tests" ? "../.." : "..",
);
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

function sha256(raw: Buffer | string) {
  return createHash("sha256").update(raw).digest("hex");
}

function processIdentity(pid: number, birthId: string) {
  return {
    pid,
    birthId,
    incarnation: `${pid}:${birthId}`,
    capturedAt: "2026-07-21T00:00:00.000Z",
    birthIdPrecision: "exact" as const,
  };
}

function currentExactProcessIdentity() {
  const identity = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(identity, "test process must expose an exact process identity");
  return identity;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
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

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function liveProviderPreflightPrompt() {
  return [
    "CPB provider live preflight.",
    "Do not call tools. Do not inspect files. Reply exactly with: CPB_PROVIDER_PREFLIGHT_OK",
  ].join("\n");
}

async function writeRaw(root: string, relative: string, raw: string) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, raw, "utf8");
  const buffer = await readFile(file);
  return { path: file, bytes: buffer.byteLength, sha256: sha256(buffer) };
}

async function copyProductEvidence(root: string) {
  for (const relative of productFiles) {
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(repoRoot, relative), destination);
  }
}

function controlPlaneEvidence(phase: string, role: string) {
  const evidence = {
    transport: "acp",
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

function codeGraphCleanupProof() {
  const assignmentId = "assignment-provider-promotion";
  const statePath = `/tmp/${assignmentId}/.codegraph/daemon.pid`;
  return {
    generator: "runtime/worker/managed-worker.ts#stopAssignmentCodeGraphRuntime",
    assignmentId,
    attempt: 1,
    attemptToken: "attempt-token-provider-promotion",
    entryId: "provider-promotion",
    projectId: "proj-provider-promotion",
    jobId: "job-provider-promotion",
    workerId: "w-provider-promotion",
    orchestratorEpoch: 1,
    context: "before_terminal_publication",
    cleanupAttempt: 1,
    ok: true,
    cleanupVerified: true,
    processTreeStopped: true,
    stateRemoved: true,
    statePath,
    worktreePath: `/tmp/${assignmentId}`,
    startup: {
      ok: true,
      source: "test_codegraph_daemon",
      pid: 12345,
      processPid: 12345,
      statePath,
      startedAt: "2026-07-20T10:00:00.000Z",
      readyAt: "2026-07-20T10:00:01.000Z",
    },
    startupSource: "test_codegraph_daemon",
    pid: 12345,
    processPid: 12345,
    cleanupStartedAt: "2026-07-20T10:00:02.000Z",
    cleanupCompletedAt: "2026-07-20T10:00:03.000Z",
  };
}

async function writeControlPlaneAuditRef(
  runRoot: string,
  phase: string,
  role: string,
  summary: unknown,
  outputPath: string,
) {
  const summaryRecord = summary as Record<string, unknown>;
  const projectId = "cpb-provider-live-preflight";
  const correlationNonce = sha256(`${phase}:${role}:provider-promotion`).slice(0, 32);
  const jobId = `provider-preflight-${role}-codex-${correlationNonce}`;
  const sessionId = `promotion-session-${phase}-${correlationNonce}`;
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
    JSON.stringify({
      ts: "2026-07-20T10:00:01.000Z",
      event: "session_new",
      agent: "codex",
      phase,
      role,
      projectId,
      jobId,
      correlationNonce,
      sessionId,
    }),
  ];
  const raw = `${rawLines.join("\n")}\n`;
  const auditDirectory = path.join(runRoot, "preflight/control-plane-audit");
  const rawFile = path.join(auditDirectory, `${phase}-codex-${correlationNonce}.raw.jsonl`);
  await mkdir(auditDirectory, { recursive: true });
  await writeFile(rawFile, raw, "utf8");
  const rawBuffer = await readFile(rawFile);
  const file = path.join(auditDirectory, `${phase}-codex-${correlationNonce}.json`);
  const artifact = {
    schemaVersion: 1,
    generator: "scripts/queue-swebench-batch.ts#controlPlaneAuditArtifact",
    generatedAt: "2026-07-20T10:00:02.000Z",
    nonce: correlationNonce,
    jobIdentity: {
      projectId,
      jobId,
      correlationNonce,
      outputPathSha256: sha256(outputPath),
      promptSha256: sha256(liveProviderPreflightPrompt()),
      sentinelSha256: sha256("CPB_PROVIDER_PREFLIGHT_OK"),
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
      sha256: sha256(rawBuffer),
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
        sessionHash: sha256(sessionId),
      },
    ],
    summary,
    summarySha256: stableJsonSha256(summary),
  };
  await writeJson(file, artifact);
  const buffer = await readFile(file);
  return {
    path: file,
    bytes: buffer.byteLength,
    sha256: sha256(buffer),
    rawPath: rawFile,
    rawBytes: rawBuffer.byteLength,
    rawSha256: sha256(rawBuffer),
    summarySha256: stableJsonSha256(summary),
    projectId,
    jobId,
    correlationNonce,
  };
}

async function writeProviderRun(runRoot: string) {
  const routes = [
    ["plan", "planner", "planner"],
    ["execute", "executor", "executor"],
    ["verify", "verifier", "verifier"],
    ["adversarial_verify", "adversarial_verifier", "adversarial_verifier"],
  ] as const;
  const agents = {
    planner: "codex",
    executor: "codex",
    verifier: "codex",
    adversarial_verifier: "codex",
  };
  const phases: Array<Record<string, unknown>> = [];
  for (const [phase, role] of routes.map(([phase, role]) => [phase, role] as const)) {
    const proof = controlPlaneEvidence(phase, role);
    const outputPath = path.join(runRoot, `preflight/${phase}.json`);
    const auditFixture = await writeControlPlaneAuditRef(
      runRoot,
      phase,
      role,
      proof.controlPlaneEvidence,
      outputPath,
    );
    const {
      projectId,
      jobId,
      correlationNonce,
      ...controlPlaneAudit
    } = auditFixture;
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
      projectId,
      jobId,
      correlationNonce,
      ...proof,
      controlPlaneAudit,
    };
    await writeJson(outputPath, handshake);
    const outputBuffer = await readFile(outputPath);
    phases.push({
      phase,
      role,
      agent: "codex",
      providerKey: "codex",
      transport: "acp",
      command: "codex-acp",
      outputPath,
      outputBytes: outputBuffer.byteLength,
      outputSha256: sha256(outputBuffer),
      denyRules: ["web_tool_denied", "read_only_mutation_denied", "broad_test_command_denied"],
      handshakeOk: true,
      handshake,
      violations: [],
    });
  }
  const providerPreflight = {
    schemaVersion: 1,
    generator: "scripts/queue-swebench-batch.ts#runSweBenchProviderPreflight",
    generatedAt: new Date().toISOString(),
    ok: true,
    violations: [],
    phases,
  };
  const prepareEvent = { event: "riskmap_generated", assignmentId: "assignment-provider-promotion", ok: true };
  await writeJson(path.join(runRoot, "artifacts/prepare.json"), prepareEvent);
  const phaseArtifacts: Record<string, { path: string; bytes: number; sha256: string }> = {
    prepare_task: {
      path: `${path.join(runRoot, "artifacts/prepare.json")}#riskmap_generated`,
      bytes: stableJsonBytes(prepareEvent),
      sha256: stableJsonSha256(prepareEvent),
    },
  };
  for (const phase of ["plan", "execute", "verify", "adversarial_verify"]) {
    phaseArtifacts[phase] = await writeRaw(runRoot, `artifacts/${phase}.json`, `${JSON.stringify({ phase, ok: true })}\n`);
  }
  const patch = await writeRaw(runRoot, "artifacts/source.patch", [
    "diff --git a/django/db/models/expressions.py b/django/db/models/expressions.py",
    "--- a/django/db/models/expressions.py",
    "+++ b/django/db/models/expressions.py",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n"));
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
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
      residualScanOk: true,
      residualProcesses: 0,
      residualScanFailures: [],
      reasons: ["batch_wait_completed"],
      workerIds: ["w-provider-promotion"],
      pids: [12345],
    },
    assignments: [{
      entryId: "provider-promotion",
      projectId: "proj-provider-promotion",
      workerId: "w-provider-promotion",
      record: {
        benchmarkInstanceId: "django__django-13128",
        representativeRepository: "django/django",
        baseCommit: "2d67222472f80f251607ae1b720527afceba06ad",
        datasetRowRef: "https://datasets-server.huggingface.co/rows?dataset=SWE-bench%2FSWE-bench_Verified&config=default&split=test&offset=0&length=1",
      },
      queued: {
        assignmentId: "assignment-provider-promotion",
        attempt: 1,
        attemptToken: "attempt-token-provider-promotion",
        orchestratorEpoch: 1,
      },
    }],
    terminalStates: [{
      assignmentId: "assignment-provider-promotion",
      status: "completed",
      attempt: 1,
      jobId: "job-provider-promotion",
      workerId: "w-provider-promotion",
      orchestratorEpoch: 1,
    }],
  };
  const report = buildSweBenchBatchReport({
    manifest,
    evidenceByAssignmentId: {
      "assignment-provider-promotion": {
        phaseEvidence: Object.fromEntries(Object.entries(phaseArtifacts).map(([phase, artifact]) => [phase, {
          ok: true,
          durationMs: 100,
          structuredOutputPath: artifact.path,
          structuredOutputBytes: artifact.bytes,
          artifactSha256: artifact.sha256,
          retryCount: 0,
          retryFailureKinds: [],
        }])),
        patch: {
          path: patch.path,
          sha256: patch.sha256,
          bytes: patch.bytes,
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
        jobId: "job-provider-promotion",
      },
    },
    generatedAt: new Date().toISOString(),
  });
  const validation = validateSweBenchBatchReport({ manifest, report });
  assert.equal(validation.valid, true, JSON.stringify(validation.violations, null, 2));
  const reportFile = path.join(runRoot, "report.json");
  await writeJson(reportFile, report);
  return { reportFile, prepareFile: path.join(runRoot, "artifacts/prepare.json") };
}

async function rewriteReportAsTwoJobs(reportFile: string) {
  const report = JSON.parse(await readFile(reportFile, "utf8"));
  const manifest = cloneJson(report.sourceManifest);
  const firstAssignment = manifest.assignments[0];
  const secondAssignment = cloneJson(firstAssignment);
  secondAssignment.entryId = "provider-promotion-second";
  secondAssignment.projectId = "proj-provider-promotion-second";
  secondAssignment.workerId = "w-provider-promotion-second";
  secondAssignment.queued.assignmentId = "assignment-provider-promotion-second";
  secondAssignment.queued.attemptToken = "attempt-token-provider-promotion-second";
  secondAssignment.queued.orchestratorEpoch = 2;
  manifest.count = 2;
  manifest.assignments = [firstAssignment, secondAssignment];
  manifest.terminalStates = [
    manifest.terminalStates[0],
    {
      assignmentId: "assignment-provider-promotion-second",
      status: "completed",
      attempt: 1,
      jobId: "job-provider-promotion-second",
      workerId: "w-provider-promotion-second",
      orchestratorEpoch: 2,
    },
  ];
  manifest.workerCleanup.workerCleanupEvents = 2;
  manifest.workerCleanup.workerIds = ["w-provider-promotion", "w-provider-promotion-second"];
  manifest.workerCleanup.pids = [12345, 12346];

  const firstJob = report.jobs[0];
  const secondCleanup = codeGraphCleanupProof();
  secondCleanup.assignmentId = "assignment-provider-promotion-second";
  secondCleanup.attemptToken = "attempt-token-provider-promotion-second";
  secondCleanup.entryId = "provider-promotion-second";
  secondCleanup.projectId = "proj-provider-promotion-second";
  secondCleanup.jobId = "job-provider-promotion-second";
  secondCleanup.workerId = "w-provider-promotion-second";
  secondCleanup.orchestratorEpoch = 2;
  const rebuilt = buildSweBenchBatchReport({
    manifest,
    evidenceByAssignmentId: {
      "assignment-provider-promotion": {
        phaseEvidence: firstJob.phaseEvidence,
        patch: firstJob.patch,
        regressionEvidence: firstJob.regressionEvidence,
        cleanup: firstJob.cleanup,
        jobId: firstJob.jobId,
      },
      "assignment-provider-promotion-second": {
        phaseEvidence: firstJob.phaseEvidence,
        patch: firstJob.patch,
        regressionEvidence: firstJob.regressionEvidence,
        cleanup: { codegraph: secondCleanup },
        jobId: "job-provider-promotion-second",
      },
    },
    generatedAt: report.generatedAt,
  });
  const validation = validateSweBenchBatchReport({ manifest, report: rebuilt });
  assert.equal(validation.valid, true, JSON.stringify(validation.violations, null, 2));
  await writeJson(reportFile, rebuilt);
}

async function mutateTopLevelAuditNonceAndRebind(reportFile: string) {
  const report = JSON.parse(await readFile(reportFile, "utf8"));
  const phase = report.sourceManifest.providerPreflight.phases[0];
  const auditRef = phase.handshake.controlPlaneAudit;
  const audit = JSON.parse(await readFile(auditRef.path, "utf8"));
  audit.nonce = "0".repeat(32);
  await writeJson(auditRef.path, audit);
  const auditRaw = await readFile(auditRef.path);
  auditRef.bytes = auditRaw.byteLength;
  auditRef.sha256 = sha256(auditRaw);
  phase.handshake.controlPlaneAudit = auditRef;
  await writeJson(phase.outputPath, phase.handshake);
  const outputRaw = await readFile(phase.outputPath);
  phase.outputBytes = outputRaw.byteLength;
  phase.outputSha256 = sha256(outputRaw);
  report.manifest.providerPreflight = cloneJson(report.sourceManifest.providerPreflight);
  report.jobs[0].providerRoute.actual.preflight = cloneJson(report.sourceManifest.providerPreflight);
  report.manifest.hash = stableJsonSha256(report.sourceManifest);
  report.jobs[0].providerRoute.actual.preflight = cloneJson(report.sourceManifest.providerPreflight.phases);
  report.validation = validateSweBenchBatchReport({
    manifest: report.sourceManifest,
    report,
    artifactBaseDir: path.dirname(reportFile),
  });
  await writeJson(reportFile, report);
}

async function writeDraftRun(runRoot: string) {
  const draft = {
    schemaVersion: 1,
    generator: "scripts/rehearse-disposable-draft-pr.ts#rehearseDisposableDraftPr",
    generatedAt: new Date().toISOString(),
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
    cleanup: { pullRequestClosed: true, branchDeleted: true },
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
  const file = path.join(runRoot, "draft-pr-rehearsal.json");
  await writeJson(file, draft);
  return file;
}

async function leaveCommittedProviderCleanup(
  root: string,
  runRoot: string,
  reportFile: string,
  runId: string,
) {
  let failRelease = true;
  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId,
    afterPhaseForTest(phase) {
      if (phase === "before-run-lock-cleanup" && failRelease) {
        failRelease = false;
        throw new Error("leave committed cleanup evidence");
      }
    },
  });
  assert.equal(result.committed, true);
  assert.equal(result.outcome, "committed_cleanup_required");
  assert.ok(result.receipt);
  return result;
}

function fileGeneration(details: Awaited<ReturnType<typeof lstat>>) {
  return {
    dev: details.dev,
    ino: details.ino,
    size: details.size,
    mtimeMs: details.mtimeMs,
    ctimeMs: details.ctimeMs,
    birthtimeMs: details.birthtimeMs,
  };
}

test("promotes provider-only evidence into a unique repo-local run directory and preserves fragments", async () => {
  const root = await tempRoot("cpb-promote-root");
  const runRoot = await tempRoot("cpb-promote-run");
  const { reportFile } = await writeProviderRun(runRoot);

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId: "provider-success",
  });

  assert.equal(result.ok, true);
  assert.equal(result.liveReleaseEvidenceFile, null);
  assert.equal(result.providerEvidenceFile, "docs/product/evidence/live-release/runs/provider-success/provider-connectivity.json");
  const promoted = JSON.parse(await readFile(path.join(root, result.providerEvidenceFile!), "utf8"));
  const preparePath = promoted.jobs[0].phaseEvidence.prepare_task.structuredOutputPath;
  assert.match(preparePath, /#riskmap_generated$/);
  assert.match(preparePath, /^docs\/product\/evidence\/live-release\/runs\/provider-success\/artifacts\//);
  const phase = promoted.sourceManifest.providerPreflight.phases[0];
  assert.match(phase.outputPath, /^docs\/product\/evidence\/live-release\/runs\/provider-success\/artifacts\//);
  assert.match(phase.handshake.controlPlaneAudit.path, /^docs\/product\/evidence\/live-release\/runs\/provider-success\/artifacts\//);
  assert.match(phase.handshake.controlPlaneAudit.rawPath, /^docs\/product\/evidence\/live-release\/runs\/provider-success\/artifacts\//);
  const outputRaw = await readFile(path.join(root, phase.outputPath));
  assert.equal(outputRaw.byteLength, phase.outputBytes);
  assert.equal(sha256(outputRaw), phase.outputSha256);
  assert.deepEqual(JSON.parse(outputRaw.toString("utf8")), phase.handshake);
  const auditArtifact = JSON.parse(await readFile(path.join(root, phase.handshake.controlPlaneAudit.path), "utf8"));
  assert.equal(auditArtifact.jobIdentity.outputPathSha256, sha256(phase.outputPath));
});

test("rejects internally consistent multi-job provider-only bundles before publishing", async () => {
  const root = await tempRoot("cpb-promote-provider-two-job-root");
  const runRoot = await tempRoot("cpb-promote-provider-two-job-run");
  const { reportFile } = await writeProviderRun(runRoot);
  await rewriteReportAsTwoJobs(reportFile);

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId: "provider-two-job",
  });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((violation) => violation.path === "providerConnectivity"
    && /providerConnectivity\.jobs/.test(violation.reason)), JSON.stringify(result.violations, null, 2));
  await assert.rejects(
    () => lstat(path.join(root, "docs/product/evidence/live-release/runs/provider-two-job")),
    /ENOENT/,
  );
});

test("rejects top-level control-plane nonce mutation even when audit and output bindings are recomputed", async () => {
  const root = await tempRoot("cpb-promote-provider-nonce-root");
  const runRoot = await tempRoot("cpb-promote-provider-nonce-run");
  const { reportFile } = await writeProviderRun(runRoot);
  await mutateTopLevelAuditNonceAndRebind(reportFile);

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId: "provider-nonce-mutation",
  });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((violation) => /control-plane safety proof is missing or invalid|providerConnectivity/.test(violation.reason)),
    JSON.stringify(result.violations, null, 2));
  await assert.rejects(
    () => lstat(path.join(root, "docs/product/evidence/live-release/runs/provider-nonce-mutation")),
    /ENOENT/,
  );
});

test("rejects destination symlink escape before staging promotion output", async () => {
  const root = await tempRoot("cpb-promote-destination-root");
  const outside = await tempRoot("cpb-promote-destination-outside");
  await mkdir(path.join(root, "docs/product/evidence"), { recursive: true });
  await symlink(outside, path.join(root, "docs/product/evidence/live-release"));
  const runRoot = await tempRoot("cpb-promote-destination-run");
  const { reportFile } = await writeProviderRun(runRoot);

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId: "destination-symlink",
  });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((violation) => violation.path === "destination"
    && /repository/.test(violation.reason)));
});

test("rejects source artifact paths that escape the declared run root", async () => {
  const root = await tempRoot("cpb-promote-source-root");
  const runRoot = await tempRoot("cpb-promote-source-run");
  const outside = await tempRoot("cpb-promote-source-outside");
  const outsidePatch = await writeRaw(outside, "outside.patch", "diff --git a/x b/x\n");
  const { reportFile } = await writeProviderRun(runRoot);
  const report = JSON.parse(await readFile(reportFile, "utf8"));
  report.jobs[0].patch.path = outsidePatch.path;
  report.jobs[0].patch.bytes = outsidePatch.bytes;
  report.jobs[0].patch.sha256 = outsidePatch.sha256;
  await writeJson(reportFile, report);

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId: "source-escape",
  });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((violation) => violation.path === "jobs[0].patch.path"
    && /--run-root/.test(violation.reason)));
});

test("rejects source mutation when report bytes and sha no longer match", async () => {
  const root = await tempRoot("cpb-promote-mutation-root");
  const runRoot = await tempRoot("cpb-promote-mutation-run");
  const { reportFile, prepareFile } = await writeProviderRun(runRoot);
  await writeJson(prepareFile, { event: "riskmap_generated", assignmentId: "assignment-provider-promotion", ok: false });

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId: "source-mutation",
  });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((violation) => /\.(bytes|sha256)$/.test(violation.path)
    && /source artifact content/.test(violation.reason)));
});

test("rejects control-plane raw audit streams that no longer match the handshake binding", async () => {
  const root = await tempRoot("cpb-promote-raw-audit-mutation-root");
  const runRoot = await tempRoot("cpb-promote-raw-audit-mutation-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const report = JSON.parse(await readFile(reportFile, "utf8"));
  const auditRef = report.sourceManifest.providerPreflight.phases[0].handshake.controlPlaneAudit;
  await writeFile(auditRef.rawPath, `${JSON.stringify({ event: "agent_launch", ok: false })}\n`, "utf8");

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId: "raw-audit-mutation",
  });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((violation) => violation.path === "providerReport.validation"
    && /control-plane safety proof is missing or invalid/.test(violation.reason)), JSON.stringify(result.violations, null, 2));
});

test("copies draft evidence and writes the final manifest only after full verifier passes", async () => {
  const root = await tempRoot("cpb-promote-full-root");
  await copyProductEvidence(root);
  const runRoot = await tempRoot("cpb-promote-full-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const draftFile = await writeDraftRun(runRoot);

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    draftRehearsal: draftFile,
    runId: "full-success",
  });

  assert.equal(result.ok, true);
  assert.equal(result.liveReleaseEvidenceFile, "docs/product/cpb-live-release-validation.json");
  const manifest = JSON.parse(await readFile(path.join(root, result.liveReleaseEvidenceFile!), "utf8"));
  assert.equal(manifest.providerConnectivity.evidenceBundleRef, result.providerEvidenceFile);
  assert.equal(manifest.draftPrRehearsal.evidenceBundleRef, result.draftPrEvidenceFile);
});

test("finalizes a verified provider-only run with the same run id", async () => {
  const root = await tempRoot("cpb-promote-two-stage-root");
  await copyProductEvidence(root);
  const runRoot = await tempRoot("cpb-promote-two-stage-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const draftFile = await writeDraftRun(runRoot);

  const providerOnly = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId: "two-stage",
  });
  assert.equal(providerOnly.ok, true);
  const providerPath = path.join(root, providerOnly.providerEvidenceFile!);
  const providerSha = sha256(await readFile(providerPath));

  const finalized = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    draftRehearsal: draftFile,
    runId: "two-stage",
  });

  assert.equal(finalized.ok, true);
  assert.equal(finalized.providerEvidenceFile, providerOnly.providerEvidenceFile);
  assert.equal(sha256(await readFile(providerPath)), providerSha);
  assert.equal(finalized.draftPrEvidenceFile, "docs/product/evidence/live-release/runs/two-stage/draft-pr-rehearsal.json");
  const manifest = JSON.parse(await readFile(path.join(root, finalized.liveReleaseEvidenceFile!), "utf8"));
  assert.equal(manifest.providerConnectivity.evidenceBundleRef, providerOnly.providerEvidenceFile);
  assert.equal(manifest.draftPrRehearsal.evidenceBundleRef, finalized.draftPrEvidenceFile);
});

test("serializes concurrent provider-only publication for the same run id", async () => {
  const root = await tempRoot("cpb-promote-concurrent-provider-root");
  const runRoot = await tempRoot("cpb-promote-concurrent-provider-run");
  const { reportFile } = await writeProviderRun(runRoot);

  const results = await Promise.all([
    promoteLiveReleaseEvidence({
      root,
      runRoot,
      providerReport: reportFile,
      providerOnly: true,
      runId: "concurrent-provider",
    }),
    promoteLiveReleaseEvidence({
      root,
      runRoot,
      providerReport: reportFile,
      providerOnly: true,
      runId: "concurrent-provider",
    }),
  ]);

  assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results, null, 2));
  assert.equal(results.filter((result) => !result.ok).length, 1);
  assert.ok(results.find((result) => !result.ok)?.violations.some((violation) => violation.path === "destination"
    && /already exists/.test(violation.reason)), JSON.stringify(results, null, 2));
  const entries = await readdir(path.join(root, "docs/product/evidence/live-release/runs"));
  assert.ok(entries.includes("concurrent-provider"));
  assert.equal(entries.some((entry) => /staging-\d+-\d+/.test(entry)), false);
  assert.equal(entries.some((entry) => entry === ".concurrent-provider.publish.lock"), false);
});

test("allows only one concurrent provider-only to full finalization to publish draft evidence", async () => {
  const root = await tempRoot("cpb-promote-concurrent-final-root");
  await copyProductEvidence(root);
  const runRoot = await tempRoot("cpb-promote-concurrent-final-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const draftFile = await writeDraftRun(runRoot);
  const providerOnly = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId: "concurrent-final",
  });
  assert.equal(providerOnly.ok, true);

  const results = await Promise.all([
    promoteLiveReleaseEvidence({
      root,
      runRoot,
      providerReport: reportFile,
      draftRehearsal: draftFile,
      runId: "concurrent-final",
    }),
    promoteLiveReleaseEvidence({
      root,
      runRoot,
      providerReport: reportFile,
      draftRehearsal: draftFile,
      runId: "concurrent-final",
    }),
  ]);

  assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results, null, 2));
  assert.equal(results.filter((result) => !result.ok).length, 1);
  assert.ok(results.find((result) => !result.ok)?.violations.some((violation) => violation.path === "destination"
    && /draft evidence|destination already exists/.test(violation.reason)), JSON.stringify(results, null, 2));
  const draftPath = path.join(root, "docs/product/evidence/live-release/runs/concurrent-final/draft-pr-rehearsal.json");
  assert.equal(sha256(await readFile(draftPath)), sha256(await readFile(draftFile)));
  const manifest = JSON.parse(await readFile(path.join(root, "docs/product/cpb-live-release-validation.json"), "utf8"));
  assert.equal(manifest.draftPrRehearsal.evidenceBundleRef, "docs/product/evidence/live-release/runs/concurrent-final/draft-pr-rehearsal.json");
});

test("serializes concurrent provider-only publication and full promotion for a new run", async () => {
  const root = await tempRoot("cpb-promote-provider-full-race-root");
  await copyProductEvidence(root);
  const runRoot = await tempRoot("cpb-promote-provider-full-race-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const draftFile = await writeDraftRun(runRoot);

  const [providerResult, fullResult] = await Promise.all([
    promoteLiveReleaseEvidence({
      root,
      runRoot,
      providerReport: reportFile,
      providerOnly: true,
      runId: "provider-full-race",
    }),
    promoteLiveReleaseEvidence({
      root,
      runRoot,
      providerReport: reportFile,
      draftRehearsal: draftFile,
      runId: "provider-full-race",
    }),
  ]);

  assert.equal(fullResult.ok, true, JSON.stringify(fullResult.violations));
  assert.equal(fullResult.committed, true);
  assert.ok(providerResult.ok || providerResult.violations.some((violation) => violation.path === "destination"));
  const manifest = JSON.parse(await readFile(path.join(root, fullResult.liveReleaseEvidenceFile!), "utf8"));
  assert.equal(manifest.providerConnectivity.evidenceBundleRef, fullResult.providerEvidenceFile);
  assert.equal(manifest.draftPrRehearsal.evidenceBundleRef, fullResult.draftPrEvidenceFile);
  const entries = await readdir(path.join(root, "docs/product/evidence/live-release/runs"));
  assert.equal(entries.some((entry) => entry.includes("provider-full-race") && entry.endsWith(".lock")), false);
  const receiptEntry = entries.find((entry) => entry.includes("provider-full-race") && entry.includes("promotion-receipt"));
  assert.ok(receiptEntry);
  const durableReceipt = JSON.parse(await readFile(
    path.join(root, "docs/product/evidence/live-release/runs", receiptEntry),
    "utf8",
  ));
  assert.equal(durableReceipt.state, "committed-clean");
});

test("reports committed manifest cleanup failure and recovers it on same-run retry", async () => {
  const root = await tempRoot("cpb-promote-committed-cleanup-root");
  await copyProductEvidence(root);
  const runRoot = await tempRoot("cpb-promote-committed-cleanup-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const draftFile = await writeDraftRun(runRoot);
  let cleanupFailures = 0;

  const first = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    draftRehearsal: draftFile,
    runId: "committed-cleanup",
    afterPhaseForTest(phase) {
      if (phase === "before-candidate-marker-cleanup" && cleanupFailures < 2) {
        cleanupFailures += 1;
        throw new Error("injected candidate owner cleanup failure");
      }
    },
  });

  assert.equal(first.ok, false);
  assert.equal(first.committed, true);
  assert.equal(first.outcome, "committed_cleanup_required");
  assert.ok(first.receipt);
  assert.ok(first.residuals.some((residual) => residual.kind === "candidate-owner"));
  assert.deepEqual(first.recoveryPaths, first.residuals.map((residual) => residual.path));
  assert.ok(first.violations.some((violation) => /committed publication cleanup failed/.test(violation.reason)));
  await lstat(path.join(root, first.liveReleaseEvidenceFile!));
  await lstat(path.join(root, first.receipt.cleanupReceiptFile));

  const recovered = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    draftRehearsal: draftFile,
    runId: "committed-cleanup",
  });

  assert.equal(recovered.ok, true, JSON.stringify(recovered.violations));
  assert.equal(recovered.committed, true);
  assert.equal(recovered.outcome, "committed");
  assert.equal(recovered.recoveredCleanup, true);
  assert.deepEqual(recovered.residuals, []);
  const durableReceipt = JSON.parse(await readFile(path.join(root, first.receipt!.cleanupReceiptFile), "utf8"));
  assert.equal(durableReceipt.state, "committed-clean");
});

test("candidate marker cleanup preserves a same-path isolated successor at the raw removal boundary", async () => {
  const root = await tempRoot("cpb-promote-marker-removal-successor-root");
  await copyProductEvidence(root);
  const runRoot = await tempRoot("cpb-promote-marker-removal-successor-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const draftFile = await writeDraftRun(runRoot);
  let isolatedPath = "";
  let predecessorPath = "";
  let attacked = false;

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    draftRehearsal: draftFile,
    runId: "marker-removal-successor",
    async beforeCleanupRemovalForTest(context) {
      if (attacked || context.kind !== "candidate.owner") return;
      attacked = true;
      isolatedPath = context.isolatedPath;
      predecessorPath = `${isolatedPath}.owned-predecessor`;
      await rename(isolatedPath, predecessorPath);
      await writeFile(isolatedPath, "preserve isolated marker successor\n", "utf8");
    },
  });

  assert.equal(attacked, true);
  assert.equal(result.ok, false);
  assert.equal(result.committed, true);
  assert.equal(result.outcome, "committed_cleanup_required");
  assert.ok(result.recoveryPaths.includes(isolatedPath), JSON.stringify(result, null, 2));
  assert.match(
    result.violations.map((violation) => violation.reason).join("\n"),
    /final removal boundary|generation changed/,
  );
  assert.equal(await readFile(isolatedPath, "utf8"), "preserve isolated marker successor\n");
  assert.equal((await lstat(predecessorPath)).isFile(), true);
});

test("promotion preserves primary transaction and hostile raw-cleanup failures together", async () => {
  const root = await tempRoot("cpb-promote-cleanup-dual-failure-root");
  await copyProductEvidence(root);
  const runRoot = await tempRoot("cpb-promote-cleanup-dual-failure-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const draftFile = await writeDraftRun(runRoot);
  let isolatedPath = "";
  let attacked = false;

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    draftRehearsal: draftFile,
    runId: "cleanup-dual-failure",
    afterPhaseForTest(phase) {
      if (phase === "before-manifest-commit") {
        throw new Error("primary promotion failure marker");
      }
    },
    async beforeCleanupRemovalForTest(context) {
      if (attacked || context.kind !== "candidate" || context.entryType !== "file") return;
      attacked = true;
      isolatedPath = context.isolatedPath;
      await rename(isolatedPath, `${isolatedPath}.owned-predecessor`);
      await writeFile(isolatedPath, "preserve cleanup successor\n", "utf8");
    },
  });

  const reasons = result.violations.map((violation) => violation.reason).join("\n");
  assert.equal(attacked, true);
  assert.equal(result.ok, false);
  assert.match(reasons, /primary promotion failure marker/);
  assert.match(reasons, /final removal boundary|generation changed/);
  assert.ok(result.recoveryPaths.includes(isolatedPath), JSON.stringify(result, null, 2));
  assert.equal(await readFile(isolatedPath, "utf8"), "preserve cleanup successor\n");
});

test("run-lock directory cleanup preserves a same-path isolated successor", async () => {
  const root = await tempRoot("cpb-promote-directory-removal-successor-root");
  const runRoot = await tempRoot("cpb-promote-directory-removal-successor-run");
  const { reportFile } = await writeProviderRun(runRoot);
  let isolatedPath = "";
  let predecessorPath = "";
  let sentinelPath = "";

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId: "directory-removal-successor",
    async beforeCleanupRemovalForTest(context) {
      if (isolatedPath || context.kind !== "run-lock" || context.entryType !== "directory") return;
      isolatedPath = context.isolatedPath;
      predecessorPath = `${isolatedPath}.owned-predecessor`;
      sentinelPath = path.join(isolatedPath, "successor.txt");
      await rename(isolatedPath, predecessorPath);
      await mkdir(isolatedPath);
      await writeFile(sentinelPath, "preserve isolated directory successor\n", "utf8");
    },
  });

  assert.notEqual(isolatedPath, "");
  assert.equal(result.ok, false);
  assert.equal(result.committed, true);
  assert.equal(result.outcome, "committed_cleanup_required");
  assert.ok(result.recoveryPaths.includes(isolatedPath), JSON.stringify(result, null, 2));
  assert.equal(await readFile(sentinelPath, "utf8"), "preserve isolated directory successor\n");
  assert.equal((await lstat(predecessorPath)).isDirectory(), true);
});

test("rollback owner-marker cleanup preserves a same-path isolated successor", async () => {
  const root = await tempRoot("cpb-promote-owned-marker-successor-root");
  await copyProductEvidence(root);
  const runRoot = await tempRoot("cpb-promote-owned-marker-successor-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const draftFile = await writeDraftRun(runRoot);
  let isolatedPath = "";
  let predecessorPath = "";

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    draftRehearsal: draftFile,
    runId: "owned-marker-successor",
    afterPhaseForTest(phase) {
      if (phase === "before-manifest-commit") throw new Error("force owner-marker rollback");
    },
    async beforeCleanupRemovalForTest(context) {
      if (isolatedPath
        || context.kind !== "candidate"
        || context.entryType !== "file"
        || !context.canonicalPath.endsWith(".owner.json")) return;
      isolatedPath = context.isolatedPath;
      predecessorPath = `${isolatedPath}.owned-predecessor`;
      await rename(isolatedPath, predecessorPath);
      await writeFile(isolatedPath, "preserve isolated owner-marker successor\n", "utf8");
    },
  });

  const reasons = result.violations.map((violation) => violation.reason).join("\n");
  assert.notEqual(isolatedPath, "");
  assert.match(reasons, /force owner-marker rollback/);
  assert.match(reasons, /final removal boundary|generation changed/);
  assert.ok(result.recoveryPaths.includes(isolatedPath), JSON.stringify(result, null, 2));
  assert.equal(await readFile(isolatedPath, "utf8"), "preserve isolated owner-marker successor\n");
  assert.equal((await lstat(predecessorPath)).isFile(), true);
});

test("new-file rollback keeps committed cleanup failure after canonical paths disappear", async () => {
  const root = await tempRoot("cpb-promote-new-file-successor-root");
  await copyProductEvidence(root);
  const runRoot = await tempRoot("cpb-promote-new-file-successor-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const draftFile = await writeDraftRun(runRoot);
  let isolatedPath = "";
  let predecessorPath = "";

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    draftRehearsal: draftFile,
    runId: "new-file-successor",
    afterPhaseForTest(phase) {
      if (phase === "candidate-owner-marker-initialized") {
        throw new Error("force newly-created file rollback");
      }
    },
    async beforeCleanupRemovalForTest(context) {
      if (isolatedPath
        || context.kind !== "candidate"
        || context.entryType !== "file"
        || context.canonicalPath.endsWith(".cpb-promotion-owner.json")) return;
      isolatedPath = context.isolatedPath;
      predecessorPath = `${isolatedPath}.owned-predecessor`;
      await rename(isolatedPath, predecessorPath);
      await writeFile(isolatedPath, "preserve newly-created file successor\n", "utf8");
    },
  });

  const reasons = result.violations.map((violation) => violation.reason).join("\n");
  assert.notEqual(isolatedPath, "");
  assert.match(reasons, /force newly-created file rollback/);
  assert.match(reasons, /final removal boundary|generation changed/);
  assert.ok(result.recoveryPaths.includes(isolatedPath), JSON.stringify(result, null, 2));
  assert.equal(await readFile(isolatedPath, "utf8"), "preserve newly-created file successor\n");
  assert.equal((await lstat(predecessorPath)).isFile(), true);
});

test("raw cleanup fsync failure never reports the already-removed isolated file as recoverable", async () => {
  const root = await tempRoot("cpb-promote-removal-durability-root");
  await copyProductEvidence(root);
  const runRoot = await tempRoot("cpb-promote-removal-durability-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const draftFile = await writeDraftRun(runRoot);
  let isolatedPath = "";
  let cleanupContainer = "";
  let failContainerSync = false;

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    draftRehearsal: draftFile,
    runId: "removal-durability",
    afterPhaseForTest(phase) {
      if (phase === "candidate-owner-marker-initialized") {
        throw new Error("primary before cleanup durability failure");
      }
    },
    beforeCleanupRemovalForTest(context) {
      if (isolatedPath || context.kind !== "candidate" || context.entryType !== "file") return;
      isolatedPath = context.isolatedPath;
      cleanupContainer = context.cleanupContainer;
      failContainerSync = true;
    },
    async syncDirectoryForTest(directory) {
      if (failContainerSync && path.resolve(directory) === path.resolve(cleanupContainer)) {
        failContainerSync = false;
        throw Object.assign(new Error("injected raw removal container fsync failure"), { code: "EIO" });
      }
    },
  });

  const reasons = result.violations.map((violation) => violation.reason).join("\n");
  assert.notEqual(isolatedPath, "");
  assert.equal(failContainerSync, false);
  assert.match(reasons, /primary before cleanup durability failure/);
  assert.match(reasons, /removal committed but durability is ambiguous/);
  await assert.rejects(() => lstat(isolatedPath), /ENOENT/);
  assert.equal((await lstat(cleanupContainer)).isDirectory(), true);
  assert.ok(result.recoveryPaths.includes(cleanupContainer), JSON.stringify(result, null, 2));
  assert.equal(result.recoveryPaths.includes(isolatedPath), false, JSON.stringify(result, null, 2));
});

test("provider-only lock cleanup failure is committed, nonzero, and retryable", async () => {
  const root = await tempRoot("cpb-promote-provider-lock-cleanup-root");
  const runRoot = await tempRoot("cpb-promote-provider-lock-cleanup-run");
  const { reportFile } = await writeProviderRun(runRoot);
  let failCleanup = true;

  const first = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId: "provider-lock-cleanup",
    afterPhaseForTest(phase) {
      if (phase === "before-run-lock-cleanup" && failCleanup) {
        failCleanup = false;
        throw new Error("injected run lock release failure");
      }
    },
  });

  assert.equal(first.ok, false);
  assert.equal(first.committed, true);
  assert.equal(first.outcome, "committed_cleanup_required");
  assert.ok(first.residuals.some((residual) => residual.kind === "run-lock"));
  assert.ok(first.recoveryPaths.some((recoveryPath) => recoveryPath.endsWith(".provider-lock-cleanup.publish.lock")));
  await lstat(path.join(root, first.providerEvidenceFile!));

  const recovered = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId: "provider-lock-cleanup",
  });
  assert.equal(recovered.ok, true, JSON.stringify(recovered.violations));
  assert.equal(recovered.committed, true);
  assert.equal(recovered.recoveredCleanup, true);
});

test("cleanup receipt symlink is rejected before committed takeover", async () => {
  const root = await tempRoot("cpb-promote-receipt-symlink-root");
  const runRoot = await tempRoot("cpb-promote-receipt-symlink-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const first = await leaveCommittedProviderCleanup(root, runRoot, reportFile, "receipt-symlink");
  const receiptPath = path.join(root, first.receipt!.cleanupReceiptFile);
  const outsideRoot = await tempRoot("cpb-promote-receipt-symlink-outside");
  const outsideReceipt = path.join(outsideRoot, "receipt.json");
  await copyFile(receiptPath, outsideReceipt);
  const outsideDigest = sha256(await readFile(outsideReceipt));
  await rm(receiptPath);
  await symlink(outsideReceipt, receiptPath);
  let takeoverObserved = false;

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId: "receipt-symlink",
    afterPhaseForTest(phase) {
      if (phase === "after-committed-cleanup-takeover") takeoverObserved = true;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(takeoverObserved, false);
  assert.ok(result.recoveryPaths.includes(receiptPath), JSON.stringify(result, null, 2));
  assert.match(result.violations.map((violation) => violation.reason).join("\n"), /symbolic|regular file|safely/i);
  assert.equal((await lstat(receiptPath)).isSymbolicLink(), true);
  assert.equal(sha256(await readFile(outsideReceipt)), outsideDigest);
});

test("oversized lock owner is rejected with bounded recovery metadata", async () => {
  const root = await tempRoot("cpb-promote-owner-oversize-root");
  const runRoot = await tempRoot("cpb-promote-owner-oversize-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const first = await leaveCommittedProviderCleanup(root, runRoot, reportFile, "owner-oversize");
  const lockDirectory = path.join(root, "docs/product/evidence/live-release/runs/.owner-oversize.publish.lock");
  const markerPath = path.join(lockDirectory, ".cpb-promotion-owner.json");
  await writeFile(markerPath, "x".repeat(64 * 1024 + 1), "utf8");

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId: "owner-oversize",
    lockIdentityForTest: processIdentity(47001, "replacement"),
    captureLockIdentityForTest: () => null,
    lockTimeoutMsForTest: 250,
  });

  assert.equal(result.ok, false);
  assert.equal(result.committed, true);
  assert.ok(result.recoveryPaths.includes(markerPath), JSON.stringify(result, null, 2));
  assert.match(result.violations.map((violation) => violation.reason).join("\n"), /exceeds 65536 byte limit/i);
  assert.equal((await lstat(markerPath)).size, 64 * 1024 + 1);
});

test("lock owner bounded read rejects same-content path replacement after descriptor read", async () => {
  const root = await tempRoot("cpb-promote-owner-generation-root");
  const runRoot = await tempRoot("cpb-promote-owner-generation-run");
  const { reportFile } = await writeProviderRun(runRoot);
  await leaveCommittedProviderCleanup(root, runRoot, reportFile, "owner-generation");
  const lockDirectory = path.join(root, "docs/product/evidence/live-release/runs/.owner-generation.publish.lock");
  const markerPath = path.join(lockDirectory, ".cpb-promotion-owner.json");
  const displacedMarker = `${markerPath}.displaced`;
  const markerBytes = await readFile(markerPath);
  let replaced = false;
  const options = {
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId: "owner-generation",
    lockIdentityForTest: processIdentity(47002, "replacement"),
    captureLockIdentityForTest: () => null,
    lockTimeoutMsForTest: 250,
    boundedReadHooksForTest: {
      async beforePathGenerationCheck({ filePath }: { filePath: string }) {
        if (replaced || filePath !== markerPath) return;
        replaced = true;
        await rename(markerPath, displacedMarker);
        await writeFile(markerPath, markerBytes);
      },
    },
  };

  const result = await promoteLiveReleaseEvidence(options);

  assert.equal(replaced, true);
  assert.equal(result.ok, false);
  assert.equal(result.committed, true);
  assert.ok(result.recoveryPaths.includes(markerPath), JSON.stringify(result, null, 2));
  assert.match(result.violations.map((violation) => violation.reason).join("\n"), /changed|generation/i);
  assert.deepEqual(await readFile(markerPath), markerBytes);
  assert.deepEqual(await readFile(displacedMarker), markerBytes);
});

test("stale quarantine preserves a same-token same-generation ABA replacement", async () => {
  const root = await tempRoot("cpb-promote-quarantine-same-token-root");
  const runRoot = await tempRoot("cpb-promote-quarantine-same-token-run");
  const { reportFile } = await writeProviderRun(runRoot);
  await leaveCommittedProviderCleanup(root, runRoot, reportFile, "quarantine-same-token");
  let replacementDirectory = "";
  let sentinelPath = "";

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId: "quarantine-same-token",
    lockIdentityForTest: processIdentity(47003, "replacement"),
    captureLockIdentityForTest: () => null,
    async afterPhaseForTest(phase, context) {
      if (phase !== "after-stale-lock-quarantine" || context.kind !== "run-lock") return;
      replacementDirectory = context.quarantinedDirectory;
      const markerPath = path.join(replacementDirectory, ".cpb-promotion-owner.json");
      const originalMarker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
      await rm(replacementDirectory, { recursive: true });
      await mkdir(replacementDirectory);
      sentinelPath = path.join(replacementDirectory, "successor-sentinel.txt");
      await writeFile(sentinelPath, "same-token ABA successor\n", "utf8");
      await writeFile(markerPath, "", "utf8");
      const replacementDetails = await lstat(replacementDirectory);
      await writeFile(markerPath, `${JSON.stringify({
        ...originalMarker,
        identity: fileGeneration(replacementDetails),
      }, null, 2)}\n`, "utf8");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.committed, true);
  assert.ok(result.recoveryPaths.includes(replacementDirectory), JSON.stringify(result, null, 2));
  assert.equal(await readFile(sentinelPath, "utf8"), "same-token ABA successor\n");
  assert.match(result.violations.map((violation) => violation.reason).join("\n"), /generation|identity|preserv/i);
});

test("committed receipt takeover runs only while the new run-lock generation is held", async () => {
  const root = await tempRoot("cpb-promote-takeover-lock-root");
  await copyProductEvidence(root);
  const runRoot = await tempRoot("cpb-promote-takeover-lock-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const draftFile = await writeDraftRun(runRoot);
  let cleanupFailures = 0;
  const first = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    draftRehearsal: draftFile,
    runId: "takeover-lock",
    afterPhaseForTest(phase) {
      if (phase === "before-candidate-marker-cleanup" && cleanupFailures < 2) {
        cleanupFailures += 1;
        throw new Error("leave committed cleanup receipt");
      }
    },
  });
  assert.equal(first.outcome, "committed_cleanup_required");
  let takeoverObserved = false;

  const recovered = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    draftRehearsal: draftFile,
    runId: "takeover-lock",
    async afterPhaseForTest(phase, context) {
      if (phase !== "after-committed-cleanup-takeover") return;
      const marker = JSON.parse(await readFile(path.join(context.lockDirectory, ".cpb-promotion-owner.json"), "utf8"));
      assert.equal(marker.generation, context.generation);
      takeoverObserved = true;
    },
  });

  assert.equal(recovered.ok, true, JSON.stringify(recovered.violations));
  assert.equal(recovered.recoveredCleanup, true);
  assert.equal(takeoverObserved, true);
});

test("stale-lock quarantine fences a concurrent cleaner and third successor", async () => {
  const root = await tempRoot("cpb-promote-cleaner-aba-root");
  const runRoot = await tempRoot("cpb-promote-cleaner-aba-run");
  const { reportFile } = await writeProviderRun(runRoot);
  let failRelease = true;
  const first = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId: "cleaner-aba",
    afterPhaseForTest(phase) {
      if (phase === "before-run-lock-cleanup" && failRelease) {
        failRelease = false;
        throw new Error("leave stale run lock");
      }
    },
  });
  assert.equal(first.outcome, "committed_cleanup_required");
  const providerHash = sha256(await readFile(path.join(root, first.providerEvidenceFile!)));
  let releaseQuarantine!: () => void;
  const quarantineHeld = new Promise<void>((resolve) => { releaseQuarantine = resolve; });
  let quarantineObserved!: () => void;
  const quarantined = new Promise<void>((resolve) => { quarantineObserved = resolve; });
  const cleaner = promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId: "cleaner-aba",
    async afterPhaseForTest(phase, context) {
      if (phase !== "after-stale-lock-quarantine" || context.kind !== "run-lock") return;
      quarantineObserved();
      await quarantineHeld;
    },
  });
  await Promise.race([
    quarantined,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stale lock was not quarantined")), 2_000)),
  ]);
  let successorSettled = false;
  const successor = promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId: "cleaner-aba",
  }).finally(() => { successorSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(successorSettled, false, "third successor must remain fenced while quarantine is open");
  releaseQuarantine();
  const [cleanerResult, successorResult] = await Promise.all([cleaner, successor]);

  assert.equal(cleanerResult.ok, true, JSON.stringify(cleanerResult.violations));
  assert.equal(cleanerResult.recoveredCleanup, true);
  assert.equal(successorResult.ok, false);
  assert.equal(sha256(await readFile(path.join(root, first.providerEvidenceFile!))), providerHash);
  const entries = await readdir(path.join(root, "docs/product/evidence/live-release/runs"));
  assert.equal(entries.some((entry) => entry.includes("cleaner-aba") && entry.includes("cleanup.")), false);
});

test("dead and PID-reused lock owners are recovered by full process identity", async (t) => {
  for (const mode of ["dead", "pid-reused"] as const) {
    await t.test(mode, async () => {
      const root = await tempRoot(`cpb-promote-${mode}-owner-root`);
      const runRoot = await tempRoot(`cpb-promote-${mode}-owner-run`);
      const { reportFile } = await writeProviderRun(runRoot);
      const original = processIdentity(41001, "original");
      let failRelease = true;
      const first = await promoteLiveReleaseEvidence({
        root,
        runRoot,
        providerReport: reportFile,
        providerOnly: true,
        runId: `${mode}-owner`,
        lockIdentityForTest: original,
        captureLockIdentityForTest: () => original,
        afterPhaseForTest(phase) {
          if (phase === "before-run-lock-cleanup" && failRelease) {
            failRelease = false;
            throw new Error("leave simulated crashed lock");
          }
        },
      });
      assert.equal(first.outcome, "committed_cleanup_required");
      const replacement = processIdentity(42001, "replacement");
      const recovered = await promoteLiveReleaseEvidence({
        root,
        runRoot,
        providerReport: reportFile,
        providerOnly: true,
        runId: `${mode}-owner`,
        lockIdentityForTest: replacement,
        captureLockIdentityForTest: (pid) => mode === "dead"
          ? null
          : processIdentity(pid, "reused-incarnation"),
      });
      assert.equal(recovered.ok, true, JSON.stringify(recovered.violations));
      assert.equal(recovered.recoveredCleanup, true);
    });
  }
});

test("a SIGKILLed publisher cannot permanently retain the run lock", async () => {
  const root = await tempRoot("cpb-promote-sigkill-lock-root");
  const runRoot = await tempRoot("cpb-promote-sigkill-lock-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const lockDirectory = path.join(root, "docs/product/evidence/live-release/runs/.sigkill-owner.publish.lock");
  const childScript = `
    import { lstat, mkdir, writeFile } from "node:fs/promises";
    import { createServer } from "node:net";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const directory = ${JSON.stringify(lockDirectory)};
    await mkdir(directory, { recursive: true });
    const markerPath = path.join(directory, ".cpb-promotion-owner.json");
    await writeFile(markerPath, "");
    const details = await lstat(directory);
    const processTreeModule = pathToFileURL(path.join(${JSON.stringify(repoRoot)}, "dist/core/runtime/process-tree.js")).href;
    const { captureProcessIdentity } = await import(processTreeModule);
    const processIdentity = captureProcessIdentity(process.pid, { strict: true });
    if (!processIdentity || processIdentity.birthIdPrecision !== "exact") {
      throw new Error("child could not capture exact production process identity");
    }
    const fence = createServer();
    fence.on("connection", (socket) => socket.end("CPB_PROMOTION_LOCK_FENCE_V1 sigkill-owner-token\\n"));
    await new Promise((resolve, reject) => {
      fence.once("error", reject);
      fence.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
    });
    const fencePort = fence.address().port;
    await writeFile(markerPath, JSON.stringify({
      schemaVersion: 1,
      generator: "scripts/promote-live-release-evidence.ts#ownerToken",
      kind: "run-lock",
      token: "sigkill-owner-token",
      generation: "sigkill-owner-generation",
      fencePort,
      identity: {
        dev: details.dev,
        ino: details.ino,
        size: details.size,
        mtimeMs: details.mtimeMs,
        ctimeMs: details.ctimeMs,
        birthtimeMs: details.birthtimeMs,
      },
      processIdentity,
    }));
    process.stdout.write("LOCKED\\n");
    await new Promise(() => {});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const reapChild = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await once(child, "exit").catch(() => undefined);
  };
  await new Promise<void>((resolve, reject) => {
    const fail = async (error: Error) => {
      clearTimeout(timeout);
      await reapChild();
      reject(error);
    };
    const timeout = setTimeout(() => {
      void fail(new Error(`publisher did not acquire its run lock; stderr=${stderr.trim() || "<empty>"}`));
    }, 15_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`publisher exited before SIGKILL: code=${code} signal=${signal}; stderr=${stderr.trim() || "<empty>"}`));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (!chunk.includes("LOCKED")) return;
      clearTimeout(timeout);
      resolve();
    });
  });
  assert.equal(child.kill("SIGKILL"), true);
  await once(child, "exit");

  const recovered = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId: "sigkill-owner",
  });
  assert.equal(recovered.ok, true, JSON.stringify(recovered.violations));
  await assert.rejects(
    () => lstat(lockDirectory),
    /ENOENT/,
  );
});

test("stale run-lock recovery does not treat an unrelated listener on the recorded port as owner proof", async () => {
  const root = await tempRoot("cpb-promote-unrelated-fence-root");
  const runRoot = await tempRoot("cpb-promote-unrelated-fence-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const original = processIdentity(45001, "original");
  let failRelease = true;
  const first = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId: "unrelated-fence",
    lockIdentityForTest: original,
    captureLockIdentityForTest: () => original,
    afterPhaseForTest(phase) {
      if (phase === "before-run-lock-cleanup" && failRelease) {
        failRelease = false;
        throw new Error("leave lock for unrelated fence test");
      }
    },
  });
  assert.equal(first.outcome, "committed_cleanup_required");
  const lockDirectory = path.join(root, "docs/product/evidence/live-release/runs/.unrelated-fence.publish.lock");
  const marker = JSON.parse(await readFile(path.join(lockDirectory, ".cpb-promotion-owner.json"), "utf8")) as {
    fencePort: number;
  };
  const unrelated = createServer((socket) => socket.end("CPB_PROMOTION_LOCK_FENCE_V1 wrong-owner-token\n"));
  await new Promise<void>((resolve, reject) => {
    unrelated.once("error", reject);
    unrelated.listen({ host: "127.0.0.1", port: marker.fencePort, exclusive: true }, () => resolve());
  });
  try {
    const recovered = await promoteLiveReleaseEvidence({
      root,
      runRoot,
      providerReport: reportFile,
      providerOnly: true,
      runId: "unrelated-fence",
      lockIdentityForTest: currentExactProcessIdentity(),
      captureLockIdentityForTest: () => null,
      lockTimeoutMsForTest: 250,
    });
    assert.equal(recovered.ok, true, JSON.stringify(recovered.violations));
    assert.equal(recovered.recoveredCleanup, true);
  } finally {
    await new Promise<void>((resolve, reject) => unrelated.close((error) => error ? reject(error) : resolve()));
  }
});

test("lock identity probe and persisted identity defects fail closed", async (t) => {
  for (const mode of [
    "eperm",
    "io",
    "malformed",
    "coarse",
    "missing-precision",
    "bad-incarnation",
    "noncanonical-time",
    "unsafe-pid",
    "unsafe-process-group",
  ] as const) {
    await t.test(mode, async () => {
      const root = await tempRoot(`cpb-promote-${mode}-lock-root`);
      const runRoot = await tempRoot(`cpb-promote-${mode}-lock-run`);
      const { reportFile } = await writeProviderRun(runRoot);
      const original = processIdentity(43001, "original");
      let failRelease = true;
      const first = await promoteLiveReleaseEvidence({
        root,
        runRoot,
        providerReport: reportFile,
        providerOnly: true,
        runId: `${mode}-lock`,
        lockIdentityForTest: original,
        captureLockIdentityForTest: () => original,
        afterPhaseForTest(phase) {
          if (phase === "before-run-lock-cleanup" && failRelease) {
            failRelease = false;
            throw new Error("leave lock for fail-closed recovery");
          }
        },
      });
      assert.equal(first.committed, true);
      const lockDirectory = path.join(root, `docs/product/evidence/live-release/runs/.${mode}-lock.publish.lock`);
      const markerPath = path.join(lockDirectory, ".cpb-promotion-owner.json");
      if (mode === "malformed") {
        await writeFile(markerPath, "{not-json\n", "utf8");
      } else if ([
        "coarse",
        "missing-precision",
        "bad-incarnation",
        "noncanonical-time",
        "unsafe-pid",
        "unsafe-process-group",
      ].includes(mode)) {
        const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
          processIdentity: Record<string, unknown>;
        };
        if (mode === "coarse") marker.processIdentity.birthIdPrecision = "coarse";
        if (mode === "missing-precision") delete marker.processIdentity.birthIdPrecision;
        if (mode === "bad-incarnation") marker.processIdentity.incarnation = "43001:unrelated-successor";
        if (mode === "noncanonical-time") marker.processIdentity.capturedAt = "2026-07-21T00:00:00Z";
        if (mode === "unsafe-pid") {
          marker.processIdentity.pid = Number.MAX_SAFE_INTEGER + 1;
          marker.processIdentity.incarnation = `${Number.MAX_SAFE_INTEGER + 1}:${marker.processIdentity.birthId}`;
        }
        if (mode === "unsafe-process-group") marker.processIdentity.processGroupId = Number.MAX_SAFE_INTEGER + 1;
        await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
      }
      const result = await promoteLiveReleaseEvidence({
        root,
        runRoot,
        providerReport: reportFile,
        providerOnly: true,
        runId: `${mode}-lock`,
        lockIdentityForTest: processIdentity(44001, "replacement"),
        captureLockIdentityForTest: () => {
          if (mode === "eperm") throw Object.assign(new Error("identity permission denied"), { code: "EPERM" });
          if (mode === "io") throw Object.assign(new Error("identity read failed"), { code: "EIO" });
          return null;
        },
        lockTimeoutMsForTest: 250,
      });
      assert.equal(result.ok, false);
      assert.equal(result.committed, true);
      assert.equal(result.outcome, "committed_cleanup_required");
      await lstat(lockDirectory);
    });
  }
});

test("manifest rename failure retains its owner marker until candidate data cleanup succeeds", async () => {
  const root = await tempRoot("cpb-promote-manifest-rename-root");
  await copyProductEvidence(root);
  const runRoot = await tempRoot("cpb-promote-manifest-rename-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const draftFile = await writeDraftRun(runRoot);
  let candidateFile = "";
  let candidateMarker = "";

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    draftRehearsal: draftFile,
    runId: "manifest-rename-failure",
    async afterPhaseForTest(phase, context) {
      if (phase !== "before-manifest-commit") return;
      candidateFile = context.candidateFile;
      candidateMarker = context.candidateMarker;
      await mkdir(context.manifestFile);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.committed, false);
  await assert.rejects(() => lstat(candidateFile), /ENOENT/);
  await assert.rejects(() => lstat(candidateMarker), /ENOENT/);
  await assert.rejects(
    () => lstat(path.join(root, "docs/product/evidence/live-release/runs/manifest-rename-failure")),
    /ENOENT/,
  );
  await rm(path.join(root, "docs/product/cpb-live-release-validation.json"), { recursive: true });
});

test("manifest commit reports committed durability ambiguity after parent fsync failure and recovers on retry", async () => {
  const root = await tempRoot("cpb-promote-manifest-durability-root");
  await copyProductEvidence(root);
  const runRoot = await tempRoot("cpb-promote-manifest-durability-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const draftFile = await writeDraftRun(runRoot);
  const liveEvidenceDir = path.join(root, "docs/product");
  let failManifestParentSync = false;

  const first = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    draftRehearsal: draftFile,
    runId: "manifest-durability",
    afterPhaseForTest(phase) {
      if (phase === "before-manifest-commit") failManifestParentSync = true;
    },
    async syncDirectoryForTest(directory) {
      if (failManifestParentSync && path.resolve(directory) === path.resolve(liveEvidenceDir)) {
        failManifestParentSync = false;
        throw Object.assign(new Error("injected manifest parent fsync failure"), { code: "EIO" });
      }
    },
  });

  assert.equal(first.ok, false);
  assert.equal(first.committed, true);
  assert.equal(first.outcome, "committed_cleanup_required");
  assert.ok(first.receipt);
  assert.match(first.violations.map((violation) => violation.reason).join("\n"), /durability is ambiguous|injected manifest parent fsync failure/);
  await lstat(path.join(root, "docs/product/cpb-live-release-validation.json"));
  await lstat(path.join(root, first.receipt.cleanupReceiptFile));

  const recovered = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    draftRehearsal: draftFile,
    runId: "manifest-durability",
  });
  assert.equal(recovered.ok, true, JSON.stringify(recovered.violations));
  assert.equal(recovered.committed, true);
  assert.equal(recovered.outcome, "committed");
  assert.equal(recovered.recoveredCleanup, true);
});

test("missing candidate owner marker is a cleanup violation while data remains", async () => {
  const root = await tempRoot("cpb-promote-missing-candidate-owner-root");
  await copyProductEvidence(root);
  const runRoot = await tempRoot("cpb-promote-missing-candidate-owner-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const draftFile = await writeDraftRun(runRoot);
  let candidateFile = "";

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    draftRehearsal: draftFile,
    runId: "missing-candidate-owner",
    async afterPhaseForTest(phase, context) {
      if (phase !== "before-manifest-commit") return;
      candidateFile = context.candidateFile;
      await rm(context.candidateMarker);
      throw new Error("force rollback after removing candidate marker");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.committed, false);
  assert.ok(result.violations.some((violation) => /owner marker is missing while owned data still exists/.test(violation.reason)));
  await lstat(candidateFile);
});

test("candidate cleanup retries after a transient owner marker failure", async () => {
  const root = await tempRoot("cpb-promote-candidate-retry-root");
  await copyProductEvidence(root);
  const runRoot = await tempRoot("cpb-promote-candidate-retry-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const draftFile = await writeDraftRun(runRoot);
  let candidateFile = "";
  let candidateMarker = "";
  let repairDone: Promise<void> = Promise.resolve();

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    draftRehearsal: draftFile,
    runId: "candidate-cleanup-retry",
    async afterPhaseForTest(phase, context) {
      if (phase !== "before-manifest-commit") return;
      candidateFile = context.candidateFile;
      candidateMarker = context.candidateMarker;
      const markerBytes = await readFile(candidateMarker);
      await rm(candidateMarker);
      await mkdir(candidateMarker);
      repairDone = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          void rm(candidateMarker, { recursive: true })
            .then(() => writeFile(candidateMarker, markerBytes))
            .then(() => resolve(), reject);
        }, 5);
      });
      throw new Error("force rollback with transient candidate marker failure");
    },
  });
  await repairDone;

  assert.equal(result.ok, false);
  assert.equal(result.committed, false);
  assert.equal(result.violations.some((violation) => violation.path === "cleanup"), false);
  await assert.rejects(() => lstat(candidateFile), /ENOENT/);
  await assert.rejects(() => lstat(candidateMarker), /ENOENT/);
});

test("lock owner marker failure cleans the just-created lock directory", async () => {
  const root = await tempRoot("cpb-promote-lock-owner-root");
  const runRoot = await tempRoot("cpb-promote-lock-owner-run");
  const { reportFile } = await writeProviderRun(runRoot);
  let injected = false;

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId: "lock-owner-failure",
    async afterPhaseForTest(phase, context) {
      if (phase === "lock-directory-created" && context.kind === "run-lock" && !injected) {
        injected = true;
        await mkdir(context.markerPath);
      }
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.committed, false);
  await assert.rejects(
    () => lstat(path.join(root, "docs/product/evidence/live-release/runs/.lock-owner-failure.publish.lock")),
    /ENOENT/,
  );
  const entries = await readdir(path.join(root, "docs/product/evidence/live-release/runs"));
  assert.equal(entries.some((entry) => entry.includes("lock-owner-failure.staging")), false);
  const retried = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId: "lock-owner-failure",
  });
  assert.equal(retried.ok, true, JSON.stringify(retried.violations));
});

test("candidate owner marker initialization failure leaves no candidate orphan", async () => {
  const root = await tempRoot("cpb-promote-candidate-owner-init-root");
  await copyProductEvidence(root);
  const runRoot = await tempRoot("cpb-promote-candidate-owner-init-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const draftFile = await writeDraftRun(runRoot);
  let candidateFile = "";
  let candidateMarker = "";

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    draftRehearsal: draftFile,
    runId: "candidate-owner-init",
    afterPhaseForTest(phase, context) {
      if (phase !== "candidate-owner-marker-initialized") return;
      candidateFile = context.candidateFile;
      candidateMarker = context.candidateMarker;
      throw new Error("injected candidate owner marker initialization failure");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.committed, false);
  assert.equal(result.outcome, "not_committed");
  await assert.rejects(() => lstat(candidateFile), /ENOENT/);
  await assert.rejects(() => lstat(candidateMarker), /ENOENT/);
  await assert.rejects(
    () => lstat(path.join(root, "docs/product/evidence/live-release/runs/candidate-owner-init")),
    /ENOENT/,
  );
  const entries = await readdir(path.join(root, "docs/product/evidence/live-release/runs"));
  assert.equal(entries.some((entry) => entry.includes("candidate-owner-init") && entry.startsWith(".")), false);
});

test("rejects arbitrary prebuilt run directories during same-run finalization", async () => {
  const root = await tempRoot("cpb-promote-prebuilt-root");
  await copyProductEvidence(root);
  const runRoot = await tempRoot("cpb-promote-prebuilt-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const draftFile = await writeDraftRun(runRoot);
  await writeJson(
    path.join(root, "docs/product/evidence/live-release/runs/prebuilt/provider-connectivity.json"),
    { ok: true },
  );

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    draftRehearsal: draftFile,
    runId: "prebuilt",
  });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((violation) => violation.path === "destination"
    && /provider bundle content|provider-only promotion bundle/.test(violation.reason)));
  await assert.rejects(
    () => lstat(path.join(root, "docs/product/evidence/live-release/runs/prebuilt/draft-pr-rehearsal.json")),
    /ENOENT/,
  );
  await assert.rejects(
    () => lstat(path.join(root, "docs/product/cpb-live-release-validation.json")),
    /ENOENT/,
  );
});

test("rejects tampered provider-only bundles without adding draft or final manifest", async () => {
  const root = await tempRoot("cpb-promote-tamper-root");
  await copyProductEvidence(root);
  const runRoot = await tempRoot("cpb-promote-tamper-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const draftFile = await writeDraftRun(runRoot);
  const providerOnly = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId: "tampered",
  });
  assert.equal(providerOnly.ok, true);
  const providerPath = path.join(root, providerOnly.providerEvidenceFile!);
  const providerSha = sha256(await readFile(providerPath));
  await writeRaw(root, "docs/product/evidence/live-release/runs/tampered/artifacts/artifacts/source.patch", "tampered\n");

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    draftRehearsal: draftFile,
    runId: "tampered",
  });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((violation) => violation.path === "destination"
    && /provider bundle content/.test(violation.reason)));
  assert.equal(sha256(await readFile(providerPath)), providerSha);
  await assert.rejects(
    () => lstat(path.join(root, "docs/product/evidence/live-release/runs/tampered/draft-pr-rehearsal.json")),
    /ENOENT/,
  );
  await assert.rejects(
    () => lstat(path.join(root, "docs/product/cpb-live-release-validation.json")),
    /ENOENT/,
  );
});

test("rolls back the promoted run directory when full manifest verification fails", async () => {
  const root = await tempRoot("cpb-promote-full-rollback-root");
  const runRoot = await tempRoot("cpb-promote-full-rollback-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const draftFile = await writeDraftRun(runRoot);

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    draftRehearsal: draftFile,
    runId: "full-rollback",
  });

  assert.equal(result.ok, false);
  await assert.rejects(
    () => lstat(path.join(root, "docs/product/evidence/live-release/runs/full-rollback")),
    /ENOENT/,
  );
});

test("keeps a verified provider-only bundle when same-run final verification fails", async () => {
  const root = await tempRoot("cpb-promote-two-stage-rollback-root");
  const runRoot = await tempRoot("cpb-promote-two-stage-rollback-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const draftFile = await writeDraftRun(runRoot);
  const providerOnly = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId: "two-stage-rollback",
  });
  assert.equal(providerOnly.ok, true);
  const providerPath = path.join(root, providerOnly.providerEvidenceFile!);
  const providerSha = sha256(await readFile(providerPath));

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    draftRehearsal: draftFile,
    runId: "two-stage-rollback",
  });

  assert.equal(result.ok, false);
  assert.equal(sha256(await readFile(providerPath)), providerSha);
  await assert.rejects(
    () => lstat(path.join(root, "docs/product/evidence/live-release/runs/two-stage-rollback/draft-pr-rehearsal.json")),
    /ENOENT/,
  );
  await assert.rejects(
    () => lstat(path.join(root, "docs/product/cpb-live-release-validation.json")),
    /ENOENT/,
  );
});

test("rejects same-run finalization reruns after draft evidence exists", async () => {
  const root = await tempRoot("cpb-promote-rerun-root");
  await copyProductEvidence(root);
  const runRoot = await tempRoot("cpb-promote-rerun-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const draftFile = await writeDraftRun(runRoot);
  assert.equal((await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    providerOnly: true,
    runId: "rerun",
  })).ok, true);
  assert.equal((await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    draftRehearsal: draftFile,
    runId: "rerun",
  })).ok, true);

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    draftRehearsal: draftFile,
    runId: "rerun",
  });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((violation) => violation.path === "destination"
    && /provider bundle content|draft evidence/.test(violation.reason)));
});

test("rejects a final manifest path that escapes the repository", async () => {
  const root = await tempRoot("cpb-promote-manifest-escape-root");
  await copyProductEvidence(root);
  const runRoot = await tempRoot("cpb-promote-manifest-escape-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const draftFile = await writeDraftRun(runRoot);

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    draftRehearsal: draftFile,
    runId: "manifest-escape",
    evidenceFile: "../escaped-live-release.json",
  });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((violation) => violation.path === "evidenceFile"
    && /repository-local/.test(violation.reason)));
  await assert.rejects(
    () => lstat(path.join(root, "docs/product/evidence/live-release/runs/manifest-escape")),
    /ENOENT/,
  );
});

test("rejects an absolute product evidence path outside the repository", async () => {
  const root = await tempRoot("cpb-promote-product-escape-root");
  const runRoot = await tempRoot("cpb-promote-product-escape-run");
  const { reportFile } = await writeProviderRun(runRoot);
  const draftFile = await writeDraftRun(runRoot);
  const outside = await tempRoot("cpb-promote-product-escape-outside");
  const outsideProduct = path.join(outside, "product.json");
  await writeJson(outsideProduct, { schemaVersion: 1 });

  const result = await promoteLiveReleaseEvidence({
    root,
    runRoot,
    providerReport: reportFile,
    draftRehearsal: draftFile,
    runId: "product-escape",
    productEvidenceFile: outsideProduct,
  });

  assert.equal(result.ok, false);
  assert.ok(result.violations.some((violation) => violation.path === "productEvidenceFile"
    && /repository-local/.test(violation.reason)));
  await assert.rejects(
    () => lstat(path.join(root, "docs/product/evidence/live-release/runs/product-escape")),
    /ENOENT/,
  );
});
