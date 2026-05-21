#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  HOOK_POINTS,
  registerPhaseHook,
  clearPhaseHooks,
  getPhaseHooks,
  basePhase,
  hookPointFor,
  buildHookContext,
  runPhaseHooks,
  registerBuiltinHooks,
  makeHookEvent,
  _resetHookRegistration,
} from "../server/services/phase-hooks.js";

// --- basePhase ---
assert.equal(basePhase("plan"), "plan");
assert.equal(basePhase("execute"), "execute");
assert.equal(basePhase("execute-retry-2"), "execute");
assert.equal(basePhase("verify-retry-3"), "verify");
assert.equal(basePhase("review-fix-1"), "review");
assert.equal(basePhase(null), null);
assert.equal(basePhase(undefined), undefined);

// --- hookPointFor ---
assert.equal(hookPointFor("plan", "pre"), "pre-plan");
assert.equal(hookPointFor("execute", "pre"), "pre-execute");
assert.equal(hookPointFor("execute", "post"), "post-execute");
assert.equal(hookPointFor("verify", "pre"), "pre-verify");
assert.equal(hookPointFor("verify", "post"), "post-verify");
assert.equal(hookPointFor("execute", "on-failure"), "on-failure");
assert.equal(hookPointFor("unknown", "pre"), null);

// --- Registry: empty by default ---
_resetHookRegistration();
assert.deepEqual(getPhaseHooks("pre-plan"), []);
assert.deepEqual(getPhaseHooks("nonexistent"), []);

// --- Registry: register and get ---
const hook1 = () => ({ ok: true, diagnostics: [], events: [], blockPhase: false });
registerPhaseHook("pre-plan", hook1);
assert.equal(getPhaseHooks("pre-plan").length, 1);
assert.equal(getPhaseHooks("pre-plan")[0], hook1);

// --- Registry: clear specific point ---
registerPhaseHook("pre-execute", hook1);
clearPhaseHooks("pre-plan");
assert.deepEqual(getPhaseHooks("pre-plan"), []);
assert.equal(getPhaseHooks("pre-execute").length, 1);

// --- Registry: clear all ---
_resetHookRegistration();
assert.deepEqual(getPhaseHooks("pre-execute"), []);

// --- Registry: validation ---
assert.throws(() => registerPhaseHook("invalid-point", hook1), /unknown hook point/);
assert.throws(() => registerPhaseHook("pre-plan", "not a function"), /hook must be a function/);

// --- buildHookContext with full envelope ---
const envelope = {
  cpbRoot: "/cpb",
  project: "test",
  jobId: "job-001",
  phase: "plan",
  executorRoot: "/executor",
  stateRoot: "/state",
  sourcePath: "/source",
  wikiDir: "/wiki",
  inboxDir: "/inbox",
  outputsDir: "/outputs",
  eventLogPath: "/events/job-001.jsonl",
  task: "test task",
  workflow: "standard",
  artifacts: { plan: "plan-001" },
  completedPhases: ["plan"],
  jobStatus: "running",
  worktree: "/worktree",
  lineage: null,
  retryCount: 0,
  failurePhase: null,
  blockedReason: null,
};

const ctx = buildHookContext({ hookPoint: "pre-plan", envelope, role: "planner", phase: "plan" });
assert.equal(ctx.hookPoint, "pre-plan");
assert.equal(ctx.project, "test");
assert.equal(ctx.jobId, "job-001");
assert.equal(ctx.phase, "plan");
assert.equal(ctx.role, "planner");
assert.equal(ctx.cpbRoot, "/cpb");
assert.equal(ctx.executorRoot, "/executor");
assert.equal(ctx.stateRoot, "/state");
assert.equal(ctx.sourcePath, "/source");
assert.equal(ctx.wikiDir, "/wiki");
assert.equal(ctx.inboxDir, "/inbox");
assert.equal(ctx.outputsDir, "/outputs");
assert.equal(ctx.eventLogPath, "/events/job-001.jsonl");
assert.equal(ctx.task, "test task");
assert.equal(ctx.workflow, "standard");
assert.deepEqual(ctx.artifacts, { plan: "plan-001" });
assert.deepEqual(ctx.completedPhases, ["plan"]);
assert.equal(ctx.jobStatus, "running");
assert.equal(ctx.worktree, "/worktree");
assert.ok(ctx.timestamp);
assert.equal(ctx.result, null);
assert.equal(ctx.error, null);

