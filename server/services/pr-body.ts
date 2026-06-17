type LooseRecord = Record<string, any>;

function valueOrUnavailable(value: unknown) {
  return value === null || value === undefined || value === "" ? "unavailable" : String(value);
}

function artifactRef(artifact: LooseRecord | null | undefined) {
  if (!artifact) return "unavailable";
  const id = artifact.id || artifact.artifactId || null;
  const path = artifact.path || null;
  if (id && path) return `${id} (${path})`;
  return id || path || "unavailable";
}

function agentValue(agents: LooseRecord, key: string) {
  return valueOrUnavailable(agents?.[key]);
}

function testLines(tests: unknown[]) {
  if (!Array.isArray(tests) || tests.length === 0) return ["- Tests: unavailable"];
  return tests.map((test) => `- ${test}`);
}

function routingDecisionLines(rc: LooseRecord | null | undefined) {
  if (!rc?.routing) return [];
  const r = rc.routing;
  const effective = r.effectiveRoute || r.effective || {};
  return [
    "",
    "## Routing Decision",
    "",
    `- Workflow: ${valueOrUnavailable(effective.workflow)}`,
    `- Plan Mode: ${valueOrUnavailable(rc.planMode || effective.planMode)}`,
    `- Reviewer: ${effective.reviewer ? "yes" : "no"}`,
    `- Source: ${valueOrUnavailable(effective.source)}`,
    `- Reason: ${valueOrUnavailable(effective.reason)}`,
    ...(r.actorTrust ? [
      `- Actor: ${valueOrUnavailable(r.actorTrust.actor)} (${valueOrUnavailable(r.actorTrust.level)})`,
      `- Trusted: ${r.actorTrust.trusted ? "yes" : "no"}`,
    ] : []),
  ];
}

function triageStrategyLines(rc: LooseRecord | null | undefined) {
  if (!rc?.routing) return [];
  const r = rc.routing;
  const scopes = r.protectedScopes || [];
  const scopeNames = scopes.map((s: Record<string, unknown>) => {
    const sev = s.severity ? ` [${s.severity}]` : "";
    return `${s.scope}${sev}`;
  });
  return [
    "",
    "## Triage Strategy",
    "",
    `- Category: ${valueOrUnavailable(r.effectiveRoute?.category || r.effective?.category)}`,
    `- Protected Scopes: ${scopeNames.length > 0 ? scopeNames.join(", ") : "none"}`,
    `- Downgrade Allowed: ${r.downgradeAllowed ? "yes" : "no"}`,
    ...(r.reasons?.length ? [
      `- Reasons: ${r.reasons.join("; ")}`,
    ] : []),
  ];
}

function contextPackLines(rc: LooseRecord | null | undefined) {
  if (!rc?.contextPack?.path) return [];
  const cp = rc.contextPack;
  return [
    "",
    "## Context Pack",
    "",
    `- Path: ${valueOrUnavailable(cp.path)}`,
    `- Files: ${valueOrUnavailable(cp.fileCount ?? cp.files?.length)}`,
  ];
}

function childTaskLines(rc: LooseRecord | null | undefined) {
  if (!rc?.childTaskIds?.length) return [];
  return [
    "",
    "## Child Tasks",
    "",
    ...rc.childTaskIds.map((id: string) => `- ${id}`),
  ];
}

function planCacheLines(rc: LooseRecord | null | undefined) {
  const cache = rc?.planCache;
  if (!cache) return [];
  return [
    "",
    "## Plan Cache",
    "",
    `- Group: ${valueOrUnavailable(cache.planGroupId)}`,
    `- Cache Key: ${valueOrUnavailable(cache.planCacheKey)}`,
    `- Hit: ${cache.cacheHit ? "yes" : "no"}`,
    `- Source: ${valueOrUnavailable(cache.source)}`,
    `- Reused Plan: ${cache.reusedPlanId || cache.parentPlanId || "unavailable"}`,
  ];
}

function finalDiffGuardLines(rc: LooseRecord | null | undefined) {
  if (!rc?.finalDiffGuard) return [];
  const dg = rc.finalDiffGuard;
  const scopes = (dg.protectedScopes || []).map((s: Record<string, unknown> | string) => typeof s === "string" ? s : (s.scope || s));
  const gr = dg.guardResult || {};
  return [
    "",
    "## Final Diff Guard",
    "",
    `- Result: ${dg.passed ? "passed" : "blocked"}`,
    `- Protected Scopes: ${scopes.length > 0 ? scopes.join(", ") : "none"}`,
    ...(gr.escalation ? [
      `- Escalation: ${gr.escalation.workflow}/${gr.escalation.planMode} (reviewer: ${gr.escalation.reviewer ? "yes" : "no"})`,
    ] : []),
    ...(dg.route ? [
      `- Route: ${dg.route.workflow}/${dg.route.planMode}`,
    ] : []),
  ];
}

export function buildCodePatchBayPrBody({
  job = {},
  agents = {},
  artifacts = {},
  tests = [],
  verdict = {},
  audit = {},
  routingContext = null,
}: LooseRecord = {}) {
  const issue = job.sourceContext?.issueNumber ? `#${job.sourceContext.issueNumber}` : "unavailable";
  const repo = job.sourceContext?.repo || "unavailable";
  const status = verdict.status || "unavailable";
  const confidence = verdict.confidence ?? "unavailable";
  const reason = verdict.reason || "unavailable";
  const blocking = verdict.blockingCount ?? verdict.blocking?.length ?? "unavailable";

  const closes = job.sourceContext?.issueNumber ? `\n\nCloses #${job.sourceContext.issueNumber}` : "";

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
    ...(routingContext ? routingDecisionLines(routingContext) : []),
    ...(routingContext ? triageStrategyLines(routingContext) : []),
    ...(routingContext?.contextPack?.path ? contextPackLines(routingContext) : []),
    ...(routingContext?.childTaskIds?.length ? childTaskLines(routingContext) : []),
    ...(routingContext?.planCache ? planCacheLines(routingContext) : []),
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
    ...(routingContext?.finalDiffGuard ? finalDiffGuardLines(routingContext) : []),
    "",
    "## Audit",
    "",
    `- Event log: ${valueOrUnavailable(audit.eventLog)}`,
    `- Artifact index: ${valueOrUnavailable(audit.artifactIndex)}`,
    "",
  ].join("\n") + closes;
}
