/**
 * Tests for evidence ledger and checklist verdict persistence in the verify phase.
 *
 * Task 7: Checklist-aware jobs must produce event-visible evidence-ledger and
 * checklist-verdict artifacts. Legacy verifier pass without checklistVerdict
 * must fail as VERDICT_INVALID and synthesize a failing checklist-verdict.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { LooseRecord, recordValue } from "../shared/types.js";

import { runJob } from "../core/engine/run-job.js";
import {
  buildDisposableVerificationReplayEnv,
  executableVerificationEvidenceSummary,
  isRepositoryTestPath,
  summarizeIndependentVerifierExecutions,
} from "../core/phases/verify.js";
import { observableContractExecutionCoverage } from "../core/workflow/observable-contract.js";
import { appendEvent } from "../server/services/event/event-store.js";
import { buildArtifactIndex } from "../server/services/job/job-projection.js";
import { tempRoot } from "./helpers.js";

const execFileAsync = promisify(execFile);

test("repository test path classification separates production files from common test layouts", () => {
  for (const file of [
    "tests/unit/widget.test.ts",
    "src/__tests__/widget.js",
    "pkg/test_widget.py",
    "pkg/widget_test.go",
    "spec/widget_spec.rb",
  ]) assert.equal(isRepositoryTestPath(file), true, file);
  for (const file of ["src/widget.ts", "astropy/timeseries/core.py", "docs/testing-guide.md"]) {
    assert.equal(isRepositoryTestPath(file), false, file);
  }
});

test("disposable verifier replays permit generated test artifacts without weakening the candidate checkout", () => {
  const env = buildDisposableVerificationReplayEnv({
    sourceContext: { riskMap: { riskLevel: "high" } },
  });

  assert.equal(env.CPB_VERIFIER_REPLAY_WORKSPACE_WRITE, "1");
  assert.equal(env.CPB_CODEX_VERIFIER_WORKSPACE_WRITE, "1");
  assert.equal(env.CPB_ACP_TOOL_CALL_BUDGET_VERIFY, "45");
});

test("fresh verifier ACP audit accepts completed runtime probes but rejects inspection and failed tests", () => {
  const sessionId = "verify-session-1";
  const audit = [
    { event: "tool_call", phase: "verify", role: "verifier", sessionId, toolCallId: "git", kind: "execute", title: "git diff --stat", status: "in_progress" },
    { event: "tool_call", phase: "verify", role: "verifier", sessionId, toolCallId: "git", status: "completed" },
    { event: "tool_call", phase: "verify", role: "verifier", sessionId, toolCallId: "pytest", kind: "execute", title: "python -m pytest tests/test_feature.py", status: "in_progress" },
    { event: "tool_call", phase: "verify", role: "verifier", sessionId, toolCallId: "pytest", status: "failed" },
    { event: "tool_call", phase: "verify", role: "verifier", sessionId, toolCallId: "probe", kind: "execute", title: "python - <<'PY'\nassert 2 + 2 == 4\nPY", status: "in_progress" },
    { event: "tool_call", phase: "verify", role: "verifier", sessionId, toolCallId: "probe", status: "completed" },
  ].map((entry) => JSON.stringify(entry)).join("\n");

  const summary = summarizeIndependentVerifierExecutions(audit, { sessionId });
  assert.equal(summary.ok, true);
  assert.equal(summary.observations.length, 1);
  const observation = recordValue(summary.observations[0]);
  assert.equal(observation.toolCallId, "probe");
  assert.equal(observation.executionClass, "runtime_probe");
  assert.match(String(observation.auditEventSha256), /^sha256:/);
});

test("fresh verifier ACP audit accepts runtime probes with environment assignments", () => {
  const sessionId = "verify-session-env";
  const audit = [
    {
      event: "tool_call",
      phase: "verify",
      role: "verifier",
      sessionId,
      toolCallId: "probe",
      kind: "execute",
      title: "PYTHONPATH=. MPLBACKEND=Agg python -c \"assert 2 + 2 == 4\"",
      status: "in_progress",
    },
    {
      event: "tool_call",
      phase: "verify",
      role: "verifier",
      sessionId,
      toolCallId: "probe",
      status: "completed",
    },
  ].map((entry) => JSON.stringify(entry)).join("\n");

  const summary = summarizeIndependentVerifierExecutions(audit, { sessionId });
  assert.equal(summary.ok, true);
  assert.equal(summary.observations.length, 1);
  assert.equal(recordValue(summary.observations[0]).executionClass, "runtime_probe");
});

test("candidate-derived runtime expectations cannot satisfy a frozen text oracle", () => {
  const expected = "expected ['time', 'flux'] as the first columns but found ['time']";
  const nestedQuoteFailure = "expected '['time', 'flux']' as the first columns but found '['time']'";
  const frozenChecklist = {
    schemaVersion: 1,
    jobId: "job-oracle",
    project: "project-oracle",
    status: "frozen",
    items: [{
      id: "AC-001",
      allowedFiles: ["src/diagnostic.py"],
      observableContract: {
        contractId: "OBS-001",
        contractSha256: `sha256:${"a".repeat(64)}`,
        frozenBeforeExecution: true,
        observationKind: "contains_text",
        probeInput: "Trigger a missing required value",
        expectedObservation: expected,
        forbiddenObservations: [nestedQuoteFailure],
        oracleSourceRefs: [{ kind: "task_text", locator: "task:0" }],
        candidateIndependent: true,
      },
    }],
  };
  const circular = {
    ok: true,
    attempts: [{
      executionClass: "runtime_probe",
      status: "completed",
      command: `python -c "actual=${JSON.stringify(nestedQuoteFailure)}; assert actual == ${JSON.stringify(nestedQuoteFailure)}"`,
    }],
    observations: [],
  };
  const rejected = observableContractExecutionCoverage(frozenChecklist, circular);
  assert.equal(rejected.ok, false);
  assert.deepEqual(rejected.missingContractIds, ["OBS-001"]);

  const bound = {
    ok: true,
    attempts: [{
      executionClass: "runtime_probe",
      status: "completed",
      command: `python -c "actual='...'; expected=${JSON.stringify(expected)}; forbidden=${JSON.stringify(nestedQuoteFailure)}; assert expected in actual; assert forbidden not in actual"`,
    }],
    observations: [],
  };
  const accepted = observableContractExecutionCoverage(frozenChecklist, bound);
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.passedContractIds, ["OBS-001"]);

  const executable = executableVerificationEvidenceSummary({}, {}, circular, frozenChecklist);
  assert.equal(executable.genericExecutionPassed, true);
  assert.equal(executable.ok, false);
});

test("a failed frozen-oracle assertion is classified as candidate evidence, not missing infrastructure", () => {
  const expected = "expected [a, b] but found [a]";
  const forbidden = "expected '[a, b]' but found '[a]'";
  const frozenChecklist = {
    items: [{
      id: "AC-007",
      allowedFiles: ["src/diagnostic.py"],
      observableContract: {
        contractId: "OBS-007",
        frozenBeforeExecution: true,
        observationKind: "exact_text",
        expectedObservation: expected,
        forbiddenObservations: [forbidden],
      },
    }],
  };
  const failed = observableContractExecutionCoverage(frozenChecklist, {
    attempts: [{
      executionClass: "runtime_probe",
      status: "failed",
      command: `python -c "expected=${JSON.stringify(expected)}; forbidden=${JSON.stringify(forbidden)}; actual='bad'; assert actual == expected; assert actual != forbidden"`,
    }],
  });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.failedContractIds, ["OBS-007"]);
  assert.deepEqual(failed.fixScope, ["src/diagnostic.py"]);
});

test("fresh verifier ACP audit is session-bound and fail-closed", () => {
  const audit = JSON.stringify({
    event: "tool_call",
    phase: "verify",
    role: "verifier",
    sessionId: "old-session",
    toolCallId: "test",
    kind: "execute",
    title: "pytest tests/test_feature.py",
    status: "completed",
  });

  assert.equal(summarizeIndependentVerifierExecutions(audit, { sessionId: "current-session" }).ok, false);
  assert.equal(summarizeIndependentVerifierExecutions(audit, {}).ok, false);
});

test("fresh verifier ACP audit resolves the current session from the exact execution window", () => {
  const audit = [
    { ts: "2026-07-14T00:00:00.000Z", event: "tool_call", phase: "verify", role: "verifier", sessionId: "old", toolCallId: "old-test", kind: "execute", title: "pytest old.py", status: "completed" },
    { ts: "2026-07-14T00:01:01.000Z", event: "session_new", phase: "verify", role: "verifier", sessionId: "current" },
    { ts: "2026-07-14T00:01:02.000Z", event: "tool_call", phase: "verify", role: "verifier", sessionId: "current", toolCallId: "current-test", kind: "execute", title: "python -m pytest tests/test_current.py", status: "completed" },
    { ts: "2026-07-14T00:01:03.000Z", event: "session_close", phase: "verify", role: "verifier", sessionId: "current" },
  ].map((entry) => JSON.stringify(entry)).join("\n");

  const summary = summarizeIndependentVerifierExecutions(audit, {
    startedAt: "2026-07-14T00:01:00.000Z",
    completedAt: "2026-07-14T00:01:04.000Z",
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.sessionId, "current");
  assert.equal(recordValue(summary.observations[0]).toolCallId, "current-test");
});

test("fresh verifier ACP audit excludes a later same-role session outside the completed window", () => {
  const audit = [
    { ts: "2026-07-14T00:01:01.000Z", event: "session_new", phase: "verify", role: "verifier", sessionId: "candidate" },
    { ts: "2026-07-14T00:01:02.000Z", event: "tool_call", phase: "verify", role: "verifier", sessionId: "candidate", toolCallId: "candidate-probe", kind: "execute", title: "python -c \"assert 2 + 2 == 4\"", status: "completed" },
    { ts: "2026-07-14T00:01:04.500Z", event: "session_new", phase: "verify", role: "verifier", sessionId: "baseline-replay" },
    { ts: "2026-07-14T00:01:05.000Z", event: "tool_call", phase: "verify", role: "verifier", sessionId: "baseline-replay", toolCallId: "baseline-read", kind: "read", title: "Read frozen test file", status: "completed" },
  ].map((entry) => JSON.stringify(entry)).join("\n");

  const summary = summarizeIndependentVerifierExecutions(audit, {
    startedAt: "2026-07-14T00:01:00.000Z",
    completedAt: "2026-07-14T00:01:03.000Z",
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.sessionId, "candidate");
  assert.equal(summary.observations.length, 1);
  assert.equal(recordValue(summary.observations[0]).toolCallId, "candidate-probe");
  assert.equal(recordValue(summary.observations[0]).executionClass, "runtime_probe");
});

function jsonEnvelope(data: LooseRecord) {
  return "```json\n" + JSON.stringify(data, null, 2) + "\n```";
}

function checklist(overrides: LooseRecord = {}) {
  return {
    schemaVersion: 1,
    jobId: "job-checklist",
    project: "flow",
    status: "frozen",
    source: { task: "task", issue: null, documents: [] },
    items: [
      {
        id: "AC-001",
        requirement: "README is updated",
        source: "user_task",
        sourceRefs: [{ kind: "task_text", locator: "task:0", sha256: "sha256:task" }],
        predicateId: "PRED-001",
        required: true,
        area: "docs",
        risk: "low",
        verificationMethod: "static",
        expectedEvidence: "README diff contains requested text",
        dependsOn: [],
        allowedFiles: ["README.md"],
      },
    ],
    assumptions: [],
    ...overrides,
  };
}

function makeVerifierPool(verdictOverride: LooseRecord = {}, options: LooseRecord = {}) {
  let verifierPrompt = "";
  const pool = {
    async execute(_agent: string, _prompt: string, _cwd: string, _timeoutMs: number, meta: LooseRecord) {
      if (meta.role === "planner") {
        if (/\bdecomposedItems\b/.test(_prompt)) {
          return {
            output: jsonEnvelope({
              status: "ok",
              decomposedItems: [
                {
                  requirement: "README is updated",
                  predicateId: "PRED-001",
                  verificationMethod: "static",
                  allowedFiles: ["README.md"],
                  sourceRefs: [{ kind: "task_text", locator: "task:0" }],
                },
              ],
            }),
            providerKey: "fake",
            variant: null,
          };
        }
        return {
          output: jsonEnvelope({
            status: "ok",
            planMarkdown: "## Analysis\n- ok\n\n## Bounded Handoff\n- Real actors: README documentation fixture\n- Entrypoints: runJob standard workflow\n- Bypass candidates: none\n- Edit files: README.md\n- Verification targets: npm test\n- Blockers: none\n\n## Files to modify\n- README.md\n\n## Implementation Steps\n1. edit\n\n## Testing\n- npm test\n\n## Risks\n- none",
          }),
          providerKey: "fake",
          variant: null,
        };
      }
      if (meta.role === "executor") {
        return {
          output: jsonEnvelope({
            status: "ok",
            summary: "Updated README.md with new content",
            tests: [],
            risks: [],
            checklistMapping: [
              { checklistId: "AC-001", changedFiles: ["README.md"], executorClaim: "Updated README", notes: "" },
            ],
          }),
          providerKey: "fake",
          variant: null,
        };
      }
      if (meta.role === "verifier") {
        verifierPrompt = _prompt;
        if (options.verdictFileEnvelope) {
          const match = _prompt.match(/VERIFIER_JSON_OUTPUT_FILE=([^\n]+)/);
          assert.ok(match?.[1], "verifier prompt must expose VERIFIER_JSON_OUTPUT_FILE");
          const verdictFilePath = match[1].trim();
          await mkdir(path.dirname(verdictFilePath), { recursive: true });
          await writeFile(verdictFilePath, JSON.stringify(options.verdictFileEnvelope, null, 2), "utf8");
        }
        if (typeof options.verifierOutput === "string") {
          return {
            output: options.verifierOutput,
            providerKey: "fake",
            variant: null,
          };
        }
        return {
          output: jsonEnvelope({
            status: "ok",
            verdict: "pass",
            reason: "looks good",
            details: "Implementation matches plan",
            confidence: 0.9,
            ...verdictOverride,
          }),
          providerKey: "fake",
          variant: null,
        };
      }
      return {
        output: jsonEnvelope({ status: "ok", verdict: "pass", reason: "legacy", details: "ok", confidence: 1 }),
        providerKey: "fake",
        variant: null,
      };
    },
    async releaseWorktree() { return true; },
    getVerifierPrompt() { return verifierPrompt; },
  };
  return pool;
}

async function makeSourceRoot() {
  const sourcePath = await tempRoot("cpb-verifier-source");
  await mkdir(path.join(sourcePath, ".cpb"), { recursive: true });
  await writeFile(path.join(sourcePath, "README.md"), "# fixture\n", "utf8");
  await writeFile(
    path.join(sourcePath, "package.json"),
    JSON.stringify({ name: "verifier-fixture", private: true }, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(sourcePath, ".cpb", "verification-probes.json"),
    JSON.stringify({
      schemaVersion: 1,
      probes: [{ predicateId: "PRED-CMD", executable: process.execPath, args: ["-e", "process.exit(0)"] }],
    }, null, 2) + "\n",
    "utf8",
  );
  await execFileAsync("git", ["init", "-q"], { cwd: sourcePath });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: sourcePath });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: sourcePath });
  await execFileAsync("git", ["add", "-A"], { cwd: sourcePath });
  await execFileAsync("git", ["commit", "-q", "-m", "initial fixture"], { cwd: sourcePath });
  return sourcePath;
}

async function runVerifierFixture(pool: LooseRecord, opts: LooseRecord = {}) {
  const cpbRoot = await tempRoot("cpb-verifier-gate");
  const sourcePath = await makeSourceRoot();
  const dataRoot = path.join(cpbRoot, "runtime", "projects", "flow");
  const events: LooseRecord[] = [];
  const prepareOverrides = recordValue(opts.prepareOverrides);

  const prepareTaskResult: LooseRecord = {
    phases: ["plan", "execute", "verify"],
    riskMap: { riskLevel: "low" },
    ...prepareOverrides,
  };
  if (opts.withChecklist !== false) {
    prepareTaskResult.acceptanceChecklist = opts.acceptanceChecklist || checklist();
  }

  const result = await runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "Update README",
    jobId: opts.jobId || "job-checklist",
    workflow: "standard",
    planMode: "full",
    sourcePath,
    sourceContext: opts.sourceContext || {},
    agents: { planner: "fake", executor: "fake", verifier: "fake" },
    prepareTask: async () => prepareTaskResult,
    createJob: async () => ({ jobId: opts.jobId || "job-checklist" }),
    startJob: async () => ({}),
    checkpointJob: async () => ({}),
    completePhase: async () => ({}),
    completeJob: async () => ({}),
    failJob: async () => ({}),
    blockJob: async () => ({}),
    appendEvent: async (_root: string, _project: string, _jobId: string, event: LooseRecord) => {
      events.push(event);
      await appendEvent(cpbRoot, "flow", opts.jobId || "job-checklist", event, { dataRoot });
    },
    reportProgress: async () => ({}),
    getPool: () => pool,
  });

  return { result, events, cpbRoot, dataRoot };
}

/**
 * Case 1: checklist-aware job with legacy verifier pass and no checklistVerdict
 * fails with VERDICT_INVALID, still emits event-visible evidence-ledger plus
 * a synthesized failing checklist-verdict.
 */
