#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import {
  canWrite,
  canRead,
  checkPermission,
  validateRole,
  recordPermissionDenial,
  getObservablePaths,
  isInfraDenial,
  getPhasePolicy,
} from "../server/services/permission-matrix.js";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createJob } from "../server/services/job-store.js";
import { materializeJob, readEvents } from "../server/services/event-store.js";

const cpbRoot = "/test/cpb-root";
const project = "perm-test";
const sourcePath = "/test/source-project";

// --- validateRole ---
assert.doesNotThrow(() => validateRole("codex-plan"));
assert.doesNotThrow(() => validateRole("claude-execute"));
assert.doesNotThrow(() => validateRole("codex-verify"));
assert.doesNotThrow(() => validateRole("claude-repair"));
assert.doesNotThrow(() => validateRole("reviewer-review"));
assert.throws(() => validateRole("unknown"), /unknown role/);

// --- codex-plan write permissions ---
const planWriteAllowed = canWrite("codex-plan", `${cpbRoot}/wiki/projects/${project}/inbox/plan-001.md`, cpbRoot, project);
assert.equal(planWriteAllowed.allowed, true);

const planWriteDenied = canWrite("codex-plan", `${cpbRoot}/wiki/projects/${project}/outputs/deliverable-001.md`, cpbRoot, project);
assert.equal(planWriteDenied.allowed, false);
assert.ok(planWriteDenied.reason.includes("cannot write"));

// codex-plan cannot write to outputs
const planWriteOutputs = canWrite("codex-plan", `${cpbRoot}/wiki/projects/${project}/outputs`, cpbRoot, project);
assert.equal(planWriteOutputs.allowed, false);

// --- claude-execute write permissions ---
const execWriteDeliverable = canWrite("claude-execute", `${cpbRoot}/wiki/projects/${project}/outputs/deliverable-001.md`, cpbRoot, project, sourcePath);
assert.equal(execWriteDeliverable.allowed, true);

const execWriteSource = canWrite("claude-execute", `${sourcePath}/src/main.js`, cpbRoot, project, sourcePath);
assert.equal(execWriteSource.allowed, true);

const execWriteInbox = canWrite("claude-execute", `${cpbRoot}/wiki/projects/${project}/inbox/plan-001.md`, cpbRoot, project, sourcePath);
assert.equal(execWriteInbox.allowed, false);

const execWriteSystem = canWrite("claude-execute", `${cpbRoot}/wiki/system/config.md`, cpbRoot, project, sourcePath);
assert.equal(execWriteSystem.allowed, false);

const execWriteProfiles = canWrite("claude-execute", `${cpbRoot}/profiles/codex/soul.md`, cpbRoot, project, sourcePath);
assert.equal(execWriteProfiles.allowed, false);

const execWriteBridges = canWrite("claude-execute", `${cpbRoot}/bridges/common.sh`, cpbRoot, project, sourcePath);
assert.equal(execWriteBridges.allowed, false);

// Specific deny scopes win over broad sourcePath allow in self-hosted CPB worktrees.
const selfHostedExecWriteOutput = canWrite(
  "claude-execute",
  `${cpbRoot}/wiki/projects/${project}/outputs/deliverable-001.md`,
  cpbRoot,
  project,
  cpbRoot,
);
assert.equal(selfHostedExecWriteOutput.allowed, true);

const selfHostedExecWriteBridge = canWrite(
  "claude-execute",
  `${cpbRoot}/bridges/common.sh`,
  cpbRoot,
  project,
  cpbRoot,
);
assert.equal(selfHostedExecWriteBridge.allowed, false);
assert.ok(selfHostedExecWriteBridge.reason.includes("cannot write"));

// --- codex-verify write permissions ---
const verifyWriteVerdict = canWrite("codex-verify", `${cpbRoot}/wiki/projects/${project}/outputs/verdict-001.md`, cpbRoot, project);
assert.equal(verifyWriteVerdict.allowed, true);

const verifyWriteInbox = canWrite("codex-verify", `${cpbRoot}/wiki/projects/${project}/inbox/plan-001.md`, cpbRoot, project);
assert.equal(verifyWriteInbox.allowed, false);