// --- buildHookContext with empty input ---
const emptyCtx = buildHookContext({ hookPoint: "on-failure" });
assert.equal(emptyCtx.project, null);
assert.equal(emptyCtx.jobId, null);

// --- buildHookContext with locator instead of envelope ---
const locator = {
  cpbRoot: "/cpb",
  project: "loc-test",
  jobId: "job-002",
  phase: "execute",
  executorRoot: "/exec",
  stateRoot: "/state",
  sourcePath: "/src",
  wikiDir: "/wiki",
  inboxDir: "/inbox",
  outputsDir: "/out",
  eventLogPath: "/events/job-002.jsonl",
};
const locCtx = buildHookContext({ hookPoint: "pre-execute", locator });
assert.equal(locCtx.project, "loc-test");
assert.equal(locCtx.jobId, "job-002");

// --- runPhaseHooks: empty registry no-op ---
_resetHookRegistration();
const emptyResult = await runPhaseHooks({ hookPoint: "pre-plan" });
assert.equal(emptyResult.ok, true);
assert.equal(emptyResult.blockPhase, false);
assert.deepEqual(emptyResult.hookEvents, []);
assert.deepEqual(emptyResult.hookResults, []);

// --- runPhaseHooks: single success hook ---
_resetHookRegistration();
registerPhaseHook("pre-plan", () => ({ ok: true, diagnostics: [], events: [], blockPhase: false }));
const singleResult = await runPhaseHooks({ hookPoint: "pre-plan", project: "test" });
assert.equal(singleResult.ok, true);
assert.equal(singleResult.blockPhase, false);
assert.equal(singleResult.hookResults.length, 1);
assert.equal(singleResult.hookEvents.length, 2);
assert.equal(singleResult.hookEvents[0].type, "phase_hook_started");
assert.equal(singleResult.hookEvents[1].type, "phase_hook_completed");

// --- runPhaseHooks: hook ordering ---
_resetHookRegistration();
const order = [];
registerPhaseHook("pre-execute", () => { order.push(1); return { ok: true, diagnostics: [], events: [], blockPhase: false }; });
registerPhaseHook("pre-execute", () => { order.push(2); return { ok: true, diagnostics: [], events: [], blockPhase: false }; });
await runPhaseHooks({ hookPoint: "pre-execute" });
assert.deepEqual(order, [1, 2]);

// --- runPhaseHooks: hook failure classification ---
_resetHookRegistration();
registerPhaseHook("pre-execute", () => ({
  ok: false,
  diagnostics: [{ message: "boom", classification: "infra" }],
  events: [],
  blockPhase: false,
  classification: "infra",
}));
const failResult = await runPhaseHooks({ hookPoint: "pre-execute", project: "test" });
assert.equal(failResult.ok, false);
assert.equal(failResult.classification, "infra");
assert.equal(failResult.hookEvents[1].type, "phase_hook_failed");

// --- runPhaseHooks: blocking result ---
_resetHookRegistration();
registerPhaseHook("pre-verify", () => ({
  ok: false,
  diagnostics: [{ message: "blocked", classification: "blocking" }],
  events: [],
  blockPhase: true,
  classification: "blocking",
}));
const blockedResult = await runPhaseHooks({ hookPoint: "pre-verify" });
assert.equal(blockedResult.ok, false);
assert.equal(blockedResult.blockPhase, true);
assert.equal(blockedResult.classification, "blocking");

// --- runPhaseHooks: hook throws is caught ---
_resetHookRegistration();
registerPhaseHook("post-execute", () => { throw new Error("hook crash"); });
const crashResult = await runPhaseHooks({ hookPoint: "post-execute" });
assert.equal(crashResult.ok, false);
assert.equal(crashResult.hookResults[0].diagnostics[0].message, "hook crash");
assert.equal(crashResult.hookResults[0].diagnostics[0].classification, "infra");

