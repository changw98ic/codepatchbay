#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  validateVerdictEnvelope,
  classifyVerdict,
  parseVerdictEnvelope,
  formatVerdictEnvelope,
} from "../server/services/verdict-envelope.js";

const REQUIRED_BASIS_KEYS = [
  "taskGoal", "worktreeDiff", "tests", "buildLogs",
  "events", "runtimeState", "executorSummary",
];

const FULL_BASIS = {
  taskGoal: "t", worktreeDiff: "n", tests: "n",
  buildLogs: "n", events: "n", runtimeState: "n", executorSummary: "n",
};

function fullBasis(envelope) {
  return REQUIRED_BASIS_KEYS.every((k) => k in envelope.basis);
}

// --- validateVerdictEnvelope ---

assert.deepEqual(validateVerdictEnvelope(null), { valid: false, error: "envelope must be an object" });
console.log("validate: null -> invalid: OK");

assert.deepEqual(
  validateVerdictEnvelope({}),
  { valid: false, error: "status must be one of: pass, fail, inconclusive, infra_error, got: undefined" },
);
console.log("validate: missing status -> invalid: OK");

assert.deepEqual(
  validateVerdictEnvelope({ status: "pass" }),
  { valid: false, error: "basis must be an object" },
);
console.log("validate: missing basis -> invalid: OK");

assert.deepEqual(
  validateVerdictEnvelope({ status: "pass", basis: { taskGoal: "t", worktreeDiff: "n", tests: "n", buildLogs: "n", events: "n", runtimeState: "n", executorSummary: "n" } }),
  { valid: false, error: "blockingMissingInputs must be an array" },
);
console.log("validate: missing blockingMissingInputs -> invalid: OK");

assert.deepEqual(
  validateVerdictEnvelope({ status: "pass", basis: { taskGoal: "t", worktreeDiff: "n", tests: "n", buildLogs: "n", events: "n", runtimeState: "n", executorSummary: "n" }, blockingMissingInputs: [] }),
  { valid: false, error: "reason must be a string" },
);
console.log("validate: missing reason -> invalid: OK");

const minimalValid = {
  status: "pass",
  basis: { taskGoal: "t", worktreeDiff: "n", tests: "n", buildLogs: "n", events: "n", runtimeState: "n", executorSummary: "n" },
  blockingMissingInputs: [],
  reason: "ok",
};
assert.deepEqual(validateVerdictEnvelope(minimalValid), { valid: true });
console.log("validate: minimal valid (all required) -> OK");

assert.deepEqual(
  validateVerdictEnvelope({ status: "fail", basis: "not-object" }),
  { valid: false, error: "basis must be an object" },
);
console.log("validate: basis not object -> invalid: OK");

assert.deepEqual(
  validateVerdictEnvelope({ status: "fail", basis: FULL_BASIS, blockingMissingInputs: [], reason: "ok" }),
  { valid: true },
);
console.log("validate: full basis -> valid: OK");

assert.deepEqual(
  validateVerdictEnvelope({ status: "fail", basis: { taskGoal: "x" } }),
  { valid: false, error: "basis missing required keys: worktreeDiff, tests, buildLogs, events, runtimeState, executorSummary" },
);
console.log("validate: partial basis -> invalid: OK");

assert.deepEqual(
  validateVerdictEnvelope({ status: "fail", basis: FULL_BASIS, blockingMissingInputs: "not-array" }),
  { valid: false, error: "blockingMissingInputs must be an array" },
);
console.log("validate: blockingMissingInputs not array -> invalid: OK");

assert.deepEqual(
  validateVerdictEnvelope({ status: "fail", basis: FULL_BASIS, blockingMissingInputs: [], reason: 42 }),
  { valid: false, error: "reason must be a string" },
);
console.log("validate: reason not string -> invalid: OK");

assert.deepEqual(
  validateVerdictEnvelope({ status: "fail", basis: FULL_BASIS, blockingMissingInputs: [], reason: "ok", summary: 42 }),
  { valid: false, error: "summary must be a string" },
);
console.log("validate: summary not string -> invalid: OK");

assert.deepEqual(
  validateVerdictEnvelope({
    status: "infra_error",
    basis: { taskGoal: "t", worktreeDiff: "n", tests: "n", buildLogs: "n", events: "n", runtimeState: "n", executorSummary: "n" },
    blockingMissingInputs: [],
    reason: "files missing",
  }),
  { valid: true },
);
console.log("validate: full valid envelope -> OK");

// --- classifyVerdict ---

assert.equal(classifyVerdict("pass"), "pass");
assert.equal(classifyVerdict("PASS"), "pass");
assert.equal(classifyVerdict("fail"), "fail");
assert.equal(classifyVerdict("FAIL"), "fail");
assert.equal(classifyVerdict("partial"), "fail");
assert.equal(classifyVerdict("inconclusive"), "inconclusive");
assert.equal(classifyVerdict("unknown"), "inconclusive");
assert.equal(classifyVerdict("infra_error"), "infra_error");
assert.equal(classifyVerdict("garbage"), "inconclusive");
console.log("classifyVerdict: OK");

