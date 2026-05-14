import path from "path";
import { spawn } from "child_process";
import { readFile } from "node:fs/promises";
import { registerTask, unregisterTask } from "../services/executor.js";
import { broadcast } from "../services/ws-broadcast.js";
import { createSession, getSession, updateSession } from "../services/review-session.js";

const SAFE_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

function spawnPipeline(cpbRoot, project, task, log) {
  const scriptPath = path.join(cpbRoot, "bridges", "run-pipeline.sh");
  const taskId = `channel:${project}:pipeline:${Date.now()}`;

  const child = spawn("bash", [scriptPath, project, task, "3", "0"], {
    cwd: cpbRoot,
    env: { ...process.env, CPB_ROOT: cpbRoot, CPB_DANGEROUS: process.env.CPB_DANGEROUS || "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  registerTask(taskId, project, "run-pipeline.sh", child.pid);

  let output = "";
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    broadcast({ type: "task:output", taskId, project, output: text, stream: "stdout" });
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    broadcast({ type: "task:output", taskId, project, output: text, stream: "stderr" });
  });

  child.on("exit", (code) => {
    unregisterTask(taskId);
    broadcast({ type: "task:complete", taskId, project, script: "run-pipeline.sh", exitCode: code, output });
    log?.info(`Channel pipeline ${taskId} exited with code ${code}`);
  });

  return { accepted: true, taskId, pid: child.pid };
}

/**
 * Parse IM message text into { project, task }.
 * Format: "project-name task description here"
 * First token = project name (must match SAFE_NAME), rest = task.
 */
function parseCommand(text) {
  const trimmed = text.trim().replace(/@\S+\s*/, ""); // strip @mentions
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return null;

  const project = parts[0];
  if (!SAFE_NAME.test(project)) return null;

  const task = parts.slice(1).join(" ").trim();
  if (!task) return null;

  return { project, task };
}

/**
 * Parse review commands from IM text.
 * "review approve <sessionId>"
 * "review reject <sessionId>"
 * "review <project> <intent>"
 */
function parseReviewCommand(text) {
  const trimmed = text.trim().replace(/@\S+\s*/, "");
  const parts = trimmed.split(/\s+/);
  if (parts[0] !== "review") return null;

  if (parts.length >= 3 && (parts[1] === "approve" || parts[1] === "reject")) {
    const sessionId = parts.slice(2).join(" ");
    return { action: parts[1], sessionId };
  }

  if (parts.length >= 3 && SAFE_NAME.test(parts[1])) {
    return { action: "create", project: parts[1], intent: parts.slice(2).join(" ") };
  }

  return null;
}

async function handleReviewCommand(cpbRoot, cmd, log) {
  if (cmd.action === "create") {
    const session = await createSession(cpbRoot, { project: cmd.project, intent: cmd.intent });
    broadcast({ type: "review:update", sessionId: session.sessionId, status: session.status, project: cmd.project, session });

    // Auto-start the review
    const scriptPath = path.join(cpbRoot, "bridges/review-dispatch.mjs");
    spawn("node", [scriptPath, cpbRoot, session.sessionId], {
      cwd: cpbRoot,
      env: { ...process.env, CPB_ROOT: cpbRoot },
      stdio: "ignore",
      detached: true,
    }).unref();

    return { ok: true, sessionId: session.sessionId, action: "created" };
  }

  const session = await getSession(cpbRoot, cmd.sessionId);
  if (!session) return { ok: false, error: "session not found" };

  if (cmd.action === "approve") {
    if (session.status !== "user_review") {
      return { ok: false, error: `session not awaiting approval (status: ${session.status})` };
    }
    await updateSession(cpbRoot, session.sessionId, { status: "dispatched", userVerdict: "approved" });
    const result = spawnPipeline(cpbRoot, session.project, session.intent, log);
    await updateSession(cpbRoot, session.sessionId, { jobId: result.taskId });
    broadcast({ type: "review:update", sessionId: session.sessionId, status: "dispatched", jobId: result.taskId, project: session.project });
    return { ok: true, sessionId: session.sessionId, action: "approved", taskId: result.taskId };
  }

  if (cmd.action === "reject") {
    if (session.status !== "user_review") {
      return { ok: false, error: `session not awaiting approval (status: ${session.status})` };
    }
    const updated = await updateSession(cpbRoot, session.sessionId, { status: "expired", userVerdict: "rejected" });
    broadcast({ type: "review:update", sessionId: session.sessionId, status: "expired", project: session.project });
    return { ok: true, sessionId: session.sessionId, action: "rejected" };
  }

  return { ok: false, error: "unknown action" };
}

async function loadChannelConfig(cpbRoot) {
  const file = path.join(cpbRoot, "channels.json");
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function channelRoutes(fastify, opts) {

  // Feishu event callback
  fastify.post("/channels/feishu", async (req, reply) => {
    const body = req.body || {};

    // URL verification challenge
    if (body.type === "url_verification") {
      return { challenge: body.challenge };
    }

    // Event callback
    const event = body.event;
    if (!event || !event.message) return { ok: true };

    const cpbRoot = req.cpbRoot;
    const config = await loadChannelConfig(cpbRoot);
    if (!config?.channels?.feishu?.enabled) return { ok: true };

    // Validate token if configured
    if (config.channels.feishu.verificationToken && body.token !== config.channels.feishu.verificationToken) {
      return reply.code(403).send({ error: "invalid token" });
    }

    // Extract text from message content
    let text = "";
    try {
      const content = JSON.parse(event.message.content || "{}");
      text = content.text || "";
    } catch {
      text = event.message.content || "";
    }

    // Try review command first
    const reviewCmd = parseReviewCommand(text);
    if (reviewCmd) return handleReviewCommand(cpbRoot, reviewCmd, req.log);

    const cmd = parseCommand(text);
    if (!cmd) return { ok: true, parsed: false };

    return spawnPipeline(cpbRoot, cmd.project, cmd.task, req.log);
  });

  // DingTalk outgoing robot callback

  fastify.post("/channels/dingtalk", async (req, reply) => {
    const body = req.body || {};
    const cpbRoot = req.cpbRoot;
    const config = await loadChannelConfig(cpbRoot);
    if (!config?.channels?.dingtalk?.enabled) return { ok: true };

    // Validate token if configured
    if (config.channels.dingtalk.outgoingToken) {
      const token = (req.headers["x-dingtalk-signature"] || "").split(",")[1];
      if (!token || token !== config.channels.dingtalk.outgoingToken) {
        return reply.code(403).send({ error: "invalid signature" });
      }
    }

    // Extract text
    const text = body.text?.content || body.content || "";

    // Try review command first
    const reviewCmd = parseReviewCommand(text);
    if (reviewCmd) return handleReviewCommand(cpbRoot, reviewCmd, req.log);

    const cmd = parseCommand(text);
    if (!cmd) return { ok: true, parsed: false };

    return spawnPipeline(cpbRoot, cmd.project, cmd.task, req.log);
  });
}
