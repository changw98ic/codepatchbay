import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { runtimeDataPath } from "./runtime-root.js";

export const PROCESS_REGISTRY_FORMAT_VERSION = 1;

function validateId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value)) {
    throw new Error(`invalid ${label}: ${value}`);
  }
}

function processDir(cpbRoot) {
  return runtimeDataPath(cpbRoot, "processes");
}

function processFile(cpbRoot, jobId) {
  validateId(jobId, "jobId");
  return path.join(processDir(cpbRoot), `${jobId}.json`);
}

function nowIso() {
  return new Date().toISOString();
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tmp, file);
}

export async function registerProcess(cpbRoot, { jobId, project, phase, runnerPid, treeId, leaseId, command, startedAt, cwd, executorRoot } = {}) {
  validateId(jobId, "jobId");
  const file = processFile(cpbRoot, jobId);
  const entry = {
    jobId,
    project: project || null,
    phase: phase || null,
    runnerPid: runnerPid || process.pid,
    treeId: treeId || null,
    childPids: [],
    leaseId: leaseId || null,
    startedAt: startedAt || nowIso(),
    lastHeartbeat: nowIso(),
    status: "running",
    exitCode: null,
    command: command || null,
    cwd: cwd || null,
    executorRoot: executorRoot || null,
  };
  await writeJson(file, entry);
  return entry;
}

export async function updateHeartbeat(cpbRoot, jobId) {
  const file = processFile(cpbRoot, jobId);
  const entry = await readJson(file);
  if (!entry) return null;
  entry.lastHeartbeat = nowIso();
  await writeJson(file, entry);
  return entry;
}

export async function markExited(cpbRoot, jobId, { exitCode, status = "exited" } = {}) {
  const file = processFile(cpbRoot, jobId);
  const entry = await readJson(file);
  if (!entry) return null;
  entry.status = status;
  entry.exitCode = exitCode ?? null;
  await writeJson(file, entry);
  return entry;
}

export async function addChildPid(cpbRoot, jobId, childPid) {
  const file = processFile(cpbRoot, jobId);
  const entry = await readJson(file);
  if (!entry) return null;
  if (!entry.childPids.includes(childPid)) {
    entry.childPids.push(childPid);
  }
  await writeJson(file, entry);
  return entry;
}

export async function getProcess(cpbRoot, jobId) {
  return readJson(processFile(cpbRoot, jobId));
}

export async function listProcesses(cpbRoot) {
  const dir = processDir(cpbRoot);
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const results = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const entry = await readJson(path.join(dir, name));
    if (entry) {
      entry.liveness = classifyLiveness(entry);
      entry.ageMs = computeAge(entry);
      results.push(entry);
    }
  }
  return results;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: process does not exist → dead
    // EPERM: process exists but no permission → alive
    if (err.code === "EPERM") return true;
    return false;
  }
}

export function computeAge(entry) {
  if (!entry?.startedAt) return null;
  const started = new Date(entry.startedAt).getTime();
  if (Number.isNaN(started)) return null;
  return Date.now() - started;
}

export function classifyLiveness(entry, { staleThresholdMs = 180_000 } = {}) {
  if (!entry) return "unknown";
  if (entry.status === "exited" || entry.status === "stopped") return entry.status;

  const { runnerPid } = entry;
  if (!isProcessAlive(runnerPid)) return "orphan";

  const lastHb = new Date(entry.lastHeartbeat).getTime();
  if (Number.isNaN(lastHb)) return "unknown";
  const age = Date.now() - lastHb;
  if (age > staleThresholdMs) return "stale";

  return "alive";
}

export async function stopProcess(cpbRoot, jobId) {
  const entry = await getProcess(cpbRoot, jobId);
  if (!entry) return { stopped: false, reason: "not found" };

  const { project } = entry;
  const ts = nowIso();

  async function audit(type, extra = {}) {
    if (!project) return;
    try {
      const { appendEvent } = await import("./event-store.js");
      await appendEvent(cpbRoot, project, jobId, { type, jobId, project, runnerPid: entry.runnerPid, ts, ...extra });
    } catch {}
  }

  if (entry.status === "exited" || entry.status === "stopped") {
    await audit("process_stop_skipped", { reason: `already ${entry.status}` });
    return { stopped: false, reason: `already ${entry.status}` };
  }

  if (!isProcessAlive(entry.runnerPid)) {
    await markExited(cpbRoot, jobId, { status: "orphan" });
    await audit("process_marked_orphan");
    return { stopped: false, reason: "process already dead (marked orphan)" };
  }

  // Verify PID identity: check the process is still the same one we registered
  // by checking the process start time hasn't changed
  try {
    const procStat = await stat(`/proc/${entry.runnerPid}`);
    const registeredAt = new Date(entry.startedAt).getTime();
    if (procStat.birthtimeMs > registeredAt + 5000) {
      await audit("process_stop_skipped", { reason: "PID recycled: process identity mismatch" });
      return { stopped: false, reason: "PID recycled: process identity mismatch" };
    }
  } catch {
    // /proc not available (macOS), rely on PID being alive
  }

  const pids = [entry.runnerPid, ...entry.childPids];
  await audit("process_stop_requested", { signaledPids: pids });

  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }

  await new Promise((r) => setTimeout(r, 2000));

  for (const pid of pids) {
    if (isProcessAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }

  await markExited(cpbRoot, jobId, { exitCode: -15, status: "stopped" });
  await audit("process_stopped", { signaledPids: pids });
  return { stopped: true, jobId, signaledPids: pids };
}

