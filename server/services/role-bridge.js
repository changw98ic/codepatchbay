import { loadProfile } from "./profile-loader.js";

const ROLE_BRIDGE_MAP = {
  planner: "run-phase.mjs",
  executor: "run-phase.mjs",
  verifier: "run-phase.mjs",
  reviewer: "run-phase.mjs",
  repairer: "run-phase.mjs",
};

const ROLE_DISPATCH_MAP = {
  planner: "planner",
  executor: "executor",
  verifier: "verifier",
  reviewer: "reviewer",
  repairer: "repairer",
};

const CODEX_ROLES = new Set(["planner", "verifier", "reviewer"]);
const CLAUDE_ROLES = new Set(["executor", "repairer"]);

export function bridgeForRole(role) {
  return ROLE_BRIDGE_MAP[role] ?? null;
}

export function dispatchForRole(role) {
  return ROLE_DISPATCH_MAP[role] ?? null;
}

export async function bridgeEnvFromProfile(cpbRoot, role) {
  const profile = await loadProfile(cpbRoot, role);
  const env = {};
  if (profile.permissions.deny_tools.length > 0) {
    env.CPB_ACP_DENY_TOOLS = profile.permissions.deny_tools.join(",");
  }
  // Map role-specific agent commands to correct env vars
  if (profile.agent.command) {
    if (CODEX_ROLES.has(role)) {
      env.CPB_ACP_CODEX_COMMAND = profile.agent.command;
    } else if (CLAUDE_ROLES.has(role)) {
      env.CPB_ACP_CLAUDE_COMMAND = profile.agent.command;
    }
  }
  // ACP lane metadata
  if (profile.acp) {
    env.CPB_ACP_LAUNCH_PROFILE = profile.acp.profile || "headless";
    env.CPB_ACP_UI_LANE = profile.acp.uiLane ? "1" : "0";
    if (profile.acp.uiLaneReason) env.CPB_ACP_UI_LANE_REASON = profile.acp.uiLaneReason;
  }
  return env;
}
