import path from "path";
import { spawn } from "child_process";
import { readFile } from "node:fs/promises";
import { broadcast } from "../services/ws-broadcast.js";
import { createSession, getSession, updateSession } from "../services/review-session.js";
import { buildChildEnv } from "../services/secret-policy.js";
import { enqueue } from "../services/hub-queue.js";
import { getProject } from "../services/hub-registry.js";
import { parseChannelCommand } from "../services/channel-commands.js";
import {
  authorizeDiscordInteraction,
  parseDiscordInteraction,
  verifyDiscordSignature,
} from "../services/channel-discord.js";
import { channelPolicyDenied, handleChannelCommand } from "../services/channel-queue-actions.js";
import { channelPolicyRequest, enforceChannelPolicy } from "../services/channel-policy.js";
import {
  handleSlackInteractiveAction,
  handleSlackSlashCommand,
  parseSlackInteractiveAction,
  parseSlackFormBody,
  parseSlackSlashCommand,
  verifySlackSignature,
} from "../services/channel-slack.js";

const SAFE_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

async function queueReviewPipeline(cpbRoot, project, task, log, options = {}) {
  const hubRoot = options.hubRoot || cpbRoot;
  const queuedAt = new Date().toISOString();
  try {
    const registeredProject = await getProject(hubRoot, project);
    if (!registeredProject?.sourcePath) {
      const error = `Project '${project}' has no sourcePath`;
      log?.error(`queueReviewPipeline error: ${error}`);
      return { accepted: false, taskId: null, error };
    }

    const entry = await enqueue(hubRoot, {
      projectId: project,
      sourcePath: registeredProject.sourcePath,
      priority: "P2",
      description: task,
      type: "channel_review_pipeline",
      metadata: {
        source: "channel_review",
        channel: options.channel || "channel",
        workflow: "standard",
        planMode: "full",
        acpProfile: "headless",
        uiLane: false,
        uiLaneReason: "",
        autoFinalize: false,
        issueNumber: null,
        issueUrl: null,
        repo: registeredProject.github?.fullName || null,
        issueTitle: task,
        actor: options.actor || null,
        requestedAt: queuedAt,
      },
    });

    broadcast({ type: "task:queued", taskId: entry.id, project, entry });
    return { accepted: true, taskId: entry.id, entry };
  } catch (err) {
    log?.error(`queueReviewPipeline error: ${err.message}`);
    broadcast({
      type: "task:error",
      taskId: null,
      project,
      error: err.message,
      code: err.code || "QUEUE_FAILURE",
    });
    return { accepted: false, taskId: null, error: err.message };
  }
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

function reviewPolicyAction(action) {
  if (action === "create") return "run";
  if (action === "reject") return "cancel";
  return action;
}

async function authorizeReviewCommand(cpbRoot, cmd, session, { policy = null, channel = "channel", actor = null } = {}) {
  if (!policy) return { allowed: true, reason: "channel policy not configured" };
  return enforceChannelPolicy(cpbRoot, policy, channelPolicyRequest({
    channel,
    action: reviewPolicyAction(cmd.action),
    project: cmd.project || session?.project || null,
    job: session?.jobId || null,
    actor,
  }));
}

function reviewPolicyDenied(decision, cmd, session, { channel = "channel", actor = null } = {}) {
  return {
    ...channelPolicyDenied(decision),
    channel,
    action: reviewPolicyAction(cmd.action),
    project: cmd.project || session?.project || null,
    sessionId: cmd.sessionId || session?.sessionId || null,
    actor: actor ? {
      userId: actor.userId || actor.id || null,
      channelId: actor.channelId || null,
    } : null,
  };
}

async function handleReviewCommand(cpbRoot, cmd, log, options = {}) {
  if (cmd.action === "create") {
    const decision = await authorizeReviewCommand(cpbRoot, cmd, null, options);
    if (!decision.allowed) return reviewPolicyDenied(decision, cmd, null, options);

    const session = await createSession(cpbRoot, { project: cmd.project, intent: cmd.intent });
    broadcast({ type: "review:update", sessionId: session.sessionId, status: session.status, project: cmd.project, session });

    // Auto-start the review
    const scriptPath = path.join(cpbRoot, "bridges/review-dispatch.mjs");
    spawn("node", [scriptPath, cpbRoot, session.sessionId], {
      cwd: cpbRoot,
      env: buildChildEnv(process.env, { CPB_ROOT: cpbRoot }),
      stdio: "ignore",
      detached: true,
    }).unref();

    return { ok: true, sessionId: session.sessionId, action: "created" };
  }

  const session = await getSession(cpbRoot, cmd.sessionId);
  if (!session) return { ok: false, error: "session not found" };

  const decision = await authorizeReviewCommand(cpbRoot, cmd, session, options);
  if (!decision.allowed) return reviewPolicyDenied(decision, cmd, session, options);

  if (cmd.action === "approve") {
    if (session.status !== "user_review") {
      return { ok: false, error: `session not awaiting approval (status: ${session.status})` };
    }
    await updateSession(cpbRoot, session.sessionId, { status: "dispatched", userVerdict: "approved" });
    const result = await queueReviewPipeline(cpbRoot, session.project, session.intent, log, options);
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

async function queueChannelCommand(cpbRoot, parsed, context = {}, { policy = null } = {}) {
  const channel = context.channel || parsed?.channel || "channel";
  return handleChannelCommand(cpbRoot, parsed, {
    policy,
    hubRoot: context.hubRoot || cpbRoot,
    channel,
    context,
  });
}

export async function channelRoutes(fastify, opts) {
  fastify.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    req.rawBody = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""), "utf8");
    try {
      done(null, JSON.parse(req.rawBody.toString("utf8") || "{}"));
    } catch (error) {
      done(error);
    }
  });

  fastify.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "buffer" }, (req, body, done) => {
    req.rawBody = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""), "utf8");
    done(null, parseSlackFormBody(req.rawBody));
  });

  fastify.post("/channels/slack/commands", async (req, reply) => {
    const signingSecret = opts.slackSigningSecret || process.env.CPB_SLACK_SIGNING_SECRET;
    const verification = verifySlackSignature({
      signingSecret,
      timestamp: req.headers["x-slack-request-timestamp"],
      signature: req.headers["x-slack-signature"],
      rawBody: req.rawBody,
    });
    if (!verification.ok) {
      return reply.code(401).send({ ok: false, error: verification.reason });
    }

    const parsed = parseSlackSlashCommand(req.body || {});
    const dryRun = opts.slackDryRun === true || req.query?.dryRun === "1" || req.query?.dry_run === "1";
    if (dryRun) {
      return {
        ok: true,
        channel: "slack",
        dryRun: true,
        parsed,
      };
    }

    const policy = opts.channelPolicy || null;
    const result = await handleSlackSlashCommand(req.cpbRoot, parsed, {
      policy,
      hubRoot: req.cpbHubRoot || req.cpbRoot,
    });
    return reply.code(result.statusCode || (result.ok ? 200 : 400)).send(result);
  });

  fastify.post("/channels/slack/actions", async (req, reply) => {
    const signingSecret = opts.slackSigningSecret || process.env.CPB_SLACK_SIGNING_SECRET;
    const verification = verifySlackSignature({
      signingSecret,
      timestamp: req.headers["x-slack-request-timestamp"],
      signature: req.headers["x-slack-signature"],
      rawBody: req.rawBody,
    });
    if (!verification.ok) {
      return reply.code(401).send({ ok: false, error: verification.reason });
    }

    let payload;
    try {
      payload = JSON.parse(req.body?.payload || "{}");
    } catch {
      return reply.code(400).send({ ok: false, error: "invalid Slack action payload" });
    }

    const parsed = parseSlackInteractiveAction(payload);
    const policy = opts.channelPolicy || null;
    const result = await handleSlackInteractiveAction(req.cpbRoot, parsed, { policy });
    return reply.code(result.statusCode || (result.ok ? 200 : 400)).send(result);
  });

  fastify.post("/channels/discord/interactions", async (req, reply) => {
    const publicKey = opts.discordPublicKey || process.env.CPB_DISCORD_PUBLIC_KEY;
    const verification = verifyDiscordSignature({
      publicKey,
      timestamp: req.headers["x-signature-timestamp"],
      signature: req.headers["x-signature-ed25519"],
      rawBody: req.rawBody,
    });
    if (!verification.ok) {
      return reply.code(401).send({ ok: false, error: verification.reason });
    }

    if (req.body?.type === 1) return { type: 1 };

    const parsed = parseDiscordInteraction(req.body || {});
    const policy = opts.channelPolicy || null;
    const dryRun = opts.discordDryRun === true || req.query?.dryRun === "1" || req.query?.dry_run === "1";
    if (dryRun) {
      const authorization = await authorizeDiscordInteraction(req.cpbRoot, policy, parsed);
      if (!authorization.allowed) {
        return reply.code(403).send({
          ok: false,
          code: "CHANNEL_POLICY_DENIED",
          reason: authorization.reason,
        });
      }
      return {
        ok: true,
        channel: "discord",
        dryRun: true,
        parsed,
      };
    }

    const result = await queueChannelCommand(req.cpbRoot, parsed, {
      channel: "discord",
      hubRoot: req.cpbHubRoot || req.cpbRoot,
    }, { policy });
    return reply.code(result.statusCode || (result.ok ? (result.action === "queued" ? 202 : 200) : 400)).send(result);
  });

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
    if (reviewCmd) {
      return handleReviewCommand(cpbRoot, reviewCmd, req.log, {
        policy: opts.channelPolicy || null,
        channel: "feishu",
        actor: {
          userId: event.sender?.sender_id?.user_id || event.sender?.id || event.message.sender?.id || null,
          channelId: event.message.chat_id || null,
        },
        hubRoot: req.cpbHubRoot || cpbRoot,
      });
    }

    const commandText = text.trim();
    const command = parseChannelCommand(commandText);
    if (!command.ok && command.code === "NOT_CPB_COMMAND") {
      const legacy = parseCommand(text);
      if (!legacy) return { ok: true, parsed: false };
      return queueChannelCommand(cpbRoot, {
        ok: true,
        channel: "feishu",
        actor: {
          userId: event.sender?.sender_id?.user_id || event.sender?.id || null,
          channelId: event.message.chat_id || null,
        },
        command: {
          ok: true,
          type: "run",
          command: "run",
          project: legacy.project,
          task: legacy.task,
          job: null,
          issue: null,
          workflow: "standard",
        },
        commandText,
      }, {
        channel: "feishu",
        commandText,
        hubRoot: req.cpbHubRoot || cpbRoot,
      }, { policy: opts.channelPolicy || null });
    }

    return queueChannelCommand(cpbRoot, {
      ok: command.ok,
      channel: "feishu",
      actor: {
        userId: event.sender?.sender_id?.user_id || event.sender?.id || null,
        channelId: event.message.chat_id || null,
      },
      command,
      commandText,
    }, {
      channel: "feishu",
      commandText,
      hubRoot: req.cpbHubRoot || cpbRoot,
    }, { policy: opts.channelPolicy || null });
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
    if (reviewCmd) {
      return handleReviewCommand(cpbRoot, reviewCmd, req.log, {
        policy: opts.channelPolicy || null,
        channel: "dingtalk",
        actor: {
          userId: body.senderId || null,
          channelId: body.conversationId || null,
        },
        hubRoot: req.cpbHubRoot || cpbRoot,
      });
    }

    const commandText = text.trim();
    const command = parseChannelCommand(commandText);
    if (!command.ok && command.code === "NOT_CPB_COMMAND") {
      const legacy = parseCommand(text);
      if (!legacy) return { ok: true, parsed: false };
      return queueChannelCommand(cpbRoot, {
        ok: true,
        channel: "dingtalk",
        actor: {
          userId: body.senderId || null,
          channelId: body.conversationId || null,
        },
        command: {
          ok: true,
          type: "run",
          command: "run",
          project: legacy.project,
          task: legacy.task,
          job: null,
          issue: null,
          workflow: "standard",
        },
        commandText,
      }, {
        channel: "dingtalk",
        commandText,
        hubRoot: req.cpbHubRoot || cpbRoot,
      }, { policy: opts.channelPolicy || null });
    }

    return queueChannelCommand(cpbRoot, {
      ok: command.ok,
      channel: "dingtalk",
      actor: {
        userId: body.senderId || null,
        channelId: body.conversationId || null,
      },
      command,
      commandText,
    }, {
      channel: "dingtalk",
      commandText,
      hubRoot: req.cpbHubRoot || cpbRoot,
    }, { policy: opts.channelPolicy || null });
  });
}
