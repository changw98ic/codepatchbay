// Merged from: job-projection.ts, job-run-report.ts, job-artifact-detail.ts, artifact-index.ts

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { readEvents, readEventsReadOnly, listEventFiles, materializeJob } from "../event/event-store.js";
import { listRuntimeDataRoots } from "../runtime.js";
import { normalizeWorkflow } from "../../../core/workflow/definition.js";
import { parseVerdictEnvelope } from "../../../core/workflow/verdict.js";

// ──────────────────────────────────────────────────────────────────────────────
// artifact-index.ts (merged)
// ──────────────────────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;
const SCHEMA_VERSION_WITH_CHECKLIST = 2;
const KNOWN_KINDS = new Set([
  "plan", "deliverable", "review", "verdict", "prompt", "diff", "tests", "risk", "pr",
  "acceptance-checklist", "execution-map", "evidence-ledger", "checklist-verdict",
]);

function wikiProjectDir(cpbRoot: string, project: string, wikiDir?: string | null) {
  if (wikiDir) return path.resolve(wikiDir);
  return path.join(path.resolve(cpbRoot), "wiki", "projects", project);
}

function runtimeWikiDir(dataRoot: string) {
  return path.join(path.resolve(dataRoot), "wiki");
}

function inboxDir(cpbRoot: string, project: string, wikiDir?: string | null) {
  return path.join(wikiProjectDir(cpbRoot, project, wikiDir), "inbox");
}

function outputsDir(cpbRoot: string, project: string, wikiDir?: string | null) {
  return path.join(wikiProjectDir(cpbRoot, project, wikiDir), "outputs");
}

function basename(value: unknown) {
  return path.basename(String(value || ""));
}

function withoutKnownExtension(fileName: string) {
  return fileName.replace(/\.(?:md|patch|diff|txt|json)$/i, "");
}

function inferKind(event: Record<string, any>, artifact: string) {
  if (KNOWN_KINDS.has(event.kind)) return event.kind;
  if (KNOWN_KINDS.has(event.artifactKind)) return event.artifactKind;
  if (event.type === "pr_opened" || event.prUrl || event.pullRequestUrl) return "pr";

  const name = basename(artifact);
  if (/^acceptance-checklist-/i.test(name)) return "acceptance-checklist";
  if (/^execution-map-/i.test(name)) return "execution-map";
  if (/^evidence-ledger-/i.test(name)) return "evidence-ledger";
  if (/^checklist-verdict-/i.test(name)) return "checklist-verdict";
  if (/^plan-/i.test(name)) return "plan";
  if (/^deliverable-/i.test(name)) return "deliverable";
  if (/^review-/i.test(name)) return "review";
  if (/^verdict-/i.test(name)) return "verdict";
  if (/^prompt-/i.test(name)) return "prompt";
  if (/^diff-/i.test(name) || /\.(?:patch|diff)$/i.test(name)) return "diff";
  if (/^tests-/i.test(name)) return "tests";
  if (/^risk-/i.test(name)) return "risk";
  if (/^pr-/i.test(name)) return "pr";

  if (event.phase === "plan") return "plan";
  if (event.phase === "execute") return "deliverable";
  if (event.phase === "review") return "review";
  if (event.phase === "verify") return "verdict";
  return "deliverable";
}

function artifactIdFor(artifact: string) {
  return withoutKnownExtension(basename(artifact));
}

function hasKnownExtension(fileName: string) {
  return /\.(?:md|patch|diff|txt|json)$/i.test(fileName);
}

function isInside(root: string, filePath: string) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function candidateArtifactPaths(cpbRoot: string, project: string, kind: string, artifact: string, wikiDir?: string | null) {
  if (path.isAbsolute(artifact)) {
    return hasKnownExtension(artifact) ? [artifact] : [artifact, `${artifact}.md`];
  }
  const dir = kind === "plan" ? inboxDir(cpbRoot, project, wikiDir) : outputsDir(cpbRoot, project, wikiDir);
  const direct = path.resolve(dir, artifact);
  return hasKnownExtension(artifact) ? [direct] : [direct, `${direct}.md`];
}

