import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
});
