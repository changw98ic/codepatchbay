function agentLine(label, value) {
  return `- ${label}: ${value || "not selected"}`;
}

export function buildQueuedComment({ job = {}, queueEntry = null, agents = {} } = {}) {
  const workflow = job.workflow || queueEntry?.payload?.workflow || "standard";
  return [
    "CodePatchBay queued this issue.",
    "",
    `- Job: ${job.jobId || "pending"}`,
    `- Workflow: ${workflow}`,
    agentLine("Planner", agents.planner),
    agentLine("Executor", agents.executor),
    agentLine("Verifier", agents.verifier),
    "",
    "I'll post updates here.",
    "",
  ].join("\n");
}

export async function postGithubQueuedComment({
  repo,
  issueNumber,
  job,
  queueEntry,
  agents,
  dryRun = false,
  postComment,
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
    };
  }
}
