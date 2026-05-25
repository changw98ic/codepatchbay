import { normalizeGithubIssue, normalizeGithubLabels } from "./github-issues.js";

function ignored(event, reason) {
  return {
    status: "ignored",
    event,
    reason,
  };
}

function repoFullName(payload = {}) {
  return payload.repository?.full_name || payload.repository?.nameWithOwner || payload.repository?.fullName || null;
}

function actorLogin(payload = {}) {
  return payload.sender?.login || payload.actor?.login || payload.sender?.name || null;
}

function issueAuthorAssociation(issue = {}) {
  return issue.author_association || issue.authorAssociation || issue.author?.association || null;
}

function baseEnvelope({ event, delivery, projectId, payload, type, issue, url, commandText = null }) {
  const normalizedIssue = issue ? normalizeGithubIssue(issue, { repo: repoFullName(payload), projectId }) : null;
  const authorAssociation = issue ? issueAuthorAssociation(issue) : null;
  return {
    status: "ok",
    type,
    event,
    delivery: delivery || null,
    repo: repoFullName(payload),
    projectId: projectId || normalizedIssue?.projectId || null,
    issueNumber: normalizedIssue?.number ?? null,
    actor: actorLogin(payload),
    action: payload.action || null,
    commandText,
    labels: normalizedIssue?.labels || [],
    url: url || normalizedIssue?.url || null,
    title: normalizedIssue?.title || null,
    body: normalizedIssue?.body || null,
    authorAssociation,
    raw: {
      action: payload.action || null,
      authorAssociation,
    },
  };
}

function normalizeIssuesEvent({ event, delivery, projectId, payload }) {
  if (!payload.issue) return ignored(event, "issues payload missing issue");
  return {
    ...baseEnvelope({
      event,
      delivery,
      projectId,
      payload,
      type: "github_issue",
      issue: payload.issue,
      url: payload.issue.html_url || payload.issue.url || null,
    }),
    label: payload.label?.name || null,
  };
}

function normalizeIssueCommentEvent({ event, delivery, projectId, payload }) {
  if (!payload.issue) return ignored(event, "issue_comment payload missing issue");
  return baseEnvelope({
    event,
    delivery,
    projectId,
    payload,
    type: "github_issue_comment",
    issue: payload.issue,
    url: payload.comment?.html_url || payload.issue.html_url || payload.issue.url || null,
    commandText: payload.comment?.body || "",
  });
}

function normalizeInstallationEvent({ event, delivery, payload }) {
  return {
    status: "ok",
    type: "github_installation",
    event,
    delivery: delivery || null,
    repo: null,
    projectId: null,
    issueNumber: null,
    actor: actorLogin(payload),
    action: payload.action || null,
    commandText: null,
    labels: [],
    url: null,
    installationId: payload.installation?.id ?? null,
    repositories: normalizeGithubLabels(
      (payload.repositories || payload.repositories_added || payload.repositories_removed || [])
        .map((repo) => repo.full_name || repo.nameWithOwner || repo.fullName || repo.name),
    ),
  };
}

export function normalizeGithubWebhookEvent({ event, delivery, payload = {}, projectId = null } = {}) {
  if (event === "issues") {
    return normalizeIssuesEvent({ event, delivery, projectId, payload });
  }
  if (event === "issue_comment") {
    return normalizeIssueCommentEvent({ event, delivery, projectId, payload });
  }
  if (event === "installation" || event === "installation_repositories") {
    return normalizeInstallationEvent({ event, delivery, payload });
  }
  return ignored(event || null, `unsupported event: ${event || "unknown"}`);
}