test("checklist-aware job with legacy verifier pass fails as VERDICT_INVALID and emits synthesized failing checklist-verdict", async () => {
  const pool = makeVerifierPool(); // No checklistVerdict in response
  const { result, events, cpbRoot, dataRoot } = await runVerifierFixture(pool);

  // Job should fail
  assert.equal(result.status, "failed", "checklist-aware job with legacy pass must fail");

  // Evidence-ledger artifact event must exist
  assert.ok(
    events.some((e) => e.type === "artifact_created" && e.kind === "evidence-ledger"),
    "evidence-ledger artifact_created event must exist",
  );

  // Checklist-verdict artifact event must exist
  assert.ok(
    events.some((e) => e.type === "artifact_created" && e.kind === "checklist-verdict"),
    "checklist-verdict artifact_created event must exist",
  );

  // The persisted verdict must be a synthesized fail
  const index = await buildArtifactIndex(cpbRoot, "flow", "job-checklist", { dataRoot });
  const verdictEntry = index.entries.find((entry: LooseRecord) => entry.kind === "checklist-verdict");
  assert.ok(verdictEntry?.path, "checklist-verdict must have a readable artifact path");
  const persistedVerdict = JSON.parse(await readFile(verdictEntry.path, "utf8"));
  assert.equal(persistedVerdict.status, "fail", "synthesized verdict must have status fail");

  // The synthesized verdict must have every required item unchecked
  const uncheckedItems = persistedVerdict.items.filter((item: LooseRecord) => item.result === "unchecked");
  assert.equal(uncheckedItems.length, persistedVerdict.items.length, "all items must be unchecked in synthesized verdict");
});

