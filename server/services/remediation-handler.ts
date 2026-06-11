import { mkdir, rmdir, readFile } from "node:fs/promises";
import path from "node:path";
import { appendEvent, checkpointJob, readEvents, materializeJob } from "./event-store.js";
import { readJobsIndex, updateJobsIndexEntry } from "./jobs-index.js";
import { getProject, resolveHubRoot } from "./hub-registry.js";
import { enqueue, listQueue } from "./hub-queue.js";
import { allocateArtifactId } from "./artifact-locator.js";
import { resolveProjectDataRoot } from "./runtime-context.js";

function validateId(name, value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value)) {
    throw new Error(`invalid ${name}: ${value}`);
  }
}

async function acquireRemediationLock(cpbRoot, project, jobId, dataRoot) {
  const lockDir = path.join(dataRoot, "remediation-locks", project, `${jobId}.lock`);
  await mkdir(path.dirname(lockDir), { recursive: true });
  try {
    await mkdir(lockDir);
  } catch (err) {
    if (err.code === "EEXIST") {
      throw new Error(`Remediation already running for ${project}/${jobId}`);
    }
    throw err;
  }
  return lockDir;
}

async function releaseRemediationLock(lockDir) {
  try {
    await rmdir(lockDir);
  } catch {}
}

async function recordEvent(cpbRoot, project, jobId, event, dataRoot) {
  const eventOpts = { dataRoot, includeLegacyFallback: false };
  await appendEvent(cpbRoot, project, jobId, event, eventOpts);
  await checkpointJob(cpbRoot, project, jobId, eventOpts).catch(() => {});
  const state = materializeJob(await readEvents(cpbRoot, project, jobId, eventOpts));
  await updateJobsIndexEntry(cpbRoot, project, jobId, state, { dataRoot }).catch(() => {});
}

export async function runRemediation(cpbRoot, { project, jobId, executorRoot = null }) {
  validateId("project", project);
  validateId("jobId", jobId);

  const hubRoot = resolveHubRoot(cpbRoot);
  const dataRoot = await resolveProjectDataRoot(cpbRoot, project, { hubRoot });

  let events;
  try {
    events = await readEvents(cpbRoot, project, jobId, { dataRoot, includeLegacyFallback: false });
  } catch {
    events = [];
  }
  if (events.length === 0) {
    throw new Error(`event file not found or empty for job ${jobId}`);
  }
  const job = materializeJob(events);

  const lockDir = await acquireRemediationLock(cpbRoot, project, jobId, dataRoot);
  try {
    const wikiDir = path.join(dataRoot, "wiki");
    const outputsDir = path.join(wikiDir, "outputs");
    const remediationId = await allocateArtifactId(outputsDir, "remediation");
    const remediationFile = path.join(outputsDir, `remediation-${remediationId}.md`);
    const remediationArtifact = `remediation-${remediationId}`;

    let sourcePath = "";
    try {
      sourcePath = (await getProject(hubRoot, project))?.sourcePath || "";
    } catch {}

    return { remediationId, remediationFile, remediationArtifact, workflow: job?.workflow || "", sourcePath, lockDir };
  } catch (err) {
    await releaseRemediationLock(lockDir);
    throw err;
  }
}

export async function completeRemediation(cpbRoot, { project, jobId, remediationId, remediationFile, remediationArtifact, status, error = null, executorRoot = null, lockDir = null }) {
  const hubRoot = resolveHubRoot(cpbRoot);
  const dataRoot = await resolveProjectDataRoot(cpbRoot, project, { hubRoot });
  const activeLockDir = lockDir || path.join(dataRoot, "remediation-locks", project, `${jobId}.lock`);
  try {
    if (status === "failed") {
      await recordEvent(cpbRoot, project, jobId, {
        type: "external_remediation_failed",
        jobId,
        project,
        artifact: remediationArtifact,
        file: remediationFile,
        error: error || "unknown error",
        ts: new Date().toISOString(),
      }, dataRoot);
      return;
    }

    let remediationContent;
    try {
      remediationContent = await readFile(remediationFile, "utf8");
    } catch {
      await recordEvent(cpbRoot, project, jobId, {
        type: "external_remediation_failed",
        jobId,
        project,
        artifact: remediationArtifact,
        file: remediationFile,
        error: "remediation report not created",
        ts: new Date().toISOString(),
      }, dataRoot);
      throw new Error("remediation report not created");
    }

    const remediationStatus = parseRemediationStatus(remediationContent);
    if (!remediationStatus) {
      await recordEvent(cpbRoot, project, jobId, {
        type: "external_remediation_failed",
        jobId,
        project,
        artifact: remediationArtifact,
        file: remediationFile,
        error: `invalid remediation status: ${remediationStatus === null ? "missing" : remediationStatus}`,
        ts: new Date().toISOString(),
      }, dataRoot);
      throw new Error("invalid remediation status");
    }

    await recordEvent(cpbRoot, project, jobId, {
      type: "external_remediation_completed",
      jobId,
      project,
      artifact: remediationArtifact,
      file: remediationFile,
      remediationStatus,
      ts: new Date().toISOString(),
    }, dataRoot);

    if (remediationStatus === "FIXED") {
      await markJobSuperseded(cpbRoot, project, jobId, dataRoot);
      await createLineageTask(cpbRoot, { project, jobId, remediationArtifact, remediationStatus, executorRoot, dataRoot, hubRoot });
    }

    return remediationStatus;
  } finally {
    await releaseRemediationLock(activeLockDir);
  }
}

