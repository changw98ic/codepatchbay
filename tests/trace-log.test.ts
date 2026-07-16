import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { emitPhaseResultEvent } from "../core/engine/phase-result-events.js";
import { emitPhaseStartEvents } from "../core/engine/phase-start-events.js";
import { writeRuntimeArtifactEvent } from "../core/engine/runtime-artifact-events.js";
import { writeArtifact } from "../core/artifacts/artifact-store.js";
import { appendEvent, materializeJob, readEvents } from "../server/services/event/event-store.js";
import { buildJobTrace, formatTraceHuman } from "../server/services/trace/trace-log.js";
import { buildJobReplay, recordExternalEvaluation } from "../server/services/trace/trace-replay.js";
import { tempRoot } from "./helpers.js";
import { run as runJobsCommand } from "../cli/commands/jobs.js";

test("event store adds stable trace identifiers to job and phase events", async () => {
  const cpbRoot = await tempRoot("cpb-trace-event");
  const dataRoot = path.join(cpbRoot, "runtime");
  const project = "flow";
  const jobId = "job-trace-auto";

  await appendEvent(cpbRoot, project, jobId, {
    type: "job_created",
    jobId,
    project,
    task: "trace everything",
    ts: "2026-07-08T00:00:00.000Z",
  }, { dataRoot });
  await emitPhaseStartEvents({
    cpbRoot,
    project,
    jobId,
    phase: "plan",
    role: "planner",
    nodeId: "plan",
    selectedAgent: "codex",
    appendEvent: (root, proj, job, event) => appendEvent(root, proj, job, event, { dataRoot }),
    now: () => "2026-07-08T00:00:01.000Z",
  });

  const eventFile = path.join(dataRoot, "events", project, `${jobId}.jsonl`);
  const events = (await readFile(eventFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  const created = events.find((event) => event.type === "job_created");
  const phaseStarted = events.find((event) => event.type === "phase_started");
  const dagStarted = events.find((event) => event.type === "dag_node_started");

  assert.equal(created.traceId, jobId);
  assert.equal(created.spanId, "job:job-trace-auto");
  assert.equal(created.parentSpanId, null);
  assert.equal(phaseStarted.traceId, jobId);
  assert.equal(phaseStarted.spanId, "phase:plan");
  assert.equal(phaseStarted.parentSpanId, "job:job-trace-auto");
  assert.equal(dagStarted.traceId, jobId);
  assert.equal(dagStarted.spanId, "dag:plan");
  assert.equal(dagStarted.parentSpanId, "phase:plan");
});

test("buildJobTrace projects phase, prompt, usage, and retry decision spans", async () => {
  const cpbRoot = await tempRoot("cpb-trace-project");
  const dataRoot = path.join(cpbRoot, "runtime");
  const project = "flow";
  const jobId = "job-trace-tree";
  const auditPath = path.join(dataRoot, "audit", "verify.jsonl");
  await mkdir(path.dirname(auditPath), { recursive: true });
  await writeFile(
    auditPath,
    [
      {
        event: "agent_launch",
        phase: "verify",
        role: "verifier",
        agent: "claude-mimo",
        executionPolicy: {
          codexSandboxMode: null,
          effectiveSandboxMode: "read-only",
          sandboxEnforcement: "cpb-outer",
          codexApprovalPolicy: null,
          outerSandboxMode: "required",
          outerSandboxProvider: "sandbox-exec",
          outerWorkspaceWritable: false,
          outerWriteRootCount: 4,
        },
      },
      { event: "tool_call", phase: "verify", role: "verifier", toolCallId: "tool-1", title: "Read sphinx/domains/python.py", kind: "read", status: "in_progress" },
      { event: "tool_call", phase: "verify", role: "verifier", toolCallId: "tool-1", title: null, kind: null, status: "completed" },
      { event: "tool_call", phase: "verify", role: "verifier", toolCallId: "tool-2", title: "Run canonical pytest", kind: "terminal", status: "failed" },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );

  await appendEvent(cpbRoot, project, jobId, {
    type: "job_created",
    jobId,
    project,
    task: "fix verifier routing",
    ts: "2026-07-08T00:00:00.000Z",
  }, { dataRoot });
  await appendEvent(cpbRoot, project, jobId, {
    type: "scheduler_decision_applied",
    jobId,
    project,
    attemptId: "attempt-1",
    mode: "smart",
    rank: 1,
    score: 88,
    reasons: ["evidence-backed-fresh-attempt"],
    retryStrategy: "fresh_attempt",
    failureFingerprint: "sha256:failure",
    ts: "2026-07-08T00:00:00.500Z",
  }, { dataRoot });
  await emitPhaseStartEvents({
    cpbRoot,
    project,
    jobId,
    phase: "verify",
    role: "verifier",
    nodeId: "verify",
    selectedAgent: "claude-mimo",
    attemptId: "attempt-1",
    phaseRoutingDecision: {
      role: "verifier",
      preferredAgent: "codex",
      selectedAgent: "claude-mimo",
      fallbackApplied: false,
      reason: "independent verifier required",
      taskCategory: "bugfix",
      selectionSource: "dynamic_agent_plan",
      outcomeApplied: true,
      outcomeReason: "independent verifier required",
      independenceApplied: true,
      independenceConflict: false,
      excludedProviderFamily: "codex",
      candidates: [{ agent: "codex", value: 0.7 }, { agent: "claude-mimo", value: 0.8 }],
      thresholds: { minSamples: 12 },
    },
    appendEvent: (root, proj, job, event) => appendEvent(root, proj, job, event, { dataRoot }),
    now: () => "2026-07-08T00:00:01.000Z",
  });
  await emitPhaseResultEvent({
    cpbRoot,
    project,
    jobId,
    phase: "verify",
    agentName: "claude-mimo",
    attemptId: "attempt-1",
    phaseResult: {
      schemaVersion: 1,
      phase: "verify",
      status: "failed",
      artifact: { name: "verdict-123" },
      failure: {
        kind: "verification_failed",
        phase: "verify",
        reason: "AC-002 failed",
        retryable: true,
        cause: {},
      },
      diagnostics: {
        promptArtifact: { name: "prompt-verify-123" },
        acpAuditFile: auditPath,
        usage: {
          inputTokens: 100,
          cachedInputTokens: 30,
          outputTokens: 20,
          reasoningOutputTokens: 5,
          totalTokens: 120,
          costUsd: null,
          tokenSource: "acp_audit_prompt_usage:codex_session_rollout_delta",
          toolCalls: 2,
          functionCalls: null,
        },
      },
    },
    appendEvent: (root, proj, job, event) => appendEvent(root, proj, job, event, { dataRoot }),
    now: () => "2026-07-08T00:00:05.000Z",
  });
  await appendEvent(cpbRoot, project, jobId, {
    type: "agent_routing_result",
    jobId,
    project,
    phase: "verify",
    role: "verifier",
    attemptId: "attempt-1",
    preferredAgent: "codex",
    selectedAgent: "claude-mimo",
    finalAgent: "claude-mimo",
    providerKey: "claude:mimo",
    status: "failed",
    failureKind: "verification_failed",
    fallbackApplied: false,
    fallbackCount: 0,
    ts: "2026-07-08T00:00:05.500Z",
  }, { dataRoot });
  await appendEvent(cpbRoot, project, jobId, {
    type: "retry_decision",
    jobId,
    project,
    phase: "verify",
    action: "retry_same_worker",
    retryPhase: "execute",
    reason: "verification failed: AC-002 failed",
    failureClass: "implementation_error",
    failureFingerprint: "sha256:retry-failure",
    failureEvidence: { fixScope: ["src/parser.ts"] },
    retryStrategy: "fresh_session_diagnosis",
    strategyChanged: true,
    forceFreshSession: true,
    ts: "2026-07-08T00:00:06.000Z",
  }, { dataRoot });
  await appendEvent(cpbRoot, project, jobId, {
    type: "provider_handoff",
    jobId,
    project,
    phase: "verify",
    role: "verifier",
    attemptId: "attempt-1",
    attempt: 1,
    from: "codex",
    to: "claude-mimo",
    failureKind: "agent_unavailable",
    handoffKind: "provider_transport",
    status: "transport_failure",
    midRun: true,
    reason: "stream disconnected before completion",
    ts: "2026-07-08T00:00:06.500Z",
  }, { dataRoot });

  const trace = await buildJobTrace({ cpbRoot, project, jobId, dataRoot });

  assert.equal(trace.traceId, jobId);
  assert.equal(trace.root.name, "job job-trace-tree");
  assert.equal(trace.root.attributes.task, "fix verifier routing");
  const schedulerSpan = trace.spans.find((span) => span.kind === "scheduler");
  assert.ok(schedulerSpan);
  assert.equal(schedulerSpan.parentSpanId, `job:${jobId}`);
  assert.equal(schedulerSpan.attributes["scheduler.rank"], 1);
  assert.equal(schedulerSpan.attributes["scheduler.score"], 88);
  assert.equal(schedulerSpan.attributes["retry.strategy"], "fresh_attempt");
  assert.equal(schedulerSpan.attributes["failure.fingerprint"], "sha256:failure");
  const verifySpan = trace.spans.find((span) => span.spanId === "phase:verify:attempt:attempt-1");
  assert.ok(verifySpan);
  assert.equal(verifySpan.status, "failed");
  assert.equal(verifySpan.attributes["llm.agent"], "claude-mimo");
  assert.equal(verifySpan.attributes["llm.usage.total_tokens"], 120);
  assert.equal(verifySpan.attributes["llm.usage.cached_input_tokens"], 30);
  assert.equal(verifySpan.attributes["llm.usage.reasoning_output_tokens"], 5);
  assert.equal(verifySpan.attributes["llm.usage.token_source"], "acp_audit_prompt_usage:codex_session_rollout_delta");
  assert.equal(verifySpan.attributes["llm.usage.tool_calls"], 2);
  assert.equal(verifySpan.attributes["llm.usage.function_calls"], null);
  assert.equal(verifySpan.attributes["llm.cost_usd"], null);
  assert.equal(verifySpan.attributes["prompt.artifact"], "prompt-verify-123");
  assert.equal(verifySpan.attributes["failure.kind"], "verification_failed");
  const routingSpan = trace.spans.find((span) => span.kind === "routing" && span.attributes["phase"] === "verify");
  assert.ok(routingSpan);
  assert.equal(routingSpan.status, "failed");
  assert.equal(routingSpan.attributes["routing.preferred_agent"], "codex");
  assert.equal(routingSpan.attributes["routing.selected_agent"], "claude-mimo");
  assert.equal(routingSpan.attributes["routing.final_agent"], "claude-mimo");
  assert.equal(routingSpan.attributes["routing.provider_key"], "claude:mimo");
  assert.equal(routingSpan.attributes["routing.task_category"], "bugfix");
  assert.equal(routingSpan.attributes["routing.independence_applied"], true);
  assert.equal(routingSpan.attributes["routing.excluded_provider_family"], "codex");
  assert.equal(routingSpan.attributes["routing.final_status"], "failed");
  assert.equal(routingSpan.attributes["routing.failure_kind"], "verification_failed");
  assert.equal(Array.isArray(routingSpan.attributes["routing.candidates"]), true);
  const retrySpan = trace.spans.find((span) => span.spanId === "retry:verify:execute");
  assert.ok(retrySpan);
  assert.equal(retrySpan.parentSpanId, "phase:verify");
  assert.equal(retrySpan.attributes["retry.action"], "retry_same_worker");
  assert.equal(retrySpan.attributes["failure.class"], "implementation_error");
  assert.equal(retrySpan.attributes["failure.fingerprint"], "sha256:retry-failure");
  assert.deepEqual(retrySpan.attributes["failure.evidence"], { fixScope: ["src/parser.ts"] });
  assert.equal(retrySpan.attributes["retry.strategy"], "fresh_session_diagnosis");
  assert.equal(retrySpan.attributes["retry.strategy_changed"], true);
  assert.equal(retrySpan.attributes["retry.force_fresh_session"], true);
  const handoffSpan = trace.spans.find((span) => span.kind === "provider_handoff");
  assert.ok(handoffSpan);
  assert.equal(handoffSpan.spanId, "provider:handoff:verify:codex:claude-mimo:attempt:attempt-1:iteration:1");
  assert.equal(handoffSpan.parentSpanId, "phase:verify:attempt:attempt-1");
  assert.equal(handoffSpan.attributes["provider.from"], "codex");
  assert.equal(handoffSpan.attributes["provider.to"], "claude-mimo");
  assert.equal(handoffSpan.attributes["provider.handoff_kind"], "provider_transport");
  assert.equal(handoffSpan.attributes["provider.status"], "transport_failure");
  assert.equal(handoffSpan.attributes["provider.mid_run"], true);
  assert.equal(handoffSpan.attributes["failure.kind"], "agent_unavailable");
  const failedToolSpan = trace.spans.find((span) => span.spanId === "tool:verify:tool-2:attempt:attempt-1");
  assert.ok(failedToolSpan);
  assert.equal(failedToolSpan.parentSpanId, "phase:verify:attempt:attempt-1");
  assert.equal(failedToolSpan.status, "failed");
  assert.equal(failedToolSpan.attributes["tool.name"], "Run canonical pytest");
  const readToolSpan = trace.spans.find((span) => span.spanId === "tool:verify:tool-1:attempt:attempt-1");
  assert.ok(readToolSpan);
  assert.equal(readToolSpan.attributes["tool.name"], "Read sphinx/domains/python.py");
  assert.equal(readToolSpan.attributes["tool.kind"], "read");
  const executionPolicySpan = trace.spans.find((span) => span.kind === "execution_policy");
  assert.ok(executionPolicySpan);
  assert.equal(executionPolicySpan.spanId, "policy:verify:attempt:attempt-1");
  assert.equal(executionPolicySpan.parentSpanId, "phase:verify:attempt:attempt-1");
  assert.equal(executionPolicySpan.attributes["execution.effective_sandbox_mode"], "read-only");
  assert.equal(executionPolicySpan.attributes["execution.sandbox_enforcement"], "cpb-outer");
  assert.equal(executionPolicySpan.attributes["execution.outer_workspace_writable"], false);
  assert.match(formatTraceHuman(trace), /phase verify failed/);
});

test("buildJobTrace keeps retry iterations and solver candidates distinct within an attempt", async () => {
  const cpbRoot = await tempRoot("cpb-trace-attempt-identity");
  const dataRoot = path.join(cpbRoot, "runtime");
  const project = "flow";
  const jobId = "job-trace-attempt";
  const identity = {
    assignmentId: "a-entry-1",
    attemptId: "attempt-2",
  };

  const events = [
    {
      type: "job_created",
      jobId,
      project,
      task: "trace solver iterations",
      ts: "2026-07-08T00:00:00.000Z",
    },
    {
      type: "phase_started",
      jobId,
      project,
      phase: "execute",
      ...identity,
      ts: "2026-07-08T00:00:01.000Z",
    },
    {
      type: "phase_retry",
      jobId,
      project,
      phase: "execute",
      attempt: 1,
      ...identity,
      ts: "2026-07-08T00:00:02.000Z",
    },
    {
      type: "phase_retry",
      jobId,
      project,
      phase: "execute",
      attempt: 2,
      ...identity,
      ts: "2026-07-08T00:00:03.000Z",
    },
    {
      type: "solver_candidate_started",
      jobId,
      project,
      phase: "execute",
      iteration: 2,
      candidateId: "candidate-a",
      ...identity,
      ts: "2026-07-08T00:00:04.000Z",
    },
    {
      type: "solver_candidate_completed",
      jobId,
      project,
      phase: "execute",
      iteration: 2,
      candidateId: "candidate-a",
      ...identity,
      ts: "2026-07-08T00:00:05.000Z",
    },
    {
      type: "solver_candidate_started",
      jobId,
      project,
      phase: "execute",
      iteration: 2,
      candidateId: "candidate-b",
      ...identity,
      ts: "2026-07-08T00:00:06.000Z",
    },
  ];
  for (const event of events) {
    await appendEvent(cpbRoot, project, jobId, event, { dataRoot });
  }

  const trace = await buildJobTrace({ cpbRoot, project, jobId, dataRoot });
  const phaseSpanId = "phase:execute:assignment:a-entry-1:attempt:attempt-2";
  const retryOne = trace.spans.find((span) => span.spanId === "retry:execute:phase_retry:assignment:a-entry-1:attempt:attempt-2:iteration:1");
  const retryTwo = trace.spans.find((span) => span.spanId === "retry:execute:phase_retry:assignment:a-entry-1:attempt:attempt-2:iteration:2");
  const candidateA = trace.spans.find((span) => span.spanId === "solver:execute:solver_candidate:assignment:a-entry-1:attempt:attempt-2:iteration:2:candidate:candidate-a");
  const candidateB = trace.spans.find((span) => span.spanId === "solver:execute:solver_candidate:assignment:a-entry-1:attempt:attempt-2:iteration:2:candidate:candidate-b");

  assert.ok(trace.spans.some((span) => span.spanId === phaseSpanId));
  assert.ok(retryOne);
  assert.ok(retryTwo);
  assert.notEqual(retryOne.spanId, retryTwo.spanId);
  assert.equal(retryOne.parentSpanId, phaseSpanId);
  assert.equal(retryTwo.parentSpanId, phaseSpanId);
  assert.ok(candidateA);
  assert.ok(candidateB);
  assert.equal(candidateA.parentSpanId, phaseSpanId);
  assert.equal(candidateA.events.length, 2);
  assert.equal(candidateA.status, "passed");
  assert.equal(candidateA.attributes["assignment.id"], "a-entry-1");
  assert.equal(candidateA.attributes["attempt.id"], "attempt-2");
  assert.equal(candidateA.attributes.iteration, 2);
  assert.equal(candidateA.attributes["candidate.id"], "candidate-a");
  assert.match(formatTraceHuman(trace), /assignment=a-entry-1 attempt=attempt-2 iteration=2 candidate=candidate-a/);
});

test("completion-gate repair trace exposes gate fingerprint, checklist targets, and candidate transition", async () => {
  const cpbRoot = await tempRoot("cpb-trace-completion-repair");
  const dataRoot = path.join(cpbRoot, "runtime");
  const project = "flow";
  const jobId = "job-trace-completion-repair";
  const common = {
    jobId,
    project,
    attemptId: "attempt-1",
    phase: "execute",
    iteration: 1,
    candidateId: "candidate-before",
    failureFingerprint: "sha256:gate-failure",
    gateOutcome: "evidence_mismatch",
    targetChecklistIds: ["AC-002"],
    fixScope: ["src/parser.ts"],
    strategy: "targeted_repair",
  };
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_created",
    jobId,
    project,
    ts: "2026-07-12T00:00:00.000Z",
  }, { dataRoot });
  await appendEvent(cpbRoot, project, jobId, {
    type: "phase_started",
    jobId,
    project,
    phase: "execute",
    attemptId: "attempt-1",
    ts: "2026-07-12T00:00:01.000Z",
  }, { dataRoot });
  await appendEvent(cpbRoot, project, jobId, {
    type: "solver_completion_gate_repair_started",
    ...common,
    ts: "2026-07-12T00:00:02.000Z",
  }, { dataRoot });
  await appendEvent(cpbRoot, project, jobId, {
    type: "solver_completion_gate_repair_completed",
    ...common,
    resultCandidateId: "candidate-after",
    status: "passed",
    ts: "2026-07-12T00:00:04.000Z",
  }, { dataRoot });

  const trace = await buildJobTrace({ cpbRoot, project, jobId, dataRoot });
  const span = trace.spans.find((entry) => entry.spanId.includes("solver_completion_gate_repair"));
  assert.ok(span);
  assert.equal(span.kind, "solver");
  assert.equal(span.status, "passed");
  assert.equal(span.attributes["failure.fingerprint"], "sha256:gate-failure");
  assert.equal(span.attributes["completion.outcome"], "evidence_mismatch");
  assert.deepEqual(span.attributes["checklist.targets"], ["AC-002"]);
  assert.deepEqual(span.attributes["fix.scope"], ["src/parser.ts"]);
  assert.equal(span.attributes["candidate.id"], "candidate-before");
  assert.equal(span.attributes["candidate.result_id"], "candidate-after");
});

test("jobs trace command prints a JSON trace for a project job", async () => {
  const cpbRoot = await tempRoot("cpb-trace-cli");
  const dataRoot = path.join(cpbRoot, "runtime");
  const project = "flow";
  const jobId = "job-trace-cli";
  const writes: string[] = [];
  const originalLog = console.log;
  const originalEnv = process.env.CPB_PROJECT_RUNTIME_ROOT;

  await appendEvent(cpbRoot, project, jobId, {
    type: "job_created",
    jobId,
    project,
    task: "inspect trace",
    ts: "2026-07-08T00:00:00.000Z",
  }, { dataRoot });

  try {
    process.env.CPB_PROJECT_RUNTIME_ROOT = dataRoot;
    console.log = (value?: unknown) => {
      writes.push(String(value));
    };
    await runJobsCommand(["trace", project, jobId, "--json"], { cpbRoot });
  } finally {
    console.log = originalLog;
    if (originalEnv === undefined) delete process.env.CPB_PROJECT_RUNTIME_ROOT;
    else process.env.CPB_PROJECT_RUNTIME_ROOT = originalEnv;
  }

  const parsed = JSON.parse(writes.join("\n"));
  assert.equal(parsed.traceId, jobId);
  assert.equal(parsed.root.spanId, `job:${jobId}`);
});

test("job replay reconstructs the decision timeline, persisted patch, and external false-positive boundary", async () => {
  const cpbRoot = await tempRoot("cpb-trace-replay");
  const dataRoot = path.join(cpbRoot, "runtime");
  const project = "flow";
  const jobId = "job-trace-replay";
  const candidateIdentityHash = `sha256:${"a".repeat(64)}`;
  const patch = "diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+ok\n";
  const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const unsignedBundle = {
    schemaVersion: 1,
    baseSha: "1".repeat(40),
    expectedTreeHash: "2".repeat(40),
    candidateIdentityHash,
    patchSha256: sha256(patch),
    patchBytes: Buffer.byteLength(patch),
    patch,
  };
  const bundle = {
    ...unsignedBundle,
    bundleHash: sha256(JSON.stringify({
      schemaVersion: unsignedBundle.schemaVersion,
      baseSha: unsignedBundle.baseSha,
      expectedTreeHash: unsignedBundle.expectedTreeHash,
      candidateIdentityHash: unsignedBundle.candidateIdentityHash,
      patchSha256: unsignedBundle.patchSha256,
      patchBytes: unsignedBundle.patchBytes,
    })),
  };

  await appendEvent(cpbRoot, project, jobId, {
    type: "job_created",
    jobId,
    project,
    task: "fix ordinary application behavior",
    ts: "2026-07-12T00:00:00.000Z",
  }, { dataRoot });
  const artifact = await writeArtifact(cpbRoot, {
    project,
    jobId,
    kind: "candidate-replay-bundle",
    content: JSON.stringify(bundle, null, 2),
    dataRoot,
  });
  await writeRuntimeArtifactEvent({
    cpbRoot,
    project,
    jobId,
    phase: "execute",
    artifact,
    attemptId: "attempt-1",
    appendEvent: (root, proj, job, event) => appendEvent(root, proj, job, event, { dataRoot }),
    now: () => "2026-07-12T00:00:01.000Z",
  });
  await appendEvent(cpbRoot, project, jobId, {
    type: "completion_gate_evaluated",
    jobId,
    project,
    attemptId: "attempt-1",
    outcome: "complete",
    reason: "all internal gates passed",
    missingGates: [],
    completionReport: {
      commands: ["npm test -- known"],
      changedFiles: ["a.txt"],
      candidateValidation: {
        identityHash: candidateIdentityHash,
        patchHash: `sha256:${"d".repeat(64)}`,
        treeHash: bundle.expectedTreeHash,
        cleanReplay: { cleanApply: true, replayMethod: "persisted_patch_bundle" },
      },
    },
    ts: "2026-07-12T00:00:02.000Z",
  }, { dataRoot });
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_completed",
    jobId,
    project,
    ts: "2026-07-12T00:00:03.000Z",
  }, { dataRoot });
  const external = await recordExternalEvaluation({
    cpbRoot,
    project,
    jobId,
    dataRoot,
    evaluation: {
      evaluator: "independent-harness",
      status: "failed",
      candidateIdentityHash,
      summary: "a required behavior still fails",
      checks: [{ command: "npm test -- hidden", status: "failed", reason: "assertion failed" }],
    },
    now: () => "2026-07-12T00:00:04.000Z",
  });
  assert.equal(external?.type, "external_evaluation_recorded", "post-terminal external audit event must be retained");
  const materialized = materializeJob(await readEvents(cpbRoot, project, jobId, { dataRoot }));
  assert.equal(materialized.status, "completed");
  assert.equal(materialized.completionGate?.outcome, "complete");
  assert.equal(materialized.externalEvaluation, undefined, "external evaluation must remain audit-only and outside solver state");

  const replay = await buildJobReplay({ cpbRoot, project, jobId, dataRoot, includePatch: true });
  const replayBundle = replay.candidateBundle && typeof replay.candidateBundle === "object"
    ? replay.candidateBundle as Record<string, unknown>
    : {};
  assert.equal(replay.decisionBoundary.classification, "test_selection_gap");
  assert.equal(replay.decisionBoundary.boundary, "verification_coverage");
  assert.deepEqual(replay.decisionBoundary.missingExternalChecks, ["npm test -- hidden"]);
  assert.equal(replayBundle.valid, true);
  assert.equal(replayBundle.bundleHash, bundle.bundleHash);
  assert.equal(replayBundle.patch, patch);
  assert.equal(replay.coverage.stages.task.present, true);
  assert.equal(replay.coverage.stages.finalPatch.present, true);
  assert.ok(replay.coverage.missing.includes("verifier"), "synthetic replay must report its deliberately missing verifier stage");
  assert.ok(replay.timeline.some((entry) => entry.type === "external_evaluation_recorded"));
  assert.ok(replay.decisions.externalEvaluations.some((entry) => entry.attributes["external.evaluator"] === "independent-harness"));

  const writes: string[] = [];
  const originalLog = console.log;
  const evaluationFile = path.join(cpbRoot, "external-evaluation.json");
  await writeFile(evaluationFile, JSON.stringify({
    evaluator: "independent-harness",
    status: "failed",
    candidateIdentityHash,
    summary: "same external result imported through the generic CLI",
    checks: [{ command: "npm test -- hidden", status: "failed" }],
  }), "utf8");
  try {
    console.log = (value?: unknown) => { writes.push(String(value)); };
    const recordExitCode = await runJobsCommand([
      "record-evaluation",
      project,
      jobId,
      "--file",
      evaluationFile,
      "--data-root",
      dataRoot,
    ], { cpbRoot });
    assert.equal(recordExitCode, 0);
    const recorded = JSON.parse(writes.join("\n"));
    assert.equal(recorded.type, "external_evaluation_recorded");
    writes.length = 0;
    const exitCode = await runJobsCommand([
      "trace",
      project,
      jobId,
      "--replay",
      "--include-patch",
      "--json",
      "--data-root",
      dataRoot,
    ], { cpbRoot });
    assert.equal(exitCode, 0);
  } finally {
    console.log = originalLog;
  }
  const cliReplay = JSON.parse(writes.join("\n"));
  assert.equal(cliReplay.decisionBoundary.classification, "test_selection_gap");
  assert.equal(cliReplay.candidateBundle.patch, patch);

  await recordExternalEvaluation({
    cpbRoot,
    project,
    jobId,
    dataRoot,
    evaluation: {
      evaluator: "independent-harness",
      status: "failed",
      candidateIdentityHash,
      checks: [{ command: "npm test -- known", status: "failed" }],
    },
    now: () => "2026-07-12T00:00:05.000Z",
  });
  const falsePositiveReplay = await buildJobReplay({ cpbRoot, project, jobId, dataRoot });
  assert.equal(falsePositiveReplay.decisionBoundary.classification, "completion_false_positive");
  assert.equal(falsePositiveReplay.decisionBoundary.boundary, "completion_gate");

  await recordExternalEvaluation({
    cpbRoot,
    project,
    jobId,
    dataRoot,
    evaluation: {
      evaluator: "independent-harness",
      status: "failed",
      candidateIdentityHash: `sha256:${"f".repeat(64)}`,
      checks: [{ command: "npm test -- known", status: "failed" }],
    },
    now: () => "2026-07-12T00:00:06.000Z",
  });
  const lineageReplay = await buildJobReplay({ cpbRoot, project, jobId, dataRoot });
  assert.equal(lineageReplay.decisionBoundary.classification, "evaluation_lineage_mismatch");
  assert.equal(lineageReplay.decisionBoundary.boundary, "candidate_identity");
});

