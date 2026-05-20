#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildLocator,
  locatorEnvelope,
  reconstructJobState,
  buildPhaseLocator,
  wikiProjectDir,
  inboxDir,
  outputsDir,
  projectMetaPath,
  contextPath,
  decisionsPath,
  eventLogPath,
  resolveProjectSourcePath,
  readProjectContext,
  readProjectDecisions,
  projectExists,
} from "../server/services/phase-locator.js";
import { createJob, startPhase, completePhase, failJob, retryJob } from "../server/services/job-store.js";

const root = await mkdtemp(path.join(tmpdir(), "cpb-phase-locator-"));
const project = "locator-test";

async function setupWikiProject(cpbRoot, proj, { sourcePath } = {}) {
  const wikiDir = wikiProjectDir(cpbRoot, proj);
  await mkdir(path.join(wikiDir, "inbox"), { recursive: true });
  await mkdir(path.join(wikiDir, "outputs"), { recursive: true });
  await writeFile(
    projectMetaPath(cpbRoot, proj),
    JSON.stringify({ name: proj, sourcePath: sourcePath || null }, null, 2),
    "utf8"
  );
  await writeFile(contextPath(cpbRoot, proj), `# ${proj}\nContext for testing.\n`, "utf8");
  await writeFile(decisionsPath(cpbRoot, proj), `# ${proj} Decisions\n- Use test fixtures\n`, "utf8");
}

await setupWikiProject(root, project, { sourcePath: "/tmp/test-project" });

// --- Path helpers ---
assert.equal(
  wikiProjectDir(root, project),
  path.resolve(root, "wiki", "projects", project)
);
assert.equal(
  inboxDir(root, project),
  path.resolve(root, "wiki", "projects", project, "inbox")
);
assert.equal(
  outputsDir(root, project),
  path.resolve(root, "wiki", "projects", project, "outputs")
);
assert.equal(
  eventLogPath(root, project, "job-001"),
  path.resolve(root, "cpb-task", "events", project, "job-001.jsonl")
);

// --- projectExists ---
assert.equal(await projectExists(root, project), true);
assert.equal(await projectExists(root, "nonexistent"), false);

// --- resolveProjectSourcePath ---
const sp = await resolveProjectSourcePath(root, project);
assert.equal(sp, "/tmp/test-project");
const noSp = await resolveProjectSourcePath(root, "nonexistent");
assert.equal(noSp, null);

// --- readProjectContext ---
const ctx = await readProjectContext(root, project);
assert.ok(ctx.includes("Context for testing"));
const noCtx = await readProjectContext(root, "nonexistent");
assert.equal(noCtx, null);

// --- readProjectDecisions ---
const dec = await readProjectDecisions(root, project);
assert.ok(dec.includes("Use test fixtures"));
const noDec = await readProjectDecisions(root, "nonexistent");
assert.equal(noDec, null);

// --- buildLocator without job ---
const locator = await buildLocator(root, project, null, { phase: "plan" });
assert.equal(locator.cpbRoot, path.resolve(root));
assert.equal(locator.project, project);
assert.equal(locator.jobId, null);
assert.equal(locator.phase, "plan");
assert.equal(locator.wikiDir, wikiProjectDir(root, project));
assert.equal(locator.inboxDir, inboxDir(root, project));
assert.equal(locator.outputsDir, outputsDir(root, project));
assert.equal(locator.sourcePath, "/tmp/test-project");

// --- buildLocator with CPB_PROJECT_PATH_OVERRIDE ---
const hadOverride = "CPB_PROJECT_PATH_OVERRIDE" in process.env;
const origOverride = process.env.CPB_PROJECT_PATH_OVERRIDE;
process.env.CPB_PROJECT_PATH_OVERRIDE = "/override/path";
const overrideLocator = await buildLocator(root, project, null);
assert.equal(overrideLocator.sourcePath, "/override/path");
if (hadOverride) {
  process.env.CPB_PROJECT_PATH_OVERRIDE = origOverride;
} else {
  delete process.env.CPB_PROJECT_PATH_OVERRIDE;
}

// --- buildLocator with job ---
const job = await createJob(root, {
  project,
  task: "Test locator with job",
  workflow: "standard",
  ts: "2026-05-20T00:00:00.000Z",
});
await startPhase(root, project, job.jobId, { phase: "plan", leaseId: "lease-1" });
await completePhase(root, project, job.jobId, { phase: "plan", artifact: "plan-001" });

const jobLocator = await buildLocator(root, project, job.jobId, { phase: "execute" });
assert.equal(jobLocator.jobId, job.jobId);
assert.equal(jobLocator.task, "Test locator with job");
assert.equal(jobLocator.workflow, "standard");
assert.ok(jobLocator.artifacts.plan);
assert.equal(jobLocator.eventLogPath, eventLogPath(root, project, job.jobId));

