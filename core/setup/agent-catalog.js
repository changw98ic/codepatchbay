const SETUP_AGENTS = [
  {
    id: "codex",
    displayName: "OpenAI Codex CLI",
    vendor: "OpenAI",
    binary: "codex",
    tier: 1,
    recommended: true,
    roles: ["planner", "verifier", "executor"],
    capabilities: ["repo_inspect", "file_edit", "shell", "verify", "pr_review"],
    sourceUrl: "https://github.com/openai/codex/blob/main/codex-rs/README.md",
    install: {
      npm: {
        label: "npm",
        command: "npm i -g @openai/codex",
        sourceUrl: "https://github.com/openai/codex/blob/main/codex-rs/README.md",
      },
      brew: {
        label: "Homebrew",
        command: "brew install --cask codex",
        sourceUrl: "https://github.com/openai/codex/blob/main/codex-rs/README.md",
      },
    },
    auth: {
      methods: ["chatgpt", "api_key"],
      connectCommand: "codex",
      statusCommand: "codex auth status",
    },
    adapter: {
      protocol: "acp",
      command: "codex-acp",
    },
  },
  {
    id: "claude",
    displayName: "Claude Code",
    vendor: "Anthropic",
    binary: "claude",
    tier: 1,
    recommended: true,
    roles: ["executor", "repairer"],
    capabilities: ["repo_inspect", "file_edit", "shell", "large_context"],
    sourceUrl: "https://code.claude.com/docs/en/installation",
    install: {
      native: {
        label: "native installer",
        command: "curl -fsSL https://claude.ai/install.sh | bash",
        sourceUrl: "https://code.claude.com/docs/en/quickstart",
        notes: ["Shows a fetched installer command; require local confirmation before executing."],
      },
      brew: {
        label: "Homebrew",
        command: "brew install --cask claude-code",
        sourceUrl: "https://code.claude.com/docs/en/quickstart",
      },
      npm: {
        label: "npm",
        command: "npm install -g @anthropic-ai/claude-code",
        sourceUrl: "https://support.claude.com/en/articles/14552382-your-first-day-in-claude-code",
        notes: ["Do not use sudo with global npm installs."],
      },
    },
    auth: {
      methods: ["browser_login", "console", "bedrock", "vertex"],
      connectCommand: "claude",
      statusCommand: "claude doctor",
    },
    adapter: {
      protocol: "acp",
      command: "claude-agent-acp",
    },
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    vendor: "Anomaly",
    binary: "opencode",
    tier: 1,
    recommended: true,
    roles: ["executor", "reviewer", "fallback"],
    capabilities: ["repo_inspect", "file_edit", "shell", "provider_keys"],
    sourceUrl: "https://opencode.ai/docs/",
    install: {
      script: {
        label: "install script",
        command: "curl -fsSL https://opencode.ai/install | bash",
        sourceUrl: "https://opencode.ai/docs/",
        notes: ["Shows a fetched installer command; require local confirmation before executing."],
      },
      npm: {
        label: "npm",
        command: "npm install -g opencode-ai",
        sourceUrl: "https://opencode.ai/docs/",
      },
      brew: {
        label: "Homebrew",
        command: "brew install anomalyco/tap/opencode",
        sourceUrl: "https://opencode.ai/docs/",
      },
    },
    auth: {
      methods: ["provider_api_key", "connect"],
      connectCommand: "opencode auth login",
      statusCommand: "opencode auth list",
    },
    adapter: {
      protocol: "cli",
      command: "opencode",
    },
  },
  {
    id: "cursor",
    displayName: "Cursor Agent",
    vendor: "Anysphere",
    binary: "cursor-agent",
    tier: 2,
    recommended: false,
    roles: ["executor"],
    capabilities: ["repo_inspect", "file_edit", "shell", "automation"],
    sourceUrl: "https://docs.cursor.com/en/cli/installation",
    install: {
      script: {
        label: "install script",
        command: "curl https://cursor.com/install -fsS | bash",
        sourceUrl: "https://docs.cursor.com/en/cli/installation",
        notes: ["Shows a fetched installer command; require local confirmation before executing."],
      },
    },
    auth: {
      methods: ["browser_login"],
      connectCommand: "cursor-agent",
      statusCommand: "cursor-agent --version",
    },
    adapter: {
      protocol: "cli",
      command: "cursor-agent",
    },
  },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function listSetupAgents({ includeOptional = true } = {}) {
  const agents = includeOptional ? SETUP_AGENTS : SETUP_AGENTS.filter((agent) => agent.recommended);
  return clone(agents);
}

export function getSetupAgent(id) {
  const agent = SETUP_AGENTS.find((entry) => entry.id === id);
  return agent ? clone(agent) : null;
}
