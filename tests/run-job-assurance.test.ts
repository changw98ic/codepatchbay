import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  buildEvidencePack,
  runHighAssurancePlanning,
  type AssuranceContext,
} from "../core/engine/run-job-assurance.js";
import { withArtifactStoreTestHooks } from "../core/artifacts/artifact-store.js";
import { FailureKind } from "../core/contracts/failure.js";
import {
  buildLocalCodeIndexEvidence,
  taskSymbolCandidates,
} from "../core/indexing/local-code-index/evidence.js";
import type {
  LocalCodeIndexQueryResult,
} from "../core/indexing/local-code-index/contracts.js";
import { tempRoot } from "./helpers.js";

// ── v2 index ref fixture ──────────────────────────────────────────────────────

async function localIndexFixture(root: string) {
  // Create a v2-format index ref. The actual index storage is handled by the
  // v2 service; for testing we use this ref in sourceContext and test the
  // evidence rendering path directly via buildLocalCodeIndexEvidence.
  const ref = {
    schemaVersion: 2 as const,
    sourcePath: root,
    repositoryKey: "test-repository-key",
    worktreeKey: "test-worktree-key",
    sourceKey: "test-source-key",
    snapshotId: "snapshot-test",
  };
  return ref;
}

// ── v2 query result fixtures ──────────────────────────────────────────────────

function definitionsResult(symbols: Array<{ symbol: string; path: string; kind: string }>): LocalCodeIndexQueryResult {
  return {
    kind: "definitions",
    snapshotId: "snapshot-test",
    coverage: { effective: "ast-grep-structural", partial: false, failedFiles: 0, oversizedFiles: 0 },
    truncated: false,
    durationMs: 5,
    occurrences: symbols.map((s) => ({
      symbol: s.symbol,
      kind: s.kind,
      role: "definition" as const,
      path: s.path,
      range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: s.symbol.length },
      exported: false,
      coverage: "ast-grep-structural" as const,
    })),
  } as LocalCodeIndexQueryResult;
}

function inventoryResult(files: Array<{ path: string; size: number }>): LocalCodeIndexQueryResult {
  return {
    kind: "inventory",
    snapshotId: "snapshot-test",
    coverage: { effective: "ast-grep-structural", partial: false, failedFiles: 0, oversizedFiles: 0 },
    truncated: false,
    durationMs: 3,
    files: files.map((f) => ({
      path: f.path,
      language: "typescript",
      size: f.size,
      nodeCount: 1,
      coverage: "ast-grep-structural" as const,
    })),
    nextCursor: null,
  } as LocalCodeIndexQueryResult;
}

function relatedFilesResult(files: Array<{ path: string; score: number }>): LocalCodeIndexQueryResult {
  return {
    kind: "related-files",
    snapshotId: "snapshot-test",
    coverage: { effective: "ast-grep-structural", partial: false, failedFiles: 0, oversizedFiles: 0 },
    truncated: false,
    durationMs: 4,
    files: files.map((f) => ({
      path: f.path,
      score: f.score,
      evidence: [{
        fromPath: "src/parser.ts",
        toPath: f.path,
        type: "imports" as const,
        symbol: null,
        evidence: [],
        weight: 1,
      }],
    })),
  } as LocalCodeIndexQueryResult;
}

// ── Context builder ───────────────────────────────────────────────────────────

function assuranceContext(
  root: string,
  options: { env?: NodeJS.ProcessEnv; ref?: { schemaVersion: 2; sourcePath: string; repositoryKey: string; worktreeKey: string; sourceKey: string; snapshotId: string } } = {},
): AssuranceContext {
  return {
    cpbRoot: root,
    project: "project",
    task: "inspect env",
    sourcePath: root,
    dataRoot: null,
    sourceContext: options.ref
      ? { localCodeIndexReadiness: { available: true, ref: options.ref } }
      : {},
    agents: null,
    timeouts: {},
    env: options.env,
    scope: null,
    _attemptId: "attempt",
    getPool: () => null,
    appendEvent: async () => {},
    blockJob: async () => {},
    failJob: async () => {},
    onProgress: null,
  };
}

async function outputFiles(root: string) {
  try {
    return await readdir(path.join(root, "wiki", "outputs"));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return [];
    throw error;
  }
}

// ── v2 evidence rendering tests ───────────────────────────────────────────────

