import { spawn, execFile } from "child_process";
import path from "path";
import { readFile, rm } from "fs/promises";
import { broadcast } from "../services/ws-broadcast.js";
import { spawnBridge } from "./tasks.js";
import { makeJobId } from "../services/job-store.js";
import {
  createSession,
  getSession,
  listSessions,
  updateSession,
} from "../services/review-session.js";

const SAFE_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

function gitExec(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`));
      else resolve(stdout.trim());
    });
  });
}

function worktreePathFor(cpbRoot, jobId) {
  return path.join(cpbRoot, "cpb-task", "worktrees", `${jobId}-pipeline`);
}

const REVIEW_NOTIFY_STATUSES = new Set(["user_review", "dispatched", "expired", "cancelled"]);

export async function reviewRoutes(fastify, opts) {

  const notify = (event) => {
    broadcast(event);
    if (REVIEW_NOTIFY_STATUSES.has(event.status)) {
      fastify.notifBroadcast(event).catch(() => {});
    }
  };

  // Create review session
  fastify.post("/review", async (req) => {
    const { project, intent } = req.body || {};
    if (!project || !SAFE_NAME.test(project)) {
      throw fastify.httpErrors.badRequest("valid project name required");
    }
    if (!intent || typeof intent !== "string" || intent.trim().length < 3) {
      throw fastify.httpErrors.badRequest("intent required (min 3 chars)");
    }

    const session = await createSession(req.cpbRoot, { project, intent: intent.trim() });
    notify({ type: "review:update", sessionId: session.sessionId, status: session.status, project, session });
    return session;
  });

  // List sessions
  fastify.get("/review", async (req) => {
    return listSessions(req.cpbRoot);
  });

  // Get session
  fastify.get("/review/:id", async (req) => {
    const session = await getSession(req.cpbRoot, req.params.id);
    if (!session) throw fastify.httpErrors.notFound("session not found");
    return session;
  });

  // Start review cpb (spawns review-dispatch.mjs in background)
  fastify.post("/review/:id/start", async (req) => {
    const session = await getSession(req.cpbRoot, req.params.id);
    if (!session) throw fastify.httpErrors.notFound("session not found");
    if (session.status !== "idle") {
      throw fastify.httpErrors.conflict(`session already in status: ${session.status}`);
    }

    const scriptPath = path.join(req.cpbRoot, "bridges/review-dispatch.mjs");

    const child = spawn("node", [scriptPath, req.cpbRoot, session.sessionId], {
      cwd: req.cpbRoot,
      env: { ...process.env, CPB_ROOT: req.cpbRoot },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.stdout.on("data", (chunk) => process.stdout.write(`[review-dispatch] ${chunk}`));
    child.stderr.on("data", (chunk) => process.stderr.write(`[review-dispatch] ${chunk}`));
    child.unref();

    return { accepted: true, sessionId: session.sessionId };
  });

  // User approves → dispatch pipeline
  fastify.post("/review/:id/approve", async (req) => {
    const session = await getSession(req.cpbRoot, req.params.id);
    if (!session) throw fastify.httpErrors.notFound("session not found");
    if (session.status !== "user_review") {
      throw fastify.httpErrors.conflict(`session not awaiting approval (status: ${session.status})`);
    }

    await updateSession(req.cpbRoot, session.sessionId, {
      status: "dispatched",
      userVerdict: "approved",
    });

    const jobId = makeJobId();
    const wtPath = worktreePathFor(req.cpbRoot, jobId);
    const result = spawnBridge(
      req.cpbRoot,
      session.project,
      "run-pipeline.sh",
      [session.project, session.intent, "3", "0", "standard", jobId],
      req.log,
      jobId,
      { CPB_USE_WORKTREE: "1" },
    );

    await updateSession(req.cpbRoot, session.sessionId, {
      jobId,
      worktreePath: wtPath,
    });

    notify({
      type: "review:update",
      sessionId: session.sessionId,
      status: "dispatched",
      jobId: result.taskId,
      project: session.project,
      session: await getSession(req.cpbRoot, session.sessionId),
    });

    return { dispatched: true, sessionId: session.sessionId, taskId: result.taskId };
  });

  // Internal auto-approve path (used by self-evolve)
  fastify.post("/review/:id/auto-approve", async (req) => {
    const session = await getSession(req.cpbRoot, req.params.id);
    if (!session) throw fastify.httpErrors.notFound("session not found");

    if (!["dispatched", "user_review"].includes(session.status)) {
      return {
        dispatched: false,
        sessionId: session.sessionId,
        status: session.status,
        note: "invalid_state_for_auto_approve",
      };
    }

    const result = await updateSession(
      req.cpbRoot,
      session.sessionId,
      {
        status: session.status === "dispatched" ? session.status : "dispatched",
        userVerdict: "approved",
      },
      { skipTransitionCheck: true },
    );

    if (result.status === "dispatched" && result.jobId) {
      return {
        dispatched: true,
        sessionId: session.sessionId,
        taskId: result.jobId,
        note: "already_dispatched",
      };
    }

    const jobId = makeJobId();
    const wtPath = worktreePathFor(req.cpbRoot, jobId);
    const updated = spawnBridge(
      req.cpbRoot,
      session.project,
      "run-pipeline.sh",
      [session.project, session.intent, "3", "0", "standard", jobId],
      req.log,
      jobId,
      { CPB_USE_WORKTREE: "1" },
    );

    const refreshed = await updateSession(req.cpbRoot, session.sessionId, {
      ...result,
      jobId,
      worktreePath: wtPath,
      status: "dispatched",
      userVerdict: "approved",
    }, { skipTransitionCheck: true });

    notify({
      type: "review:update",
      sessionId: refreshed.sessionId,
      status: refreshed.status,
      jobId: refreshed.jobId,
      project: refreshed.project,
      session: refreshed,
    });

    return {
      dispatched: true,
      sessionId: session.sessionId,
      taskId: updated.taskId,
    };
  });

  // User rejects → discard worktree, keep main tree clean
  fastify.post("/review/:id/reject", async (req) => {
    const session = await getSession(req.cpbRoot, req.params.id);
    if (!session) throw fastify.httpErrors.notFound("session not found");
    if (session.status !== "user_review") {
      throw fastify.httpErrors.conflict(`session not awaiting approval (status: ${session.status})`);
    }

    // Clean up worktree if it exists
    if (session.worktreePath) {
      try {
        const projectJson = path.join(req.cpbRoot, "wiki", "projects", session.project, "project.json");
        const meta = JSON.parse(await readFile(projectJson, "utf8"));
        if (meta.sourcePath) {
          await gitExec(meta.sourcePath, "worktree", "remove", "--force", session.worktreePath).catch(() => {});
        }
      } catch {}
      try { await rm(session.worktreePath, { recursive: true, force: true }); } catch {}
    }

    const updated = await updateSession(req.cpbRoot, session.sessionId, {
      status: "expired",
      userVerdict: "rejected",
    });

    notify({ type: "review:update", sessionId: session.sessionId, status: "expired", project: session.project, session: updated });
    return updated;
  });

  // User accepts → merge worktree branch into main, clean up worktree
  fastify.post("/review/:id/cancel", async (req, reply) => cancelRoute(req, reply, notify));

  fastify.post("/review/:id/accept", async (req) => {
    const session = await getSession(req.cpbRoot, req.params.id);
    if (!session) throw fastify.httpErrors.notFound("session not found");
    if (session.status !== "user_review" && session.status !== "dispatched") {
      throw fastify.httpErrors.conflict(`session not in reviewable state (status: ${session.status})`);
    }

    let merged = false;
    if (session.worktreePath && session.jobId) {
      try {
        const projectJson = path.join(req.cpbRoot, "wiki", "projects", session.project, "project.json");
        const meta = JSON.parse(await readFile(projectJson, "utf8"));
        const sourcePath = meta.sourcePath;
        if (sourcePath) {
          const branch = `cpb/${session.jobId}-pipeline`;
          // Check if branch exists
          try {
            await gitExec(sourcePath, "rev-parse", "--verify", branch);
            // Merge the branch
            await gitExec(sourcePath, "merge", "--no-ff", "-m", `cpb: accept review ${session.sessionId}`, branch);
            merged = true;
            // Clean up branch
            await gitExec(sourcePath, "branch", "-D", branch).catch(() => {});
          } catch (err) {
            // Branch might not exist if pipeline didn't use worktree
          }
          // Clean up worktree directory
          await gitExec(sourcePath, "worktree", "remove", "--force", session.worktreePath).catch(() => {});
          await rm(session.worktreePath, { recursive: true, force: true }).catch(() => {});
        }
      } catch (err) {
        // Best effort merge
      }
    }

    const updated = await updateSession(req.cpbRoot, session.sessionId, {
      status: "completed",
      userVerdict: "accepted",
      merged,
    });

    notify({ type: "review:update", sessionId: session.sessionId, status: "completed", project: session.project, session: updated });
    return { accepted: true, merged, sessionId: session.sessionId };
  });
}

async function cancelRoute(req, reply, notify) {
  const { id } = req.params;
  const session = await getSession(req.flowRoot, id);
  if (!session) return reply.code(404).send({ error: "not found" });
  const updated = await updateSession(req.flowRoot, id, {
    status: "cancelled",
    detail: req.body?.reason || "cancelled",
  }, { skipTransitionCheck: true });
  notify({ type: "review:update", sessionId: id, status: "cancelled", project: session.project, session: updated });
  return { cancelled: true, sessionId: id };
}
