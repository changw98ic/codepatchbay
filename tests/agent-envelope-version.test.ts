import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentJson } from "../core/agents/response-parser.js";

test("legacy envelope without schemaVersion is accepted", () => {
  const r = parseAgentJson('```json\n{"status":"ok","planMarkdown":"# x"}\n```');
  assert.equal(r.ok, true);
});

test("envelope with supported schemaVersion=1 is accepted", () => {
  const r = parseAgentJson('{"status":"ok","schemaVersion":1,"planMarkdown":"# x"}');
  assert.equal(r.ok, true);
});

test("envelope with unsupported schemaVersion is rejected with structured reason", () => {
  const r = parseAgentJson('{"status":"ok","schemaVersion":99,"planMarkdown":"# x"}');
  assert.equal(r.ok, false);
  assert.match(r.reason, /unsupported envelope schemaVersion/i);
});

test("schemaVersion 0 (explicit legacy) is treated as unsupported sentinel", () => {
  // 显式 0 不在支持集 → 拒绝;legacy 必须以"缺省"表达,而非 0。
  const r = parseAgentJson('{"status":"ok","schemaVersion":0}');
  assert.equal(r.ok, false);
});
