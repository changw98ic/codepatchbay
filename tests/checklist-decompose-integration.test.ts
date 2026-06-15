/**
 * Integration tests for decomposeTaskToChecklistItems: the runAgent → parse →
 * validate → fail-closed orchestration (DECOMP-001/005). Uses a fake pool that
 * mirrors how runAgent maps pool.execute results. Does not go through runJob/
 * freezeChecklist (those are covered by the unit suite + kill-switch gate), so
 * the run-node-tests CPB_CHECKLIST_DECOMPOSE=0 default does not affect this file.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { decomposeTaskToChecklistItems } from "../core/workflow/checklist-decomposer.js";

function makeFakePool(outputOrError) {
  return {
    async execute(_agent, _prompt, _cwd, _timeoutMs, _meta) {
      if (outputOrError instanceof Error) throw outputOrError;
      return { output: outputOrError, providerKey: "fake", variant: null };
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