// codex-verify cannot write to source code
const verifyWriteSource = canWrite("codex-verify", `${sourcePath}/src/main.js`, cpbRoot, project, sourcePath);
assert.equal(verifyWriteSource.allowed, false);

const selfHostedVerifyWriteVerdict = canWrite(
  "codex-verify",
  `${cpbRoot}/wiki/projects/${project}/outputs/verdict-001.md`,
  cpbRoot,
  project,
  cpbRoot,
);
assert.equal(selfHostedVerifyWriteVerdict.allowed, true);

const selfHostedVerifyWriteSource = canWrite(
  "codex-verify",
  `${cpbRoot}/server/services/job-store.js`,
  cpbRoot,
  project,
  cpbRoot,
);
assert.equal(selfHostedVerifyWriteSource.allowed, false);

// --- claude-repair write permissions ---
const repairWrite = canWrite("claude-repair", `${cpbRoot}/server/services/fix.js`, cpbRoot, project);
assert.equal(repairWrite.allowed, true);

// --- reviewer-review write permissions ---
const reviewWrite = canWrite("reviewer-review", `${cpbRoot}/wiki/projects/${project}/outputs/review-001.md`, cpbRoot, project);
assert.equal(reviewWrite.allowed, true);

// --- Read permissions: always allowed (unrestricted observation) ---
const readTargets = [
  `${cpbRoot}/wiki/projects/${project}/inbox/plan-001.md`,
  `${cpbRoot}/wiki/projects/${project}/outputs/deliverable-001.md`,
  `${cpbRoot}/cpb-task/events/${project}/job-001.jsonl`,
  `${cpbRoot}/cpb-task/state/pipeline-${project}.json`,
  `${cpbRoot}/wiki/system/handshake-protocol.md`,
  `${cpbRoot}/profiles/claude/soul.md`,
  `${cpbRoot}/bridges/common.sh`,
  `${cpbRoot}/templates/handoff/execute-to-review.md`,
  `${sourcePath}/src/main.js`,
  `${sourcePath}/tests/foo.test.mjs`,
  "/some/random/path/outside/cpb",
];

for (const role of ["codex-plan", "codex-verify", "claude-execute", "claude-repair", "reviewer-review"]) {
  for (const target of readTargets) {
    const result = canRead(role, target, cpbRoot, project, sourcePath);
    assert.equal(result.allowed, true, `${role} should read ${target}`);
  }
}

// --- checkPermission ---
const writeCheck = checkPermission("codex-plan", "write", `${cpbRoot}/wiki/projects/${project}/inbox/plan-001.md`, cpbRoot, project);
assert.equal(writeCheck.allowed, true);

const readCheck = checkPermission("codex-verify", "read", `${cpbRoot}/wiki/projects/${project}/outputs/verdict-001.md`, cpbRoot, project);
assert.equal(readCheck.allowed, true);

const deniedCheck = checkPermission("codex-plan", "write", `${cpbRoot}/wiki/projects/${project}/outputs/deliverable-001.md`, cpbRoot, project);
assert.equal(deniedCheck.allowed, false);
assert.ok(deniedCheck.reason);

// --- Verifier observation paths cover all required resources ---
const verifyObservable = getObservablePaths("codex-verify", cpbRoot, project, { sourcePath });
assert.ok(verifyObservable.length > 0, "verifier should have observable paths");

// Verifier can read task goal, code, diffs, events, state, tests
const verifyReadChecks = [
  { name: "task goal (inbox plan)", path: `${cpbRoot}/wiki/projects/${project}/inbox/plan-001.md` },
  { name: "deliverable (outputs)", path: `${cpbRoot}/wiki/projects/${project}/outputs/deliverable-001.md` },
  { name: "verdict (outputs)", path: `${cpbRoot}/wiki/projects/${project}/outputs/verdict-001.md` },
  { name: "context (wiki)", path: `${cpbRoot}/wiki/projects/${project}/context.md` },
  { name: "system docs", path: `${cpbRoot}/wiki/system/handshake-protocol.md` },
  { name: "templates", path: `${cpbRoot}/templates/handoff/execute-to-review.md` },
  { name: "source code", path: `${sourcePath}/src/main.js` },
  { name: "test files", path: `${sourcePath}/tests/foo.test.mjs` },
  { name: "git diff (source .git)", path: `${sourcePath}/.git/HEAD` },
  { name: "event log", path: `${cpbRoot}/cpb-task/events/${project}/job-001.jsonl` },
  { name: "pipeline state", path: `${cpbRoot}/cpb-task/state/pipeline-${project}.json` },
  { name: "checkpoints", path: `${cpbRoot}/cpb-task/checkpoints/${project}/job-001.json` },
];

