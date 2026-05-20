#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Unattended optimization drill: validates that CPB can process optimization tasks
// for both "flow" and "novel-writer" projects using the new control-plane modules.

import { registerProject, getProject, resolveHubRoot } from "../server/services/hub-registry.js";
import { createJob, failJob, completeJob, getJob, blockJob, startPhase, completePhase, FAILURE_CODES } from "../server/services/job-store.js";
import { readEvents } from "../server/services/event-store.js";
import { buildLocator, locatorEnvelope, reconstructJobState, wikiProjectDir, projectExists } from "../server/services/phase-locator.js";
import { recoverAsNewJob, retryAsNewJob, isTerminal, verifyTerminalImmutability } from "../server/services/job-recovery.js";
import { checkPermission, canWrite, canRead, recordPermissionDenial } from "../server/services/permission-matrix.js";
import { collectVerifierEvidence, collectEventLog, collectDeliverable, collectProjectContext } from "../server/services/verifier-evidence.js";
import { validatePhaseInputs, phaseRole, checkPhasePermissions } from "../server/services/phase-runner.js";
import { getWorkflow } from "../server/services/workflow-definition.js";

const TEST_PROJECTS = ["flow", "novel-writer"];

async function setupProject(cpbRoot, proj, { sourcePath } = {}) {
  const wikiDir = wikiProjectDir(cpbRoot, proj);
  await mkdir(path.join(wikiDir, "inbox"), { recursive: true });
  await mkdir(path.join(wikiDir, "outputs"), { recursive: true });
  await writeFile(
    path.join(wikiDir, "project.json"),
    JSON.stringify({ name: proj, sourcePath: sourcePath || `/fake/source/${proj}` }, null, 2),
    "utf8"
  );
  await writeFile(
    path.join(wikiDir, "context.md"),
    `# ${proj}\nProject context for unattended drill.\n`,
    "utf8"
  );
  await writeFile(
    path.join(wikiDir, "decisions.md"),
    `# ${proj} Decisions\n- Use optimization pipeline\n`,
    "utf8"
  );
}

