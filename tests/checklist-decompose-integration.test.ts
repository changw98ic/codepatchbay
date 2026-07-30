/**
 * Integration tests for decomposeTaskToChecklistItems: the runAgent → parse →
 * validate → fail-closed orchestration (DECOMP-001/005). Uses a fake pool that
 * mirrors how runAgent maps pool.execute results. Does not go through runJob/
 * freezeChecklist (those are covered by the unit suite + kill-switch gate), so
 * the run-node-tests CPB_CHECKLIST_DECOMPOSE=0 default does not affect this file.
 */
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { FailureKind } from "../core/contracts/failure.js";
import { decomposeTaskToChecklistItems } from "../core/workflow/checklist-decomposer.js";
import {
  deriveRepositoryKey,
  deriveWorktreeKey,
  deriveSourceKey,
  canonicalStringify,
  snapshotIdentityPath,
  symbolShardPath,
} from "../core/indexing/local-code-index/index.js";
import type { LocalCodeIndexRef } from "../core/indexing/local-code-index/index.js";
import { recordValue } from "../shared/types.js";
import { tempRoot } from "./helpers.js";

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

function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Set up a minimal v2 local code index on disk for integration testing.
 *
 * Creates the storage structure that `queryLocalCodeIndex` expects:
 *   <cpbRoot>/indexes/local-code/v2/
 *     repositories/<repoKey>/objects/symbol-shards/<prefix>/<shardId>.json
 *     repositories/<repoKey>/objects.lock/
 *     <worktreeKey>/snapshots/<snapshotId>/identity.json
 */
async function setupV2LocalCodeIndex(
  cpbRoot: string,
  sourcePath: string,
  symbols: Array<{ name: string; kind?: string; path?: string }>,
): Promise<LocalCodeIndexRef> {
  // sourcePath must already be canonicalized (resolve symlinks before calling).
  const repoKey = deriveRepositoryKey(sourcePath);
  const wtKey = deriveWorktreeKey(sourcePath);
  const srcKey = deriveSourceKey(repoKey, wtKey);
  const storageRoot = path.join(cpbRoot, "indexes", "local-code", "v2");

  // Build symbol shard entries.
  const entries = symbols.map((sym) => {
    const filePath = sym.path ?? "src/partition.ts";
    return {
      symbol: sym.name,
      kind: sym.kind ?? "function",
      role: "definition" as const,
      path: filePath,
      range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 20 },
      exported: true,
      coverage: "ast-grep-structural",
    };
  });

  const shard = { entries, fileSummaries: [] };
  const shardBytes = new TextEncoder().encode(canonicalStringify(shard));
  const shardId = createHash("sha256").update(shardBytes).digest("hex").slice(0, 16);

  // Write symbol shard.
  const shardPath = symbolShardPath(storageRoot, repoKey, shardId);
  await mkdir(path.dirname(shardPath), { recursive: true });
  await writeFile(shardPath, shardBytes);

  // Build and write snapshot identity.
  const identity = {
    schemaVersion: 2 as const,
    repositoryKey: repoKey,
    worktreeKey: wtKey,
    sourceKey: srcKey,
    sourcePath,
    git: null,
    worktreeStateFingerprint: "test-fingerprint",
    inventory: {
      "src/partition.ts": {
        fileObjectId: "test-file-obj",
        metadata: { size: "100", mtimeMs: "0" },
      },
    },
    extractorFingerprint: "test-extractor",
    symbolShardIds: [shardId],
    relationShardIds: [],
    toolState: {
      name: "ast-grep" as const,
      version: "test",
      extractorFingerprint: "test-extractor",
      available: true,
      coverage: { effective: "ast-grep-structural" as const, partial: false, failedFiles: 0, oversizedFiles: 0 },
      errors: [],
    },
    indexMapHash: "test-hash",
    indexMapByteLength: 0,
  };

  const identityBytes = new TextEncoder().encode(canonicalStringify(identity));
  const snapshotId = "idx2-" + createHash("sha256").update(identityBytes).digest("hex").slice(0, 24);

  const identityPath = snapshotIdentityPath(storageRoot, wtKey, snapshotId);
  await mkdir(path.dirname(identityPath), { recursive: true });
  await writeFile(identityPath, identityBytes);

  // Note: do NOT pre-create the objects.lock directory.
  // acquireIndexLock creates it on first use; pre-creating an empty lock
  // directory causes "index lock exists without valid owner" errors.

  return {
    schemaVersion: 2,
    sourcePath,
    repositoryKey: repoKey,
    worktreeKey: wtKey,
    sourceKey: srcKey,
    snapshotId,
  };
}

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
    ...makeCtx(makeFakePool(VALID, (call) => { observed = call; })),
    workflow: "complex",
    sourceContext: { riskMap: { riskLevel: "high", domains: ["provider_pool"] } },
    env: {
      CPB_ACP_TOOL_CALL_BUDGET_PREPARE_TASK: "999",
    },
  };

  const r = await decomposeTaskToChecklistItems({ task: "fix provider pool queue behavior", ctx });

  assert.equal(r.ok, true);
  assert.equal(observed.agent, "fake-planner");
  assert.equal(observed.meta.phase, "prepare_task");
  assert.equal(observed.meta.role, "checklist_decomposer");
  assert.equal(observed.meta.env.CPB_TASK_RISK_LEVEL, "high");
  assert.equal(observed.meta.env.CPB_ACP_TOOL_CALL_BUDGET_PREPARE_TASK, "999");
  assert.equal(observed.meta.env.CPB_ACP_TOOL_EVENT_BUDGET_PREPARE_TASK, "0");
  assert.equal(observed.meta.env.CPB_ACP_TOOL_CALL_BUDGET_PLAN, undefined);
  assert.equal(JSON.parse(String(observed.meta.env.CPB_TASK_PHASE_BUDGET_POLICY_JSON)).phases.prepare_task.toolCallBudget, 60);
});