// --- makeHookEvent ---
const evt = makeHookEvent("phase_hook_started", {
  jobId: "j1", project: "p1", phase: "plan", role: "planner",
  hookPoint: "pre-plan", timestamp: "2026-01-01T00:00:00Z",
});
assert.equal(evt.type, "phase_hook_started");
assert.equal(evt.jobId, "j1");
assert.equal(evt.project, "p1");
assert.equal(evt.hookPoint, "pre-plan");
assert.equal(evt.ts, "2026-01-01T00:00:00Z");

// --- Built-in hooks: pre-plan passes with valid fields ---
_resetHookRegistration();
registerBuiltinHooks();
const prePlanCtx = buildHookContext({
  hookPoint: "pre-plan",
  envelope: { project: "test", jobId: "j1", phase: "plan", eventLogPath: "/events/j1.jsonl" },
  role: "planner",
  phase: "plan",
});
const prePlanResult = await runPhaseHooks(prePlanCtx);
assert.equal(prePlanResult.ok, true);
assert.equal(prePlanResult.blockPhase, false);

// --- Built-in hooks: pre-plan blocks on missing field ---
_resetHookRegistration();
registerBuiltinHooks();
const badCtx = buildHookContext({
  hookPoint: "pre-plan",
  envelope: { project: "test", jobId: null, phase: "plan", eventLogPath: "/events/j1.jsonl" },
  role: "planner",
  phase: "plan",
});
const badResult = await runPhaseHooks(badCtx);
assert.equal(badResult.ok, false);
assert.equal(badResult.blockPhase, true);

// --- Built-in hooks: pre-execute requires artifacts.plan ---
_resetHookRegistration();
registerBuiltinHooks();
const noPlanCtx = buildHookContext({
  hookPoint: "pre-execute",
  envelope: { project: "test", jobId: "j1", phase: "execute", eventLogPath: "/e.jsonl", artifacts: {} },
  role: "executor",
  phase: "execute",
});
const noPlanResult = await runPhaseHooks(noPlanCtx);
assert.equal(noPlanResult.ok, false);
assert.equal(noPlanResult.blockPhase, true);
assert.ok(noPlanResult.diagnostics.some((d) => d.message.includes("artifacts.plan")));

// --- Built-in hooks: pre-execute passes with plan artifact ---
_resetHookRegistration();
registerBuiltinHooks();
const withPlanCtx = buildHookContext({
  hookPoint: "pre-execute",
  envelope: { project: "test", jobId: "j1", phase: "execute", eventLogPath: "/e.jsonl", artifacts: { plan: "plan-001" } },
  role: "executor",
  phase: "execute",
});
const withPlanResult = await runPhaseHooks(withPlanCtx);
assert.equal(withPlanResult.ok, true);

// ============================================================
// RELAXED PRE_VERIFY: issue #65 regression tests
// ============================================================

// --- pre-verify passes with execute artifact ---
_resetHookRegistration();
registerBuiltinHooks();
const withExecCtx = buildHookContext({
  hookPoint: "pre-verify",
  envelope: { project: "test", jobId: "j1", phase: "verify", eventLogPath: "/e.jsonl", artifacts: { execute: "deliverable-001.md" } },
  role: "verifier",
  phase: "verify",
});
const withExecResult = await runPhaseHooks(withExecCtx);
assert.equal(withExecResult.ok, true);

// --- pre-verify passes with deliverable artifact ---
_resetHookRegistration();
registerBuiltinHooks();
const withDeliverableCtx = buildHookContext({
  hookPoint: "pre-verify",
  envelope: { project: "test", jobId: "j1", phase: "verify", eventLogPath: "/e.jsonl", artifacts: { deliverable: "deliverable-001.md" } },
  role: "verifier",
  phase: "verify",
});
const withDeliverableResult = await runPhaseHooks(withDeliverableCtx);
assert.equal(withDeliverableResult.ok, true);

