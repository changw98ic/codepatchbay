import { loadProfile } from "./prompt/prompt-resources.js";

const ROLE_BRIDGE_MAP: Record<string, string> = {
  planner: "planner.sh",
  executor: "executor.sh",
  verifier: "verifier.sh",
  reviewer: "reviewer.sh",
  repairer: "repairer.sh",
};

const ROLE_DISPATCH_MAP: Record<string, string> = {
  planner: "planner",
  executor: "executor",
  verifier: "verifier",
  reviewer: "reviewer",
  repairer: "repairer",
};

export function bridgeForRole(role: string) {
  return ROLE_BRIDGE_MAP[role] ?? null;
}

export function dispatchForRole(role: string) {
  return ROLE_DISPATCH_MAP[role] ?? null;
}

export async function bridgeEnvFromProfile(cpbRoot: string, role: string) {
  const profile = await loadProfile(cpbRoot, role);
  const env: Record<string, string> = {};
  if (profile.permissions.deny_tools.length > 0) {
    env.CPB_ACP_DENY_TOOLS = profile.permissions.deny_tools.join(",");
  }
  if (profile.agent.command) {
    env.CPB_ACP_CLAUDE_COMMAND = profile.agent.command;
  }
  return env;
}
