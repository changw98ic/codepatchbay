import { recordValue, type LooseRecord } from "../../shared/types.js";
import { mergeRoutePolicy, normalizeRoute } from "../../core/triage/schema.js";
import { classifyIssueRules } from "../../core/triage/rules.js";


function stripJsonFence(raw: unknown): string {
  return String(raw || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function routeFromWorkflowPlan({ workflow = null, planMode = null, reason = null, source = "command" }: LooseRecord = {}) {
  if (!workflow && !planMode) return null;
  return normalizeRoute({
    workflow: workflow || undefined,
    planMode: planMode || undefined,
    reason: reason || "requested route",
    source,
  });
}

function withMode(decision: LooseRecord, triageMode: string): LooseRecord {
  return {
    ...decision,
    triageMode,
  };
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function githubTriageInput(event: LooseRecord = {}, requestedRoute: LooseRecord | null = null): LooseRecord {
  const raw = recordValue(event.raw);
  return {
    labels: event.labels,
    title: event.title,
    body: event.body,
    actor: event.actor,
    authorAssociation: raw.authorAssociation || event.authorAssociation || null,
    requestedRoute,
  };
}

function channelRequestedRoute(command: LooseRecord = {}) {
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

function channelTriageInput(command: LooseRecord = {}, context: LooseRecord = {}, requested: LooseRecord | null = null): LooseRecord {
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

export function buildAcpTriagerPrompt(input: LooseRecord = {}, ruleDecision: LooseRecord | null = null): string {
  const rules = ruleDecision || classifyIssueRules(input);
  return [
    "You are the CodePatchBay issue routing triager.",
    "Return only JSON. Do not execute code or modify files.",
    "",
    "Choose a requestedRoute only; policy will merge it with actor trust and protected-scope rules.",
    "Valid workflows: direct, standard, complex.",
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
          workflow: "direct|standard|complex",
          planMode: "none|light|full|parent",
          reviewer: "boolean",
          reason: "short reason",
        },
      },
    }, null, 2),
  ].join("\n");
}

export function parseAcpTriagerResponse(raw: unknown): LooseRecord {
  const text = stripJsonFence(raw);
  if (!text) return { requestedRoute: null, raw: "" };
  let parsed: LooseRecord;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { requestedRoute: null, raw: text, error: `invalid ACP triage JSON: ${recordValue(error).message}` };
  }
  const route = recordValue(parsed.requestedRoute || parsed.requested || parsed.route);
  return {
    requestedRoute: Object.keys(route).length > 0
      ? normalizeRoute({ ...route, source: "acp", reason: route.reason || "ACP triager route" })
      : null,
    raw: text,
  };
}

export function triageIssue(input: LooseRecord = {}, { requestedRoute = null, acpRoute = null, acpResponse = null }: LooseRecord = {}) {
  const rules = classifyIssueRules({
    ...input,
    requestedRoute: requestedRoute || input.requestedRoute,
  });
  const acpRouteRecord = recordValue(acpRoute);
  const parsedAcp = Object.keys(acpRouteRecord).length > 0
    ? normalizeRoute({ ...acpRouteRecord, source: acpRouteRecord.source || "acp" })
    : parseAcpTriagerResponse(acpResponse).requestedRoute;

  return mergeRoutePolicy({
    ruleRoute: rules.ruleRoute,
    requestedRoute: recordValue(requestedRoute || input.requestedRoute || rules.requestedRoute),
    acpRoute: recordValue(parsedAcp),
    actorTrust: recordValue(rules.actorTrust),
    protectedScopes: rules.protectedScopes,
    actualDiffRisk: recordValue(rules.actualDiffRisk),
    reasons: rules.reasons,
  });
}

export async function triageIssueWithAcp(input: LooseRecord = {}, {
  cpbRoot = process.cwd(),
  hubRoot = null,
  cwd = process.cwd(),
  agent = "claude",
  timeoutMs = 60_000,
  acpPool = null,
}: LooseRecord = {}) {
  const rules = classifyIssueRules(input);
  const prompt = buildAcpTriagerPrompt(input, rules);
  let acpResponse = null;
  let acpError = null;

  try {
    const pool = acpPool
      ? recordValue(acpPool)
      : recordValue((await import("./acp/acp-pool.js")).getManagedAcpPool({ cpbRoot: stringValue(cpbRoot, process.cwd()), hubRoot: stringValue(hubRoot) || null }));
    const executor = recordValue(pool);
    if (typeof executor.execute !== "function") throw new Error("ACP pool execute unavailable");
    const result = recordValue(await executor.execute(
      stringValue(agent, "claude"),
      prompt,
      stringValue(cwd, process.cwd()),
      numberValue(timeoutMs, 60_000),
      { phase: "issue_triage", role: "triager", controlPlane: true },
    ));
    acpResponse = result.output;
  } catch (error) {
    acpError = recordValue(error).message || String(error);
  }

  const parsed: LooseRecord = acpResponse ? parseAcpTriagerResponse(acpResponse) : { requestedRoute: null };
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

export function triageGithubIssue(event: LooseRecord = {}, { requestedRoute = null, acpRoute = null }: LooseRecord = {}) {
  const requested = requestedRoute ? recordValue(requestedRoute) : null;
  return withMode(triageIssue(githubTriageInput(event, requested), { requestedRoute: requested, acpRoute }), "rules");
}

export async function triageGithubIssueWithAcp(event: LooseRecord = {}, options: LooseRecord = {}) {
  const requestedRoute = options.requestedRoute ? recordValue(options.requestedRoute) : null;
  const decision = await triageIssueWithAcp(githubTriageInput(event, requestedRoute), {
    ...options,
    requestedRoute,
  });
  return withMode(decision, "acp");
}

export function triageChannelCommand(command: LooseRecord = {}, context: LooseRecord = {}) {
  const requested = channelRequestedRoute(command);
  return withMode(triageIssue(channelTriageInput(command, context, requested), { requestedRoute: requested }), stringValue(command.triage, "rules"));
}

export async function triageChannelCommandWithAcp(command: LooseRecord = {}, context: LooseRecord = {}, options: LooseRecord = {}) {
  const requested = channelRequestedRoute(command);
  const decision = await triageIssueWithAcp(channelTriageInput(command, context, requested), {
    ...options,
    requestedRoute: requested,
  });
  return withMode(decision, "acp");
}
