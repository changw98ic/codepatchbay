// ── dispatch-state ──
import { appendFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { buildMeta } from "../../../core/job/meta.js";
import { listJobs } from "../job/job-store.js";


function nowIso() {
  return new Date().toISOString();
}

function dispatchDir(hubRoot: string) {
  return path.join(path.resolve(hubRoot), "dispatches");
}

function dispatchFile(hubRoot: string, dispatchId: string) {
  if (!/^dispatch-[A-Za-z0-9-]+$/.test(dispatchId)) {
    throw new Error(`invalid dispatchId: ${dispatchId}`);
  }
  return path.join(dispatchDir(hubRoot), `${dispatchId}.jsonl`);
}

const DISPATCH_LOCK_TTL_MS = 30_000;

export function makeDispatchId(ts = nowIso(), suffix = randomBytes(3).toString("hex")) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) throw new Error("invalid timestamp");
  const compact = date.toISOString().replace(/[-:]/g, "");
  return `dispatch-${compact.slice(0, 8)}-${compact.slice(9, 15)}-${suffix}`;
}

const mutationChains = new Map<string, Promise<unknown>>();

async function withDispatchFileLock(hubRoot: string, dispatchId: string, fn: () => Promise<unknown>) {
  const file = dispatchFile(hubRoot, dispatchId);
  const lockDir = `${file}.lock`;
  await mkdir(path.dirname(lockDir), { recursive: true });

  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(lockDir);
      acquired = true;
      break;
    } catch (err) {
      if (!err || (err as AnyRecord).code !== "EEXIST") throw err;
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs >= DISPATCH_LOCK_TTL_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // The lock disappeared between mkdir and stat; retry.
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  if (!acquired) throw new Error(`dispatch lock busy: ${path.basename(file)}`);

  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

function serialized(hubRoot: string, dispatchId: string, fn: () => Promise<unknown>) {
  const key = `${path.resolve(hubRoot)}:${dispatchId}`;
  const prev = mutationChains.get(key) || Promise.resolve();
  const next = prev.then(() => fn());
  mutationChains.set(key, next.catch(() => {}));
  const cleanup = () => {
    if (mutationChains.get(key) === next) mutationChains.delete(key);
  };
  next.then(cleanup, cleanup);
  return next;
}

const TERMINAL_STATUSES = new Set(["completed", "failed"]);

const LEGAL_TRANSITIONS = {
  created:   ["pending", "assigned", "running"],
  pending:   ["assigned", "running"],
  assigned:  ["running"],
  running:   ["completed", "failed"],
  completed: [],
  failed:    [],
};

function eventTypeToStatus(eventType: string) {
  switch (eventType) {
    case "dispatch_created":         return "pending";
    case "dispatch_worker_assigned": return "assigned";
    case "dispatch_started":         return "running";
    case "dispatch_completed":       return "completed";
    case "dispatch_failed":          return "failed";
    default: return null;
  }
}

function validateTransition(currentStatus: string | null, eventType: string) {
  const targetStatus = eventTypeToStatus(eventType);
  if (targetStatus === null) return;

  if (eventType === "dispatch_created") {
    if (currentStatus !== null) {
      throw new Error(`invalid transition: dispatch_created on existing dispatch (status: ${currentStatus})`);
    }
    return;
  }

  if (currentStatus === null) {
    throw new Error(`invalid transition: ${eventType} on non-existent dispatch`);
  }

  if (TERMINAL_STATUSES.has(currentStatus)) {
    throw new Error(`invalid transition: dispatch is ${currentStatus} (terminal)`);
  }

  const allowed = (LEGAL_TRANSITIONS as AnyRecord)[currentStatus];
  if (!allowed || !allowed.includes(targetStatus)) {
    throw new Error(`invalid transition: ${currentStatus} -> ${targetStatus} (via ${eventType})`);
  }
}

async function appendDispatchEvent(hubRoot: string, dispatchId: string, event: AnyRecord) {
  return serialized(hubRoot, dispatchId, () => withDispatchFileLock(hubRoot, dispatchId, async () => {
    const file = dispatchFile(hubRoot, dispatchId);
    const existing = await readDispatchEvents(hubRoot, dispatchId);
    const currentState = existing.length > 0 ? materializeDispatch(existing).status : null;

    validateTransition(currentState, event.type);

    await mkdir(path.dirname(file), { recursive: true });
    const line = JSON.stringify(event);
    await appendFile(file, `${line}\n`, "utf8");
    return event;
  }));
}

async function readDispatchEvents(hubRoot: string, dispatchId: string): Promise<AnyRecord[]> {
  const file = dispatchFile(hubRoot, dispatchId);
  try {
    const raw = await readFile(file, "utf8");
    return raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch (err) {
    if ((err as AnyRecord).code === "ENOENT") return [];
    throw err;
  }
}

export function materializeDispatch(events: AnyRecord[]) {
  const state: AnyRecord = {
    dispatchId: null,
    projectId: null,
    sourcePath: null,
    sessionId: null,
    workerId: null,
    cwd: null,
    queueEntryId: null,
    status: null,
    createdAt: null,
    updatedAt: null,
  };

  let terminal = false;

  for (const event of events) {
    if (terminal) continue;

    if (event.dispatchId !== undefined) state.dispatchId = event.dispatchId;
    if (event.projectId !== undefined) state.projectId = event.projectId;
    if (event.sourcePath !== undefined) state.sourcePath = event.sourcePath;
    if (event.sessionId !== undefined) state.sessionId = event.sessionId;
    if (event.cwd !== undefined) state.cwd = event.cwd;
    if (event.ts !== undefined) state.updatedAt = event.ts;

    switch (event.type) {
      case "dispatch_created":
        state.queueEntryId = event.queueEntryId ?? null;
        state.workerId = event.workerId ?? null;
        state.status = "pending";
        state.createdAt = event.ts ?? state.createdAt;
        break;
      case "dispatch_worker_assigned":
        state.workerId = event.workerId ?? null;
        state.status = "assigned";
        break;
      case "dispatch_started":
        state.status = "running";
        break;
      case "dispatch_completed":
        state.status = "completed";
        terminal = true;
        break;
      case "dispatch_failed":
        state.status = "failed";
        terminal = true;
        break;
    }
  }

  return state;
}

export async function createDispatch(hubRoot: string, { projectId, sourcePath, sessionId, workerId, queueEntryId, ts = nowIso() }: AnyRecord = {}) {
  if (!projectId) throw new Error("projectId is required");
  const meta = buildMeta({ projectId, sourcePath, sessionId, workerId });
  const dispatchId = makeDispatchId(ts);
  await appendDispatchEvent(hubRoot, dispatchId, {
    type: "dispatch_created",
    dispatchId,
    projectId,
    sourcePath: meta.sourcePath,
    sessionId: meta.sessionId,
    workerId: meta.workerId,
    cwd: meta.cwd,
    queueEntryId: queueEntryId || null,
    ts,
  });
  return getDispatch(hubRoot, dispatchId);
}

export async function getDispatch(hubRoot: string, dispatchId: string) {
  const events = await readDispatchEvents(hubRoot, dispatchId);
  if (events.length === 0) return null;
  return materializeDispatch(events);
}

export async function assignWorker(hubRoot: string, dispatchId: string, { workerId, ts = nowIso() }: AnyRecord = {}) {
  if (!workerId) throw new Error("workerId is required");
  await appendDispatchEvent(hubRoot, dispatchId, {
    type: "dispatch_worker_assigned",
    dispatchId,
    workerId,
    ts,
  });
  return getDispatch(hubRoot, dispatchId);
}

export async function startDispatch(hubRoot: string, dispatchId: string, { ts = nowIso() }: AnyRecord = {}) {
  await appendDispatchEvent(hubRoot, dispatchId, {
    type: "dispatch_started",
    dispatchId,
    ts,
  });
  return getDispatch(hubRoot, dispatchId);
}

export async function completeDispatch(hubRoot: string, dispatchId: string, { ts = nowIso() }: AnyRecord = {}) {
  await appendDispatchEvent(hubRoot, dispatchId, {
    type: "dispatch_completed",
    dispatchId,
    ts,
  });
  return getDispatch(hubRoot, dispatchId);
}

export async function failDispatch(hubRoot: string, dispatchId: string, { ts = nowIso() }: AnyRecord = {}) {
  await appendDispatchEvent(hubRoot, dispatchId, {
    type: "dispatch_failed",
    dispatchId,
    ts,
  });
  return getDispatch(hubRoot, dispatchId);
}

export async function listDispatches(hubRoot: string, { projectId, status }: AnyRecord = {}) {
  const dir = dispatchDir(hubRoot);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as AnyRecord).code === "ENOENT") return [];
    throw err;
  }

  const results = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const dispatchId = entry.name.slice(0, -".jsonl".length);
    if (!/^dispatch-[A-Za-z0-9-]+$/.test(dispatchId)) continue;
    const events = await readDispatchEvents(hubRoot, dispatchId);
    if (events.length === 0) continue;
    const state = materializeDispatch(events);
    if (projectId && state.projectId !== projectId) continue;
    if (status && state.status !== status) continue;
    results.push(state);
  }

  return results.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
}

