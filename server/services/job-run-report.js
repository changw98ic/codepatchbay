import { listEventFiles, materializeJob, readEventsReadOnly } from "./event-store.js";
import { listRuntimeDataRoots } from "./runtime-context.js";

const STATUS_KEYS = ["running", "completed", "failed", "blocked", "cancelled", "unknown"];

function anomalyReason(job, jobIdSet) {
  if (job.status === "failed") return job.blockedReason || job.failureCode || "failed";
  if (job.status === "blocked") return job.blockedReason || "blocked";
  if (job.status === "cancelled") return job.cancelReason || "cancelled";
  const parentId = job.lineage?.parentJobId;
  if (parentId && !jobIdSet.has(parentId)) return `orphan recovery: parent ${parentId} not found`;
  if (parentId) return `recovery from ${parentId}`;
  return job.status;
}

function isAnomalous(job, jobIdSet) {
  if (["failed", "blocked", "cancelled"].includes(job.status)) return true;
  if (job.lineage?.parentJobId) return true;
  return false;
}

export async function buildJobRunReport({ cpbRoot, anomalyLimit = 10, hubRoot } = {}) {
  const roots = await listRuntimeDataRoots(cpbRoot, { hubRoot });
  const seenPaths = new Set();
  const eventFiles = [];
  for (const root of roots) {
    const dataRoot = root.kind === "legacy" ? undefined : root.dataRoot;
    const batch = await listEventFiles(cpbRoot, { dataRoot });
    for (const f of batch) {
      if (seenPaths.has(f.file)) continue;
      seenPaths.add(f.file);
      eventFiles.push({ ...f, dataRoot });
    }
  }

  const jobs = [];
  for (const { project, jobId, file, dataRoot } of eventFiles) {
    const events = await readEventsReadOnly(cpbRoot, project, jobId, dataRoot ? { dataRoot } : {});
    if (!events || events.length === 0) continue;
    const job = materializeJob(events);
    if (!job.jobId || !job.project || !job.createdAt) continue;
    jobs.push({ ...job, eventLogPath: file });
  }

  const statusCounts = {};
  for (const key of STATUS_KEYS) statusCounts[key] = 0;
  for (const job of jobs) {
    const status = STATUS_KEYS.includes(job.status) ? job.status : "unknown";
    statusCounts[status]++;
  }

  const phaseMap = {};
  for (const job of jobs) {
    if (job.failurePhase && job.failureCode) {
      if (!phaseMap[job.failurePhase]) phaseMap[job.failurePhase] = {};
      phaseMap[job.failurePhase][job.failureCode] = (phaseMap[job.failurePhase][job.failureCode] || 0) + 1;
    }
  }
  const phaseFailureCounts = Object.keys(phaseMap).sort().map((phase) => ({
    phase,
    count: Object.values(phaseMap[phase]).reduce((a, b) => a + b, 0),
    byCode: Object.entries(phaseMap[phase])
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, count]) => ({ code, count })),
  }));

  const cancellationCount = jobs.filter((j) => j.status === "cancelled").length;
  const retryRecoveryCount = jobs.filter(
    (j) => (j.lineage?.parentJobId) || j.retryCount > 0
  ).length;

  const jobIdSet = new Set(jobs.map((j) => j.jobId));
  const recentAnomalousJobs = jobs
    .filter((j) => isAnomalous(j, jobIdSet))
    .sort((a, b) => {
      const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return tb - ta;
    })
    .slice(0, anomalyLimit)
    .map((j) => ({
      project: j.project,
      jobId: j.jobId,
      status: j.status,
      phase: j.phase || null,
      failurePhase: j.failurePhase || null,
      failureCode: j.failureCode || null,
      updatedAt: j.updatedAt,
      eventLogPath: j.eventLogPath,
      parentJobId: j.lineage?.parentJobId || null,
      reason: anomalyReason(j, jobIdSet),
    }));

  return {
    command: "cpb jobs report",
    generatedAt: new Date().toISOString(),
    totalJobs: jobs.length,
    statusCounts,
    phaseFailureCounts,
    cancellationCount,
    retryRecoveryCount,
    recentAnomalousJobs,
  };
}

export function formatReportHuman(report) {
  const lines = [];
  lines.push("Job run report");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Total jobs: ${report.totalJobs}`);
  lines.push("");
  lines.push("Status counts:");
  for (const [status, count] of Object.entries(report.statusCounts)) {
    lines.push(`  ${status}: ${count}`);
  }
  if (report.phaseFailureCounts.length > 0) {
    lines.push("");
    lines.push("Phase failures:");
    for (const pf of report.phaseFailureCounts) {
      lines.push(`  ${pf.phase}: ${pf.count}`);
      for (const bc of pf.byCode) {
        lines.push(`    ${bc.code}: ${bc.count}`);
      }
    }
  }
  lines.push("");
  lines.push(`Cancellations: ${report.cancellationCount}`);
  lines.push(`Retry/recovery: ${report.retryRecoveryCount}`);
  if (report.recentAnomalousJobs.length > 0) {
    lines.push("");
    lines.push(`Recent anomalies (showing ${report.recentAnomalousJobs.length}):`);
    for (const a of report.recentAnomalousJobs) {
      lines.push(`  ${a.jobId} ${a.status} phase:${a.phase || "-"} ${a.reason}`);
    }
  }
  return lines.join("\n");
}
