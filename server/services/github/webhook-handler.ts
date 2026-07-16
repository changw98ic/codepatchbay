import {
  loadGithubAppConfig,
  resolveGithubWebhookSecret,
  verifyGithubWebhookSignature,
  resolveGithubTransport,
} from "./github-api.js";
import type { LooseRecord } from "../../../shared/types.js";
import { normalizeGithubWebhookEvent, matchGithubTrigger } from "./github-adapter.js";
import { createGithubIssueQueueJob } from "../event/event-source.js";
import { listProjects } from "../hub/hub-registry.js";
import {
  postGithubQueuedComment,
} from "./github-issues.js";
import { parseChannelCommand, channelPolicyRequest, enforceChannelPolicy } from "../channel/channel-commands.js";
import { loadQueue, updateEntry } from "../hub/hub-queue.js";

type PostQueuedCommentOptions = NonNullable<Parameters<typeof postGithubQueuedComment>[0]>;
type GithubPostComment = PostQueuedCommentOptions["postComment"];
type GithubPostCommentResult = Awaited<ReturnType<NonNullable<GithubPostComment>>>;
type GithubEventForWebhook = Parameters<typeof createGithubIssueQueueJob>[1];
type GithubMatchForWebhook = Parameters<typeof createGithubIssueQueueJob>[2];
const TRUSTED_GITHUB_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export interface WebhookRequest {
  rawBody: Buffer;
  headers: LooseRecord;
  hubRoot: string;
  cpbRoot: string;
  opts?: WebhookOptions;
}

export interface WebhookOptions {
  channelPolicy?: LooseRecord;
  githubDryRun?: boolean;
  githubPostComment?: GithubPostComment;
}

export interface WebhookResponse {
  statusCode: number;
  body: LooseRecord;
}

function recordValue(value: unknown): LooseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as LooseRecord : {};
}

function recordOrNull(value: unknown): LooseRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as LooseRecord : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined;
}

function githubEvent(value: unknown): GithubEventForWebhook {
  const record = recordValue(value);
  return {
    ...record,
    source: stringValue(record.source) || undefined,
    status: stringValue(record.status) || undefined,
    delivery: stringValue(record.delivery) || undefined,
    event: stringValue(record.event) || undefined,
    repo: stringValue(record.repo) || undefined,
    action: stringValue(record.action) || undefined,
    commandText: stringValue(record.commandText) || undefined,
    label: stringValue(record.label) || undefined,
    labels: stringList(record.labels),
    title: stringValue(record.title) || undefined,
    body: stringValue(record.body) || undefined,
    url: stringValue(record.url) || undefined,
    actor: stringValue(record.actor) || undefined,
    projectId: stringValue(record.projectId) || undefined,
  };
}

function githubMatch(value: unknown): GithubMatchForWebhook {
  const record = recordValue(value);
  return {
    ...record,
    matched: record.matched === true,
    workflow: stringValue(record.workflow) || undefined,
    planMode: stringValue(record.planMode) || undefined,
    reason: stringValue(record.reason) || undefined,
  };
}

function githubPostCommentResult(value: unknown): GithubPostCommentResult {
  return recordValue(value) as GithubPostCommentResult;
}

function hasTrustedGithubAssociation(value: unknown): boolean {
  return TRUSTED_GITHUB_ASSOCIATIONS.has(String(value || "").trim().toUpperCase());
}

function isGithubCommentExecutionTrigger(event: LooseRecord): boolean {
  if (event.type !== "github_issue_comment" || event.action !== "created" || !event.commandText) return false;
  const commandText = String(event.commandText).trim();
  return commandText === "/cpb run" || commandText.startsWith("/cpb run ");
}