test("v2 evidence renderer produces structured output from query results", () => {
  // Test buildLocalCodeIndexEvidence directly with v2 query results.
  // This exercises the v2 rendering path without needing a real index on disk.
  const queryResults: Record<string, LocalCodeIndexQueryResult> = {
    definitions: definitionsResult([
      { symbol: "inspect", path: "src/env-inspector.ts", kind: "function" },
      { symbol: "inspectEnv", path: "src/cli.ts", kind: "function" },
    ]),
    inventory: inventoryResult([
      { path: "src/env-inspector.ts", size: 512 },
      { path: "src/cli.ts", size: 1024 },
      { path: "src/utils.ts", size: 256 },
    ]),
    "related-files": relatedFilesResult([
      { path: "src/config.ts", score: 2.5 },
      { path: "src/loader.ts", score: 1.0 },
    ]),
  };

  const task = "inspect env and `parseConfig()`";
  const evidence = buildLocalCodeIndexEvidence(queryResults, task);

  // Verify v2 header and snapshot ID.
  assert.match(evidence, /Local code index evidence \(v2\)/, "should have v2 header");
  assert.match(evidence, /snapshot-test/, "should include snapshot ID");
  assert.match(evidence, /inspect env and/, "should include task description");

  // Verify symbol definitions section.
  assert.match(evidence, /Symbol definitions/, "should have symbol definitions section");
  assert.match(evidence, /inspect/, "should contain extracted symbol");
  assert.match(evidence, /env-inspector\.ts/, "should contain definition file path");
  assert.match(evidence, /function/, "should contain symbol kind");

  // Verify file inventory section.
  assert.match(evidence, /File inventory \(3 files\)/, "should have file inventory with count");
  assert.match(evidence, /cli\.ts/, "should contain inventory file");
  assert.match(evidence, /utils\.ts/, "should contain another inventory file");
  assert.match(evidence, /512B/, "should show file size");

  // Verify related files section with scores.
  assert.match(evidence, /Related files/, "should have related files section");
  assert.match(evidence, /config\.ts/, "should contain related file path");
  assert.match(evidence, /score: 2\.50/, "should show related file score");
  assert.match(evidence, /loader\.ts/, "should contain second related file");
  assert.match(evidence, /score: 1\.00/, "should show second score");

  // Verify coverage summary.
  assert.match(evidence, /Coverage:/, "should have coverage summary");
  assert.match(evidence, /ast-grep-structural/, "should show effective coverage level");
});

test("v2 evidence renderer handles empty definitions gracefully", () => {
  // When definitions queries return no occurrences, the definitions section
  // is omitted. The renderer still includes the coverage summary from the
  // query result, so the output is non-empty but has no symbol data.
  const emptyDefinitions: LocalCodeIndexQueryResult = {
    kind: "definitions",
    snapshotId: "snapshot-test",
    coverage: { effective: "file-inventory-only", partial: false, failedFiles: 0, oversizedFiles: 0 },
    truncated: false,
    durationMs: 1,
    occurrences: [],
  } as LocalCodeIndexQueryResult;

  const evidence = buildLocalCodeIndexEvidence({ definitions: emptyDefinitions }, "some task");
  // No symbol definitions section when occurrences are empty.
  assert.doesNotMatch(evidence, /Symbol definitions/);
  // Coverage summary is still present.
  assert.match(evidence, /Coverage: file-inventory-only/);
  // Header and task are present.
  assert.match(evidence, /Local code index evidence \(v2\)/);
  assert.match(evidence, /some task/);
});

test("v2 evidence renderer returns no-relevant fallback when no query results at all", () => {
  // When no query results are provided, the renderer returns the fallback.
  const evidence = buildLocalCodeIndexEvidence({}, "some task");
  assert.match(evidence, /No relevant local code index evidence found/);
});

test("taskSymbolCandidates extracts symbols from task descriptions", () => {
  // Verify the v2 symbol extraction from task text.
  const symbols = taskSymbolCandidates("fix the `buildIndex` function and update parseConfig() calls");
  assert.ok(symbols.includes("buildIndex"), "should extract backtick-quoted identifiers");
  assert.ok(symbols.includes("parseConfig"), "should extract function-call syntax identifiers");
  assert.ok(symbols.length <= 5, "should cap at MAX_SYMBOL_CANDIDATES");
  // Short identifiers (< 3 chars) should be excluded.
  assert.ok(!symbols.includes("ab"), "should exclude short identifiers");
});

test("v2 evidence renderer caps output at maxChars with truncation marker", () => {
  // Build a large evidence pack to verify truncation.
  const manyFiles = Array.from({ length: 200 }, (_, i) => ({
    path: `src/file-${i}.ts`,
    size: 100 + i,
  }));
  const queryResults: Record<string, LocalCodeIndexQueryResult> = {
    inventory: inventoryResult(manyFiles),
  };

  const evidence = buildLocalCodeIndexEvidence(queryResults, "large task", 500);
  assert.ok(evidence.length <= 600, "output should be capped near maxChars (allowing for truncation marker)");
  assert.match(evidence, /truncated/, "should include truncation marker");
});