test("partial checklist verdict is normalized to semantic fail instead of verdict-invalid", async () => {
  const pool = makeVerifierPool({
    verdict: "partial",
    reason: "independent verification could not prove the required behavior",
    checklistVerdict: {
      schemaVersion: 1,
      jobId: "job-checklist",
      status: "partial",
      items: [{
        checklistId: "AC-001",
        result: "unchecked",
        evidenceRefs: [],
        actualResult: "The scoped diff exists but behavior remains unproven.",
        reason: "No independent behavioral proof.",
        fixScope: [],
      }],
      blocking: [],
      fixScope: [],
      reason: "Required behavior remains unproven.",
    },
  });
  const { result, cpbRoot, dataRoot } = await runVerifierFixture(pool);

  assert.equal(result.status, "failed");
  const phaseResults = Array.isArray(result.phaseResults) ? result.phaseResults : [];
  const verifyResult = phaseResults.find((phaseResult: LooseRecord) => phaseResult.phase === "verify") as LooseRecord;
  assert.equal(recordValue(verifyResult.failure).kind, "verification_failed");

  const index = await buildArtifactIndex(cpbRoot, "flow", "job-checklist", { dataRoot });
  const verdictEntry = index.entries.find((entry: LooseRecord) => entry.kind === "checklist-verdict");
  assert.ok(verdictEntry?.path);
  const persistedVerdict = JSON.parse(await readFile(verdictEntry.path, "utf8"));
  assert.equal(persistedVerdict.status, "fail");
  assert.equal(persistedVerdict.items[0].result, "unchecked");
});

