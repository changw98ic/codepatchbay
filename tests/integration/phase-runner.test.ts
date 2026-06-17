#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  roleForBridge,
  phaseRole,
  validatePhaseInputs,
  checkPhasePermissions,
  extractPlanId,
  extractDeliverableId,
  extractArtifactId,
  dispatchPhase,
} from "../../server/services/phase-runner.js";
import { createJob, getJob } from "../../server/services/job/job-store.js";
import { wikiProjectDir } from "../../server/services/phase-locator.js";
import { readEvents } from "../../server/services/event/event-store.js";
import { registerDagWorkflow } from "../../core/workflow/definition.js";
import { registerProject } from "../../server/services/hub/hub-registry.js";

const root = await mkdtemp(path.join(tmpdir(), "cpb-phase-runner-"));
const hubRoot = path.join(root, "hub");
process.env.CPB_HUB_ROOT = hubRoot;
const project = "runner-test";
const dataRoot = path.join(hubRoot, "projects", project);

// Setup wiki project
await registerProject(hubRoot, {
  id: project,
  name: project,
  sourcePath: root,
  projectRuntimeRoot: dataRoot,
  skipCodeGraphGate: true,
});
const wikiDir = path.join(dataRoot, "wiki");
await mkdir(path.join(wikiDir, "inbox"), { recursive: true });
await mkdir(path.join(wikiDir, "outputs"), { recursive: true });
await writeFile(
  path.join(wikiDir, "project.json"),
  JSON.stringify({ name: project }, null, 2),
  "utf8"
);

// --- roleForBridge ---
assert.equal(roleForBridge("bridges/planner.sh"), "planner");
assert.equal(roleForBridge("bridges/executor.sh"), "executor");
assert.equal(roleForBridge("bridges/verifier.sh"), "verifier");
assert.equal(roleForBridge("bridges/reviewer.sh"), "reviewer");
assert.equal(roleForBridge("bridges/repairer.sh"), "repairer");
assert.equal(roleForBridge("bridges/codex-plan.sh"), null);
assert.equal(roleForBridge("bridges/claude-execute.sh"), null);
assert.equal(roleForBridge("bridges/codex-verify.sh"), null);
assert.equal(roleForBridge("bridges/unknown.sh"), null);

// --- phaseRole ---
assert.equal(phaseRole("plan"), "planner");
assert.equal(phaseRole("execute"), "executor");
assert.equal(phaseRole("verify"), "verifier");
assert.equal(phaseRole("review"), "reviewer");
assert.equal(phaseRole("repair"), "repairer");
assert.equal(phaseRole("unknown"), null);

// --- extractPlanId ---
assert.equal(extractPlanId("Plan: /path/to/plan-001.md\nOther output"), "001");
assert.equal(extractPlanId("Some output\nPlan: /another/plan-042.md\nMore"), "042");
assert.equal(extractPlanId("No plan output here"), null);

// --- extractDeliverableId ---
assert.equal(extractDeliverableId("Deliverable: /path/to/deliverable-001.md\n"), "001");
assert.equal(extractDeliverableId("Deliverable: /path/deliverable-123.md"), "123");
assert.equal(extractDeliverableId("No deliverable here"), null);

// --- extractArtifactId ---
assert.equal(extractArtifactId("Plan: /path/plan-007.md", "Plan"), "007");
assert.equal(extractArtifactId("Deliverable: /path/deliverable-009.md", "Deliverable"), "009");

// --- validatePhaseInputs: valid ---
const job = await createJob(root, {
  project,
  task: "Test phase runner validation",
  ts: "2026-05-20T00:00:00.000Z",
  dataRoot,
});

const validResult = await validatePhaseInputs(root, project, job.jobId, "plan");
assert.equal(validResult.valid, true);
assert.equal(validResult.errors.length, 0);

// --- validatePhaseInputs: invalid project name ---
const invalidProject = await validatePhaseInputs(root, "bad project!", job.jobId, "plan");
assert.equal(invalidProject.valid, false);
assert.ok(invalidProject.errors.some((e) => e.includes("invalid project")));

// --- validatePhaseInputs: missing job ---
const missingJob = await validatePhaseInputs(root, project, "nonexistent", "plan");
assert.equal(missingJob.valid, false);
assert.ok(missingJob.errors.some((e) => e.includes("job not found")));

