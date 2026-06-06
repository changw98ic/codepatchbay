import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { listProjects, resolveHubRoot } from "../services/hub-registry.js";
import {
  loadProjectState as loadMultiProjectState,
  loadBacklog as loadMultiBacklog,
} from "../services/multi-evolve-state.js";
import { buildChildEnv } from "../services/secret-policy.js";

let activeProcess = null;

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

function evolveScriptPath(cpbRoot) {
  return path.join(cpbRoot, "runtime", "evolve", "multi-evolve.js");
}

function isEvolutionProcess(pid) {
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    return cmd.includes("runtime/evolve/multi-evolve.js") || cmd.includes("multi-evolve.js");
  } catch {
    return false;
  }
}

function isPidAlive(pid) {
  try {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: process exists but no permission → still alive
    if (err.code === "EPERM") return true;
    return false;
  }
}

export async function evolveRoutes(fastify, opts) {
  // ── Generic evolution endpoints ──

  fastify.get("/evolve/status", async (req) => {
    const hubRoot = req.cpbHubRoot || resolveHubRoot(req.cpbRoot);
    const projects = await listProjects(hubRoot, { enabledOnly: false });
    const rows = await Promise.all(projects.map(async (project) => {
      const [state, backlog] = await Promise.all([
        loadMultiProjectState(project.sourcePath, project.id),
        loadMultiBacklog(project.sourcePath, project.id),
      ]);
      return {
        id: project.id,
        name: project.name,
        sourcePath: project.sourcePath,
        enabled: project.enabled !== false,
        worker: project.worker || null,
        state,
        backlog: {
          total: backlog.length,
          pending: backlog.filter((issue) => issue.status === "pending").length,
          inProgress: backlog.filter((issue) => issue.status === "in_progress").length,
        },
      };
    }));
    return {
      running: Boolean(activeProcess),
      pid: activeProcess?.pid || null,
      projects: rows,
    };
  });

  fastify.get("/evolve/history", async (req) => {
    return [];
  });

  fastify.post("/evolve/start", async (req, res) => {
    const quickCheck = Boolean(activeProcess);
    if (quickCheck) {
      throw fastify.httpErrors.conflict("evolution already running");
    }

    const release = await startMutex.acquire();
    try {
      if (activeProcess) {
        throw fastify.httpErrors.conflict("evolution already running");
      }

      const body = req.body || {};
      const args = [];
      if (body.dryRun !== false) args.push("--dry-run");
      if (body.scan === true) args.push("--scan");
      if (body.once === true) args.push("--once");
      if (body.project) args.push("--project", String(body.project));
      if (body.agent) args.push("--agent", String(body.agent));

      const script = evolveScriptPath(req.cpbRoot);
      const hubRoot = req.cpbHubRoot || resolveHubRoot(req.cpbRoot);
      const child = spawn("node", [script, ...args], {
        cwd: req.cpbRoot,
        env: buildChildEnv(process.env, { CPB_ROOT: req.cpbRoot, CPB_HUB_ROOT: hubRoot }),
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });
      activeProcess = child;

      child.stdout.on("data", (chunk) => process.stdout.write(`[evolve] ${chunk}`));
      child.stderr.on("data", (chunk) => process.stderr.write(`[evolve] ${chunk}`));
      child.on("exit", () => {
        if (activeProcess === child) activeProcess = null;
      });
      child.on("error", () => {
        if (activeProcess === child) activeProcess = null;
      });

      res.code(202);
      return { accepted: true, pid: child.pid };
    } finally {
      release();
    }
  });

  fastify.post("/evolve/stop", async () => {
    if (!activeProcess) {
      return { stopped: false, reason: "not_running" };
    }
    const pid = activeProcess.pid;
    activeProcess.kill("SIGTERM");
    activeProcess = null;
    return { stopped: true, pid };
  });

  function removedMultiEvolveAlias(_req, reply) {
    reply.code(410);
    return {
      error: "gone",
      message: "The /evolve/multi/* routes were removed by the hard cut. Use /evolve/status, /evolve/start, or /evolve/stop.",
    };
  }

  fastify.get("/evolve/multi/status", removedMultiEvolveAlias);
  fastify.post("/evolve/multi/start", removedMultiEvolveAlias);
  fastify.post("/evolve/multi/stop", removedMultiEvolveAlias);
}
