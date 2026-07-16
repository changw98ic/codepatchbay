/**
 * Integration tests for decomposeTaskToChecklistItems: the runAgent → parse →
 * validate → fail-closed orchestration (DECOMP-001/005). Uses a fake pool that
 * mirrors how runAgent maps pool.execute results. Does not go through runJob/
 * freezeChecklist (those are covered by the unit suite + kill-switch gate), so
 * the run-node-tests CPB_CHECKLIST_DECOMPOSE=0 default does not affect this file.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { FailureKind } from "../core/contracts/failure.js";
import { decomposeTaskToChecklistItems } from "../core/workflow/checklist-decomposer.js";

function makeFakePool(outputOrError, onExecute = null) {
  return {
    async execute(agent, prompt, cwd, timeoutMs, meta) {
      if (onExecute) onExecute({ agent, prompt, cwd, timeoutMs, meta });
      if (outputOrError instanceof Error) throw outputOrError;
      return { output: outputOrError, providerKey: "fake", variant: null };
    },
  };
}

function makeSequencedPool(sequence) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async execute(_agent, _prompt, _cwd, _timeoutMs, _meta) {
      const value = sequence[Math.min(calls, sequence.length - 1)];
      calls += 1;
      if (value instanceof Error) throw value;
      return { output: value, providerKey: "fake", variant: null };
    },
  };
}

function makeCtx(pool) {
  return {
    pool,
    project: "p",
    jobId: "job-decompose",
    sourcePath: ".",
    cpbRoot: ".",
    dataRoot: null,
    env: {},
    agents: { planner: "fake-planner" },
  };
}

const VALID = '```json\n{"status":"ok","decomposedItems":[{"requirement":"support --json","predicateId":"status-json","verificationMethod":"static","allowedFiles":["cli/commands/status.ts"],"sourceRefs":[{"kind":"task_text","locator":"task:0"}]}]}\n```';

test("decompose: pool returns valid items -> ok with allowedFiles", async () => {
  const r = await decomposeTaskToChecklistItems({ task: "add --json to status", ctx: makeCtx(makeFakePool(VALID)) });
  assert.equal(r.ok, true);
  assert.equal(r.items!.length, 1);
  assert.equal(r.items![0].predicateId, "status-json");
  assert.deepEqual(r.items![0].allowedFiles, ["cli/commands/status.ts"]);
});

test("decompose: prepare_task agent call receives risk budget env", async () => {
  let observed;
  const ctx = {
    ...makeCtx(makeFakePool(VALID, ({ meta }) => { observed = meta; })),
    workflow: "complex",
    sourceContext: { riskMap: { riskLevel: "high", domains: ["provider_pool"] } },
    env: {
      CPB_ACP_TOOL_CALL_BUDGET_PREPARE_TASK: "999",
    },
  };

  const r = await decomposeTaskToChecklistItems({ task: "fix provider pool queue behavior", ctx });

  assert.equal(r.ok, true);
  assert.equal(observed.phase, "prepare_task");
  assert.equal(observed.env.CPB_TASK_RISK_LEVEL, "high");
  assert.equal(observed.env.CPB_ACP_TOOL_CALL_BUDGET_PREPARE_TASK, "999");
  assert.equal(observed.env.CPB_ACP_TOOL_EVENT_BUDGET_PREPARE_TASK, "240");
  assert.equal(observed.env.CPB_ACP_TOOL_CALL_BUDGET_PLAN, undefined);
  assert.equal(JSON.parse(String(observed.env.CPB_TASK_PHASE_BUDGET_POLICY_JSON)).phases.prepare_task.toolCallBudget, 60);
});

test("decompose: pool returns no decomposedItems -> fail-closed", async () => {
  const r = await decomposeTaskToChecklistItems({
    task: "t",
    ctx: makeCtx(makeFakePool('```json\n{"status":"ok","planMarkdown":"not a decomposition"}\n```')),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /decomposed items invalid|not valid JSON/);
});

test("decompose: pool returns malformed JSON -> fail-closed", async () => {
  const r = await decomposeTaskToChecklistItems({
    task: "t",
    ctx: makeCtx(makeFakePool("this is not json at all")),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /not valid JSON/);
});

test("decompose: pool returns items with empty allowedFiles -> fail-closed (scope required)", async () => {
  const r = await decomposeTaskToChecklistItems({
    task: "t",
    ctx: makeCtx(makeFakePool('```json\n{"status":"ok","decomposedItems":[{"requirement":"r","predicateId":"p","verificationMethod":"static","allowedFiles":[]}]}\n```')),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /allowedFiles/);
});

test("decompose: agent (pool) throws -> fail-closed", async () => {
  const r = await decomposeTaskToChecklistItems({
    task: "t",
    ctx: makeCtx(makeFakePool(new Error("agent unavailable"))),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /decompose agent failed/);
});

test("decompose: retryable agent failure preserves kind and retryability", async () => {
  const previous = process.env.CPB_CHECKLIST_DECOMPOSE_RETRY_MAX;
  process.env.CPB_CHECKLIST_DECOMPOSE_RETRY_MAX = "0";
  try {
    const r = await decomposeTaskToChecklistItems({
      task: "t",
      ctx: makeCtx(makeFakePool(new Error("fake-planner exited 1: temporary transport error"))),
    });
    assert.equal(r.ok, false);
    assert.equal(r.kind, FailureKind.AGENT_EXIT_NONZERO);
    assert.equal(r.retryable, true);
    assert.match(r.reason!, /temporary transport error/);
  } finally {
    if (previous === undefined) delete process.env.CPB_CHECKLIST_DECOMPOSE_RETRY_MAX;
    else process.env.CPB_CHECKLIST_DECOMPOSE_RETRY_MAX = previous;
  }
});

test("decompose: retries retryable agent failure before accepting valid output", async () => {
  const previousMax = process.env.CPB_CHECKLIST_DECOMPOSE_RETRY_MAX;
  const previousDelay = process.env.CPB_CHECKLIST_DECOMPOSE_RETRY_BASE_DELAY_MS;
  process.env.CPB_CHECKLIST_DECOMPOSE_RETRY_MAX = "1";
  process.env.CPB_CHECKLIST_DECOMPOSE_RETRY_BASE_DELAY_MS = "0";
  try {
    const pool = makeSequencedPool([new Error("planner timed out after 10ms"), VALID]);
    const r = await decomposeTaskToChecklistItems({ task: "add --json to status", ctx: makeCtx(pool) });
    assert.equal(r.ok, true);
    assert.equal(pool.calls, 2);
    assert.equal(r.items![0].predicateId, "status-json");
  } finally {
    if (previousMax === undefined) delete process.env.CPB_CHECKLIST_DECOMPOSE_RETRY_MAX;
    else process.env.CPB_CHECKLIST_DECOMPOSE_RETRY_MAX = previousMax;
    if (previousDelay === undefined) delete process.env.CPB_CHECKLIST_DECOMPOSE_RETRY_BASE_DELAY_MS;
    else process.env.CPB_CHECKLIST_DECOMPOSE_RETRY_BASE_DELAY_MS = previousDelay;
  }
});