for (const { name, path: checkPath } of verifyReadChecks) {
  const result = canRead("codex-verify", checkPath, cpbRoot, project, sourcePath);
  assert.equal(result.allowed, true, `verifier should read ${name}`);
}

// --- getObservablePaths ---
const planPaths = getObservablePaths("codex-plan", cpbRoot, project, { sourcePath });
assert.ok(planPaths.some((p) => p.includes("wiki") && p.includes(project)), "codex-plan should observe project wiki");
assert.ok(planPaths.some((p) => p === path.resolve(sourcePath)), "codex-plan should observe source");

const repairPaths = getObservablePaths("claude-repair", cpbRoot, project);
assert.equal(repairPaths.length, 1, "claude-repair observes entire cpbRoot");
assert.equal(repairPaths[0], path.resolve(cpbRoot));

// --- getPhasePolicy ---
const verifyPolicy = getPhasePolicy("codex-verify", cpbRoot, project, { sourcePath });
assert.equal(verifyPolicy.role, "codex-verify");
assert.ok(verifyPolicy.writeAllowed.length > 0, "verifier has allowed write scopes");
assert.ok(verifyPolicy.writeDenied.length > 0, "verifier has denied write scopes");
assert.ok(verifyPolicy.observablePaths.length > 0, "verifier has observable paths");
assert.ok(verifyPolicy.writeAllowed.some((p) => p.includes("outputs")), "verifier can write outputs");
assert.ok(verifyPolicy.writeDenied.some((p) => p.includes("inbox")), "verifier denied inbox writes");
assert.ok(verifyPolicy.writeDenied.some((p) => p.includes(sourcePath.replace(/^\/test\//, "")) || p === sourcePath), "verifier denied source writes");

const execPolicy = getPhasePolicy("claude-execute", cpbRoot, project, { sourcePath });
assert.equal(execPolicy.role, "claude-execute");
assert.ok(execPolicy.writeAllowed.some((p) => p.includes("outputs")));
assert.ok(execPolicy.writeAllowed.some((p) => p === path.resolve(sourcePath)));

// getPhasePolicy rejects unknown roles
assert.throws(() => getPhasePolicy("hacker", cpbRoot, project), /unknown role/);

// --- isInfraDenial ---
assert.equal(isInfraDenial({ type: "permission_denied", category: "infra" }), true);
assert.equal(isInfraDenial({ type: "permission_denied" }), false);
assert.equal(isInfraDenial({ type: "job_failed", category: "infra" }), false);
assert.equal(isInfraDenial(null), false);
assert.equal(isInfraDenial(undefined), false);

// --- recordPermissionDenial: structured infra denial ---
const denialRoot = await mkdtemp(path.join(tmpdir(), "cpb-perm-denial-"));
const denialJob = await createJob(denialRoot, {
  project: "denial-test",
  task: "test denial recording",
  ts: "2026-05-20T00:00:00.000Z",
});
await recordPermissionDenial(denialRoot, "denial-test", denialJob.jobId, {
  role: "codex-plan",
  action: "write",
  targetPath: "/some/outputs/file.md",
  reason: "codex-plan cannot write to outputs",
  phase: "plan",
  allowedBoundary: "/allowed/inbox",
  recoveryGuidance: "write plans to the inbox",
});
const denialEvents = await readEvents(denialRoot, "denial-test", denialJob.jobId);
const denialEvent = denialEvents.find((e) => e.type === "permission_denied");
assert.ok(denialEvent, "should have permission_denied event");
assert.equal(denialEvent.role, "codex-plan");
assert.equal(denialEvent.action, "write");
assert.equal(denialEvent.reason, "codex-plan cannot write to outputs");
assert.equal(denialEvent.category, "infra", "denial should be categorized as infra");
assert.equal(denialEvent.phase, "plan");
assert.equal(denialEvent.deniedOperation, "write");
assert.equal(denialEvent.allowedBoundary, "/allowed/inbox");
assert.equal(denialEvent.recoveryGuidance, "write plans to the inbox");

// --- Denial events are distinct from business FAIL ---
const failEvents = denialEvents.filter((e) => e.type === "job_failed");
assert.equal(failEvents.length, 0, "permission denial should NOT produce job_failed event");

// isInfraDenial identifies the denial event
assert.equal(isInfraDenial(denialEvent), true, "recorded denial should be infra");

// --- Denial materialization through materializeJob ---
const matState = materializeJob(denialEvents);
assert.ok(matState.permissionDenials, "materialized state should have permissionDenials");
assert.equal(matState.permissionDenials.length, 1);
assert.equal(matState.permissionDenials[0].category, "infra");
assert.equal(matState.permissionDenials[0].role, "codex-plan");
assert.equal(matState.permissionDenials[0].action, "write");
assert.equal(matState.permissionDenials[0].reason, "codex-plan cannot write to outputs");
assert.equal(matState.permissionDenials[0].phase, "plan");
assert.equal(matState.permissionDenials[0].deniedOperation, "write");
assert.equal(matState.permissionDenials[0].allowedBoundary, "/allowed/inbox");
assert.equal(matState.permissionDenials[0].recoveryGuidance, "write plans to the inbox");
assert.equal(matState.infraStatus, "blocked", "infraStatus should be blocked on denial");

// --- Denial materialization: infra vs business failure ---
const bizFailRoot = await mkdtemp(path.join(tmpdir(), "cpb-biz-fail-"));
const bizFailJob = await createJob(bizFailRoot, {
  project: "biz-fail-test",
  task: "test business failure distinction",
  ts: "2026-05-20T00:00:00.000Z",
});

// Append a business failure event directly
const { appendEvent } = await import("../server/services/runtime-events.js");
await appendEvent(bizFailRoot, "biz-fail-test", bizFailJob.jobId, {
  type: "phase_failed",
  jobId: bizFailJob.jobId,
  project: "biz-fail-test",
  phase: "verify",
  error: "VERDICT: FAIL — missing tests",
  code: "QUALITY_FAIL",
  ts: "2026-05-20T00:01:00.000Z",
});

const bizEvents = await readEvents(bizFailRoot, "biz-fail-test", bizFailJob.jobId);
const bizState = materializeJob(bizEvents);

// Business failure: status is "failed" but infraStatus is NOT "blocked"
assert.equal(bizState.status, "failed", "business failure should set status to failed");
assert.equal(bizState.infraStatus, null, "business failure should NOT set infraStatus");
assert.equal(bizState.permissionDenials.length, 0, "business failure should have no permission denials");
assert.equal(bizState.failureCode, "QUALITY_FAIL", "business failure should have failure code");

// --- Multiple denials accumulate ---
const multiDenialRoot = await mkdtemp(path.join(tmpdir(), "cpb-multi-denial-"));
const multiDenialJob = await createJob(multiDenialRoot, {
  project: "multi-denial",
  task: "test multiple denials",
  ts: "2026-05-20T00:00:00.000Z",
});
await recordPermissionDenial(multiDenialRoot, "multi-denial", multiDenialJob.jobId, {
  role: "codex-plan",
  action: "write",
  targetPath: "/a",
  reason: "denial 1",
});
await recordPermissionDenial(multiDenialRoot, "multi-denial", multiDenialJob.jobId, {
  role: "codex-plan",
  action: "write",
  targetPath: "/b",
  reason: "denial 2",
});
const multiState = materializeJob(await readEvents(multiDenialRoot, "multi-denial", multiDenialJob.jobId));
assert.equal(multiState.permissionDenials.length, 2, "should accumulate multiple denials");
assert.equal(multiState.permissionDenials[0].targetPath, "/a");
assert.equal(multiState.permissionDenials[1].targetPath, "/b");
assert.equal(multiState.infraStatus, "blocked");

console.log("permission-matrix: all tests passed");
