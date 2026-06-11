import { appendFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { buildMeta } from "../../core/job/meta.js";

type AnyRecord = Record<string, any>;

function nowIso() {
  return new Date().toISOString();
}

function dispatchDir(hubRoot) {
  return path.join(path.resolve(hubRoot), "dispatches");
}

function dispatchFile(hubRoot, dispatchId) {
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

const mutationChains = new Map<string, Promise<any>>();

async function withDispatchFileLock(hubRoot: string, dispatchId: string, fn: () => Promise<any>) {
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

function serialized(hubRoot: string, dispatchId: string, fn: () => Promise<any>) {
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

export async function deleteDispatchFile(hubRoot, dispatchId) {
  const file = dispatchFile(hubRoot, dispatchId);
  await rm(file, { force: true });
}
