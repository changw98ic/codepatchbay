import { spawn } from "child_process";
import path from "path";
import { readFile, rm } from "fs/promises";
import { runtimeDataPath } from "../services/runtime-root.js";
import { broadcast } from "../services/ws-broadcast.js";
import { makeJobId } from "../services/job-store.js";
import {
  createSession,
  getSession,
  listSessions,
  startSessionResearch,
} from "../services/review-session.js";
import { buildChildEnv } from "../services/secret-policy.js";
import { writeProjectIndex } from "../services/project-index.js";
import { resolveHubRoot, getProject } from "../services/hub-registry.js";
import {
  dispatchSession,
  autoApproveSession,
  cancelReviewDispatch,
  analyzeSession,
  acceptSession,
  rejectSession,
} from "../services/review-dispatch.js";

const SAFE_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

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

  // Start review workflow in background.
  fastify.post("/review/:id/start", async (req) => {
    let session;
    const key = req.headers['idempotency-key'] || `start-${Date.now()}`;
    const existing = await getSession(req.cpbRoot, req.params.id);
    const alreadyStarted = existing?.idempotency?.startKey === key;
    try {
      session = await startSessionResearch(req.cpbRoot, req.params.id, key);
    } catch (err) {
      if (err.message?.includes("invalid transition") || err.message?.includes("already in status")) {
        throw fastify.httpErrors.conflict(`session not in idle state`);
      }
      if (err.message?.includes("idempotency conflict")) {
        throw fastify.httpErrors.conflict(`session already started with different key`);
      }
      if (err.message?.includes("not found")) {
        throw fastify.httpErrors.notFound("session not found");
      }
      throw err;
    }

    if (alreadyStarted) {
      return { accepted: true, sessionId: session.sessionId, alreadyStarted: true };
    }

    if (opts.startRunner === false) {
      return { accepted: true, sessionId: session.sessionId, runnerStarted: false };
    }

    const executorRoot = path.resolve(opts.executorRoot || process.env.CPB_EXECUTOR_ROOT || req.cpbRoot);
    const scriptPath = path.join(executorRoot, "server/services/review-dispatch-runner.mjs");

    const child = spawn("node", [scriptPath, req.cpbRoot, session.sessionId], {
      cwd: req.cpbRoot,
      env: buildChildEnv(process.env, { CPB_ROOT: req.cpbRoot, CPB_EXECUTOR_ROOT: executorRoot }),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.stdout.on("data", (chunk) => process.stdout.write(`[review-dispatch] ${chunk}`));
    child.stderr.on("data", (chunk) => process.stderr.write(`[review-dispatch] ${chunk}`));
    child.unref();

    return { accepted: true, sessionId: session.sessionId };
  });

  // User approves → dispatch pipeline via hub queue
  fastify.post("/review/:id/approve", async (req) => {
    const session = await getSession(req.cpbRoot, req.params.id);
    if (!session) throw fastify.httpErrors.notFound("session not found");
    if (session.status !== "user_review") {
      throw fastify.httpErrors.conflict(`session not awaiting approval (status: ${session.status})`);
    }

    const result = await dispatchSession(req.cpbRoot, req.params.id, {
      hubRoot: req.cpbHubRoot,
    });
    if (!result.ok) throw fastify.httpErrors.notFound(result.error);

    notify({
      type: "review:update",
      sessionId: result.sessionId,
      status: "dispatched",
      jobId: result.taskId,
      project: result.project,
      session: result.session,
    });

    return { dispatched: true, sessionId: result.sessionId, taskId: result.taskId };
  });

  // Internal auto-approve path (used by self-evolve)
  fastify.post("/review/:id/auto-approve", async (req) => {
    const result = await autoApproveSession(req.cpbRoot, req.params.id, {
      hubRoot: req.cpbHubRoot,
    });

    if (!result.ok) {
      if (result.error === "session_not_found") throw fastify.httpErrors.notFound("session not found");
      return {
        dispatched: false,
        sessionId: req.params.id,
        status: result.status,
        note: result.note,
      };
    }

    notify({
      type: "review:update",
      sessionId: result.sessionId,
      status: "dispatched",
      jobId: result.taskId,
      project: result.project,
      session: result.session,
    });

    return {
      dispatched: true,
      sessionId: result.sessionId,
      taskId: result.taskId,
      note: result.note,
    };
  });

  // User rejects → discard worktree, keep main tree clean
  fastify.post("/review/:id/reject", async (req) => {
    const session = await getSession(req.cpbRoot, req.params.id);
    if (!session) throw fastify.httpErrors.notFound("session not found");
    if (session.status !== "user_review") {
      throw fastify.httpErrors.conflict(`session not awaiting approval (status: ${session.status})`);
    }

    const result = await rejectSession(req.cpbRoot, req.params.id);
    if (!result.ok) throw fastify.httpErrors.notFound(result.error);

    notify({ type: "review:update", sessionId: result.sessionId, status: "expired", project: result.project, session: result.session });
    return result.session;
  });

  // User accepts → merge worktree branch into main, clean up worktree
  fastify.post("/review/:id/cancel", async (req, reply) => {
    const result = await cancelReviewDispatch(req.cpbRoot, req.params.id, req.body?.reason);
    if (!result.ok) return reply.code(404).send({ error: "not found" });
    notify({ type: "review:update", sessionId: result.sessionId, status: "cancelled", project: result.project, session: result.session });
    return { cancelled: true, sessionId: result.sessionId };
  });

  fastify.post("/review/:id/accept", async (req) => {
    const session = await getSession(req.cpbRoot, req.params.id);
    if (!session) throw fastify.httpErrors.notFound("session not found");
    if (session.status !== "user_review" && session.status !== "dispatched") {
      throw fastify.httpErrors.conflict(`session not in reviewable state (status: ${session.status})`);
    }

    const hubRoot = req.cpbHubRoot || resolveHubRoot(req.cpbRoot);
    const result = await acceptSession(req.cpbRoot, req.params.id);

    // Persist project-index after successful merge (best-effort, stays in route)
    if (result.merged && result.session?.jobId) {
      try {
        const projectJson = path.join(req.cpbRoot, "wiki", "projects", session.project, "project.json");
        const meta = JSON.parse(await readFile(projectJson, "utf8"));
        if (meta.sourcePath) {
          const { execFile: execFileCb } = await import("child_process");
          const { promisify } = await import("util");
          const execFileAsync = promisify(execFileCb);
          const gitHead = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: meta.sourcePath, encoding: "utf8" }).then(r => r.stdout.trim());
          const currentBranch = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: meta.sourcePath, encoding: "utf8" }).then(r => r.stdout.trim());
          await writeProjectIndex(hubRoot, req.cpbRoot, session.project, {
            state: "merged_indexed",
            branch: currentBranch,
            gitHead,
            indexedFrom: `merge:${result.session.jobId}`,
            timestamp: new Date().toISOString(),
          });
        }
      } catch { /* best effort */ }
    } else if (result.mergeFailed && result.session?.jobId) {
      try {
        await writeProjectIndex(hubRoot, req.cpbRoot, session.project, {
          state: "merge_failed",
          indexedFrom: `merge:${result.session.jobId}`,
          error: result.session.mergeError || "merge failed",
          timestamp: new Date().toISOString(),
        });
      } catch { /* best effort */ }
    }

    notify({ type: "review:update", sessionId: result.sessionId, status: result.status, project: result.project, session: result.session });
    return { accepted: true, merged: result.merged, mergeFailed: result.mergeFailed, sessionId: result.sessionId };
  });

  // Analyze session for approval (ACP-triggered summary)
  fastify.post("/review/:id/analyze", async (req) => {
    const result = await analyzeSession(req.cpbRoot, req.params.id);
    if (!result.ok && result.error === "session_not_found") {
      throw fastify.httpErrors.notFound("session not found");
    }
    return result;
  });
}
