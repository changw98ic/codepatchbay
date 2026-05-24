import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  ROUTING_TASK_CATEGORIES,
  resolveRoutingForCategory,
  validateRoutingRules,
  assertValidRoutingRules,
} from "../core/agents/routing.js";

import { normalizeWorkflow } from "../core/workflow/definition.js";

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

  it("exposes setup metadata for known runtime agents without changing ACP descriptors", async () => {
    const { loadRegistry, getDescriptor, getSetupMetadata } = await import("../core/agents/registry.js");
    await loadRegistry();

    const codexDescriptor = getDescriptor("codex");
    const codexSetup = getSetupMetadata("codex");

    assert.equal(codexDescriptor.command, "codex-acp");
    assert.equal(codexSetup.id, "codex");
    assert.equal(codexSetup.binary, "codex");
    assert.deepEqual(codexSetup.installMethods, ["npm", "brew"]);
    assert.ok(codexSetup.roles.includes("planner"));
    assert.equal(getSetupMetadata("nonexistent"), null);
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

// ---------------------------------------------------------------------------
// D37 Routing Rules Config tests
// ---------------------------------------------------------------------------

// 1. All required categories are supported
describe("ROUTING_TASK_CATEGORIES", () => {
  it("contains every required task category", () => {
    const required = [
      "bugfix",
      "test",
      "docs",
      "security",
      "frontend",
      "backend",
      "infra",
      "research",
      "review",
    ];
    for (const cat of required) {
      assert.ok(
        ROUTING_TASK_CATEGORIES.includes(cat),
        `missing category: ${cat}`,
      );
    }
  });
});

// 2. Project routing config overrides workflow + phase agents
describe("resolveRoutingForCategory", () => {
  it("applies project routing rule for a known category", () => {
    const routing = {
      security: {
        workflow: "complex",
        planner: "codex",
        executor: "claude",
        verifier: "codex",
        reviewer: "codex",
      },
    };

    const resolved = resolveRoutingForCategory("security", routing);
    assert.equal(resolved.workflow, "complex");
    assert.equal(resolved.planner, "codex");
    assert.equal(resolved.executor, "claude");
    assert.equal(resolved.verifier, "codex");
    assert.equal(resolved.reviewer, "codex");
  });

  it("returns null when no rule matches the category", () => {
    const routing = {
      security: {
        workflow: "complex",
        planner: "codex",
        executor: "claude",
        verifier: "codex",
        reviewer: "codex",
      },
    };

    const resolved = resolveRoutingForCategory("frontend", routing);
    assert.equal(resolved, null);
  });
});

// 3. normalizeWorkflow with routing yields correct DAG nodes
describe("normalizeWorkflow with routing", () => {
  it("yields complex workflow nodes when security routing is configured", () => {
    const routing = {
      security: {
        workflow: "complex",
        planner: "codex",
        executor: "claude",
        verifier: "codex",
        reviewer: "codex",
      },
    };

    const dag = normalizeWorkflow("standard", {
      category: "security",
      routing,
    });

    // Complex workflow has 4 phases: plan, execute, review, verify
    assert.equal(dag.name, "complex");
    assert.equal(dag.nodes.length, 4);

    const phaseIds = dag.nodes.map((n) => n.id ?? n.phase);
    assert.ok(phaseIds.includes("plan"));
    assert.ok(phaseIds.includes("execute"));
    assert.ok(phaseIds.includes("review"));
    assert.ok(phaseIds.includes("verify"));

    // Agents from routing rule should be applied to nodes
    const planNode = dag.nodes.find((n) => (n.id ?? n.phase) === "plan");
    assert.equal(planNode.agent, "codex");

    const executeNode = dag.nodes.find((n) => (n.id ?? n.phase) === "execute");
    assert.equal(executeNode.agent, "claude");

    const reviewNode = dag.nodes.find((n) => (n.id ?? n.phase) === "review");
    assert.equal(reviewNode.agent, "codex");

    const verifyNode = dag.nodes.find((n) => (n.id ?? n.phase) === "verify");
    assert.equal(verifyNode.agent, "codex");
  });
});

// 4. Fallback: category with no project rule uses default agents
describe("normalizeWorkflow fallback", () => {
  it("uses default agents when category has no routing rule", () => {
    const routing = {};

    const dag = normalizeWorkflow("standard", {
      category: "docs",
      routing,
    });

    // Standard workflow: plan -> execute -> verify
    assert.equal(dag.name, "standard");
    assert.equal(dag.nodes.length, 3);

    // Default agents: planner codex, executor claude, verifier codex
    const planNode = dag.nodes.find((n) => (n.id ?? n.phase) === "plan");
    assert.equal(planNode.agent, "codex");

    const executeNode = dag.nodes.find((n) => (n.id ?? n.phase) === "execute");
    assert.equal(executeNode.agent, "claude");

    const verifyNode = dag.nodes.find((n) => (n.id ?? n.phase) === "verify");
    assert.equal(verifyNode.agent, "codex");
  });

  it("uses default agents when routing is null", () => {
    const dag = normalizeWorkflow("standard", {
      category: "infra",
      routing: null,
    });

    assert.equal(dag.name, "standard");
    assert.equal(dag.nodes.length, 3);

    const planNode = dag.nodes.find((n) => (n.id ?? n.phase) === "plan");
    assert.equal(planNode.agent, "codex");
  });
});

// 5. Invalid agent names fail validation before job start
describe("validateRoutingRules", () => {
  it("rejects routing with unknown agent name", () => {
    const routing = {
      security: {
        workflow: "standard",
        planner: "codex",
        executor: "totally-fake-agent",
        verifier: "codex",
      },
    };

    const result = validateRoutingRules(routing);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
    assert.ok(
      result.errors[0].includes("totally-fake-agent"),
      `error should mention the bad agent, got: ${result.errors[0]}`,
    );
  });

  it("accepts routing with valid agent names", () => {
    const routing = {
      security: {
        workflow: "complex",
        planner: "codex",
        executor: "claude",
        verifier: "codex",
        reviewer: "codex",
      },
    };

    const result = validateRoutingRules(routing);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it("rejects unknown category names", () => {
    const routing = {
      totally_fake_category: {
        workflow: "standard",
        planner: "codex",
        executor: "claude",
        verifier: "codex",
      },
    };

    const result = validateRoutingRules(routing);
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((e) => e.includes("totally_fake_category")),
      `error should mention unknown category`,
    );
  });
});

describe("assertValidRoutingRules", () => {
  it("throws on invalid agent name", () => {
    const routing = {
      frontend: {
        workflow: "standard",
        planner: "codex",
        executor: "no-such-agent",
        verifier: "codex",
      },
    };

    assert.throws(
      () => assertValidRoutingRules(routing),
      (err) => err.message.includes("no-such-agent"),
    );
  });

  it("does not throw on valid rules", () => {
    const routing = {
      bugfix: {
        workflow: "standard",
        planner: "codex",
        executor: "claude",
        verifier: "codex",
      },
    };

    // Should not throw
    assertValidRoutingRules(routing);
  });
});
