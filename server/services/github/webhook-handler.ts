import {
  loadGithubAppConfig,
  resolveGithubWebhookSecret,
  verifyGithubWebhookSignature,
  resolveGithubTransport,
} from "./github-api.js";
import { AnyRecord } from "../../../shared/types.js";
import { normalizeGithubWebhookEvent, matchGithubTrigger } from "./github-adapter.js";
import { createGithubIssueQueueJob } from "../event/event-source.js";
import { listProjects } from "../hub/hub-registry.js";
import {
  postGithubQueuedComment,
} from "./github-issues.js";
import { parseChannelCommand, channelPolicyRequest, enforceChannelPolicy } from "../channel/channel-commands.js";
import { loadQueue, updateEntry } from "../hub/hub-queue.js";


export interface WebhookRequest {
  rawBody: Buffer;
  headers: AnyRecord;
  hubRoot: string;
  cpbRoot: string;
  opts?: WebhookOptions;
}

export interface WebhookOptions {
  channelPolicy?: any;
  githubDryRun?: boolean;
  githubPostComment?: Function;
}

export interface WebhookResponse {
  statusCode: number;
  body: AnyRecord;
}

function headerValue(headers: AnyRecord, name: string): any {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function findProjectByRepo(hubRoot: string, repo: any): Promise<AnyRecord | null> {
  if (!repo) return null;
  const projects = await listProjects(hubRoot, { enabledOnly: true });
  return projects.find((project) => project.github?.fullName === repo) || null;
}

function responseBase({ event, delivery, action }: AnyRecord): AnyRecord {
  return {
    accepted: true,
    event,
    delivery,
    action: action || null,
  };
}

export async function handleGithubWebhook(req: WebhookRequest): Promise<WebhookResponse> {
  const { rawBody, headers, hubRoot, cpbRoot, opts = {} } = req;

  // Load config + verify signature
  let config: AnyRecord;
  let secret: any;
  try {
    config = await loadGithubAppConfig(hubRoot);
    secret = resolveGithubWebhookSecret(config);
  } catch {
    return { statusCode: 401, body: { error: "invalid GitHub webhook signature" } };
  }

  const signature = headerValue(headers, "x-hub-signature-256");
  const valid = verifyGithubWebhookSignature({ signature, rawBody, secret });
  if (!valid) {
    return { statusCode: 401, body: { error: "invalid GitHub webhook signature" } };
  }

  let payload: AnyRecord;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { statusCode: 400, body: { error: "invalid JSON payload" } };
  }

  const event = headerValue(headers, "x-github-event") || null;
  const delivery = headerValue(headers, "x-github-delivery") || null;
  const base = responseBase({ event, delivery, action: payload.action });
  const project = await findProjectByRepo(hubRoot, payload.repository?.full_name || null);
  if (!project) return { statusCode: 202, body: base };

  const normalized: AnyRecord = (normalizeGithubWebhookEvent as any)({
    event,
    delivery,
    payload,
    projectId: project.id,
  });
  if (normalized.status !== "ok") {
    return { statusCode: 202, body: { ...base, normalized } };
  }

  // Handle GitHub issue comment commands (e.g., /cpb approve)
  if (normalized.type === "github_issue_comment" && normalized.action === "created" && normalized.commandText) {
    const parsed = parseChannelCommand(normalized.commandText) as Record<string, any>;
    if (parsed.ok && parsed.command === "approve" && parsed.job) {
      const queue: AnyRecord = await loadQueue(hubRoot);
      const entry = queue.entries.find((e: any) => e.id === parsed.job);

      const trustedAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
      const permissionDenied = (reason: string) => ({
        statusCode: 403,
        body: { ...base, normalized, projectId: project.id, commandHandled: "approve", error: reason },
      });

      if (!entry || entry.status !== "waiting.approval") {
        return { statusCode: 202, body: { ...base, normalized, projectId: project.id } };
      }
      if (!trustedAssociations.has(normalized.authorAssociation)) {
        return permissionDenied("only repo collaborators can approve");
      }
      if (entry.metadata?.repo && entry.metadata.repo !== normalized.repo) {
        return permissionDenied("queue entry does not belong to this repo");
      }
      if (entry.metadata?.issueNumber && String(entry.metadata.issueNumber) !== String(normalized.issueNumber)) {
        return permissionDenied("queue entry does not belong to this issue");
      }
      if (opts.channelPolicy) {
        const decision = await enforceChannelPolicy(hubRoot, opts.channelPolicy, (channelPolicyRequest as any)({
          channel: "github",
          action: "approve",
          project: project.id,
          job: entry.id,
          actor: {
            userId: normalized.actor || null,
            channelId: normalized.repo || null,
          },
        }));
        if (!decision.allowed) {
          return {
            statusCode: 403,
            body: { ...base, normalized, projectId: project.id, commandHandled: "approve", code: "CHANNEL_POLICY_DENIED", error: decision.reason },
          };
        }
      }

      const ts = new Date().toISOString();
      await updateEntry(hubRoot, entry.id, {
        status: "pending",
        metadata: {
          approvedAt: ts,
          approvedBy: normalized.actor || null,
          finalDisposition: "approved",
        },
      });

      return {
        statusCode: 202,
        body: { ...base, normalized, projectId: project.id, commandHandled: "approve", approved: { queueEntryId: entry.id } },
      };
    }
  }

  const match: AnyRecord = matchGithubTrigger(normalized, project.github?.triggers);
  if (!match.matched) {
    return { statusCode: 202, body: { ...base, normalized, projectId: project.id, match } };
  }

  const queueResult: AnyRecord = await createGithubIssueQueueJob(cpbRoot, normalized, match, {
    hubRoot,
    sourcePath: project.sourcePath || null,
  } as any);
  const transport = await resolveGithubTransport(hubRoot);
  const comment: AnyRecord = await (postGithubQueuedComment as any)({
    repo: normalized.repo,
    issueNumber: normalized.issueNumber,
    job: queueResult.job,
    queueEntry: queueResult.queueEntry,
    dryRun: opts.githubDryRun === true,
    postComment: opts.githubPostComment || transport.postComment,
    transportMode: transport.mode,
  });

  return {
    statusCode: 202,
    body: {
      ...base,
      normalized,
      projectId: project.id,
      match,
      queue: {
        status: queueResult.status,
        candidateEntryId: queueResult.entry?.id || null,
        queueEntryId: queueResult.queueEntry?.id || null,
        jobId: queueResult.job?.jobId || null,
      },
      hubQueue: queueResult.queueEntry ? {
        id: queueResult.queueEntry.id,
        status: queueResult.queueEntry.status,
        projectId: queueResult.queueEntry.projectId,
      } : null,
      comment: {
        status: comment.status,
        posted: comment.posted,
      },
      transport: {
        mode: transport.mode,
        healthy: transport.healthy,
      },
    },
  };
}
