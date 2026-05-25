import { createHmac, timingSafeEqual } from "node:crypto";
import { parseChannelCommand } from "./channel-commands.js";
import { channelPolicyRequest, enforceChannelPolicy } from "./channel-policy.js";
import { createChannelQueueJob } from "./event-source.js";
import { cancelJob, listJobsAcrossRuntimeRoots, retryJob } from "./job-store.js";
import { jobToQueueRow } from "./job-projection.js";
import { readEvents } from "./event-store.js";
import { approveGate } from "./approval-gate.js";
import { listQueue, updateEntry } from "./hub-queue.js";

const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

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
} = {}) {
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

export function parseSlackSlashCommand(payload = {}) {
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
  };
}

function actionTypeFromId(actionId = "") {
  const normalized = String(actionId || "").trim().toLowerCase();
  return normalized.split(/[:.]/).filter(Boolean).pop() || null;
}

function parseActionValue(value) {
  if (!value || typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return /^job-[A-Za-z0-9-]+$/.test(value) ? { job: value } : {};
  }
}

export function parseSlackInteractiveAction(payload = {}) {
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

async function findJobById(cpbRoot, jobId) {
  const jobs = await listJobsAcrossRuntimeRoots(cpbRoot);
  return jobs.find((job) => job.jobId === jobId) || null;
}

function isQueueEntryId(value) {
  return /^q-[A-Za-z0-9-]+$/.test(String(value || ""));
}

async function findQueueEntryById(hubRoot, queueEntryId) {
  if (!isQueueEntryId(queueEntryId)) return null;
  const entries = await listQueue(hubRoot);
  return entries.find((entry) => entry.id === queueEntryId) || null;
}

function queueEntryStatus(entry) {
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

function policyDenied(decision) {
  return {
    ok: false,
    code: "CHANNEL_POLICY_DENIED",
    statusCode: 403,
    reason: decision.reason,
  };
}

async function authorizeSlackCommand(cpbRoot, policy, parsed, { action, project = null, job = null } = {}) {
  if (!policy) return { allowed: true, reason: "channel policy not configured" };
  return enforceChannelPolicy(cpbRoot, policy, channelPolicyRequest({
    channel: "slack",
    action,
    project,
    job,
    actor: parsed.actor,
  }));
}

export async function handleSlackSlashCommand(cpbRoot, parsed, { policy = null, hubRoot = cpbRoot } = {}) {
  const command = parsed?.command;
  if (!parsed?.ok || !command?.ok) {
    return {
      ok: false,
      channel: "slack",
      action: "help",
      parsed,
      error: command?.message || "invalid Slack command",
    };
  }

  if (command.type === "run" || command.type === "issue") {
    const decision = await authorizeSlackCommand(cpbRoot, policy, parsed, {
      action: command.type,
      project: command.project,
    });
    if (!decision.allowed) {
      return {
        ...policyDenied(decision),
        channel: "slack",
        action: command.type,
        parsed,
      };
    }

    const result = await createChannelQueueJob(cpbRoot, command, {
      channel: "slack",
      actor: parsed.actor.userId,
      actorName: parsed.actor.userName,
      teamId: parsed.actor.teamId,
      channelId: parsed.actor.channelId,
      channelName: parsed.actor.channelName,
      triggerId: parsed.triggerId,
      commandText: parsed.commandText,
    }, {
      hubRoot,
    });
    return {
      ok: result.status === "created",
      channel: "slack",
      action: result.status === "created" ? "queued" : result.status,
      parsed,
      queueEntry: result.queueEntry,
      candidateEntry: result.entry,
      job: jobSummary(result.job),
      actions: result.job
        ? slackActionMetadata(result.job.jobId)
        : (result.queueEntry ? slackQueueActionMetadata(result.queueEntry.id) : null),
    };
  }

  if (command.type === "status") {
    const job = await findJobById(cpbRoot, command.job);
    if (!job) {
      const queueEntry = await findQueueEntryById(hubRoot, command.job);
      if (queueEntry) {
        const decision = await authorizeSlackCommand(cpbRoot, policy, parsed, {
          action: "status",
          project: queueEntry.projectId,
          job: queueEntry.id,
        });
        if (!decision.allowed) {
          return {
            ...policyDenied(decision),
            channel: "slack",
            action: "status",
            parsed,
          };
        }

        return {
          ok: true,
          channel: "slack",
          action: "status",
          parsed,
          status: queueEntryStatus(queueEntry),
          actions: slackQueueActionMetadata(queueEntry.id),
        };
      }
    }
    if (!job) {
      return {
        ok: false,
        channel: "slack",
        action: "status",
        parsed,
        error: `job not found: ${command.job}`,
      };
    }
    const decision = await authorizeSlackCommand(cpbRoot, policy, parsed, {
      action: "status",
      project: job.project,
      job: job.jobId,
    });
    if (!decision.allowed) {
      return {
        ...policyDenied(decision),
        channel: "slack",
        action: "status",
        parsed,
      };
    }

    return {
      ok: true,
      channel: "slack",
      action: "status",
      parsed,
      status: jobToQueueRow(job),
      actions: slackActionMetadata(job.jobId),
    };
  }

  if (command.type === "approve" || command.type === "cancel" || command.type === "retry" || command.type === "logs") {
    const job = await findJobById(cpbRoot, command.job);
    if (!job && (command.type === "approve" || command.type === "cancel" || command.type === "retry")) {
      const queueEntry = await findQueueEntryById(hubRoot, command.job);
      if (queueEntry) {
        const decision = await authorizeSlackCommand(cpbRoot, policy, parsed, {
          action: command.type,
          project: queueEntry.projectId,
          job: queueEntry.id,
        });
        if (!decision.allowed) {
          return {
            ...policyDenied(decision),
            channel: "slack",
            action: command.type,
            parsed,
          };
        }

        const ts = new Date().toISOString();
        if (command.type === "approve") {
          if (queueEntry.status !== "waiting.approval") {
            return {
              ok: false,
              channel: "slack",
              action: "approve",
              parsed,
              error: `queue entry is not waiting for approval: ${queueEntry.id}`,
            };
          }
          const updated = await updateEntry(hubRoot, queueEntry.id, {
            status: "pending",
            metadata: {
              approvedAt: ts,
              approvedBy: parsed.actor.userId || null,
            },
          });
          return {
            ok: true,
            channel: "slack",
            action: "approved",
            actor: parsed.actor,
            approvedAt: ts,
            queueEntry: updated,
            status: queueEntryStatus(updated),
            actions: slackQueueActionMetadata(updated.id),
          };
        }

        if (command.type === "retry") {
          const updated = await updateEntry(hubRoot, queueEntry.id, {
            status: "pending",
            claimedBy: null,
            claimedAt: null,
            workerId: null,
            metadata: {
              retryReason: `Retried from Slack by ${parsed.actor.userId || "unknown user"}`,
              retriedAt: ts,
              retriedBy: parsed.actor.userId || null,
            },
          });
          return {
            ok: true,
            channel: "slack",
            action: "retried",
            actor: parsed.actor,
            retriedAt: ts,
            queueEntry: updated,
            status: queueEntryStatus(updated),
            actions: slackQueueActionMetadata(updated.id),
          };
        }

        const updated = await updateEntry(hubRoot, queueEntry.id, {
          status: "cancelled",
          metadata: {
            cancelReason: `Cancelled from Slack by ${parsed.actor.userId || "unknown user"}`,
            cancelledAt: ts,
            cancelledBy: parsed.actor.userId || null,
          },
        });
        return {
          ok: true,
          channel: "slack",
          action: "cancelled",
          actor: parsed.actor,
          cancelledAt: ts,
          queueEntry: updated,
          status: queueEntryStatus(updated),
          actions: slackQueueActionMetadata(updated.id),
        };
      }
    }
    if (!job) {
      return {
        ok: false,
        channel: "slack",
        action: command.type,
        parsed,
        error: `job not found: ${command.job}`,
      };
    }
    const decision = await authorizeSlackCommand(cpbRoot, policy, parsed, {
      action: command.type,
      project: job.project,
      job: job.jobId,
    });
    if (!decision.allowed) {
      return {
        ...policyDenied(decision),
        channel: "slack",
        action: command.type,
        parsed,
      };
    }

    const ts = new Date().toISOString();
    if (command.type === "approve") {
      const approved = await approveGate(cpbRoot, job.project, job.jobId, {
        actor: parsed.actor,
        action: command,
        ts,
      });
      return {
        ok: true,
        channel: "slack",
        action: "approved",
        actor: parsed.actor,
        approvedAt: ts,
        job: jobSummary(approved),
      };
    }

    if (command.type === "cancel") {
      const cancelled = await cancelJob(cpbRoot, job.project, job.jobId, {
        reason: `Cancelled from Slack by ${parsed.actor.userId || "unknown user"}`,
        ts,
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

    if (command.type === "retry") {
      const retry = await retryJob(cpbRoot, job.project, job.jobId, {
        trigger: "slack",
        force: true,
        ts,
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

    const events = await readEvents(cpbRoot, job.project, job.jobId);
    return {
      ok: true,
      channel: "slack",
      action: "logs",
      parsed,
      job: jobSummary(job),
      events: events.slice(-20),
    };
  }

  return {
    ok: false,
    channel: "slack",
    action: command.type,
    parsed,
    error: `${command.type} is not wired yet`,
  };
}

export async function handleSlackInteractiveAction(cpbRoot, parsed, { policy = null } = {}) {
  if (!parsed?.ok || !parsed.action?.type || !parsed.action?.job) {
    return {
      ok: false,
      channel: "slack",
      action: "invalid",
      parsed,
      error: "invalid Slack interactive action",
    };
  }

  const job = await findJobById(cpbRoot, parsed.action.job);
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