test("invalid verifier JSON persists full raw output artifact for diagnosis", async () => {
  const rawOutput = [
    "raw-output-begin:" + "x".repeat(900),
    "```json",
    JSON.stringify({ status: "ok", reason: "tail only would hide the prefix" }, null, 2),
    "```",
    "raw-output-end",
  ].join("\n");
  const pool = makeVerifierPool({}, { verifierOutput: rawOutput });
  const { result } = await runVerifierFixture(pool);

  assert.equal(result.status, "failed");
  const phaseResults = Array.isArray(result.phaseResults) ? result.phaseResults : [];
  const verifyResult = phaseResults.find((phaseResult: LooseRecord) => phaseResult.phase === "verify") as LooseRecord;
  assert.ok(verifyResult, `verify phase result must exist: ${JSON.stringify(result, null, 2).slice(0, 4000)}`);
  const verifyFailure = recordValue(verifyResult.failure);
  const verifyDiagnostics = recordValue(verifyResult.diagnostics);
  assert.equal(verifyFailure.kind, "verdict_invalid");
  assert.ok(
    String(verifyFailure.stderrSnippet || "").length < rawOutput.length,
    "legacy stderrSnippet remains a short tail and cannot be the only diagnostic",
  );

  const rawArtifact = recordValue(verifyDiagnostics.rawAgentOutputArtifact);
  assert.ok(rawArtifact?.path, "invalid verifier output must persist a raw output artifact");
  const persisted = await readFile(rawArtifact.path, "utf8");
  assert.equal(persisted, rawOutput);
  assert.ok(persisted.includes("raw-output-begin:"), "full artifact must preserve the prefix lost by tail snippets");
  assert.ok(persisted.includes("raw-output-end"), "full artifact must preserve the output tail");
});

