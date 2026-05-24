import { appendEvent } from "./event-store.js";
import { getJob } from "./job-store.js";

function isPass(verdict) {
  return String(verdict || "").toUpperCase() === "PASS";
}

function prTitle(job) {
  const title = job.task || job.sourceContext?.issueTitle || `Issue #${job.sourceContext?.issueNumber || job.jobId}`;
  return `[cpb] ${title}`;
}

function prBody(job) {
  const issue = job.sourceContext?.issueNumber ? `#${job.sourceContext.issueNumber}` : "unavailable";
  return [
    "## CodePatchBay Run",
    "",
    `- Job: ${job.jobId}`,
    `- Workflow: ${job.workflow || "standard"}`,
    `- Issue: ${issue}`,
    "",
    "## Verification",
    "",
    "- Verdict: PASS",
    "",
  ].join("\n");
}

function buildRequest(job) {
  return {
    repo: job.sourceContext?.repo || null,
    title: prTitle(job),
    body: prBody(job),
    head: job.worktreeBranch || null,
    base: job.worktreeBaseBranch || "main",
    draft: true,
  };
}

function blocked(reason, evidence = {}, error = null) {
  return {
    status: "blocked.pr",
    jobStatus: "passed",
    evidence: {
      reason,
      ...evidence,
    },
    error,
  };
}

export async function openDraftPullRequest({
  job,
  verdict,
  branchPushed = false,
  dryRun = false,
  createPullRequest,
} = {}) {
  if (!isPass(verdict)) {
    return {
      status: "skipped",
      reason: "draft PR creation requires a PASS verdict",
      jobStatus: job?.status || null,
    };
  }

  const request = buildRequest(job || {});
  const evidence = {
    repo: request.repo,
    head: request.head,
    base: request.base,
    draft: request.draft,
  };

  if (!request.repo || !request.head || !request.base) {
    return blocked("PR request is missing repo, head, or base", evidence);
  }
  if (!branchPushed) {
    return blocked("branch has not been pushed", evidence);
  }

  if (dryRun) {
    return {
      status: "dry-run",
      jobStatus: "passed",
      request,
      posted: false,
    };
  }

  try {
    if (typeof createPullRequest !== "function") {
      throw new Error("GitHub PR transport not configured");
    }
    const response = await createPullRequest(request);
    return {
      status: "pr.opened",
      jobStatus: "passed",
      request,
      response,
      prUrl: response?.url || response?.html_url || null,
      prNumber: response?.number || null,
    };
  } catch (error) {
    return blocked("failed to open draft PR", evidence, {
      message: error.message,
      code: error.code || null,
    });
  }
}

export async function maybeOpenDraftPrAfterPass(cpbRoot, project, jobId, options = {}) {
  const job = await getJob(cpbRoot, project, jobId, { dataRoot: options.dataRoot });
  const result = await openDraftPullRequest({
    job,
    verdict: options.verdict,
    branchPushed: options.branchPushed,
    dryRun: options.dryRun,
    createPullRequest: options.createPullRequest,
  });

  if (result.status === "pr.opened") {
    await appendEvent(cpbRoot, project, jobId, {
      type: "pr_opened",
      jobId,
      project,
      prUrl: result.prUrl,
      prNumber: result.prNumber,
      artifact: options.artifact || null,
      ts: new Date().toISOString(),
    }, { dataRoot: options.dataRoot });
  }

  return result;
}
