/**
 * Tests for LLM checklist decomposition: validateDecomposedItems, buildDecomposePrompt,
 * the parse→validate chain (simulating planner output), and buildAcceptanceChecklist's
 * decomposedItems path (allowedFiles non-empty).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { validateDecomposedItems, buildAcceptanceChecklist } from "../core/workflow/acceptance-checklist.js";
import { buildDecomposePrompt } from "../core/workflow/checklist-decomposer.js";
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
  assert.match(p, /```json/);
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

test("buildAcceptanceChecklist: without decomposedItems keeps deterministic []-scope (kill-switch path)", async () => {
  const cl = await buildAcceptanceChecklist({
    jobId: "job-1", project: "p", task: "t", documents: [], riskMap: { riskLevel: "medium" },
    requirementClassification: baseClassification,
  });
  assert.equal(cl.items.length, 1);
  assert.deepEqual(cl.items[0].allowedFiles, []);
  assert.equal(cl.items[0].verificationMethod, "static");
});