export async function deleteDispatchFile(hubRoot: string, dispatchId: string) {
  const file = dispatchFile(hubRoot, dispatchId);
  await rm(file, { force: true });
}

// ── worker-dispatch ──
import { realpath } from "node:fs/promises";
import { AnyRecord } from "../../../shared/types.js";
import { getProject } from "../hub/hub-registry.js";

function dispatchEnabled() {
  return process.env.CPB_WORKER_DISPATCH_ENABLED === "1";
}

export { dispatchEnabled };

export async function guardSourcePath(hubRoot: string, projectId: string, sourcePath?: string) {
  if (!dispatchEnabled()) return;
  if (!sourcePath) throw new Error("sourcePath is required for Hub-dispatched mutations");

  const project = await getProject(hubRoot, projectId);
  if (!project) throw new Error(`project not found: ${projectId}`);
  if (!project.sourcePath) return;

  const registeredCanonical = await realpath(path.resolve(project.sourcePath));
  const providedCanonical = await realpath(path.resolve(sourcePath));

  if (registeredCanonical !== providedCanonical) {
    throw new Error(
      `sourcePath mismatch: project '${projectId}' registered at ${registeredCanonical}, got ${providedCanonical}`
    );
  }
}

export async function recordDispatch(hubRoot: string, { projectId, sourcePath, sessionId, workerId, queueEntryId }: Record<string, any> = {}) {
  if (!dispatchEnabled()) return null;
  return createDispatch(hubRoot, { projectId, sourcePath, sessionId, workerId, queueEntryId });
}

