// Merged from: git-platform-adapter.ts, git-adapters/github.ts, github-triggers.ts, github-events.ts

import { recordValue, type LooseRecord } from "../../../shared/types.js";
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

const adapterCache = new Map<string, LooseRecord>();

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

function recordArray(value: unknown): LooseRecord[] {
  return Array.isArray(value) ? value.map(recordValue) : [];
}

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

export function registerAdapter(adapter: LooseRecord) {
  const validated = validateGitPlatformAdapter(adapter);
  adapterCache.set(stringValue(validated.platform), validated);
  return validated;
}

// ============================================================
// git-adapters/github.ts exports
// ============================================================

export function createGithubAdapter() {
  const adapter = {
    boundaryVersion: BOUNDARY_VERSION,
    platform: "github",

    async resolveTransport(hubRoot: string, options: LooseRecord = {}) {
      const transport = await resolveGithubTransport(hubRoot, { env: recordValue(options).env });
      return validateTransportResult(transport);
    },

    normalizeWebhookEvent(raw: LooseRecord) {
      return normalizeGithubWebhookEvent(raw);
    },

    matchTrigger(event: LooseRecord, rules: LooseRecord[]) {
      return matchGithubTrigger(event, rules);
    },

    normalizeIssue(raw: LooseRecord, options: LooseRecord = {}) {
      return normalizeGithubIssue(recordValue(raw), recordValue(options));
    },

    async readIssues(hubRoot: string) {
      return readGithubIssues(hubRoot);
    },

    async syncIssues(hubRoot: string, options: LooseRecord = {}) {
      return syncGithubIssuesFromGh(hubRoot, options);
    },

    buildIssueBranchParts(options: LooseRecord = {}) {
      return buildGithubIssueBranchParts(recordValue(options));
    },

    async loadConfig(hubRoot: string) {
      return loadGithubAppConfig(hubRoot);
    },

    validateConfig(raw: LooseRecord = {}) {
      return validateGithubAppConfig(raw);
    },

    resolveWebhookSecret(config: LooseRecord, options: LooseRecord = {}) {
      const env = recordValue(options).env;
      return resolveGithubWebhookSecret(config, env && typeof env === "object" && !Array.isArray(env) ? { env: env as NodeJS.ProcessEnv } : {});
    },

    verifyWebhookSignature(options: LooseRecord) {
      return verifyGithubWebhookSignature(options);
    },
  };

  return validateGitPlatformAdapter(adapter);
}

// ============================================================
// github-triggers.ts exports
// ============================================================

function eventKey(event: LooseRecord) {
  if (!event?.event || !event?.action) return null;
  return `${event.event}.${event.action}`;
}

function sameText(a: unknown, b: unknown) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function commandMatches(commandText: unknown, expected: unknown) {
  const command = String(commandText || "").trim();
  const prefix = String(expected || "").trim();
  return prefix !== "" && (command === prefix || command.startsWith(`${prefix} `));
}

function labelMatches(event: LooseRecord, label: unknown) {
  const expected = String(label || "").toLowerCase();
  if (!expected) return false;
  const labels = Array.isArray(event.labels) ? event.labels : [];
  return sameText(event.label, expected) || labels.some((name: unknown) => sameText(name, expected));
}

