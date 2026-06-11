import { createHmac, timingSafeEqual, createPublicKey, verify, createHash } from "node:crypto";
import { parseChannelCommand } from "./channel-commands.js";
import { channelPolicyRequest, enforceChannelPolicy } from "./channel-commands.js";
import { approveGate } from "../auto-finalizer.js";
import { createChannelQueueJob, enqueueSddTaskEntriesForApprovedParent } from "../event/event-source.js";
import { appendEvent, readEvents } from "../event/event-store.js";
import { listQueue, updateEntry } from "../hub/hub-queue.js";
import { cancelJob, listJobsAcrossRuntimeRoots, retryJob } from "../job/job-store.js";
import { jobToQueueRow } from "../job/job-projection.js";
import { resolveProjectDataRoot } from "../runtime.js";

type AnyRecord = Record<string, any>;

// ============================================================
// channel-queue-actions (formerly channel-queue-actions.ts)
// ============================================================

function titleCaseChannel(channel) {
  const value = String(channel || "channel");
  return value ? value[0].toUpperCase() + value.slice(1) : "Channel";
}

export function channelJobSummary(job) {
  if (!job) return null;
  return {
    jobId: job.jobId,
    project: job.project,
    task: job.task,
    workflow: job.workflow || "standard",
    status: job.status || null,
  };
}

export function channelJobActionMetadata(jobId) {
  return {
    viewRun: {
      type: "link",
      label: "View Run",
      url: `/jobs/${jobId}`,
      value: jobId,
    },
    cancel: {
      type: "command",
      label: "Cancel",
      command: `/cpb cancel ${jobId}`,
      value: jobId,
    },
  };
}

export function channelQueueActionMetadata(queueEntryId) {
  return {
    status: {
      type: "command",
      label: "Status",
      command: `/cpb status ${queueEntryId}`,
      value: queueEntryId,
    },
    cancel: {
      type: "command",
      label: "Cancel",
      command: `/cpb cancel ${queueEntryId}`,
      value: queueEntryId,
    },
    retry: {
      type: "command",
      label: "Retry",
      command: `/cpb retry ${queueEntryId}`,
      value: queueEntryId,
    },
  };
}

async function findChannelJobById(cpbRoot, jobId, { hubRoot = cpbRoot }: LooseRecord = {}) {
  const jobs = await listJobsAcrossRuntimeRoots(cpbRoot, { hubRoot });
  const job = jobs.find((entry) => entry.jobId === jobId) || null;
  if (!job) return { job: null, dataRoot: null };
  const dataRoot = await resolveProjectDataRoot(cpbRoot, job.project, { hubRoot });
  return { job, dataRoot };
}

function isQueueEntryId(value) {
  return /^q-[A-Za-z0-9-]+$/.test(String(value || ""));
}

export async function findQueueEntryById(hubRoot, queueEntryId) {
  if (!isQueueEntryId(queueEntryId)) return null;
  const entries = await listQueue(hubRoot);
  return entries.find((entry) => entry.id === queueEntryId) || null;
}

export function queueEntryStatus(entry) {
  if (!entry) return null;
  return {
    queueEntryId: entry.id,
    jobId: null,
    project: entry.projectId,
    task: entry.description || entry.id,
    workflow: entry.metadata?.workflow || "standard",
    status: entry.status,
    source: {
      type: entry.metadata?.source || entry.type || "queue",
      channel: entry.metadata?.channel || null,
      repo: entry.metadata?.repo || null,
      issueNumber: entry.metadata?.issueNumber ?? null,
    },
    createdAt: entry.createdAt || null,
    updatedAt: entry.updatedAt || null,
  };
}

export function channelPolicyDenied(decision) {
  return {
    ok: false,
    code: "CHANNEL_POLICY_DENIED",
    statusCode: 403,
    reason: decision.reason,
  };
}

async function authorizeChannelAction(
  cpbRoot,
  policy,
  { channel, action, project = null, job = null, actor = null }: AnyRecord = {},
) {
  if (!policy) return { allowed: true, reason: "channel policy not configured" };
  return enforceChannelPolicy(cpbRoot, policy, channelPolicyRequest({
    channel,
    action,
    project,
    job,
    actor,
  }));
}

function actorId(actor: AnyRecord = {}) {
  return actor.userId || actor.id || "unknown user";
}