export async function lookupDispatch(hubRoot: string, dispatchId: string) {
  return getDispatch(hubRoot, dispatchId);
}

export async function markDispatchAssigned(hubRoot: string, dispatchId: string, { workerId }: { workerId?: string } = {}) {
  if (!dispatchEnabled()) return null;
  return assignWorker(hubRoot, dispatchId, { workerId });
}

export async function markDispatchStarted(hubRoot: string, dispatchId: string) {
  if (!dispatchEnabled()) return null;
  return startDispatch(hubRoot, dispatchId);
}

export async function markDispatchCompleted(hubRoot: string, dispatchId: string) {
  if (!dispatchEnabled()) return null;
  return completeDispatch(hubRoot, dispatchId);
}

export async function markDispatchFailed(hubRoot: string, dispatchId: string) {
  if (!dispatchEnabled()) return null;
  return failDispatch(hubRoot, dispatchId);
}

// ── task-ledger ──
import { readGithubIssues } from "../github/github-issues.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit: unknown) {
  const parsed = Number.parseInt(String(limit), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function timestampOf(task: Record<string, any>) {
  return task.updatedAt || task.createdAt || "";
}

function statusRank(status: string) {
  const ranks = {
    running: 0,
    ready: 1,
    open: 2,
    failed: 3,
    archived: 4,
    cancelled: 5,
    done: 6,
    closed: 7,
  };
  return ranks[status] ?? 8;
}

function priorityRank(priority: string) {
  if (priority === "P0") return 0;
  if (priority === "P1") return 1;
  if (priority === "P2") return 2;
  if (priority === "P3") return 3;
  return 4;
}

function firstLine(value: unknown, fallback = "") {
  const line = String(value || "").split("\n").find((part) => part.trim());
  return line ? line.trim() : fallback;
}

function truncate(value: unknown, max = 180) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function normalizeLabels(labels: unknown) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter(Boolean);
}