function blockedWikiReference(cpbRoot: string, project: string, kind: string, artifact: string, wikiDir: string | null | undefined, restrictToWiki: boolean) {
  if (!restrictToWiki) return null;
  const dir = kind === "plan" ? inboxDir(cpbRoot, project, wikiDir) : outputsDir(cpbRoot, project, wikiDir);
  if (path.isAbsolute(artifact)) {
    return {
      path: basename(artifact) || "artifact",
      reason: "artifact reference outside project wiki",
    };
  }
  const candidates = candidateArtifactPaths(cpbRoot, project, kind, artifact, wikiDir);
  if (candidates.some((candidate) => !isInside(dir, candidate))) {
    return {
      path: basename(artifact) || "artifact",
      reason: "artifact reference outside project wiki",
    };
  }
  return null;
}

async function resolveArtifactPath(cpbRoot: string, project: string, kind: string, artifact: string, wikiDir?: string | null) {
  const candidates = candidateArtifactPaths(cpbRoot, project, kind, artifact, wikiDir);
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {}
  }
  return candidates[0];
}

async function inspectArtifact(filePath: string): Promise<Record<string, any>> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      return { exists: false, broken: true, sha256: null, reason: "artifact path is not a file" };
    }
    const content = await readFile(filePath);
    return {
      exists: true,
      broken: false,
      sha256: createHash("sha256").update(content).digest("hex"),
      reason: null,
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { exists: false, broken: true, sha256: null, reason: "artifact file missing" };
    }
    return { exists: false, broken: true, sha256: null, reason: error.message || "artifact unreadable" };
  }
}

function artifactReferences(events: Record<string, any>[]) {
  const refs = [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (typeof event.artifact === "string" && event.artifact.length > 0) {
      refs.push({ event, artifact: event.artifact, kind: inferKind(event, event.artifact) });
    }
    if (typeof event.promptArtifact === "string" && event.promptArtifact.length > 0) {
      refs.push({ event, artifact: event.promptArtifact, kind: "prompt" });
    }
  }
  return refs;
}

