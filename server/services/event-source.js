import { readFile, writeFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { runtimeDataPath } from "./runtime-root.js";
import { appendEvent } from "./event-store.js";
import { createJob } from "./job-store.js";

const EVENT_SOURCE_DIR = "event-sources";
const CANDIDATE_QUEUE_FILE = "candidates.json";
const CANDIDATE_LOCK_TTL_MS = 30_000;

function sourceDir(cpbRoot) {
  return runtimeDataPath(cpbRoot, EVENT_SOURCE_DIR);
}

function candidateFile(cpbRoot) {
  return path.join(sourceDir(cpbRoot), CANDIDATE_QUEUE_FILE);
}

function generateId() {
  return `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function dedupeKey(source, externalId) {
  return `${source}:${externalId}`;
}

const candidateChains = new Map();

async function withCandidateFileLock(cpbRoot, fn) {
  const file = candidateFile(cpbRoot);
  const lockDir = `${file}.lock`;
  await mkdir(path.dirname(lockDir), { recursive: true });

  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(lockDir);
      acquired = true;
      break;
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs >= CANDIDATE_LOCK_TTL_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // The lock disappeared between mkdir and stat; retry.
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  if (!acquired) throw new Error(`candidate queue lock busy: ${path.basename(file)}`);

  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

function withCandidateLock(cpbRoot, fn) {
  const key = path.resolve(cpbRoot);
  const prev = candidateChains.get(key) || Promise.resolve();
  const next = prev.then(() => withCandidateFileLock(cpbRoot, fn));
  candidateChains.set(key, next.catch(() => {}));
  const cleanup = () => {
    if (candidateChains.get(key) === next) candidateChains.delete(key);
  };
  next.then(cleanup, cleanup);
  return next;
}

async function atomicWriteJson(file, data) {
  const tmp = `${file}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, file);
}

