import { appendFile, mkdir, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord, recordValue, type LooseRecord } from "../../../core/contracts/types.js";
import { resolveCachedProjectRuntimeRoot } from "../phase-locator.js";
import {
  isSecretArtifact,
  isSecretContent,
  isSecretPath,
  makeSecretBlockedEvent,
  redactSecrets,
} from "../secret-policy.js";
import {
  materializeJob,
  advanceMaterializedJob,
  POST_TERMINAL_ALLOWED,
  TERMINAL_STATUSES,
  type MaterializedJobState,
} from "./event-materializer.js";
import type {
  EventRecord,
  EventStoreOptions,
  EventWriteNotification,
} from "./event-types.js";
import { withTraceContext } from "../trace/trace-context.js";
import { openPinnedHubRedisStateBackend } from "../../../shared/hub-state-redis.js";

export { materializeJob, advanceMaterializedJob } from "./event-materializer.js";

const EVENT_LOCK_TTL_MS = 30_000;

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function isEventRecord(value: unknown): value is EventRecord {
  return isRecord(value);
}

function redisJobField(project: string, jobId: string) {
  validatePathComponent("project", project);
  validatePathComponent("jobId", jobId);
  const part = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  return `job:${part(project)}:${part(jobId)}`;
}

async function redisEventBackend() {
  const hubRoot = process.env.CPB_HUB_ROOT;
  if (!hubRoot) return null;
  return await openPinnedHubRedisStateBackend({
    configFile: process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE,
    hubRoot,
  });
}