// --- locatorEnvelope ---
const envelope = locatorEnvelope(jobLocator);
assert.equal(envelope.cpbRoot, path.resolve(root));
assert.equal(envelope.project, project);
assert.equal(envelope.jobId, job.jobId);
assert.equal(envelope.phase, "execute");
assert.equal(typeof envelope.artifacts, "object");
assert.equal(envelope.task, "Test locator with job");

// --- reconstructJobState ---
const state = await reconstructJobState(root, project, job.jobId);
assert.ok(state);
assert.equal(state.jobId, job.jobId);
assert.equal(state.task, "Test locator with job");
assert.equal(state.artifacts.plan, "plan-001");
assert.equal(state.wikiDir, wikiProjectDir(root, project));

const noState = await reconstructJobState(root, project, "nonexistent-job");
assert.equal(noState, null);

// --- validation ---
await assert.rejects(
  () => buildLocator(root, "invalid project name!", null),
  /invalid project/
);
await assert.rejects(
  () => buildLocator(root, project, "invalid job!id"),
  /invalid jobId/
);

// --- stateRoot in buildLocator ---
const plainLocator = await buildLocator(root, project, null);
assert.equal(plainLocator.stateRoot, path.resolve(path.join(root, "cpb-task")));

// --- stateRoot + worktree + jobStatus + lineage in locatorEnvelope ---
const jobEnvelope = locatorEnvelope(jobLocator);
assert.equal(jobEnvelope.stateRoot, path.resolve(path.join(root, "cpb-task")));
assert.equal(jobEnvelope.worktree, jobLocator.worktree);
assert.equal(jobEnvelope.jobStatus, jobLocator.jobStatus);
assert.ok(Array.isArray(jobEnvelope.completedPhases));
assert.ok(jobEnvelope.completedPhases.includes("plan"));

// --- lineage propagation ---
const lineageJob = await createJob(root, {
  project,
  task: "Lineage test",
  workflow: "standard",
  ts: "2026-05-20T01:00:00.000Z",
});
await startPhase(root, project, lineageJob.jobId, { phase: "plan", leaseId: "lease-l" });
await completePhase(root, project, lineageJob.jobId, { phase: "plan", artifact: "plan-099.md" });
await failJob(root, project, lineageJob.jobId, { reason: "test fail", code: "RECOVERABLE", phase: "execute" });
const retried = await retryJob(root, project, lineageJob.jobId, { fromPhase: "execute" });

const retryLocator = await buildLocator(root, project, retried.jobId, { phase: "execute" });
assert.ok(retryLocator.lineage);
assert.equal(retryLocator.lineage.parentJobId, lineageJob.jobId);
assert.equal(retryLocator.lineage.parentStatus, "failed");

const retryEnvelope = locatorEnvelope(retryLocator);
assert.ok(retryEnvelope.lineage);
assert.equal(retryEnvelope.lineage.parentJobId, lineageJob.jobId);
assert.equal(retryEnvelope.retryCount, 0); // recovery_created doesn't materialize retryCount

// --- reconstructJobState returns full locator ---
const reconstructed = await reconstructJobState(root, project, job.jobId);
assert.ok(reconstructed);
assert.equal(reconstructed.jobId, job.jobId);
assert.equal(reconstructed.project, project);
assert.equal(reconstructed.wikiDir, wikiProjectDir(root, project));
assert.equal(reconstructed.inboxDir, inboxDir(root, project));
assert.equal(reconstructed.outputsDir, outputsDir(root, project));
assert.equal(reconstructed.eventLogPath, eventLogPath(root, project, job.jobId));
assert.equal(reconstructed.stateRoot, path.resolve(path.join(root, "cpb-task")));
assert.equal(reconstructed.sourcePath, "/tmp/test-project");
assert.ok(reconstructed.artifacts.plan);

const noReconstruct = await reconstructJobState(root, project, "nonexistent-job");
assert.equal(noReconstruct, null);

// --- buildPhaseLocator resolves previous-phase artifacts ---
const phaseLoc = await buildPhaseLocator(root, project, job.jobId, "execute");
assert.equal(phaseLoc.phase, "execute");
assert.equal(phaseLoc.prevPhase, "plan");
assert.equal(phaseLoc.prevArtifact, "plan-001");
assert.equal(phaseLoc.prevArtifactPath, path.join(inboxDir(root, project), "plan-001.md"));
assert.equal(phaseLoc.bridgeScript, "claude-execute.sh");

const planPhaseLoc = await buildPhaseLocator(root, project, job.jobId, "plan");
assert.equal(planPhaseLoc.prevPhase, null);
assert.equal(planPhaseLoc.prevArtifact, null);
assert.equal(planPhaseLoc.prevArtifactPath, null);
assert.equal(planPhaseLoc.bridgeScript, "codex-plan.sh");

// --- buildPhaseLocator without job returns basic locator ---
const noJobPhaseLoc = await buildPhaseLocator(root, project, null, "plan");
assert.equal(noJobPhaseLoc.jobId, null);
assert.equal(noJobPhaseLoc.prevPhase, null);

console.log("phase-locator: all tests passed");
