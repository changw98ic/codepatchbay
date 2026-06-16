import { detectSecretInput, redactSecrets } from "../secret-policy.js";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { AnyRecord } from "../../../shared/types.js";
import { runtimeDataRoot } from "../runtime.js";
import { resolveHubRoot } from "../hub/hub-registry.js";

// ============================================================
// channel-commands (formerly channel-commands.ts)
// ============================================================

export const CHANNEL_COMMAND_HELP = [
  "CodePatchBay channel commands:",
  "/cpb run <project> <task> [--workflow <name>] [--plan-mode <mode>] [--triage <auto|rules|none>]",
  "/cpb issue <project> <number> [--workflow <name>] [--plan-mode <mode>] [--triage <auto|rules|none>]",
  "/cpb status <job>",
  "/cpb approve <job>",
  "/cpb cancel <job>",
  "/cpb retry <job>",
  "/cpb logs <job>",
].join("\n");

const SAFE_PROJECT = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

function baseFields(extra: Record<string, any> = {}): Record<string, any> {
  return {
    project: null,
    job: null,
    issue: null,
    task: null,
    workflow: null,
    planMode: null,
    triage: null,
    ...extra,
  };
}

function errorResult(code: string, message: string, extra: Record<string, any> = {}) {
  return {
    ok: false,
    type: "error",
    command: extra.command || null,
    code,
    message,
    help: CHANNEL_COMMAND_HELP,
    ...baseFields(extra),
  };
}

export function tokenizeChannelCommand(input: string) {
  const text = String(input ?? "");
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const ch of text) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaping) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}

function stripInvocation(tokens: string[]) {
  const rest = [...tokens];
  while (rest[0] && (/^<@[^>]+>$/.test(rest[0]) || /^@\S+$/.test(rest[0]))) {
    rest.shift();
  }
  if (rest[0] === "/cpb" || rest[0]?.toLowerCase() === "cpb") {
    rest.shift();
    return rest;
  }
  return null;
}

function extractRoutingOptions(tokens: string[]): Record<string, any> {
  const positional = [];
  let workflow = null;
  let planMode = null;
  let triage = null;
  let workflowRequested = false;
  let planModeRequested = false;
  let triageRequested = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--workflow" || token === "-w") {
      const value = tokens[i + 1];
      if (!value) {
        return { error: "missing workflow value", positional, workflow, planMode, triage };
      }
      workflow = value;
      workflowRequested = true;
      i += 1;
      continue;
    }
    if (token.startsWith("--workflow=")) {
      const value = token.slice("--workflow=".length);
      if (!value) {
        return { error: "missing workflow value", positional, workflow, planMode, triage };
      }
      workflow = value;
      workflowRequested = true;
      continue;
    }
    if (token === "--plan-mode") {
      const value = tokens[i + 1];
      if (!value) {
        return { error: "missing plan-mode value", positional, workflow, planMode, triage };
      }
      planMode = value;
      planModeRequested = true;
      i += 1;
      continue;
    }
    if (token.startsWith("--plan-mode=")) {
      const value = token.slice("--plan-mode=".length);
      if (!value) {
        return { error: "missing plan-mode value", positional, workflow, planMode, triage };
      }
      planMode = value;
      planModeRequested = true;
      continue;
    }
    if (token === "--triage") {
      const value = tokens[i + 1];
      if (!value || value.startsWith("--")) {
        triage = "auto";
      } else {
        triage = value;
        i += 1;
      }
      triageRequested = true;
      continue;
    }
    if (token.startsWith("--triage=")) {
      const value = token.slice("--triage=".length);
      if (!value) {
        return { error: "missing triage value", positional, workflow, planMode, triage };
      }
      triage = value;
      triageRequested = true;
      continue;
    }
    if (token === "--no-triage") {
      triage = "none";
      triageRequested = true;
      continue;
    }
    positional.push(token);
  }

  return {
    positional,
    workflow,
    planMode,
    triage,
    workflowRequested,
    planModeRequested,
    triageRequested,
    error: null,
  };
}

function validProject(project: string) {
  return typeof project === "string" && SAFE_PROJECT.test(project);
}