// --- ISSUE #65: pre-verify passes with completedPhases containing "execute" but no artifact ---
_resetHookRegistration();
registerBuiltinHooks();
const noArtifactButCompletedCtx = buildHookContext({
  hookPoint: "pre-verify",
  envelope: {
    project: "test",
    jobId: "j1",
    phase: "verify",
    eventLogPath: "/e.jsonl",
    artifacts: {},
    completedPhases: ["plan", "execute"],
  },
  role: "verifier",
  phase: "verify",
});
const noArtifactButCompletedResult = await runPhaseHooks(noArtifactButCompletedCtx);
assert.equal(noArtifactButCompletedResult.ok, true, "pre-verify must pass when completedPhases includes execute even without artifact");
assert.equal(noArtifactButCompletedResult.blockPhase, false);

// --- pre-verify blocks when no artifact AND no execute in completedPhases ---
_resetHookRegistration();
registerBuiltinHooks();
const noExecCtx = buildHookContext({
  hookPoint: "pre-verify",
  envelope: { project: "test", jobId: "j1", phase: "verify", eventLogPath: "/e.jsonl", artifacts: {}, completedPhases: ["plan"] },
  role: "verifier",
  phase: "verify",
});
const noExecResult = await runPhaseHooks(noExecCtx);
assert.equal(noExecResult.ok, false, "pre-verify must block when no execute artifact and execute not in completedPhases");
assert.equal(noExecResult.blockPhase, true);

// --- pre-verify blocks when completedPhases empty and no artifact ---
_resetHookRegistration();
registerBuiltinHooks();
const emptyPhasesCtx = buildHookContext({
  hookPoint: "pre-verify",
  envelope: { project: "test", jobId: "j1", phase: "verify", eventLogPath: "/e.jsonl", artifacts: {}, completedPhases: [] },
  role: "verifier",
  phase: "verify",
});
const emptyPhasesResult = await runPhaseHooks(emptyPhasesCtx);
assert.equal(emptyPhasesResult.ok, false);
assert.equal(emptyPhasesResult.blockPhase, true);

// --- Built-in hooks: post-execute no-op without env ---
_resetHookRegistration();
delete process.env.CPB_HOOK_POST_EXECUTE_VERIFY_CMD;
registerBuiltinHooks();
const postExecCtx = buildHookContext({
  hookPoint: "post-execute",
  envelope: { project: "test", jobId: "j1", phase: "execute", eventLogPath: "/e.jsonl" },
  role: "executor",
  phase: "execute",
});
const postExecResult = await runPhaseHooks(postExecCtx);
assert.equal(postExecResult.ok, true);
assert.equal(postExecResult.diagnostics.length, 0);

// --- Built-in hooks: post-execute records when env var is set ---
_resetHookRegistration();
process.env.CPB_HOOK_POST_EXECUTE_VERIFY_CMD = "npm test";
registerBuiltinHooks();
const postEnvCtx = buildHookContext({
  hookPoint: "post-execute",
  envelope: { project: "test", jobId: "j1", phase: "execute", eventLogPath: "/e.jsonl" },
  role: "executor",
  phase: "execute",
});
const postEnvResult = await runPhaseHooks(postEnvCtx);
assert.equal(postEnvResult.ok, true);
assert.ok(postEnvResult.diagnostics.some((d) => d.message.includes("npm test")));
delete process.env.CPB_HOOK_POST_EXECUTE_VERIFY_CMD;

// --- Built-in hooks: on-failure collects diagnostics ---
_resetHookRegistration();
registerBuiltinHooks();
const failCtx = buildHookContext({
  hookPoint: "on-failure",
  envelope: { project: "test", jobId: "j1", phase: "execute", eventLogPath: "/e.jsonl" },
  role: "executor",
  phase: "execute",
  error: new Error("child exited with 1"),
});
const onFailResult = await runPhaseHooks(failCtx);
assert.equal(onFailResult.ok, true);
assert.ok(onFailResult.diagnostics.some((d) => d.message.includes("phase execute failed")));
assert.ok(onFailResult.diagnostics.some((d) => d.classification === "infra"));

// ============================================================
// DIAGNOSTIC EVENT EMISSION: issue #65 regression tests
// ============================================================

