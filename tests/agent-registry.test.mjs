import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("agent registry", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-reg-test-"));
  });

  after(async () => {
    try { await rm(tmpDir, { recursive: true }); } catch {}
  });

  it("loads builtin descriptors", async () => {
    const { loadRegistry, hasAgent, getDescriptor } = await import("../core/agents/registry.js");
    await loadRegistry();
    assert.equal(hasAgent("codex"), true);
    assert.equal(hasAgent("claude"), true);
    assert.equal(hasAgent("gemini"), false);

    const codex = getDescriptor("codex");
    assert.equal(codex.name, "codex");
    assert.equal(codex.envPrefix, "CPB_ACP_CODEX");
    assert.ok(codex.defaultRoles.includes("planner"));
    assert.ok(codex.defaultRoles.includes("verifier"));

    const claude = getDescriptor("claude");
    assert.equal(claude.name, "claude");
    assert.ok(claude.defaultRoles.includes("executor"));
    assert.ok(claude.defaultRoles.includes("repairer"));
  });

  it("loads user descriptors from config dir", async () => {
    const configDir = path.join(tmpDir, "agents");
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "test-agent.json"), JSON.stringify({
      name: "test-agent",
      displayName: "Test Agent",
      command: "test-agent-bin",
      args: ["--mode", "test"],
      capabilities: ["plan", "execute"],
      defaultRoles: ["planner"],
      stability: "experimental",
      envPrefix: "CPB_ACP_TEST",
    }));

    const { loadRegistry, hasAgent, getDescriptor } = await import("../core/agents/registry.js");
    await loadRegistry(configDir);
    assert.equal(hasAgent("test-agent"), true);

    const d = getDescriptor("test-agent");
    assert.equal(d.command, "test-agent-bin");
    assert.deepEqual(d.args, ["--mode", "test"]);
    assert.deepEqual(d.defaultRoles, ["planner"]);
  });

  it("defaultAgentForRole uses descriptor defaultRoles", async () => {
    const { loadRegistry, defaultAgentForRole } = await import("../core/agents/registry.js");
    await loadRegistry();

    assert.equal(defaultAgentForRole("planner"), "codex");
    assert.equal(defaultAgentForRole("executor"), "claude");
    assert.equal(defaultAgentForRole("verifier"), "codex");
  });

  it("defaultAgentForRole falls back to legacy for unknown roles", async () => {
    const { loadRegistry, defaultAgentForRole } = await import("../core/agents/registry.js");
    await loadRegistry();
    // Role not in any descriptor defaultRoles — legacy fallback
    assert.equal(defaultAgentForRole("planner"), "codex"); // legacy: planner→codex
    assert.equal(defaultAgentForRole("executor"), "claude"); // legacy: executor→claude
  });

  it("legacyAgentForPhase returns correct mappings", async () => {
    const { loadRegistry, legacyAgentForPhase } = await import("../core/agents/registry.js");
    await loadRegistry();
    assert.equal(legacyAgentForPhase("plan"), "codex");
    assert.equal(legacyAgentForPhase("verify"), "codex");
    assert.equal(legacyAgentForPhase("review"), "codex");
    assert.equal(legacyAgentForPhase("execute"), "claude");
    assert.equal(legacyAgentForPhase("repair"), "claude");
  });

  it("resolveAgentCommand uses env override", async () => {
    const { loadRegistry, resolveAgentCommand } = await import("../core/agents/registry.js");
    await loadRegistry();

    // Set env override
    process.env.CPB_ACP_CODEX_COMMAND = "/custom/codex-bin";
    process.env.CPB_ACP_CODEX_ARGS = "--fast --verbose";
    try {
      const resolved = resolveAgentCommand("codex");
      assert.equal(resolved.command, "/custom/codex-bin");
      assert.deepEqual(resolved.args, ["--fast", "--verbose"]);
      assert.equal(resolved.source, "env");
    } finally {
      delete process.env.CPB_ACP_CODEX_COMMAND;
      delete process.env.CPB_ACP_CODEX_ARGS;
    }
  });

  it("resolveAgentCommand uses descriptor when no env override", async () => {
    const { loadRegistry, resolveAgentCommand } = await import("../core/agents/registry.js");
    await loadRegistry();

    const resolved = resolveAgentCommand("codex");
    assert.equal(resolved.command, "codex-acp");
    assert.equal(resolved.source, "descriptor");
    assert.ok(resolved.fallbackCommand);
  });

  it("resolveAgentCommand returns null for unknown agent", async () => {
    const { loadRegistry, resolveAgentCommand } = await import("../core/agents/registry.js");
    await loadRegistry();

    assert.equal(resolveAgentCommand("nonexistent"), null);
  });

  it("agentsWithCapability filters correctly", async () => {
    const { loadRegistry, agentsWithCapability } = await import("../core/agents/registry.js");
    await loadRegistry();

    const planners = agentsWithCapability("plan");
    const names = planners.map((d) => d.name);
    assert.ok(names.includes("codex"));
    assert.ok(names.includes("claude"));
    assert.ok(!names.includes("gemini"));

    const repairers = agentsWithCapability("repair");
    const repairNames = repairers.map((d) => d.name);
    assert.ok(repairNames.includes("claude"));
    assert.ok(!repairNames.includes("codex"));
  });

  it("isAgentStable checks stability field", async () => {
    const { loadRegistry, isAgentStable } = await import("../core/agents/registry.js");
    await loadRegistry();

    assert.equal(isAgentStable("codex"), true);
    assert.equal(isAgentStable("claude"), true);
    assert.equal(isAgentStable("gemini"), false);
    assert.equal(isAgentStable("nonexistent"), false);
  });

  it("poolLimitForAgent reads env and descriptor defaults", async () => {
    const { loadRegistry, poolLimitForAgent } = await import("../core/agents/registry.js");
    await loadRegistry();

    process.env.CPB_ACP_POOL_CODEX = "5";
    try {
      assert.equal(poolLimitForAgent("codex"), 5);
    } finally {
      delete process.env.CPB_ACP_POOL_CODEX;
    }

    // Without env, uses descriptor default or 2
    const defaultLimit = poolLimitForAgent("codex");
    assert.ok(defaultLimit >= 1);
  });

  it("listAgents returns all loaded agents", async () => {
    const { loadRegistry, listAgents, listAgentNames } = await import("../core/agents/registry.js");
    await loadRegistry();

    const agents = listAgents();
    assert.ok(agents.length >= 2);
    const names = listAgentNames();
    assert.ok(names.includes("codex"));
    assert.ok(names.includes("claude"));
    assert.ok(!names.includes("gemini"));
  });

  it("skips invalid descriptors gracefully", async () => {
    const configDir = path.join(tmpDir, "bad-agents");
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "bad1.json"), JSON.stringify({ name: "" }));
    await writeFile(path.join(configDir, "bad2.json"), "not json at all");
    await writeFile(path.join(configDir, "bad3.txt"), "not a json file");

    const { loadRegistry, hasAgent } = await import("../core/agents/registry.js");
    await loadRegistry(configDir);
    assert.equal(hasAgent("bad1"), false);
  });
});