for (const projectName of TEST_PROJECTS) {
  test(`unattended drill: ${projectName} can be registered/discovered through canonical project state`, async () => {
    const cpbRoot = await mkdtemp(path.join(tmpdir(), `cpb-drill-${projectName}-`));
    await setupProject(cpbRoot, projectName);

    // Verify project exists through canonical state
    assert.equal(await projectExists(cpbRoot, projectName), true);

    // Build locator and verify canonical paths
    const locator = await buildLocator(cpbRoot, projectName, null, { phase: "plan" });
    assert.equal(locator.project, projectName);
    assert.equal(locator.wikiDir, wikiProjectDir(cpbRoot, projectName));
    assert.ok(locator.inboxDir.includes("inbox"));
    assert.ok(locator.outputsDir.includes("outputs"));

    // Read project context
    const ctx = await readFile(path.join(locator.wikiDir, "context.md"), "utf8");
    assert.ok(ctx.includes(projectName));
  });

  test(`unattended drill: ${projectName} queue entry can be created from optimization task`, async () => {
    const cpbRoot = await mkdtemp(path.join(tmpdir(), `cpb-drill-queue-${projectName}-`));
    await setupProject(cpbRoot, projectName);

    const task = `Optimize ${projectName}: improve performance of core module`;
    const job = await createJob(cpbRoot, {
      project: projectName,
      task,
      workflow: "standard",
      ts: "2026-05-20T00:00:00.000Z",
    });

    assert.ok(job.jobId);
    assert.equal(job.project, projectName);
    assert.equal(job.task, task);
    assert.equal(job.status, "running");
    assert.equal(job.workflow, "standard");
  });

  test(`unattended drill: ${projectName} worker can claim and process entries via locator-only contracts`, async () => {
    const cpbRoot = await mkdtemp(path.join(tmpdir(), `cpb-drill-worker-${projectName}-`));
    await setupProject(cpbRoot, projectName);

    const task = `Optimize ${projectName}: reduce bundle size`;
    const job = await createJob(cpbRoot, {
      project: projectName,
      task,
      workflow: "standard",
      ts: "2026-05-20T00:00:00.000Z",
    });

    // Phase 1: Plan — locator-only reconstruction
    const planLocator = await buildLocator(cpbRoot, projectName, job.jobId, { phase: "plan" });
    assert.equal(planLocator.task, task);
    assert.equal(planLocator.phase, "plan");
    assert.ok(planLocator.eventLogPath);

    await startPhase(cpbRoot, projectName, job.jobId, { phase: "plan", leaseId: `lease-${job.jobId}-plan` });
    await completePhase(cpbRoot, projectName, job.jobId, { phase: "plan", artifact: "plan-001" });

    // Phase 2: Execute — fresh locator reconstruction (simulating new process)
    const execLocator = await buildLocator(cpbRoot, projectName, job.jobId, { phase: "execute" });
    assert.equal(execLocator.artifacts.plan, "plan-001", "execute phase can reconstruct plan artifact from canonical state");
    assert.equal(execLocator.task, task, "execute phase can reconstruct task from canonical state");

    await startPhase(cpbRoot, projectName, job.jobId, { phase: "execute", leaseId: `lease-${job.jobId}-execute` });
    await completePhase(cpbRoot, projectName, job.jobId, { phase: "execute", artifact: "deliverable-001" });

    // Phase 3: Verify — fresh locator reconstruction
    const verifyLocator = await buildLocator(cpbRoot, projectName, job.jobId, { phase: "verify" });
    assert.equal(verifyLocator.artifacts.plan, "plan-001");
    assert.equal(verifyLocator.artifacts.execute, "deliverable-001");

    await startPhase(cpbRoot, projectName, job.jobId, { phase: "verify", leaseId: `lease-${job.jobId}-verify` });
    await completePhase(cpbRoot, projectName, job.jobId, { phase: "verify", artifact: "verdict-001" });
    await completeJob(cpbRoot, projectName, job.jobId);

    // Full state reconstruction from locator alone
    const finalState = await reconstructJobState(cpbRoot, projectName, job.jobId);
    assert.equal(finalState.jobStatus, "completed");
    assert.equal(finalState.artifacts.plan, "plan-001");
    assert.equal(finalState.artifacts.execute, "deliverable-001");
    assert.equal(finalState.artifacts.verify, "verdict-001");
  });

  test(`unattended drill: ${projectName} verifier does not require executor deliverables`, async () => {
    const cpbRoot = await mkdtemp(path.join(tmpdir(), `cpb-drill-verifier-${projectName}-`));
    await setupProject(cpbRoot, projectName);

    const task = `Optimize ${projectName}: improve error handling`;
    const job = await createJob(cpbRoot, {
      project: projectName,
      task,
      workflow: "standard",
      ts: "2026-05-20T00:00:00.000Z",
    });

    // Simulate execute phase without creating a deliverable file
    await startPhase(cpbRoot, projectName, job.jobId, { phase: "execute", leaseId: `lease-${job.jobId}-execute` });
    await completePhase(cpbRoot, projectName, job.jobId, { phase: "execute", artifact: "" });

    // Verifier can still collect evidence without deliverable
    const evidence = await collectVerifierEvidence(cpbRoot, projectName, job.jobId);
    assert.ok(evidence.jobState, "verifier can access job state without deliverable");
    assert.ok(evidence.eventLog?.available, "verifier can access event log without deliverable");
    assert.ok(evidence.projectContext?.available, "verifier can access project context without deliverable");
    assert.ok(Array.isArray(evidence.diagnostics), "verifier produces diagnostics");
    const missingDiag = evidence.diagnostics.find((d) => d.message.includes("deliverable not available"));
    assert.ok(missingDiag, "verifier diagnoses missing deliverable as info, not crash");
    assert.equal(missingDiag.level, "info");
  });

  test(`unattended drill: ${projectName} failure recovery creates fresh job, original stays immutable`, async () => {
    const cpbRoot = await mkdtemp(path.join(tmpdir(), `cpb-drill-recovery-${projectName}-`));
    await setupProject(cpbRoot, projectName);

    const task = `Optimize ${projectName}: fix memory leak`;
    const job = await createJob(cpbRoot, {
      project: projectName,
      task,
      workflow: "standard",
      ts: "2026-05-20T00:00:00.000Z",
    });

    await startPhase(cpbRoot, projectName, job.jobId, { phase: "execute", leaseId: `lease-${job.jobId}-execute` });
    await failJob(cpbRoot, projectName, job.jobId, {
      reason: "executor timed out",
      code: FAILURE_CODES.RECOVERABLE,
      phase: "execute",
    });

    // Original job stays immutable
    const original = await getJob(cpbRoot, projectName, job.jobId);
    assert.equal(original.status, "failed");
    assert.equal(original.blockedReason, "executor timed out");

    // Recovery creates fresh job
    const recovered = await recoverAsNewJob(cpbRoot, projectName, job.jobId, {
      reason: "automated recovery from timeout",
    });

    assert.notEqual(recovered.jobId, job.jobId, "recovery is a new job");
    assert.equal(recovered.task, task);
    assert.equal(recovered.status, "running");

    // Original is still immutable
    const immutability = await verifyTerminalImmutability(cpbRoot, projectName, job.jobId);
    assert.equal(immutability.immutable, true);

    // New job has lineage
    const events = await readEvents(cpbRoot, projectName, recovered.jobId);
    const recovery = events.find((e) => e.type === "recovery_created");
    assert.ok(recovery);
    assert.equal(recovery.lineage.parentJobId, job.jobId);
  });

  test(`unattended drill: ${projectName} permission denials become structured diagnostics`, async () => {
    const cpbRoot = await mkdtemp(path.join(tmpdir(), `cpb-drill-perms-${projectName}-`));
    await setupProject(cpbRoot, projectName);

    const task = `Optimize ${projectName}: refactor API`;
    const job = await createJob(cpbRoot, {
      project: projectName,
      task,
      workflow: "standard",
      ts: "2026-05-20T00:00:00.000Z",
    });

    // Verify write to inbox is denied for verifier
    const verifyWriteInbox = canWrite(
      "codex-verify",
      path.join(wikiProjectDir(cpbRoot, projectName), "inbox", "plan-001.md"),
      cpbRoot,
      projectName
    );
    assert.equal(verifyWriteInbox.allowed, false);
    assert.ok(verifyWriteInbox.reason);

    // Record structured denial
    await recordPermissionDenial(cpbRoot, projectName, job.jobId, {
      role: "codex-verify",
      action: "write",
      targetPath: path.join(wikiProjectDir(cpbRoot, projectName), "inbox", "plan-001.md"),
      reason: verifyWriteInbox.reason,
    });

    // Verify it's a structured event, not a business FAIL
    const events = await readEvents(cpbRoot, projectName, job.jobId);
    const denial = events.find((e) => e.type === "permission_denied");
    assert.ok(denial, "permission denial is recorded as structured event");
    assert.equal(denial.role, "codex-verify");
    assert.equal(denial.action, "write");
    assert.ok(denial.reason);

    // Reads are still allowed
    const readAllowed = canRead(
      "codex-verify",
      path.join(wikiProjectDir(cpbRoot, projectName), "outputs", "deliverable-001.md"),
      cpbRoot,
      projectName
    );
    assert.equal(readAllowed.allowed, true);
  });

  test(`unattended drill: ${projectName} runs unattended to terminal state`, async () => {
    const cpbRoot = await mkdtemp(path.join(tmpdir(), `cpb-drill-e2e-${projectName}-`));
    await setupProject(cpbRoot, projectName);

    const task = `Optimize ${projectName}: complete end-to-end unattended`;
    const job = await createJob(cpbRoot, {
      project: projectName,
      task,
      workflow: "standard",
      ts: "2026-05-20T00:00:00.000Z",
    });

    const workflow = getWorkflow("standard");

    // Simulate all phases completing
    for (const phase of workflow.phases) {
      const locator = await buildLocator(cpbRoot, projectName, job.jobId, { phase });
      assert.ok(locator.task, `${phase} locator has task`);
      assert.ok(locator.eventLogPath, `${phase} locator has eventLogPath`);

      const validation = await validatePhaseInputs(cpbRoot, projectName, job.jobId, phase);
      assert.equal(validation.valid, true, `${phase} inputs are valid`);

      await startPhase(cpbRoot, projectName, job.jobId, { phase, leaseId: `lease-${job.jobId}-${phase}` });
      const artifact = `${phase === "plan" ? "plan" : phase === "execute" ? "deliverable" : "verdict"}-001`;
      await completePhase(cpbRoot, projectName, job.jobId, { phase, artifact });
    }

    await completeJob(cpbRoot, projectName, job.jobId);

    const finalJob = await getJob(cpbRoot, projectName, job.jobId);
    assert.equal(finalJob.status, "completed");
    assert.equal(finalJob.artifacts.plan, "plan-001");
    assert.equal(finalJob.artifacts.execute, "deliverable-001");
    assert.equal(finalJob.artifacts.verify, "verdict-001");

    // Verify full event history
    const events = await readEvents(cpbRoot, projectName, job.jobId);
    const types = events.map((e) => e.type);
    assert.ok(types.includes("job_created"));
    assert.ok(types.includes("phase_started"));
    assert.ok(types.includes("phase_completed"));
    assert.ok(types.includes("job_completed"));
  });

  test(`unattended drill: ${projectName} pipeline failure starts from current state, not stale artifacts`, async () => {
    const cpbRoot = await mkdtemp(path.join(tmpdir(), `cpb-drill-stale-${projectName}-`));
    await setupProject(cpbRoot, projectName);

    const task = `Optimize ${projectName}: handle stale recovery`;
    const job1 = await createJob(cpbRoot, {
      project: projectName,
      task,
      workflow: "standard",
      ts: "2026-05-20T00:00:00.000Z",
    });

    // Job 1 completes plan then fails at execute
    await startPhase(cpbRoot, projectName, job1.jobId, { phase: "plan", leaseId: "l1" });
    await completePhase(cpbRoot, projectName, job1.jobId, { phase: "plan", artifact: "plan-001" });
    await startPhase(cpbRoot, projectName, job1.jobId, { phase: "execute", leaseId: "l2" });
    await failJob(cpbRoot, projectName, job1.jobId, {
      reason: "execute failed",
      code: FAILURE_CODES.RECOVERABLE,
      phase: "execute",
    });

    // Recovery creates a fresh job
    const job2 = await retryAsNewJob(cpbRoot, projectName, job1.jobId, { trigger: "automated" });

    // Job 2 starts from current issue/task state via locator
    const job2Locator = await buildLocator(cpbRoot, projectName, job2.jobId, { phase: "plan" });
    assert.equal(job2Locator.task, task, "recovery job reads task from canonical state");
    assert.equal(job2Locator.workflow, "standard", "recovery job reads workflow from canonical state");

    // Job 1 remains unchanged audit record
    const job1Final = await getJob(cpbRoot, projectName, job1.jobId);
    assert.equal(job1Final.status, "failed");
    assert.equal(job1Final.artifacts.plan, "plan-001", "original job artifacts preserved");

    // Job 2 has lineage
    const job2Events = await readEvents(cpbRoot, projectName, job2.jobId);
    const lineage = job2Events.find((e) => e.type === "recovery_created");
    assert.equal(lineage.lineage.parentJobId, job1.jobId);
    assert.equal(lineage.lineage.parentStatus, "failed");
  });
}
