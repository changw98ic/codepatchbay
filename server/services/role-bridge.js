import { loadProfile } from "./profile-loader.js";

const ROLE_BRIDGE_MAP = {
  planner: "planner.sh",
  executor: "executor.sh",
  verifier: "verifier.sh",
  reviewer: "reviewer.sh",
  repairer: "repairer.sh",
};

export function bridgeForRole(role) {
  return ROLE_BRIDGE_MAP[role] ?? null;
}

export async function bridgeEnvFromProfile(cpbRoot, role) {
  const profile = await loadProfile(cpbRoot, role);
  const env = {};
  if (profile.permissions.deny_tools.length > 0) {
    env.CPB_ACP_DENY_TOOLS = profile.permissions.deny_tools.join(",");
  }
  if (profile.agent.command) {
    env.CPB_ACP_CLAUDE_COMMAND = profile.agent.command;
  }
  return env;
}
