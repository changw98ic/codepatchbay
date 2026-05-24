function valueOrUnavailable(value) {
  return value === null || value === undefined || value === "" ? "unavailable" : String(value);
}

function artifactRef(artifact) {
  if (!artifact) return "unavailable";
  const id = artifact.id || artifact.artifactId || null;
  const path = artifact.path || null;
  if (id && path) return `${id} (${path})`;
  return id || path || "unavailable";
}

function agentValue(agents, key) {
  return valueOrUnavailable(agents?.[key]);
}

function testLines(tests) {
  if (!Array.isArray(tests) || tests.length === 0) return ["- Tests: unavailable"];
  return tests.map((test) => `- ${test}`);
}

export function buildCodePatchBayPrBody({
  job = {},
  agents = {},
  artifacts = {},
  tests = [],
  verdict = {},
  audit = {},
} = {}) {
  const issue = job.sourceContext?.issueNumber ? `#${job.sourceContext.issueNumber}` : "unavailable";
  const repo = job.sourceContext?.repo || "unavailable";
  const status = verdict.status || "unavailable";
  const confidence = verdict.confidence ?? "unavailable";
  const reason = verdict.reason || "unavailable";
  const blocking = verdict.blockingCount ?? verdict.blocking?.length ?? "unavailable";

  return [
    "## CodePatchBay Run",
    "",
    `- Job: ${valueOrUnavailable(job.jobId)}`,
    `- Project: ${valueOrUnavailable(job.project)}`,
    `- Repository: ${repo}`,
    `- Issue: ${issue}`,
    `- Workflow: ${valueOrUnavailable(job.workflow || "standard")}`,
    `- Planner: ${agentValue(agents, "planner")}`,
    `- Executor: ${agentValue(agents, "executor")}`,
    `- Verifier: ${agentValue(agents, "verifier")}`,
    `- Retries: ${valueOrUnavailable(job.retryCount ?? 0)}`,
    "",
    "## Plan",
    "",
    `- Plan: ${artifactRef(artifacts.plan)}`,
    `- Deliverable: ${artifactRef(artifacts.deliverable)}`,
    `- Review: ${artifactRef(artifacts.review)}`,
    `- Diff: ${artifactRef(artifacts.diff)}`,
    "",
    "## Tests",
    "",
    ...testLines(tests),
    "",
    "## Verification",
    "",
    `- Status: ${status}`,
    `- Confidence: ${confidence}`,
    `- Blocking: ${blocking}`,
    `- Reason: ${reason}`,
    `- Verdict: ${artifactRef(artifacts.verdict)}`,
    "",
    "## Audit",
    "",
    `- Event log: ${valueOrUnavailable(audit.eventLog)}`,
    `- Artifact index: ${valueOrUnavailable(audit.artifactIndex)}`,
    "",
  ].join("\n");
}