// --- validatePhaseInputs: missing project ---
const missingProject = await validatePhaseInputs(root, "no-such-project", job.jobId, "plan");
assert.equal(missingProject.valid, false);
assert.ok(missingProject.errors.some((e) => e.includes("project not found")));

// --- validatePhaseInputs: missing phase ---
const noPhase = await validatePhaseInputs(root, project, job.jobId, "");
assert.equal(noPhase.valid, false);

// --- checkPhasePermissions ---
// Plan can write to inbox
const planWrite = await checkPhasePermissions(root, project, job.jobId, "plan", path.join(wikiDir, "inbox", "plan-001.md"), "write");
assert.equal(planWrite.allowed, true);

// Plan cannot write to outputs
const planWriteBad = await checkPhasePermissions(root, project, job.jobId, "plan", path.join(wikiDir, "outputs", "deliverable-001.md"), "write");
assert.equal(planWriteBad.allowed, false);

// Verify can read (observation always allowed)
const verifyRead = await checkPhasePermissions(root, project, job.jobId, "verify", path.join(wikiDir, "outputs", "deliverable-001.md"), "read");
assert.equal(verifyRead.allowed, true);

// Execute can write to outputs
const execWrite = await checkPhasePermissions(root, project, job.jobId, "execute", path.join(wikiDir, "outputs", "deliverable-001.md"), "write");
assert.equal(execWrite.allowed, true);

// Custom workflow phases use workflow roles before falling back to legacy phase names.
const auditWorkflow = "phase-runner-audit";
registerDagWorkflow(auditWorkflow, {
  nodes: [
    { id: "audit", phase: "audit", role: "verifier", dependsOn: [] },
  ],
});
const auditJob = await createJob(root, {
  project,
  task: "Test custom workflow phase permissions",
  workflow: auditWorkflow,
  ts: "2026-05-20T00:30:00.000Z",
  dataRoot,
});
const auditWriteInbox = await checkPhasePermissions(
  root,
  project,
  auditJob.jobId,
  "audit",
  path.join(wikiDir, "inbox", "audit-001.md"),
  "write",
);
assert.equal(auditWriteInbox.allowed, false);

// --- dispatchPhase: delegates to job-runner.js for full lifecycle ---
const realProjectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

// dispatchPhase returns error when job-runner.js is missing
const noRunnerRoot = await mkdtemp(path.join(tmpdir(), "cpb-no-runner-"));
const noRunnerDataRoot = path.join(hubRoot, "projects", "no-runner-test");
const noRunnerWikiDir = wikiProjectDir(noRunnerRoot, "no-runner-test");
await mkdir(path.join(noRunnerWikiDir, "inbox"), { recursive: true });
await mkdir(path.join(noRunnerWikiDir, "outputs"), { recursive: true });
await writeFile(
  path.join(noRunnerWikiDir, "project.json"),
  JSON.stringify({ name: "no-runner-test" }, null, 2),
  "utf8"
);
await registerProject(hubRoot, {
  id: "no-runner-test",
  name: "no-runner-test",
  sourcePath: noRunnerRoot,
  projectRuntimeRoot: noRunnerDataRoot,
  skipCodeGraphGate: true,
});
const noRunnerJob = await createJob(noRunnerRoot, {
  project: "no-runner-test",
  task: "Test missing job-runner",
  ts: "2026-05-20T00:00:00.000Z",
  dataRoot: noRunnerDataRoot,
});
const noRunnerResult = await dispatchPhase(noRunnerRoot, {
  project: "no-runner-test",
  jobId: noRunnerJob.jobId,
  phase: "plan",
  script: "/bin/true",
  executorRoot: noRunnerRoot,
});
assert.equal(noRunnerResult.exitCode, 1);
assert.ok((noRunnerResult.error as Error).message.includes("job-runner not found"));

