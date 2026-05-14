import { spawn } from "child_process";
import path from "path";
import { broadcast } from "../services/ws-broadcast.js";
import { spawnBridge } from "./tasks.js";
import {
  createSession,
  getSession,
  listSessions,
  updateSession,
} from "../services/review-session.js";

const SAFE_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

const REVIEW_NOTIFY_STATUSES = new Set(["user_review", "dispatched", "expired"]);

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

    const session = await createSession(req.flowRoot, { project, intent: intent.trim() });
    notify({ type: "review:update", sessionId: session.sessionId, status: session.status, project, session });
    return session;
  });

  // List sessions
  fastify.get("/review", async (req) => {
    return listSessions(req.flowRoot);
  });

  // Get session
  fastify.get("/review/:id", async (req) => {
    const session = await getSession(req.flowRoot, req.params.id);
    if (!session) throw fastify.httpErrors.notFound("session not found");
    return session;
  });

  // Start review flow (spawns review-dispatch.mjs in background)
  fastify.post("/review/:id/start", async (req) => {
    const session = await getSession(req.flowRoot, req.params.id);
    if (!session) throw fastify.httpErrors.notFound("session not found");
    if (session.status !== "idle") {
      throw fastify.httpErrors.conflict(`session already in status: ${session.status}`);
    }

    const scriptPath = path.join(req.flowRoot, "bridges/review-dispatch.mjs");

    const child = spawn("node", [scriptPath, req.flowRoot, session.sessionId], {
      cwd: req.flowRoot,
      env: { ...process.env, FLOW_ROOT: req.flowRoot },
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
    const session = await getSession(req.flowRoot, req.params.id);
    if (!session) throw fastify.httpErrors.notFound("session not found");
    if (session.status !== "user_review") {
      throw fastify.httpErrors.conflict(`session not awaiting approval (status: ${session.status})`);
    }

    await updateSession(req.flowRoot, session.sessionId, {
      status: "dispatched",
      userVerdict: "approved",
    });

    const result = spawnBridge(
      req.flowRoot,
      session.project,
      "run-pipeline.sh",
      [session.project, session.intent, "3", "0"],
      req.log,
    );

    await updateSession(req.flowRoot, session.sessionId, {
      jobId: result.taskId,
    });

    notify({
      type: "review:update",
      sessionId: session.sessionId,
      status: "dispatched",
      jobId: result.taskId,
      project: session.project,
      session: await getSession(req.flowRoot, session.sessionId),
    });

    return { dispatched: true, sessionId: session.sessionId, taskId: result.taskId };
  });

  // Internal auto-approve path (used by self-evolve)
  fastify.post("/review/:id/auto-approve", async (req) => {
    const session = await getSession(req.flowRoot, req.params.id);
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
      req.flowRoot,
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

    const updated = spawnBridge(
      req.flowRoot,
      session.project,
      "run-pipeline.sh",
      [session.project, session.intent, "3", "0"],
      req.log,
    );

    const refreshed = await updateSession(req.flowRoot, session.sessionId, {
      ...result,
      jobId: updated.taskId,
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

  // User rejects
  fastify.post("/review/:id/reject", async (req) => {
    const session = await getSession(req.flowRoot, req.params.id);
    if (!session) throw fastify.httpErrors.notFound("session not found");
    if (session.status !== "user_review") {
      throw fastify.httpErrors.conflict(`session not awaiting approval (status: ${session.status})`);
    }

    const updated = await updateSession(req.flowRoot, session.sessionId, {
      status: "expired",
      userVerdict: "rejected",
    });

    notify({ type: "review:update", sessionId: session.sessionId, status: "expired", project: session.project, session: updated });
    return updated;
  });
}
