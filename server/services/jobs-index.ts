import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { listEventFiles, materializeJob, readEvents } from "./event-store.js";

const INDEX_VERSION = 1;

const LOCK_TTL_MS = 30_000;
const LOCK_POLL_MS = 25;

function nowIso() {
  return new Date().toISOString();
}

function makeLockOwner() {
  return {
    acquiredAt: nowIso(),
    heartbeatAt: nowIso(),
    ownerPid: process.pid,
    ownerToken: `${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`,
  };
}

async function writeLockMetadata(lockDir, owner) {
  await writeFile(
    path.join(lockDir, "lock.json"),
    `${JSON.stringify({ ...owner, heartbeatAt: nowIso() }, null, 2)}\n`,
    "utf8"
  );
}

async function lockMetadata(lockDir) {
  try {
    const raw = await readFile(path.join(lockDir, "lock.json"), "utf8");
    const lock = JSON.parse(raw);
    return lock && typeof lock === "object" ? lock : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

async function indexLockIsStale(lockDir) {
  const now = Date.now();
  const lock = await lockMetadata(lockDir);
  if (lock) {
    if (processIsAlive(lock.ownerPid)) return false;
    const observedAt = Date.parse(lock.heartbeatAt || lock.acquiredAt || "");
    return Number.isNaN(observedAt) || now - observedAt >= LOCK_TTL_MS;
  }
  try {
    const info = await stat(lockDir);
    return now - info.mtimeMs >= LOCK_TTL_MS;
  } catch {
    return false;
  }
}

async function indexLockOwnerToken(lockDir) {
  const lock = await lockMetadata(lockDir);
  return lock?.ownerToken || null;
}

// Cross-process file lock using mkdir (same pattern as hub-queue.js, inbox-mail.js)
async function withIndexLock(lockDir, callback) {
  await mkdir(path.dirname(lockDir), { recursive: true });
  const owner = makeLockOwner();
  const deadline = Date.now() + LOCK_TTL_MS + LOCK_POLL_MS;
  let acquired = false;
  while (Date.now() < deadline) {
    try {
      await mkdir(lockDir);
      await writeLockMetadata(lockDir, owner);
      acquired = true;
      break;
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      if (await indexLockIsStale(lockDir)) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
  }
  if (!acquired) throw new Error(`jobs-index lock busy: ${path.basename(lockDir)}`);

  const heartbeat = setInterval(() => {
    writeLockMetadata(lockDir, owner).catch(() => {});
  }, Math.max(1_000, Math.floor(LOCK_TTL_MS / 3)));
  heartbeat.unref?.();

  try {
    return await callback();
  } finally {
    clearInterval(heartbeat);
    try {
      if (await indexLockOwnerToken(lockDir) === owner.ownerToken) {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch {}
  }
}

// In-memory promise-chain lock: serializes concurrent index writes per cpbRoot.
// Each cpbRoot gets its own chain; callers wait for the previous write to settle.
const _writeQueues = new Map();
const _mergeQueues = new Map();

function enqueueWrite(cpbRoot, opts, fn) {
  const key = indexFilePath(cpbRoot, opts);
  const lockDir = `${key}.lock`;
  // prev is always a settled promise (either resolved or catch'd to resolved)
  const prev = _writeQueues.get(key) || Promise.resolve();
  const next = prev.then(() => withIndexLock(lockDir, fn));
  // Store a never-rejecting tail so the next writer always proceeds
  const tail = next.catch(() => {});
  _writeQueues.set(key, tail);
  tail.finally(() => {
    if (_writeQueues.get(key) === tail) _writeQueues.delete(key);
  });
  return next;
}

function legacyIndexRoot(cpbRoot) {
  return path.join(path.resolve(cpbRoot), "cpb-task");
}

function _base(cpbRoot, opts: Record<string, any> = {}) {
  if (opts?.dataRoot) return path.resolve(opts.dataRoot);
  if (opts?.legacyOnly === true || opts?.includeLegacyFallback === true) {
    return legacyIndexRoot(cpbRoot);
  }
  throw new Error("dataRoot is required for project jobs-index paths");
}

function indexFilePath(cpbRoot, opts = {}) {
  return path.join(_base(cpbRoot, opts), "jobs-index.json");
}

function tempIndexFilePath(cpbRoot, opts = {}) {
  return path.join(
    _base(cpbRoot, opts),
    `jobs-index.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`
  );
}

function compositeKey(project, jobId) {
  return `${project}/${jobId}`;
}

function strictRuntimeScope(opts) {
  return opts?.includeLegacyFallback === false || (opts?.dataRoot && opts.includeLegacyFallback !== true);
}

function strictScopeKeys(opts, files) {
  if (!strictRuntimeScope(opts)) return null;
  return new Set(files.map(({ project, jobId }) => compositeKey(project, jobId)));
}

async function currentStrictScopeKeys(cpbRoot, opts) {
  if (!strictRuntimeScope(opts)) return null;
  return strictScopeKeys(opts, await listEventFiles(cpbRoot, opts));
}

function filterIndexToScope(index, allowedKeys) {
  if (!allowedKeys) return index;

  let removed = false;
  const jobs = {};
  for (const [key, job] of Object.entries(index.jobs)) {
    if (allowedKeys.has(key)) {
      jobs[key] = job;
    } else {
      removed = true;
    }
  }
  if (!removed) return index;

  return {
    ...index,
    _meta: {
      ...index._meta,
      jobCount: Object.keys(jobs).length,
    },
    jobs,
  };
}

function isoTime(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

function isNewerJob(candidate, current) {
  return isoTime(candidate?.updatedAt ?? candidate?.createdAt) >= isoTime(current?.updatedAt ?? current?.createdAt);
}

function mergeConcurrentUpdates(index, latest, scanStartedAt) {
  if (!latest?.jobs || typeof latest.jobs !== "object") return index;
  const scanStartedMs = isoTime(scanStartedAt);
  for (const [key, latestJob] of Object.entries(latest.jobs)) {
    const latestJobMs = isoTime((latestJob as Record<string, any>)?.updatedAt ?? (latestJob as Record<string, any>)?.createdAt);
    if (latestJobMs < scanStartedMs) continue;
    const current = index.jobs[key];
    if (!current || isNewerJob(latestJob, current)) {
      index.jobs[key] = latestJob;
    }
  }
  index._meta.jobCount = Object.keys(index.jobs).length;
  return index;
}

async function singleFlight(map, key, fn) {
  const active = map.get(key);
  if (active) return active;
  const next = fn().finally(() => {
    if (map.get(key) === next) map.delete(key);
  });
  map.set(key, next);
  return next;
}

export async function readJobsIndex(cpbRoot, opts = {}) {
  const target = indexFilePath(cpbRoot, opts);
  try {
    const raw = await readFile(target, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || parsed._meta?.version !== INDEX_VERSION || typeof parsed.jobs !== "object") {
      return null;
    }
    return parsed;
  } catch (err) {
    if (err?.code === "ENOENT" || err instanceof SyntaxError) {
      return null;
    }
    throw err;
  }
}

async function writeJobsIndex(cpbRoot, index, opts = {}) {
  const target = indexFilePath(cpbRoot, opts);
  const tmp = tempIndexFilePath(cpbRoot, opts);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(tmp, JSON.stringify(index) + "\n", "utf8");
    await rename(tmp, target);
  } catch (err) {
    try { await rm(tmp, { force: true }); } catch {}
    throw err;
  }
}

export async function updateJobsIndexEntry(cpbRoot, project, jobId, state, opts = {}) {
  return enqueueWrite(cpbRoot, opts, async () => {
    // Re-read latest index while holding the lock
    const index = await readJobsIndex(cpbRoot, opts) || {
      _meta: { version: INDEX_VERSION, updatedAt: null, jobCount: 0 },
      jobs: {},
    };

    index.jobs[compositeKey(project, jobId)] = state;
    index._meta.updatedAt = new Date().toISOString();
    index._meta.jobCount = Object.keys(index.jobs).length;

    await writeJobsIndex(cpbRoot, index, opts);
  });
}

export async function rebuildJobsIndex(cpbRoot, opts = {}) {
  const scanStartedAt = new Date().toISOString();
  const files = await listEventFiles(cpbRoot, opts);
  const allowedKeys = strictScopeKeys(opts, files);
  const jobs = {};

  for (const { project, jobId } of files) {
    const events = await readEvents(cpbRoot, project, jobId, opts);
    if (events.length === 0) continue;
    const state = materializeJob(events);
    if (state.createdAt && state.project && state.jobId) {
      jobs[compositeKey(project, jobId)] = state;
    }
  }

  const index = {
    _meta: {
      version: INDEX_VERSION,
      updatedAt: new Date().toISOString(),
      jobCount: Object.keys(jobs).length,
    },
    jobs,
  };

  return enqueueWrite(cpbRoot, opts, async () => {
    mergeConcurrentUpdates(index, await readJobsIndex(cpbRoot, opts), scanStartedAt);
    const scopedIndex = filterIndexToScope(index, await currentStrictScopeKeys(cpbRoot, opts) || allowedKeys);
    scopedIndex._meta.updatedAt = new Date().toISOString();
    await writeJobsIndex(cpbRoot, scopedIndex, opts);
    return scopedIndex;
  });
}

async function mergeMissingEventStreams(cpbRoot, index, opts = {}) {
  const key = indexFilePath(cpbRoot, opts);
  return singleFlight(_mergeQueues, key, () => mergeMissingEventStreamsOnce(cpbRoot, index, opts));
}

async function mergeMissingEventStreamsOnce(cpbRoot, index, opts = {}) {
  index = await readJobsIndex(cpbRoot, opts) || index;
  const files = await listEventFiles(cpbRoot, opts);
  const allowedKeys = strictScopeKeys(opts, files);
  const missing = [];

  for (const { project, jobId } of files) {
    const key = compositeKey(project, jobId);
    if (index.jobs[key]) continue;
    const events = await readEvents(cpbRoot, project, jobId, opts);
    if (events.length === 0) continue;
    const state = materializeJob(events);
    if (state.createdAt && state.project && state.jobId) {
      missing.push({ key, state });
    }
  }

  if (missing.length > 0 || allowedKeys) {
    return enqueueWrite(cpbRoot, opts, async () => {
      const latest = await readJobsIndex(cpbRoot, opts) || index;
      let changed = false;

      for (const { key, state } of missing) {
        if (latest.jobs[key]) continue;
        latest.jobs[key] = state;
        changed = true;
      }

      const scopedLatest = filterIndexToScope(latest, await currentStrictScopeKeys(cpbRoot, opts) || allowedKeys);
      if (scopedLatest !== latest) changed = true;

      if (changed) {
        scopedLatest._meta.updatedAt = new Date().toISOString();
        scopedLatest._meta.jobCount = Object.keys(scopedLatest.jobs).length;
        await writeJobsIndex(cpbRoot, scopedLatest, opts);
      }

      return scopedLatest;
    });
  }

  return index;
}

export async function listJobsFromIndex(cpbRoot, opts: Record<string, any> = {}) {
  let index = await readJobsIndex(cpbRoot, opts);
  if (!index) {
    index = await rebuildJobsIndex(cpbRoot, opts);
  } else {
    index = await mergeMissingEventStreams(cpbRoot, index, opts);
  }

  const dataRoot = opts?.dataRoot ? path.resolve(opts.dataRoot) : null;
  return Object.values(index.jobs)
    .map((job) => job as Record<string, any>)
    .map((job) => dataRoot ? { ...job, dataRoot: job.dataRoot || dataRoot, _dataRoot: job._dataRoot || dataRoot } : job)
    .filter((job) => job.createdAt && job.project && job.jobId)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}
