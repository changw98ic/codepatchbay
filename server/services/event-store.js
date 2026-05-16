import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runtimeDataPath } from "./runtime-root.js";

function validatePathComponent(name, value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value)
  ) {
    throw new Error(`invalid ${name}`);
  }
}

function serializeEvent(event) {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("invalid event: expected a non-null object");
  }

  let serialized;
  try {
    serialized = JSON.stringify(event);
  } catch (err) {
    throw new Error(`invalid event: ${err.message}`);
  }

  if (typeof serialized !== "string") {
    throw new Error("invalid event: must serialize to JSON");
  }

  return serialized;
}

function malformedEventError(file, lineNumber, reason) {
  return new Error(`${file} at line ${lineNumber}: malformed event: ${reason}`);
}

export function eventFileFor(cpbRoot, project, jobId) {
  validatePathComponent("project", project);
  validatePathComponent("jobId", jobId);

  const eventsRoot = runtimeDataPath(cpbRoot, "events");
  const file = path.resolve(eventsRoot, project, `${jobId}.jsonl`);
  const relative = path.relative(eventsRoot, file);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("event file resolves outside events root");
  }

  return file;
}

export async function listEventFiles(cpbRoot) {
  const eventsRoot = runtimeDataPath(cpbRoot, "events");

  let projectEntries;
  try {
    projectEntries = await readdir(eventsRoot, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const files = [];
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) {
      continue;
    }

    const project = projectEntry.name;
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(project)) {
      continue;
    }

    let jobEntries;
    try {
      jobEntries = await readdir(path.join(eventsRoot, project), { withFileTypes: true });
    } catch (err) {
      if (err && err.code === "ENOENT") {
        continue;
      }
      throw err;
    }

    for (const jobEntry of jobEntries) {
      if (!jobEntry.isFile() || !jobEntry.name.endsWith(".jsonl")) {
        continue;
      }

      const jobId = jobEntry.name.slice(0, -".jsonl".length);
      if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(jobId)) {
        continue;
      }

      files.push({
        project,
        jobId,
        file: path.join(eventsRoot, project, jobEntry.name),
      });
    }
  }

  return files.sort((a, b) => a.file.localeCompare(b.file));
}

