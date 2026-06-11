import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "./secret-policy.js";

type AnyRecord = Record<string, any>;

function controlDataRoot(cpbRoot, { dataRoot, hubRoot }: AnyRecord = {}) {
  const root = dataRoot || hubRoot || process.env.CPB_HUB_ROOT;
  return root ? path.resolve(root) : path.join(path.resolve(cpbRoot), "cpb-task");
}

function channelPolicyEventsPath(cpbRoot, options: AnyRecord = {}) {
  return path.join(controlDataRoot(cpbRoot, options), "channel-policy-events.jsonl");
}

function asList(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function matchesField(ruleValue, requestValue) {
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

export function evaluateChannelPolicy(policy, request) {
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

export async function recordChannelPolicyDecision(cpbRoot, decision, request, options: AnyRecord = {}) {
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

export async function enforceChannelPolicy(cpbRoot, policy, request, options: AnyRecord = {}) {
  const decision = evaluateChannelPolicy(policy, request);
  await recordChannelPolicyDecision(cpbRoot, decision, request, options);
  return decision;
}

export async function readChannelPolicyEvents(cpbRoot, options: AnyRecord = {}) {
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
