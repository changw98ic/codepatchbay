import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("setup gateway catalog", () => {
  it("exposes tiered coding-agent manifests with transparent install commands", async () => {
    const { listSetupAgents, getSetupAgent } = await import("../core/setup/agent-catalog.js");
    const { validateSetupAgentManifest } = await import("../core/setup/manifest-schema.js");

    const agents = listSetupAgents();
    const names = agents.map((agent) => agent.id);

    assert.deepEqual(names.slice(0, 3), ["codex", "claude", "opencode"]);
    assert.equal(getSetupAgent("codex").displayName, "OpenAI Codex CLI");
    assert.equal(getSetupAgent("codex").install.npm.command, "npm i -g @openai/codex");
    assert.equal(getSetupAgent("claude").install.brew.command, "brew install --cask claude-code");
    assert.equal(getSetupAgent("opencode").install.npm.command, "npm install -g opencode-ai");
    for (const agent of agents) {
      assert.deepEqual(validateSetupAgentManifest(agent), { valid: true, errors: [] });
    }
  });

  it("reports actionable setup manifest schema errors", async () => {
    const { validateSetupAgentManifest } = await import("../core/setup/manifest-schema.js");

    const result = validateSetupAgentManifest({
      id: "bad-agent",
      displayName: "Bad Agent",
      binary: "bad-agent",
      roles: ["executor"],
      capabilities: ["shell"],
      install: {
        npm: { label: "npm" },
      },
    });

    assert.equal(result.valid, false);
    assert.ok(result.errors.includes("sourceUrl must be a non-empty string"));
    assert.ok(result.errors.includes("install.npm.command must be a non-empty string"));
    assert.ok(result.errors.includes("install.npm.sourceUrl must be a non-empty string"));
  });

  it("builds a setup snapshot from injected probes without running installers", async () => {
    const { detectSetupEnvironment } = await import("../core/setup/detect.js");

    const snapshot = await detectSetupEnvironment({
      runCommand: async (command, args) => {
        if (command === "node") return { ok: true, stdout: "v22.1.0\n" };
        if (command === "git") return { ok: true, stdout: "git version 2.45.0\n" };
        if (command === "npm") return { ok: true, stdout: "10.8.0\n" };
        if (command === "brew") return { ok: false, error: Object.assign(new Error("missing"), { code: "ENOENT" }) };
        if (command === "codex") return { ok: true, stdout: "codex-cli 0.130.0\n" };
        if (command === "claude") return { ok: false, error: Object.assign(new Error("missing"), { code: "ENOENT" }) };
        if (command === "opencode") return { ok: true, stdout: "opencode 1.0.0\n" };
        return { ok: false, error: new Error(`unexpected command ${command} ${args.join(" ")}`) };
      },
      platform: "darwin",
      arch: "arm64",
    });

    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.system.platform, "darwin");
    assert.equal(snapshot.tools.node.installed, true);
    assert.equal(snapshot.tools.brew.installed, false);
    assert.equal(snapshot.tools.brew.status, "missing");
    assert.equal(snapshot.tools.brew.error.kind, "missing");
    assert.equal(snapshot.agents.codex.installed, true);
    assert.equal(snapshot.agents.claude.installed, false);
    assert.equal(snapshot.agents.claude.status, "missing");
    assert.equal(snapshot.agents.claude.error.kind, "missing");
    assert.equal(snapshot.agents.opencode.installed, true);
  });

  it("classifies command timeouts as structured probe records", async () => {
    const { detectSetupEnvironment } = await import("../core/setup/detect.js");

    const timeoutError = Object.assign(new Error("command timed out"), {
      code: "ETIMEDOUT",
      signal: "SIGTERM",
      killed: true,
    });

    const snapshot = await detectSetupEnvironment({
      runCommand: async (command) => {
        if (["node", "git", "npm"].includes(command)) return { ok: true, stdout: `${command} ok\n` };
        if (command === "opencode") return { ok: false, error: timeoutError };
        return { ok: false, error: Object.assign(new Error("missing"), { code: "ENOENT" }) };
      },
      platform: "linux",
      arch: "x64",
    });

    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.agents.opencode.installed, false);
    assert.equal(snapshot.agents.opencode.status, "timeout");
    assert.equal(snapshot.agents.opencode.error.kind, "timeout");
    assert.equal(snapshot.agents.opencode.error.code, "ETIMEDOUT");
    assert.equal(snapshot.tools.brew.status, "missing");
    assert.equal(snapshot.tools.brew.error.kind, "missing");
  });

  it("selects an explicit install plan and never defaults to silent installation", async () => {
    const { createInstallPlan } = await import("../core/setup/install-plan.js");

    const plan = createInstallPlan({
      agentId: "claude",
      method: "brew",
      detected: { tools: { brew: { installed: true }, npm: { installed: true } } },
    });

    assert.equal(plan.agent.id, "claude");
    assert.equal(plan.method, "brew");
    assert.equal(plan.command, "brew");
    assert.deepEqual(plan.args, ["install", "--cask", "claude-code"]);
    assert.equal(plan.requiresExplicitConfirmation, true);
    assert.match(plan.sourceUrl, /claude\.com/);
    assert.equal(plan.rollback.command, "brew uninstall --cask claude-code");
    assert.ok(plan.supplyChainNotes.includes("Review the source URL before executing this plan."));
  });

  it("marks fetched installer commands with shell and supply-chain metadata", async () => {
    const { createInstallPlan } = await import("../core/setup/install-plan.js");

    const plan = createInstallPlan({
      agentId: "opencode",
      method: "script",
      detected: { tools: { brew: { installed: false }, npm: { installed: true } } },
    });

    assert.equal(plan.shell, true);
    assert.equal(plan.command, "sh");
    assert.deepEqual(plan.args, ["-lc", "curl -fsSL https://opencode.ai/install | bash"]);
    assert.equal(plan.rollback.command, null);
    assert.ok(plan.rollback.notes.some((note) => /vendor uninstall/i.test(note)));
    assert.ok(plan.supplyChainNotes.some((note) => /fetched installer/i.test(note)));
  });

  it("records failed explicit install attempts without storing command text", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-setup-events-"));
    try {
      const { readSetupEvents, runInstallPlanWithEvents } = await import("../server/services/setup-events.js");
      const plan = {
        agent: { id: "fake-agent", displayName: "Fake Agent", vendor: "Tests", binary: "fake-agent" },
        method: "test",
        command: process.execPath,
        args: ["-e", "process.exit(7)"],
        displayCommand: "fake install SECRET_TOKEN_SHOULD_NOT_APPEAR",
        sourceUrl: "https://example.invalid/fake-agent",
        requiresExplicitConfirmation: true,
        shell: false,
      };

      await assert.rejects(
        () => runInstallPlanWithEvents(plan, { cpbRoot: tmpRoot, stdio: "ignore" }),
        /Install command exited with code 7/,
      );

      const events = await readSetupEvents(tmpRoot);
      assert.equal(events.length, 2);
      assert.equal(events[0].type, "setup_install_started");
      assert.equal(events[0].agentId, "fake-agent");
      assert.equal(events[0].method, "test");
      assert.match(events[0].commandHash, /^[a-f0-9]{64}$/);
      assert.equal(events[1].type, "setup_install_finished");
      assert.equal(events[1].result, "failed");
      assert.equal(events[1].exitCode, 7);
      assert.doesNotMatch(JSON.stringify(events), /SECRET_TOKEN_SHOULD_NOT_APPEAR/);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("checks binary auth and adapter health for a setup agent", async () => {
    const { checkSetupAgentHealth } = await import("../core/setup/health-check.js");

    const result = await checkSetupAgentHealth("codex", {
      runCommand: async (command, args) => {
        const signature = [command, ...args].join(" ");
        if (signature === "codex --version") return { ok: true, stdout: "codex-cli 0.130.0\n" };
        if (signature === "codex auth status") return { ok: true, stdout: "signed in\n" };
        if (signature === "codex-acp --help") return { ok: true, stdout: "usage\n" };
        return { ok: false, error: Object.assign(new Error(`unexpected ${signature}`), { code: "EUNEXPECTED" }) };
      },
    });

    assert.equal(result.schemaVersion, 1);
    assert.equal(result.agent.id, "codex");
    assert.equal(result.status, "ready");
    assert.equal(result.checks.binary.status, "installed");
    assert.equal(result.checks.binary.version, "codex-cli 0.130.0");
    assert.equal(result.checks.auth.status, "ok");
    assert.equal(result.checks.adapter.status, "ok");
  });

  it("reports skipped optional health checks and structured timeouts", async () => {
    const { checkSetupAgentHealth } = await import("../core/setup/health-check.js");

    const timeoutError = Object.assign(new Error("adapter timed out"), {
      code: "ETIMEDOUT",
      killed: true,
      signal: "SIGTERM",
    });

    const result = await checkSetupAgentHealth({
      id: "minimal",
      displayName: "Minimal Agent",
      binary: "minimal",
      roles: ["executor"],
      capabilities: ["shell"],
      install: { npm: { label: "npm", command: "npm i -g minimal", sourceUrl: "https://example.invalid/minimal" } },
      sourceUrl: "https://example.invalid/minimal",
      adapter: { protocol: "acp", command: "minimal-acp" },
    }, {
      runCommand: async (command) => {
        if (command === "minimal") return { ok: true, stdout: "minimal 1.0.0\n" };
        if (command === "minimal-acp") return { ok: false, error: timeoutError };
        return { ok: false, error: Object.assign(new Error("missing"), { code: "ENOENT" }) };
      },
    });

    assert.equal(result.status, "degraded");
    assert.equal(result.checks.auth.status, "skipped");
    assert.equal(result.checks.adapter.status, "timeout");
    assert.equal(result.checks.adapter.error.kind, "timeout");
  });

  it("runs setup as an installer wizard and writes a setup profile", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-setup-wizard-"));
    try {
      const { runSetupWizard, readSetupProfile } = await import("../core/setup/wizard.js");
      const catalog = [
        {
          id: "codex",
          displayName: "OpenAI Codex CLI",
          vendor: "OpenAI",
          binary: "codex",
          recommended: true,
          roles: ["planner"],
          capabilities: ["repo_inspect"],
          sourceUrl: "https://example.invalid/codex",
          install: {
            npm: {
              label: "npm",
              command: `${process.execPath} -e "process.exit(0)"`,
              sourceUrl: "https://example.invalid/codex",
            },
          },
          auth: { connectCommand: "codex", statusCommand: "codex auth status" },
        },
        {
          id: "claude",
          displayName: "Claude Code",
          vendor: "Anthropic",
          binary: "claude",
          recommended: true,
          roles: ["executor"],
          capabilities: ["file_edit"],
          sourceUrl: "https://example.invalid/claude",
          install: {
            npm: {
              label: "npm",
              command: `${process.execPath} -e "process.exit(0)"`,
              sourceUrl: "https://example.invalid/claude",
            },
          },
          auth: { connectCommand: "claude", statusCommand: "claude doctor" },
        },
      ];
      const detected = {
        schemaVersion: 1,
        generatedAt: "2026-05-25T00:00:00.000Z",
        system: { platform: "darwin", arch: "arm64" },
        tools: {
          npm: { installed: true },
          brew: { installed: false },
        },
        agents: {
          codex: { installed: false, status: "missing" },
          claude: { installed: false, status: "missing" },
        },
      };
      const installed = [];
      const result = await runSetupWizard({
        cpbRoot: tmpRoot,
        mode: "non-interactive",
        agents: ["codex", "claude"],
        detectFn: async () => detected,
        catalog,
        runInstallPlanFn: async (plan) => {
          installed.push(plan.agent.id);
          return { ok: true, code: 0 };
        },
        healthCheckFn: async (agentId) => ({ agent: { id: agentId }, status: "ready", checks: {} }),
        authConnectFn: (agentId) => ({ provider: { id: agentId }, localSetupUrl: `http://127.0.0.1:3456/setup/auth/${agentId}` }),
      });

      assert.equal(result.executed, true);
      assert.deepEqual(result.selectedAgents.map((agent) => agent.id), ["codex", "claude"]);
      assert.deepEqual(installed, ["codex", "claude"]);
      assert.equal(result.installations.codex.status, "succeeded");
      assert.equal(result.health.claude.status, "ready");
      assert.equal(result.auth.codex.localSetupUrl, "http://127.0.0.1:3456/setup/auth/codex");
      assert.equal(result.profile.agents.codex.installed, true);

      const profile = await readSetupProfile(tmpRoot);
      assert.equal(profile.schemaVersion, 1);
      assert.deepEqual(profile.selectedAgents, ["codex", "claude"]);
      assert.equal(profile.agents.claude.healthStatus, "ready");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("recommended setup selects only missing recommended agents", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-setup-recommended-"));
    try {
      const { runSetupWizard } = await import("../core/setup/wizard.js");
      const catalog = [
        { id: "codex", displayName: "Codex", vendor: "OpenAI", binary: "codex", recommended: true, roles: [], capabilities: [], sourceUrl: "https://example.invalid/codex", install: { npm: { label: "npm", command: "npm i -g codex", sourceUrl: "https://example.invalid/codex" } } },
        { id: "opencode", displayName: "OpenCode", vendor: "OpenCode", binary: "opencode", recommended: false, roles: [], capabilities: [], sourceUrl: "https://example.invalid/opencode", install: { npm: { label: "npm", command: "npm i -g opencode", sourceUrl: "https://example.invalid/opencode" } } },
      ];
      const result = await runSetupWizard({
        cpbRoot: tmpRoot,
        mode: "recommended",
        detectFn: async () => ({
          tools: { npm: { installed: true }, brew: { installed: false } },
          agents: {
            codex: { installed: false, status: "missing" },
            opencode: { installed: false, status: "missing" },
          },
        }),
        catalog,
        runInstallPlanFn: async () => ({ ok: true, code: 0 }),
        healthCheckFn: async (agentId) => ({ agent: { id: agentId }, status: "ready", checks: {} }),
        authConnectFn: (agentId) => ({ provider: { id: agentId }, localSetupUrl: `http://127.0.0.1:3456/setup/auth/${agentId}` }),
      });

      assert.deepEqual(result.selectedAgents.map((agent) => agent.id), ["codex"]);
      assert.equal(result.installations.codex.status, "succeeded");
      assert.equal(result.installations.opencode, undefined);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("interactive setup asks for Codex, Claude Code, OpenCode, and auth checks individually", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-setup-interactive-"));
    try {
      const { runSetupWizard } = await import("../core/setup/wizard.js");
      const catalog = [
        { id: "codex", displayName: "Codex", vendor: "OpenAI", binary: "codex", recommended: true, roles: [], capabilities: [], sourceUrl: "https://example.invalid/codex", install: { npm: { label: "npm", command: "npm i -g codex", sourceUrl: "https://example.invalid/codex" } } },
        { id: "claude", displayName: "Claude Code", vendor: "Anthropic", binary: "claude", recommended: true, roles: [], capabilities: [], sourceUrl: "https://example.invalid/claude", install: { npm: { label: "npm", command: "npm i -g claude", sourceUrl: "https://example.invalid/claude" } } },
        { id: "opencode", displayName: "OpenCode", vendor: "OpenCode", binary: "opencode", recommended: false, roles: [], capabilities: [], sourceUrl: "https://example.invalid/opencode", install: { npm: { label: "npm", command: "npm i -g opencode", sourceUrl: "https://example.invalid/opencode" } } },
      ];
      const asked = [];
      const installed = [];
      const result = await runSetupWizard({
        cpbRoot: tmpRoot,
        mode: "interactive",
        detectFn: async () => ({
          tools: { npm: { installed: true }, brew: { installed: false } },
          agents: {
            codex: { installed: false, status: "missing" },
            claude: { installed: false, status: "missing" },
            opencode: { installed: false, status: "missing" },
          },
        }),
        catalog,
        questionFn: async (question) => {
          asked.push(question);
          if (/Install Codex\?/i.test(question)) return "y";
          if (/Install Claude Code\?/i.test(question)) return "n";
          if (/Install OpenCode\?/i.test(question)) return "y";
          if (/Run auth check\?/i.test(question)) return "n";
          return "";
        },
        confirmFn: async () => true,
        runInstallPlanFn: async (plan) => {
          installed.push(plan.agent.id);
          return { ok: true, code: 0 };
        },
        healthCheckFn: async () => {
          throw new Error("auth check should be skipped");
        },
        authConnectFn: () => {
          throw new Error("auth connect should be skipped");
        },
      });

      assert.deepEqual(asked, [
        "Install Codex? y/N ",
        "Install Claude Code? y/N ",
        "Install OpenCode? y/N ",
        "Run auth check? y/N ",
      ]);
      assert.deepEqual(result.selectedAgents.map((agent) => agent.id), ["codex", "opencode"]);
      assert.deepEqual(installed, ["codex", "opencode"]);
      assert.equal(result.health.codex.status, "skipped");
      assert.equal(result.auth.opencode.status, "skipped");
      assert.equal(result.profile.agents.codex.healthStatus, "skipped");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("D40 manifest registry layout", () => {
  async function makeManifestDir(entries) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cpb-manifest-"));
    for (const [name, content] of Object.entries(entries)) {
      await writeFile(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
    }
    return dir;
  }

  const validCodex = {
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
  };

  const validClaude = {
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
      npm: {
        label: "npm",
        command: "npm install -g @anthropic-ai/claude-code",
        sourceUrl: "https://support.claude.com/en/articles/14552382",
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
  };

  it("loadSetupAgentCatalog loads agents from JSON manifest files", async () => {
    const { loadSetupAgentCatalog } = await import("../core/setup/agent-catalog.js");
    const dir = await makeManifestDir({
      "codex.json": validCodex,
      "claude.json": validClaude,
    });
    try {
      const agents = loadSetupAgentCatalog({ manifestDir: dir });
      assert.equal(agents.length, 2);
      assert.equal(agents[0].id, "codex");
      assert.equal(agents[1].id, "claude");
      assert.equal(agents[0].install.npm.command, "npm i -g @openai/codex");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loadSetupAgentCatalog skips invalid JSON when strict is false", async () => {
    const { loadSetupAgentCatalog } = await import("../core/setup/agent-catalog.js");
    const dir = await makeManifestDir({
      "codex.json": validCodex,
      "broken.json": "this is not json {{{",
    });
    try {
      const agents = loadSetupAgentCatalog({ manifestDir: dir, strict: false });
      assert.equal(agents.length, 1);
      assert.equal(agents[0].id, "codex");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loadSetupAgentCatalog throws on invalid JSON when strict is true", async () => {
    const { loadSetupAgentCatalog } = await import("../core/setup/agent-catalog.js");
    const dir = await makeManifestDir({
      "codex.json": validCodex,
      "broken.json": "this is not json {{{",
    });
    try {
      assert.throws(
        () => loadSetupAgentCatalog({ manifestDir: dir, strict: true }),
        /broken\.json/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loadSetupAgentCatalog throws on invalid manifest schema in strict mode", async () => {
    const { loadSetupAgentCatalog } = await import("../core/setup/agent-catalog.js");
    const badManifest = { id: "bad", displayName: "Bad", binary: "bad" };
    const dir = await makeManifestDir({
      "bad.json": badManifest,
    });
    try {
      assert.throws(
        () => loadSetupAgentCatalog({ manifestDir: dir, strict: true }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loadSetupAgentCatalog skips invalid manifest schema when strict is false", async () => {
    const { loadSetupAgentCatalog } = await import("../core/setup/agent-catalog.js");
    const badManifest = { id: "bad", displayName: "Bad", binary: "bad" };
    const dir = await makeManifestDir({
      "bad.json": badManifest,
      "codex.json": validCodex,
    });
    try {
      const agents = loadSetupAgentCatalog({ manifestDir: dir, strict: false });
      assert.equal(agents.length, 1);
      assert.equal(agents[0].id, "codex");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("listSetupAgents preserves current ids and order from built-in manifests", async () => {
    const { listSetupAgents } = await import("../core/setup/agent-catalog.js");
    const agents = listSetupAgents();
    const ids = agents.map((a) => a.id);
    assert.deepEqual(ids, ["codex", "claude", "opencode", "cursor"]);
  });

  it("listSetupAgents preserves current commands from built-in manifests", async () => {
    const { listSetupAgents, getSetupAgent } = await import("../core/setup/agent-catalog.js");
    const agents = listSetupAgents();
    assert.equal(agents.length, 4);
    assert.equal(getSetupAgent("codex").install.npm.command, "npm i -g @openai/codex");
    assert.equal(getSetupAgent("claude").install.brew.command, "brew install --cask claude-code");
    assert.equal(getSetupAgent("opencode").install.npm.command, "npm install -g opencode-ai");
    assert.equal(getSetupAgent("cursor").install.script.command, "curl https://cursor.com/install -fsS | bash");
  });

  it("loadSetupAgentCatalog returns empty array for empty directory", async () => {
    const { loadSetupAgentCatalog } = await import("../core/setup/agent-catalog.js");
    const dir = await mkdtemp(path.join(os.tmpdir(), "cpb-manifest-empty-"));
    try {
      const agents = loadSetupAgentCatalog({ manifestDir: dir });
      assert.equal(agents.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loadSetupAgentCatalog ignores non-.json files", async () => {
    const { loadSetupAgentCatalog } = await import("../core/setup/agent-catalog.js");
    const dir = await makeManifestDir({
      "codex.json": validCodex,
      "readme.md": "# not a manifest",
      "notes.txt": "ignore me",
    });
    try {
      const agents = loadSetupAgentCatalog({ manifestDir: dir });
      assert.equal(agents.length, 1);
      assert.equal(agents[0].id, "codex");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("D41 version pin and upgrade plan", () => {
  const detected = { tools: { npm: { installed: true }, brew: { installed: false } } };

  it("uses pinnedCommandTemplate when version is supplied", async () => {
    const { createInstallPlan } = await import("../core/setup/install-plan.js");

    const plan = createInstallPlan({
      agentId: "codex",
      method: "npm",
      version: "0.130.0",
      detected,
    });

    assert.equal(plan.version, "0.130.0");
    assert.equal(plan.displayCommand, "npm i -g @openai/codex@0.130.0");
    assert.equal(plan.command, "npm");
    assert.deepEqual(plan.args, ["i", "-g", "@openai/codex@0.130.0"]);
  });

  it("plan shape includes version, upgrade, rollback, requiresExplicitConfirmation, displayCommand", async () => {
    const { createInstallPlan } = await import("../core/setup/install-plan.js");

    const plan = createInstallPlan({
      agentId: "codex",
      method: "npm",
      version: "0.130.0",
      detected,
    });

    assert.equal(plan.version, "0.130.0");
    assert.ok(plan.upgrade, "plan.upgrade must exist");
    assert.ok(plan.rollback, "plan.rollback must exist");
    assert.equal(plan.requiresExplicitConfirmation, true);
    assert.ok(plan.displayCommand.length > 0);
  });

  it("exposes upgrade metadata from manifest", async () => {
    const { createInstallPlan } = await import("../core/setup/install-plan.js");

    const plan = createInstallPlan({
      agentId: "codex",
      method: "npm",
      version: "0.130.0",
      detected,
    });

    assert.ok(plan.upgrade);
    assert.ok(typeof plan.upgrade.displayCommand === "string");
    assert.ok(plan.upgrade.displayCommand.length > 0);
    assert.equal(plan.upgrade.requiresExplicitConfirmation, true);
  });

  it("omits version pin when version is not supplied", async () => {
    const { createInstallPlan } = await import("../core/setup/install-plan.js");

    const plan = createInstallPlan({
      agentId: "codex",
      method: "npm",
      detected,
    });

    assert.equal(plan.version, undefined);
    assert.equal(plan.displayCommand, "npm i -g @openai/codex");
  });

  it("version-pinned plan never auto-executes: requiresExplicitConfirmation is always true", async () => {
    const { createInstallPlan } = await import("../core/setup/install-plan.js");

    const plan = createInstallPlan({
      agentId: "codex",
      method: "npm",
      version: "0.130.0",
      detected,
    });

    assert.equal(plan.requiresExplicitConfirmation, true);
    assert.equal(plan.upgrade.requiresExplicitConfirmation, true);
  });

  it("throws on empty version string", async () => {
    const { createInstallPlan } = await import("../core/setup/install-plan.js");

    assert.throws(
      () => createInstallPlan({ agentId: "codex", method: "npm", version: "", detected }),
      /version/i,
    );
  });

  it("throws on manifest method without pinnedCommandTemplate when version is supplied", async () => {
    const { createInstallPlan } = await import("../core/setup/install-plan.js");

    // brew method has no pinnedCommandTemplate — should throw when version is requested
    assert.throws(
      () => createInstallPlan({ agentId: "codex", method: "brew", version: "0.130.0", detected }),
      /pinnedCommandTemplate|version/i,
    );
  });
});