async function assertNoLocalEvent(cpbRoot: string, project: string, jobId: string, opts: EventStoreOptions) {
  const dataRoot = opts.dataRoot || resolveCachedProjectRuntimeRoot(cpbRoot, project);
  if (!dataRoot) return;
  const file = eventFileFor(cpbRoot, project, jobId, { ...opts, dataRoot, legacyOnly: false });
  try {
    if ((await stat(file)).size > 0) {
      throw Object.assign(new Error("local job events require an explicit Redis migration"), {
        code: "HUB_JOB_MIGRATION_REQUIRED",
      });
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function redisPersistableEvent(event: EventRecord, project: string, jobId: string): EventRecord {
  const artifact = event.artifact;
  const blocked = (reason: string) => {
    const value = makeSecretBlockedEvent(artifact, reason);
    value.jobId = event.jobId ?? jobId;
    value.project = event.project ?? project;
    return withTraceContext(value, { project, jobId }) as EventRecord;
  };
  if (artifact && isSecretPath(artifact)) return blocked("secret-like artifact path blocked");
  if (typeof artifact === "string" && isSecretArtifact(artifact, artifact)) {
    return blocked("secret-like artifact content blocked");
  }
  if (typeof artifact === "string") {
    const payload = [event.content, event.output, event.stdout, event.stderr, event.body]
      .filter((value) => value !== undefined && value !== null);
    if (payload.some((value) => isSecretContent(typeof value === "string" ? value : JSON.stringify(value)))) {
      return blocked("secret-like artifact content blocked");
    }
  }
  return recordValue(redactSecrets(event)) as EventRecord;
}

async function withEventLock<T>(eventFile: string, callback: () => Promise<T>): Promise<T> {
  const lockDir = `${eventFile}.lock`;
  await mkdir(path.dirname(lockDir), { recursive: true });
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await mkdir(lockDir);
      acquired = true;
      break;
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs >= EVENT_LOCK_TTL_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Race: someone else removed it, retry
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  if (!acquired) throw new Error(`event log lock busy: ${path.basename(eventFile)}`);
  try {
    return await callback();
  } finally {
    try { await rm(lockDir, { recursive: true, force: true }); } catch {}
  }
}

export const JOBS_EVENTS_FORMAT_VERSION = 1;
const eventWriteListeners = new Set<(payload: EventWriteNotification) => void | Promise<void>>();

export function onEventWritten(listener: (payload: EventWriteNotification) => void | Promise<void>) {
  eventWriteListeners.add(listener);
  return () => eventWriteListeners.delete(listener);
}

async function notifyEventWritten(payload: EventWriteNotification) {
  for (const listener of eventWriteListeners) {
    try {
      await listener(payload);
    } catch {}
  }
}

function _base(cpbRoot: string, opts: EventStoreOptions) {
  if (opts?.dataRoot) return opts.dataRoot;
  if (opts?.legacyOnly === true) return legacyRuntimeRoot(cpbRoot);
  throw new Error("dataRoot is required for project event store paths");
}

function legacyRuntimeRoot(cpbRoot: string) {
  return path.join(path.resolve(cpbRoot), "cpb-task");
}

function validatePathComponent(name: string, value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value)
  ) {
    throw new Error(`invalid ${name}`);
  }
}

function serializeEvent(event: unknown) {
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

function malformedEventError(file: string, lineNumber: number, reason: string) {
  return new Error(`${file} at line ${lineNumber}: malformed event: ${reason}`);
}

async function truncateCorruptJsonlTail(file: string, raw: string) {
  const lastNewline = raw.lastIndexOf("\n");
  const validPrefix = lastNewline >= 0 ? raw.slice(0, lastNewline + 1) : "";
  await truncate(file, Buffer.byteLength(validPrefix, "utf8"));
}

export function eventFileFor(cpbRoot: string, project: string, jobId: string, opts: EventStoreOptions = {}) {
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

async function _scanEventsDir(eventsRoot: string) {
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

export async function listEventFiles(cpbRoot: string, opts: EventStoreOptions = {}) {
  const includeLegacyFallback = opts.includeLegacyFallback === true || opts.legacyOnly === true;
  if (!opts.dataRoot && !includeLegacyFallback) {
    throw new Error("dataRoot is required for project event store paths");
  }

  const rtRoot = opts.dataRoot && opts.legacyOnly !== true ? path.join(opts.dataRoot, "events") : null;
  const legacyRoot = path.join(legacyRuntimeRoot(cpbRoot), "events");

  const seen = new Set();
  const allFiles = [];

  if (rtRoot && rtRoot !== legacyRoot) {
    for (const f of await _scanEventsDir(rtRoot)) {
      const key = `${f.project}/${f.jobId}`;
      if (!seen.has(key)) { seen.add(key); allFiles.push(f); }
    }
  }
  if (includeLegacyFallback) {
    for (const f of await _scanEventsDir(legacyRoot)) {
      const key = `${f.project}/${f.jobId}`;
      if (!seen.has(key)) { seen.add(key); allFiles.push(f); }
    }
  }

  return allFiles.sort((a, b) => a.file.localeCompare(b.file));
}

export async function recoverEventFile(cpbRoot: string, project: string, jobId: string, opts: EventStoreOptions = {}) {
  const file = eventFileFor(cpbRoot, project, jobId, opts);
  try {
    const raw = await readFile(file, "utf8");
    if (raw.endsWith("\n") || raw.length === 0) {
      return { recovered: false, removedBytes: 0 };
    }

    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      await writeFile(file, "", "utf8");
      return { recovered: true, removedBytes: Buffer.byteLength(raw) };
    }

    const lastLine = lines[lines.length - 1];
    try {
      JSON.parse(lastLine);
      await writeFile(file, raw + "\n", "utf8");
      return { recovered: true, removedBytes: 0, addedNewline: true };
    } catch {
      const lastNewline = raw.lastIndexOf("\n");
      const trimmed = lastNewline === -1 ? "" : raw.substring(0, lastNewline + 1);
      const removedBytes = Buffer.byteLength(raw) - Buffer.byteLength(trimmed);
      await writeFile(file, trimmed, "utf8");
      return { recovered: true, removedBytes };
    }
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { recovered: false, removedBytes: 0 };
    }
    throw err;
  }
}

export async function appendEvent(cpbRoot: string, project: string, jobId: string, event: EventRecord, opts: EventStoreOptions = {}) {
  const tracedEvent = withTraceContext(event, { project, jobId }) as EventRecord;
  // Validate event structure first (throws on invalid input)
  serializeEvent(tracedEvent);

  const redis = await redisEventBackend();
  if (redis) {
    await assertNoLocalEvent(cpbRoot, project, jobId, opts);
    const field = redisJobField(project, jobId);
    const persistable = redisPersistableEvent(tracedEvent, project, jobId);
    const serialized = serializeEvent(persistable);
    for (let retry = 0; retry < 64; retry += 1) {
      const snapshot = await redis.readStateRecord(field);
      const current = snapshot.data === null ? null : snapshot.data as MaterializedJobState;
      if (current && (!isRecord(current) || current.jobId !== jobId || current.project !== project)) {
        throw Object.assign(new Error(`invalid Redis job projection: ${project}/${jobId}`), { code: "HUB_STATE_RECORD_INVALID" });
      }
      const eventType = text(persistable.type);
      if (current && TERMINAL_STATUSES.has(current.status) && !POST_TERMINAL_ALLOWED.has(eventType)) {
        console.warn(`[event-store] skipped ${eventType || "unknown"} on terminal job ${jobId} (status: ${current.status})`);
        return null;
      }
      const projection = current
        ? advanceMaterializedJob(current, persistable)
        : materializeJob([persistable]);
      const committed = await redis.appendJobEvent(field, snapshot.revision, projection, serialized);
      if (!committed.committed) continue;
      await notifyEventWritten({
        cpbRoot, project, jobId, file: `redis:${field}`,
        dataRoot: opts.dataRoot ?? null, event: persistable,
      });
      return persistable;
    }
    throw Object.assign(new Error(`job events changed too frequently: ${project}/${jobId}`), { code: "HUB_STATE_RECORD_CONFLICT" });
  }

  const file = eventFileFor(cpbRoot, project, jobId, opts);

  const written = await withEventLock(file, async () => {
    // Terminal seal: reject business-state mutations on terminal job event logs.
    const existing = await readEvents(cpbRoot, project, jobId, opts.dataRoot ? { ...opts, includeLegacyFallback: false } : opts);
    if (existing.length > 0) {
      const state = materializeJob(existing);
      const eventType = text(tracedEvent.type);
      if (TERMINAL_STATUSES.has(state.status) && !POST_TERMINAL_ALLOWED.has(eventType)) {
        console.warn(`[event-store] skipped ${eventType || "unknown"} on terminal job ${jobId} (status: ${state.status})`);
        return null;
      }
    }

    const writeBlocked = async (artifactName: unknown, reason: string): Promise<EventRecord> => {
      const blocked: EventRecord = makeSecretBlockedEvent(artifactName, reason);
      blocked.jobId = tracedEvent.jobId ?? jobId;
      blocked.project = tracedEvent.project ?? project;
      const tracedBlocked = withTraceContext(blocked, { project, jobId }) as EventRecord;
      const serialized = serializeEvent(tracedBlocked);
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, `${serialized}\n`, "utf8");
      return tracedBlocked;
    };

    // Block secret-like artifacts before persisting
    const artifact = tracedEvent.artifact;
    if (artifact && isSecretPath(artifact)) {
      return writeBlocked(tracedEvent.artifact, "secret-like artifact path blocked");
    }

    // Block events with secret-like content in artifact fields
    if (typeof artifact === "string" && isSecretArtifact(artifact, artifact)) {
      return writeBlocked(artifact, "secret-like artifact content blocked");
    }

    if (typeof artifact === "string") {
      const artifactPayload = [
        tracedEvent.content,
        tracedEvent.output,
        tracedEvent.stdout,
        tracedEvent.stderr,
        tracedEvent.body,
      ].filter((value) => value !== undefined && value !== null);
      if (artifactPayload.some((value) => isSecretContent(typeof value === "string" ? value : JSON.stringify(value)))) {
        return writeBlocked(artifact, "secret-like artifact content blocked");
      }
    }

    // Redact secrets from event payload before persisting
    const redacted = recordValue(redactSecrets(tracedEvent));
    const serialized = serializeEvent(redacted);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${serialized}\n`, "utf8");
    return redacted;
  });
  if (written) {
    await notifyEventWritten({ cpbRoot, project, jobId, file, dataRoot: opts.dataRoot ?? null, event: written });
  }
  return written;
}

async function _parseEventFileReadOnly(file: string): Promise<EventRecord[] | null> {
  try {
    const raw = await readFile(file, "utf8");
    const lines = raw
      .split("\n")
      .map((line, index) => ({ line, lineNumber: index + 1 }))
      .filter(({ line }) => line.trim().length > 0);

    const events: EventRecord[] = [];
    for (const { line, lineNumber } of lines) {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch (err) {
        throw new Error(`malformed event JSON in ${file} at line ${lineNumber}: ${err.message}`);
      }
      if (!isEventRecord(event)) {
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

async function _parseEventFile(file: string): Promise<EventRecord[] | null> {
  try {
    return await _parseEventFileReadOnly(file);
  } catch (err) {
    if (err && err.message && err.message.includes("malformed event JSON")) {
      const raw = await readFile(file, "utf8");
      if (!raw.endsWith("\n")) {
        await truncateCorruptJsonlTail(file, raw);
        return await _parseEventFileReadOnly(file);
      }
    }
    throw err;
  }
}

export async function readEvents(cpbRoot: string, project: string, jobId: string, opts: EventStoreOptions = {}) {
  const redis = await redisEventBackend();
  if (redis) {
    await assertNoLocalEvent(cpbRoot, project, jobId, opts);
    return (await redis.readJobEvents(redisJobField(project, jobId))).map((serialized, index) => {
      try {
        const event = JSON.parse(serialized);
        if (!isEventRecord(event)) throw new Error("expected object");
        return event;
      } catch (error) {
        throw new Error(`Redis job event ${project}/${jobId} at index ${index}: malformed event: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }
  const cachedDataRoot = opts.dataRoot || (opts.legacyOnly !== true ? resolveCachedProjectRuntimeRoot(cpbRoot, project) : null);

  // Try runtime root first when we have one and it differs from legacy.
  if (opts.legacyOnly !== true && cachedDataRoot && cachedDataRoot !== legacyRuntimeRoot(cpbRoot)) {
    const rtFile = eventFileFor(cpbRoot, project, jobId, { ...opts, dataRoot: cachedDataRoot });
    const rtEvents = await _parseEventFile(rtFile);
    if (rtEvents !== null) return rtEvents;
  }
  const includeLegacyFallback = opts.includeLegacyFallback === true || opts.legacyOnly === true;
  if (!includeLegacyFallback) {
    if (!cachedDataRoot) throw new Error("dataRoot is required for project event store paths");
    return [];
  }

  // Legacy path
  const file = eventFileFor(cpbRoot, project, jobId, { legacyOnly: true });
  const result = await _parseEventFile(file);
  return result ?? [];
}

export async function readEventsReadOnly(cpbRoot: string, project: string, jobId: string, opts: EventStoreOptions = {}) {
  const redis = await redisEventBackend();
  if (redis) return await readEvents(cpbRoot, project, jobId, opts);
  const cachedDataRoot = opts.dataRoot || (opts.legacyOnly !== true ? resolveCachedProjectRuntimeRoot(cpbRoot, project) : null);

  if (opts.legacyOnly !== true && cachedDataRoot && cachedDataRoot !== legacyRuntimeRoot(cpbRoot)) {
    const rtFile = eventFileFor(cpbRoot, project, jobId, { ...opts, dataRoot: cachedDataRoot });
    const rtEvents = await _parseEventFileReadOnly(rtFile);
    if (rtEvents !== null) return rtEvents;
  }
  const includeLegacyFallback = opts.includeLegacyFallback === true || opts.legacyOnly === true;
  if (!includeLegacyFallback) {
    if (!cachedDataRoot) throw new Error("dataRoot is required for project event store paths");
    return [];
  }
  const file = eventFileFor(cpbRoot, project, jobId, { legacyOnly: true });
  const result = await _parseEventFileReadOnly(file);
  return result ?? [];
}

function checkpointFileFor(cpbRoot: string, project: string, jobId: string, opts: EventStoreOptions = {}) {
  validatePathComponent("project", project);
  validatePathComponent("jobId", jobId);
  const checkpointsRoot = path.join(_base(cpbRoot, opts), "checkpoints");
  return path.resolve(checkpointsRoot, project, `${jobId}.json`);
}

export async function writeCheckpoint(cpbRoot: string, project: string, jobId: string, state: LooseRecord, opts: EventStoreOptions = {}) {
  const file = checkpointFileFor(cpbRoot, project, jobId, opts);
  await mkdir(path.dirname(file), { recursive: true });
  const checkpoint: LooseRecord = {
    _meta: { version: JOBS_EVENTS_FORMAT_VERSION, writtenAt: new Date().toISOString(), eventCount: null },
    state,
  };
  await writeFile(file, JSON.stringify(checkpoint) + "\n", "utf8");
  return file;
}

export async function readCheckpoint(cpbRoot: string, project: string, jobId: string, opts: EventStoreOptions = {}): Promise<MaterializedJobState | null> {
  // Try runtime root first
  if (opts.legacyOnly !== true && opts.dataRoot && opts.dataRoot !== legacyRuntimeRoot(cpbRoot)) {
    const rtFile = checkpointFileFor(cpbRoot, project, jobId, opts);
    try {
      const raw = await readFile(rtFile, "utf8");
      const parsed = recordValue(JSON.parse(raw));
      return isRecord(parsed.state) ? parsed.state as MaterializedJobState : null;
    } catch {}
  }
  const includeLegacyFallback = opts.includeLegacyFallback === true || opts.legacyOnly === true;
  if (!includeLegacyFallback) {
    if (!opts.dataRoot) throw new Error("dataRoot is required for project event store paths");
    return null;
  }
  const file = checkpointFileFor(cpbRoot, project, jobId, { legacyOnly: true });
  try {
    const raw = await readFile(file, "utf8");
    const parsed = recordValue(JSON.parse(raw));
    return isRecord(parsed.state) ? parsed.state as MaterializedJobState : null;
  } catch {
    return null;
  }
}

export async function deleteCheckpoint(cpbRoot: string, project: string, jobId: string, opts: EventStoreOptions = {}) {
  const file = checkpointFileFor(cpbRoot, project, jobId, opts);
  await rm(file, { force: true });
}

export async function checkpointJob(cpbRoot: string, project: string, jobId: string, opts: EventStoreOptions = {}) {
  const events = await readEvents(cpbRoot, project, jobId, opts);
  if (events.length === 0) return null;
  const state = materializeJob(events);
  if (!TERMINAL_STATUSES.has(state.status)) return null;
  await writeCheckpoint(cpbRoot, project, jobId, state, opts);
  return state;
}
