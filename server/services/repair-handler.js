import { mkdir, rmdir, readFile } from "node:fs/promises";
import path from "node:path";
import { appendEvent, checkpointJob, readEvents, materializeJob } from "./event-store.js";
import { readJobsIndex, updateJobsIndexEntry } from "./jobs-index.js";
import { resolveHubRoot } from "./hub-registry.js";
import { enqueue, listQueue } from "./hub-queue.js";
import { allocateArtifactId } from "./artifact-locator.js";
import { runtimeDataRoot } from "./runtime-root.js";

function dataRoot(cpbRoot) {
  return process.env.CPB_PROJECT_RUNTIME_ROOT || runtimeDataRoot(cpbRoot);
}

function validateId(name, value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value)) {
    throw new Error(`invalid ${name}: ${value}`);
  }
}

async function acquireRepairLock(cpbRoot, project, jobId) {
  const lockDir = path.join(dataRoot(cpbRoot), "repair-locks", project, `${jobId}.lock`);
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

async function recordEvent(cpbRoot, project, jobId, event) {
  await appendEvent(cpbRoot, project, jobId, event);
  await checkpointJob(cpbRoot, project, jobId).catch(() => {});
  const state = materializeJob(await readEvents(cpbRoot, project, jobId));
  await updateJobsIndexEntry(cpbRoot, project, jobId, state).catch(() => {});
}

export async function runRepair(cpbRoot, { project, jobId, executorRoot }) {
  validateId("project", project);
  validateId("jobId", jobId);

  const wikiDir = path.join(cpbRoot, "wiki", "projects", project);
  const outputsDir = path.join(wikiDir, "outputs");

  let events;
  try {
    events = await readEvents(cpbRoot, project, jobId);
  } catch {
    events = [];
  }
  if (events.length === 0) {
    throw new Error(`event file not found or empty for job ${jobId}`);
  }
  const job = materializeJob(events);

  const repairId = await allocateArtifactId(outputsDir, "repair");
  const repairFile = path.join(outputsDir, `repair-${repairId}.md`);
  const repairArtifact = `repair-${repairId}`;

  let sourcePath = "";
  try {
    const metaFile = path.join(wikiDir, "project.json");
    const meta = JSON.parse(await readFile(metaFile, "utf8"));
    sourcePath = meta.sourcePath || "";
  } catch {}

  return { repairId, repairFile, repairArtifact, workflow: job?.workflow || "", sourcePath };
}

export async function completeRepair(cpbRoot, { project, jobId, repairId, repairFile, repairArtifact, status, error, executorRoot }) {
  if (status === "failed") {
    await recordEvent(cpbRoot, project, jobId, {
      type: "external_repair_failed",
      jobId,
      project,
      artifact: repairArtifact,
      file: repairFile,
      error: error || "unknown error",
      ts: new Date().toISOString(),
    });
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
    });
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
    });
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
  });

  if (repairStatus === "FIXED") {
    await markJobSuperseded(cpbRoot, project, jobId);
    await createLineageTask(cpbRoot, { project, jobId, repairArtifact, repairStatus, executorRoot });
  }

  return repairStatus;
}

function parseRepairStatus(content) {
  const firstLine = content.split(/\r?\n/)[0] || "";
  const match = firstLine.match(/^REPAIR:\s*([A-Z_]+)/);
  const status = match ? match[1] : null;
  if (status === "FIXED" || status === "NOOP" || status === "BLOCKED") return status;
  return null;
}

async function markJobSuperseded(cpbRoot, project, jobId) {
  await recordEvent(cpbRoot, project, jobId, {
    type: "job_superseded",
    jobId,
    project,
    reason: "external_repair_fixed",
    ts: new Date().toISOString(),
  });
  const state = materializeJob(await readEvents(cpbRoot, project, jobId));
  if (state) {
    state.status = "superseded";
    await updateJobsIndexEntry(cpbRoot, project, jobId, state).catch(() => {});
  }
}

async function createLineageTask(cpbRoot, { project, jobId, repairArtifact, repairStatus, executorRoot }) {
  const job = materializeJob(await readEvents(cpbRoot, project, jobId));
  if (!job?.task) {
    throw new Error(`job task missing: ${jobId}`);
  }

  // Skip if a completed job already exists for the same task
  try {
    const index = await readJobsIndex(cpbRoot);
    const jobs = index?.jobs || {};
    const alreadyCompleted = Object.values(jobs).some(
      (j) => j && j.task === job.task && j.status === "completed" && j.project === project,
    );
    if (alreadyCompleted) {
      console.log(`Skip lineage task: task already completed — ${job.task.slice(0, 60)}`);
      return;
    }
  } catch {}

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
    },
  });

  console.log(`New task: ${entry.id}`);
}
