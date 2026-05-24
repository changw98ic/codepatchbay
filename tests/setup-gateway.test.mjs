import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("setup gateway catalog", () => {
  it("exposes tiered coding-agent manifests with transparent install commands", async () => {
    const { listSetupAgents, getSetupAgent } = await import("../core/setup/agent-catalog.js");

    const agents = listSetupAgents();
    const names = agents.map((agent) => agent.id);

    assert.deepEqual(names.slice(0, 3), ["codex", "claude", "opencode"]);
    assert.equal(getSetupAgent("codex").displayName, "OpenAI Codex CLI");
    assert.equal(getSetupAgent("codex").install.npm.command, "npm i -g @openai/codex");
    assert.equal(getSetupAgent("claude").install.brew.command, "brew install --cask claude-code");
    assert.equal(getSetupAgent("opencode").install.npm.command, "npm install -g opencode-ai");
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

    assert.equal(snapshot.system.platform, "darwin");
    assert.equal(snapshot.tools.node.installed, true);
    assert.equal(snapshot.tools.brew.installed, false);
    assert.equal(snapshot.agents.codex.installed, true);
    assert.equal(snapshot.agents.claude.installed, false);
    assert.equal(snapshot.agents.opencode.installed, true);
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
  });
});
