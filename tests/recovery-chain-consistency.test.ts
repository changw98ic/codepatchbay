import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";

import { completePhase, blockJob, createJob } from "../server/services/job/job-store.js";
import { acceptSession, dispatchSession } from "../server/services/review/review-dispatch.js";
import { createSession, getSession, updateSession } from "../server/services/review/review-session.js";
import { completeRepair, runRepair } from "../server/services/review/review-dispatch.js";
import { completeRemediation, runRemediation } from "../server/services/review/review-dispatch.js";
import { enqueue, listQueue, updateEntry } from "../server/services/hub/hub-queue.js";
import { registerProject } from "../server/services/hub/hub-registry.js";
import { recordValue } from "../shared/types.js";
import { tempRoot } from "./helpers.js";

async function withHubRoot(hubRoot, fn) {
  const previous = process.env.CPB_HUB_ROOT;
  process.env.CPB_HUB_ROOT = hubRoot;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.CPB_HUB_ROOT;
    else process.env.CPB_HUB_ROOT = previous;
  }
}

async function prepareProject(prefix = "cpb-recovery") {
  const cpbRoot = await tempRoot(`${prefix}-cpb`);
  const hubRoot = await tempRoot(`${prefix}-hub`);
  const sourcePath = await tempRoot(`${prefix}-source`);
  const project = await registerProject(hubRoot, {
    id: "proj",
    sourcePath,
    skipCodeGraphGate: true,
  });
  return { cpbRoot, hubRoot, sourcePath, dataRoot: project.projectRuntimeRoot };
}

test("repair and remediation handlers hold per-job locks until completion", async () => {
  const { cpbRoot, hubRoot, dataRoot } = await prepareProject("cpb-repair-lock");
  await withHubRoot(hubRoot, async () => {
    const job = await createJob(cpbRoot, {
      project: "proj",
      jobId: "job-repair-lock",
      task: "repair lock task",
      dataRoot,
    });

    const repair = await runRepair(cpbRoot, { project: "proj", jobId: job.jobId });
    assert.equal(existsSync(repair.lockDir), true);
    await assert.rejects(
      () => runRepair(cpbRoot, { project: "proj", jobId: job.jobId }),
      /Repair already running/,
    );

    await completeRepair(cpbRoot, {
      project: "proj",
      jobId: job.jobId,
      repairId: repair.repairId,
      repairFile: repair.repairFile,
      repairArtifact: repair.repairArtifact,
      status: "failed",
      error: "test failure",
      lockDir: repair.lockDir,
    });
    assert.equal(existsSync(repair.lockDir), false);

    const remediationJob = await createJob(cpbRoot, {
      project: "proj",
      jobId: "job-remediation-lock",
      task: "remediation lock task",
      dataRoot,
    });
    const remediation = await runRemediation(cpbRoot, { project: "proj", jobId: remediationJob.jobId });
    assert.equal(existsSync(remediation.lockDir), true);
    await assert.rejects(
      () => runRemediation(cpbRoot, { project: "proj", jobId: remediationJob.jobId }),
      /Remediation already running/,
    );
    await completeRemediation(cpbRoot, {
      project: "proj",
      jobId: remediationJob.jobId,
      remediationId: remediation.remediationId,
      remediationFile: remediation.remediationFile,
      remediationArtifact: remediation.remediationArtifact,
      status: "failed",
      error: "test failure",
      lockDir: remediation.lockDir,
    });
    assert.equal(existsSync(remediation.lockDir), false);
  });
});

test("review dispatch serializes enqueue and session updates per session", async () => {
  const { cpbRoot, hubRoot } = await prepareProject("cpb-review-dispatch");
  const storageOptions = { hubRoot };
  const session = await createSession(cpbRoot, { project: "proj", intent: "same review task", ...storageOptions });
  await updateSession(cpbRoot, session.sessionId, { status: "user_review" }, { ...storageOptions, skipTransitionCheck: true });

  const [first, second] = await Promise.all([
    dispatchSession(cpbRoot, session.sessionId, { hubRoot }),
    dispatchSession(cpbRoot, session.sessionId, { hubRoot }),
  ]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.jobId, second.jobId);
  const updated = await getSession(cpbRoot, session.sessionId, storageOptions);
  assert.equal(updated.status, "dispatched");
  assert.equal(updated.jobId, first.jobId);
  assert.equal(updated.queueEntryId, first.taskId);
  assert.equal(updated.idempotency.dispatchKey, `review:${session.sessionId}`);

  const entries = await listQueue(hubRoot, { projectId: "proj" });
  const dispatched = entries.filter((entry) => entry.metadata?.reviewSessionId === session.sessionId);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].metadata.queueDedupeKey, `review:${session.sessionId}`);
});