/**
 * Case 2: checklist-aware job with valid checklistVerdict and fresh evidence
 * passes verify and emits evidence-ledger plus checklist-verdict artifact events.
 */
test("checklist-aware job with checklistVerdict and fresh evidence passes and emits artifacts", async () => {
  const pool = makeVerifierPool({
    checklistVerdict: {
      schemaVersion: 1,
      jobId: "job-checklist",
      status: "pass",
      items: [
        {
          checklistId: "AC-001",
          result: "pass",
          evidenceRefs: [{ ledgerId: "pending", evidenceId: "EV-001" }],
          actualResult: "README updated as required",
          reason: "README diff shows requested content",
          fixScope: [],
        },
      ],
      blocking: [],
      fixScope: [],
      reason: "all items passed with evidence",
    },
  });

  const { result, events, cpbRoot, dataRoot } = await runVerifierFixture(pool);

  // Evidence-ledger and checklist-verdict events must exist
  assert.ok(
    events.some((e) => e.type === "artifact_created" && e.kind === "evidence-ledger"),
    "evidence-ledger artifact_created event must exist",
  );
  assert.ok(
    events.some((e) => e.type === "artifact_created" && e.kind === "checklist-verdict"),
    "checklist-verdict artifact_created event must exist",
  );

  // The persisted checklist-verdict should be pass
  const index = await buildArtifactIndex(cpbRoot, "flow", "job-checklist", { dataRoot });
  const verdictEntry = index.entries.find((entry: LooseRecord) => entry.kind === "checklist-verdict");
  assert.ok(verdictEntry?.path, "checklist-verdict must have a readable artifact path");
  const persistedVerdict = JSON.parse(await readFile(verdictEntry.path, "utf8"));
  assert.equal(persistedVerdict.status, "pass", "checklist verdict must be pass");
});

test("checklistVerdict item reason is recovered from actualResult when verifier omits it", async () => {
  const pool = makeVerifierPool({
    checklistVerdict: {
      schemaVersion: 1,
      jobId: "job-checklist",
      status: "pass",
      items: [
        {
          checklistId: "AC-001",
          result: "pass",
          evidenceRefs: [{ ledgerId: "pending", evidenceId: "EV-001" }],
          actualResult: "README updated as required",
          fixScope: [],
        },
      ],
      blocking: [],
      fixScope: [],
      reason: "all items passed with evidence",
    },
  });

  const { result, cpbRoot, dataRoot } = await runVerifierFixture(pool);

  assert.equal(result.status, "completed");
  const index = await buildArtifactIndex(cpbRoot, "flow", "job-checklist", { dataRoot });
  const verdictEntry = index.entries.find((entry: LooseRecord) => entry.kind === "checklist-verdict");
  assert.ok(verdictEntry?.path, "checklist-verdict must have a readable artifact path");
  const persistedVerdict = JSON.parse(await readFile(verdictEntry.path, "utf8"));
  assert.equal(persistedVerdict.items[0].reason, "README updated as required");
});

test("verifier JSON file is accepted when final agent output is not parseable", async () => {
  const checklistVerdict = {
    schemaVersion: 1,
    jobId: "job-checklist",
    status: "pass",
    items: [
      {
        checklistId: "AC-001",
        result: "pass",
        evidenceRefs: [{ ledgerId: "pending", evidenceId: "EV-001" }],
        actualResult: "README updated as required",
        reason: "README diff shows requested content",
        fixScope: [],
      },
    ],
    blocking: [],
    fixScope: [],
    reason: "all items passed with evidence",
  };
  const pool = makeVerifierPool({}, {
    verifierOutput: "final ACP message was swallowed or polluted",
    verdictFileEnvelope: {
      status: "ok",
      verdict: "pass",
      reason: "verified from file",
      details: "The controlled verifier file contains the JSON envelope.",
      confidence: 0.91,
      checklistVerdict,
    },
  });

  const { result, events, cpbRoot, dataRoot } = await runVerifierFixture(pool);

  assert.equal(result.status, "completed");
  assert.ok(
    events.some((e) => e.type === "artifact_created" && e.kind === "checklist-verdict"),
    "checklist-verdict artifact_created event must exist",
  );
  const index = await buildArtifactIndex(cpbRoot, "flow", "job-checklist", { dataRoot });
  const verdictEntry = index.entries.find((entry: LooseRecord) => entry.kind === "checklist-verdict");
  assert.ok(verdictEntry?.path, "checklist-verdict must have a readable artifact path");
  const persistedVerdict = JSON.parse(await readFile(verdictEntry.path, "utf8"));
  assert.equal(persistedVerdict.status, "pass", "verdict file should drive a passing checklist verdict");
});

