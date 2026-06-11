// @ts-nocheck
import { DEFAULT_GITHUB_TRIGGERS } from "./hub-registry.js";

function eventKey(event) {
  if (!event?.event || !event?.action) return null;
  return `${event.event}.${event.action}`;
}

function sameText(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function commandMatches(commandText, expected) {
  const command = String(commandText || "").trim();
  const prefix = String(expected || "").trim();
  return prefix !== "" && (command === prefix || command.startsWith(`${prefix} `));
}

function labelMatches(event, label) {
  const expected = String(label || "").toLowerCase();
  if (!expected) return false;
  return sameText(event.label, expected) || (event.labels || []).some((name) => sameText(name, expected));
}

function matchRule(event, rule) {
  if (!event || event.status !== "ok") return null;
  if (rule.event && rule.event !== eventKey(event)) return null;

  if (rule.label && labelMatches(event, rule.label)) {
    return `matched label ${rule.label}`;
  }

  if (rule.command && commandMatches(event.commandText, rule.command)) {
    return `matched command ${rule.command}`;
  }

  if (!rule.label && !rule.command) {
    return `matched ${rule.event || eventKey(event)}`;
  }

  return null;
}

export function matchGithubTrigger(event, rules = DEFAULT_GITHUB_TRIGGERS) {
  for (const rule of rules || []) {
    const reason = matchRule(event, rule);
    if (!reason) continue;
    return {
      matched: true,
      workflow: rule.workflow || "standard",
      planMode: rule.planMode || null,
      rule,
      reason,
    };
  }
  return {
    matched: false,
    workflow: null,
    rule: null,
    reason: "no trigger rule matched",
  };
}
