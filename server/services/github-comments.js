import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { appendEvent, readEvents } from "./event-store.js";
import { jobToGithubStatusUpdate } from "./job-projection.js";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function agentLine(label, value) {
  return `- ${label}: ${value || "not selected"}`;
}

function isSddApprovalQueue(queueEntry) {
  const approval = queueEntry?.metadata?.sddApproval || {};
  return Boolean(
    approval.requiresApproval
    && (
      queueEntry?.status === "waiting.approval"
      || approval.status === "waiting_approval"
    )
  );
}

function sddFilePath(metadata, name) {
  return metadata?.sddBootstrap?.files?.[name]?.path
    || metadata?.sddBootstrap?.generationEvent?.generatedFiles?.[name]?.path
    || null;
}

function displaySddPath(filePath) {
  if (!filePath) return "unavailable";
  const normalized = String(filePath).replace(/\\/g, "/");
  const sddIndex = normalized.lastIndexOf("/sdd/");
  if (sddIndex >= 0) return normalized.slice(sddIndex + 1);
  const parts = normalized.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || normalized;
}

function buildSddApprovalComment({ queueEntry = null, agents = {} } = {}) {
  const metadata = queueEntry?.metadata || {};
  const workflow = metadata.workflow || "sdd-standard";
  const taskCount = Array.isArray(metadata.sddTasks) ? metadata.sddTasks.length : 0;
  const queueId = queueEntry?.id;
  const approveCmd = queueId ? `\`/cpb approve ${queueId}\`` : "a connected channel command";
  return [
    "### SDD Draft Requires Approval",
    "",
    "A Spec-Driven Development draft has been generated for this issue. Review the artifacts below, then approve to start execution.",
    "",
    `- **Spec**: \`${displaySddPath(sddFilePath(metadata, "spec"))}\``,
    `- **Design**: \`${displaySddPath(sddFilePath(metadata, "design"))}\``,
    `- **Tasks**: \`${displaySddPath(sddFilePath(metadata, "tasks"))}\``,
    `- **Parsed tasks**: ${taskCount}`,
    queueId ? `- **Queue ID**: \`${queueId}\`` : null,
    `- **Workflow**: \`${workflow}\``,
    "",
    agentLine("Planner", agents.planner),
    agentLine("Executor", agents.executor),
    agentLine("Verifier", agents.verifier),
    "",
    "---",
    "",
    `To approve, comment ${approveCmd} on this issue.`,
    "",
  ].filter((line) => line !== null).join("\n");
}

