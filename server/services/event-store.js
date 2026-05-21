import { appendFile, mkdir, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { runtimeDataRoot, runtimeDataPath } from "./runtime-root.js";
import {
  isSecretArtifact,
  isSecretContent,
  isSecretPath,
  makeSecretBlockedEvent,
  redactSecrets,
} from "./secret-policy.js";

export const JOBS_EVENTS_FORMAT_VERSION = 1;

function _base(cpbRoot, opts) {
  return opts?.dataRoot || runtimeDataRoot(cpbRoot);
}

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

async function truncateCorruptJsonlTail(file, raw) {
  const lastNewline = raw.lastIndexOf("\n");
  const validPrefix = lastNewline >= 0 ? raw.slice(0, lastNewline + 1) : "";
  await truncate(file, Buffer.byteLength(validPrefix, "utf8"));
}

export function eventFileFor(cpbRoot, project, jobId, opts = {}) {
  validatePathComponent("project", project);
  validatePathComponent("jobId", jobId);

  const eventsRoot = path.join(_base(cpbRoot, opts), "events");
  const file = path.resolve(eventsRoot, project, `${jobId}.jsonl`);
  const relative = path.relative(eventsRoot, file);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("event file resolves outside events root");
  }

  return file;
}

async function _scanEventsDir(eventsRoot) {
  let projectEntries;
  try {
    projectEntries = await readdir(eventsRoot, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }

  const files = [];
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;
    const project = projectEntry.name;
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(project)) continue;

    let jobEntries;
    try {
      jobEntries = await readdir(path.join(eventsRoot, project), { withFileTypes: true });
    } catch (err) {
      if (err && err.code === "ENOENT") continue;
      throw err;
    }

    for (const jobEntry of jobEntries) {
      if (!jobEntry.isFile() || !jobEntry.name.endsWith(".jsonl")) continue;
      const jobId = jobEntry.name.slice(0, -".jsonl".length);
      if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(jobId)) continue;
      files.push({ project, jobId, file: path.join(eventsRoot, project, jobEntry.name) });
    }
  }
  return files;
}

export async function listEventFiles(cpbRoot, opts = {}) {
  const rtRoot = opts.dataRoot ? path.join(opts.dataRoot, "events") : null;
  const legacyRoot = runtimeDataPath(cpbRoot, "events");

  const seen = new Set();
  const allFiles = [];

  if (rtRoot && rtRoot !== legacyRoot) {
    for (const f of await _scanEventsDir(rtRoot)) {
      const key = `${f.project}/${f.jobId}`;
      if (!seen.has(key)) { seen.add(key); allFiles.push(f); }
    }
  }
  for (const f of await _scanEventsDir(legacyRoot)) {
    const key = `${f.project}/${f.jobId}`;
    if (!seen.has(key)) { seen.add(key); allFiles.push(f); }
  }

  return allFiles.sort((a, b) => a.file.localeCompare(b.file));
}

export async function repairEventFile(cpbRoot, project, jobId, opts = {}) {
  const file = eventFileFor(cpbRoot, project, jobId, opts);
  try {
    const raw = await readFile(file, "utf8");
    if (raw.endsWith("\n") || raw.length === 0) {
      return { repaired: false, removedBytes: 0 };
    }

    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      await writeFile(file, "", "utf8");
      return { repaired: true, removedBytes: Buffer.byteLength(raw) };
    }

    const lastLine = lines[lines.length - 1];
    try {
      JSON.parse(lastLine);
      await writeFile(file, raw + "\n", "utf8");
      return { repaired: true, removedBytes: 0, addedNewline: true };
    } catch {
      const lastNewline = raw.lastIndexOf("\n");
      const trimmed = lastNewline === -1 ? "" : raw.substring(0, lastNewline + 1);
      const removedBytes = Buffer.byteLength(raw) - Buffer.byteLength(trimmed);
      await writeFile(file, trimmed, "utf8");
      return { repaired: true, removedBytes };
    }
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { repaired: false, removedBytes: 0 };
    }
    throw err;
  }
}