// --- parseVerdictEnvelope - structured JSON with `status` in fenced block ---

const structured = parseVerdictEnvelope(`Some intro text

\`\`\`json
{
  "status": "pass",
  "basis": {
    "taskGoal": "add dark mode",
    "worktreeDiff": "added 3 files",
    "tests": "all pass",
    "buildLogs": "clean",
    "events": "none",
    "runtimeState": "stable",
    "executorSummary": "implemented toggle"
  },
  "blockingMissingInputs": [],
  "reason": "All criteria met",
  "summary": "Dark mode fully implemented"
}
\`\`\`

Narrative text.`);
assert.equal(structured.status, "pass");
assert.equal(structured.reason, "All criteria met");
assert.equal(structured.summary, "Dark mode fully implemented");
assert.deepEqual(structured.blockingMissingInputs, []);
assert.ok(fullBasis(structured));
assert.equal(structured.source, "envelope");
console.log("parseVerdictEnvelope (structured status envelope): OK");

// --- parseVerdictEnvelope - infra_error structured ---

const infra = parseVerdictEnvelope(`\`\`\`json
{"status": "infra_error", "basis": {"taskGoal": "x", "worktreeDiff": "n", "tests": "n", "buildLogs": "n", "events": "n", "runtimeState": "n", "executorSummary": "n"}, "blockingMissingInputs": ["plan file"], "reason": "plan not found"}
\`\`\``);
assert.equal(infra.status, "infra_error");
assert.deepEqual(infra.blockingMissingInputs, ["plan file"]);
assert.equal(infra.source, "envelope");
console.log("parseVerdictEnvelope (infra_error): OK");

// --- parseVerdictEnvelope - standalone JSON near top ---

const standalone = parseVerdictEnvelope(`{"status": "fail", "basis": {"taskGoal": "t", "worktreeDiff": "d", "tests": "f", "buildLogs": "c", "events": "e", "runtimeState": "r", "executorSummary": "s"}, "blockingMissingInputs": [], "reason": "tests failed"}`);
assert.equal(standalone.status, "fail");
assert.equal(standalone.source, "envelope");
console.log("parseVerdictEnvelope (standalone JSON): OK");

// --- parseVerdictEnvelope - legacy VERDICT: line ---

const legacy = parseVerdictEnvelope(`VERDICT: FAIL
Some findings here
- thing 1 failed
- thing 2 broken`);
assert.equal(legacy.status, "fail");
assert.equal(legacy.source, "legacy");
assert.ok(fullBasis(legacy));
assert.ok(Array.isArray(legacy.blockingMissingInputs));
assert.equal(legacy.reason, "Legacy verdict: FAIL");
console.log("parseVerdictEnvelope (legacy VERDICT: FAIL): OK");

// --- parseVerdictEnvelope - legacy PARTIAL -> fail ---

const partial = parseVerdictEnvelope(`VERDICT: PARTIAL\nSome text`);
assert.equal(partial.status, "fail");
assert.equal(partial.source, "legacy");
console.log("parseVerdictEnvelope (PARTIAL->fail): OK");

// --- parseVerdictEnvelope - bare PASS ---

const bare = parseVerdictEnvelope(`PASS\nSome text`);
assert.equal(bare.status, "pass");
assert.equal(bare.source, "legacy");
console.log("parseVerdictEnvelope (bare PASS): OK");

// --- parseVerdictEnvelope - empty content ---

const empty = parseVerdictEnvelope("");
assert.equal(empty.status, "inconclusive");
assert.equal(empty.source, "empty");
assert.ok(fullBasis(empty));
assert.ok(Array.isArray(empty.blockingMissingInputs));
assert.ok(typeof empty.reason === "string" && empty.reason.length > 0);
console.log("parseVerdictEnvelope (empty): OK");

// --- parseVerdictEnvelope - garbage content ---

const garbage = parseVerdictEnvelope("Just some random text\nwith no verdict markers\nat all");
assert.equal(garbage.status, "inconclusive");
assert.equal(garbage.source, "unknown");
assert.ok(fullBasis(garbage));
assert.ok(Array.isArray(garbage.blockingMissingInputs));
assert.ok(typeof garbage.reason === "string" && garbage.reason.length > 0);
console.log("parseVerdictEnvelope (garbage): OK");

// --- formatVerdictEnvelope ---

const formatted = formatVerdictEnvelope({
  status: "pass",
  basis: { taskGoal: "t", worktreeDiff: "n", tests: "p", buildLogs: "c", events: "n", runtimeState: "s", executorSummary: "done" },
  blockingMissingInputs: [],
  reason: "all good",
});
const parsedFmt = JSON.parse(formatted);
assert.equal(parsedFmt.status, "pass");
assert.equal(parsedFmt.reason, "all good");
console.log("formatVerdictEnvelope: OK");

// --- formatVerdictEnvelope - invalid throws ---

assert.throws(() => formatVerdictEnvelope({ status: "bad" }), /invalid verdict envelope/);
console.log("formatVerdictEnvelope (invalid): OK");

console.log("All verdict-envelope tests passed.");