function issueKeyFn(issue: Record<string, any>) {
  const repo = issue.repository || issue.repo || issue.repositoryFullName || "github";
  return `github:${repo}#${issue.number}`;
}

function queueIssueKey(entry: Record<string, any>) {
  const metadata = entry.metadata || {};
  if (!metadata.issueNumber) return null;
  const repo = metadata.repo || metadata.repository || metadata.repositoryFullName || "github";
  return `github:${repo}#${metadata.issueNumber}`;
}

function isClosedIssue(issue: Record<string, any>) {
  return String(issue?.state || "").toUpperCase() === "CLOSED";
}

function isTerminalQueueEntry(entry: Record<string, any>) {
  return ["completed", "failed", "cancelled"].includes(entry?.status);
}

function isArchivedQueueEntry(entry: Record<string, any>) {
  return Boolean(entry?.metadata?.finalDisposition?.startsWith("superseded"));
}

function queueActivityRank(entry: Record<string, any>) {
  if (entry?.status === "in_progress") return 0;
  if (entry?.status === "pending") return 1;
  if (entry?.status === "needs_issue_link") return 2;
  return 3;
}

function selectQueueEntry(entries: Record<string, any>[] = []) {
  return [...entries].sort(
    (a, b) =>
      queueActivityRank(a) - queueActivityRank(b)
      || timestampOf(b).localeCompare(timestampOf(a)),
  )[0] || null;
}

function queueTitle(entry: Record<string, any>) {
  const metadata = entry.metadata || {};
  return firstLine(metadata.issueTitle || entry.description, entry.id);
}

function queueSource(entry: Record<string, any>) {
  const metadata = entry.metadata || {};
  if (metadata.issueNumber || metadata.issueUrl) {
    return {
      kind: "github",
      label: metadata.issueNumber ? `GitHub issue #${metadata.issueNumber}` : "GitHub issue",
      url: metadata.issueUrl || null,
      issueNumber: metadata.issueNumber || null,
      repo: metadata.repo || metadata.repository || null,
    };
  }
  return {
    kind: "hub-queue",
    label: "Hub queue",
    url: null,
    queueEntryId: entry.id,
  };
}

function issueSource(issue: Record<string, any>) {
  return {
    kind: "github",
    label: `GitHub issue #${issue.number}`,
    url: issue.url || null,
    issueNumber: issue.number,
    repo: issue.repository || issue.repo || issue.repositoryFullName || null,
  };
}