function headerValue(headers: LooseRecord, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

async function findProjectByRepo(hubRoot: string, repo: string | null): Promise<LooseRecord | null> {
  if (!repo) return null;
  const projectsRaw = await listProjects(hubRoot, { enabledOnly: true });
  const projects = Array.isArray(projectsRaw) ? projectsRaw.map(recordValue) : [];
  return projects.find((project) => recordValue(project.github).fullName === repo) || null;
}

function responseBase({ event, delivery, action }: LooseRecord): LooseRecord {
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
  let config: LooseRecord;
  let secret: string;
  try {
    config = recordValue(await loadGithubAppConfig(hubRoot));
    secret = resolveGithubWebhookSecret(config);
  } catch {
    return { statusCode: 401, body: { error: "invalid GitHub webhook signature" } };
  }

  const signature = headerValue(headers, "x-hub-signature-256");
  const valid = verifyGithubWebhookSignature({ signature, rawBody, secret });
  if (!valid) {
    return { statusCode: 401, body: { error: "invalid GitHub webhook signature" } };
  }

  let payload: LooseRecord;
  try {
    payload = recordValue(JSON.parse(rawBody.toString("utf8")));
  } catch {
    return { statusCode: 400, body: { error: "invalid JSON payload" } };
  }

  const event = headerValue(headers, "x-github-event") || null;
  const delivery = headerValue(headers, "x-github-delivery") || null;
  const base = responseBase({ event, delivery, action: payload.action });
  const repository = recordValue(payload.repository);
  const project = await findProjectByRepo(hubRoot, stringValue(repository.full_name));
  if (!project) return { statusCode: 202, body: base };

  const normalized = recordValue(normalizeGithubWebhookEvent({
    event,
    delivery,
    payload,
    projectId: project.id,
  }));
  if (normalized.status !== "ok") {
    return { statusCode: 202, body: { ...base, normalized } };
  }

  // Handle GitHub issue comment commands (e.g., /cpb approve)
  if (normalized.type === "github_issue_comment" && normalized.action === "created" && normalized.commandText) {
    const parsed = recordValue(parseChannelCommand(String(normalized.commandText)));
    if (parsed.ok && parsed.command === "approve" && parsed.job) {
      const queue = recordValue(await loadQueue(hubRoot));
      const entries = Array.isArray(queue.entries) ? queue.entries.map(recordValue) : [];
      const entry = entries.find((e) => e.id === parsed.job);

      const permissionDenied = (reason: string) => ({
        statusCode: 403,
        body: { ...base, normalized, projectId: project.id, commandHandled: "approve", error: reason },
      });

      if (!entry || entry.status !== "waiting.approval") {
        return { statusCode: 202, body: { ...base, normalized, projectId: project.id } };
      }
      if (!hasTrustedGithubAssociation(normalized.authorAssociation)) {
        return permissionDenied("only repo collaborators can approve");
      }
      const entryMetadata = recordValue(entry.metadata);
      if (entryMetadata.repo && entryMetadata.repo !== normalized.repo) {
        return permissionDenied("queue entry does not belong to this repo");
      }
      if (entryMetadata.issueNumber && String(entryMetadata.issueNumber) !== String(normalized.issueNumber)) {
        return permissionDenied("queue entry does not belong to this issue");
      }
      if (opts.channelPolicy) {
        const decision = await enforceChannelPolicy(hubRoot, opts.channelPolicy, channelPolicyRequest({
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

  const projectGithub = recordValue(project.github);
  const triggerRules = Array.isArray(projectGithub.triggers) ? projectGithub.triggers.map(recordValue) : undefined;
  const match = githubMatch(matchGithubTrigger(normalized, triggerRules));
  if (!match.matched) {
    return { statusCode: 202, body: { ...base, normalized, projectId: project.id, match } };
  }

  if (isGithubCommentExecutionTrigger(normalized) && !hasTrustedGithubAssociation(normalized.authorAssociation)) {
    return {
      statusCode: 403,
      body: {
        ...base,
        normalized,
        projectId: project.id,
        match,
        code: "GITHUB_ACTOR_FORBIDDEN",
        error: "only repo collaborators can trigger CodePatchBay execution",
      },
    };
  }

  const queueResult = recordValue(await createGithubIssueQueueJob(cpbRoot, githubEvent(normalized), match, {
    hubRoot,
    sourcePath: stringValue(project.sourcePath),
  }));
  const transport = recordValue(await resolveGithubTransport(hubRoot));
  const job = recordOrNull(queueResult.job);
  const queueEntry = recordOrNull(queueResult.queueEntry);
  const candidateEntry = recordOrNull(queueResult.entry);
  const rawPostComment = transport.postComment;
  const transportPostComment: GithubPostComment = typeof rawPostComment === "function"
    ? async (request) => githubPostCommentResult(await rawPostComment(request))
    : undefined;
  const postComment = typeof opts.githubPostComment === "function"
    ? opts.githubPostComment
    : transportPostComment;
  const comment = recordValue(await postGithubQueuedComment({
    repo: normalized.repo,
    issueNumber: normalized.issueNumber,
    job,
    queueEntry,
    dryRun: opts.githubDryRun === true,
    postComment,
    transportMode: stringValue(transport.mode),
  }));

  return {
    statusCode: 202,
    body: {
      ...base,
      normalized,
      projectId: project.id,
      match,
      queue: {
        status: queueResult.status,
        candidateEntryId: candidateEntry?.id || null,
        queueEntryId: queueEntry?.id || null,
        jobId: job?.jobId || null,
      },
      hubQueue: queueEntry ? {
        id: queueEntry.id,
        status: queueEntry.status,
        projectId: queueEntry.projectId,
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