async function handleQueueEntryAction(hubRoot, queueEntry, command, parsed, { channel, queueActionMetadata }) {
  const ts = new Date().toISOString();
  const actor = parsed.actor || {};
  const label = titleCaseChannel(channel);

  if (command.type === "approve") {
    if (queueEntry.status !== "waiting.approval") {
      return {
        ok: false,
        channel,
        action: "approve",
        parsed,
        error: `queue entry is not waiting for approval: ${queueEntry.id}`,
      };
    }
    const sddTaskQueueEntries = await enqueueSddTaskEntriesForApprovedParent(hubRoot, queueEntry);
    const updated = await updateEntry(hubRoot, queueEntry.id, {
      status: queueEntry.metadata?.sddApproval?.requiresApproval ? "completed" : "pending",
      metadata: {
        approvedAt: ts,
        approvedBy: actor.userId || null,
        finalDisposition: queueEntry.metadata?.sddApproval?.requiresApproval
          ? "approved.children_queued"
          : queueEntry.metadata?.finalDisposition,
        sddApproval: queueEntry.metadata?.sddApproval?.requiresApproval ? {
          ...queueEntry.metadata.sddApproval,
          status: "approved",
          approvedAt: ts,
          approvedBy: actor.userId || null,
          childQueueEntryIds: sddTaskQueueEntries.map((entry) => entry.id),
        } : queueEntry.metadata?.sddApproval,
      },
    });
    return {
      ok: true,
      channel,
      action: "approved",
      actor,
      approvedAt: ts,
      queueEntry: updated,
      sddTaskQueueEntries,
      status: queueEntryStatus(updated),
      actions: queueActionMetadata(updated.id),
    };
  }

  if (command.type === "retry") {
    const updated = await updateEntry(hubRoot, queueEntry.id, {
      status: "pending",
      claimedBy: null,
      claimedAt: null,
      workerId: null,
      metadata: {
        retryReason: `Retried from ${label} by ${actorId(actor)}`,
        retriedAt: ts,
        retriedBy: actor.userId || null,
      },
    });
    return {
      ok: true,
      channel,
      action: "retried",
      actor,
      retriedAt: ts,
      queueEntry: updated,
      status: queueEntryStatus(updated),
      actions: queueActionMetadata(updated.id),
    };
  }

  const updated = await updateEntry(hubRoot, queueEntry.id, {
    status: "cancelled",
    metadata: {
      cancelReason: `Cancelled from ${label} by ${actorId(actor)}`,
      cancelledAt: ts,
      cancelledBy: actor.userId || null,
    },
  });
  return {
    ok: true,
    channel,
    action: "cancelled",
    actor,
    cancelledAt: ts,
    queueEntry: updated,
    status: queueEntryStatus(updated),
    actions: queueActionMetadata(updated.id),
  };
}

async function handleJobAction(cpbRoot, job, dataRoot, command, parsed, { channel, jobActionMetadata }) {
  const ts = new Date().toISOString();
  const actor = parsed.actor || {};
  const label = titleCaseChannel(channel);

  if (command.type === "approve") {
    const approved = await approveGate(cpbRoot, job.project, job.jobId, {
      actor,
      action: command,
      ts,
      dataRoot,
    });
    return {
      ok: true,
      channel,
      action: "approved",
      actor,
      approvedAt: ts,
      job: channelJobSummary(approved),
    };
  }

  if (command.type === "cancel") {
    const cancelled = await cancelJob(cpbRoot, job.project, job.jobId, {
      reason: `Cancelled from ${label} by ${actorId(actor)}`,
      ts,
      dataRoot,
    });
    return {
      ok: true,
      channel,
      action: "cancelled",
      actor,
      cancelledAt: ts,
      job: channelJobSummary(cancelled),
    };
  }

  if (command.type === "retry") {
    const retry = await retryJob(cpbRoot, job.project, job.jobId, {
      trigger: channel,
      force: true,
      ts,
      dataRoot,
    });
    return {
      ok: true,
      channel,
      action: "retried",
      actor,
      retriedAt: ts,
      job: channelJobSummary(retry),
      recoveryOf: job.jobId,
      actions: jobActionMetadata(retry.jobId),
    };
  }

  const events = await readEvents(cpbRoot, job.project, job.jobId, { dataRoot });
  return {
    ok: true,
    channel,
    action: "logs",
    parsed,
    job: channelJobSummary(job),
    events: events.slice(-20),
  };
}