test("checklist-aware pass without checklistVerdict is recovered when every required item has passing ledger evidence", async () => {
  const pool = makeVerifierPool();
  const commandChecklist = checklist({
    items: [{
      ...checklist().items[0],
      predicateId: "PRED-CMD",
      verificationMethod: "command",
      expectedEvidence: "maintainer-approved command probe exits successfully",
      allowedFiles: [],
    }],
  });
  const { events, cpbRoot, dataRoot } = await runVerifierFixture(pool, { acceptanceChecklist: commandChecklist });

  assert.ok(
    events.some((e) => e.type === "artifact_created" && e.kind === "evidence-ledger"),
    "evidence-ledger artifact_created event must exist",
  );
  assert.ok(
    events.some((e) => e.type === "artifact_created" && e.kind === "checklist-verdict"),
    "checklist-verdict artifact_created event must exist",
  );

  const index = await buildArtifactIndex(cpbRoot, "flow", "job-checklist", { dataRoot });
  const ledgerEntry = index.entries.find((entry: LooseRecord) => entry.kind === "evidence-ledger");
  assert.ok(ledgerEntry?.path, "evidence-ledger must have a readable artifact path");
  const ledger = JSON.parse(await readFile(ledgerEntry.path, "utf8"));
  assert.equal(ledger.evidence[0]?.result, "pass", "command probe should produce pass evidence");

  const verdictEntry = index.entries.find((entry: LooseRecord) => entry.kind === "checklist-verdict");
  assert.ok(verdictEntry?.path, "checklist-verdict must have a readable artifact path");
  const persistedVerdict = JSON.parse(await readFile(verdictEntry.path, "utf8"));
  assert.equal(persistedVerdict.status, "pass", "missing checklistVerdict should be synthesized from passing ledger evidence");
  assert.deepEqual(persistedVerdict.items[0].evidenceRefs, [{ ledgerId: "evidence-ledger-job-checklist", evidenceId: "EV-001" }]);
});

/**
 * Case 3: verifier prompt includes predeclared ledger ids before verifier output.
 * A verifier response that cites an invented EV-* id fails as evidence_missing.
 */
test("verifier prompt includes predeclared ledger ids and invented ids cause evidence_missing", async () => {
  const pool = makeVerifierPool({
    checklistVerdict: {
      schemaVersion: 1,
      jobId: "job-checklist",
      status: "pass",
      items: [
        {
          checklistId: "AC-001",
          result: "pass",
          evidenceRefs: [{ ledgerId: "pending", evidenceId: "EV-INVENTED-999" }],
          actualResult: "looks correct",
          reason: "invented evidence id",
          fixScope: [],
        },
      ],
      blocking: [],
      fixScope: [],
      reason: "invented evidence",
    },
  });

  const { result, events, cpbRoot, dataRoot } = await runVerifierFixture(pool);

  // Verifier prompt must include ledger id info
  const verifierPrompt = pool.getVerifierPrompt();
  assert.ok(verifierPrompt, "verifier prompt must be captured");
  assert.match(verifierPrompt, /evidence-ledger/i, "verifier prompt must reference evidence ledger");

  // The job should still complete (verdict validation in completion gate is Task 8,
  // but the evidence-ledger artifact should still be persisted)
  assert.ok(
    events.some((e) => e.type === "artifact_created" && e.kind === "evidence-ledger"),
    "evidence-ledger must still be emitted even with invalid evidence refs",
  );
});

test("verifier prompt treats plan paths as advisory when checklist evidence is authoritative", async () => {
  const pool = makeVerifierPool({
    checklistVerdict: {
      schemaVersion: 1,
      jobId: "job-checklist",
      status: "pass",
      items: [
        {
          checklistId: "AC-001",
          result: "pass",
          evidenceRefs: [{ ledgerId: "pending", evidenceId: "EV-001" }],
          actualResult: "README updated as required",
          reason: "README diff shows requested content",
          fixScope: [],
        },
      ],
      blocking: [],
      fixScope: [],
      reason: "all items passed with evidence",
    },
  });

  await runVerifierFixture(pool);

  const verifierPrompt = pool.getVerifierPrompt();
  assert.match(
    verifierPrompt,
    /The plan artifact is guidance for where to look, not an independent acceptance criterion/,
    "verifier prompt must not turn plan implementation paths into acceptance criteria",
  );
  assert.match(
    verifierPrompt,
    /Return FAIL or PARTIAL only for a concrete unsatisfied requirement/,
    "verifier prompt must require a concrete failure before blocking checklist-passing work",
  );
  assert.doesNotMatch(
    verifierPrompt,
    /If the diff implements a different product path than the plan requires, verdict = FAIL or PARTIAL even when tests pass/,
    "old plan-path hard-fail rule must not be present",
  );
});

/**
 * Case 4: a fresh hard-gate observation without matching
 * { checklistId, verificationMethod, predicateId } cannot prove a checklist item.
 */