export async function appendEvent(cpbRoot, project, jobId, event, opts = {}) {
  // Validate event structure first (throws on invalid input)
  serializeEvent(event);

  const writeBlocked = async (artifactName, reason) => {
    const blocked = makeSecretBlockedEvent(artifactName, reason);
    blocked.jobId = event.jobId || jobId;
    blocked.project = event.project || project;
    const serialized = serializeEvent(blocked);
    const file = eventFileFor(cpbRoot, project, jobId, opts);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${serialized}\n`, "utf8");
    return blocked;
  };

  // Block secret-like artifacts before persisting
  if (event.artifact && isSecretPath(event.artifact)) {
    return writeBlocked(event.artifact, "secret-like artifact path blocked");
  }

  // Block events with secret-like content in artifact fields
  if (event.artifact && typeof event.artifact === "string" && isSecretArtifact(event.artifact, event.artifact)) {
    return writeBlocked(event.artifact, "secret-like artifact content blocked");
  }

  if (event.artifact && typeof event.artifact === "string") {
    const artifactPayload = [
      event.content,
      event.output,
      event.stdout,
      event.stderr,
      event.body,
    ].filter((value) => value !== undefined && value !== null);
    if (artifactPayload.some((value) => isSecretContent(typeof value === "string" ? value : JSON.stringify(value)))) {
      return writeBlocked(event.artifact, "secret-like artifact content blocked");
    }
  }

  // Redact secrets from event payload before persisting
  const redacted = redactSecrets(event);
  const serialized = JSON.stringify(redacted);
  const file = eventFileFor(cpbRoot, project, jobId, opts);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${serialized}\n`, "utf8");
  return redacted;
}

async function _parseEventFile(file) {
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
          await truncateCorruptJsonlTail(file, raw);
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
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

export async function readEvents(cpbRoot, project, jobId, opts = {}) {
  // Try runtime root first when dataRoot is provided and differs from legacy
  if (opts.dataRoot && opts.dataRoot !== runtimeDataRoot(cpbRoot)) {
    const rtFile = eventFileFor(cpbRoot, project, jobId, opts);
    const rtEvents = await _parseEventFile(rtFile);
    if (rtEvents !== null) return rtEvents;
  }

  // Legacy path
  const file = eventFileFor(cpbRoot, project, jobId);
  const result = await _parseEventFile(file);
  return result ?? [];
}

const POST_TERMINAL_ALLOWED = new Set([
  "job_redirect_consumed", "phase_activity",
  "permission_denied",
  "external_repair_started", "external_repair_completed", "external_repair_failed",
  "finalizer_result",
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
    executor: null,
    artifacts: {},
    completedPhases: [],
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
    externalRepairStatus: null,
    externalRepairArtifact: null,
    externalRepairAt: null,
    externalRepairError: null,
    lineage: null,
    permissionDenials: [],
    infraStatus: null,
    finalizer: null,
  };

  let terminal = false;

  for (const event of events) {
    const isPostTerminalEvent = terminal;
    if (isPostTerminalEvent && !POST_TERMINAL_ALLOWED.has(event.type)) {
      continue;
    }

    if (event.jobId !== undefined) state.jobId = event.jobId;
    if (event.project !== undefined) state.project = event.project;
    if (!isPostTerminalEvent && event.attempt !== undefined) state.attempt = event.attempt;
    if (!isPostTerminalEvent && event.workflow !== undefined) state.workflow = event.workflow;
    if (event.ts !== undefined) state.updatedAt = event.ts;

    switch (event.type) {
      case "job_created":
        state.task = event.task ?? state.task;
        state.executor = event.executor ?? state.executor;
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
        if (event.phase !== undefined && !state.completedPhases.includes(event.phase)) {
          state.completedPhases = [...state.completedPhases, event.phase];
        }
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
      case "recovery_created":
        state.lineage = {
          parentJobId: event.lineage?.parentJobId ?? null,
          parentStatus: event.lineage?.parentStatus ?? null,
          parentFailureCode: event.lineage?.parentFailureCode ?? null,
          parentFailurePhase: event.lineage?.parentFailurePhase ?? null,
          parentBlockedReason: event.lineage?.parentBlockedReason ?? null,
          recoveryReason: event.recoveryReason ?? null,
          trigger: event.trigger ?? null,
        };
        break;
      case "permission_denied":
        state.permissionDenials = [
          ...state.permissionDenials,
          {
            category: event.category ?? "infra",
            phase: event.phase ?? null,
            role: event.role ?? null,
            action: event.action ?? null,
            deniedOperation: event.deniedOperation ?? event.action ?? null,
            targetPath: event.targetPath ?? "",
            reason: event.reason ?? "permission denied",
            allowedBoundary: event.allowedBoundary ?? "",
            recoveryGuidance: event.recoveryGuidance ?? "",
            ts: event.ts ?? null,
          },
        ];
        state.infraStatus = "blocked";
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
      case "external_repair_started":
        state.externalRepairStatus = "STARTED";
        state.externalRepairArtifact = event.artifact ?? state.externalRepairArtifact;
        state.externalRepairAt = event.ts ?? state.externalRepairAt;
        state.externalRepairError = null;
        break;
      case "external_repair_completed":
        state.externalRepairStatus = event.repairStatus ?? "UNKNOWN";
        state.externalRepairArtifact = event.artifact ?? state.externalRepairArtifact;
        state.externalRepairAt = event.ts ?? state.externalRepairAt;
        state.externalRepairError = null;
        break;
      case "external_repair_failed":
        state.externalRepairStatus = "FAILED";
        state.externalRepairArtifact = event.artifact ?? state.externalRepairArtifact;
        state.externalRepairAt = event.ts ?? state.externalRepairAt;
        state.externalRepairError = event.error ?? event.reason ?? null;
        break;
      case "finalizer_result":
        state.finalizer = {
          ok: Boolean(event.result?.ok),
          status: event.result?.status ?? null,
          code: event.result?.code ?? null,
          commit: event.result?.commit ?? null,
          closed: event.result?.closed ?? null,
          mode: event.result?.mode ?? null,
          ts: event.ts ?? null,
        };
        break;
    }
  }

  return state;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "cancelled"]);

