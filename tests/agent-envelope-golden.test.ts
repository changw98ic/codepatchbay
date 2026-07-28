import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlannerJson, parseExecutorJson } from "../core/agents/response-parser.js";

// 代表性 envelope:文档化每个角色的最小合法输出形态,而非抓取真实 provider 输出。
// 注:结果以 `as any` 解构,沿用 tests/checklist-response-parser.test.ts 的既定模式——
// parser 的返回类型是联合(`{ok:false,reason}` | `{ok:true,...}`),`assert.equal` 无法窄化。
const fenced = (obj: unknown) => "```json\n" + JSON.stringify(obj) + "\n```";

test("planner envelope (codex-style, legacy) → planMarkdown", () => {
  const r = parsePlannerJson(fenced({ status: "ok", planMarkdown: "# Plan\n\n## Steps\n- do x" })) as any;
  assert.equal(r.ok, true);
  assert.equal(r.planMarkdown, "# Plan\n\n## Steps\n- do x");
});

test("planner envelope with schemaVersion=1 still round-trips", () => {
  const r = parsePlannerJson(fenced({ status: "ok", schemaVersion: 1, planMarkdown: "# v1 plan" })) as any;
  assert.equal(r.ok, true);
  assert.equal(r.planMarkdown, "# v1 plan");
});

test("planner envelope missing planMarkdown → structured failure", () => {
  const r = parsePlannerJson(fenced({ status: "ok" })) as any;
  assert.equal(r.ok, false);
  assert.match(r.reason, /planMarkdown/i);
});

test("executor envelope (claude-style, legacy) parses", () => {
  const r = parseExecutorJson(fenced({ status: "ok", summary: "done", deliverablePath: "outputs/d-1.md" })) as any;
  assert.equal(r.ok, true);
});

test("agent non-success status surfaces reason", () => {
  const r = parsePlannerJson(fenced({ status: "error", reason: "context window exceeded" })) as any;
  assert.equal(r.ok, false);
  assert.match(r.reason, /context window exceeded/);
});
