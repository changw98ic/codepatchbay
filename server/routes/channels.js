import path from "path";
import { spawn } from "child_process";
import { readFile } from "node:fs/promises";
import { registerTask, unregisterTask } from "../services/executor.js";
import { broadcast } from "../services/ws-broadcast.js";

const SAFE_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

function spawnPipeline(flowRoot, project, task, log) {
  const scriptPath = path.join(flowRoot, "bridges", "run-pipeline.sh");
  const taskId = `channel:${project}:pipeline:${Date.now()}`;

  const child = spawn("bash", [scriptPath, project, task, "3", "0"], {
    cwd: flowRoot,
    env: { ...process.env, FLOW_ROOT: flowRoot, FLOW_DANGEROUS: process.env.FLOW_DANGEROUS || "0" },
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

async function loadChannelConfig(flowRoot) {
  const file = path.join(flowRoot, "channels.json");
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

    const flowRoot = req.flowRoot;
    const config = await loadChannelConfig(flowRoot);
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

    const cmd = parseCommand(text);
    if (!cmd) return { ok: true, parsed: false };

    return spawnPipeline(flowRoot, cmd.project, cmd.task, req.log);
  });

  // DingTalk outgoing robot callback
  fastify.post("/channels/dingtalk", async (req, reply) => {
    const body = req.body || {};
    const flowRoot = req.flowRoot;
    const config = await loadChannelConfig(flowRoot);
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

    const cmd = parseCommand(text);
    if (!cmd) return { ok: true, parsed: false };

    return spawnPipeline(flowRoot, cmd.project, cmd.task, req.log);
  });
}