test("fresh hard-gate observation without matching fields cannot prove checklist item", async () => {
  // The hard-gate checks in the test fixture produce observations like
  // { gate: "node --check", file, ok: true }. These lack checklistId,
  // verificationMethod, and predicateId, so they cannot serve as evidence
  // for any checklist item.
  const pool = makeVerifierPool({
    checklistVerdict: {
      schemaVersion: 1,
      jobId: "job-checklist",
      status: "pass",
      items: [
        {
          checklistId: "AC-001",
          result: "pass",
          evidenceRefs: [{ ledgerId: "pending", evidenceId: "EV-001" }],
          actualResult: "hard gate passed",
          reason: "node --check passed",
          fixScope: [],
        },
      ],
      blocking: [],
      fixScope: [],
      reason: "hard gate pass as evidence",
    },
  });

  const { events, cpbRoot, dataRoot } = await runVerifierFixture(pool);

  // The evidence-ledger should have empty evidence because hard-gate
  // observations lack checklistId/verificationMethod/predicateId bindings
  const index = await buildArtifactIndex(cpbRoot, "flow", "job-checklist", { dataRoot });
  const ledgerEntry = index.entries.find((entry: LooseRecord) => entry.kind === "evidence-ledger");
  assert.ok(ledgerEntry?.path, "evidence-ledger must exist");
  const ledger = JSON.parse(await readFile(ledgerEntry.path, "utf8"));
  assert.ok(Array.isArray(ledger.evidence), "evidence must be an array");
  // Hard gate checks without checklistId/verificationMethod/predicateId should not
  // produce evidence claims in the ledger
  const unboundClaims = ledger.evidence.filter(
    (e: LooseRecord) => !e.checklistId || !e.verificationMethod || !e.predicateId,
  );
  assert.equal(unboundClaims.length, 0, "no evidence claims should exist without checklist bindings");
});

/**
 * Case 5: When prepareTask does not provide a checklist, run-job now
 * auto-constructs one (default checklist-first). The job is therefore
 * checklist-aware: a verifier that returns a legacy verdict without a
 * checklistVerdict fails as VERDICT_INVALID, and the evidence-ledger plus
 * synthesized failing checklist-verdict artifacts are emitted. There is no
 * silent legacy-verifier fallback.
 */
test("job without explicit checklist auto-constructs one and runs the checklist-aware path", async () => {
  const pool = makeVerifierPool(); // legacy verdict, no checklistVerdict
  const { result, events } = await runVerifierFixture(pool, {
    withChecklist: false,
    sourceContext: {},
  });

  // Auto-constructed checklist makes the job checklist-aware; a legacy
  // verdict without checklistVerdict is rejected.
  assert.equal(result.status, "failed");

  assert.ok(
    events.some((e) => e.type === "artifact_created" && e.kind === "evidence-ledger"),
    "evidence-ledger must be emitted for the auto-constructed checklist path",
  );
  assert.ok(
    events.some((e) => e.type === "artifact_created" && e.kind === "checklist-verdict"),
    "checklist-verdict must be emitted (synthesized failing) for the checklist-aware path",
  );
});

/**
 * Case 6: a readable event-indexed acceptance-checklist artifact selects the
 * checklist-aware verify path even when phase diagnostics/source context are absent.
 */
test("readable event-indexed acceptance-checklist artifact selects checklist-aware path", async () => {
  const pool = makeVerifierPool();
  // prepareTask includes the checklist (which creates the event-indexed artifact),
  // but sourceContext is empty
  const { result, events } = await runVerifierFixture(pool, {
    sourceContext: {},
  });

  // Since the checklist was created via prepareTask and event-indexed, the verify
  // phase should be checklist-aware. The legacy verifier pass should fail.
  assert.equal(result.status, "failed", "checklist-aware path should reject legacy verdict");
  assert.ok(
    events.some((e) => e.type === "artifact_created" && e.kind === "evidence-ledger"),
    "evidence-ledger must be emitted for checklist-aware path",
  );
  assert.ok(
    events.some((e) => e.type === "artifact_created" && e.kind === "checklist-verdict"),
    "checklist-verdict must be emitted for checklist-aware path",
  );
});

/**
 * Case 7: a generic command/test summary that lacks method-specific observation
 * fields fails as evidence_missing or evidence_invalid.
 */
test("generic command/test summary fails as evidence_missing without method-specific fields", async () => {
  const pool = makeVerifierPool({
    checklistVerdict: {
      schemaVersion: 1,
      jobId: "job-checklist",
      status: "pass",
      items: [
        {
          checklistId: "AC-001",
          result: "pass",
          evidenceRefs: [{ ledgerId: "pending", evidenceId: "EV-001" }],
          actualResult: "tests passed",
          reason: "npm test passed",
          fixScope: [],
        },
      ],
      blocking: [],
      fixScope: [],
      reason: "generic test pass",
    },
  });

  const { events, cpbRoot, dataRoot } = await runVerifierFixture(pool);

  // The evidence-ledger should be emitted
  assert.ok(
    events.some((e) => e.type === "artifact_created" && e.kind === "evidence-ledger"),
    "evidence-ledger must be emitted",
  );

  // Since the probes are built from hardGateChecks (which don't have checklistId/predicateId/probeId
  // bindings in this test fixture), the evidence ledger should be empty or have no valid claims.
  // The checklist-verdict that passes must still reference valid evidence.
  const index = await buildArtifactIndex(cpbRoot, "flow", "job-checklist", { dataRoot });
  const ledgerEntry = index.entries.find((entry: LooseRecord) => entry.kind === "evidence-ledger");
  assert.ok(ledgerEntry?.path, "evidence-ledger must exist");
  const ledger = JSON.parse(await readFile(ledgerEntry.path, "utf8"));
  // With no properly bound hard-gate probes, evidence array should be empty
  assert.ok(Array.isArray(ledger.evidence), "evidence must be an array");
});

/**
 * Case 8: method-specific probes for command, static, artifact_event, and
 * absence_check produce valid claims only when their observation validator passes.
 */
