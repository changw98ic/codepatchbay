const ROLE_BRIDGE_MAP = {
  codex: "codex-plan.sh",
  claude: "claude-execute.sh",
  codex_verify: "codex-verify.sh",
};

export function bridgeForRole(role) {
  return ROLE_BRIDGE_MAP[role] ?? null;
}
