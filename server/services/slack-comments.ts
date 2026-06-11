// @ts-nocheck
import { createHash } from "node:crypto";
import { appendEvent, readEvents } from "./event-store.js";
import { jobToQueueRow } from "./job-projection.js";

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

export function buildSlackStatusMessage({ job, projection } = {}) {
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

async function alreadyPostedSlackStatus(cpbRoot, project, jobId, dedupeKey, { dataRoot } = {}) {
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
} = {}) {
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