test("review accept records merge failure when registry source path is missing", async () => {
  const cpbRoot = await tempRoot("cpb-review-accept-cpb");
  const hubRoot = await tempRoot("cpb-review-accept-hub");
  const worktreePath = await tempRoot("cpb-review-accept-worktree");
  const storageOptions = { hubRoot };
  const session = await createSession(cpbRoot, { project: "missing-project", intent: "accept missing source", ...storageOptions });
  await updateSession(cpbRoot, session.sessionId, {
    status: "user_review",
    jobId: "job-review-accept-missing",
    worktreePath,
  }, { ...storageOptions, skipTransitionCheck: true });

  const result = await acceptSession(cpbRoot, session.sessionId, { hubRoot });
  const updated = await getSession(cpbRoot, session.sessionId, storageOptions);

  assert.equal(result.ok, true);
  assert.equal(result.status, "merge_failed");
  assert.equal(result.mergeFailed, true);
  assert.equal(result.merged, false);
  assert.equal(updated.status, "merge_failed");
  assert.match(updated.mergeError, /sourcePath missing/);
  assert.equal(existsSync(`${cpbRoot}/cpb-task`), false);
});

test("repair FIXED lineage carries retry, previousFailure, and artifact context", async () => {
  const { cpbRoot, hubRoot, sourcePath, dataRoot } = await prepareProject("cpb-repair-lineage");
  await withHubRoot(hubRoot, async () => {
    const job = await createJob(cpbRoot, {
      project: "proj",
      jobId: "job-repair-lineage",
      task: "repair lineage task",
      dataRoot,
      sourceContext: { issueNumber: 42 },
    });
    await completePhase(cpbRoot, "proj", job.jobId, {
      phase: "plan",
      artifact: "plan-001",
      dataRoot,
    });
    await blockJob(cpbRoot, "proj", job.jobId, {
      reason: "verification failed",
      code: "verification_failed",
      dataRoot,
    });

    const origin = await enqueue(hubRoot, {
      projectId: "proj",
      sourcePath,
      description: "repair lineage task",
      metadata: {
        jobId: job.jobId,
        sourceContext: { issueNumber: 42, queueEntryId: "origin-entry" },
      },
    });
    await updateEntry(hubRoot, origin.id, { status: "failed" });

    const repair = await runRepair(cpbRoot, { project: "proj", jobId: job.jobId });
    await writeFile(repair.repairFile, "REPAIR: FIXED\n\nfixed by test\n", "utf8");
    const status = await completeRepair(cpbRoot, {
      project: "proj",
      jobId: job.jobId,
      repairId: repair.repairId,
      repairFile: repair.repairFile,
      repairArtifact: repair.repairArtifact,
      status: "completed",
      lockDir: repair.lockDir,
    });
    assert.equal(status, "FIXED");

    const entries = await listQueue(hubRoot, { projectId: "proj" });
    const lineage = entries.find((entry) => entry.metadata?.originJobId === job.jobId);
    assert.ok(lineage, "repair should enqueue a lineage task");
    const sourceContext = recordValue(lineage.metadata?.sourceContext);
    const repairContext = recordValue(sourceContext.repair);
    const repairArtifacts = recordValue(repairContext.artifacts);
    const retryContext = recordValue(sourceContext.retry);
    const retryArtifacts = recordValue(retryContext.artifacts);
    const previousFailure = recordValue(sourceContext.previousFailure);
    const previousArtifacts = recordValue(previousFailure.artifacts);
    assert.equal(sourceContext.issueNumber, 42);
    assert.equal(repairContext.repairArtifact, repair.repairArtifact);
    assert.equal(repairArtifacts.plan, "plan-001");
    assert.equal(retryContext.failureKind, "verification_failed");
    assert.equal(retryContext.previousJobId, job.jobId);
    assert.equal(retryArtifacts.plan, "plan-001");
    assert.equal(previousFailure.kind, "verification_failed");
    assert.equal(previousFailure.reason, "verification failed");
    assert.equal(previousArtifacts.plan, "plan-001");
  });
});