function bodySummary(body: unknown, fallback: string) {
  const goalMatch = String(body || "").match(/##\s+Goal\s+([\s\S]*?)(?:\n##\s+|$)/i);
  const content = goalMatch ? goalMatch[1] : body;
  return truncate(firstLine(content, fallback), 220);
}

function progressFor({ queueEntry, issue }: Record<string, any> = {}) {
  const finalDisposition = queueEntry?.metadata?.finalDisposition || null;
  if (finalDisposition?.startsWith("superseded")) {
    return {
      stage: "archived",
      label: "Archived",
      detail: finalDisposition,
      percent: 100,
    };
  }

  if (issue?.state === "CLOSED" || issue?.state === "closed") {
    return { stage: "closed", label: "Closed", detail: "Closed in GitHub", percent: 100 };
  }

  if (queueEntry?.status === "pending") {
    return { stage: "ready", label: "Ready to run", detail: "Queued in Hub", percent: 10 };
  }
  if (queueEntry?.status === "needs_issue_link") {
    return { stage: "open", label: "Needs issue link", detail: "Awaiting GitHub issue metadata", percent: 0 };
  }
  if (queueEntry?.status === "in_progress") {
    return { stage: "running", label: "Running", detail: "Claimed by worker", percent: 50 };
  }
  if (queueEntry?.status === "completed") {
    return { stage: "done", label: "Done", detail: "Queue item completed", percent: 100 };
  }
  if (queueEntry?.status === "failed") {
    return { stage: "failed", label: "Failed", detail: "Queue item failed", percent: 100 };
  }
  if (queueEntry?.status === "cancelled") {
    return { stage: "cancelled", label: "Cancelled", detail: "Queue item cancelled", percent: 100 };
  }

  return { stage: "open", label: "Open, not queued", detail: "Known from source ledger only", percent: 0 };
}

function humanNextAction(progress: Record<string, any>, queueEntry: Record<string, any>) {
  if (progress.stage === "ready") return "Start a CPB worker or let the queue dispatcher pick it up.";
  if (progress.label === "Needs issue link") return "Link a GitHub issue to this task before it can be claimed for execution.";
  if (progress.stage === "open") return "Import or queue this issue before expecting CPB to execute it.";
  if (progress.stage === "failed") return "Inspect the latest run evidence, then create a fresh recovery task if still needed.";
  if (progress.stage === "archived") return "Do not retry this item directly; follow the replacement task links.";
  if (progress.stage === "running") return "Watch the current worker and run evidence.";
  if (progress.stage === "done" && queueEntry?.metadata?.finalDisposition) return "No action; this item has a final disposition.";
  if (progress.stage === "done" || progress.stage === "closed") return "No action needed unless follow-up acceptance gaps remain.";
  return "Review task details and choose the next execution path.";
}

function evidenceFor({ queueEntry, jobs = [], dispatches = [] }) {
  const evidence = [];
  const queueEntries = Array.isArray(queueEntry) ? queueEntry : [queueEntry].filter(Boolean);
  for (const entry of queueEntries.slice(0, 10)) {
    evidence.push({
      kind: "queue",
      id: entry.id,
      status: entry.status,
      updatedAt: entry.updatedAt || entry.createdAt || null,
    });
  }
  for (const dispatch of dispatches.slice(0, 5)) {
    evidence.push({
      kind: "dispatch",
      id: dispatch.dispatchId,
      status: dispatch.status,
      updatedAt: dispatch.updatedAt || dispatch.createdAt || null,
      workerId: dispatch.workerId || null,
    });
  }
  for (const job of jobs.slice(0, 5)) {
    evidence.push({
      kind: "job",
      id: job.jobId,
      status: job.status,
      phase: job.phase || null,
      updatedAt: job.updatedAt || job.createdAt || null,
      reason: job.blockedReason || job.failureCause || null,
    });
  }
  return evidence;
}

function matchingJobs(queueEntries: Record<string, any> | Record<string, any>[], jobs: Record<string, any>[]) {
  const entries = Array.isArray(queueEntries) ? queueEntries : [queueEntries].filter(Boolean);
  if (entries.length === 0) return [];
  const descriptions = new Set(entries.map((entry) => entry.description || ""));
  const projects = new Set(entries.map((entry) => entry.projectId));
  return jobs
    .filter((job: Record<string, any>) => projects.has(job.project) && descriptions.has(job.task))
    .sort((a: Record<string, any>, b: Record<string, any>) => timestampOf(b).localeCompare(timestampOf(a)));
}

function matchingDispatches(queueEntries: Record<string, any> | Record<string, any>[], dispatches: Record<string, any>[]) {
  const entries = Array.isArray(queueEntries) ? queueEntries : [queueEntries].filter(Boolean);
  if (entries.length === 0) return [];
  const entryIds = new Set(entries.map((entry) => entry.id));
  return dispatches
    .filter((dispatch: Record<string, any>) => entryIds.has(dispatch.queueEntryId))
    .sort((a: Record<string, any>, b: Record<string, any>) => timestampOf(b).localeCompare(timestampOf(a)));
}

function issueTask(issue: Record<string, any>, { queueEntry, queueEntries = [], jobs, dispatches }: { queueEntry: Record<string, any>; queueEntries?: Record<string, any>[]; jobs: Record<string, any>[]; dispatches: Record<string, any>[] }) {
  const labels = normalizeLabels(issue.labels);
  const progress = progressFor({ queueEntry, issue });
  const source = issueSource(issue);
  const title = issue.title || queueTitle(queueEntry) || `Issue #${issue.number}`;
  const body = issue.body || "";
  const linkedEntries = queueEntries.length > 0 ? queueEntries : [queueEntry].filter(Boolean);
  const jobsForEntry = matchingJobs(linkedEntries, jobs);
  const dispatchesForEntry = matchingDispatches(linkedEntries, dispatches);
  const latestJob = jobsForEntry[0] || null;
  const latestDispatch = dispatchesForEntry[0] || null;
  const evidence = evidenceFor({
    queueEntry: linkedEntries,
    jobs: jobsForEntry,
    dispatches: dispatchesForEntry,
  });

  return {
    id: issueKeyFn(issue),
    title,
    projectId: queueEntry?.projectId || issue.projectId || "flow",
    priority: queueEntry?.priority || labels.find((label) => /^P[0-3]$/i.test(label)) || null,
    status: progress.stage,
    progress,
    source,
    labels,
    createdAt: issue.createdAt || queueEntry?.createdAt || null,
    updatedAt: issue.updatedAt || queueEntry?.updatedAt || issue.createdAt || null,
    human: {
      summary: bodySummary(body, title),
      progress: `${progress.label}${progress.detail ? ` · ${progress.detail}` : ""}`,
      source: source.label,
      nextAction: humanNextAction(progress, queueEntry),
      description: truncate(body || queueEntry?.description || title, 900),
    },
    agent: {
      objective: body || queueEntry?.description || title,
      status: {
        stage: progress.stage,
        queueStatus: queueEntry?.status || null,
        githubState: issue.state || null,
        finalDisposition: queueEntry?.metadata?.finalDisposition || null,
      },
      source: {
        kind: source.kind,
        url: source.url,
        repo: source.repo,
        issueNumber: issue.number,
      },
      execution: {
        queueEntryId: queueEntry?.id || null,
        projectId: queueEntry?.projectId || null,
        priority: queueEntry?.priority || null,
        executionBoundary: queueEntry?.executionBoundary || null,
        supersedesQueueEntryId: queueEntry?.metadata?.supersedesQueueEntryId || null,
        supersededByIssues: queueEntry?.metadata?.supersededByIssues || [],
        workerId: queueEntry?.workerId || latestDispatch?.workerId || null,
        jobId: latestJob?.jobId || null,
        dispatchId: latestDispatch?.dispatchId || null,
        executor: latestJob?.executor || null,
        releaseSnapshot: queueEntry?.metadata?.releaseSnapshot || null,
        indexSnapshot: queueEntry?.metadata?.indexSnapshot || null,
        acpProfile: queueEntry?.metadata?.acpProfile || "headless",
        uiLane: Boolean(queueEntry?.metadata?.uiLane),
        uiLaneReason: queueEntry?.metadata?.uiLaneReason || "",
      },
      evidence,
    },
  };
}

function queueTask(entry: Record<string, any>, { jobs, dispatches }: { jobs: Record<string, any>[]; dispatches: Record<string, any>[] }) {
  const progress = progressFor({ queueEntry: entry });
  const source = queueSource(entry);
  const title = queueTitle(entry);
  const jobsForEntry = matchingJobs(entry, jobs);
  const dispatchesForEntry = matchingDispatches(entry, dispatches);
  const latestJob = jobsForEntry[0] || null;
  const latestDispatch = dispatchesForEntry[0] || null;
  const evidence = evidenceFor({
    queueEntry: entry,
    jobs: jobsForEntry,
    dispatches: dispatchesForEntry,
  });

  return {
    id: `queue:${entry.id}`,
    title,
    projectId: entry.projectId || null,
    priority: entry.priority || null,
    status: progress.stage,
    progress,
    source,
    labels: [],
    createdAt: entry.createdAt || null,
    updatedAt: entry.updatedAt || entry.createdAt || null,
    human: {
      summary: title,
      progress: `${progress.label}${progress.detail ? ` · ${progress.detail}` : ""}`,
      source: source.label,
      nextAction: humanNextAction(progress, entry),
      description: truncate(entry.description || title, 900),
    },
    agent: {
      objective: entry.description || title,
      status: {
        stage: progress.stage,
        queueStatus: entry.status || null,
        finalDisposition: entry.metadata?.finalDisposition || null,
      },
      source,
      execution: {
        queueEntryId: entry.id,
        projectId: entry.projectId || null,
        priority: entry.priority || null,
        executionBoundary: entry.executionBoundary || null,
        supersedesQueueEntryId: entry.metadata?.supersedesQueueEntryId || null,
        supersededByIssues: entry.metadata?.supersededByIssues || [],
        workerId: entry.workerId || latestDispatch?.workerId || null,
        jobId: latestJob?.jobId || null,
        dispatchId: latestDispatch?.dispatchId || null,
        executor: latestJob?.executor || null,
        releaseSnapshot: entry.metadata?.releaseSnapshot || null,
        indexSnapshot: entry.metadata?.indexSnapshot || null,
        acpProfile: entry.metadata?.acpProfile || "headless",
        uiLane: Boolean(entry.metadata?.uiLane),
        uiLaneReason: entry.metadata?.uiLaneReason || "",
      },
      evidence,
    },
  };
}

function summarize(tasks: Record<string, any>[]) {
  const summary = {
    total: tasks.length,
    ready: 0,
    running: 0,
    open: 0,
    done: 0,
    failed: 0,
    archived: 0,
    closed: 0,
    bySource: {},
  };
  for (const task of tasks) {
    if (summary[task.status] !== undefined) summary[task.status] += 1;
    else summary[task.status] = 1;
    const sourceKind = task.source?.kind || "unknown";
    summary.bySource[sourceKind] = (summary.bySource[sourceKind] || 0) + 1;
  }
  return summary;
}

export async function buildTaskLedger({
  cpbRoot,
  hubRoot,
  limit = DEFAULT_LIMIT,
  projectId,
  includeQueueOnly = false,
  includeArchived = false,
}: Record<string, any> = {}) {
  const [queueEntries, githubIssues, jobs, dispatches] = await Promise.all([
    listQueue(hubRoot),
    readGithubIssues(hubRoot),
    listJobs(cpbRoot),
    listDispatches(hubRoot),
  ]);

  const visibleGithubIssues = githubIssues.filter((issue) => !isClosedIssue(issue));
  const issueKeys = new Set(visibleGithubIssues.map(issueKeyFn));
  const queuesByIssue = new Map();
  for (const entry of queueEntries) {
    const key = queueIssueKey(entry);
    if (!key) continue;
    const entries = queuesByIssue.get(key) || [];
    entries.push(entry);
    queuesByIssue.set(key, entries);
  }

  const consumedQueueIds = new Set();
  const tasks = [];
  for (const issue of visibleGithubIssues) {
    if (!issue?.number) continue;
    const key = issueKeyFn(issue);
    const linkedEntries = queuesByIssue.get(key) || [];
    const queueEntry = selectQueueEntry(linkedEntries);
    for (const entry of linkedEntries) consumedQueueIds.add(entry.id);
    tasks.push(issueTask(issue, { queueEntry, queueEntries: linkedEntries, jobs, dispatches }));
  }

  for (const entry of queueEntries) {
    if (consumedQueueIds.has(entry.id)) continue;
    if (!includeQueueOnly) continue;
    if (isArchivedQueueEntry(entry) && !includeArchived) continue;
    if (isTerminalQueueEntry(entry) && !isArchivedQueueEntry(entry)) continue;
    const key = queueIssueKey(entry);
    if (key && issueKeys.has(key)) continue;
    tasks.push(queueTask(entry, { jobs, dispatches }));
  }

  const filtered = projectId ? tasks.filter((task) => task.projectId === projectId) : tasks;
  const sorted = filtered.sort(
    (a, b) =>
      statusRank(a.status) - statusRank(b.status)
      || priorityRank(a.priority) - priorityRank(b.priority)
      || timestampOf(b).localeCompare(timestampOf(a)),
  );
  const itemLimit = clampLimit(limit);

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      ...summarize(filtered),
      visible: Math.min(filtered.length, itemLimit),
    },
    tasks: sorted.slice(0, itemLimit),
  };
}