function parsePositiveInteger(value: unknown): number | null {
  if (!/^[0-9]+$/.test(String(value ?? ""))) return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function okResult(type: string, fields: Record<string, any>) {
  return {
    ok: true,
    type,
    command: type,
    ...baseFields(fields),
  };
}

function parseRun(command: string, tokens: string[]) {
  const {
    positional,
    workflow,
    planMode,
    triage,
    workflowRequested,
    planModeRequested,
    triageRequested,
    error,
  } = extractRoutingOptions(tokens);
  if (error) return errorResult("INVALID_COMMAND", error, { command });

  const [project, ...taskParts] = positional;
  const task = taskParts.join(" ").trim();
  if (!validProject(project) || !task) {
    return errorResult("INVALID_COMMAND", "run requires project and task", { command });
  }

  return okResult("run", {
    project,
    task,
    workflow,
    planMode,
    triage,
    workflowRequested,
    planModeRequested,
    triageRequested,
  });
}

function parseIssue(command: string, tokens: string[]) {
  const {
    positional,
    workflow,
    planMode,
    triage,
    workflowRequested,
    planModeRequested,
    triageRequested,
    error,
  } = extractRoutingOptions(tokens);
  if (error) return errorResult("INVALID_COMMAND", error, { command });

  const [project, issueValue] = positional;
  const issue = parsePositiveInteger(issueValue);
  if (!validProject(project) || !issue) {
    return errorResult("INVALID_COMMAND", "issue requires project and numeric issue", { command });
  }

  return okResult("issue", {
    project,
    issue,
    workflow,
    planMode,
    triage,
    workflowRequested,
    planModeRequested,
    triageRequested,
  });
}

function parseJobCommand(command: string, tokens: string[]) {
  const [job] = tokens;
  if (!job) {
    return errorResult("INVALID_COMMAND", `${command} requires job`, { command });
  }
  return okResult(command, { job });
}

export function parseChannelCommand(input: string) {
  const detection = detectSecretInput(input);
  if (detection.matched) {
    return {
      ...errorResult("SECRET_INPUT_REJECTED", detection.guidance),
      guidance: detection.guidance,
      detection,
    };
  }

  const tokens = stripInvocation(tokenizeChannelCommand(input));
  if (!tokens) {
    return errorResult("NOT_CPB_COMMAND", "message is not a CodePatchBay command");
  }
  const command = tokens.shift()?.toLowerCase() || "";
  if (!command) {
    return errorResult("INVALID_COMMAND", "missing command");
  }

  if (command === "run") return parseRun(command, tokens);
  if (command === "issue") return parseIssue(command, tokens);
  if (command === "status" || command === "approve" || command === "cancel" || command === "retry" || command === "logs") {
    return parseJobCommand(command, tokens);
  }

  return errorResult("UNKNOWN_COMMAND", `unknown command: ${command}`, { command });
}

// ============================================================
// channel-policy (formerly channel-policy.ts)
// ============================================================


function channelPolicyRoot(cpbRoot: string, options: Record<string, any> = {}) {
  if (options.controlRoot) return path.resolve(options.controlRoot);
  if (options.hubRoot) return path.resolve(options.hubRoot);
  return process.env.CPB_HUB_ROOT ? resolveHubRoot(cpbRoot) : runtimeDataRoot(cpbRoot);
}

function channelPolicyEventsPath(cpbRoot: string, options: Record<string, any> = {}) {
  return path.join(channelPolicyRoot(cpbRoot, options), "channel-policy-events.jsonl");
}

function asList(value: unknown) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function matchesField(ruleValue: unknown, requestValue: unknown) {
  const values = asList(ruleValue);
  if (values.length === 0) return true;
  return values.some((value) => value === "*" || String(value) === String(requestValue ?? ""));
}

function ruleMatches(rule: AnyRecord, request: AnyRecord) {
  return (
    matchesField(rule.channel, request.channel) &&
    matchesField(rule.project, request.project) &&
    matchesField(rule.channelId, request.channelId) &&
    matchesField(rule.userId, request.userId) &&
    matchesField(rule.actions || rule.action, request.action)
  );
}

function normalizedRules(policy: AnyRecord = {}) {
  return [
    ...asList(policy.rules),
    ...asList(policy.allow).map((rule) => ({ ...rule, effect: "allow" })),
    ...asList(policy.deny).map((rule) => ({ ...rule, effect: "deny" })),
  ].filter((rule) => rule && typeof rule === "object");
}

export function channelPolicyRequest({
  channel,
  action,
  project = null,
  job = null,
  actor = {},
  channelId = null,
}: AnyRecord = {}) {
  return {
    channel: channel || null,
    action: action || null,
    project,
    job,
    userId: actor.userId || actor.id || null,
    channelId: channelId || actor.channelId || null,
  };
}

export function evaluateChannelPolicy(policy: AnyRecord | null | undefined, request: AnyRecord) {
  if (!policy || policy.enabled === false) {
    return { allowed: true, reason: "channel policy not configured", matchedRule: null };
  }

  const rules = normalizedRules(policy);
  const deny = rules.find((rule) => (rule.effect || "allow") === "deny" && ruleMatches(rule, request));
  if (deny) {
    return { allowed: false, reason: "matched deny rule", matchedRule: deny };
  }

  const allow = rules.find((rule) => (rule.effect || "allow") === "allow" && ruleMatches(rule, request));
  if (allow) {
    return { allowed: true, reason: "matched allow rule", matchedRule: allow };
  }

  if (policy.default === "deny") {
    return {
      allowed: false,
      reason: `${request.channel || "channel"} ${request.action || "action"} is not allowed for project ${request.project || "unknown"}`,
      matchedRule: null,
    };
  }

  return { allowed: true, reason: "default allow", matchedRule: null };
}

export async function recordChannelPolicyDecision(cpbRoot: string, decision: AnyRecord, request: AnyRecord, options: Record<string, any> = {}) {
  const event = {
    type: "channel_policy_decision",
    allowed: Boolean(decision.allowed),
    reason: decision.reason || null,
    request: redactSecrets(request),
    ts: new Date().toISOString(),
  };
  const file = channelPolicyEventsPath(cpbRoot, options);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

export async function enforceChannelPolicy(cpbRoot: string, policy: AnyRecord | null | undefined, request: AnyRecord, _options: Record<string, any> = {}) {
  const decision = evaluateChannelPolicy(policy, request);
  await recordChannelPolicyDecision(cpbRoot, decision, request, _options);
  return decision;
}

export async function readChannelPolicyEvents(cpbRoot: string, options: Record<string, any> = {}) {
  let raw;
  try {
    raw = await readFile(channelPolicyEventsPath(cpbRoot, options), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
