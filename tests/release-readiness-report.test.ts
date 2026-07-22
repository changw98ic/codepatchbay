import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { DEFAULT_PRODUCT_VALIDATION_AGENTS } from "../scripts/run-swebench-product-validation.js";
import {
  buildSweBenchBatchReport as buildSweBenchBatchReportProduction,
  recordFromDatasetRow,
  stableJsonSha256,
  validateSweBenchBatchReport,
} from "../scripts/queue-swebench-batch.js";
import { buildReleaseReadinessReport } from "../scripts/release-readiness-report.js";
import { tempRoot, writeJson } from "./helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const referenceTime = "2026-07-20T12:00:00.000Z";
const productEvidenceFiles = [
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

function controlPlaneEvidence({
  phase,
  role,
  agent = "codex",
  providerKey = "codex",
  transport = "acp",
}: {
  phase: string;
  role: string;
  agent?: string;
  providerKey?: string;
  transport?: "acp" | "claude-cli";
}) {
  const evidence = {
    transport,
    phase,
    role,
    agent,
    providerKey,
    agentLaunchObserved: true,
    sessionObserved: true,
    policyVerified: true,
    toolCallCount: 0,
    terminalLaunchCount: 0,
    policySummary: transport === "acp"
      ? {
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
        }
      : {
          terminalPolicy: "deny",
          permissionRequests: "reject",
          webToolsDisabled: true,
          tools: [],
          mcpServers: [],
          slashCommandsDisabled: true,
          settings: {
            permissions: {
              allow: [],
              deny: ["Bash", "Edit", "Glob", "Grep", "NotebookEdit", "Read", "WebFetch", "WebSearch", "Write"],
            },
            strictMcpConfig: true,
          },
        },
  };
  return {
    controlPlaneEvidence: evidence,
    controlPlaneEvidenceSha256: stableJsonSha256(evidence),
  };
}

function digest(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}

function digestBuffer(raw: Buffer) {
  return createHash("sha256").update(raw).digest("hex");
}

function stableTestJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableTestJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableTestJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableJsonBytes(value: unknown) {
  return Buffer.byteLength(stableTestJson(value), "utf8");
}

function stableJsonDigest(value: unknown) {
  return digest(stableTestJson(value));
}

function prepareTaskRiskmapEvent() {
  return { type: "riskmap_generated", status: "ok", risk: "low" };
}

async function copyProductEvidence(root: string) {
  for (const relative of productEvidenceFiles) {
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(repoRoot, relative), destination);
  }
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

async function writeProviderArtifactFiles(root: string) {
  const artifactRoot = path.join(root, "docs/product/evidence/live-release/artifacts");
  await mkdir(artifactRoot, { recursive: true });
  for (const phase of ["prepare_task", "plan", "execute", "verify", "adversarial_verify"]) {
    await writeFile(
      path.join(artifactRoot, `${phase}.json`),
      phase === "prepare_task" ? JSON.stringify(prepareTaskRiskmapEvent()) : `phase:${phase}`,
      "utf8",
    );
  }
  await writeFile(path.join(artifactRoot, "django__django-13128.patch"), "patch", "utf8");
  await writeFile(path.join(artifactRoot, "scorer.log"), "scorer ok", "utf8");
}

function controlPlaneAuditRef({
  phase,
  role,
  summary,
  outputPath,
  agent = "codex",
  providerKey = "codex",
  transport = "acp",
  command = "codex-acp",
}: {
  phase: string;
  role: string;
  summary: unknown;
  outputPath: string;
  agent?: string;
  providerKey?: string;
  transport?: "acp" | "claude-cli";
  command?: string;
}) {
  const dir = path.join(path.dirname(outputPath), "control-plane-audit");
  const file = path.join(dir, `${phase}.json`);
  const rawFile = path.join(dir, `${phase}.raw.jsonl`);
  const projectId = "cpb-provider-live-preflight";
  const correlationNonce = "c".repeat(32);
  const jobId = `provider-preflight-${role}-${agent}-${correlationNonce}`;
  const summaryRecord = summary as Record<string, unknown>;
  const rawLines = [
    JSON.stringify({
      ts: "2026-07-20T10:00:00.000Z",
      event: "agent_launch",
      agent,
      phase,
      role,
      projectId,
      jobId,
      correlationNonce,
      ...(transport === "acp" ? { mcpServers: [], mcpServerNames: [] } : {}),
      livePreflightPolicy: summaryRecord.policySummary,
    }),
    JSON.stringify({ ts: "2026-07-20T10:00:01.000Z", event: "session_new", agent, phase, role, projectId, jobId, correlationNonce, sessionId: `session-${phase}` }),
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
    route: { phase, role, agent, providerKey, transport, command },
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
        agent,
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
        agent,
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

function codeGraphCleanupProof() {
  return {
    generator: "runtime/worker/managed-worker.ts#stopAssignmentCodeGraphRuntime",
    assignmentId: "assignment-provider-preflight",
    attempt: 1,
    attemptToken: "attempt-token-provider-preflight",
    entryId: "provider-preflight",
    projectId: "proj-provider-preflight",
    jobId: "job-provider-preflight",
    workerId: "w-live-release",
    orchestratorEpoch: 1,
    context: "before_terminal_publication",
    cleanupAttempt: 1,
    ok: true,
    cleanupVerified: true,
    processTreeStopped: true,
    stateRemoved: true,
    statePath: "/tmp/assignment-provider-preflight/.codegraph/daemon.pid",
    worktreePath: "/tmp/assignment-provider-preflight",
    startup: {
      ok: true,
      source: "fake_codegraph_daemon",
      pid: 12345,
      processPid: 12345,
      statePath: "/tmp/assignment-provider-preflight/.codegraph/daemon.pid",
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

function completedPhaseEvidence(phase: string, index: number) {
  const fragment = phase === "prepare_task" ? prepareTaskRiskmapEvent() : null;
  const raw = `phase:${phase}`;
  return {
    ok: true,
    durationMs: 1000 + index,
    retryCount: 0,
    retryFailureKinds: [],
    toolEvents: 1,
    auditUpdateEvents: 1,
    terminalCommands: 1,
    structuredOutputBytes: fragment ? Buffer.byteLength(stableTestJson(fragment)) : Buffer.byteLength(raw),
    structuredOutputPath: `docs/product/evidence/live-release/artifacts/${phase}.json${phase === "prepare_task" ? "#riskmap_generated" : ""}`,
    artifactSha256: fragment ? stableJsonSha256(fragment) : digest(raw),
    failureKind: "",
  };
}

function providerPreflightPhase({
  phase,
  role,
  agent,
  providerKey,
  transport,
  command,
}: {
  phase: string;
  role: string;
  agent: string;
  providerKey: string;
  transport: "acp" | "claude-cli";
  command: string;
}) {
  const artifactRoot = mkdtempSync(path.join(os.tmpdir(), "cpb-release-readiness-preflight-"));
  const outputPath = path.join(artifactRoot, `${phase}.json`);
  const proof = controlPlaneEvidence({ phase, role, agent, providerKey, transport });
  const handshake = {
    ok: true,
    mode: "live",
    generator: "scripts/queue-swebench-batch.ts#liveProviderPreflightHandshake",
    sentinelVerified: true,
    phase,
    role,
    agent,
    providerKey,
    transport,
    command,
    projectId: "cpb-provider-live-preflight",
    jobId: `provider-preflight-${role}-${agent}-${"c".repeat(32)}`,
    correlationNonce: "c".repeat(32),
    ...proof,
    controlPlaneAudit: controlPlaneAuditRef({
      phase,
      role,
      agent,
      providerKey,
      transport,
      command,
      summary: proof.controlPlaneEvidence,
      outputPath,
    }),
  };
  writeFileSync(outputPath, `${JSON.stringify(handshake, null, 2)}\n`, "utf8");
  const outputBuffer = readFileSync(outputPath);
  return {
    phase,
    role,
    agent,
    providerKey,
    transport,
    command,
    outputPath,
    outputBytes: outputBuffer.byteLength,
    outputSha256: digestBuffer(outputBuffer),
    denyRules: ["web_tool_denied", "read_only_mutation_denied", "broad_test_command_denied"],
    handshakeOk: true,
    handshake,
    violations: [],
  };
}

function providerEvidence({ weak = false } = {}) {
  const sampleRow = {
    instance_id: "django__django-13128",
    repo: "django/django",
    base_commit: "2d67222472f80f251607ae1b720527afceba06ad",
    problem_statement: "Remove the need for ExpressionWrapper on temporal subtraction.",
    FAIL_TO_PASS: JSON.stringify([
      "test_date_subtraction (expressions.tests.FTimeDeltaTests)",
    ]),
    PASS_TO_PASS: JSON.stringify([
      "test_deepcopy (expressions.tests.FTests)",
      "test_and (expressions.tests.CombinableTests)",
    ]),
  };
  const record = recordFromDatasetRow(sampleRow, 7);
  const providerPreflight = {
    schemaVersion: 1,
    generator: "scripts/queue-swebench-batch.ts#runSweBenchProviderPreflight",
    generatedAt: "2026-07-20T10:00:00.000Z",
    ok: true,
    violations: [],
    phases: [
      providerPreflightPhase({
        phase: "plan",
        role: "planner",
        agent: DEFAULT_PRODUCT_VALIDATION_AGENTS.planner,
        providerKey: "codex",
        transport: "acp",
        command: "codex-acp",
      }),
      providerPreflightPhase({
        phase: "execute",
        role: "executor",
        agent: DEFAULT_PRODUCT_VALIDATION_AGENTS.executor,
        providerKey: "claude:glm",
        transport: "claude-cli",
        command: "claude",
      }),
      providerPreflightPhase({
        phase: "verify",
        role: "verifier",
        agent: DEFAULT_PRODUCT_VALIDATION_AGENTS.verifier,
        providerKey: "claude:mimo-v2.5pro",
        transport: "claude-cli",
        command: "claude",
      }),
      providerPreflightPhase({
        phase: "adversarial_verify",
        role: "adversarial_verifier",
        agent: DEFAULT_PRODUCT_VALIDATION_AGENTS.adversarial_verifier,
        providerKey: "claude:mimo-v2.5pro",
        transport: "claude-cli",
        command: "claude",
      }),
    ],
  };
  const terminalState = weak
    ? { assignmentId: "assignment-provider-preflight", status: "failed", failureKind: "provider_unavailable", attempt: 1, jobId: "job-provider-preflight", workerId: "w-live-release", orchestratorEpoch: 1 }
    : { assignmentId: "assignment-provider-preflight", status: "completed", attempt: 1, jobId: "job-provider-preflight", workerId: "w-live-release", orchestratorEpoch: 1 };
  const manifest = {
    schemaVersion: 1,
    generatedAt: "2026-07-20T10:00:00.000Z",
    dataset: "SWE-bench/SWE-bench_Verified",
    split: "test",
    count: 1,
    planMode: "full",
    providerPreflightMode: "live",
    agents: DEFAULT_PRODUCT_VALIDATION_AGENTS,
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
    terminalStates: [terminalState],
    assignments: [{
      entryId: "provider-preflight",
      projectId: "proj-provider-preflight",
      workerId: "w-live-release",
      record,
      queued: {
        assignmentId: "assignment-provider-preflight",
        attempt: 1,
        attemptToken: "attempt-token-provider-preflight",
        orchestratorEpoch: 1,
      },
    }],
    providerPreflight,
  };
  return buildSweBenchBatchReportProduction({
    manifest,
    scorerRequired: !weak,
    evidenceByAssignmentId: weak ? {} : {
      "assignment-provider-preflight": {
        patch: {
          path: "docs/product/evidence/live-release/artifacts/django__django-13128.patch",
          sha256: digest("patch"),
          bytes: Buffer.byteLength("patch"),
          changedFiles: ["django/db/models/expressions.py"],
          changedFileCount: 1,
          applyStatus: "applies",
        },
        regressionEvidence: {
          status: "present",
          canonicalCommandsRun: [
            "PYTHONPATH=. python3 tests/runtests.py expressions.tests.FTimeDeltaTests.test_date_subtraction",
          ],
          canonicalCommandsMissing: [],
          sourcePhase: "verify",
        },
        scorer: {
          required: true,
          completed: true,
          resolved: true,
          unresolved: false,
          failed: false,
          emptyPatch: false,
          logPath: "docs/product/evidence/live-release/artifacts/scorer.log",
          patchSha256: digest("patch"),
          image: "sweb.eval.x86_64.django",
          command: "python -m swebench.harness.run_evaluation --dataset_name SWE-bench/SWE-bench_Verified",
          exitCode: 0,
        },
        phaseEvidence: {
          prepare_task: completedPhaseEvidence("prepare_task", 1),
          plan: completedPhaseEvidence("plan", 2),
          execute: completedPhaseEvidence("execute", 3),
          verify: completedPhaseEvidence("verify", 4),
          adversarial_verify: completedPhaseEvidence("adversarial_verify", 5),
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

function draftPrEvidence() {
  const repository = "cpb-validation/disposable-release-target";
  const branch = "cpb-release-rehearsal/readiness-test";
  const url = `https://github.com/${repository}/pull/17`;
  return {
    schemaVersion: 1,
    generator: "scripts/rehearse-disposable-draft-pr.ts#rehearseDisposableDraftPr",
    generatedAt: "2026-07-20T10:05:00.000Z",
    ok: true,
    mode: "live",
    target: {
      repository,
      repositoryId: "R_42",
      baseBranch: "main",
      disposable: true,
      markerVerified: true,
      markerPath: ".cpb-disposable-target.json",
      markerSha: "b".repeat(40),
    },
    branch,
    pullRequest: { number: 17, url, draft: true, state: "closed" },
    cleanup: { pullRequestClosed: true, branchDeleted: true },
    operations: [
      { name: "origin.verify", repository: "source/repo", targetRepository: repository, different: true },
      { name: "github.auth.verify", authenticated: true },
      { name: "repository.verify", repository, repositoryId: "R_42", baseBranch: "main" },
      { name: "marker.verify", repository, baseBranch: "main", path: ".cpb-disposable-target.json", sha: "b".repeat(40), purpose: "codepatchbay-release-rehearsal" },
      { name: "branch.create.verify", repository, branch, baseSha: "c".repeat(40) },
      { name: "payload.write.verify", repository, branch, path: ".cpb-release-rehearsals/readiness-test.json", sha: "d".repeat(40) },
      { name: "pull_request.create.verify", repository, branch, baseBranch: "main", number: 17, url, draft: true, state: "open" },
      { name: "pull_request.read.verify", repository, branch, number: 17, url, draft: true, state: "open" },
      { name: "pull_request.close.verify", repository, number: 17, state: "closed" },
      { name: "branch.delete.verify", repository, branch, deleted: true },
    ],
    violations: [],
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
      assert.equal(typeof phase.outputPath, "string", `provider preflight ${label}-${phaseIndex} outputPath must be string`);
      assert.equal(typeof audit.rawPath, "string", `provider preflight ${label}-${phaseIndex} rawPath must be string`);
      const sourceOutput = path.isAbsolute(String(phase.outputPath))
        ? String(phase.outputPath)
        : path.join(root, String(phase.outputPath));
      const sourceAudit = path.isAbsolute(audit.path) ? audit.path : path.join(root, audit.path);
      const sourceRaw = path.isAbsolute(String(audit.rawPath))
        ? String(audit.rawPath)
        : path.join(root, String(audit.rawPath));
      await writeJson(sourceOutput, handshake);
      assert.equal(
        stableTestJson(JSON.parse(await readFile(sourceOutput, "utf8"))),
        stableTestJson(handshake),
        `provider preflight ${label}-${phaseIndex} output must retain the handshake exactly before rebinding`,
      );
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
      const artifact = JSON.parse(await readFile(sourceAudit, "utf8")) as Record<string, Record<string, unknown>>;
      artifact.jobIdentity.outputPathSha256 = digest(outputRelative);
      artifact.rawStream.path = path.basename(rawRelative);
      artifact.rawStream.bytes = rawBuffer.byteLength;
      artifact.rawStream.sha256 = digestBuffer(rawBuffer);
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
  if (manifest && canonicalPreflight !== undefined && sourceManifest) {
    manifest.providerPreflight = structuredClone(canonicalPreflight);
    manifest.hash = stableJsonSha256(sourceManifest);
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
          const event = prepareTaskRiskmapEvent();
          await writeJson(path.join(root, relative), event);
          evidence.structuredOutputPath = `${relative}#riskmap_generated`;
          evidence.structuredOutputBytes = stableJsonBytes(event);
          evidence.artifactSha256 = stableJsonDigest(event);
        } else {
          const artifact = await writeRawArtifact(root, relative, `phase:${phase}`);
          evidence.structuredOutputPath = artifact.path;
          evidence.structuredOutputBytes = artifact.bytes;
          evidence.artifactSha256 = artifact.sha256;
        }
      }
    }
    const patch = job.patch as Record<string, unknown> | undefined;
    if (patch && typeof patch === "object") {
      const relative = `docs/product/evidence/live-release/provider-artifacts/job-${jobIndex}/source.patch`;
      const artifact = await writeRawArtifact(root, relative, "patch");
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

async function writeReleaseEvidence(root: string) {
  await copyProductEvidence(root);
  await writeProviderArtifactFiles(root);
  const providerRef = "docs/product/evidence/live-release/runs/readiness-fixture/provider-connectivity.json";
  const draftRef = "docs/product/evidence/live-release/runs/readiness-fixture/draft-pr-rehearsal.json";
  const productRef = "docs/product/cpb-flagship-product-validation.json";
  const provider = providerEvidence();
  await bindProviderArtifacts(root, provider);
  await writeJson(path.join(root, providerRef), provider);
  await writeJson(path.join(root, draftRef), draftPrEvidence());
  const [providerRaw, draftRaw, productRaw] = await Promise.all([
    readFile(path.join(root, providerRef), "utf8"),
    readFile(path.join(root, draftRef), "utf8"),
    readFile(path.join(root, productRef), "utf8"),
  ]);
  await writeJson(path.join(root, "docs/product/cpb-live-release-validation.json"), {
    schemaVersion: 1,
    generatedAt: "2026-07-20T10:10:00.000Z",
    providerConnectivity: { evidenceBundleRef: providerRef, sha256: digest(providerRaw) },
    draftPrRehearsal: { evidenceBundleRef: draftRef, sha256: digest(draftRaw) },
    productEvidence: { evidenceBundleRef: productRef, sha256: digest(productRaw) },
  });
  await execFileAsync("git", [
    "add",
    "-N",
    ...productEvidenceFiles,
    "docs/product/evidence/live-release/artifacts/prepare_task.json",
    "docs/product/evidence/live-release/artifacts/plan.json",
    "docs/product/evidence/live-release/artifacts/execute.json",
    "docs/product/evidence/live-release/artifacts/verify.json",
    "docs/product/evidence/live-release/artifacts/adversarial_verify.json",
    "docs/product/evidence/live-release/artifacts/django__django-13128.patch",
    "docs/product/evidence/live-release/artifacts/scorer.log",
    "docs/product/evidence/live-release/provider-artifacts",
    providerRef,
    draftRef,
    "docs/product/cpb-live-release-validation.json",
  ], { cwd: root });
}

async function writeWeakLiveReleaseEvidence(root: string) {
  await copyProductEvidence(root);
  await writeProviderArtifactFiles(root);
  const providerRef = "docs/product/evidence/live-release/runs/weak-readiness-fixture/provider-connectivity.json";
  const draftRef = "docs/product/evidence/live-release/runs/weak-readiness-fixture/draft-pr-rehearsal.json";
  const productRef = "docs/product/cpb-flagship-product-validation.json";
  const provider = providerEvidence({ weak: true });
  await bindProviderArtifacts(root, provider);
  await writeJson(path.join(root, providerRef), provider);
  await writeJson(path.join(root, draftRef), draftPrEvidence());
  const [providerRaw, draftRaw, productRaw] = await Promise.all([
    readFile(path.join(root, providerRef), "utf8"),
    readFile(path.join(root, draftRef), "utf8"),
    readFile(path.join(root, productRef), "utf8"),
  ]);
  await writeJson(path.join(root, "docs/product/cpb-live-release-validation.json"), {
    schemaVersion: 1,
    generatedAt: "2026-07-20T10:10:00.000Z",
    providerConnectivity: { evidenceBundleRef: providerRef, sha256: digest(providerRaw) },
    draftPrRehearsal: { evidenceBundleRef: draftRef, sha256: digest(draftRaw) },
    productEvidence: { evidenceBundleRef: productRef, sha256: digest(productRaw) },
  });
  await execFileAsync("git", [
    "add",
    "-N",
    ...productEvidenceFiles,
    "docs/product/evidence/live-release/artifacts/prepare_task.json",
    "docs/product/evidence/live-release/artifacts/plan.json",
    "docs/product/evidence/live-release/artifacts/execute.json",
    "docs/product/evidence/live-release/artifacts/verify.json",
    "docs/product/evidence/live-release/artifacts/adversarial_verify.json",
    "docs/product/evidence/live-release/artifacts/django__django-13128.patch",
    "docs/product/evidence/live-release/artifacts/scorer.log",
    "docs/product/evidence/live-release/provider-artifacts",
    providerRef,
    draftRef,
    "docs/product/cpb-live-release-validation.json",
  ], { cwd: root });
}

async function initRepo(root: string) {
  await execFileAsync("git", ["init"], { cwd: root });
}

test("release readiness report identifies missing product evidence as the remaining gate", async () => {
  const root = await tempRoot("cpb-release-readiness-missing-product");
  await initRepo(root);

  const report = await buildReleaseReadinessReport({ root, referenceTime });

  assert.equal(report.ready, false);
  assert.equal(report.gates.patchIntegrity.ok, true);
  assert.equal(report.gates.productGate.ok, false);
  assert.equal(report.gates.productGate.missingEvidence, true);
  assert.deepEqual(report.remaining.map((item) => item.gate), ["product-gate", "live-release-evidence"]);
});

test("release readiness report keeps malformed product evidence as structured product-gate failure", async () => {
  const root = await tempRoot("cpb-release-readiness-malformed-product");
  await initRepo(root);
  const evidenceFile = path.join(root, "docs", "product", "cpb-flagship-product-validation.json");
  await mkdir(path.dirname(evidenceFile), { recursive: true });
  await writeFile(evidenceFile, "{ not valid json\n", "utf8");
  await execFileAsync("git", ["add", "-N", "docs/product/cpb-flagship-product-validation.json"], { cwd: root });

  const report = await buildReleaseReadinessReport({ root, referenceTime });

  assert.equal(report.ready, false);
  assert.equal(report.gates.productGate.ok, false);
  assert.equal(report.gates.productGate.missingEvidence, false);
  assert.equal(report.remaining[0].gate, "product-gate");
  assert.match(report.gates.productGate.violations[0].reason, /invalid product validation JSON/);
});

test("release readiness report rejects missing local product evidence bundles", async () => {
  const root = await tempRoot("cpb-release-readiness-missing-bundles");
  await initRepo(root);
  const evidenceFile = path.join(root, "docs", "product", "cpb-flagship-product-validation.json");
  await mkdir(path.dirname(evidenceFile), { recursive: true });
  await copyFile(path.join(repoRoot, "docs/product/cpb-flagship-product-validation.json"), evidenceFile);
  await execFileAsync("git", ["add", "-N", "docs/product/cpb-flagship-product-validation.json"], { cwd: root });

  const report = await buildReleaseReadinessReport({ root, referenceTime });

  assert.equal(report.ready, false);
  assert.equal(report.gates.productGate.ok, false);
  assert.equal(report.remaining[0].gate, "product-gate");
  assert.match(report.gates.productGate.violations[0].reason, /local evidence bundle path does not exist/);
});

test("release readiness report passes only when patch, product, and live evidence gates pass", async () => {
  const root = await tempRoot("cpb-release-readiness-ready");
  await initRepo(root);
  await writeReleaseEvidence(root);

  const report = await buildReleaseReadinessReport({ root, referenceTime });

  assert.equal(report.ready, true, JSON.stringify(report, null, 2));
  assert.equal(report.gates.patchIntegrity.ok, true);
  assert.equal(report.gates.productGate.ok, true);
  assert.equal(report.gates.liveReleaseEvidence.ok, true);
  assert.equal(report.gates.productGate.recordCount, 3);
  assert.deepEqual(report.remaining, []);
});

test("release readiness report rejects weak provider evidence without a completed representative job", async () => {
  const root = await tempRoot("cpb-release-readiness-weak-provider");
  await initRepo(root);
  await writeWeakLiveReleaseEvidence(root);

  const report = await buildReleaseReadinessReport({ root, referenceTime });

  assert.equal(report.ready, false);
  assert.equal(report.gates.patchIntegrity.ok, true);
  assert.equal(report.gates.productGate.ok, true);
  assert.equal(report.gates.liveReleaseEvidence.ok, false);
  assert.match(
    report.gates.liveReleaseEvidence.violations.map((violation) => violation.reason).join("\n"),
    /every representative provider job must complete/,
  );
  assert.deepEqual(report.remaining.map((item) => item.gate), ["live-release-evidence"]);
});

test("release readiness report accepts SWE-bench Verified product evidence", async () => {
  const root = await tempRoot("cpb-release-readiness-swe-bench-ready");
  await initRepo(root);
  await writeReleaseEvidence(root);

  const report = await buildReleaseReadinessReport({ root, referenceTime });

  assert.equal(report.ready, true, JSON.stringify(report, null, 2));
  assert.equal(report.gates.productGate.ok, true);
  assert.equal(report.gates.productGate.recordCount, 3);
  assert.deepEqual(report.remaining, []);
});

test("release readiness report exposes supplemental official score bundle count", async () => {
  const root = await tempRoot("cpb-release-readiness-official-score-ready");
  await initRepo(root);
  await writeReleaseEvidence(root);

  const report = await buildReleaseReadinessReport({ root, referenceTime });

  assert.equal(report.ready, true, JSON.stringify(report, null, 2));
  assert.equal(report.gates.productGate.ok, true);
  assert.equal(report.gates.productGate.recordCount, 3);
  assert.equal(report.gates.productGate.supplementalOfficialScoreBundleCount, 1);
  assert.equal(report.gates.liveReleaseEvidence.officialScoreBundleCount, 1);
  assert.deepEqual(report.remaining, []);
});

test("package exposes release readiness report entrypoint", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(
    pkg.scripts["report:release-readiness"],
    "npm run build:node && node dist/scripts/release-readiness-report.js",
  );
});
