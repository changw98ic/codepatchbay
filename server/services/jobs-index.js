import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { runtimeDataPath } from "./runtime-root.js";
import { listEventFiles, materializeJob, readEvents } from "./event-store.js";

const INDEX_VERSION = 1;

function indexFilePath(cpbRoot) {
  return path.join(runtimeDataPath(cpbRoot), "jobs-index.json");
}

function tempIndexFilePath(cpbRoot) {
  return path.join(runtimeDataPath(cpbRoot), "jobs-index.tmp");
}

function compositeKey(project, jobId) {
  return `${project}/${jobId}`;
}

export async function readJobsIndex(cpbRoot) {
  try {
    const raw = await readFile(indexFilePath(cpbRoot), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || parsed._meta?.version !== INDEX_VERSION || typeof parsed.jobs !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeJobsIndex(cpbRoot, index) {
  const target = indexFilePath(cpbRoot);
  const tmp = tempIndexFilePath(cpbRoot);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(tmp, JSON.stringify(index) + "\n", "utf8");
  await rename(tmp, target);
}

export async function updateJobsIndexEntry(cpbRoot, project, jobId, state) {
  const index = await readJobsIndex(cpbRoot) || {
    _meta: { version: INDEX_VERSION, updatedAt: null, jobCount: 0 },
    jobs: {},
  };

  index.jobs[compositeKey(project, jobId)] = state;
  index._meta.updatedAt = new Date().toISOString();
  index._meta.jobCount = Object.keys(index.jobs).length;

  await writeJobsIndex(cpbRoot, index);
}

export async function rebuildJobsIndex(cpbRoot) {
  const files = await listEventFiles(cpbRoot);
  const jobs = {};

  for (const { project, jobId } of files) {
    const events = await readEvents(cpbRoot, project, jobId);
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

  await writeJobsIndex(cpbRoot, index);
  return index;
}

export async function listJobsFromIndex(cpbRoot) {
  let index = await readJobsIndex(cpbRoot);
  if (!index) {
    index = await rebuildJobsIndex(cpbRoot);
  }

  return Object.values(index.jobs)
    .filter((job) => job.createdAt && job.project && job.jobId)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}
