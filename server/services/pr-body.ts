// @ts-nocheck
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

function sddTraceLines(trace) {
  if (!trace) return [];
  const artifacts = trace.artifacts || {};
  return [
    "",
    "## SDD Trace",
    "",
    `- Trace: ${valueOrUnavailable(trace.traceId)}`,
    `- Status: ${valueOrUnavailable(trace.status)}`,
    `- Spec: ${valueOrUnavailable(trace.spec || artifacts.spec)}`,
    `- Design: ${valueOrUnavailable(trace.design || artifacts.design)}`,
    `- Tasks: ${valueOrUnavailable(trace.tasks || artifacts.tasks)}`,
  ];
}

function routingDecisionLines(rc) {
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

function triageStrategyLines(rc) {
  if (!rc?.routing) return [];
  const r = rc.routing;
  const scopes = r.protectedScopes || [];
  const scopeNames = scopes.map((s) => {
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

function sddBootstrapLines(rc) {
  if (!rc?.sddBootstrap) return [];
  const bs = rc.sddBootstrap;
  const gen = bs.generationEvent || {};
  const files = gen.generatedFiles || bs.files || {};
  return [
    "",
    "## SDD Generation",
    "",
    `- Source: ${valueOrUnavailable(gen.source || bs.source)}`,
    `- Generator: ${valueOrUnavailable(gen.generator)}`,
    `- Spec: ${valueOrUnavailable(files.spec?.path || bs.files?.spec?.path)}`,
    `- Design: ${valueOrUnavailable(files.design?.path || bs.files?.design?.path)}`,
    `- Tasks: ${valueOrUnavailable(files.tasks?.path || bs.files?.tasks?.path)}`,
  ];
}

function contextPackLines(rc) {
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

function childTaskLines(rc) {
  if (!rc?.childTaskIds?.length) return [];
  return [
    "",
    "## Child Tasks",
    "",
    ...rc.childTaskIds.map((id) => `- ${id}`),
  ];
}

function planCacheLines(rc) {
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

function finalDiffGuardLines(rc) {
  if (!rc?.finalDiffGuard) return [];
  const dg = rc.finalDiffGuard;
  const scopes = (dg.protectedScopes || []).map((s) => s.scope || s);
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
  sddTrace = null,
  routingContext = null,
} = {}) {
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
    ...sddTraceLines(sddTrace || job.sddTrace || job.sourceContext?.sddTrace),
    ...(routingContext ? routingDecisionLines(routingContext) : []),
    ...(routingContext ? triageStrategyLines(routingContext) : []),
    ...(routingContext?.sddBootstrap ? sddBootstrapLines(routingContext) : []),
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
