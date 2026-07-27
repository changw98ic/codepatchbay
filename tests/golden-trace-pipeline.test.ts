/**
 * Golden Trace — run/pipeline event sequence characterization.
 *
 * PURPOSE
 *   Pin the EXACT ordered sequence of event types that today's runJob pipeline
 *   appends to a job event log, from creation to terminal, so that kernel
 *   refactors (Phase 4 runDagNode execution-chain split, RunJobContext cleanup)
 *   can be compared event-by-event against this frozen baseline.
 *
 *   This is CHARACTERIZATION (Phase 0): it freezes CURRENT behavior, not
 *   desired behavior. If a refactor intentionally reorders/removes events,
 *   update GOLDEN_TRACE here as part of that change and explain why in the
 *   commit message.
 *
 * HARNESS CHOICE
 *   A full end-to-end `cpb pipeline` drive spawns real ACP agent processes and
 *   is not deterministic. Instead we invoke `runJob` from core/engine/run-job.ts
 *   directly with injected fake ports — the same proven pattern used by
 *   tests/engine-run-job.test.ts (runEngine/makeServices/makePool). That file
 *   does not export its helpers, so this test is self-contained and mirrors the
 *   idiom: a fake provider pool returns canned plan/execute/verify output, and
 *   every event-writing port funnels through one ordered recorder.
 *
 * CAPTURE SEMANTICS
 *   In production the durable event log (cpb-task/events/<project>/<jobId>.jsonl)
 *   is written exclusively via appendEvent, but several runJob ports internally
 *   call appendEvent to persist their own events:
 *     - createJob  -> "job_created"
 *     - startPhase -> "phase_started"   (one per DAG phase)
 *     - completeJob-> "job_completed"
 *   To faithfully capture "creation -> terminal", this harness funnels those
 *   ports through the same recorder with their canonical event types. The
 *   completePhase port is stubbed without an event push: in production it
 *   appends "phase_completed" for DAG phases, but the kernel never emits that
 *   for DAG phases via its own appendEvent (only prepare_task's phase_completed
 *   flows through appendEvent directly), so it is out of scope for this kernel
 *   trace and intentionally absent from GOLDEN_TRACE.
 *
 * DETERMINISM
 *   Standard workflow, medium risk map (no adversarial_verify insertion), full
 *   planMode, checklist decomposition disabled (CPB_CHECKLIST_DECOMPOSE=0,
 *   forced by the test runner), no high-assurance tournament, no routing
 *   overrides, no hub root (so no provider-usage delegation). Phase retry
 *   budgets are pinned via TEST_JOB_ENV. The fake pool never triggers fallback
 *   or retry, so the sequence is fully determined.
 *
 * When this test fails after a kernel change, the diagnostic prints the actual
 * sequence — copy it into GOLDEN_TRACE only after confirming the new order is
 * intentional.
 */

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { runJob as runJobImpl } from "../core/engine/run-job.js";
import { tempRoot } from "./helpers.js";
import type { LooseRecord } from "../shared/types.js";

// ─── Deterministic retry timing (mirrors tests/engine-run-job.test.ts) ───
const TEST_JOB_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  CPB_PHASE_RETRY_MAX: "1",
  CPB_PHASE_RETRY_BASE_DELAY_MS: "0",
  CPB_PHASE_FEEDBACK_RETRY_MAX: "1",
};

const runJob = (ctx: LooseRecord) => runJobImpl({ ...ctx, env: ctx.env ?? TEST_JOB_ENV });

