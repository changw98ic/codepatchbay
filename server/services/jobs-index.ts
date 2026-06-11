import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { runtimeDataPath, runtimeDataRoot } from "./runtime-root.js";
import { listEventFiles, materializeJob, readEvents } from "./event-store.js";

const INDEX_VERSION = 1;

const LOCK_TTL_MS = 30_000;

// Cross-process file lock using mkdir (same pattern as hub-queue.js, inbox-mail.js)
async function withIndexLock(lockDir, callback) {
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
        if (Date.now() - info.mtimeMs >= LOCK_TTL_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Race: someone else removed it, retry
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  if (!acquired) throw new Error(`jobs-index lock busy: ${path.basename(lockDir)}`);
  try {
    return await callback();
  } finally {
    try { await rm(lockDir, { recursive: true, force: true }); } catch {}
  }
}

// In-memory promise-chain lock: serializes concurrent index writes per cpbRoot.
// Each cpbRoot gets its own chain; callers wait for the previous write to settle.
const _writeQueues = new Map();

function enqueueWrite(cpbRoot, opts, fn) {
  const key = indexFilePath(cpbRoot, opts);
  const lockDir = `${key}.lock`;
  // prev is always a settled promise (either resolved or catch'd to resolved)
  const prev = _writeQueues.get(key) || Promise.resolve();
  const next = prev.then(() => withIndexLock(lockDir, fn));
  // Store a never-rejecting tail so the next writer always proceeds
  _writeQueues.set(key, next.catch(() => {}));
  return next;
}

function _base(cpbRoot, opts) {
  return opts?.dataRoot || process.env.CPB_PROJECT_RUNTIME_ROOT || runtimeDataRoot(cpbRoot);
}

function indexFilePath(cpbRoot, opts = {}) {
  return path.join(_base(cpbRoot, opts), "jobs-index.json");
}

function tempIndexFilePath(cpbRoot, opts = {}) {
  return path.join(_base(cpbRoot, opts), "jobs-index.tmp");
}

function compositeKey(project, jobId) {
  return `${project}/${jobId}`;
}

export async function readJobsIndex(cpbRoot, opts = {}) {
  try {
    const raw = await readFile(indexFilePath(cpbRoot, opts), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || parsed._meta?.version !== INDEX_VERSION || typeof parsed.jobs !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeJobsIndex(cpbRoot, index, opts = {}) {
  const target = indexFilePath(cpbRoot, opts);
  const tmp = tempIndexFilePath(cpbRoot, opts);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(tmp, JSON.stringify(index) + "\n", "utf8");
  await rename(tmp, target);
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
  const files = await listEventFiles(cpbRoot, opts);
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

  await writeJobsIndex(cpbRoot, index, opts);
  return index;
}

async function mergeMissingEventStreams(cpbRoot, index, opts = {}) {
  const files = await listEventFiles(cpbRoot, opts);
  let changed = false;

  for (const { project, jobId } of files) {
    const key = compositeKey(project, jobId);
    if (index.jobs[key]) continue;
    const events = await readEvents(cpbRoot, project, jobId, opts);
    if (events.length === 0) continue;
    const state = materializeJob(events);
    if (state.createdAt && state.project && state.jobId) {
      index.jobs[key] = state;
      changed = true;
    }
  }

  if (changed) {
    index._meta.updatedAt = new Date().toISOString();
    index._meta.jobCount = Object.keys(index.jobs).length;
    await writeJobsIndex(cpbRoot, index, opts);
  }

  return index;
}

export async function listJobsFromIndex(cpbRoot, opts = {}) {
  let index = await readJobsIndex(cpbRoot, opts);
  if (!index) {
    index = await rebuildJobsIndex(cpbRoot, opts);
  } else {
    index = await mergeMissingEventStreams(cpbRoot, index, opts);
  }

  return Object.values(index.jobs)
    .map((job) => job as Record<string, any>)
    .filter((job) => job.createdAt && job.project && job.jobId)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}
