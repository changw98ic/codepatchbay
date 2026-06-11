// @ts-nocheck
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
    roles: ["executor", "remediator"],
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
    assert.deepEqual(ids, ["codex", "claude", "opencode", "cursor", "reasonix"]);
  });

  it("listSetupAgents preserves current commands from built-in manifests", async () => {
    const { listSetupAgents, getSetupAgent } = await import("../core/setup/agent-catalog.js");
    const agents = listSetupAgents();
    assert.equal(agents.length, 5);
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

  it("loadSetupAgentCatalog returns empty array for missing directory in non-strict mode", async () => {
    const { loadSetupAgentCatalog } = await import("../core/setup/agent-catalog.js");
    const agents = loadSetupAgentCatalog({ manifestDir: "/nonexistent/path", strict: false });
    assert.equal(agents.length, 0);
  });

  it("loadSetupAgentCatalog returns cloned manifests that do not share references", async () => {
    const { loadSetupAgentCatalog } = await import("../core/setup/agent-catalog.js");
    const dir = await makeManifestDir({ "codex.json": validCodex });
    try {
      const agents1 = loadSetupAgentCatalog({ manifestDir: dir });
      const agents2 = loadSetupAgentCatalog({ manifestDir: dir });
      agents1[0].displayName = "mutated";
      assert.equal(agents2[0].displayName, "OpenAI Codex CLI");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("getSetupAgent returns null for unknown agent id", async () => {
    const { getSetupAgent } = await import("../core/setup/agent-catalog.js");
    assert.equal(getSetupAgent("nonexistent-agent"), null);
  });

  it("getSetupAgent returns a clone independent of internal catalog", async () => {
    const { getSetupAgent } = await import("../core/setup/agent-catalog.js");
    const a1 = getSetupAgent("codex");
    const a2 = getSetupAgent("codex");
    a1.displayName = "mutated";
    assert.equal(a2.displayName, "OpenAI Codex CLI");
  });

  it("listSetupAgents filters to recommended only when includeOptional is false", async () => {
    const { listSetupAgents } = await import("../core/setup/agent-catalog.js");
    const all = listSetupAgents();
    const recommended = listSetupAgents({ includeOptional: false });
    assert.ok(all.length > recommended.length);
    for (const agent of recommended) {
      assert.equal(agent.recommended, true);
    }
  });

  it("built-in manifests pass schema validation", async () => {
    const { listSetupAgents } = await import("../core/setup/agent-catalog.js");
    const { validateSetupAgentManifest } = await import("../core/setup/manifest-schema.js");
    const agents = listSetupAgents();
    for (const agent of agents) {
      const result = validateSetupAgentManifest(agent);
      assert.equal(result.valid, true, `Agent ${agent.id} should pass validation: ${result.errors.join(", ")}`);
    }
  });
});
