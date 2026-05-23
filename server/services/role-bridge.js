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
  // Map role to agent via registry, then set agent-specific env
  if (profile.agent.command) {
    try {
      const { loadRegistry, defaultAgentForRole, getDescriptor } = await import("../../core/agents/registry.js");
      await loadRegistry();
      const agentName = defaultAgentForRole(role);
      const descriptor = getDescriptor(agentName);
      if (descriptor) {
        env[`${descriptor.envPrefix}_COMMAND`] = profile.agent.command;
      } else {
        // Fallback to legacy env vars
        env.CPB_ACP_CODEX_COMMAND = profile.agent.command;
      }
    } catch {
      // Registry unavailable, use legacy mapping
      const CODEX_ROLES = new Set(["planner", "verifier", "reviewer"]);
      if (CODEX_ROLES.has(role)) {
        env.CPB_ACP_CODEX_COMMAND = profile.agent.command;
      } else {
        env.CPB_ACP_CLAUDE_COMMAND = profile.agent.command;
      }
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