// --- on-failure hook emits phase_hook_diagnostic events ---
_resetHookRegistration();
registerBuiltinHooks();
const diagFailCtx = buildHookContext({
  hookPoint: "on-failure",
  envelope: { project: "diag-test", jobId: "j2", phase: "execute", eventLogPath: "/e.jsonl" },
  role: "executor",
  phase: "execute",
  error: new Error("bridge crashed"),
});
const diagFailResult = await runPhaseHooks(diagFailCtx);
const diagEvents = diagFailResult.hookEvents.filter((e) => e.type === "phase_hook_diagnostic");
assert.ok(diagEvents.length >= 1, "on-failure must emit phase_hook_diagnostic events");
assert.equal(diagEvents[0].hookPoint, "on-failure");
assert.equal(diagEvents[0].project, "diag-test");
assert.equal(diagEvents[0].jobId, "j2");
assert.ok(diagEvents[0].classification, "diagnostic event must have classification");
assert.ok(diagEvents[0].message, "diagnostic event must have non-empty message");

// --- blocking pre-hook emits phase_hook_diagnostic events ---
_resetHookRegistration();
registerPhaseHook("pre-verify", () => ({
  ok: false,
  diagnostics: [{ message: "blocked by policy", classification: "blocking" }],
  events: [],
  blockPhase: true,
  classification: "blocking",
}));
const blockDiagResult = await runPhaseHooks({
  hookPoint: "pre-verify",
  project: "btest",
  jobId: "j3",
  phase: "verify",
  role: "verifier",
});
const blockDiagEvents = blockDiagResult.hookEvents.filter((e) => e.type === "phase_hook_diagnostic");
assert.ok(blockDiagEvents.length >= 1, "blocking pre-hook must emit phase_hook_diagnostic events");
assert.equal(blockDiagEvents[0].classification, "blocking");
assert.ok(blockDiagEvents[0].message.includes("blocked by policy"));

// --- thrown hook emits phase_hook_diagnostic events ---
_resetHookRegistration();
registerPhaseHook("post-execute", () => { throw new Error("hook exploded"); });
const throwDiagResult = await runPhaseHooks({
  hookPoint: "post-execute",
  project: "ttest",
  jobId: "j4",
  phase: "execute",
  role: "executor",
});
const throwDiagEvents = throwDiagResult.hookEvents.filter((e) => e.type === "phase_hook_diagnostic");
assert.ok(throwDiagEvents.length >= 1, "thrown hook must emit phase_hook_diagnostic events");
assert.equal(throwDiagEvents[0].classification, "infra");
assert.ok(throwDiagEvents[0].message.includes("hook exploded"));

// --- successful hooks do NOT emit diagnostic events ---
_resetHookRegistration();
registerPhaseHook("pre-plan", () => ({ ok: true, diagnostics: [], events: [], blockPhase: false }));
const successResult = await runPhaseHooks({
  hookPoint: "pre-plan",
  project: "stest",
  jobId: "j5",
  phase: "plan",
  role: "planner",
});
const successDiagEvents = successResult.hookEvents.filter((e) => e.type === "phase_hook_diagnostic");
assert.equal(successDiagEvents.length, 0, "successful hooks must not emit phase_hook_diagnostic events");

// --- runPhaseHooks event shape includes hook metadata ---
_resetHookRegistration();
registerPhaseHook("pre-plan", () => ({ ok: true, diagnostics: [], events: [], blockPhase: false }));
const metaResult = await runPhaseHooks({
  hookPoint: "pre-plan",
  project: "p",
  jobId: "j",
  phase: "plan",
  role: "planner",
});
const started = metaResult.hookEvents.find((e) => e.type === "phase_hook_started");
assert.equal(started.hookPoint, "pre-plan");
assert.equal(started.project, "p");
assert.equal(started.jobId, "j");
assert.equal(started.phase, "plan");
assert.equal(started.role, "planner");
assert.equal(started.hookCount, 1);

const completed = metaResult.hookEvents.find((e) => e.type === "phase_hook_completed");
assert.equal(completed.classification, "info");

_resetHookRegistration();

console.log("phase-hooks: all tests passed");
