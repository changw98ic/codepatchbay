import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  loadRegistry,
  listSquads,
  getSquad,
  resolveSquadAgent,
} from "../core/agents/registry.js";

describe("squads", () => {
  beforeEach(async () => {
    await loadRegistry();
  });

  it("listSquads returns all defined squads", async () => {
    const squads = listSquads();
    assert.ok(Array.isArray(squads));
    assert.ok(squads.length >= 4, `expected at least 4 squads, got ${squads.length}`);

    const names = squads.map((s) => s.name);
    assert.ok(names.includes("frontend"));
    assert.ok(names.includes("backend"));
    assert.ok(names.includes("full-stack"));
    assert.ok(names.includes("review"));
  });

  it("getSquad returns squad definition", () => {
    const frontend = getSquad("frontend");
    assert.ok(frontend);
    assert.equal(frontend.leader, "claude");
    assert.ok(Array.isArray(frontend.members));
    assert.ok(frontend.members.includes("claude"));
    assert.ok(frontend.members.includes("gemini"));
  });

  it("getSquad returns null for unknown squad", () => {
    const result = getSquad("nonexistent");
    assert.equal(result, null);
  });

  it("resolveSquadAgent returns leader by default (leader-first strategy)", () => {
    const agent = resolveSquadAgent("frontend");
    assert.ok(agent);
    // claude is leader and is a builtin agent
    assert.equal(agent, "claude");
  });

  it("resolveSquadAgent respects explicit strategy", () => {
    // round-robin should cycle through members
    const a1 = resolveSquadAgent("full-stack", { strategy: "round-robin" });
    const a2 = resolveSquadAgent("full-stack", { strategy: "round-robin" });
    assert.ok(a1);
    assert.ok(a2);
    // They should be different members (unless only 1 available)
    const members = getSquad("full-stack").members;
    assert.ok(members.includes(a1));
    assert.ok(members.includes(a2));
  });

  it("resolveSquadAgent least-busy uses poolStatus", () => {
    const poolStatus = {
      codex: { active: 3 },
      claude: { active: 0 },
    };
    const agent = resolveSquadAgent("backend", { strategy: "least-busy", poolStatus });
    // claude has 0 active, codex has 3
    assert.equal(agent, "claude");
  });

  it("resolveSquadAgent least-busy falls back to leader without poolStatus", () => {
    const agent = resolveSquadAgent("backend", { strategy: "least-busy" });
    assert.equal(agent, "codex"); // backend leader is codex
  });

  it("resolveSquadAgent returns null for unknown squad", () => {
    const result = resolveSquadAgent("nonexistent");
    assert.equal(result, null);
  });
});

describe("squad in workflow DAG", () => {
  it("normalizeWorkflow defers squad resolution to runtime", async () => {
    const { normalizeWorkflow, registerDagWorkflow, resolveNodeAgent } = await import("../core/workflow/definition.js");

    registerDagWorkflow("test-squad-dag", {
      nodes: [
        { id: "plan", phase: "plan", role: "planner", dependsOn: [] },
        { id: "execute", phase: "execute", squad: "frontend", dependsOn: ["plan"] },
        { id: "verify", phase: "verify", role: "verifier", dependsOn: ["execute"] },
      ],
    });

    const dag = normalizeWorkflow("test-squad-dag");
    const execNode = dag.nodes.find((n) => n.id === "execute");
    assert.ok(execNode);
    // Squad is deferred — no agent at init time
    assert.equal(execNode._squad, "frontend");
    // Agent resolved at runtime via resolveNodeAgent
    const agent = resolveNodeAgent(execNode);
    assert.equal(agent, "claude");
  });

  it("normalizeWorkflow preserves nodes without squad", async () => {
    const { normalizeWorkflow } = await import("../core/workflow/definition.js");

    const dag = normalizeWorkflow("standard");
    // standard workflow has no squad fields
    for (const node of dag.nodes) {
      assert.equal(node._squad, undefined);
    }
  });
});
