// @ts-nocheck
import assert from "node:assert/strict";
import { test } from "node:test";
import { createInstallPlan, upgradeFor } from "../core/setup/install-plan.js";
import { validateSetupAgentManifest } from "../core/setup/manifest-schema.js";
import { getSetupAgent, listSetupAgents } from "../core/setup/agent-catalog.js";

// --- D41 Acceptance: Install plan includes pinned version command ---

test("createInstallPlan with version produces pinned command for npm agents", () => {
  const plan = createInstallPlan({ agentId: "claude", method: "npm", version: "1.2.3" });
  assert.equal(plan.version, "1.2.3");
  assert.ok(plan.displayCommand.includes("@anthropic-ai/claude-code@1.2.3"),
    `displayCommand should contain pinned version: ${plan.displayCommand}`);
  assert.ok(plan.displayCommand.includes("1.2.3"));
});

test("createInstallPlan with version throws if manifest has no pinnedCommandTemplate", () => {
  assert.throws(
    () => createInstallPlan({ agentId: "cursor", method: "script", version: "1.0.0" }),
    /pinnedCommandTemplate is required/,
  );
});

test("createInstallPlan without version uses the default command", () => {
  const plan = createInstallPlan({ agentId: "codex", method: "npm" });
  assert.equal(plan.version, undefined);
  assert.equal(plan.displayCommand, "npm i -g @openai/codex");
});

test("renderPinnedCommand rejects invalid version strings", () => {
  assert.throws(() => createInstallPlan({ agentId: "claude", method: "npm", version: "" }));
  assert.throws(() => createInstallPlan({ agentId: "claude", method: "npm", version: "1.0; rm -rf /" }));
});

// --- D41 Acceptance: Upgrade plan and rollback guidance are visible ---

test("createInstallPlan includes upgrade plan from manifest", () => {
  const plan = createInstallPlan({ agentId: "claude", method: "npm" });
  assert.ok(plan.upgrade, "plan should include upgrade info");
  assert.equal(plan.upgrade.method, "npm");
  assert.ok(plan.upgrade.displayCommand.includes("npm update"));
  assert.ok(plan.upgrade.sourceUrl);
});

test("createInstallPlan includes rollback guidance", () => {
  const plan = createInstallPlan({ agentId: "claude", method: "npm" });
  assert.ok(plan.rollback, "plan should include rollback info");
  assert.ok(plan.rollback.command, "rollback should have a command");
  assert.ok(plan.rollback.command.includes("npm uninstall"));
});

test("upgradeFor returns null when agent has no upgrade for method", () => {
  const agent = getSetupAgent("cursor");
  const result = upgradeFor("npm", agent);
  assert.equal(result, null);
});

test("upgradeFor returns upgrade plan for script-based agents", () => {
  const agent = getSetupAgent("cursor");
  const result = upgradeFor("script", agent);
  assert.ok(result);
  assert.equal(result.method, "script");
  assert.ok(result.displayCommand);
});

test("upgrade plan always has requiresExplicitConfirmation", () => {
  for (const agent of listSetupAgents()) {
    for (const method of Object.keys(agent.upgrade || {})) {
      const plan = upgradeFor(method, agent);
      if (plan) {
        assert.equal(plan.requiresExplicitConfirmation, true,
          `${agent.id} upgrade.${method} should require explicit confirmation`);
      }
    }
  }
});

// --- D41 Acceptance: No upgrade command executes without --yes ---

test("executeInstallPlan refuses plans without requiresExplicitConfirmation", async () => {
  const { executeInstallPlan } = await import("../core/setup/install-plan.js");
  await assert.rejects(
    () => executeInstallPlan({ command: "echo", args: ["hi"] }),
    /Refusing to execute/,
  );
});

test("upgrade plan from createInstallPlan has requiresExplicitConfirmation", () => {
  const plan = createInstallPlan({ agentId: "codex", method: "npm" });
  assert.equal(plan.requiresExplicitConfirmation, true);
});

// --- Manifest schema validates upgrade and pinnedCommandTemplate ---

test("manifest schema accepts valid upgrade entries", () => {
  const manifest = {
    id: "test",
    displayName: "Test",
    binary: "test",
    sourceUrl: "https://example.com",
    roles: ["executor"],
    capabilities: ["shell"],
    install: { npm: { label: "npm", command: "npm i -g test", sourceUrl: "https://example.com" } },
    upgrade: { npm: { label: "npm upgrade", command: "npm update -g test", sourceUrl: "https://example.com" } },
  };
  const result = validateSetupAgentManifest(manifest);
  assert.equal(result.valid, true, result.errors.join("; "));
});

test("manifest schema rejects invalid upgrade entries", () => {
  const manifest = {
    id: "test",
    displayName: "Test",
    binary: "test",
    sourceUrl: "https://example.com",
    roles: ["executor"],
    capabilities: ["shell"],
    install: { npm: { label: "npm", command: "npm i -g test", sourceUrl: "https://example.com" } },
    upgrade: { npm: { label: "", command: "" } },
  };
  const result = validateSetupAgentManifest(manifest);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("upgrade.npm")));
});

test("manifest schema accepts valid pinnedCommandTemplate", () => {
  const manifest = {
    id: "test",
    displayName: "Test",
    binary: "test",
    sourceUrl: "https://example.com",
    roles: ["executor"],
    capabilities: ["shell"],
    install: { npm: { label: "npm", command: "npm i -g test", sourceUrl: "https://example.com", pinnedCommandTemplate: "npm i -g test@{version}" } },
  };
  const result = validateSetupAgentManifest(manifest);
  assert.equal(result.valid, true, result.errors.join("; "));
});

test("manifest schema rejects non-string pinnedCommandTemplate", () => {
  const manifest = {
    id: "test",
    displayName: "Test",
    binary: "test",
    sourceUrl: "https://example.com",
    roles: ["executor"],
    capabilities: ["shell"],
    install: { npm: { label: "npm", command: "npm i -g test", sourceUrl: "https://example.com", pinnedCommandTemplate: 42 } },
  };
  const result = validateSetupAgentManifest(manifest);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("pinnedCommandTemplate")));
});

test("all built-in manifests pass schema validation including upgrade fields", () => {
  for (const agent of listSetupAgents()) {
    const result = validateSetupAgentManifest(agent);
    assert.equal(result.valid, true, `${agent.id}: ${result.errors.join("; ")}`);
  }
});