export async function appendEvent(cpbRoot, project, jobId, event) {
  const serialized = serializeEvent(event);
  const file = eventFileFor(cpbRoot, project, jobId);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${serialized}\n`, "utf8");
  return event;
}

export async function readEvents(cpbRoot, project, jobId) {
  const file = eventFileFor(cpbRoot, project, jobId);

  try {
    const raw = await readFile(file, "utf8");
    const hasTrailingNewline = raw.endsWith("\n");
    const lines = raw
      .split("\n")
      .map((line, index) => ({ line, lineNumber: index + 1 }))
      .filter(({ line }) => line.trim().length > 0);

    const events = [];
    for (const { line, lineNumber } of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch (err) {
        if (lineNumber === lines[lines.length - 1].lineNumber && !hasTrailingNewline) {
          break;
        }
        throw new Error(`malformed event JSON in ${file} at line ${lineNumber}: ${err.message}`);
      }
      if (event === null || typeof event !== "object" || Array.isArray(event)) {
        throw malformedEventError(file, lineNumber, "expected a non-null object");
      }
      events.push(event);
    }
    return events;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

const POST_TERMINAL_ALLOWED = new Set([
  "job_completed", "job_failed", "job_blocked", "job_cancelled",
  "job_cancel_requested", "job_redirect_consumed", "job_retried", "phase_activity", "workflow_selected",
]);

export function materializeJob(events) {
  const state = {
    jobId: null,
    project: null,
    task: null,
    status: null,
    phase: null,
    attempt: null,
    workflow: null,
    artifacts: {},
    leaseId: null,
    worktree: null,
    createdAt: null,
    updatedAt: null,
    blockedReason: null,
    failureCode: null,
    failurePhase: null,
    retryable: false,
    retryCount: 0,
    failureCause: null,
    cancelRequested: false,
    cancelReason: null,
    redirectContext: null,
    redirectReason: null,
    redirectEventId: null,
    consumedRedirectIds: [],
    lastActivityAt: null,
    lastActivityMessage: null,
  };

  let terminal = false;

  for (const event of events) {
    if (event.jobId !== undefined) state.jobId = event.jobId;
    if (event.project !== undefined) state.project = event.project;
    if (event.attempt !== undefined) state.attempt = event.attempt;
    if (event.workflow !== undefined) state.workflow = event.workflow;
    if (event.ts !== undefined) state.updatedAt = event.ts;

    if (terminal && !POST_TERMINAL_ALLOWED.has(event.type)) {
      continue;
    }

    switch (event.type) {
      case "job_created":
        state.task = event.task ?? state.task;
        state.status = "running";
        state.createdAt = event.ts ?? state.createdAt;
        state.blockedReason = null;
        terminal = false;
        break;
      case "worktree_created":
        state.worktree = event.worktree ?? event.path ?? state.worktree;
        break;
      case "phase_started":
        state.phase = event.phase ?? state.phase;
        state.leaseId = event.leaseId ?? null;
        state.status = "running";
        state.blockedReason = null;
        break;
      case "phase_completed":
        state.phase = event.phase ?? state.phase;
        state.leaseId = null;
        state.status = "running";
        if (event.phase !== undefined && event.artifact !== undefined) {
          state.artifacts[event.phase] = event.artifact;
        }
        break;
      case "phase_failed":
        state.phase = event.phase ?? state.phase;
        state.leaseId = null;
        state.status = "failed";
        state.blockedReason = event.error ?? event.reason ?? null;
        state.failureCode = event.code ?? state.failureCode;
        state.failurePhase = event.phase ?? state.failurePhase;
        state.retryable = event.retryable ?? state.retryable;
        state.retryCount = event.retryCount ?? state.retryCount;
        state.failureCause = event.cause ?? state.failureCause;
        terminal = true;
        break;
      case "budget_exceeded":
        state.status = "blocked";
        state.leaseId = null;
        state.blockedReason = event.reason ?? "budget exceeded";
        terminal = true;
        break;
      case "job_blocked":
        state.status = "blocked";
        state.leaseId = null;
        state.blockedReason = event.reason ?? event.blockedReason ?? null;
        terminal = true;
        break;
      case "job_failed":
        state.status = "failed";
        state.leaseId = null;
        state.blockedReason = event.reason ?? event.error ?? state.blockedReason;
        state.failureCode = event.code ?? state.failureCode;
        state.failurePhase = event.phase ?? state.failurePhase;
        state.retryable = event.retryable ?? state.retryable;
        state.retryCount = event.retryCount ?? state.retryCount;
        state.failureCause = event.cause ?? state.failureCause;
        terminal = true;
        break;
      case "job_completed":
        state.status = "completed";
        state.phase = "completed";
        state.leaseId = null;
        state.blockedReason = null;
        state.failureCode = null;
        state.failurePhase = null;
        state.retryable = false;
        state.retryCount = 0;
        state.failureCause = null;
        terminal = true;
        break;
      case "job_cancel_requested":
        state.cancelRequested = true;
        state.cancelReason = event.reason ?? null;
        break;
      case "job_cancelled":
        state.cancelRequested = true;
        state.status = "cancelled";
        state.leaseId = null;
        terminal = true;
        break;
      case "job_retried":
        state.status = "running";
        state.phase = event.fromPhase ?? state.phase;
        state.leaseId = null;
        state.blockedReason = null;
        state.failureCode = null;
        state.failurePhase = null;
        state.retryable = false;
        state.retryCount = event.retryCount ?? state.retryCount + 1;
        state.failureCause = null;
        for (const artifactPhase of event.clearArtifacts ?? []) {
          delete state.artifacts[artifactPhase];
        }
        terminal = false;
        break;
      case "job_redirect_requested":
        if (!terminal) {
          state.redirectContext = event.instructions ?? null;
          state.redirectReason = event.reason ?? null;
          state.redirectEventId = event.redirectEventId ?? null;
        }
        break;
      case "job_redirect_consumed":
        if (event.redirectEventId !== undefined) {
          state.consumedRedirectIds = [
            ...state.consumedRedirectIds,
            event.redirectEventId,
          ];
        }
        if (state.redirectEventId === event.redirectEventId) {
          state.redirectContext = null;
          state.redirectReason = null;
          state.redirectEventId = null;
        }
        break;
      case "workflow_selected":
        state.workflow = event.workflow ?? state.workflow;
        break;
      case "phase_activity":
        state.lastActivityAt = event.ts ?? state.lastActivityAt;
        state.lastActivityMessage = event.message ?? state.lastActivityMessage;
        break;
    }
  }

  return state;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "cancelled"]);

function checkpointFileFor(cpbRoot, project, jobId) {
  validatePathComponent("project", project);
  validatePathComponent("jobId", jobId);
  const checkpointsRoot = runtimeDataPath(cpbRoot, "checkpoints");
  return path.resolve(checkpointsRoot, project, `${jobId}.json`);
}

export async function writeCheckpoint(cpbRoot, project, jobId, state) {
  const file = checkpointFileFor(cpbRoot, project, jobId);
  await mkdir(path.dirname(file), { recursive: true });
  const checkpoint = {
    _meta: { version: 1, writtenAt: new Date().toISOString(), eventCount: null },
    state,
  };
  await writeFile(file, JSON.stringify(checkpoint) + "\n", "utf8");
  return file;
}

export async function readCheckpoint(cpbRoot, project, jobId) {
  const file = checkpointFileFor(cpbRoot, project, jobId);
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return parsed.state ?? null;
  } catch {
    return null;
  }
}

export async function deleteCheckpoint(cpbRoot, project, jobId) {
  const file = checkpointFileFor(cpbRoot, project, jobId);
  await rm(file, { force: true });
}

export async function checkpointJob(cpbRoot, project, jobId) {
  const events = await readEvents(cpbRoot, project, jobId);
  if (events.length === 0) return null;
  const state = materializeJob(events);
  if (!TERMINAL_STATUSES.has(state.status)) return null;
  await writeCheckpoint(cpbRoot, project, jobId, state);
  return state;
}