function checkpointFileFor(cpbRoot, project, jobId, opts = {}) {
  validatePathComponent("project", project);
  validatePathComponent("jobId", jobId);
  const checkpointsRoot = path.join(_base(cpbRoot, opts), "checkpoints");
  return path.resolve(checkpointsRoot, project, `${jobId}.json`);
}

export async function writeCheckpoint(cpbRoot, project, jobId, state, opts = {}) {
  const file = checkpointFileFor(cpbRoot, project, jobId, opts);
  await mkdir(path.dirname(file), { recursive: true });
  const checkpoint = {
    _meta: { version: JOBS_EVENTS_FORMAT_VERSION, writtenAt: new Date().toISOString(), eventCount: null },
    state,
  };
  await writeFile(file, JSON.stringify(checkpoint) + "\n", "utf8");
  return file;
}

export async function readCheckpoint(cpbRoot, project, jobId, opts = {}) {
  // Try runtime root first
  if (opts.dataRoot && opts.dataRoot !== runtimeDataRoot(cpbRoot)) {
    const rtFile = checkpointFileFor(cpbRoot, project, jobId, opts);
    try {
      const raw = await readFile(rtFile, "utf8");
      const parsed = JSON.parse(raw);
      return parsed.state ?? null;
    } catch {}
  }
  const file = checkpointFileFor(cpbRoot, project, jobId);
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return parsed.state ?? null;
  } catch {
    return null;
  }
}

export async function deleteCheckpoint(cpbRoot, project, jobId, opts = {}) {
  const file = checkpointFileFor(cpbRoot, project, jobId, opts);
  await rm(file, { force: true });
}

export async function checkpointJob(cpbRoot, project, jobId, opts = {}) {
  const events = await readEvents(cpbRoot, project, jobId, opts);
  if (events.length === 0) return null;
  const state = materializeJob(events);
  if (!TERMINAL_STATUSES.has(state.status)) return null;
  await writeCheckpoint(cpbRoot, project, jobId, state, opts);
  return state;
}