function parseRemediationStatus(content) {
  const firstLine = content.split(/\r?\n/)[0] || "";
  const match = firstLine.match(/^REMEDIATION:\s*([A-Z_]+)/);
  const status = match ? match[1] : null;
  if (status === "FIXED" || status === "NOOP" || status === "BLOCKED") return status;
  return null;
}

async function markJobSuperseded(cpbRoot, project, jobId, dataRoot) {
  await recordEvent(cpbRoot, project, jobId, {
    type: "job_superseded",
    jobId,
    project,
    reason: "external_remediation_fixed",
    ts: new Date().toISOString(),
  }, dataRoot);
  const state = materializeJob(await readEvents(cpbRoot, project, jobId, { dataRoot, includeLegacyFallback: false }));
  if (state) {
    state.status = "superseded";
    await updateJobsIndexEntry(cpbRoot, project, jobId, state, { dataRoot }).catch(() => {});
  }
}

async function createLineageTask(cpbRoot, { project, jobId, remediationArtifact, remediationStatus, executorRoot, dataRoot, hubRoot }) {
  const job = materializeJob(await readEvents(cpbRoot, project, jobId, { dataRoot, includeLegacyFallback: false }));
  if (!job?.task) {
    throw new Error(`job task missing: ${jobId}`);
  }

  // Skip if a completed job already exists for the same task
  try {
    const index = await readJobsIndex(cpbRoot, { dataRoot });
    const jobs = index?.jobs || {};
    const alreadyCompleted = Object.values(jobs).some(
      (j) => {
        const candidate = j as Record<string, any>;
        return candidate && candidate.task === job.task && candidate.status === "completed" && candidate.project === project;
      },
    );
    if (alreadyCompleted) {
      console.log(`Skip lineage task: task already completed — ${job.task.slice(0, 60)}`);
      return;
    }
  } catch {}

  const entries = await listQueue(hubRoot, { projectId: project });
  const origin =
    entries.find((entry) => entry.metadata?.jobId === jobId) ||
    entries.find((entry) => entry.description === job.task && entry.status === "failed") ||
    entries.find((entry) => entry.description === job.task) ||
    null;

  let sourcePath = origin?.sourcePath || "";
  if (!sourcePath) {
    try {
      sourcePath = (await getProject(hubRoot, project))?.sourcePath || "";
    } catch {}
  }

  const entry = await enqueue(hubRoot, {
    projectId: project,
    sourcePath,
    sessionId: origin?.sessionId || null,
    workerId: origin?.workerId || null,
    cwd: origin?.cwd || sourcePath,
    executionBoundary: origin?.executionBoundary || "worktree",
    type: origin?.type || "pipeline",
    priority: origin?.priority || "P2",
    description: job.task,
    metadata: {
      ...(origin?.metadata || {}),
      originJobId: jobId,
      originQueueEntryId: origin?.id || null,
      remediationArtifact,
      remediationStatus,
      lineageReason: "external_remediation_fixed_cpb_self_bug",
      sourceContext: {
        ...(origin?.metadata?.sourceContext || job.sourceContext || {}),
        remediation: {
          previousJobId: jobId,
          previousQueueEntryId: origin?.id || null,
          remediationArtifact,
          remediationStatus,
          lineageReason: "external_remediation_fixed_cpb_self_bug",
          failureReason: job.blockedReason || null,
          failurePhase: job.failurePhase || null,
          failureCode: job.failureCode || null,
          artifacts: job.artifacts || {},
        },
        retry: {
          failureKind: job.failureCode || "external_remediation",
          failureReason: job.blockedReason || "external remediation requested",
          previousJobId: jobId,
          previousPhase: job.failurePhase || null,
          previousOutput: "",
          artifacts: job.artifacts || {},
        },
        previousFailure: {
          kind: job.failureCode || "external_remediation",
          reason: job.blockedReason || "external remediation requested",
          jobId,
          phase: job.failurePhase || null,
          retryCount: job.retryCount || 0,
          artifacts: job.artifacts || {},
        },
      },
    },
  });

  console.log(`New task: ${entry.id}`);
}
