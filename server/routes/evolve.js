import { readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  loadState,
  appendHistory,
  loadBacklog,
  saveState,
} from "../services/evolve-state.js";

let activeProcess = null;

const leaseMetaPath = (flowRoot) => path.join(flowRoot, "flow-task", "self-evolve", ".controller-lock", "meta.json");

function isPidAlive(pid) {
  try {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getControllerLease(flowRoot) {
  try {
    const raw = await readFile(leaseMetaPath(flowRoot), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function getRunningController(flowRoot) {
  const lease = await getControllerLease(flowRoot);
  const leasedPid = lease?.pid ? Number(lease.pid) : null;
  if (leasedPid && isPidAlive(leasedPid)) {
    return { pid: leasedPid, source: "lease", startedAt: lease.startedAt || null };
  }

  return null;
}

async function resolveRunningState(flowRoot) {
  if (activeProcess) {
    return { running: true, pid: activeProcess.pid, source: "ui-process", startedAt: null };
  }

  const lease = await getRunningController(flowRoot);
  if (!lease) return { running: false, pid: null, source: null, startedAt: null };
  return { ...lease, running: true };
}

function evolveScriptPath(flowRoot) {
  return path.join(flowRoot, "bridges", "self-evolve.mjs");
}

async function readHistory(flowRoot) {
  const filePath = path.join(flowRoot, "flow-task", "self-evolve", "history.jsonl");
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
    const state = await loadState(req.flowRoot);
    const runningState = await resolveRunningState(req.flowRoot);
    return toResponseState(state, runningState);
  };

  fastify.get("/evolve/status", async (req) => {
    return getState(req);
  });

  fastify.get("/evolve/history", async (req) => {
    return readHistory(req.flowRoot);
  });

  fastify.post("/evolve/start", async (req, res) => {
    const runningState = await resolveRunningState(req.flowRoot);
    if (runningState.running) {
      throw fastify.httpErrors.conflict("self-evolve already running");
    }

    const state = await loadState(req.flowRoot);
    const backlog = await loadBacklog(req.flowRoot);
    const isIdle = !state.status || state.status === "idle" || state.status === "stopped" || state.status === "completed" || state.status === "error" || state.status === "failed";
    if (!isIdle && state.status !== "running" && state.round > 0) {
      throw fastify.httpErrors.conflict(`cannot start while status is ${state.status}`);
    }
    state.status = "starting";
    await saveState(req.flowRoot, state);

    const script = evolveScriptPath(req.flowRoot);
    const child = spawn("node", [script], {
      cwd: req.flowRoot,
      env: { ...process.env, FLOW_ROOT: req.flowRoot },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    child.stdout.on("data", (chunk) => {
      process.stdout.write(`[self-evolve] ${chunk}`);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(`[self-evolve] ${chunk}`);
    });
    child.on("exit", () => {
      if (activeProcess === child) activeProcess = null;
    });
    activeProcess = child;

    await appendHistory(req.flowRoot, {
      action: "start",
      source: "ui",
      backlog: backlog.length,
    });

    res.code(202);
    return { accepted: true, pid: child.pid, status: toResponseState(await loadState(req.flowRoot), await resolveRunningState(req.flowRoot)) };
  });

  fastify.post("/evolve/stop", async (req) => {
    const runningState = await resolveRunningState(req.flowRoot);
    if (!runningState.running) {
      return { stopped: false, reason: "not_running" };
    }

    if (activeProcess && runningState.pid === activeProcess.pid) {
      activeProcess.kill("SIGTERM");
      activeProcess = null;
    } else if (runningState.pid) {
      try {
        process.kill(runningState.pid, "SIGTERM");
      } catch {
        // ignore termination failures to keep endpoint idempotent
      }
      await rm(path.join(req.flowRoot, "flow-task", "self-evolve", ".controller-lock"), { recursive: true, force: true });
    }

    const state = await loadState(req.flowRoot);
    state.status = "stopped";
    await saveState(req.flowRoot, state);
    await appendHistory(req.flowRoot, {
      action: "stop",
      source: "ui",
      targetPid: runningState.pid,
    });

    return { stopped: true, pid: runningState.pid, source: runningState.source };
  });
}
