// Merged from: job-projection.ts, job-run-report.ts, job-artifact-detail.ts, artifact-index.ts

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { readEvents, readEventsReadOnly, listEventFiles, materializeJob } from "../event/event-store.js";
import { listRuntimeDataRoots } from "../runtime.js";
import { normalizeWorkflow } from "../../../core/workflow/definition.js";
import { parseVerdictEnvelope } from "../../../core/workflow/verdict.js";
import type { LooseRecord } from "../../../core/contracts/types.js";
import type { BrokerArtifactEntry, BrokerArtifactIndex } from "../../../shared/orchestrator/artifact-index.js";

type ProjectionRecord = LooseRecord & {
  id?: string;
  kind?: string;
  artifactKind?: string;
  type?: string;
  phase?: string | null;
  artifact?: unknown;
  promptArtifact?: unknown;
  prUrl?: string;
  pullRequestUrl?: string;
  agent?: string;
  producerAgent?: string;
  executor?: unknown;
  attemptId?: string;
  ts?: string;
  path?: string;
  sha256?: string | null;
  exists?: boolean;
  broken?: boolean;
  reason?: unknown;
  status?: string | null;
  blockedReason?: unknown;
  failureCode?: unknown;
  failurePhase?: unknown;
  cancelReason?: unknown;
  currentPhase?: string;
  createdAt?: string | number;
  updatedAt?: string | number;
  lastActivityAt?: unknown;
  lastActivityMessage?: unknown;
  completedNodes?: string[];
  runningNodes?: string[];
  blockedNodes?: string[];
  nodeStates?: Record<string, ProjectionRecord>;
  workflow?: string | null;
  workflowDag?: ProjectionRecord & { nodes?: ProjectionRecord[] };
  dagResume?: unknown;
  riskMap?: ProjectionRecord;
  riskLevel?: unknown;
  verificationDepth?: unknown;
  adversarialRequired?: boolean;
  phaseBudgetPolicy?: ProjectionRecord | null;
  evidenceRequirements?: unknown[];
  dynamicAgentPlan?: ProjectionRecord;
  adversarialVerdict?: ProjectionRecord;
  completionGate?: unknown;
  completionReport?: unknown;
  retryCount?: number;
  attempt?: unknown;
  project?: string;
  jobId?: string | null;
  task?: string | null;
  eventLogPath?: string;
  lineage?: ProjectionRecord & { parentJobId?: string };
  sourceContext?: ProjectionRecord | string | null;
  issueNumber?: number | string;
  repo?: string;
  repository?: string;
  channel?: string;
  channelName?: string;
  channelId?: string;
  cancelRequested?: boolean;
  redirectContext?: unknown;
  pr?: ProjectionRecord;
  artifacts?: ProjectionRecord;
  failureCause?: unknown;
  confidence?: unknown;
  blocking?: unknown[];
  fix_scope?: unknown[];
  source?: unknown;
  rawStatus?: string | null;
  nextHumanAction?: unknown;
  generatedAt?: unknown;
  totalJobs?: number;
  statusCounts?: Record<string, number>;
  phaseFailureCounts?: ProjectionRecord[];
  cancellationCount?: number;
  retryRecoveryCount?: number;
  recentAnomalousJobs?: ProjectionRecord[];
  byCode?: ProjectionRecord[];
  count?: number;
  code?: string;
  message?: unknown;
};

type ArtifactIndexOptions = {
  events?: unknown[];
  dataRoot?: string;
  wikiDir?: string;
  restrictToWiki?: boolean;
};

type BuildJobRunReportOptions = {
  cpbRoot?: string;
  anomalyLimit?: number;
  hubRoot?: string;
};

type ArtifactInspection = {
  exists: boolean;
  broken: boolean;
  sha256: string | null;
  reason: string | null;
};

