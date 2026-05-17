import { readFile, rm } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import {
  loadState,
  appendHistory,
  loadBacklog,
  saveState,
} from "../services/evolve-state.js";

let activeProcess = null;

// Promise-based mutex to prevent concurrent /evolve/start spawns.
// Without this, two simultaneous requests can both pass resolveRunningState()
// before either sets activeProcess, resulting in duplicate child processes
// and a stale activeProcess reference.
class Mutex {
  #queue = Promise.resolve();
  acquire() {
    let release;
    const next = new Promise((r) => { release = r; });
    const prev = this.#queue;
    this.#queue = this.#queue.then(() => next);
    return prev.then(() => release);
  }
}
const startMutex = new Mutex();

const leaseMetaPath = (cpbRoot) => path.join(cpbRoot, "cpb-task", "self-evolve", ".controller-lock", "meta.json");

function isPidAlive(pid) {
  try {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isSelfEvolveProcess(pid) {
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    return cmd.includes("self-evolve.mjs");
  } catch {
    return false;
  }
}

async function getControllerLease(cpbRoot) {
  try {
    const raw = await readFile(leaseMetaPath(cpbRoot), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function getRunningController(cpbRoot) {
  const lease = await getControllerLease(cpbRoot);
  const leasedPid = lease?.pid ? Number(lease.pid) : null;
  if (leasedPid && isPidAlive(leasedPid)) {
    return { pid: leasedPid, source: "lease", startedAt: lease.startedAt || null };
  }

  return null;
}

async function resolveRunningState(cpbRoot) {
  if (activeProcess) {
    return { running: true, pid: activeProcess.pid, source: "ui-process", startedAt: null };
  }

  const lease = await getRunningController(cpbRoot);
  if (!lease) return { running: false, pid: null, source: null, startedAt: null };
  return { ...lease, running: true };
}

function evolveScriptPath(cpbRoot) {
  return path.join(cpbRoot, "bridges", "self-evolve.mjs");
}

async function readHistory(cpbRoot) {
  const filePath = path.join(cpbRoot, "cpb-task", "self-evolve", "history.jsonl");
  try {
    const raw = await readFile(filePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
}

function toResponseState(state, runningState) {
  return {
    status: state.status,
    round: state.round,
    maxRounds: state.maxRounds,
    knownGoodCommit: state.knownGoodCommit,
    running: runningState.running,
    pid: runningState.pid,
    source: runningState.source,
    leaseStartedAt: runningState.startedAt,
    updatedAt: state.updatedAt,
  };
}

export async function evolveRoutes(fastify, opts) {
  const getState = async (req) => {
    const state = await loadState(req.cpbRoot);
    const runningState = await resolveRunningState(req.cpbRoot);
    return toResponseState(state, runningState);
  };

  fastify.get("/evolve/status", async (req) => {
    return getState(req);
  });

  fastify.get("/evolve/history", async (req) => {
    return readHistory(req.cpbRoot);
  });

  fastify.post("/evolve/start", async (req, res) => {
    // Fast-path check outside lock to avoid contention on the common case
    const quickCheck = await resolveRunningState(req.cpbRoot);
    if (quickCheck.running) {
      throw fastify.httpErrors.conflict("self-evolve already running");
    }

    const release = await startMutex.acquire();
    try {
      // Authoritative double-check inside the critical section
      const runningState = await resolveRunningState(req.cpbRoot);
      if (runningState.running) {
        throw fastify.httpErrors.conflict("self-evolve already running");
      }

      const state = await loadState(req.cpbRoot);
      const backlog = await loadBacklog(req.cpbRoot);
      const isIdle = !state.status || state.status === "idle" || state.status === "stopped" || state.status === "completed" || state.status === "error" || state.status === "failed";
      if (!isIdle && state.status !== "running" && state.round > 0) {
        throw fastify.httpErrors.conflict(`cannot start while status is ${state.status}`);
      }

      const script = evolveScriptPath(req.cpbRoot);
      let child;
      try {
        child = spawn("node", [script], {
          cwd: req.cpbRoot,
          env: { ...process.env, CPB_ROOT: req.cpbRoot },
          stdio: ["ignore", "pipe", "pipe"],
          detached: false,
        });
      } catch (err) {
        state.status = "failed";
        await saveState(req.cpbRoot, state);
        throw fastify.httpErrors.internalServerError(`spawn failed: ${err.message}`);
      }

      state.status = "starting";
      await saveState(req.cpbRoot, state);

      child.on("error", async (err) => {
        if (activeProcess === child) activeProcess = null;
        const s = await loadState(req.cpbRoot);
        if (s.status === "starting") {
          s.status = "failed";
          await saveState(req.cpbRoot, s);
        }
        process.stderr.write(`[self-evolve] spawn error: ${err.message}\n`);
      });

      child.stdout.on("data", (chunk) => {
        process.stdout.write(`[self-evolve] ${chunk}`);
      });
      child.stderr.on("data", (chunk) => {
        process.stderr.write(`[self-evolve] ${chunk}`);
      });
      child.on("exit", async (code) => {
        if (activeProcess === child) activeProcess = null;
        if (code !== 0) {
          const s = await loadState(req.cpbRoot);
          if (s.status === "starting") {
            s.status = "failed";
            await saveState(req.cpbRoot, s);
          }
        }
      });
      activeProcess = child;

      await appendHistory(req.cpbRoot, {
        action: "start",
        source: "ui",
        backlog: backlog.length,
      });

      res.code(202);
      return { accepted: true, pid: child.pid, status: toResponseState(await loadState(req.cpbRoot), await resolveRunningState(req.cpbRoot)) };
    } finally {
      release();
    }
  });

  fastify.post("/evolve/stop", async (req) => {
    const runningState = await resolveRunningState(req.cpbRoot);
    if (!runningState.running) {
      return { stopped: false, reason: "not_running" };
    }

    const logCtx = {
      pid: runningState.pid,
      source: runningState.source,
      leaseStartedAt: runningState.startedAt,
    };
    let sigtermSent = false;

    if (activeProcess && runningState.pid === activeProcess.pid) {
      activeProcess.kill("SIGTERM");
      activeProcess = null;
      sigtermSent = true;
    } else if (runningState.pid) {
      const pidAlive = isPidAlive(runningState.pid);

      if (!pidAlive) {
        req.log.warn(
          { ...logCtx, validation: "stale_pid_dead" },
          "evolve stop: stale lease — pid no longer exists, cleaning up lease only",
        );
      } else if (!isSelfEvolveProcess(runningState.pid)) {
        req.log.warn(
          { ...logCtx, validation: "pid_recycled" },
          "evolve stop: pid recycled to non-self-evolve process, refusing SIGTERM",
        );
      } else {
        try {
          process.kill(runningState.pid, "SIGTERM");
          sigtermSent = true;
        } catch (err) {
          req.log.warn(
            { ...logCtx, validation: "sigterm_failed", error: err.message },
            "evolve stop: SIGTERM failed on verified process",
          );
        }
      }

      await rm(path.join(req.cpbRoot, "cpb-task", "self-evolve", ".controller-lock"), { recursive: true, force: true });
    }

    const state = await loadState(req.cpbRoot);
    state.status = "stopped";
    await saveState(req.cpbRoot, state);
    await appendHistory(req.cpbRoot, {
      action: "stop",
      source: "ui",
      targetPid: runningState.pid,
      sigtermSent,
    });

    return { stopped: true, pid: runningState.pid, source: runningState.source, sigtermSent };
  });
}