export function buildSddApprovedComment({ actor, childCount, queueEntryId } = {}) {
  return [
    "### SDD Draft Approved",
    "",
    `Approved by @${actor || "unknown"}.`,
    childCount > 0 ? `${childCount} child task(s) queued for execution.` : "No child tasks were queued.",
    "",
  ].join("\n");
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

export async function addGithubLabelsWithGh({ repo, issueNumber, labels }, { runCommand = execFileAsync } = {}) {
  const args = ["issue", "edit", String(issueNumber), "--repo", repo];
  for (const label of labels) {
    args.push("--add-label", label);
  }
  await runCommand("gh", args, { maxBuffer: 1024 * 1024 });
  return { added: labels };
}

export async function removeGithubLabelWithGh({ repo, issueNumber, label }, { runCommand = execFileAsync } = {}) {
  await runCommand("gh", [
    "issue", "edit", String(issueNumber),
    "--repo", repo,
    "--remove-label", label,
  ], { maxBuffer: 1024 * 1024 });
  return { removed: label };
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
  if (isSddApprovalQueue(queueEntry)) {
    return buildSddApprovalComment({ queueEntry, agents });
  }

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

// --- Run progress comments (phase-by-phase updates) ---

const PHASE_EMOJI = {
  plan: "📋",
  execute: "⚡",
  verify: "✅",
  review: "🔍",
};

const PHASE_LABEL = {
  plan: "Planning",
  execute: "Executing",
  verify: "Verifying",
  review: "Reviewing",
};

export function buildRunComment({ job = {}, phase = null, status = null, details = {} } = {}) {
  const emoji = PHASE_EMOJI[phase] || "🔄";
  const label = PHASE_LABEL[phase] || (phase || "Processing");
  const jobId = job.jobId || details.jobId || "unknown";

  const lines = [
    `${emoji} **${label}** — ${status === "completed" ? "done" : status === "failed" ? "failed" : "in progress"}`,
    "",
    `- Job: ${jobId}`,
  ];

  if (details.artifactPath) {
    lines.push(`- Artifact: \`${details.artifactPath}\``);
  }
  if (details.durationMs != null) {
    const sec = Math.round(details.durationMs / 1000);
    lines.push(`- Duration: ${sec}s`);
  }
  if (details.retryCount != null && details.retryCount > 0) {
    lines.push(`- Retries: ${details.retryCount}`);
  }
  if (details.reason) {
    lines.push(`- Reason: ${details.reason}`);
  }
  if (details.changedFiles) {
    const files = details.changedFiles;
    const display = files.length <= 10 ? files : [...files.slice(0, 10), `... +${files.length - 10} more`];
    lines.push("", "**Changed files:**", ...display.map((f) => `- \`${f}\``));
  }
  if (details.summary) {
    lines.push("", details.summary);
  }
  lines.push("");
  return lines.join("\n");
}

export async function postGithubRunComment({
  cpbRoot,
  project,
  jobId,
  repo,
  issueNumber,
  phase,
  status,
  details = {},
  postComment,
  dryRun = false,
  transportMode = null,
  dataRoot,
} = {}) {
  const body = buildRunComment({ phase, status, details: { ...details, jobId } });
  const request = { repo, issueNumber, body };

  if (dryRun) {
    return { status: "dry-run", posted: false, request, body };
  }

  try {
    if (typeof postComment !== "function") {
      throw new Error("GitHub comment transport not configured");
    }
    const response = await postComment(request);

    if (cpbRoot && project && jobId) {
      await appendEvent(cpbRoot, project, jobId, {
        type: "github_comment_posted",
        jobId,
        project,
        commentKind: "run-progress",
        phase,
        phaseStatus: status,
        repo,
        issueNumber,
        bodyHash: hashBody(body),
        response: responseSummary(response),
        transportMode,
        transportFallback: transportMode === "gh",
        ts: new Date().toISOString(),
      }, { dataRoot }).catch(() => {});
    }

    return { status: "posted", posted: true, request, body, response };
  } catch (error) {
    if (cpbRoot && project && jobId) {
      await appendEvent(cpbRoot, project, jobId, {
        type: "github_comment_failed",
        jobId,
        project,
        commentKind: "run-progress",
        phase,
        phaseStatus: status,
        repo,
        issueNumber,
        bodyHash: hashBody(body),
        error: { message: error.message, code: error.code || null },
        transportMode,
        transportFallback: transportMode === "gh",
        ts: new Date().toISOString(),
      }, { dataRoot }).catch(() => {});
    }
    return { status: "failed", posted: false, request, body, error: { message: error.message } };
  }
}

// --- Label management with audit logging ---

export async function addGithubLabels({
  cpbRoot,
  project,
  jobId,
  repo,
  issueNumber,
  labels,
  addLabels,
  dryRun = false,
  transportMode = null,
  dataRoot,
} = {}) {
  if (!labels || labels.length === 0) return { status: "skipped", added: [] };
  if (dryRun) return { status: "dry-run", added: labels };

  try {
    if (typeof addLabels !== "function") {
      throw new Error("GitHub label transport not configured");
    }
    const result = await addLabels({ repo, issueNumber, labels });

    if (cpbRoot && project && jobId) {
      await appendEvent(cpbRoot, project, jobId, {
        type: "github_labels_added",
        jobId,
        project,
        repo,
        issueNumber,
        labels,
        added: result.added || labels,
        transportMode,
        transportFallback: transportMode === "gh",
        ts: new Date().toISOString(),
      }, { dataRoot }).catch(() => {});
    }

    return { status: "posted", added: result.added || labels };
  } catch (error) {
    return { status: "failed", added: [], error: { message: error.message } };
  }
}

export async function removeGithubLabel({
  cpbRoot,
  project,
  jobId,
  repo,
  issueNumber,
  label,
  removeLabel,
  dryRun = false,
  transportMode = null,
  dataRoot,
} = {}) {
  if (!label) return { status: "skipped", removed: null };
  if (dryRun) return { status: "dry-run", removed: label };

  try {
    if (typeof removeLabel !== "function") {
      throw new Error("GitHub label transport not configured");
    }
    const result = await removeLabel({ repo, issueNumber, label });

    if (cpbRoot && project && jobId) {
      await appendEvent(cpbRoot, project, jobId, {
        type: "github_label_removed",
        jobId,
        project,
        repo,
        issueNumber,
        label,
        transportMode,
        transportFallback: transportMode === "gh",
        ts: new Date().toISOString(),
      }, { dataRoot }).catch(() => {});
    }

    return { status: "posted", removed: result.removed || label };
  } catch (error) {
    return { status: "failed", removed: null, error: { message: error.message } };
  }
}
