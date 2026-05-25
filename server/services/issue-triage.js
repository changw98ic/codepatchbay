import { mergeRoutePolicy, normalizeRoute } from "../../core/triage/schema.js";
import { classifyIssueRules } from "../../core/triage/rules.js";

function stripJsonFence(raw) {
  return String(raw || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function routeFromWorkflowPlan({ workflow = null, planMode = null, reason = null, source = "command" } = {}) {
  if (!workflow && !planMode) return null;
  return normalizeRoute({
    workflow: workflow || undefined,
    planMode: planMode || undefined,
    reason: reason || "requested route",
    source,
  });
}

function withMode(decision, triageMode) {
  return {
    ...decision,
    triageMode,
  };
}

function githubTriageInput(event = {}, requestedRoute = null) {
  return {
    labels: event.labels,
    title: event.title,
    body: event.body,
    actor: event.actor,
    authorAssociation: event.raw?.authorAssociation || event.authorAssociation || null,
    requestedRoute,
  };
}

function channelRequestedRoute(command = {}) {
  const hasRequestedRoute = Boolean(
    command.workflowRequested
      || command.planModeRequested
      || (command.workflow && command.workflow !== "standard"),
  );
  return hasRequestedRoute
    ? routeFromWorkflowPlan({
        workflow: command.workflow,
        planMode: command.planMode,
        reason: "channel command requested route",
        source: "command",
      })
    : null;
}

function channelTriageInput(command = {}, context = {}, requested = null) {
  return {
    title: command.task || (command.issue ? `GitHub issue #${command.issue}` : ""),
    task: command.task,
    commandText: context.commandText,
    actor: context.actor,
    actorName: context.actorName,
    authorAssociation: context.authorAssociation || null,
    requestedRoute: requested,
  };
}

export function buildAcpTriagerPrompt(input = {}, ruleDecision = null) {
  const rules = ruleDecision || classifyIssueRules(input);
  return [
    "You are the CodePatchBay issue routing triager.",
    "Return only JSON. Do not execute code or modify files.",
    "",
    "Choose a requestedRoute only; policy will merge it with actor trust and protected-scope rules.",
    "Valid workflows: direct, standard, complex, sdd-standard.",
    "Valid planMode values: none, light, full, parent.",
    "Use complex/full/reviewer for security, auth, database, or payment risk.",
    "",
    JSON.stringify({
      issue: {
        labels: input.labels || [],
        title: input.title || input.task || "",
        body: input.body || "",
        actor: input.actor || input.actorName || null,
        authorAssociation: input.authorAssociation || null,
      },
      ruleRoute: rules.ruleRoute,
      requestedRoute: rules.requestedRoute,
      protectedScopes: rules.protectedScopes,
      outputSchema: {
        requestedRoute: {
          workflow: "direct|standard|complex|sdd-standard",
          planMode: "none|light|full|parent",
          reviewer: "boolean",
          reason: "short reason",
        },
      },
    }, null, 2),
  ].join("\n");
}

export function parseAcpTriagerResponse(raw) {
  const text = stripJsonFence(raw);
  if (!text) return { requestedRoute: null, raw: "" };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { requestedRoute: null, raw: text, error: `invalid ACP triage JSON: ${error.message}` };
  }
  const route = parsed.requestedRoute || parsed.requested || parsed.route || null;
  return {
    requestedRoute: route
      ? normalizeRoute({ ...route, source: "acp", reason: route.reason || "ACP triager route" })
      : null,
    raw: text,
  };
}

export function triageIssue(input = {}, { requestedRoute = null, acpRoute = null, acpResponse = null } = {}) {
  const rules = classifyIssueRules({
    ...input,
    requestedRoute: requestedRoute || input.requestedRoute,
  });
  const parsedAcp = acpRoute
    ? normalizeRoute({ ...acpRoute, source: acpRoute.source || "acp" })
    : parseAcpTriagerResponse(acpResponse).requestedRoute;

  return mergeRoutePolicy({
    ruleRoute: rules.ruleRoute,
    requestedRoute: requestedRoute || input.requestedRoute || rules.requestedRoute,
    acpRoute: parsedAcp,
    actorTrust: rules.actorTrust,
    protectedScopes: rules.protectedScopes,
    actualDiffRisk: rules.actualDiffRisk,
    reasons: rules.reasons,
  });
}

export async function triageIssueWithAcp(input = {}, {
  cpbRoot = process.cwd(),
  hubRoot = null,
  cwd = process.cwd(),
  agent = "claude",
  timeoutMs = 60_000,
  acpPool = null,
} = {}) {
  const rules = classifyIssueRules(input);
  const prompt = buildAcpTriagerPrompt(input, rules);
  let acpResponse = null;
  let acpError = null;

  try {
    const pool = acpPool || (await import("./acp-pool.js")).getManagedAcpPool({ cpbRoot, hubRoot });
    acpResponse = await pool.execute(agent, prompt, cwd, timeoutMs);
  } catch (error) {
    acpError = error.message;
  }

  const parsed = acpResponse ? parseAcpTriagerResponse(acpResponse) : { requestedRoute: null };
  const decision = triageIssue(input, { acpRoute: parsed.requestedRoute });
  return {
    ...decision,
    acpTriager: {
      agent,
      prompt,
      raw: acpResponse,
      error: acpError || parsed.error || null,
    },
  };
}

export function triageGithubIssue(event = {}, { requestedRoute = null, acpRoute = null } = {}) {
  return withMode(triageIssue(githubTriageInput(event, requestedRoute), { requestedRoute, acpRoute }), "rules");
}

export async function triageGithubIssueWithAcp(event = {}, options = {}) {
  const requestedRoute = options.requestedRoute || null;
  const decision = await triageIssueWithAcp(githubTriageInput(event, requestedRoute), {
    ...options,
    requestedRoute,
  });
  return withMode(decision, "acp");
}

export function triageChannelCommand(command = {}, context = {}) {
  const requested = channelRequestedRoute(command);
  return withMode(triageIssue(channelTriageInput(command, context, requested), { requestedRoute: requested }), command.triage || "rules");
}

export async function triageChannelCommandWithAcp(command = {}, context = {}, options = {}) {
  const requested = channelRequestedRoute(command);
  const decision = await triageIssueWithAcp(channelTriageInput(command, context, requested), {
    ...options,
    requestedRoute: requested,
  });
  return withMode(decision, "acp");
}