function isRecord(value: unknown): value is ProjectionRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): ProjectionRecord {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasErrorCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

// ──────────────────────────────────────────────────────────────────────────────
// artifact-index.ts (merged)
// ──────────────────────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;
const SCHEMA_VERSION_WITH_CHECKLIST = 2;
const KNOWN_KINDS = new Set([
  "plan", "deliverable", "review", "verdict", "prompt", "diff", "tests", "risk", "pr",
  "acceptance-checklist", "execution-map", "evidence-ledger", "checklist-verdict",
  "candidate-artifact", "candidate-replay-bundle",
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

function inferKind(event: ProjectionRecord, artifact: string) {
  if (KNOWN_KINDS.has(event.kind)) return event.kind;
  if (KNOWN_KINDS.has(event.artifactKind)) return event.artifactKind;
  if (event.type === "pr_opened" || event.prUrl || event.pullRequestUrl) return "pr";

  const name = basename(artifact);
  if (/^acceptance-checklist-/i.test(name)) return "acceptance-checklist";
  if (/^execution-map-/i.test(name)) return "execution-map";
  if (/^evidence-ledger-/i.test(name)) return "evidence-ledger";
  if (/^checklist-verdict-/i.test(name)) return "checklist-verdict";
  if (/^candidate-replay-bundle-/i.test(name)) return "candidate-replay-bundle";
  if (/^candidate-artifact-/i.test(name)) return "candidate-artifact";
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

function artifactIndexString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function artifactIndexTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  return null;
}

function artifactProducer(event: ProjectionRecord): string | null {
  return artifactIndexString(event.agent)
    || artifactIndexString(event.producerAgent)
    || artifactIndexString(event.executor);
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

async function inspectArtifact(filePath: string): Promise<ArtifactInspection> {
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
    if (hasErrorCode(error, "ENOENT")) {
      return { exists: false, broken: true, sha256: null, reason: "artifact file missing" };
    }
    return { exists: false, broken: true, sha256: null, reason: errorMessage(error) || "artifact unreadable" };
  }
}

function artifactReferences(events: ProjectionRecord[]) {
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

export async function buildArtifactIndex(cpbRoot: string, project: string, jobId: string, { events, dataRoot, wikiDir, restrictToWiki = false }: ArtifactIndexOptions = {}): Promise<BrokerArtifactIndex> {
  const sourceEvents = (events || await readEvents(cpbRoot, project, jobId, { dataRoot })).filter(isRecord);
  const effectiveWikiDir = wikiDir || (dataRoot ? runtimeWikiDir(dataRoot) : undefined);
  const entries: BrokerArtifactEntry[] = [];
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
        phase: artifactIndexString(event.phase),
        path: blocked.path,
        sha256: null,
        createdAt: artifactIndexTimestamp(event.ts),
        producerAgent: artifactProducer(event),
        exists: false,
        broken: true,
        reason: blocked.reason,
        eventType: artifactIndexString(event.type),
        attemptId: artifactIndexString(event.attemptId),
        artifactKind: artifactIndexString(event.artifactKind) || kind,
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
      phase: artifactIndexString(event.phase),
      path: artifactPath,
      sha256: inspected.sha256,
      createdAt: artifactIndexTimestamp(event.ts),
      producerAgent: artifactProducer(event),
      exists: inspected.exists,
      broken: inspected.broken,
      reason: inspected.reason,
      eventType: artifactIndexString(event.type),
      attemptId: artifactIndexString(event.attemptId),
      artifactKind: artifactIndexString(event.artifactKind) || kind,
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

function warningForBrokenArtifact(entry: BrokerArtifactEntry) {
  const name = entry.path ? entry.path.split(/[\\/]/).pop() : entry.id || entry.kind || "artifact";
  return {
    kind: entry.kind || "artifact",
    id: entry.id || null,
    path: entry.path || null,
    message: `Artifact ${name} is ${entry.reason || "unavailable"}.`,
  };
}

async function parseVerdictEntry(entry: BrokerArtifactEntry | null | undefined) {
  if (!entry || entry.broken || !entry.path) return null;
  try {
    const parsed = parseVerdictEnvelope(await readFile(entry.path, "utf8"));
    const envelope: ProjectionRecord = isRecord(parsed) ? parsed : {};
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
      reason: `verdict unreadable: ${errorMessage(err)}`,
      blockingCount: 0,
      fixScope: [],
      path: entry.path,
      artifactId: entry.id,
      source: "error",
    };
  }
}

export async function buildJobArtifactDetail(cpbRoot: string, project: string, jobId: string, { dataRoot, wikiDir }: { dataRoot?: string; wikiDir?: string } = {}) {
  const artifactIndex = await buildArtifactIndex(cpbRoot, project, jobId, { dataRoot, wikiDir });
  const verdictEntry = [...artifactIndex.entries].reverse().find((entry) => entry.kind === "verdict");
  const verdict = await parseVerdictEntry(verdictEntry);
  const warnings = artifactIndex.entries
    .filter((entry) => entry.broken)
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

function anomalyReason(job: ProjectionRecord, jobIdSet: Set<string>) {
  if (job.status === "failed") return job.blockedReason || job.failureCode || "failed";
  if (job.status === "blocked") return job.blockedReason || "blocked";
  if (job.status === "cancelled") return job.cancelReason || "cancelled";
  const parentId = job.lineage?.parentJobId;
  if (parentId && !jobIdSet.has(parentId)) return `orphan recovery: parent ${parentId} not found`;
  if (parentId) return `recovery from ${parentId}`;
  return job.status;
}

function isAnomalous(job: ProjectionRecord, jobIdSet: Set<string>) {
  if (["failed", "blocked", "cancelled"].includes(job.status)) return true;
  if (job.lineage?.parentJobId) return true;
  return false;
}

function reportStringList(value: unknown, limit = 6): string[] {
  const list = Array.isArray(value) ? value : (stringValue(value) ? [value] : []);
  return [...new Set(list.map((entry) => stringValue(entry)).filter(Boolean))].slice(0, limit);
}

function reportRecord(value: unknown): ProjectionRecord {
  return isRecord(value) ? value : {};
}

function completionPanel(reportInput: unknown) {
  const report = reportRecord(reportInput);
  if (Object.keys(report).length === 0) return null;
  const residualRisk = reportRecord(report.residualRisk);
  const evidenceCounts = reportRecord(report.evidenceCounts);
  return {
    changedFiles: reportStringList(report.changedFiles, 8),
    changedFileCount: typeof report.changedFileCount === "number" ? report.changedFileCount : reportStringList(report.changedFiles, 100).length,
    realActors: reportStringList(report.realActors),
    realEntrypoints: reportStringList(report.realEntrypoints),
    bypassCandidates: reportStringList(report.bypassCandidates),
    evidenceClasses: reportStringList(report.evidenceClasses),
    evidenceOrigins: reportStringList(report.evidenceOrigins),
    commands: reportStringList(report.commands, 6),
    evidenceCounts: {
      passed: typeof evidenceCounts.passed === "number" ? evidenceCounts.passed : null,
      failed: typeof evidenceCounts.failed === "number" ? evidenceCounts.failed : null,
      total: typeof evidenceCounts.total === "number" ? evidenceCounts.total : null,
    },
    residualRisk: {
      riskLevel: residualRisk.riskLevel ?? null,
      adversarialRequired: residualRisk.adversarialRequired === true,
      notes: reportStringList(residualRisk.notes),
      failedOrUncheckedChecklist: reportStringList(residualRisk.failedOrUncheckedChecklist),
    },
  };
}

function phaseBudgetPanel(policyInput: unknown, evidenceRequirementsInput: unknown) {
  const policy = reportRecord(policyInput);
  const phases = reportRecord(policy.phases);
  if (Object.keys(policy).length === 0 && !Array.isArray(evidenceRequirementsInput)) return null;
  const phaseBudgets = Object.entries(phases)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([phase, value]) => {
      const budget = reportRecord(value);
      return {
        phase,
        toolCallBudget: typeof budget.toolCallBudget === "number" ? budget.toolCallBudget : null,
        toolEventBudget: typeof budget.toolEventBudget === "number" ? budget.toolEventBudget : null,
        idleTimeoutMs: typeof budget.idleTimeoutMs === "number" ? budget.idleTimeoutMs : null,
        noEditToolLimit: typeof budget.noEditToolLimit === "number" ? budget.noEditToolLimit : null,
        noEditIdleTimeoutMs: typeof budget.noEditIdleTimeoutMs === "number" ? budget.noEditIdleTimeoutMs : null,
      };
    });
  const evidenceRequirements = reportStringList(
    Array.isArray(evidenceRequirementsInput) && evidenceRequirementsInput.length > 0
      ? evidenceRequirementsInput
      : policy.evidenceRequirements,
    10,
  );
  return {
    riskLevel: policy.riskLevel ?? null,
    verificationDepth: policy.verificationDepth ?? null,
    adversarialRequired: policy.adversarialRequired === true,
    evidenceRequirements,
    phaseBudgets,
    reasons: reportStringList(policy.reasons, 8),
  };
}

function jobVisibilityPanel(job: ProjectionRecord) {
  const completion = completionPanel(job.completionReport);
  const runtimePolicy = phaseBudgetPanel(job.phaseBudgetPolicy, job.evidenceRequirements);
  if (!completion && !runtimePolicy) return null;
  return {
    project: job.project ?? null,
    jobId: job.jobId ?? null,
    status: job.status ?? null,
    updatedAt: job.updatedAt ?? null,
    completion,
    runtimePolicy,
  };
}

export async function buildJobRunReport({ cpbRoot, anomalyLimit = 10, hubRoot }: BuildJobRunReportOptions = {}) {
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

  const jobs: ProjectionRecord[] = [];
  for (const { project, jobId, file, dataRoot } of eventFiles) {
    const events = await readEventsReadOnly(cpbRoot, project, jobId, dataRoot ? { dataRoot } : {});
    if (!events || events.length === 0) continue;
    const job = recordValue(materializeJob(events));
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
      const failurePhase = String(job.failurePhase);
      const failureCode = String(job.failureCode);
      if (!phaseMap[failurePhase]) phaseMap[failurePhase] = {};
      phaseMap[failurePhase][failureCode] = (phaseMap[failurePhase][failureCode] || 0) + 1;
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
  const recentJobVisibilityPanels = jobs
    .map(jobVisibilityPanel)
    .filter((panel) => Boolean(panel))
    .map((panel) => recordValue(panel))
    .sort((a, b) => {
      const ta = a.updatedAt ? new Date(String(a.updatedAt)).getTime() : 0;
      const tb = b.updatedAt ? new Date(String(b.updatedAt)).getTime() : 0;
      return tb - ta;
    })
    .slice(0, anomalyLimit);

  return {
    command: "cpb jobs report",
    generatedAt: new Date().toISOString(),
    totalJobs: jobs.length,
    statusCounts,
    phaseFailureCounts,
    cancellationCount,
    retryRecoveryCount,
    recentAnomalousJobs,
    recentJobVisibilityPanels,
  };
}

export function formatReportHuman(reportInput: unknown) {
  const report: ProjectionRecord = isRecord(reportInput) ? reportInput : {};
  const statusCounts = isRecord(report.statusCounts) ? report.statusCounts : {};
  const phaseFailureCounts = Array.isArray(report.phaseFailureCounts) ? report.phaseFailureCounts : [];
  const recentAnomalousJobs = Array.isArray(report.recentAnomalousJobs) ? report.recentAnomalousJobs : [];
  const recentJobVisibilityPanels = Array.isArray(report.recentJobVisibilityPanels) ? report.recentJobVisibilityPanels : [];
  const lines = [];
  lines.push("Job run report");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Total jobs: ${report.totalJobs}`);
  lines.push("");
  lines.push("Status counts:");
  for (const [status, count] of Object.entries(statusCounts)) {
    lines.push(`  ${status}: ${count}`);
  }
  if (phaseFailureCounts.length > 0) {
    lines.push("");
    lines.push("Phase failures:");
    for (const pf of phaseFailureCounts) {
      lines.push(`  ${pf.phase}: ${pf.count}`);
      const byCode = Array.isArray(pf.byCode) ? pf.byCode : [];
      for (const bc of byCode) {
        lines.push(`    ${bc.code}: ${bc.count}`);
      }
    }
  }
  lines.push("");
  lines.push(`Cancellations: ${report.cancellationCount}`);
  lines.push(`Retry/recovery: ${report.retryRecoveryCount}`);
  if (recentAnomalousJobs.length > 0) {
    lines.push("");
    lines.push(`Recent anomalies (showing ${recentAnomalousJobs.length}):`);
    for (const a of recentAnomalousJobs) {
      lines.push(`  ${a.jobId} ${a.status} phase:${a.phase || "-"} ${a.reason}`);
    }
  }
  if (recentJobVisibilityPanels.length > 0) {
    lines.push("");
    lines.push(`Job visibility panels (showing ${recentJobVisibilityPanels.length}):`);
    for (const panelInput of recentJobVisibilityPanels) {
      const panel = reportRecord(panelInput);
      const completion = reportRecord(panel.completion);
      const runtimePolicy = reportRecord(panel.runtimePolicy);
      lines.push(`  ${panel.jobId || "-"} ${panel.status || "-"} project:${panel.project || "-"}`);
      if (Object.keys(completion).length > 0) {
        const evidenceCounts = reportRecord(completion.evidenceCounts);
        lines.push(`    completion changed:${completion.changedFileCount ?? 0} files:${reportStringList(completion.changedFiles, 4).join(", ") || "-"}`);
        lines.push(`    actors:${reportStringList(completion.realActors, 4).join(", ") || "-"} entrypoints:${reportStringList(completion.realEntrypoints, 4).join(", ") || "-"}`);
        lines.push(`    evidence:${reportStringList(completion.evidenceClasses, 4).join(", ") || "-"} commands:${reportStringList(completion.commands, 3).join(" | ") || "-"}`);
        lines.push(`    counts:${evidenceCounts.passed ?? "-"} passed/${evidenceCounts.failed ?? "-"} failed/${evidenceCounts.total ?? "-"} total`);
      }
      if (Object.keys(runtimePolicy).length > 0) {
        const phaseBudgets = Array.isArray(runtimePolicy.phaseBudgets) ? runtimePolicy.phaseBudgets : [];
        const budgetText = phaseBudgets
          .map((entry) => reportRecord(entry))
          .map((entry) => `${entry.phase}:${entry.toolCallBudget ?? "-"}/${entry.toolEventBudget ?? "-"}`)
          .join(", ");
        lines.push(`    policy risk:${runtimePolicy.riskLevel || "-"} depth:${runtimePolicy.verificationDepth || "-"} adversarial:${runtimePolicy.adversarialRequired === true ? "yes" : "no"}`);
        lines.push(`    requirements:${reportStringList(runtimePolicy.evidenceRequirements, 6).join(", ") || "-"} budgets:${budgetText || "-"}`);
      }
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

function projectDagNodes(job: ProjectionRecord) {
  const nodeStates: Record<string, ProjectionRecord> = job.nodeStates ?? {};
  // retain: dynamic job record — node id arrays come from materialized JSON events; assert shape.
  const ids = orderedUnique([
    ...workflowNodeIds(job),
    ...Object.keys(nodeStates),
    ...((job.completedNodes ?? []) as string[]),
    ...((job.runningNodes ?? []) as string[]),
    ...((job.blockedNodes ?? []) as string[]),
  ]);

  // retain: ids is unknown[] (from orderedUnique) but consumed as string keys into nodeStates.
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

function workflowNodes(job: ProjectionRecord): ProjectionRecord[] {
  try {
    const dag = normalizeWorkflow(job.workflow);
    return Array.isArray(dag?.nodes) ? dag.nodes.map(recordValue) : [];
  } catch {
    return [];
  }
}

function workflowNodeIds(job: ProjectionRecord) {
  return workflowNodes(job).map((node) => node.id).filter(Boolean);
}

function workflowNodeById(job: ProjectionRecord, id: string) {
  return workflowNodes(job).find((node) => node.id === id) ?? null;
}

export function jobToPipelineState(job: LooseRecord): ProjectionRecord {
  const projectionJob = recordValue(job);
  const retryCount = retryCountForJob(projectionJob);
  const riskMap = recordValue(projectionJob.riskMap);
  return {
    project: projectionJob.project,
    task: projectionJob.task,
    jobId: projectionJob.jobId,
    phase: projectionJob.phase,
    status: STATUS_MAP[projectionJob.status] ?? projectionJob.status,
    retryCount,
    maxRetries: null,
    started: projectionJob.createdAt,
    updated: projectionJob.updatedAt,
    lastActivityAt: projectionJob.lastActivityAt ?? null,
    lastActivityMessage: projectionJob.lastActivityMessage ?? null,
    completedNodes: projectionJob.completedNodes ?? [],
    runningNodes: projectionJob.runningNodes ?? [],
    blockedNodes: projectionJob.blockedNodes ?? [],
    nodes: projectDagNodes(projectionJob),
    workflowDag: projectionJob.workflowDag ?? null,
    dagResume: projectionJob.dagResume ?? null,
    riskMap: projectionJob.riskMap ?? null,
    riskLevel: projectionJob.riskLevel ?? riskMap.riskLevel ?? null,
    verificationDepth: projectionJob.verificationDepth ?? riskMap.verificationDepth ?? null,
    adversarialRequired: projectionJob.adversarialRequired ?? riskMap.adversarialRequired ?? false,
    phaseBudgetPolicy: projectionJob.phaseBudgetPolicy ?? null,
    evidenceRequirements: Array.isArray(projectionJob.evidenceRequirements) ? projectionJob.evidenceRequirements : [],
    dynamicAgentPlan: projectionJob.dynamicAgentPlan ?? null,
    adversarialVerdict: projectionJob.adversarialVerdict ?? null,
    completionGate: projectionJob.completionGate ?? null,
    completionReport: projectionJob.completionReport ?? null,
  };
}

function retryCountForJob(job: ProjectionRecord) {
  const nodeAttempts = Object.values(job.nodeStates ?? {})
    .map((node) => {
      const entry = isRecord(node) ? node : {};
      const attempt = Number(entry?.attempt);
      return Number.isFinite(attempt) ? Math.max(0, attempt - 1) : 0;
    });
  const jobAttempt = Number(job.attempt);
  return Math.max(job.retryCount ?? 0, Number.isFinite(jobAttempt) ? Math.max(0, jobAttempt - 1) : 0, ...nodeAttempts);
}

function currentPhaseForJob(job: ProjectionRecord) {
  const active = projectDagNodes(job).find((node) => ACTIVE_NODE_STATUSES.has(node.status));
  if (active?.phase) return String(active.phase);
  if (job.failurePhase) return String(job.failurePhase);
  if (job.phase && job.phase !== "completed") return String(job.phase);
  return null;
}

function sourceForJob(job: ProjectionRecord): ProjectionRecord {
  const source = recordValue(job.sourceContext);
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
    const sourceType = stringValue(source.type);
    return {
      type: sourceType,
      label: sourceType.replace(/_/g, " "),
      issueNumber: null,
      repo: source.repo || null,
      channel: source.channelName || source.channelId || null,
    };
  }
  return { type: "manual", label: "Manual", issueNumber: null, repo: null, channel: null };
}

function queueStatusForJob(job: ProjectionRecord) {
  if (job.pr?.url || job.pr?.number || job.artifacts?.pr) return "pr-opened";
  if (job.status === "completed") return "passed";
  return job.status || "queued";
}

function nextHumanActionForJob(job: ProjectionRecord, status: string) {
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

export function jobToQueueRow(value: unknown): ProjectionRecord {
  const job = recordValue(value);
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
    phaseBudgetPolicy: job.phaseBudgetPolicy ?? null,
    evidenceRequirements: Array.isArray(job.evidenceRequirements) ? job.evidenceRequirements : [],
    completionGate: job.completionGate ?? null,
    completionReport: job.completionReport ?? null,
  };
}

export function githubStatusCommentDedupeKey(projection: ProjectionRecord | null | undefined) {
  if (!projection?.jobId || !projection?.status) return null;
  const prMarker = projection.pr?.url || projection.pr?.number || "";
  return ["github-status", projection.jobId, projection.status, prMarker]
    .filter((part) => part !== null && part !== undefined && String(part).length > 0)
    .map((part) => String(part))
    .join(":");
}

export function jobToGithubStatusUpdate(job: ProjectionRecord) {
  const row = jobToQueueRow(job || {});
  const rowStatus = String(row.status || "");
  if (!GITHUB_STATUS_COMMENT_STATUSES.has(rowStatus)) return null;

  const source = isRecord(row.source) ? row.source : {};
  if (source.type !== "github_issue") return null;

  const sourceContext = recordValue(job?.sourceContext);
  const repo = source.repo || sourceContext.repo || sourceContext.repository || null;
  const issueNumber = source.issueNumber ?? sourceContext.issueNumber ?? null;
  if (!repo || issueNumber === null || issueNumber === undefined) return null;

  const failureCause = isRecord(job?.failureCause) ? job.failureCause : null;
  const projection: ProjectionRecord = {
    jobId: row.jobId,
    project: row.project,
    task: row.task,
    status: rowStatus,
    rawStatus: row.rawStatus,
    workflow: row.workflow,
    repo,
    issueNumber,
    pr: row.pr,
    retryCount: row.retryCount,
    reason: stringValue(job?.blockedReason || failureCause?.message || job?.failureCause || row.lastActivityMessage) || null,
    failureCode: row.failureCode,
    failurePhase: row.failurePhase,
    updatedAt: row.updatedAt,
  };
  return {
    ...projection,
    dedupeKey: githubStatusCommentDedupeKey(projection),
  };
}

async function allJobs(cpbRoot: string, options: ProjectionRecord = {}) {
  // Import from sibling job-store module
  const { listJobsAcrossRuntimeRoots } = await import("./job-store.js");
  const jobs: unknown[] = await listJobsAcrossRuntimeRoots(cpbRoot, options);
  return jobs.map(recordValue);
}

export async function projectPipelineState(cpbRoot: string, project: string, options: ProjectionRecord = {}) {
  const jobs: ProjectionRecord[] = await allJobs(cpbRoot, options);
  const matching = jobs.filter((j: ProjectionRecord) => j.project === project);
  if (matching.length === 0) return null;

  const running = matching.find((j) => j.status === "running");
  return jobToPipelineState(running ?? matching[0]);
}

export async function listProjectPipelineStates(cpbRoot: string, options: ProjectionRecord = {}) {
  const jobs: ProjectionRecord[] = await allJobs(cpbRoot, options);
  const byProject = new Map();
  for (const job of jobs) {
    const existing = byProject.get(job.project);
    if (!existing || (job.status === "running" && existing.status !== "running")) {
      byProject.set(job.project, job);
    }
  }
  const result: ProjectionRecord = {};
  for (const [project, job] of byProject) {
    result[project] = jobToPipelineState(job);
  }
  return result;
}
