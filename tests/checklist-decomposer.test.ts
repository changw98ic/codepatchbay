/**
 * Tests for LLM checklist decomposition: validateDecomposedItems, buildDecomposePrompt,
 * the parse→validate chain (simulating planner output), and buildAcceptanceChecklist's
 * decomposedItems path (allowedFiles non-empty).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { validateDecomposedItems, buildAcceptanceChecklist } from "../core/workflow/acceptance-checklist.js";
import { buildDecomposePrompt, resolveCodegraphTaskScope } from "../core/workflow/checklist-decomposer.js";
import { parseAgentJson } from "../core/agents/response-parser.js";

function validItem(overrides = {}) {
  return {
    requirement: "support --json flag",
    predicateId: "status-json",
    verificationMethod: "static",
    allowedFiles: ["cli/commands/status.ts"],
    sourceRefs: [{ kind: "task_text", locator: "task:0" }],
    ...overrides,
  };
}

// ── validateDecomposedItems ──

test("validateDecomposedItems: accepts well-formed items", () => {
  const r = validateDecomposedItems([validItem(), validItem({ predicateId: "other", allowedFiles: ["src/x.ts"] })]);
  assert.equal(r.ok, true);
});

test("validateDecomposedItems: rejects empty / non-array", () => {
  assert.equal(validateDecomposedItems([]).ok, false);
  assert.equal(validateDecomposedItems(null as any).ok, false);
});

test("validateDecomposedItems: rejects missing requirement", () => {
  const r = validateDecomposedItems([validItem({ requirement: "" })]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /requirement/);
});

test("validateDecomposedItems: rejects duplicate predicateId", () => {
  const r = validateDecomposedItems([validItem(), validItem()]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /duplicate/);
});

test("validateDecomposedItems: rejects unsupported verificationMethod", () => {
  const r = validateDecomposedItems([validItem({ verificationMethod: "vibe_check" })]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /verificationMethod/);
});

test("validateDecomposedItems: rejects empty allowedFiles (decomposition must declare scope)", () => {
  const r = validateDecomposedItems([validItem({ allowedFiles: [] })]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /allowedFiles/);
});

test("validateDecomposedItems: rejects invalid repo-relative path", () => {
  const r = validateDecomposedItems([validItem({ allowedFiles: ["/abs/path.ts"] })]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /invalid repo-relative/);
});

// ── buildDecomposePrompt ──

test("buildDecomposePrompt: embeds task + JSON contract for decomposedItems/allowedFiles", () => {
  const p = buildDecomposePrompt("add dark mode", []);
  assert.match(p, /add dark mode/);
  assert.match(p, /decomposedItems/);
  assert.match(p, /allowedFiles/);
  assert.match(p, /real actors\/entrypoints/);
  assert.match(p, /Static diff-scope evidence.*MUST set it false/);
  assert.match(p, /evidenceClass/);
  assert.match(p, /requiresRealPathEvidence/);
  assert.match(p, /```json/);
});

test("buildDecomposePrompt: preserves every explicit bullet as a separate acceptance obligation", () => {
  const p = buildDecomposePrompt("Migrate behavior:\n- Warn in version 1.\n- Remove the legacy path in version 2.", []);
  assert.match(p, /task:bullet:1: Warn in version 1/);
  assert.match(p, /task:bullet:2: Remove the legacy path in version 2/);
  assert.match(p, /must be cited by at least one corresponding item/);
  assert.match(p, /do not collapse or silently defer/);
});

test("buildDecomposePrompt: named tests are verification targets, not static rewrite requirements", () => {
  const p = buildDecomposePrompt([
    "Resolve SWE-bench issue.",
    "",
    "Canonical local verification commands:",
    "- FAIL_TO_PASS: PYTHONPATH=. python3 tests/runtests.py expressions.tests.FTimeDeltaTests",
    "",
    "SWE-bench FAIL_TO_PASS tests:",
    "[\"test_date_subtraction (expressions.tests.FTimeDeltaTests)\"]",
  ].join("\n"));

  assert.match(
    p,
    /Named acceptance, regression, or compatibility tests are verification targets, not requirements to rewrite those tests/,
  );
  assert.match(
    p,
    /Only require test-file edits when the task itself asks for new or changed test coverage/,
  );
});

test("CodeGraph fast path builds one scoped item only for one exact production symbol", async () => {
  const items = await resolveCodegraphTaskScope({
    task: "Fix partition() without mutating its input.",
    cwd: "/repo",
    query: async (symbol) => symbol === "partition" ? [
      { node: { kind: "function", name: "partition", filePath: "src/partition.js" } },
      { node: { kind: "file", name: "partition.test.js", filePath: "test/partition.test.js" } },
    ] : [],
  });

  assert.equal(items?.length, 1);
  assert.deepEqual(items?.[0].allowedFiles, ["src/partition.js"]);
  assert.equal(items?.[0].predicateId, "task-scope-partition");
  assert.equal(items?.[0].evidenceOrigin, "deterministic_probe");
});

test("CodeGraph fast path falls back when a symbol is ambiguous across production files", async () => {
  const items = await resolveCodegraphTaskScope({
    task: "Fix render() behavior.",
    cwd: "/repo",
    query: async () => [
      { node: { kind: "method", name: "render", filePath: "src/a.ts" } },
      { node: { kind: "method", name: "render", filePath: "src/b.ts" } },
    ],
  });

  assert.equal(items, null);
});

// ── parse → validate chain (simulating planner output) ──

test("chain: well-formed planner output parses + validates into items", () => {
  const output = '```json\n{"status":"ok","decomposedItems":[{"requirement":"r","predicateId":"p1","verificationMethod":"static","allowedFiles":["a.ts"],"sourceRefs":[{"kind":"task_text","locator":"task:0"}]}]}\n```';
  const parsed = parseAgentJson(output);
  assert.equal(parsed.ok, true);
  const v = validateDecomposedItems(parsed.data.decomposedItems);
  assert.equal(v.ok, true);
});

test("chain: planner output missing decomposedItems fails validation", () => {
  const output = '```json\n{"status":"ok"}\n```';
  const parsed = parseAgentJson(output);
  assert.equal(parsed.ok, true);
  const v = validateDecomposedItems(parsed.data.decomposedItems);
  assert.equal(v.ok, false);
});

test("chain: non-ok agent status fails parse", () => {
  const output = '```json\n{"status":"error","reason":"nope"}\n```';
  assert.equal(parseAgentJson(output).ok, false);
});

// ── buildAcceptanceChecklist decomposedItems path ──

const baseClassification = { artifact: null, classifiedRequirements: [{ id: "REQ-1", kind: "task_text", locator: "task:0", summary: "x" }] };

test("buildAcceptanceChecklist: decomposedItems produce items with non-empty allowedFiles", async () => {
  const cl = await buildAcceptanceChecklist({
    jobId: "job-1", project: "p", task: "t", documents: [], riskMap: { riskLevel: "medium" },
    requirementClassification: baseClassification,
    decomposedItems: [validItem({ allowedFiles: ["src/a.ts", "src/b.ts"] })],
  });
  assert.equal(cl.items.length, 1);
  assert.deepEqual(cl.items[0].allowedFiles, ["src/a.ts", "src/b.ts"]);
  assert.equal(cl.items[0].predicateId, "status-json");
});

test("buildAcceptanceChecklist: decomposedItems preserve evidence metadata", async () => {
  const cl = await buildAcceptanceChecklist({
    jobId: "job-1", project: "p", task: "t", documents: [], riskMap: { riskLevel: "medium" },
    requirementClassification: baseClassification,
    decomposedItems: [validItem({
      evidenceClass: "real_path_probe",
      requiredEvidenceClass: "real_path_probe",
      evidenceOrigin: "independent_probe",
      requiredEvidenceOrigin: "independent_probe",
      requiresRealPathEvidence: true,
    })],
  });

  const item = cl.items[0] as Record<string, unknown>;
  assert.equal(item.evidenceClass, "real_path_probe");
  assert.equal(item.requiredEvidenceClass, "real_path_probe");
  assert.equal(item.evidenceOrigin, "independent_probe");
  assert.equal(item.requiredEvidenceOrigin, "independent_probe");
  assert.equal(item.requiresRealPathEvidence, true);
});

test("buildAcceptanceChecklist: without decomposedItems keeps deterministic []-scope (kill-switch path)", async () => {
  const cl = await buildAcceptanceChecklist({
    jobId: "job-1", project: "p", task: "t", documents: [], riskMap: { riskLevel: "medium" },
    requirementClassification: baseClassification,
  });
  assert.equal(cl.items.length, 1);
  assert.deepEqual(cl.items[0].allowedFiles, []);
  assert.equal(cl.items[0].verificationMethod, "static");
});
