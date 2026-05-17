import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { buildMeta } from "./execution-meta.js";

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

export function makeDispatchId(ts = nowIso(), suffix = randomBytes(3).toString("hex")) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) throw new Error("invalid timestamp");
  const compact = date.toISOString().replace(/[-:]/g, "");
  return `dispatch-${compact.slice(0, 8)}-${compact.slice(9, 15)}-${suffix}`;
}

async function appendDispatchEvent(hubRoot, dispatchId, event) {
  const file = dispatchFile(hubRoot, dispatchId);
  await mkdir(path.dirname(file), { recursive: true });
  const serialized = JSON.stringify(event);
  await appendFile(file, `${serialized}\n`, "utf8");
  return event;
}

async function readDispatchEvents(hubRoot, dispatchId) {
  const file = dispatchFile(hubRoot, dispatchId);
  try {
    const raw = await readFile(file, "utf8");
    return raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

const POST_TERMINAL = new Set(["dispatch_failed"]);

export function materializeDispatch(events) {
  const state = {
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
    if (event.dispatchId !== undefined) state.dispatchId = event.dispatchId;
    if (event.projectId !== undefined) state.projectId = event.projectId;
    if (event.sourcePath !== undefined) state.sourcePath = event.sourcePath;
    if (event.sessionId !== undefined) state.sessionId = event.sessionId;
    if (event.cwd !== undefined) state.cwd = event.cwd;
    if (event.ts !== undefined) state.updatedAt = event.ts;

    if (terminal && !POST_TERMINAL.has(event.type)) continue;

    switch (event.type) {
      case "dispatch_created":
        state.queueEntryId = event.queueEntryId ?? null;
        state.workerId = event.workerId ?? null;
        state.status = "pending";
        state.createdAt = event.ts ?? state.createdAt;
        terminal = false;
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

export async function createDispatch(hubRoot, { projectId, sourcePath, sessionId, workerId, queueEntryId, ts = nowIso() } = {}) {
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

export async function getDispatch(hubRoot, dispatchId) {
  const events = await readDispatchEvents(hubRoot, dispatchId);
  if (events.length === 0) return null;
  return materializeDispatch(events);
}

export async function assignWorker(hubRoot, dispatchId, { workerId, ts = nowIso() } = {}) {
  await appendDispatchEvent(hubRoot, dispatchId, {
    type: "dispatch_worker_assigned",
    dispatchId,
    workerId: workerId || null,
    ts,
  });
  return getDispatch(hubRoot, dispatchId);
}

export async function startDispatch(hubRoot, dispatchId, { ts = nowIso() } = {}) {
  await appendDispatchEvent(hubRoot, dispatchId, {
    type: "dispatch_started",
    dispatchId,
    ts,
  });
  return getDispatch(hubRoot, dispatchId);
}

export async function completeDispatch(hubRoot, dispatchId, { ts = nowIso() } = {}) {
  await appendDispatchEvent(hubRoot, dispatchId, {
    type: "dispatch_completed",
    dispatchId,
    ts,
  });
  return getDispatch(hubRoot, dispatchId);
}

export async function failDispatch(hubRoot, dispatchId, { ts = nowIso() } = {}) {
  await appendDispatchEvent(hubRoot, dispatchId, {
    type: "dispatch_failed",
    dispatchId,
    ts,
  });
  return getDispatch(hubRoot, dispatchId);
}

export async function listDispatches(hubRoot, { projectId, status } = {}) {
  const dir = dispatchDir(hubRoot);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
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