test("decompose: local code index fast path reads the v2 index via query", async () => {
  const { realpath } = await import("node:fs/promises");
  const cpbRootRaw = await tempRoot("cpb-checklist-v2-cpb");
  const sourcePathRaw = await tempRoot("cpb-checklist-v2-src");
  const cpbRoot = await realpath(cpbRootRaw);
  const sourcePath = await realpath(sourcePathRaw);
  const ref = await setupV2LocalCodeIndex(cpbRoot, sourcePath, [
    { name: "partition", kind: "function" },
  ]);

  const r = await decomposeTaskToChecklistItems({
    task: "Fix partition() without mutating its input.",
    ctx: {
      ...makeCtx(makeFakePool(new Error("agent fallback must not run"))),
      cpbRoot,
      sourcePath,
      planMode: "light",
      sourceContext: {
        riskMap: { riskLevel: "low" },
        localCodeIndexReadiness: { available: true, ref },
      },
    },
  });

  assert.equal(r.ok, true, `expected ok, got reason: ${r.reason}`);
  assert.deepEqual(r.items?.[0].allowedFiles, ["src/partition.ts"]);
  assert.equal(recordValue(r.diagnostics).source, "local_code_index_exact_symbol");
  assert.equal(recordValue(r.diagnostics).indexSnapshotId, ref.snapshotId);
});

test("decompose: local code index fast path preabort does not read or fall back to agent", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("preabort local index", "AbortError"));

  let agentCalls = 0;
  await assert.rejects(
    decomposeTaskToChecklistItems({
      task: "Fix partition() without mutating its input.",
      ctx: {
        ...makeCtx(makeFakePool(VALID, () => { agentCalls += 1; })),
        planMode: "light",
        sourceContext: {
          riskMap: { riskLevel: "low" },
          localCodeIndexReadiness: {
            available: true,
            ref: {
              schemaVersion: 2,
              sourcePath: "/does/not/matter",
              repositoryKey: "a".repeat(32),
              worktreeKey: "b".repeat(32),
              sourceKey: "c".repeat(64),
              snapshotId: "idx2-" + "d".repeat(24),
            },
          },
        },
        signal: controller.signal,
      },
    }),
    isAbortError,
  );
  assert.equal(agentCalls, 0);
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
  const r = await decomposeTaskToChecklistItems({
    task: "t",
    ctx: {
      ...makeCtx(makeFakePool(new Error("fake-planner exited 1: temporary transport error"))),
      env: { CPB_CHECKLIST_DECOMPOSE_RETRY_MAX: "0" },
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, FailureKind.AGENT_EXIT_NONZERO);
  assert.equal(r.retryable, true);
  assert.match(r.reason!, /temporary transport error/);
});

test("decompose: retries retryable agent failure before accepting valid output", async () => {
  const pool = makeSequencedPool([new Error("planner timed out after 10ms"), VALID]);
  const r = await decomposeTaskToChecklistItems({
    task: "add --json to status",
    ctx: {
      ...makeCtx(pool),
      env: {
        CPB_CHECKLIST_DECOMPOSE_RETRY_MAX: "1",
        CPB_CHECKLIST_DECOMPOSE_RETRY_BASE_DELAY_MS: "0",
      },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(pool.calls, 2);
  assert.equal(r.items![0].predicateId, "status-json");
});

test("decompose: abort during retry backoff returns promptly without a second provider call", async () => {
  const controller = new AbortController();
  const pool = makeSequencedPool([new Error("planner timed out after 10ms"), VALID]);
  setTimeout(() => controller.abort(), 0);

  await assert.rejects(
    decomposeTaskToChecklistItems({
      task: "add --json to status",
      ctx: {
        ...makeCtx(pool),
        signal: controller.signal,
        env: {
          CPB_CHECKLIST_DECOMPOSE_RETRY_MAX: "1",
          CPB_CHECKLIST_DECOMPOSE_RETRY_BASE_DELAY_MS: "10000",
        },
      },
    }),
    isAbortError,
  );

  assert.equal(pool.calls, 1);
});