test("job replay recognizes completed ACP execute tools that run tests", async () => {
  const cpbRoot = await tempRoot("cpb-trace-execute-test");
  const dataRoot = path.join(cpbRoot, "runtime");
  const project = "flow";
  const jobId = "job-trace-execute-test";
  const auditPath = path.join(dataRoot, "audit", jobId + ".jsonl");
  await mkdir(path.dirname(auditPath), { recursive: true });
  await writeFile(auditPath, [
    { event: "agent_launch", phase: "execute", role: "executor", agent: "codex" },
    { event: "tool_call", phase: "execute", role: "executor", toolCallId: "test-1", title: "npm test", kind: "execute", status: "in_progress" },
    { event: "tool_call", phase: "execute", role: "executor", toolCallId: "test-1", title: "npm test", kind: "execute", status: "completed" },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");

  await appendEvent(cpbRoot, project, jobId, {
    type: "job_created",
    jobId,
    project,
    task: "fix an ordinary behavior",
    ts: "2026-07-12T00:00:00.000Z",
  }, { dataRoot });
  await emitPhaseStartEvents({
    cpbRoot,
    project,
    jobId,
    phase: "execute",
    role: "executor",
    nodeId: "execute",
    selectedAgent: "codex",
    attemptId: "attempt-1",
    appendEvent: (root, proj, job, event) => appendEvent(root, proj, job, event, { dataRoot }),
    now: () => "2026-07-12T00:00:01.000Z",
  });
  await emitPhaseResultEvent({
    cpbRoot,
    project,
    jobId,
    phase: "execute",
    agentName: "codex",
    attemptId: "attempt-1",
    phaseResult: {
      schemaVersion: 1,
      phase: "execute",
      status: "passed",
      artifact: null,
      diagnostics: { acpAuditFile: auditPath },
    },
    appendEvent: (root, proj, job, event) => appendEvent(root, proj, job, event, { dataRoot }),
    now: () => "2026-07-12T00:00:02.000Z",
  });
  await appendEvent(cpbRoot, project, jobId, {
    type: "completion_gate_evaluated",
    jobId,
    project,
    outcome: "complete",
    completionReport: { commands: [] },
    ts: "2026-07-12T00:00:03.000Z",
  }, { dataRoot });

  const replay = await buildJobReplay({ cpbRoot, project, jobId, dataRoot });
  assert.equal(replay.coverage.stages.tests.present, true);
  assert.equal(replay.coverage.missing.includes("tests"), false);
});

test("job replay identifies an internal completion false negative", async () => {
  const cpbRoot = await tempRoot("cpb-trace-false-negative");
  const dataRoot = path.join(cpbRoot, "runtime");
  const project = "flow";
  const jobId = "job-trace-false-negative";
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_created",
    jobId,
    project,
    task: "ordinary coding task",
    ts: "2026-07-12T00:00:00.000Z",
  }, { dataRoot });
  await appendEvent(cpbRoot, project, jobId, {
    type: "completion_gate_evaluated",
    jobId,
    project,
    outcome: "checklist_failed",
    reason: "internal verifier rejected the candidate",
    missingGates: ["checklist"],
    ts: "2026-07-12T00:00:01.000Z",
  }, { dataRoot });
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_failed",
    jobId,
    project,
    ts: "2026-07-12T00:00:02.000Z",
  }, { dataRoot });
  await recordExternalEvaluation({
    cpbRoot,
    project,
    jobId,
    dataRoot,
    evaluation: { evaluator: "independent-harness", status: "passed" },
    now: () => "2026-07-12T00:00:03.000Z",
  });

  const replay = await buildJobReplay({ cpbRoot, project, jobId, dataRoot });
  assert.equal(replay.decisionBoundary.classification, "completion_false_negative");
  assert.equal(replay.decisionBoundary.boundary, "completion_gate");
});