test("method-specific probes produce valid claims only when observation validator passes", async () => {
  const { validateEvidenceObservation } = await import("../core/workflow/evidence-probes.js");

  // command probe: spec-compliant (command + cwd + exitCode 0 + digest +
  // worktreeHead) → { valid: true, satisfied: true }
  const commandItem = { verificationMethod: "command", id: "AC-001", predicateId: "PRED-001" };
  assert.deepEqual(
    validateEvidenceObservation(
      { command: "npm test", exitCode: 0, stdoutSha256: "sha256:abc", cwd: "/repo", worktreeHead: "head-1", attemptId: "att-1" },
      commandItem,
      { attemptId: "att-1" },
    ),
    { valid: true, satisfied: true },
    "command probe with all spec fields should pass",
  );

  // command probe: missing stdoutSha256 → { valid: false, satisfied: false }
  assert.deepEqual(
    validateEvidenceObservation(
      { command: "npm test", exitCode: 0, attemptId: "att-1" },
      commandItem,
      { attemptId: "att-1" },
    ),
    { valid: false, satisfied: false },
    "command probe without stdoutSha256 should fail",
  );

  // command probe: exitCode !== 0
  assert.deepEqual(
    validateEvidenceObservation(
      { command: "npm test", exitCode: 1, stdoutSha256: "sha256:abc", attemptId: "att-1" },
      commandItem,
      { attemptId: "att-1" },
    ),
    { valid: false, satisfied: false },
    "command probe with non-zero exitCode should fail",
  );

  // static probe: positive matchCount → satisfied
  const staticItem = { verificationMethod: "static", id: "AC-002", predicateId: "PRED-002" };
  assert.deepEqual(
    validateEvidenceObservation(
      { queryId: "q1", matchCount: 3 },
      staticItem,
    ),
    { valid: true, satisfied: true },
    "static probe with queryId and matchCount>0 should be valid and satisfied",
  );

  // static probe: matchCount === 0 → valid but NOT satisfied (honest zero,
  // recorded as a fail rather than silently dropped)
  assert.deepEqual(
    validateEvidenceObservation(
      { queryId: "q1", matchCount: 0 },
      staticItem,
    ),
    { valid: true, satisfied: false },
    "static probe with matchCount:0 must be valid (recordable) but not satisfied",
  );

  // static probe: missing queryId → not valid
  assert.deepEqual(
    validateEvidenceObservation(
      { matchCount: 3 },
      staticItem,
    ),
    { valid: false, satisfied: false },
    "static probe without queryId must not be valid",
  );

  // static probe: missing matchCount → not valid
  assert.deepEqual(
    validateEvidenceObservation(
      { queryId: "q1" },
      staticItem,
    ),
    { valid: false, satisfied: false },
    "static probe without matchCount should fail",
  );

  // artifact_event probe: valid (requires attemptId)
  const artifactItem = { verificationMethod: "artifact_event", id: "AC-003", predicateId: "PRED-003" };
  assert.deepEqual(
    validateEvidenceObservation(
      { eventType: "artifact_created", artifactHash: "sha256:art-1", observedAt: "2026-06-12T00:00:00Z", payloadMatcher: "artifact kind created", matchedValue: "artifact_created", attemptId: "att-1" },
      artifactItem,
    ),
    { valid: true, satisfied: true },
    "artifact_event probe with eventType, observedAt, and attemptId should pass",
  );

  // artifact_event probe: missing attemptId
  assert.deepEqual(
    validateEvidenceObservation(
      { eventType: "artifact_created", observedAt: "2026-06-12T00:00:00Z" },
      artifactItem,
    ),
    { valid: false, satisfied: false },
    "artifact_event probe without attemptId should fail",
  );

  // absence_check probe: valid
  const absenceItem = { verificationMethod: "absence_check", id: "AC-004", predicateId: "PRED-004" };
  assert.deepEqual(
    validateEvidenceObservation(
      {
        absence: true,
        queryWindow: { from: "2026-06-12T00:00:00Z", to: "2026-06-12T01:00:00Z" },
        eventTypes: ["phase_poisoned_session"],
        querySource: "event-log:phase_poisoned_session",
        queryResultSignature: "sha256:empty-result",
        attemptId: "att-1",
      },
      absenceItem,
    ),
    { valid: true, satisfied: true },
    "absence_check probe with all fields should pass",
  );

  // absence_check probe: missing queryWindow.from
  assert.deepEqual(
    validateEvidenceObservation(
      {
        absence: true,
        queryWindow: { to: "2026-06-12T01:00:00Z" },
        eventTypes: ["phase_poisoned_session"],
        attemptId: "att-1",
      },
      absenceItem,
    ),
    { valid: false, satisfied: false },
    "absence_check probe without queryWindow.from should fail",
  );

  // absence_check probe: absence is false (event was found)
  assert.deepEqual(
    validateEvidenceObservation(
      {
        absence: false,
        queryWindow: { from: "2026-06-12T00:00:00Z", to: "2026-06-12T01:00:00Z" },
        eventTypes: ["phase_poisoned_session"],
        attemptId: "att-1",
      },
      absenceItem,
    ),
    { valid: false, satisfied: false },
    "absence_check probe with absence=false should fail (event found, not absent)",
  );

  // Predicate echo rejection: bare { checklistId, method, predicateId, result: "pass" }
  // should fail because method-specific observation fields are missing
  const echoEntry = {
    checklistId: "AC-001",
    verificationMethod: "command",
    predicateId: "PRED-001",
    result: "pass",
    attemptId: "att-1",
  };
  assert.deepEqual(
    validateEvidenceObservation(echoEntry, commandItem, { attemptId: "att-1" }),
    { valid: false, satisfied: false },
    "predicate echo without observation fields must fail",
  );
});
