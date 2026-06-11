import {
  loadGithubAppConfig,
  resolveGithubWebhookSecret,
  verifyGithubWebhookSignature,
} from "../services/github-app.js";
import { normalizeGithubWebhookEvent } from "../services/github-events.js";
import { matchGithubTrigger } from "../services/github-triggers.js";
import { createGithubIssueQueueJob, enqueueSddTaskEntriesForApprovedParent } from "../services/event-source.js";
import { listProjects } from "../services/hub-registry.js";
import { resolveGithubTransport } from "../services/github-api.js";
import {
  buildSddApprovedComment,
  postGithubQueuedComment,
} from "../services/github-comments.js";
import { parseChannelCommand } from "../services/channel-commands.js";
import { channelPolicyRequest, enforceChannelPolicy } from "../services/channel-policy.js";
import { loadQueue, updateEntry } from "../services/hub-queue.js";

type AnyRecord = Record<string, any>;

function rawBodyBuffer(body: any): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  return Buffer.from(JSON.stringify(body ?? {}), "utf8");
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

export async function githubRoutes(fastify: any, opts: AnyRecord = {}) {
  fastify.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req: any, body: any, done: any) => {
    done(null, body);
  });

  fastify.post("/github/webhook", async (req: any, reply: any) => {
    const rawBody = rawBodyBuffer(req.body);
    let config: AnyRecord;
    let secret: any;
    try {
      config = await loadGithubAppConfig(req.cpbHubRoot);
      secret = resolveGithubWebhookSecret(config);
    } catch {
      return reply.code(401).send({ error: "invalid GitHub webhook signature" });
    }

    const signature = headerValue(req.headers, "x-hub-signature-256");
    const valid = verifyGithubWebhookSignature({ signature, rawBody, secret });
    if (!valid) {
      return reply.code(401).send({ error: "invalid GitHub webhook signature" });
    }

    let payload: AnyRecord;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return reply.code(400).send({ error: "invalid JSON payload" });
    }

    const event = headerValue(req.headers, "x-github-event") || null;
    const delivery = headerValue(req.headers, "x-github-delivery") || null;
    const base = responseBase({ event, delivery, action: payload.action });
    const project = await findProjectByRepo(req.cpbHubRoot, payload.repository?.full_name || null);
    if (!project) return reply.code(202).send(base);

    const normalized: AnyRecord = (normalizeGithubWebhookEvent as any)({
      event,
      delivery,
      payload,
      projectId: project.id,
    });
    if (normalized.status !== "ok") {
      return reply.code(202).send({ ...base, normalized });
    }

    // Handle GitHub issue comment commands (e.g., /cpb approve)
    if (normalized.type === "github_issue_comment" && normalized.action === "created" && normalized.commandText) {
      const parsed = parseChannelCommand(normalized.commandText);
      if (parsed.ok && parsed.command === "approve" && parsed.job) {
        const queue: AnyRecord = await loadQueue(req.cpbHubRoot);
        const entry = queue.entries.find((e) => e.id === parsed.job);

        const trustedAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
        const permissionDenied = (reason: string) => reply.code(403).send({
          ...base, normalized, projectId: project.id, commandHandled: "approve", error: reason,
        });

        if (!entry || entry.status !== "waiting.approval") {
          return reply.code(202).send({ ...base, normalized, projectId: project.id });
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
          const decision = await enforceChannelPolicy(req.cpbHubRoot, opts.channelPolicy, (channelPolicyRequest as any)({
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
            return reply.code(403).send({
              ...base,
              normalized,
              projectId: project.id,
              commandHandled: "approve",
              code: "CHANNEL_POLICY_DENIED",
              error: decision.reason,
            });
          }
        }

        {
          const ts = new Date().toISOString();
          const sddTaskQueueEntries = await enqueueSddTaskEntriesForApprovedParent(req.cpbHubRoot, entry);
          await updateEntry(req.cpbHubRoot, entry.id, {
            status: entry.metadata?.sddApproval?.requiresApproval ? "completed" : "pending",
            metadata: {
              approvedAt: ts,
              approvedBy: normalized.actor || null,
              finalDisposition: "approved.children_queued",
              sddApproval: entry.metadata?.sddApproval ? {
                ...entry.metadata.sddApproval,
                status: "approved",
                approvedAt: ts,
                approvedBy: normalized.actor || null,
                childQueueEntryIds: sddTaskQueueEntries.map((e) => e.id),
              } : undefined,
            },
          });

          const transport = await resolveGithubTransport(req.cpbHubRoot);
          const postComment = opts.githubPostComment || transport.postComment;
          if (!opts.githubDryRun && typeof postComment === "function") {
            await postComment({
              repo: normalized.repo,
              issueNumber: normalized.issueNumber,
              body: buildSddApprovedComment({
                actor: normalized.actor,
                childCount: sddTaskQueueEntries.length,
                queueEntryId: entry.id,
              }),
            }).catch(() => {});
          }

          return reply.code(202).send({
            ...base,
            normalized,
            projectId: project.id,
            commandHandled: "approve",
            approved: { queueEntryId: entry.id, childCount: sddTaskQueueEntries.length },
          });
        }
      }
    }

    const match: AnyRecord = matchGithubTrigger(normalized, project.github?.triggers);
    if (!match.matched) {
      return reply.code(202).send({ ...base, normalized, projectId: project.id, match });
    }

    const queue: AnyRecord = await createGithubIssueQueueJob(req.cpbRoot || req.cpbHubRoot, normalized, match, {
      hubRoot: req.cpbHubRoot,
      sourcePath: project.sourcePath || null,
      sddDrafterMode: opts.sddDrafterMode,
      sddAcpPool: opts.sddAcpPool,
      sddDrafterAgent: opts.sddDrafterAgent,
      sddDrafterTimeoutMs: opts.sddDrafterTimeoutMs,
    } as any);
    const transport = await resolveGithubTransport(req.cpbHubRoot);
    const comment: AnyRecord = await (postGithubQueuedComment as any)({
      repo: normalized.repo,
      issueNumber: normalized.issueNumber,
      job: queue.job,
      queueEntry: queue.queueEntry,
      dryRun: opts.githubDryRun === true,
      postComment: opts.githubPostComment || transport.postComment,
      transportMode: transport.mode,
    });

    return reply.code(202).send({
      ...base,
      normalized,
      projectId: project.id,
      match,
      queue: {
        status: queue.status,
        candidateEntryId: queue.entry?.id || null,
        queueEntryId: queue.queueEntry?.id || null,
        jobId: queue.job?.jobId || null,
      },
      hubQueue: queue.queueEntry ? {
        id: queue.queueEntry.id,
        status: queue.queueEntry.status,
        projectId: queue.queueEntry.projectId,
      } : null,
      comment: {
        status: comment.status,
        posted: comment.posted,
      },
      transport: {
        mode: transport.mode,
        healthy: transport.healthy,
      },
    });
  });
}
