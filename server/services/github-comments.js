import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { appendEvent, readEvents } from "./event-store.js";
import { jobToGithubStatusUpdate } from "./job-projection.js";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function agentLine(label, value) {
  return `- ${label}: ${value || "not selected"}`;
}

function hashBody(body) {
  return createHash("sha256").update(body || "", "utf8").digest("hex");
}

function responseSummary(response) {
  if (!response || typeof response !== "object") return null;
  return {
    id: response.id ?? null,
    url: response.html_url || response.url || null,
  };
}

export async function postGithubCommentWithGh({ repo, issueNumber, body }, { runCommand = execFileAsync } = {}) {
  const result = await runCommand("gh", [
    "issue",
    "comment",
    String(issueNumber),
    "--repo",
    repo,
    "--body",
    body,
  ], { maxBuffer: 1024 * 1024 });
  return {
    url: null,
    html_url: null,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function statusHeading(status) {
  if (status === "blocked") return "CodePatchBay blocked this run.";
  if (status === "failed") return "CodePatchBay failed this run.";
  if (status === "passed") return "Verified patch ready.";
  if (status === "pr-opened") return "Draft PR opened.";
  return "CodePatchBay updated this run.";
}

function statusDetailLines(projection) {
  if (projection.status === "blocked") {
    return [`- Reason: ${projection.reason || "approval or manual review required"}`];
  }
  if (projection.status === "failed") {
    return [
      `- Phase: ${projection.failurePhase || "unknown"}`,
      `- Reason: ${projection.reason || "run failed before verification completed"}`,
    ];
  }
  if (projection.status === "passed") {
    return [
      `- Workflow: ${projection.workflow || "standard"}`,
      `- Retries: ${projection.retryCount ?? 0}`,
    ];
  }
  if (projection.status === "pr-opened") {
    const pr = projection.pr || {};
    const prLabel = pr.number ? `#${pr.number}` : pr.url || "created";
    return [
      `- PR: ${prLabel}`,
      `- URL: ${pr.url || "unavailable"}`,
    ];
  }
  return [`- Status: ${projection.status || "unknown"}`];
}

export function buildQueuedComment({ job = {}, queueEntry = null, agents = {} } = {}) {
  const normalizedJob = job || {};
  const workflow = normalizedJob.workflow || queueEntry?.payload?.workflow || queueEntry?.metadata?.workflow || "standard";
  return [
    "CodePatchBay queued this issue.",
    "",
    `- Job: ${normalizedJob.jobId || "pending"}`,
    queueEntry?.id ? `- Queue: ${queueEntry.id}` : null,
    `- Workflow: ${workflow}`,
    agentLine("Planner", agents.planner),
    agentLine("Executor", agents.executor),
    agentLine("Verifier", agents.verifier),
    "",
    "I'll post updates here.",
    "",
  ].filter((line) => line !== null).join("\n");
}

export async function postGithubQueuedComment({
  repo,
  issueNumber,
  job,
  queueEntry,
  agents,
  dryRun = false,
  postComment,
  transportMode = null,
} = {}) {
  const body = buildQueuedComment({ job, queueEntry, agents });
  const request = {
    repo,
    issueNumber,
    body,
  };

  if (dryRun) {
    return {
      status: "dry-run",
      posted: false,
      request,
      body,
      transportMode,
    };
  }

  try {
    if (typeof postComment !== "function") {
      throw new Error("GitHub comment transport not configured");
    }
    const response = await postComment(request);
    return {
      status: "posted",
      posted: true,
      request,
      body,
      response,
      transportMode,
    };
  } catch (error) {
    return {
      status: "failed",
      posted: false,
      request,
      body,
      error: {
        message: error.message,
        code: error.code || null,
      },
      transportMode,
    };
  }
}

export function buildGithubStatusComment({ projection, job } = {}) {
  const update = projection || jobToGithubStatusUpdate(job);
  if (!update) {
    throw new Error("GitHub terminal status projection is required");
  }

  return [
    statusHeading(update.status),
    "",
    `- Job: ${update.jobId || "unknown"}`,
    `- Issue: #${update.issueNumber}`,
    ...statusDetailLines(update),
    "",
  ].join("\n");
}

async function alreadyPostedStatusComment(cpbRoot, project, jobId, dedupeKey, { dataRoot } = {}) {
  if (!cpbRoot || !project || !jobId || !dedupeKey) return false;
  const events = await readEvents(cpbRoot, project, jobId, { dataRoot });
  return events.some((event) => (
    event.type === "github_comment_posted" &&
    event.commentKind === "terminal-status" &&
    event.dedupeKey === dedupeKey
  ));
}

export async function postGithubStatusComment({
  cpbRoot,
  project,
  job,
  projection,
  dryRun = false,
  postComment,
  dataRoot,
  transportMode = null,
} = {}) {
  const update = projection || jobToGithubStatusUpdate(job);
  if (!update) {
    return {
      status: "skipped",
      posted: false,
      reason: "job is not a terminal GitHub issue status update",
    };
  }

  const auditProject = project || update.project;
  const body = buildGithubStatusComment({ projection: update, job });
  const request = {
    repo: update.repo,
    issueNumber: update.issueNumber,
    body,
  };
  const dedupeKey = update.dedupeKey;

  if (await alreadyPostedStatusComment(cpbRoot, auditProject, update.jobId, dedupeKey, { dataRoot })) {
    return {
      status: "duplicate",
      posted: false,
      dedupeKey,
      request,
      body,
    };
  }

  if (dryRun) {
    return {
      status: "dry-run",
      posted: false,
      dedupeKey,
      request,
      body,
    };
  }

  try {
    if (typeof postComment !== "function") {
      throw new Error("GitHub comment transport not configured");
    }
    const response = await postComment(request);
    await appendEvent(cpbRoot, auditProject, update.jobId, {
      type: "github_comment_posted",
      jobId: update.jobId,
      project: auditProject,
      commentKind: "terminal-status",
      status: update.status,
      dedupeKey,
      repo: update.repo,
      issueNumber: update.issueNumber,
      bodyHash: hashBody(body),
      response: responseSummary(response),
      transportMode,
      transportFallback: transportMode === "gh",
      ts: new Date().toISOString(),
    }, { dataRoot });

    return {
      status: "posted",
      posted: true,
      dedupeKey,
      request,
      body,
      response,
    };
  } catch (error) {
    if (cpbRoot && auditProject && update.jobId) {
      await appendEvent(cpbRoot, auditProject, update.jobId, {
        type: "github_comment_failed",
        jobId: update.jobId,
        project: auditProject,
        commentKind: "terminal-status",
        status: update.status,
        dedupeKey,
        repo: update.repo,
        issueNumber: update.issueNumber,
        bodyHash: hashBody(body),
        error: {
          message: error.message,
          code: error.code || null,
        },
        transportMode,
        transportFallback: transportMode === "gh",
        ts: new Date().toISOString(),
      }, { dataRoot }).catch(() => {});
    }
    return {
      status: "failed",
      posted: false,
      dedupeKey,
      request,
      body,
      error: {
        message: error.message,
        code: error.code || null,
      },
    };
  }
}