// dispatchPhase delegates to job-runner.js, Node APIs record lifecycle events
const dispatchRoot = await mkdtemp(path.join(tmpdir(), "cpb-dispatch-"));
const dispatchProject = "dispatch-test";
const dispatchDataRoot = path.join(hubRoot, "projects", dispatchProject);
const dispatchWikiDir = wikiProjectDir(dispatchRoot, dispatchProject);
await mkdir(path.join(dispatchWikiDir, "inbox"), { recursive: true });
await mkdir(path.join(dispatchWikiDir, "outputs"), { recursive: true });
await writeFile(
  path.join(dispatchWikiDir, "project.json"),
  JSON.stringify({ name: dispatchProject }, null, 2),
  "utf8"
);
await registerProject(hubRoot, {
  id: dispatchProject,
  name: dispatchProject,
  sourcePath: dispatchRoot,
  projectRuntimeRoot: dispatchDataRoot,
  skipCodeGraphGate: true,
});

const dummyScript = path.join(dispatchRoot, "dummy-bridge.sh");
await writeFile(dummyScript, "#!/bin/bash\nexit 0\n", "utf8");
await chmod(dummyScript, 0o755);

const dispatchJob = await createJob(dispatchRoot, {
  project: dispatchProject,
  task: "Test dispatchPhase lifecycle through job-runner",
  ts: "2026-05-20T00:00:00.000Z",
  dataRoot: dispatchDataRoot,
});

const dispatchResult = await dispatchPhase(dispatchRoot, {
  project: dispatchProject,
  jobId: dispatchJob.jobId,
  phase: "plan",
  script: dummyScript,
  scriptArgs: [dispatchProject, "test-task"],
  executorRoot: realProjectRoot,
  env: { ...process.env, CPB_PROJECT_RUNTIME_ROOT: dispatchDataRoot },
});

assert.equal(dispatchResult.exitCode, 0, `dispatchPhase should succeed: ${(dispatchResult.error as Error)?.message || ""}`);
assert.ok(dispatchResult.envelope, "dispatchPhase returns envelope");
assert.equal(dispatchResult.envelope.project, dispatchProject);

// Verify Node APIs recorded phase_started and phase_completed events
const dispatchEvents = await readEvents(dispatchRoot, dispatchProject, dispatchJob.jobId, { dataRoot: dispatchDataRoot });
const dispatchTypes = dispatchEvents.map((e) => e.type);
assert.ok(dispatchTypes.includes("phase_started"), "phase_started recorded via Node API");
assert.ok(dispatchTypes.includes("phase_completed"), "phase_completed recorded via Node API");

// Verify lease events: job-runner acquires and releases lease
const startedEvent = dispatchEvents.find((e) => e.type === "phase_started");
assert.ok(startedEvent.leaseId, "phase_started includes leaseId from job-runner");
assert.ok(startedEvent.phase === "plan", "phase_started records correct phase");

// Verify job state reflects phase completion through Node API
const jobAfterDispatch = await getJob(dispatchRoot, dispatchProject, dispatchJob.jobId, { dataRoot: dispatchDataRoot });
assert.equal(jobAfterDispatch.phase, "plan");
assert.equal(jobAfterDispatch.leaseId, null, "lease released after phase completion");

// dispatchPhase returns error exit when bridge script fails
const failScript = path.join(dispatchRoot, "fail-bridge.sh");
await writeFile(failScript, "#!/bin/bash\nexit 1\n", "utf8");
await chmod(failScript, 0o755);

const failJob = await createJob(dispatchRoot, {
  project: dispatchProject,
  task: "Test dispatchPhase failure",
  ts: "2026-05-20T01:00:00.000Z",
  dataRoot: dispatchDataRoot,
});

const failResult = await dispatchPhase(dispatchRoot, {
  project: dispatchProject,
  jobId: failJob.jobId,
  phase: "plan",
  script: failScript,
  scriptArgs: [],
  executorRoot: realProjectRoot,
  env: { ...process.env, CPB_PROJECT_RUNTIME_ROOT: dispatchDataRoot },
});

assert.equal(failResult.exitCode, 1, "dispatchPhase propagates bridge failure");
const failEvents = await readEvents(dispatchRoot, dispatchProject, failJob.jobId, { dataRoot: dispatchDataRoot });
const failTypes = failEvents.map((e) => e.type);
assert.ok(failTypes.includes("phase_started"), "phase_started recorded even for failing bridge");
assert.ok(failTypes.includes("phase_failed"), "phase_failed recorded via Node API for failed bridge");

console.log("phase-runner: all tests passed");