async function readQueue(file) {
  try {
    const raw = await readFile(file, "utf8");
    const queue = JSON.parse(raw);
    if (!Array.isArray(queue)) {
      throw new Error(`candidate queue malformed: expected array in ${file}`);
    }
    return queue;
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    if (err instanceof SyntaxError) {
      throw new Error(`candidate queue malformed: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Ingest an external event into the candidate queue.
 * Returns the created candidate entry.
 */
export async function ingestEvent(cpbRoot, event) {
  const {
    source,
    externalId,
    projectId,
    priority = "normal",
    payload = {},
    receivedAt,
  } = event;

  if (!source || !externalId) {
    throw new Error("ingestEvent requires source and externalId");
  }

  const entry = {
    id: generateId(),
    source,
    externalId: String(externalId),
    projectId: projectId || null,
    priority,
    dedupeKey: dedupeKey(source, externalId),
    payload,
    receivedAt: receivedAt || new Date().toISOString(),
    status: "pending",
  };

  return withCandidateLock(cpbRoot, async () => {
    const dir = sourceDir(cpbRoot);
    await mkdir(dir, { recursive: true });

    const file = candidateFile(cpbRoot);
    const queue = await readQueue(file);

    const existing = queue.find((e) => e.dedupeKey === entry.dedupeKey);
    if (existing) {
      return { ...existing, status: "duplicate" };
    }

    queue.push(entry);
    await atomicWriteJson(file, queue);

    return entry;
  });
}

function githubQueueExternalId(event) {
  if (event.delivery) return event.delivery;
  return [
    event.event || "github",
    event.repo || "repo",
    event.issueNumber || "issue",
    event.action || "action",
    event.commandText || event.label || "",
  ].join(":");
}

function githubPriority(labels = []) {
  return labels.some((label) => /p0|critical|urgent|blocker/i.test(label)) ? "high" : "normal";
}

function githubQueuePayload(event, match) {
  return {
    issueNumber: event.issueNumber ?? null,
    repo: event.repo || null,
    title: event.title || (event.issueNumber ? `Issue #${event.issueNumber}` : "GitHub issue"),
    body: event.body || "",
    url: event.url || null,
    actor: event.actor || null,
    workflow: match.workflow || "standard",
    action: event.action || null,
    commandText: event.commandText || null,
    labels: event.labels || [],
    delivery: event.delivery || null,
    triggerReason: match.reason || null,
  };
}

export async function createGithubIssueQueueJob(cpbRoot, event, match, { createJobFn = createJob } = {}) {
  if (!event || event.status !== "ok") {
    throw new Error("GitHub event must be normalized before queue creation");
  }
  if (!match?.matched) {
    throw new Error("GitHub event did not match a trigger rule");
  }
  if (!event.projectId) {
    throw new Error("GitHub event missing project id");
  }

  const payload = githubQueuePayload(event, match);
  const entry = await ingestEvent(cpbRoot, {
    source: "github-issue",
    externalId: githubQueueExternalId(event),
    projectId: event.projectId,
    priority: githubPriority(event.labels),
    payload,
  });

  if (entry.status === "duplicate") {
    return { status: "duplicate", entry, job: null };
  }

  const sourceContext = {
    type: "github_issue",
    queueEntryId: entry.id,
    issueNumber: payload.issueNumber,
    repo: payload.repo,
    url: payload.url,
    actor: payload.actor,
    delivery: payload.delivery,
    commandText: payload.commandText,
    triggerReason: payload.triggerReason,
  };
  const job = await createJobFn(cpbRoot, {
    project: event.projectId,
    task: payload.title,
    workflow: payload.workflow,
    queueEntryId: entry.id,
    sourceContext,
  });
  const updated = await updateCandidate(cpbRoot, entry.id, {
    status: "dispatched",
    reason: `created job ${job.jobId}`,
  });

  return {
    status: "created",
    entry: updated || entry,
    job,
  };
}

function channelExternalId(source, context = {}) {
  if (context.externalId) return context.externalId;
  if (context.triggerId) return context.triggerId;
  return [
    source,
    context.teamId || "team",
    context.channelId || "channel",
    context.actor || "actor",
    Date.now().toString(36),
    Math.random().toString(36).slice(2, 8),
  ].join(":");
}

function channelQueuePayload(command, context = {}) {
  return {
    task: command.task || (command.issue ? `GitHub issue #${command.issue}` : ""),
    workflow: command.workflow || "standard",
    command: command.command || command.type || null,
    issueNumber: command.issue || null,
    commandText: context.commandText || null,
    actor: context.actor || null,
    actorName: context.actorName || null,
    teamId: context.teamId || null,
    channelId: context.channelId || null,
    channelName: context.channelName || null,
    triggerId: context.triggerId || null,
  };
}

export async function createChannelQueueJob(cpbRoot, command, context = {}, { createJobFn = createJob } = {}) {
  if (!command || !["run", "issue"].includes(command.type)) {
    throw new Error("channel command must be a run or issue command before queue creation");
  }
  if (!command.project || (!command.task && !command.issue)) {
    throw new Error("channel command requires project and task or issue");
  }

  const source = context.channel || "channel";
  const payload = channelQueuePayload(command, context);
  const entry = await ingestEvent(cpbRoot, {
    source,
    externalId: channelExternalId(source, context),
    projectId: command.project,
    payload,
  });

  if (entry.status === "duplicate") {
    return { status: "duplicate", entry, job: null };
  }

  const sourceContext = {
    type: source,
    channel: source,
    queueEntryId: entry.id,
    actor: payload.actor,
    actorName: payload.actorName,
    teamId: payload.teamId,
    channelId: payload.channelId,
    channelName: payload.channelName,
    commandText: payload.commandText,
    triggerId: payload.triggerId,
    issueNumber: payload.issueNumber,
  };
  const job = await createJobFn(cpbRoot, {
    project: command.project,
    task: payload.task,
    workflow: command.workflow || "standard",
    queueEntryId: entry.id,
    sourceContext,
  });
  const updated = await updateCandidate(cpbRoot, entry.id, {
    status: "dispatched",
    reason: `created job ${job.jobId}`,
  });

  return {
    status: "created",
    entry: updated || entry,
    job,
  };
}

/**
 * List candidate events, optionally filtered by status or source.
 */
export async function listCandidates(cpbRoot, { status, source } = {}) {
  const file = candidateFile(cpbRoot);
  const queue = await readQueue(file);

  return queue.filter((e) => {
    if (status && e.status !== status) return false;
    if (source && e.source !== source) return false;
    return true;
  });
}

/**
 * Update a candidate's status (pending → processed | dismissed).
 */
export async function updateCandidate(cpbRoot, candidateId, { status, reason }) {
  return withCandidateLock(cpbRoot, async () => {
    const file = candidateFile(cpbRoot);
    const queue = await readQueue(file);
    if (!queue.length) return null;

    const entry = queue.find((e) => e.id === candidateId);
    if (!entry) return null;

    entry.status = status;
    if (reason) entry.statusReason = reason;
    entry.updatedAt = new Date().toISOString();

    await atomicWriteJson(file, queue);
    return entry;
  });
}

/**
 * Normalize a GitHub issue into a candidate event.
 */
export function githubIssueToCandidate(issue, { projectId } = {}) {
  return {
    source: "github-issue",
    externalId: String(issue.number || issue.id),
    projectId: projectId || issue.projectId || null,
    priority: issue.labels?.some?.((l) => {
      const name = typeof l === "string" ? l : l.name;
      return name && /p0|critical|urgent|blocker/i.test(name);
    }) ? "high" : "normal",
    payload: {
      title: issue.title || `Issue #${issue.number}`,
      body: (issue.body || "").slice(0, 2000),
      labels: Array.isArray(issue.labels)
        ? issue.labels.map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean)
        : [],
      url: issue.url || null,
      state: issue.state || "OPEN",
    },
  };
}

/**
 * Normalize a CI failure into a candidate event.
 */
export function ciFailureToCandidate(failure, { projectId } = {}) {
  return {
    source: "ci-failure",
    externalId: failure.runId || failure.buildId || `ci-${Date.now()}`,
    projectId: projectId || null,
    priority: "high",
    payload: {
      workflow: failure.workflow || null,
      branch: failure.branch || null,
      commit: failure.commit || null,
      message: failure.message || "CI failure",
      url: failure.url || null,
    },
  };
}