// ── task-history ──
import { listQueue, queueStatus } from "../hub/hub-queue.js";

function countByStatus(items: AnyRecord[]) {
  return items.reduce((acc, item) => {
    const status = item.status || "unknown";
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
}

function githubIssueLink(metadata: AnyRecord = {}) {
  if (!metadata.issueNumber && !metadata.issueUrl) return null;
  return {
    kind: "github-issue",
    label: metadata.issueNumber ? `#${metadata.issueNumber}` : "GitHub issue",
    url: metadata.issueUrl || null,
    issueNumber: metadata.issueNumber || null,
  };
}

function queueItem(entry: AnyRecord) {
  const metadata = entry.metadata || {};
  const links = [githubIssueLink(metadata)].filter(Boolean);
  const supersededByIssues = Array.isArray(metadata.supersededByIssues)
    ? metadata.supersededByIssues
    : [];

  return {
    id: `queue:${entry.id}`,
    kind: "queue",
    title: truncate(firstLine(metadata.issueTitle || entry.description, entry.id)),
    status: entry.status || "unknown",
    projectId: entry.projectId || null,
    priority: entry.priority || null,
    createdAt: entry.createdAt || null,
    updatedAt: entry.updatedAt || entry.createdAt || null,
    source: metadata.source || entry.type || "queue",
    queueEntryId: entry.id,
    executionBoundary: entry.executionBoundary || null,
    issueNumber: metadata.issueNumber || null,
    finalDisposition: metadata.finalDisposition || null,
    reason: metadata.cleanupReason || metadata.syncReason || metadata.error || null,
    links,
    relations: {
      supersedesQueueEntryId: metadata.supersedesQueueEntryId || null,
      supersededByIssues,
      originQueueEntryId: metadata.originQueueEntryId || null,
      originJobId: metadata.originJobId || null,
    },
  };
}

function dispatchItem(dispatch: AnyRecord) {
  return {
    id: `dispatch:${dispatch.dispatchId}`,
    kind: "dispatch",
    title: dispatch.queueEntryId
      ? `Dispatch for ${dispatch.queueEntryId}`
      : `Dispatch ${dispatch.dispatchId}`,
    status: dispatch.status || "unknown",
    projectId: dispatch.projectId || null,
    priority: null,
    createdAt: dispatch.createdAt || null,
    updatedAt: dispatch.updatedAt || dispatch.createdAt || null,
    source: "hub-dispatch",
    dispatchId: dispatch.dispatchId,
    queueEntryId: dispatch.queueEntryId || null,
    workerId: dispatch.workerId || null,
    relations: {
      queueEntryId: dispatch.queueEntryId || null,
    },
  };
}

function jobItem(job: AnyRecord) {
  return {
    id: `job:${job.jobId}`,
    kind: "job",
    title: truncate(firstLine(job.task, job.jobId)),
    status: job.status || "unknown",
    projectId: job.project || null,
    priority: null,
    createdAt: job.createdAt || null,
    updatedAt: job.updatedAt || job.createdAt || null,
    source: "durable-job",
    jobId: job.jobId,
    workflow: job.workflow || null,
    executor: job.executor || null,
    phase: job.phase || null,
    failurePhase: job.failurePhase || null,
    failureCode: job.failureCode || null,
    reason: job.blockedReason || job.failureCause || job.cancelReason || null,
    relations: {
      parentJobId: job.lineage?.parentJobId || null,
      parentStatus: job.lineage?.parentStatus || null,
      recoveryReason: job.lineage?.recoveryReason || null,
      trigger: job.lineage?.trigger || null,
    },
  };
}

function applyFilters(items: AnyRecord[], { projectId, kinds }: AnyRecord = {}) {
  const kindSet = kinds?.length ? new Set(kinds) : null;
  return items.filter((item) => {
    if (projectId && item.projectId !== projectId) return false;
    if (kindSet && !kindSet.has(item.kind)) return false;
    return true;
  });
}

export async function buildTaskHistory({ cpbRoot, hubRoot, limit = DEFAULT_LIMIT, projectId, kinds }: AnyRecord = {}) {
  const [queueEntries, dispatches, jobs, qStatus] = await Promise.all([
    listQueue(hubRoot),
    listDispatches(hubRoot),
    listJobs(cpbRoot),
    queueStatus(hubRoot),
  ]);

  const allItems = [
    ...queueEntries.map(queueItem),
    ...dispatches.map(dispatchItem),
    ...jobs.map(jobItem),
  ];
  const filtered = applyFilters(allItems, { projectId, kinds });
  const sorted = filtered.sort((a, b) => timestampOf(b).localeCompare(timestampOf(a)));
  const itemLimit = clampLimit(limit);

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalItems: filtered.length,
      visibleItems: Math.min(filtered.length, itemLimit),
      queue: qStatus,
      queueByStatus: countByStatus(queueEntries),
      dispatchByStatus: countByStatus(dispatches),
      jobByStatus: countByStatus(jobs),
      byKind: {
        queue: queueEntries.length,
        dispatch: dispatches.length,
        job: jobs.length,
      },
    },
    items: sorted.slice(0, itemLimit),
  };
}
