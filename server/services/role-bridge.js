import { loadProfile } from "./profile-loader.js";

const ROLE_BRIDGE_MAP = {
  codex: "codex-plan.sh",
  claude: "claude-execute.sh",
  codex_verify: "codex-verify.sh",
  codex_review: "reviewer-review.sh",
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