export async function cleanProcesses(cpbRoot, { dryRun = false } = {}) {
  const entries = await listProcesses(cpbRoot);
  const eligible = [];

  for (const entry of entries) {
    const liveness = classifyLiveness(entry);
    if (liveness === "exited" || liveness === "orphan") {
      eligible.push(entry);
    }
  }

  if (dryRun) {
    return { dryRun: true, removed: [], eligible };
  }

  const removed = [];
  for (const entry of eligible) {
    const file = processFile(cpbRoot, entry.jobId);
    await rm(file, { force: true });
    removed.push(entry.jobId);
  }
  return { dryRun: false, removed, eligible };
}

export async function removeProcess(cpbRoot, jobId, { dryRun = false } = {}) {
  validateId(jobId, "jobId");
  const file = processFile(cpbRoot, jobId);
  if (dryRun) {
    const entry = await readJson(file);
    return { removed: false, wouldRemove: !!entry, jobId };
  }
  await rm(file, { force: true });
  return { removed: true, jobId };
}

export async function inspectProcess(cpbRoot, jobId) {
  const entry = await getProcess(cpbRoot, jobId);
  const liveness = entry ? classifyLiveness(entry) : null;

  let leaseState = null;
  if (entry?.leaseId) {
    try {
      const { readLease, isLeaseStale } = await import("./lease-manager.js");
      const lease = await readLease(cpbRoot, entry.leaseId);
      if (lease) {
        leaseState = {
          leaseId: entry.leaseId,
          stale: isLeaseStale(lease),
          expiresAt: lease.expiresAt,
          phase: lease.phase,
        };
      }
    } catch {}
  }

  // Derive project from process entry or search all jobs
  let project = entry?.project || null;
  let job = null;

  try {
    const { getJob, listJobs } = await import("./job-store.js");
    if (project) {
      job = await getJob(cpbRoot, project, jobId);
      if (job && !job.jobId) job = null;
    }
    if (!job) {
      const allJobs = await listJobs(cpbRoot);
      job = allJobs.find((j) => j.jobId === jobId) || null;
      if (job && !project) project = job.project;
    }
  } catch {}

  let recentEvents = [];
  if (project) {
    try {
      const { readEvents } = await import("./event-store.js");
      const events = await readEvents(cpbRoot, project, jobId);
      recentEvents = events.slice(-10);
    } catch {}
  }

  let lineage = job?.lineage || null;

  // Build ancestors chain (bounded to depth 5) and children
  let ancestors = [];
  let children = [];
  try {
    const { listJobs: listAllJobs, getJob } = await import("./job-store.js");
    const allJobs = await listAllJobs(cpbRoot);
    // Children: jobs whose lineage.parentJobId === this jobId
    children = allJobs.filter((j) => j.lineage?.parentJobId === jobId);

    // Ancestors: walk lineage.parentJobId chain
    if (lineage?.parentJobId) {
      const ancestorMap = new Map(allJobs.map((j) => [j.jobId, j]));
      let curId = lineage.parentJobId;
      let depth = 0;
      while (curId && depth < 5) {
        const ancestor = ancestorMap.get(curId);
        if (!ancestor) break;
        ancestors.push(ancestor);
        curId = ancestor.lineage?.parentJobId || null;
        depth++;
      }
    }
  } catch {}

  if (!entry && !job) return null;

  let policyState = null;
  if (job) {
    try {
      const { getPhasePolicy } = await import("./permission-matrix.js");
      const role = entry?.phase ? { plan: "planner", execute: "executor", verify: "verifier", review: "reviewer", repair: "repairer" }[entry.phase] : null;
      if (role) {
        const sp = job.worktree || process.env.CPB_PROJECT_PATH_OVERRIDE || null;
        let profileConfig = null;
        try {
          const { loadProfile } = await import("./profile-loader.js");
          const profile = await loadProfile(cpbRoot, role);
          profileConfig = profile.permissions || null;
        } catch {}
        policyState = getPhasePolicy(role, cpbRoot, project, { sourcePath: sp, profileConfig });
      }
    } catch {}
  }

  return {
    process: entry,
    job,
    liveness,
    lease: leaseState,
    recentEvents,
    lineage,
    ancestors,
    children,
    policy: policyState,
  };
}
