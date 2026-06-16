// Merged from: git-platform-adapter.ts, git-adapters/github.ts, github-triggers.ts, github-events.ts

import { AnyRecord } from "../../../shared/types.js";
import { isValidPlatform, validateGitPlatformAdapter } from "../../../core/contracts/git-platform.js";
import { BOUNDARY_VERSION, validateTransportResult } from "../../../core/contracts/git-platform.js";
import { resolveGithubTransport } from "./github-api.js";
import { normalizeGithubIssue, readGithubIssues, syncGithubIssuesFromGh, normalizeGithubLabels } from "./github-issues.js";
import { buildGithubIssueBranchParts } from "./github-issues.js";
import {
  loadGithubAppConfig,
  resolveGithubWebhookSecret,
  verifyGithubWebhookSignature,
  validateGithubAppConfig,
} from "./github-api.js";
import { DEFAULT_GITHUB_TRIGGERS } from "../hub/hub-registry.js";

// ============================================================
// git-platform-adapter.ts exports
// ============================================================

const DEFAULT_PLATFORM = "github";

const adapterCache = new Map<string, Record<string, any>>();

export function resolveGitPlatform(platformHint?: string | null, options: { platform?: string } = {}) {
  let platform;
  if (typeof platformHint === "string" && platformHint.length > 0) {
    platform = platformHint;
  } else {
    platform = options.platform || DEFAULT_PLATFORM;
  }

  const cached = adapterCache.get(platform);
  if (cached) return cached;

  if (platform === "github") {
    const adapter = createGithubAdapter();
    adapterCache.set(platform, adapter);
    return adapter;
  }

  throw new Error(`git-platform: unsupported platform '${platform}'. Supported: github`);
}

export function clearAdapterCache() {
  adapterCache.clear();
}

export function registerAdapter(adapter: Record<string, any>) {
  const validated = validateGitPlatformAdapter(adapter);
  adapterCache.set(validated.platform, validated);
  return validated;
}

// ============================================================
// git-adapters/github.ts exports
// ============================================================

export function createGithubAdapter() {
  const adapter = {
    boundaryVersion: BOUNDARY_VERSION,
    platform: "github",

    async resolveTransport(hubRoot, options: Record<string, any> = {}) {
      const transport = await resolveGithubTransport(hubRoot, { env: options.env });
      return validateTransportResult(transport);
    },

    normalizeWebhookEvent(raw) {
      return normalizeGithubWebhookEvent(raw);
    },

    matchTrigger(event, rules) {
      return matchGithubTrigger(event, rules);
    },

    normalizeIssue(raw, options = {}) {
      return normalizeGithubIssue(raw, options);
    },

    async readIssues(hubRoot) {
      return readGithubIssues(hubRoot);
    },

    async syncIssues(hubRoot, options = {}) {
      return syncGithubIssuesFromGh(hubRoot, options);
    },

    buildIssueBranchParts(options = {}) {
      return buildGithubIssueBranchParts(options);
    },

    async loadConfig(hubRoot) {
      return loadGithubAppConfig(hubRoot);
    },

    validateConfig(raw = {}) {
      return validateGithubAppConfig(raw);
    },

    resolveWebhookSecret(config, options = {}) {
      return resolveGithubWebhookSecret(config, options);
    },

    verifyWebhookSignature(options) {
      return verifyGithubWebhookSignature(options);
    },
  };

  return validateGitPlatformAdapter(adapter);
}

// ============================================================
// github-triggers.ts exports
// ============================================================

function eventKey(event) {
  if (!event?.event || !event?.action) return null;
  return `${event.event}.${event.action}`;
}

function sameText(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function commandMatches(commandText, expected) {
  const command = String(commandText || "").trim();
  const prefix = String(expected || "").trim();
  return prefix !== "" && (command === prefix || command.startsWith(`${prefix} `));
}

function labelMatches(event, label) {
  const expected = String(label || "").toLowerCase();
  if (!expected) return false;
  return sameText(event.label, expected) || (event.labels || []).some((name) => sameText(name, expected));
}

function matchRule(event, rule) {
  if (!event || event.status !== "ok") return null;
  if (rule.event && rule.event !== eventKey(event)) return null;

  if (rule.label && labelMatches(event, rule.label)) {
    return `matched label ${rule.label}`;
  }

  if (rule.command && commandMatches(event.commandText, rule.command)) {
    return `matched command ${rule.command}`;
  }

  if (!rule.label && !rule.command) {
    return `matched ${rule.event || eventKey(event)}`;
  }

  return null;
}

export function matchGithubTrigger(event, rules = DEFAULT_GITHUB_TRIGGERS) {
  for (const rule of rules || []) {
    const reason = matchRule(event, rule);
    if (!reason) continue;
    return {
      matched: true,
      workflow: rule.workflow || "standard",
      planMode: (rule as any).planMode || null,
      rule,
      reason,
    };
  }
  return {
    matched: false,
    workflow: null,
    rule: null,
    reason: "no trigger rule matched",
  };
}

// ============================================================
// github-events.ts exports
// ============================================================


function ignored(event, reason) {
  return {
    status: "ignored",
    event,
    reason,
  };
}

function repoFullName(payload: AnyRecord = {}) {
  return payload.repository?.full_name || payload.repository?.nameWithOwner || payload.repository?.fullName || null;
}

function actorLogin(payload: AnyRecord = {}) {
  return payload.sender?.login || payload.actor?.login || payload.sender?.name || null;
}

function issueAuthorAssociation(issue: AnyRecord = {}) {
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
  const result = baseEnvelope({
    event,
    delivery,
    projectId,
    payload,
    type: "github_issue_comment",
    issue: payload.issue,
    url: payload.comment?.html_url || payload.issue.html_url || payload.issue.url || null,
    commandText: payload.comment?.body || "",
  });
  // Use comment author's association (not issue author's) for permission checks
  const commentAssoc = payload.comment?.author_association || null;
  if (commentAssoc) {
    result.authorAssociation = commentAssoc;
    result.raw.authorAssociation = commentAssoc;
  }
  return result;
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

export function normalizeGithubWebhookEvent(
  { event, delivery, payload = {}, projectId = null }: AnyRecord = {},
) {
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