// ── buildEvidencePack behavior tests ──────────────────────────────────────────

test("buildEvidencePack returns unavailable fallback when no v2 ref is present", async () => {
  const root = await tempRoot("cpb-assurance-no-ref");

  // No ref in sourceContext → localCodeIndexRefFromContext returns null
  // and buildEvidencePack returns the unavailable fallback without querying.
  const pack = await buildEvidencePack(assuranceContext(root));
  assert.match(pack, /Local code index evidence pack unavailable/);
});

test("buildEvidencePack returns fallback when v2 ref points to missing index", async () => {
  const root = await tempRoot("cpb-assurance-missing-index");
  const ref = await localIndexFixture(root);

  // The ref is structurally valid but no index exists on disk.
  // queryLocalCodeIndex will fail with missing_local_code_index → caught → fallback.
  const pack = await buildEvidencePack(assuranceContext(root, { ref }));
  assert.match(pack, /No relevant local code index evidence found|Local code index evidence pack unavailable/);
});

test("buildEvidencePack does not query when the job signal is pre-aborted", async () => {
  const root = await tempRoot("cpb-assurance-pre-abort");
  const controller = new AbortController();
  controller.abort();
  const ref = await localIndexFixture(root);

  // throwIfAssuranceAborted fires before any query work.
  await assert.rejects(
    buildEvidencePack({
      ...assuranceContext(root, { ref }),
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
});

// ── High-assurance planning flow tests ────────────────────────────────────────

test("disabled high-assurance planning skips even when execution is already aborted", async () => {
  const root = await tempRoot("cpb-assurance-disabled-pre-abort");
  const controller = new AbortController();
  controller.abort();
  let eventCalls = 0;
  const result = await runHighAssurancePlanning({
    ...assuranceContext(root),
    signal: controller.signal,
    appendEvent: async () => { eventCalls += 1; },
  }, {
    jobId: "job-disabled-pre-aborted",
    phaseSourceContext: {},
  });

  assert.equal(result.kind, "skipped");
  assert.equal(eventCalls, 0);
  assert.deepEqual(await outputFiles(root), []);
});

test("enabled high-assurance planning returns runtime_interrupted without event or artifact work when pre-aborted", async () => {
  const root = await tempRoot("cpb-assurance-planning-pre-abort");
  const controller = new AbortController();
  controller.abort();
  let eventCalls = 0;
  const failed = [];
  const ctx: AssuranceContext = {
    ...assuranceContext(root),
    signal: controller.signal,
    appendEvent: async () => { eventCalls += 1; },
    failJob: async (_cpbRoot, _project, _jobId, payload) => { failed.push(payload); },
    getPool: () => ({ execute: async () => ({ output: "must not run" }) }),
  };

  const result = await runHighAssurancePlanning(ctx, {
    jobId: "job-pre-aborted",
    phaseSourceContext: { assurance: { mode: "high" } },
  });

  assert.equal(result.kind, "failed");
  assert.equal(result.result.failure.kind, FailureKind.RUNTIME_INTERRUPTED);
  assert.equal(result.result.failure.retryable, false);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].kind, FailureKind.RUNTIME_INTERRUPTED);
  assert.equal(eventCalls, 0);
  assert.deepEqual(await outputFiles(root), []);
});

test("high-assurance planning aborts mid artifact commit without final temp or lock residue", async () => {
  const root = await tempRoot("cpb-assurance-mid-write-abort");
  const dataRoot = path.join(root, "runtime");
  const ref = await localIndexFixture(root);
  const controller = new AbortController();
  const failed = [];
  let hookCalls = 0;
  const result = await withArtifactStoreTestHooks({
    afterTempWrite: async ({ path: committedPath }) => {
      if (path.basename(committedPath).startsWith("plan-evidence-pack-")) {
        hookCalls += 1;
        controller.abort();
      }
    },
  }, () => runHighAssurancePlanning({
      ...assuranceContext(root, { ref }),
      dataRoot,
      signal: controller.signal,
      failJob: async (_cpbRoot, _project, _jobId, payload) => { failed.push(payload); },
      getPool: () => ({ execute: async () => ({ output: "must not run" }) }),
    }, {
      jobId: "job-mid-write-abort",
      phaseSourceContext: { assurance: { mode: "high" } },
    }));

  assert.equal(result.kind, "failed");
  assert.equal(result.result.failure.kind, FailureKind.RUNTIME_INTERRUPTED);
  assert.equal(result.result.failure.retryable, false);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].kind, FailureKind.RUNTIME_INTERRUPTED);
  assert.equal(failed[0].code, FailureKind.RUNTIME_INTERRUPTED);
  assert.equal(hookCalls, 1);
  assert.deepEqual(await outputFiles(dataRoot), []);
});
