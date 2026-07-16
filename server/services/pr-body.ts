import { recordValue, type LooseRecord } from "../../shared/types.js";

type PrBodyInput = {
  job?: LooseRecord;
  agents?: LooseRecord;
  artifacts?: LooseRecord;
  tests?: unknown[];
  verdict?: LooseRecord;
  completionGate?: LooseRecord | null;
  audit?: LooseRecord;
  routingContext?: LooseRecord | null;
};

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
  const scopeNames = scopes.map((s) => {
    if (typeof s === "string") return s;
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
  const cp = recordValue(rc.contextPack);
  const files = Array.isArray(cp.files) ? cp.files : [];
  return [
    "",
    "## Context Pack",
    "",
    `- Path: ${valueOrUnavailable(cp.path)}`,
    `- Files: ${valueOrUnavailable(cp.fileCount ?? files.length)}`,
  ];
}

function childTaskLines(rc: LooseRecord | null | undefined) {
  const childTaskIds = Array.isArray(rc?.childTaskIds) ? rc.childTaskIds.map(String) : [];
  if (childTaskIds.length === 0) return [];
  return [
    "",
    "## Child Tasks",
    "",
    ...childTaskIds.map((id) => `- ${id}`),
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
  const scopes = (dg.protectedScopes || []).map((s) => typeof s === "string" ? s : (s.scope || ""));
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

function completionGateLines(completionGate: LooseRecord | null | undefined) {
  if (!completionGate) return [];
  const checklist = recordValue(completionGate.checklist || completionGate.checklistStatus);
  const gateBlocking = Array.isArray(completionGate.blocking) ? completionGate.blocking : [];
  const checklistBlocking = Array.isArray(checklist.blocking) ? checklist.blocking : [];
  const gateBlockingCount = completionGate.blockingCount ?? (gateBlocking.length > 0 ? gateBlocking.length : undefined);
  const checklistBlockingCount = checklist.blockingCount ?? (checklistBlocking.length > 0 ? checklistBlocking.length : undefined);
  const blocking = gateBlockingCount
    ?? checklistBlockingCount
    ?? "unavailable";
  return [
    "",
    "## Completion Gate",
    "",
    `- Outcome: ${valueOrUnavailable(completionGate.outcome)}`,
    `- Reason: ${valueOrUnavailable(completionGate.reason)}`,
    `- Checklist Status: ${valueOrUnavailable(checklist.status)}`,
    `- Blocking: ${blocking}`,
  ];
}

function csv(value: unknown) {
  return Array.isArray(value) && value.length > 0 ? value.map(String).join(", ") : "unavailable";
}

function countValue(value: unknown) {
  return typeof value === "number" ? value : "unavailable";
}

function completionReportLines(report: LooseRecord | null | undefined) {
  if (!report) return [];
  const residualRisk = recordValue(report.residualRisk);
  const evidenceCounts = recordValue(report.evidenceCounts);
  return [
    "",
    "## Completion Report",
    "",
    `- Changed Files: ${countValue(report.changedFileCount)} (${csv(report.changedFiles)})`,
    `- Real Actors: ${csv(report.realActors)}`,
    `- Real Entrypoints: ${csv(report.realEntrypoints)}`,
    `- Bypass Candidates: ${csv(report.bypassCandidates)}`,
    `- Evidence Classes: ${csv(report.evidenceClasses)}`,
    `- Evidence Origins: ${csv(report.evidenceOrigins)}`,
    `- Commands: ${csv(report.commands)}`,
    `- Evidence Counts: ${countValue(evidenceCounts.passed)} passed / ${countValue(evidenceCounts.failed)} failed / ${countValue(evidenceCounts.total)} total`,
    `- Residual Risk: ${csv(residualRisk.notes)}`,
  ];
}

export function buildCodePatchBayPrBody({
  job = {},
  agents = {},
  artifacts = {},
  tests = [],
  verdict = {},
  completionGate = null,
  audit = {},
  routingContext = null,
}: PrBodyInput = {}) {
  const sourceContext = recordValue(job.sourceContext);
  const verdictRecord = recordValue(verdict);
  const blockingItems = Array.isArray(verdictRecord.blocking) ? verdictRecord.blocking : [];
  const issue = sourceContext.issueNumber ? `#${sourceContext.issueNumber}` : "unavailable";
  const repo = sourceContext.repo || "unavailable";
  const status = verdictRecord.status || "unavailable";
  const confidence = verdictRecord.confidence ?? "unavailable";
  const reason = verdictRecord.reason || "unavailable";
  const blocking = verdictRecord.blockingCount ?? blockingItems.length ?? "unavailable";
  const completionReportCandidate = job.completionReport || recordValue(completionGate).completionReport;
  const completionReport = completionReportCandidate && typeof completionReportCandidate === "object" && !Array.isArray(completionReportCandidate)
    ? recordValue(completionReportCandidate)
    : null;

  const closes = sourceContext.issueNumber ? `\n\nCloses #${sourceContext.issueNumber}` : "";
  const routing = routingContext ? recordValue(routingContext) : null;

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
    `- Plan: ${artifactRef(recordValue(artifacts.plan))}`,
    `- Deliverable: ${artifactRef(recordValue(artifacts.deliverable))}`,
    `- Review: ${artifactRef(recordValue(artifacts.review))}`,
    `- Diff: ${artifactRef(recordValue(artifacts.diff))}`,
    ...(routing ? routingDecisionLines(routing) : []),
    ...(routing ? triageStrategyLines(routing) : []),
    ...(routing && recordValue(routing.contextPack).path ? contextPackLines(routing) : []),
    ...(routing && Array.isArray(routing.childTaskIds) && routing.childTaskIds.length ? childTaskLines(routing) : []),
    ...(routing?.planCache ? planCacheLines(routing) : []),
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
    `- Verdict: ${artifactRef(recordValue(artifacts.verdict))}`,
    ...completionGateLines(completionGate),
    ...completionReportLines(completionReport),
    ...(routing?.finalDiffGuard ? finalDiffGuardLines(routing) : []),
    "",
    "## Audit",
    "",
    `- Event log: ${valueOrUnavailable(audit.eventLog)}`,
    `- Artifact index: ${valueOrUnavailable(audit.artifactIndex)}`,
    "",
  ].join("\n") + closes;
}
