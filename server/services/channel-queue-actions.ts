import { approveGate } from "./approval-gate.js";
import { channelPolicyRequest, enforceChannelPolicy } from "./channel-policy.js";
import { createChannelQueueJob, enqueueSddTaskEntriesForApprovedParent } from "./event-source.js";
import { readEvents } from "./event-store.js";
import { listQueue, updateEntry } from "./hub-queue.js";
import { cancelJob, listJobsAcrossRuntimeRoots, retryJob } from "./job-store.js";
import { jobToQueueRow } from "./job-projection.js";

type AnyRecord = Record<string, any>;

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

export async function findChannelJobById(cpbRoot, jobId) {
  const jobs = await listJobsAcrossRuntimeRoots(cpbRoot);
  return jobs.find((job) => job.jobId === jobId) || null;
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

async function handleJobAction(cpbRoot, job, command, parsed, { channel, jobActionMetadata }) {
  const ts = new Date().toISOString();
  const actor = parsed.actor || {};
  const label = titleCaseChannel(channel);

  if (command.type === "approve") {
    const approved = await approveGate(cpbRoot, job.project, job.jobId, {
      actor,
      action: command,
      ts,
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

  const events = await readEvents(cpbRoot, job.project, job.jobId);
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
    const job = await findChannelJobById(cpbRoot, command.job);
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
    const job = await findChannelJobById(cpbRoot, command.job);
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
    return handleJobAction(cpbRoot, job, command, parsed, {
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