export async function buildArtifactIndex(cpbRoot: string, project: string, jobId: string, { events, dataRoot, wikiDir, restrictToWiki = false }: Record<string, any> = {}) {
  const sourceEvents = events || await readEvents(cpbRoot, project, jobId, { dataRoot });
  const effectiveWikiDir = wikiDir || (dataRoot ? runtimeWikiDir(dataRoot) : undefined);
  const entries: Record<string, any>[] = [];
  const seen = new Set();

  const CHECKLIST_KINDS = new Set(["acceptance-checklist", "execution-map", "evidence-ledger", "checklist-verdict"]);
  let hasChecklistEntries = false;

  for (const ref of artifactReferences(sourceEvents)) {
    const { event, artifact, kind } = ref;
    const blocked = blockedWikiReference(cpbRoot, project, kind, artifact, effectiveWikiDir, restrictToWiki);
    if (blocked) {
      const key = `${kind}:${event.phase || ""}:${blocked.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        id: artifactIdFor(artifact),
        kind,
        phase: event.phase || null,
        path: blocked.path,
        sha256: null,
        createdAt: event.ts || null,
        producerAgent: event.agent || event.producerAgent || event.executor || null,
        exists: false,
        broken: true,
        reason: blocked.reason,
        eventType: event.type || null,
        attemptId: event.attemptId || null,
        artifactKind: event.artifactKind || kind,
      });
      continue;
    }

    const artifactPath = await resolveArtifactPath(cpbRoot, project, kind, artifact, effectiveWikiDir);
    const key = `${kind}:${event.phase || ""}:${artifactPath}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const inspected = await inspectArtifact(artifactPath);
    const isChecklist = CHECKLIST_KINDS.has(kind);
    if (isChecklist) hasChecklistEntries = true;
    entries.push({
      id: artifactIdFor(artifact),
      kind,
      phase: event.phase || null,
      path: artifactPath,
      sha256: inspected.sha256,
      createdAt: event.ts || null,
      producerAgent: event.agent || event.producerAgent || event.executor || null,
      exists: inspected.exists,
      broken: inspected.broken,
      reason: inspected.reason,
      eventType: event.type || null,
      attemptId: event.attemptId || null,
      artifactKind: event.artifactKind || kind,
    });
  }

  return {
    schemaVersion: hasChecklistEntries ? SCHEMA_VERSION_WITH_CHECKLIST : SCHEMA_VERSION,
    project,
    jobId,
    generatedAt: new Date().toISOString(),
    entries,
    brokenReferences: entries.filter((entry) => entry.broken),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// job-artifact-detail.ts (merged)
// ──────────────────────────────────────────────────────────────────────────────

function warningForBrokenArtifact(entry: Record<string, any>) {
  const name = entry.path ? entry.path.split(/[\\/]/).pop() : entry.id || entry.kind || "artifact";
  return {
    kind: entry.kind || "artifact",
    id: entry.id || null,
    path: entry.path || null,
    message: `Artifact ${name} is ${entry.reason || "unavailable"}.`,
  };
}

async function parseVerdictEntry(entry: Record<string, any> | null | undefined) {
  if (!entry || entry.broken || !entry.path) return null;
  try {
    const envelope: any = parseVerdictEnvelope(await readFile(entry.path, "utf8"));
    return {
      status: envelope.status,
      confidence: envelope.confidence ?? null,
      reason: envelope.reason || null,
      blockingCount: Array.isArray(envelope.blocking) ? envelope.blocking.length : 0,
      fixScope: Array.isArray(envelope.fix_scope) ? envelope.fix_scope : [],
      path: entry.path,
      artifactId: entry.id,
      source: envelope.source || null,
    };
  } catch (err) {
    return {
      status: "inconclusive",
      confidence: null,
      reason: `verdict unreadable: ${err.message}`,
      blockingCount: 0,
      fixScope: [],
      path: entry.path,
      artifactId: entry.id,
      source: "error",
    };
  }
}

export async function buildJobArtifactDetail(cpbRoot: string, project: string, jobId: string, { dataRoot, wikiDir }: { dataRoot?: string; wikiDir?: string } = {}) {
  const artifactIndex = await (buildArtifactIndex as any)(cpbRoot, project, jobId, { dataRoot, wikiDir });
  const verdictEntry = [...artifactIndex.entries].reverse().find((entry) => entry.kind === "verdict");
  const verdict = await parseVerdictEntry(verdictEntry);
  const warnings = artifactIndex.entries
    .filter((entry: Record<string, any>) => entry.broken)
    .map(warningForBrokenArtifact);

  return {
    project,
    jobId,
    artifactIndex,
    verdict,
    warnings,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// job-run-report.ts (merged)
// ──────────────────────────────────────────────────────────────────────────────

const STATUS_KEYS = ["running", "completed", "failed", "blocked", "cancelled", "unknown"];

function anomalyReason(job: Record<string, any>, jobIdSet: Set<string>) {
  if (job.status === "failed") return job.blockedReason || job.failureCode || "failed";
  if (job.status === "blocked") return job.blockedReason || "blocked";
  if (job.status === "cancelled") return job.cancelReason || "cancelled";
  const parentId = job.lineage?.parentJobId;
  if (parentId && !jobIdSet.has(parentId)) return `orphan recovery: parent ${parentId} not found`;
  if (parentId) return `recovery from ${parentId}`;
  return job.status;
}

function isAnomalous(job: Record<string, any>, jobIdSet: Set<string>) {
  if (["failed", "blocked", "cancelled"].includes(job.status)) return true;
  if (job.lineage?.parentJobId) return true;
  return false;
}

export async function buildJobRunReport({ cpbRoot, anomalyLimit = 10, hubRoot }: Record<string, any> = {}) {
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

  const jobs: Record<string, any>[] = [];
  for (const { project, jobId, file, dataRoot } of eventFiles) {
    const events = await readEventsReadOnly(cpbRoot, project, jobId, dataRoot ? { dataRoot } : {});
    if (!events || events.length === 0) continue;
    const job = materializeJob(events);
    if (!job.jobId || !job.project || !job.createdAt) continue;
    jobs.push({ ...job, eventLogPath: file });
  }

  const statusCounts: Record<string, number> = {};
  for (const key of STATUS_KEYS) statusCounts[key] = 0;
  for (const job of jobs) {
    const status = STATUS_KEYS.includes(job.status) ? job.status : "unknown";
    statusCounts[status]++;
  }

  const phaseMap: Record<string, Record<string, number>> = {};
  for (const job of jobs) {
    if (job.failurePhase && job.failureCode) {
      if (!phaseMap[job.failurePhase]) phaseMap[job.failurePhase] = {};
      phaseMap[job.failurePhase][job.failureCode] = (phaseMap[job.failurePhase][job.failureCode] || 0) + 1;
    }
  }
  const phaseFailureCounts = Object.keys(phaseMap).sort().map((phase) => ({
    phase,
    count: (Object.values(phaseMap[phase]) as number[]).reduce((a, b) => a + b, 0),
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

export function formatReportHuman(report: Record<string, any>) {
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

// ──────────────────────────────────────────────────────────────────────────────
// job-projection.ts (merged)
// ──────────────────────────────────────────────────────────────────────────────

const STATUS_MAP: Record<string, string> = {
  pending: "pending",
  running: "running",
  completed: "completed",
  failed: "failed",
  blocked: "blocked",
  cancelled: "cancelled",
};

const ACTIVE_NODE_STATUSES = new Set(["running", "retrying", "blocked"]);
const GITHUB_STATUS_COMMENT_STATUSES = new Set(["blocked", "failed", "passed", "pr-opened"]);

function orderedUnique(values: unknown[]) {
  return [...new Set(values.filter(Boolean))];
}

function projectDagNodes(job: Record<string, any>) {
  const nodeStates: Record<string, any> = job.nodeStates ?? {};
  const ids = orderedUnique([
    ...workflowNodeIds(job),
    ...Object.keys(nodeStates),
    ...((job.completedNodes ?? []) as string[]),
    ...((job.runningNodes ?? []) as string[]),
    ...((job.blockedNodes ?? []) as string[]),
  ]);

  return (ids as string[]).map((id) => {
    const node = nodeStates[id] ?? {};
    const definition = workflowNodeById(job, id);
    let status = node.status ?? "pending";
    if (!node.status) {
      if ((job.runningNodes ?? []).includes(id)) status = "running";
      else if ((job.completedNodes ?? []).includes(id)) status = "completed";
      else if ((job.blockedNodes ?? []).includes(id)) status = "blocked";
    }

    return {
      id,
      phase: node.phase ?? definition?.phase ?? id,
      status,
      attempt: node.attempt ?? null,
      artifact: node.artifact ?? null,
      reason: node.reason ?? null,
      error: node.error ?? null,
      startedAt: node.startedAt ?? null,
      completedAt: node.completedAt ?? null,
      failedAt: node.failedAt ?? null,
      retryingAt: node.retryingAt ?? null,
      skippedAt: node.skippedAt ?? null,
      cancelledAt: node.cancelledAt ?? null,
      blockedAt: node.blockedAt ?? null,
      durationMs: node.durationMs ?? null,
    };
  });
}

function workflowNodes(job: Record<string, any>): Record<string, any>[] {
  try {
    const dag = normalizeWorkflow(job.workflow);
    return dag?.nodes ?? [];
  } catch {
    return [];
  }
}

function workflowNodeIds(job: Record<string, any>) {
  return workflowNodes(job).map((node) => node.id).filter(Boolean);
}

function workflowNodeById(job: Record<string, any>, id: string) {
  return workflowNodes(job).find((node) => node.id === id) ?? null;
}

export function jobToPipelineState(job: Record<string, any>): Record<string, any> {
  const retryCount = retryCountForJob(job);
  return {
    project: job.project,
    task: job.task,
    jobId: job.jobId,
    phase: job.phase,
    status: STATUS_MAP[job.status] ?? job.status,
    retryCount,
    maxRetries: null,
    started: job.createdAt,
    updated: job.updatedAt,
    lastActivityAt: job.lastActivityAt ?? null,
    lastActivityMessage: job.lastActivityMessage ?? null,
    completedNodes: job.completedNodes ?? [],
    runningNodes: job.runningNodes ?? [],
    blockedNodes: job.blockedNodes ?? [],
    nodes: projectDagNodes(job),
    workflowDag: job.workflowDag ?? null,
    dagResume: job.dagResume ?? null,
    riskMap: job.riskMap ?? null,
    riskLevel: job.riskLevel ?? job.riskMap?.riskLevel ?? null,
    verificationDepth: job.verificationDepth ?? job.riskMap?.verificationDepth ?? null,
    adversarialRequired: job.adversarialRequired ?? job.riskMap?.adversarialRequired ?? false,
    dynamicAgentPlan: job.dynamicAgentPlan ?? null,
    adversarialVerdict: job.adversarialVerdict ?? null,
    completionGate: job.completionGate ?? null,
  };
}

function retryCountForJob(job: Record<string, any>) {
  const nodeAttempts = Object.values(job.nodeStates ?? {})
    .map((node) => {
      const entry = node as Record<string, any>;
      return Number.isFinite(entry?.attempt) ? Math.max(0, entry.attempt - 1) : 0;
    });
  return Math.max(job.retryCount ?? 0, job.attempt != null ? Math.max(0, job.attempt - 1) : 0, ...nodeAttempts);
}

function currentPhaseForJob(job: Record<string, any>) {
  const active = projectDagNodes(job).find((node) => ACTIVE_NODE_STATUSES.has(node.status));
  if (active?.phase) return active.phase;
  if (job.failurePhase) return job.failurePhase;
  if (job.phase && job.phase !== "completed") return job.phase;
  return null;
}

function sourceForJob(job: Record<string, any>): Record<string, any> {
  const source = (job.sourceContext || {}) as Record<string, any>;
  if (source.type === "github_issue" || source.issueNumber !== undefined) {
    return {
      type: "github_issue",
      label: source.issueNumber ? `GitHub issue #${source.issueNumber}` : "GitHub issue",
      issueNumber: source.issueNumber ?? null,
      repo: source.repo || source.repository || null,
      channel: null,
    };
  }
  if (source.type === "slack" || source.channel === "slack") {
    return {
      type: "slack",
      label: source.channelName ? `Slack ${source.channelName}` : "Slack",
      issueNumber: null,
      repo: null,
      channel: source.channelName || source.channelId || null,
    };
  }
  if (source.type === "discord" || source.channel === "discord") {
    return {
      type: "discord",
      label: source.channelName ? `Discord ${source.channelName}` : "Discord",
      issueNumber: null,
      repo: null,
      channel: source.channelName || source.channelId || null,
    };
  }
  if (source.type) {
    return {
      type: source.type,
      label: source.type.replace(/_/g, " "),
      issueNumber: null,
      repo: source.repo || null,
      channel: source.channelName || source.channelId || null,
    };
  }
  return { type: "manual", label: "Manual", issueNumber: null, repo: null, channel: null };
}

function queueStatusForJob(job: Record<string, any>) {
  if (job.pr?.url || job.pr?.number || job.artifacts?.pr) return "pr-opened";
  if (job.status === "completed") return "passed";
  return job.status || "queued";
}

function nextHumanActionForJob(job: Record<string, any>, status: string) {
  if (job.cancelRequested) {
    return { kind: "cancel", label: "Review cancellation request" };
  }
  if (job.redirectContext) {
    return { kind: "redirect", label: "Review redirect instructions" };
  }
  if (status === "queued") {
    return { kind: "start_worker", label: "Start a worker or wait for dispatcher" };
  }
  if (status === "blocked") {
    return { kind: "approval", label: "Review blocker or approval gate" };
  }
  if (status === "failed") {
    return { kind: "retry", label: "Review failure and retry or cancel" };
  }
  if (status === "passed") {
    return { kind: "review_patch", label: "Review verified patch" };
  }
  if (status === "pr-opened") {
    return { kind: "review_pr", label: "Review draft PR" };
  }
  return null;
}

export function jobToQueueRow(job: Record<string, any>) {
  const status = queueStatusForJob(job);
  const currentPhase = currentPhaseForJob(job);
  return {
    jobId: job.jobId,
    project: job.project,
    task: job.task,
    status,
    rawStatus: job.status || null,
    workflow: job.workflow || "standard",
    currentPhase,
    phase: currentPhase,
    retryCount: retryCountForJob(job),
    source: sourceForJob(job),
    nextHumanAction: nextHumanActionForJob(job, status),
    pr: job.pr || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    lastActivityAt: job.lastActivityAt ?? null,
    lastActivityMessage: job.lastActivityMessage ?? null,
    cancelRequested: job.cancelRequested ?? false,
    redirectContext: job.redirectContext ?? null,
    failureCode: job.failureCode ?? null,
    failurePhase: job.failurePhase ?? null,
    riskLevel: job.riskLevel ?? job.riskMap?.riskLevel ?? null,
    verificationDepth: job.verificationDepth ?? job.riskMap?.verificationDepth ?? null,
    adversarialRequired: job.adversarialRequired ?? job.riskMap?.adversarialRequired ?? false,
    completionGate: job.completionGate ?? null,
  };
}

export function githubStatusCommentDedupeKey(projection: Record<string, any> | null | undefined) {
  if (!projection?.jobId || !projection?.status) return null;
  const prMarker = projection.pr?.url || projection.pr?.number || "";
  return ["github-status", projection.jobId, projection.status, prMarker]
    .filter((part) => part !== null && part !== undefined && String(part).length > 0)
    .map((part) => String(part))
    .join(":");
}

export function jobToGithubStatusUpdate(job: Record<string, any>) {
  const row = jobToQueueRow(job || {});
  if (!GITHUB_STATUS_COMMENT_STATUSES.has(row.status)) return null;

  const source = (row.source || {}) as Record<string, any>;
  if (source.type !== "github_issue") return null;

  const repo = source.repo || job?.sourceContext?.repo || job?.sourceContext?.repository || null;
  const issueNumber = source.issueNumber ?? job?.sourceContext?.issueNumber ?? null;
  if (!repo || issueNumber === null || issueNumber === undefined) return null;

  const projection = {
    jobId: row.jobId,
    project: row.project,
    task: row.task,
    status: row.status,
    rawStatus: row.rawStatus,
    workflow: row.workflow,
    repo,
    issueNumber,
    pr: row.pr,
    retryCount: row.retryCount,
    reason: job?.blockedReason || job?.failureCause?.message || job?.failureCause || row.lastActivityMessage || null,
    failureCode: row.failureCode,
    failurePhase: row.failurePhase,
    updatedAt: row.updatedAt,
  };
  return {
    ...projection,
    dedupeKey: githubStatusCommentDedupeKey(projection),
  };
}

async function allJobs(cpbRoot: string, options: Record<string, any> = {}) {
  // Import from sibling job-store module
  const { listJobsAcrossRuntimeRoots } = await import("./job-store.js");
  return listJobsAcrossRuntimeRoots(cpbRoot, options);
}

export async function projectPipelineState(cpbRoot: string, project: string, options: Record<string, any> = {}) {
  const jobs: Record<string, any>[] = await allJobs(cpbRoot, options);
  const matching = jobs.filter((j: Record<string, any>) => j.project === project);
  if (matching.length === 0) return null;

  const running = matching.find((j) => j.status === "running");
  return jobToPipelineState(running ?? matching[0]);
}

export async function listProjectPipelineStates(cpbRoot: string, options: Record<string, any> = {}) {
  const jobs: Record<string, any>[] = await allJobs(cpbRoot, options);
  const byProject = new Map();
  for (const job of jobs) {
    const existing = byProject.get(job.project);
    if (!existing || (job.status === "running" && existing.status !== "running")) {
      byProject.set(job.project, job);
    }
  }
  const result: Record<string, any> = {};
  for (const [project, job] of byProject) {
    result[project] = jobToPipelineState(job);
  }
  return result;
}