export async function handleChannelCommand(cpbRoot, parsed, {
  policy = null,
  hubRoot = cpbRoot,
  channel = parsed?.channel || "channel",
  context = {} as AnyRecord,
  jobActionMetadata = channelJobActionMetadata,
  queueActionMetadata = channelQueueActionMetadata,
}: AnyRecord = {}) {
  const command = parsed?.command;
  if (!parsed?.ok || !command?.ok) {
    return {
      ok: false,
      channel,
      action: "help",
      parsed,
      error: command?.message || "invalid channel command",
    };
  }

  if (command.type === "run" || command.type === "issue") {
    const decision = await authorizeChannelAction(cpbRoot, policy, {
      channel,
      action: command.type,
      project: command.project,
      actor: parsed.actor || {},
    });
    if (!decision.allowed) {
      return {
        ...channelPolicyDenied(decision),
        channel,
        action: command.type,
        parsed,
      };
    }

    const result = await createChannelQueueJob(cpbRoot, command, {
      channel,
      actor: parsed.actor?.userId || context.actor || null,
      actorName: parsed.actor?.userName || context.actorName || null,
      teamId: parsed.actor?.teamId || parsed.actor?.guildId || context.teamId || null,
      channelId: parsed.actor?.channelId || context.channelId || null,
      channelName: parsed.actor?.channelName || context.channelName || null,
      triggerId: parsed.triggerId || parsed.interactionId || context.triggerId || null,
      commandText: parsed.commandText || context.commandText || null,
    }, { hubRoot });

    return {
      ok: result.status === "created",
      channel,
      action: result.status === "created" ? "queued" : result.status,
      parsed,
      queueEntry: result.queueEntry,
      candidateEntry: result.entry,
      job: channelJobSummary(result.job),
      actions: result.job
        ? jobActionMetadata(result.job.jobId)
        : (result.queueEntry ? queueActionMetadata(result.queueEntry.id) : null),
    };
  }

  if (command.type === "status") {
    const { job } = await findChannelJobById(cpbRoot, command.job, { hubRoot });
    if (!job) {
      const queueEntry = await findQueueEntryById(hubRoot, command.job);
      if (queueEntry) {
        const decision = await authorizeChannelAction(cpbRoot, policy, {
          channel,
          action: "status",
          project: queueEntry.projectId,
          job: queueEntry.id,
          actor: parsed.actor || {},
        });
        if (!decision.allowed) {
          return {
            ...channelPolicyDenied(decision),
            channel,
            action: "status",
            parsed,
          };
        }
        return {
          ok: true,
          channel,
          action: "status",
          parsed,
          status: queueEntryStatus(queueEntry),
          actions: queueActionMetadata(queueEntry.id),
        };
      }
    }
    if (!job) {
      return {
        ok: false,
        channel,
        action: "status",
        parsed,
        error: `job not found: ${command.job}`,
      };
    }

    const decision = await authorizeChannelAction(cpbRoot, policy, {
      channel,
      action: "status",
      project: job.project,
      job: job.jobId,
      actor: parsed.actor || {},
    });
    if (!decision.allowed) {
      return {
        ...channelPolicyDenied(decision),
        channel,
        action: "status",
        parsed,
      };
    }

    return {
      ok: true,
      channel,
      action: "status",
      parsed,
      status: jobToQueueRow(job),
      actions: jobActionMetadata(job.jobId),
    };
  }

  if (command.type === "approve" || command.type === "cancel" || command.type === "retry" || command.type === "logs") {
    const { job, dataRoot } = await findChannelJobById(cpbRoot, command.job, { hubRoot });
    if (!job && command.type !== "logs") {
      const queueEntry = await findQueueEntryById(hubRoot, command.job);
      if (queueEntry) {
        const decision = await authorizeChannelAction(cpbRoot, policy, {
          channel,
          action: command.type,
          project: queueEntry.projectId,
          job: queueEntry.id,
          actor: parsed.actor || {},
        });
        if (!decision.allowed) {
          return {
            ...channelPolicyDenied(decision),
            channel,
            action: command.type,
            parsed,
          };
        }
        return handleQueueEntryAction(hubRoot, queueEntry, command, parsed, {
          channel,
          queueActionMetadata,
        });
      }
    }
    if (!job) {
      return {
        ok: false,
        channel,
        action: command.type,
        parsed,
        error: `job not found: ${command.job}`,
      };
    }

    const decision = await authorizeChannelAction(cpbRoot, policy, {
      channel,
      action: command.type,
      project: job.project,
      job: job.jobId,
      actor: parsed.actor || {},
    });
    if (!decision.allowed) {
      return {
        ...channelPolicyDenied(decision),
        channel,
        action: command.type,
        parsed,
      };
    }
    return handleJobAction(cpbRoot, job, dataRoot, command, parsed, {
      channel,
      jobActionMetadata,
    });
  }

  return {
    ok: false,
    channel,
    action: command.type,
    parsed,
    error: `${command.type} is not wired for ${channel}`,
  };
}

