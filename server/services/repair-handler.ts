import { mkdir, rmdir, readFile } from "node:fs/promises";
import path from "node:path";
import { appendEvent, checkpointJob, readEvents, materializeJob } from "./event-store.js";
import { updateJobsIndexEntry } from "./jobs-index.js";
import { resolveHubRoot } from "./hub-registry.js";
import { enqueue, listQueue } from "./hub-queue.js";
import { allocateArtifactId, resolveOutputsDir } from "./artifact-locator.js";
import { resolveProjectDataRoot } from "./runtime-context.js";

function validateId(name, value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value)) {
    throw new Error(`invalid ${name}: ${value}`);
  }
}

async function acquireRepairLock(cpbRoot, project, jobId, dataRoot) {
  const lockDir = path.join(dataRoot || await resolveProjectDataRoot(cpbRoot, project), "repair-locks", project, `${jobId}.lock`);
  await mkdir(path.dirname(lockDir), { recursive: true });
  try {
    await mkdir(lockDir);
  } catch (err) {
    if (err.code === "EEXIST") {
      throw new Error(`Repair already running for ${project}/${jobId}`);
    }
    throw err;
  }
  return lockDir;
}

async function releaseRepairLock(lockDir) {
  try {
    await rmdir(lockDir);
  } catch {}
}

async function recordEvent(cpbRoot, project, jobId, event, dataRoot) {
  const eventOpts = { dataRoot, includeLegacyFallback: false };
  await appendEvent(cpbRoot, project, jobId, event, eventOpts);
  await checkpointJob(cpbRoot, project, jobId, eventOpts).catch(() => {});
  const state = materializeJob(await readEvents(cpbRoot, project, jobId, eventOpts));
  await updateJobsIndexEntry(cpbRoot, project, jobId, state, eventOpts).catch(() => {});
}

export async function runRepair(cpbRoot, { project, jobId, executorRoot = null }) {
  validateId("project", project);
  validateId("jobId", jobId);

  const hubRoot = resolveHubRoot(cpbRoot);
  const dataRoot = await resolveProjectDataRoot(cpbRoot, project, { hubRoot });
  const eventFile = path.join(dataRoot, "events", project, `${jobId}.jsonl`);
  let events;
  try {
    events = await readEvents(cpbRoot, project, jobId, { dataRoot, includeLegacyFallback: false });
  } catch {
    events = [];
  }
  if (events.length === 0) {
    throw new Error(`event file not found or empty: ${eventFile}`);
  }

  const lockDir = await acquireRepairLock(cpbRoot, project, jobId, dataRoot);
  try {
    const outputsDir = await resolveOutputsDir(hubRoot, cpbRoot, project);
    const repairId = await allocateArtifactId(outputsDir, "repair");
    const repairFile = path.join(outputsDir, `repair-${repairId}.md`);
    const repairArtifact = `repair-${repairId}`;

    return { repairId, repairFile, repairArtifact, dataRoot, lockDir };
  } catch (err) {
    await releaseRepairLock(lockDir);
    throw err;
  }
}

export async function completeRepair(cpbRoot, { project, jobId, repairId, repairFile, repairArtifact, status, error = null, executorRoot = null, lockDir = null }) {
  const hubRoot = resolveHubRoot(cpbRoot);
  const dataRoot = await resolveProjectDataRoot(cpbRoot, project, { hubRoot });
  const activeLockDir = lockDir || path.join(dataRoot, "repair-locks", project, `${jobId}.lock`);
  try {
    if (status === "failed") {
      await recordEvent(cpbRoot, project, jobId, {
        type: "external_repair_failed",
        jobId,
        project,
        artifact: repairArtifact,
        file: repairFile,
        error: error || "unknown error",
        ts: new Date().toISOString(),
      }, dataRoot);
      return;
    }

    let repairContent;
    try {
      repairContent = await readFile(repairFile, "utf8");
    } catch {
      await recordEvent(cpbRoot, project, jobId, {
        type: "external_repair_failed",
        jobId,
        project,
        artifact: repairArtifact,
        file: repairFile,
        error: "repair report not created",
        ts: new Date().toISOString(),
      }, dataRoot);
      throw new Error("repair report not created");
    }

    const repairStatus = parseRepairStatus(repairContent);
    if (!repairStatus) {
      await recordEvent(cpbRoot, project, jobId, {
        type: "external_repair_failed",
        jobId,
        project,
        artifact: repairArtifact,
        file: repairFile,
        error: `invalid repair status: ${repairStatus === null ? "missing" : repairStatus}`,
        ts: new Date().toISOString(),
      }, dataRoot);
      throw new Error("invalid repair status");
    }

    await recordEvent(cpbRoot, project, jobId, {
      type: "external_repair_completed",
      jobId,
      project,
      artifact: repairArtifact,
      file: repairFile,
      repairStatus,
      ts: new Date().toISOString(),
    }, dataRoot);

    if (repairStatus === "FIXED") {
      await createLineageTask(cpbRoot, { project, jobId, repairArtifact, repairStatus, executorRoot, dataRoot });
    }

    return repairStatus;
  } finally {
    await releaseRepairLock(activeLockDir);
  }
}

function parseRepairStatus(content) {
  const firstLine = content.split(/\r?\n/)[0] || "";
  const match = firstLine.match(/^REPAIR:\s*([A-Z_]+)/);
  const status = match ? match[1] : null;
  if (status === "FIXED" || status === "NOOP" || status === "BLOCKED") return status;
  return null;
}

async function createLineageTask(cpbRoot, { project, jobId, repairArtifact, repairStatus, executorRoot, dataRoot }) {
  const job = materializeJob(await readEvents(cpbRoot, project, jobId, { dataRoot, includeLegacyFallback: false }));
  if (!job?.task) {
    throw new Error(`job task missing: ${jobId}`);
  }

  const hubRoot = resolveHubRoot(cpbRoot);
  const entries = await listQueue(hubRoot, { projectId: project });
  const origin =
    entries.find((entry) => entry.metadata?.jobId === jobId) ||
    entries.find((entry) => entry.description === job.task && entry.status === "failed") ||
    entries.find((entry) => entry.description === job.task) ||
    null;

  let sourcePath = origin?.sourcePath || "";
  if (!sourcePath) {
    try {
      const metaFile = path.join(cpbRoot, "wiki", "projects", project, "project.json");
      const meta = JSON.parse(await readFile(metaFile, "utf8"));
      sourcePath = meta.sourcePath || "";
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
      repairArtifact,
      repairStatus,
      lineageReason: "external_repair_fixed_cpb_self_bug",
      sourceContext: {
        ...(origin?.metadata?.sourceContext || job.sourceContext || {}),
        repair: {
          previousJobId: jobId,
          previousQueueEntryId: origin?.id || null,
          repairArtifact,
          repairStatus,
          lineageReason: "external_repair_fixed_cpb_self_bug",
          failureReason: job.blockedReason || null,
          failurePhase: job.failurePhase || null,
          failureCode: job.failureCode || null,
          artifacts: job.artifacts || {},
        },
        retry: {
          failureKind: job.failureCode || "external_repair",
          failureReason: job.blockedReason || "external repair requested",
          previousJobId: jobId,
          previousPhase: job.failurePhase || null,
          previousOutput: "",
          artifacts: job.artifacts || {},
        },
        previousFailure: {
          kind: job.failureCode || "external_repair",
          reason: job.blockedReason || "external repair requested",
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