// ─── Fake agent output envelopes (mirrors tests/engine-run-job.test.ts) ───
function jsonEnvelope(data: LooseRecord) {
  return `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
}

function phaseOutput(role: string, overrides: LooseRecord = {}) {
  if (role === "planner") {
    return jsonEnvelope({
      status: "ok",
      planMarkdown: [
        "## Analysis",
        "- Golden-trace fixture plan.",
        "",
        "## Bounded Handoff",
        "- Real actors: runJob fixture and README.md",
        "- Entrypoints: standard workflow DAG execution",
        "- Bypass candidates: provider fallback and retry paths",
        "- Edit files: README.md",
        "- Verification targets: node:test fixture",
        "- Blockers: none",
        "",
        "## Files to modify",
        "- README.md",
        "",
        "## Implementation Steps",
        "1. Step one.",
        "",
        "## Testing",
        "- node:test fixture",
        "",
        "## Risks",
        "- None.",
      ].join("\n"),
      ...overrides,
    });
  }
  if (role === "executor" || role === "security-reviewer") {
    return jsonEnvelope({
      status: "ok",
      summary: "Fixture execution completed.",
      tests: ["tests/golden-trace-pipeline.test.js"],
      risks: [],
      ...overrides,
    });
  }
  const verdictStatus = String(overrides.verdict || "pass").toLowerCase() === "pass" ? "pass" : "fail";
  return jsonEnvelope({
    status: "ok",
    verdict: verdictStatus,
    reason: "Fixture verified.",
    details: "Fake provider completed the phase.",
    confidence: 1,
    checklistVerdict: {
      schemaVersion: 1,
      jobId: "job-runjob-test",
      status: verdictStatus,
      items: [
        {
          checklistId: "AC-001",
          result: verdictStatus,
          evidenceRefs: verdictStatus === "pass" ? [{ ledgerId: "evidence-ledger-job-runjob-test", evidenceId: "EV-001" }] : [],
          actualResult: verdictStatus === "pass" ? "fixture verified" : "fixture failed",
          reason: verdictStatus === "pass" ? "fake verifier confirms the fixture" : "fake verifier reports fixture failure",
          fixScope: verdictStatus === "pass" ? [] : ["README.md"],
        },
      ],
      blocking: verdictStatus === "pass" ? [] : [{ checklistId: "AC-001" }],
      fixScope: verdictStatus === "pass" ? [] : ["README.md"],
      reason: verdictStatus === "pass" ? "all items passed with evidence" : "required item failed",
    },
    ...overrides,
  });
}

function mediumRiskMap(): LooseRecord {
  return {
    riskLevel: "medium",
    domains: ["test_fixture"],
    highRiskFiles: [],
    safetyBoundaries: [],
    verificationDepth: "standard",
    adversarialRequired: false,
    adversarialFocus: [],
    confidence: "high",
  };
}

async function makeSourceRoot() {
  const sourcePath = await tempRoot("cpb-golden-source");
  await writeFile(path.join(sourcePath, "README.md"), "# golden-trace fixture\n", "utf8");
  await writeFile(
    path.join(sourcePath, "package.json"),
    `${JSON.stringify({ name: "golden-trace-fixture", private: true }, null, 2)}\n`,
    "utf8",
  );
  return sourcePath;
}

/**
 * Recorder + fake ports. Every event-writing port pushes its canonical event
 * type into `recorded` in call order. appendEvent records the event.type as
 * emitted by the kernel.
 */
function makeRecordingServices(recorded: string[]) {
  return {
    createJob: async (_cpbRoot: string, job: LooseRecord) => {
      recorded.push("job_created");
      return { ...job, jobId: job.jobId || "job-runjob-test", status: "running" };
    },
    prepareTask: async () => ({ riskMap: mediumRiskMap() }),
    startPhase: async (_cpbRoot: string, _project: string, _jobId: string, { phase }: { phase: string }) => {
      recorded.push("phase_started");
      void phase;
    },
    completePhase: async () => {
      // No event push: DAG-phase "phase_completed" is a completePhase port
      // responsibility in production and is out of scope for this kernel trace
      // (see top-of-file comment).
    },
    completeJob: async () => {
      recorded.push("job_completed");
    },
    blockJob: async () => {
      recorded.push("job_blocked");
    },
    failJob: async () => {
      recorded.push("job_failed");
    },
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: LooseRecord) => {
      recorded.push(String(event.type));
      return event;
    },
  };
}

function makePool() {
  return {
    async execute(agent: string, prompt: string, _cwd: string, _timeoutMs: number, meta: LooseRecord) {
      return {
        output: phaseOutput(meta.role),
        providerKey: agent,
        variant: null,
      };
    },
    async releaseWorktree() {
      return true;
    },
  };
}

// ─── Frozen golden trace (CURRENT behavior) ───────────────────────────────
//
// Sequence for a standard workflow, medium risk, full planMode, deterministic
// fake pool, no adversarial verify, no high-assurance, no routing overrides.
//
//  1. job_created                  (createJob port)
//  2. job_started                  (appendEvent — createJobAndHandleBlocked)
//  3. phase_started                (appendEvent — prepare_task)
//  4. riskmap_generated            (appendEvent — prepare_task)
//  5. phase_completed              (appendEvent — prepare_task)
//  6. artifact_created             (appendEvent — acceptance-checklist)
//  7. workflow_dag_materialized    (appendEvent)
//  8. dynamic_agent_plan_generated (appendEvent)
//  --- plan phase (1 artifact: promptArtifact) ---
//  9. phase_started                (startPhase port — plan)
// 10. dag_node_started             (appendEvent — plan)
// 11. agent_routing_decision       (appendEvent — plan)
// 12. artifact_created             (appendEvent — plan: promptArtifact via emitDiagnosticArtifactEvents)
// 13. dag_node_completed           (appendEvent — plan)
// 14. phase_result                 (appendEvent — plan)
// 15. agent_routing_result         (appendEvent — plan)
//  --- execute phase (2 artifacts: executionMapArtifact + promptArtifact) ---
// 16. phase_started                (startPhase port — execute)
// 17. dag_node_started             (appendEvent — execute)
// 18. agent_routing_decision       (appendEvent — execute)
// 19. artifact_created             (appendEvent — execute: executionMapArtifact)
// 20. artifact_created             (appendEvent — execute: promptArtifact)
// 21. dag_node_completed           (appendEvent — execute)
// 22. phase_result                 (appendEvent — execute)
// 23. agent_routing_result         (appendEvent — execute)
//  --- verify phase (3 artifacts: primary + promptArtifact + verdict) ---
// 24. phase_started                (startPhase port — verify)
// 25. dag_node_started             (appendEvent — verify)
// 26. agent_routing_decision       (appendEvent — verify)
// 27. artifact_created             (appendEvent — verify: primary artifact, written via writeRuntimeArtifactEvent)
// 28. artifact_created             (appendEvent — verify: promptArtifact diagnostic, via emitDiagnosticArtifactEvents)
// 29. artifact_created             (appendEvent — verify: verdict diagnostic, via emitDiagnosticArtifactEvents)
// 30. dag_node_completed           (appendEvent — verify)
// 31. phase_result                 (appendEvent — verify)
// 32. agent_routing_result         (appendEvent — verify)
//  --- completion ---
// 33. completion_gate_evaluated    (appendEvent)
// 34. job_completed                (completeJob port)
// 35. runtime_context_snapshot     (appendEvent — finalizeAuditTrail)
// 36. audit_finalized              (appendEvent — finalizeAuditTrail)
//
// NOTE: verify emits 3 artifact_created events today because the verifier
// phaseResult carries a primary artifact plus diagnostic artifacts
// (promptArtifact + verdict), and emitDiagnosticArtifactEvents (called by
// finalizePhaseResult) appends one artifact_created per diagnostic artifact
// whose name differs from the primary. This is the CURRENT characterized
// behavior; if the kernel stops emitting one of these, update this list.
const GOLDEN_TRACE: string[] = [
  "job_created",
  "job_started",
  "phase_started",
  "riskmap_generated",
  "phase_completed",
  "artifact_created",
  "workflow_dag_materialized",
  "dynamic_agent_plan_generated",
  // plan (promptArtifact)
  "phase_started",
  "dag_node_started",
  "agent_routing_decision",
  "artifact_created",
  "dag_node_completed",
  "phase_result",
  "agent_routing_result",
  // execute (executionMapArtifact + promptArtifact)
  "phase_started",
  "dag_node_started",
  "agent_routing_decision",
  "artifact_created",
  "artifact_created",
  "dag_node_completed",
  "phase_result",
  "agent_routing_result",
  // verify (primary artifact + promptArtifact + verdict diagnostic)
  "phase_started",
  "dag_node_started",
  "agent_routing_decision",
  "artifact_created",
  "artifact_created",
  "artifact_created",
  "dag_node_completed",
  "phase_result",
  "agent_routing_result",
  // completion
  "completion_gate_evaluated",
  "job_completed",
  "runtime_context_snapshot",
  "audit_finalized",
];

function assertSequence(actual: string[]) {
  if (actual.length === GOLDEN_TRACE.length && actual.every((t, i) => t === GOLDEN_TRACE[i])) return;
  // Diagnostic: print actual vs expected so a stale golden list is a one-shot fix.
  const expectedBlock = GOLDEN_TRACE.map((t) => `      ${JSON.stringify(t)},`).join("\n");
  const actualBlock = actual.map((t) => `      ${JSON.stringify(t)},`).join("\n");
  const diffLines: string[] = [];
  const max = Math.max(actual.length, GOLDEN_TRACE.length);
  for (let i = 0; i < max; i++) {
    const a = actual[i];
    const g = GOLDEN_TRACE[i];
    if (a !== g) diffLines.push(`  [${i}] expected=${JSON.stringify(g)} actual=${JSON.stringify(a)}`);
  }
  assert.fail(
    [
      "Golden trace mismatch (event type sequence from creation to terminal).",
      "If the new order is intentional, replace GOLDEN_TRACE with the actual block below.",
      "",
      `expected (${GOLDEN_TRACE.length}):`,
      expectedBlock,
      "",
      `actual (${actual.length}):`,
      actualBlock,
      "",
      "first diffs:",
      diffLines.slice(0, 12).join("\n") || "(none — lengths differ)",
    ].join("\n"),
  );
}

test("golden trace: standard pipeline appends the frozen ordered event sequence from creation to terminal", async () => {
  const cpbRoot = await tempRoot("cpb-golden-cpb");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await makeSourceRoot();
  const recorded: string[] = [];

  const result = await runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "runJob engine fixture",
    jobId: "job-runjob-test",
    workflow: "standard",
    planMode: "full",
    sourcePath,
    sourceContext: {},
    agents: {
      planner: "fake-primary",
      executor: "fake-primary",
      verifier: "fake-primary",
    },
    ...makeRecordingServices(recorded),
    getPool: () => makePool(),
  });

  assert.equal(result.status, "completed", `golden trace must reach terminal=completed, got: ${JSON.stringify(result.failure)}`);
  assert.equal(result.exitCode, 0);
  assertSequence(recorded);
});

test("golden trace invariant: job_created is first and audit_finalized is last (creation→terminal bracket)", async () => {
  const cpbRoot = await tempRoot("cpb-golden-bracket");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await makeSourceRoot();
  const recorded: string[] = [];

  await runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "runJob engine fixture",
    jobId: "job-runjob-test",
    workflow: "standard",
    planMode: "full",
    sourcePath,
    sourceContext: {},
    agents: {
      planner: "fake-primary",
      executor: "fake-primary",
      verifier: "fake-primary",
    },
    ...makeRecordingServices(recorded),
    getPool: () => makePool(),
  });

  assert.equal(recorded[0], "job_created");
  assert.equal(recorded[recorded.length - 1], "audit_finalized");
  // runtime_context_snapshot must immediately precede audit_finalized (finalizeAuditTrail order).
  assert.equal(recorded[recorded.length - 2], "runtime_context_snapshot");
});