// ============================================================
// channel-slack (formerly channel-slack.ts)
// ============================================================

const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

type LooseRecord = Record<string, any>;

function rawBodyText(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody.toString("utf8");
  return String(rawBody ?? "");
}

function expectedSlackSignature(signingSecret, timestamp, rawBody) {
  const base = `v0:${timestamp}:${rawBodyText(rawBody)}`;
  return `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
}

function signaturesMatch(expected, actual) {
  if (!expected || !actual) return false;
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

export function verifySlackSignature({
  signingSecret,
  timestamp,
  signature,
  rawBody,
  nowMs = Date.now(),
  toleranceSeconds = DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
}: LooseRecord = {}) {
  if (!signingSecret) return { ok: false, reason: "Slack signing secret is not configured" };
  if (!timestamp || !signature) return { ok: false, reason: "missing Slack signature headers" };

  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampSeconds)) return { ok: false, reason: "invalid Slack timestamp" };

  const ageSeconds = Math.abs(Math.floor(nowMs / 1000) - timestampSeconds);
  if (ageSeconds > toleranceSeconds) return { ok: false, reason: "stale Slack request timestamp" };

  const expected = expectedSlackSignature(signingSecret, timestamp, rawBody);
  if (!signaturesMatch(expected, signature)) return { ok: false, reason: "invalid Slack signature" };
  return { ok: true };
}

export function parseSlackFormBody(rawBody) {
  const params = new URLSearchParams(rawBodyText(rawBody));
  return Object.fromEntries(params.entries());
}

export function parseSlackSlashCommand(payload: LooseRecord = {}) {
  const commandText = [payload.command || "/cpb", payload.text || ""]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ");
  const command = parseChannelCommand(commandText);
  return {
    ok: command.ok,
    channel: "slack",
    actor: {
      userId: payload.user_id || null,
      userName: payload.user_name || null,
      teamId: payload.team_id || null,
      channelId: payload.channel_id || null,
      channelName: payload.channel_name || null,
    },
    command,
    triggerId: payload.trigger_id || null,
    commandText,
    responseUrlPresent: Boolean(payload.response_url),
  };
}

export function slackActionMetadata(jobId) {
  return {
    viewRun: {
      type: "link",
      label: "View Run",
      url: `/jobs/${jobId}`,
      value: jobId,
    },
    cancel: {
      type: "command",
      label: "Cancel",
      command: `/cpb cancel ${jobId}`,
      value: jobId,
    },
  };
}

export function slackQueueActionMetadata(queueEntryId) {
  return {
    status: {
      type: "command",
      label: "Status",
      command: `/cpb status ${queueEntryId}`,
      value: queueEntryId,
    },
    cancel: {
      type: "command",
      label: "Cancel",
      command: `/cpb cancel ${queueEntryId}`,
      value: queueEntryId,
    },
    retry: {
      type: "command",
      label: "Retry",
      command: `/cpb retry ${queueEntryId}`,
      value: queueEntryId,
    },
  };
}

function actionTypeFromId(actionId = "") {
  const normalized = String(actionId || "").trim().toLowerCase();
  return normalized.split(/[:.]/).filter(Boolean).pop() || null;
}

function parseActionValue(value): LooseRecord {
  if (!value || typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return /^job-[A-Za-z0-9-]+$/.test(value) ? { job: value } : {};
  }
}

export function parseSlackInteractiveAction(payload: LooseRecord = {}) {
  const rawAction = Array.isArray(payload.actions) ? payload.actions[0] : null;
  const actionValue = parseActionValue(rawAction?.value);
  const type = actionValue.action || actionValue.type || actionTypeFromId(rawAction?.action_id);
  const job = actionValue.job || actionValue.jobId || null;
  const actor = {
    userId: payload.user?.id || null,
    userName: payload.user?.username || payload.user?.name || null,
    teamId: payload.team?.id || null,
    channelId: payload.channel?.id || null,
    channelName: payload.channel?.name || null,
  };

  return {
    ok: Boolean(type && job),
    channel: "slack",
    actor,
    action: {
      type,
      job,
      actionId: rawAction?.action_id || null,
      blockId: rawAction?.block_id || null,
      value: rawAction?.value || null,
    },
    responseUrlPresent: Boolean(payload.response_url),
  };
}

function jobSummary(job) {
  if (!job) return null;
  return {
    jobId: job.jobId,
    project: job.project,
    task: job.task,
    workflow: job.workflow || "standard",
    status: job.status || null,
  };
}

function policyDenied(decision) {
  return {
    ok: false,
    code: "CHANNEL_POLICY_DENIED",
    statusCode: 403,
    reason: decision.reason,
  };
}

async function authorizeSlackCommand(cpbRoot, policy, parsed, { action, project = null, job = null }: LooseRecord = {}) {
  if (!policy) return { allowed: true, reason: "channel policy not configured" };
  return enforceChannelPolicy(cpbRoot, policy, channelPolicyRequest({
    channel: "slack",
    action,
    project,
    job,
    actor: parsed.actor,
  } as LooseRecord));
}

export async function handleSlackSlashCommand(cpbRoot, parsed, { policy = null, hubRoot = cpbRoot }: LooseRecord = {}) {
  return handleChannelCommand(cpbRoot, parsed, {
    policy,
    hubRoot,
    channel: "slack",
    jobActionMetadata: slackActionMetadata,
    queueActionMetadata: slackQueueActionMetadata,
  });
}

export async function handleSlackInteractiveAction(cpbRoot, parsed, { policy = null, hubRoot = cpbRoot }: LooseRecord = {}) {
  if (!parsed?.ok || !parsed.action?.type || !parsed.action?.job) {
    return {
      ok: false,
      channel: "slack",
      action: "invalid",
      parsed,
      error: "invalid Slack interactive action",
    };
  }

  const { job, dataRoot } = await findChannelJobById(cpbRoot, parsed.action.job, { hubRoot });
  if (!job) {
    return {
      ok: false,
      channel: "slack",
      action: parsed.action.type,
      parsed,
      error: `job not found: ${parsed.action.job}`,
    };
  }

  const decision = await authorizeSlackCommand(cpbRoot, policy, parsed, {
    action: parsed.action.type,
    project: job.project,
    job: job.jobId,
  });
  if (!decision.allowed) {
    return {
      ...policyDenied(decision),
      channel: "slack",
      action: parsed.action.type,
      parsed,
    };
  }

  const ts = new Date().toISOString();
  if (parsed.action.type === "approve") {
    await approveGate(cpbRoot, job.project, job.jobId, {
      actor: parsed.actor,
      action: parsed.action,
      ts,
      dataRoot,
    });
    return {
      ok: true,
      channel: "slack",
      action: "approved",
      actor: parsed.actor,
      approvedAt: ts,
      job: jobSummary(job),
    };
  }

  if (parsed.action.type === "cancel") {
    const cancelled = await cancelJob(cpbRoot, job.project, job.jobId, {
      reason: `Cancelled from Slack by ${parsed.actor.userId || "unknown user"}`,
      ts,
      dataRoot,
    });
    return {
      ok: true,
      channel: "slack",
      action: "cancelled",
      actor: parsed.actor,
      cancelledAt: ts,
      job: jobSummary(cancelled),
    };
  }

  if (parsed.action.type === "retry") {
    const retry = await retryJob(cpbRoot, job.project, job.jobId, {
      trigger: "slack",
      force: true,
      ts,
      dataRoot,
    });
    return {
      ok: true,
      channel: "slack",
      action: "retried",
      actor: parsed.actor,
      retriedAt: ts,
      job: jobSummary(retry),
      recoveryOf: job.jobId,
      actions: slackActionMetadata(retry.jobId),
    };
  }

  return {
    ok: false,
    channel: "slack",
    action: parsed.action.type,
    parsed,
    error: `unsupported Slack action: ${parsed.action.type}`,
  };
}

// ============================================================
// channel-discord (formerly channel-discord.ts)
// ============================================================

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function discordPublicKeyFromHex(publicKeyHex) {
  if (!/^[a-f0-9]{64}$/i.test(String(publicKeyHex || ""))) {
    throw new Error("invalid Discord public key");
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]),
    format: "der",
    type: "spki",
  });
}

export function verifyDiscordSignature({
  publicKey,
  timestamp,
  signature,
  rawBody,
}: AnyRecord = {}) {
  if (!publicKey) return { ok: false, reason: "Discord public key is not configured" };
  if (!timestamp || !signature) return { ok: false, reason: "missing Discord signature headers" };

  try {
    const key = discordPublicKeyFromHex(publicKey);
    const message = Buffer.from(`${timestamp}${rawBodyText(rawBody)}`, "utf8");
    const signatureBytes = Buffer.from(signature, "hex");
    const ok = verify(null, message, key, signatureBytes);
    return ok ? { ok: true } : { ok: false, reason: "invalid Discord signature" };
  } catch (error) {
    return { ok: false, reason: error.message || "invalid Discord signature" };
  }
}

function optionValue(options = [], names = []) {
  const wanted = new Set(names);
  const found = options.find((option) => wanted.has(option.name));
  return found?.value ?? null;
}

export function parseDiscordInteraction(payload: AnyRecord = {}) {
  if (payload.type === 1) {
    return { ok: true, channel: "discord", type: "ping" };
  }

  const data: AnyRecord = payload.data || {};
  const commandText = data.name === "cpb"
    ? ["/cpb", optionValue(data.options, ["command", "text", "input"]) || ""].join(" ").trim()
    : ["/cpb", data.name || "", optionValue(data.options, ["command", "text", "input"]) || ""].join(" ").trim();
  const command = parseChannelCommand(commandText);
  const user = payload.member?.user || payload.user || {};

  return {
    ok: command.ok,
    channel: "discord",
    actor: {
      userId: user.id || null,
      userName: user.username || user.global_name || null,
      guildId: payload.guild_id || null,
      channelId: payload.channel_id || null,
    },
    command,
    interactionId: payload.id || null,
    tokenPresent: Boolean(payload.token),
  };
}

export async function authorizeDiscordInteraction(cpbRoot, policy, parsed) {
  if (!policy || parsed?.type === "ping") return { allowed: true, reason: "channel policy not configured" };
  const command = parsed?.command;
  const request = channelPolicyRequest({
    channel: "discord",
    action: command?.type || null,
    project: command?.project || null,
    job: command?.job || null,
    actor: parsed?.actor,
  });
  return enforceChannelPolicy(cpbRoot, policy, request);
}

// ============================================================
// slack-comments (formerly slack-comments.ts)
// ============================================================

const SLACK_STATUS_COMMENT_STATUSES = new Set(["blocked", "failed", "passed", "pr-opened"]);

function hashBody(body) {
  return createHash("sha256").update(body || "", "utf8").digest("hex");
}

function responseSummary(response) {
  if (!response || typeof response !== "object") return null;
  return {
    channel: response.channel ?? null,
    ts: response.ts ?? null,
  };
}

function slackStatusHeading(status) {
  if (status === "blocked") return "CodePatchBay blocked this run.";
  if (status === "failed") return "CodePatchBay failed this run.";
  if (status === "passed") return "Verified patch ready.";
  if (status === "pr-opened") return "Draft PR opened.";
  return "CodePatchBay updated this run.";
}

function slackStatusDetailLines(row) {
  if (row.status === "blocked") return [`Reason: ${row.lastActivityMessage || "approval or manual review required"}`];
  if (row.status === "failed") return [
    `Phase: ${row.failurePhase || row.currentPhase || "unknown"}`,
    `Reason: ${row.lastActivityMessage || "run failed before verification completed"}`,
  ];
  if (row.status === "passed") return [
    `Workflow: ${row.workflow || "standard"}`,
    `Retries: ${row.retryCount ?? 0}`,
  ];
  if (row.status === "pr-opened") return [
    `PR: ${row.pr?.number ? `#${row.pr.number}` : row.pr?.url || "created"}`,
    `URL: ${row.pr?.url || "unavailable"}`,
  ];
  return [`Status: ${row.status || "unknown"}`];
}

export function slackStatusDedupeKey(row) {
  if (!row?.jobId || !row?.status) return null;
  const prMarker = row.pr?.url || row.pr?.number || "";
  return ["slack-status", row.jobId, row.status, prMarker]
    .filter((part) => part !== null && part !== undefined && String(part).length > 0)
    .map((part) => String(part))
    .join(":");
}

export function buildSlackStatusMessage({ job, projection }: AnyRecord = {}) {
  const row = projection || jobToQueueRow(job || {});
  return [
    slackStatusHeading(row.status),
    "",
    `Job: ${row.jobId || "unknown"}`,
    `Project: ${row.project || "unknown"}`,
    ...slackStatusDetailLines(row),
  ].join("\n");
}

export async function postSlackMessageWithBotToken({
  channel,
  text,
  token = process.env.CPB_SLACK_BOT_TOKEN,
}, { fetchFn = globalThis.fetch } = {}) {
  if (!token) throw new Error("Slack bot token is not configured");
  if (!channel) throw new Error("Slack channel id is required");
  if (typeof fetchFn !== "function") throw new Error("fetch is not available for Slack transport");

  const response = await fetchFn("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || `Slack API returned HTTP ${response.status}`);
  }
  return body;
}

async function alreadyPostedSlackStatus(cpbRoot, project, jobId, dedupeKey, { dataRoot }: AnyRecord = {}) {
  if (!cpbRoot || !project || !jobId || !dedupeKey) return false;
  const events = await readEvents(cpbRoot, project, jobId, { dataRoot });
  return events.some((event) => (
    event.type === "slack_message_posted" &&
    event.messageKind === "terminal-status" &&
    event.dedupeKey === dedupeKey
  ));
}

export async function postSlackStatusComment({
  cpbRoot,
  project,
  job,
  projection,
  dryRun = false,
  postMessage,
  dataRoot,
}: AnyRecord = {}) {
  const row = projection || jobToQueueRow(job || {});
  if (!SLACK_STATUS_COMMENT_STATUSES.has(row.status)) {
    return { status: "skipped", posted: false, reason: "job is not a terminal Slack status update" };
  }

  const source = job?.sourceContext || {};
  if (source.type !== "slack" && source.channel !== "slack") {
    return { status: "skipped", posted: false, reason: "job source is not Slack" };
  }
  const channel = source.channelId || row.source?.channel || null;
  if (!channel) return { status: "skipped", posted: false, reason: "Slack channel id is missing" };

  const body = buildSlackStatusMessage({ job, projection: row });
  const dedupeKey = slackStatusDedupeKey(row);
  const auditProject = project || row.project;
  const request = { channel, text: body };

  if (await alreadyPostedSlackStatus(cpbRoot, auditProject, row.jobId, dedupeKey, { dataRoot })) {
    return { status: "duplicate", posted: false, dedupeKey, request, body };
  }
  if (dryRun) return { status: "dry-run", posted: false, dedupeKey, request, body };

  if (typeof postMessage !== "function" && !process.env.CPB_SLACK_BOT_TOKEN) {
    return { status: "skipped", posted: false, reason: "Slack bot token is not configured", dedupeKey, request, body };
  }

  try {
    const response = await (postMessage || ((req) => postSlackMessageWithBotToken(req)))(request);
    await appendEvent(cpbRoot, auditProject, row.jobId, {
      type: "slack_message_posted",
      jobId: row.jobId,
      project: auditProject,
      messageKind: "terminal-status",
      status: row.status,
      dedupeKey,
      channel,
      bodyHash: hashBody(body),
      response: responseSummary(response),
      ts: new Date().toISOString(),
    }, { dataRoot });
    return { status: "posted", posted: true, dedupeKey, request, body, response };
  } catch (error) {
    if (cpbRoot && auditProject && row.jobId) {
      await appendEvent(cpbRoot, auditProject, row.jobId, {
        type: "slack_message_failed",
        jobId: row.jobId,
        project: auditProject,
        messageKind: "terminal-status",
        status: row.status,
        dedupeKey,
        channel,
        bodyHash: hashBody(body),
        error: { message: error.message, code: error.code || null },
        ts: new Date().toISOString(),
      }, { dataRoot }).catch(() => {});
    }
    return {
      status: "failed",
      posted: false,
      dedupeKey,
      request,
      body,
      error: { message: error.message, code: error.code || null },
    };
  }
}
