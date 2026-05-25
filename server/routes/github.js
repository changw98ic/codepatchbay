import {
  loadGithubAppConfig,
  resolveGithubWebhookSecret,
  verifyGithubWebhookSignature,
} from "../services/github-app.js";
import { normalizeGithubWebhookEvent } from "../services/github-events.js";
import { matchGithubTrigger } from "../services/github-triggers.js";
import { createGithubIssueQueueJob } from "../services/event-source.js";
import { listProjects } from "../services/hub-registry.js";
import { resolveGithubTransport } from "../services/github-api.js";
import {
  postGithubQueuedComment,
} from "../services/github-comments.js";

function rawBodyBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  return Buffer.from(JSON.stringify(body ?? {}), "utf8");
}

function headerValue(headers, name) {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function findProjectByRepo(hubRoot, repo) {
  if (!repo) return null;
  const projects = await listProjects(hubRoot, { enabledOnly: true });
  return projects.find((project) => project.github?.fullName === repo) || null;
}

function responseBase({ event, delivery, action }) {
  return {
    accepted: true,
    event,
    delivery,
    action: action || null,
  };
}

export async function githubRoutes(fastify, opts = {}) {
  fastify.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  fastify.post("/github/webhook", async (req, reply) => {
    const rawBody = rawBodyBuffer(req.body);
    let config;
    let secret;
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

    let payload;
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

    const normalized = normalizeGithubWebhookEvent({
      event,
      delivery,
      payload,
      projectId: project.id,
    });
    if (normalized.status !== "ok") {
      return reply.code(202).send({ ...base, normalized });
    }

    const match = matchGithubTrigger(normalized, project.github?.triggers);
    if (!match.matched) {
      return reply.code(202).send({ ...base, normalized, projectId: project.id, match });
    }

    const queue = await createGithubIssueQueueJob(req.cpbRoot || req.cpbHubRoot, normalized, match, {
      hubRoot: req.cpbHubRoot,
      sourcePath: project.sourcePath || null,
    });
    const transport = await resolveGithubTransport(req.cpbHubRoot);
    const comment = await postGithubQueuedComment({
      repo: normalized.repo,
      issueNumber: normalized.issueNumber,
      job: queue.job,
      queueEntry: queue.queueEntry,
      dryRun: opts.githubDryRun === true,
      postComment: opts.githubPostComment || transport.postComment,
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
    });
  });
}