function matchRule(event: LooseRecord, rule: LooseRecord) {
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

export function matchGithubTrigger(event: LooseRecord, rules: LooseRecord[] = DEFAULT_GITHUB_TRIGGERS) {
  for (const rule of rules || []) {
    const reason = matchRule(event, rule);
    if (!reason) continue;
    return {
      matched: true,
      workflow: rule.workflow || "standard",
      planMode: rule.planMode || null,
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


function ignored(event: string | null, reason: string) {
  return {
    status: "ignored",
    event,
    reason,
  };
}

function repoFullName(payload: LooseRecord = {}) {
  const repository = recordValue(payload.repository);
  return repository.full_name || repository.nameWithOwner || repository.fullName || null;
}

function actorLogin(payload: LooseRecord = {}) {
  const sender = recordValue(payload.sender);
  const actor = recordValue(payload.actor);
  return sender.login || actor.login || sender.name || null;
}

function issueAuthorAssociation(issue: LooseRecord = {}) {
  const author = recordValue(issue.author);
  return issue.author_association || issue.authorAssociation || author.association || null;
}

function baseEnvelope({ event, delivery, projectId, payload, type, issue, url, commandText = null }) {
  const payloadRecord = recordValue(payload);
  const issueRecord = recordValue(issue);
  const normalizedIssue = issue ? normalizeGithubIssue(issueRecord, { repo: stringValue(repoFullName(payloadRecord)), projectId: stringValue(projectId) }) : null;
  const authorAssociation = issue ? issueAuthorAssociation(issueRecord) : null;
  return {
    status: "ok",
    type,
    event,
    delivery: delivery || null,
    repo: repoFullName(payload),
    projectId: projectId || normalizedIssue?.projectId || null,
    issueNumber: normalizedIssue?.number ?? null,
    actor: actorLogin(payload),
    action: payloadRecord.action || null,
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
  const payloadRecord = recordValue(payload);
  const issue = recordValue(payloadRecord.issue);
  const label = recordValue(payloadRecord.label);
  if (!payloadRecord.issue) return ignored(event, "issues payload missing issue");
  return {
    ...baseEnvelope({
      event,
      delivery,
      projectId,
      payload: payloadRecord,
      type: "github_issue",
      issue,
      url: issue.html_url || issue.url || null,
    }),
    label: label.name || null,
  };
}

function normalizeIssueCommentEvent({ event, delivery, projectId, payload }) {
  const payloadRecord = recordValue(payload);
  const issue = recordValue(payloadRecord.issue);
  const comment = recordValue(payloadRecord.comment);
  if (!payloadRecord.issue) return ignored(event, "issue_comment payload missing issue");
  const result = baseEnvelope({
    event,
    delivery,
    projectId,
    payload: payloadRecord,
    type: "github_issue_comment",
    issue,
    url: comment.html_url || issue.html_url || issue.url || null,
    commandText: comment.body || "",
  });
  // Use comment author's association (not issue author's) for permission checks
  const commentAssoc = comment.author_association || null;
  if (commentAssoc) {
    result.authorAssociation = commentAssoc;
    result.raw.authorAssociation = commentAssoc;
  }
  return result;
}

function normalizeInstallationEvent({ event, delivery, payload }) {
  const payloadRecord = recordValue(payload);
  const installation = recordValue(payloadRecord.installation);
  return {
    status: "ok",
    type: "github_installation",
    event,
    delivery: delivery || null,
    repo: null,
    projectId: null,
    issueNumber: null,
    actor: actorLogin(payloadRecord),
    action: payloadRecord.action || null,
    commandText: null,
    labels: [],
    url: null,
    installationId: installation.id ?? null,
    repositories: normalizeGithubLabels(
      recordArray(payloadRecord.repositories || payloadRecord.repositories_added || payloadRecord.repositories_removed)
        .map((repo) => repo.full_name || repo.nameWithOwner || repo.fullName || repo.name),
    ),
  };
}

export function normalizeGithubWebhookEvent(
  { event, delivery, payload = {}, projectId = null }: LooseRecord = {},
) {
  const eventName = stringValue(event);
  const payloadRecord = recordValue(payload);
  if (eventName === "issues") {
    return normalizeIssuesEvent({ event: eventName, delivery, projectId, payload: payloadRecord });
  }
  if (eventName === "issue_comment") {
    return normalizeIssueCommentEvent({ event: eventName, delivery, projectId, payload: payloadRecord });
  }
  if (eventName === "installation" || eventName === "installation_repositories") {
    return normalizeInstallationEvent({ event: eventName, delivery, payload: payloadRecord });
  }
  return ignored(eventName || null, `unsupported event: ${eventName || "unknown"}`);
}
