import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  gatePassed,
  gateBlocked,
  gateFailed,
  isGatePassed,
  isGateBlocked,
  isGateFailed,
  isValidGateStatus,
} from "../core/gates/gate-result.js";
import {
  createGateEngine,
  createGateEngineWithBuiltins,
} from "../core/gates/gate-engine.js";

// --- gate-result tests ---

describe("gate-result", () => {
  it("gatePassed has status passed", () => {
    const r = gatePassed({ gateType: "test" });
    assert.equal(r.status, "passed");
    assert.equal(r.gateType, "test");
    assert.equal(r.schemaVersion, 1);
    assert.ok(r.createdAt);
  });

  it("gateBlocked has status blocked", () => {
    const r = gateBlocked({ gateType: "approval", reason: "waiting" });
    assert.equal(r.status, "blocked");
    assert.equal(r.reason, "waiting");
  });

  it("gateFailed has status failed", () => {
    const r = gateFailed({ gateType: "policy", reason: "denied" });
    assert.equal(r.status, "failed");
    assert.equal(r.reason, "denied");
  });

  it("predicates work correctly", () => {
    assert.equal(isGatePassed(gatePassed({ gateType: "x" })), true);
    assert.equal(isGatePassed(gateFailed({ gateType: "x", reason: "r" })), false);
    assert.equal(isGateBlocked(gateBlocked({ gateType: "x", reason: "r" })), true);
    assert.equal(isGateFailed(gateFailed({ gateType: "x", reason: "r" })), true);
    assert.equal(isGatePassed(null), false);
    assert.equal(isGatePassed(undefined), false);
  });

  it("isValidGateStatus checks", () => {
    assert.equal(isValidGateStatus("passed"), true);
    assert.equal(isValidGateStatus("blocked"), true);
    assert.equal(isValidGateStatus("failed"), true);
    assert.equal(isValidGateStatus("unknown"), false);
  });

  it("results include metadata", () => {
    const r = gatePassed({ gateType: "t", reason: "ok", metadata: { key: "val" } });
    assert.deepEqual(r.metadata, { key: "val" });
    assert.equal(r.reason, "ok");
  });
});

// --- gate-engine tests ---

describe("gate-engine", () => {
  it("starts empty with no gates", () => {
    const engine = createGateEngine();
    assert.equal(engine.list().length, 0);
    assert.equal(engine.has("approval"), false);
  });

  it("registers and retrieves gates", () => {
    const engine = createGateEngine();
    const gate = {
      type: "custom",
      description: "test gate",
      evaluate: async () => gatePassed({ gateType: "custom" }),
    };
    engine.register(gate);
    assert.equal(engine.has("custom"), true);
    assert.equal(engine.get("custom"), gate);
    assert.equal(engine.list().length, 1);
  });

  it("validates gate on registration", () => {
    const engine = createGateEngine();
    assert.throws(() => engine.register(null), /gate must have a string \.type/);
    assert.throws(() => engine.register({ type: 123 }), /gate must have a string \.type/);
    assert.throws(() => engine.register({ type: "x" }), /must have an \.evaluate function/);
    assert.throws(() => engine.register({ type: "x", evaluate: "not a fn" }), /must have an \.evaluate function/);
  });

  it("evaluate returns passed when all gates pass", async () => {
    const engine = createGateEngine();
    engine.register({
      type: "a",
      evaluate: async () => gatePassed({ gateType: "a" }),
    });
    engine.register({
      type: "b",
      evaluate: async () => gatePassed({ gateType: "b" }),
    });

    const { results, overall } = await engine.evaluate(["a", "b"], {});
    assert.equal(overall, "passed");
    assert.equal(results.length, 2);
    assert.equal(results[0].gateType, "a");
    assert.equal(results[1].gateType, "b");
  });

  it("evaluate short-circuits on blocked", async () => {
    const engine = createGateEngine();
    let bEvaluated = false;
    engine.register({
      type: "a",
      evaluate: async () => gateBlocked({ gateType: "a", reason: "wait" }),
    });
    engine.register({
      type: "b",
      evaluate: async () => { bEvaluated = true; return gatePassed({ gateType: "b" }); },
    });

    const { results, overall } = await engine.evaluate(["a", "b"], {});
    assert.equal(overall, "blocked");
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "blocked");
    assert.equal(bEvaluated, false);
  });

  it("evaluate short-circuits on failed", async () => {
    const engine = createGateEngine();
    let bEvaluated = false;
    engine.register({
      type: "a",
      evaluate: async () => gateFailed({ gateType: "a", reason: "nope" }),
    });
    engine.register({
      type: "b",
      evaluate: async () => { bEvaluated = true; return gatePassed({ gateType: "b" }); },
    });

    const { results, overall } = await engine.evaluate(["a", "b"], {});
    assert.equal(overall, "failed");
    assert.equal(results.length, 1);
    assert.equal(bEvaluated, false);
  });

  it("evaluate fails on unknown gate type", async () => {
    const engine = createGateEngine();
    const { results, overall } = await engine.evaluate(["nonexistent"], {});
    assert.equal(overall, "failed");
    assert.equal(results[0].reason, "unknown gate type: nonexistent");
  });

  it("evaluate passes on empty gate list", async () => {
    const engine = createGateEngine();
    const { results, overall } = await engine.evaluate([], {});
    assert.equal(overall, "passed");
    assert.equal(results.length, 0);
  });

  it("evaluateForPhase resolves gates from workflowGates", async () => {
    const engine = createGateEngine();
    engine.register({
      type: "approval",
      evaluate: async () => gatePassed({ gateType: "approval" }),
    });

    const { overall } = await engine.evaluateForPhase("execute", {
      workflowGates: { execute: ["approval"] },
    });
    assert.equal(overall, "passed");
  });

  it("evaluateForPhase passes when no gates configured", async () => {
    const engine = createGateEngine();
    const { overall, results } = await engine.evaluateForPhase("verify", {});
    assert.equal(overall, "passed");
    assert.equal(results.length, 0);
  });

  it("evaluateForPhase filters non-string entries", async () => {
    const engine = createGateEngine();
    const { overall, results } = await engine.evaluateForPhase("execute", {
      workflowGates: { execute: [null, 123, undefined] },
    });
    assert.equal(overall, "passed");
    assert.equal(results.length, 0);
  });

  it("accepts gates via constructor option", () => {
    const gate = {
      type: "init",
      evaluate: async () => gatePassed({ gateType: "init" }),
    };
    const engine = createGateEngine({ gates: [gate] });
    assert.equal(engine.has("init"), true);
    assert.equal(engine.list().length, 1);
  });
});

// --- built-in approval gate tests ---

describe("approval gate (built-in)", () => {
  it("passes when approval granted", async () => {
    const engine = await createGateEngineWithBuiltins();
    const { results, overall } = await engine.evaluate(["approval"], {
      approvalStatus: "approved",
      actor: "alice",
    });
    assert.equal(overall, "passed");
    assert.equal(results[0].gateType, "approval");
    assert.ok(results[0].reason.includes("alice"));
  });

  it("blocks when approval pending", async () => {
    const engine = await createGateEngineWithBuiltins();
    const { overall, results } = await engine.evaluate(["approval"], {
      approvalStatus: "pending",
    });
    assert.equal(overall, "blocked");
    assert.equal(results[0].status, "blocked");
  });

  it("fails when approval rejected", async () => {
    const engine = await createGateEngineWithBuiltins();
    const { overall, results } = await engine.evaluate(["approval"], {
      approvalStatus: "rejected",
      reason: "security concern",
    });
    assert.equal(overall, "failed");
    assert.ok(results[0].reason.includes("security concern"));
  });

  it("passes when approval not required and no status", async () => {
    const engine = await createGateEngineWithBuiltins();
    const { overall } = await engine.evaluate(["approval"], {
      approvalRequired: false,
    });
    assert.equal(overall, "passed");
  });

  it("blocks when approval required but no status", async () => {
    const engine = await createGateEngineWithBuiltins();
    const { overall } = await engine.evaluate(["approval"], {
      approvalRequired: true,
    });
    assert.equal(overall, "blocked");
  });

  it("falls back to requiresApproval function", async () => {
    const engine = await createGateEngineWithBuiltins();
    const { overall } = await engine.evaluate(["approval"], {
      operation: "push",
      requiresApproval: (op) => op === "push",
    });
    assert.equal(overall, "blocked");
  });
});

// --- built-in artifact gate tests ---

describe("artifact gate (built-in)", () => {
  it("passes when artifact exists", async () => {
    const engine = await createGateEngineWithBuiltins();
    const { overall } = await engine.evaluate(["artifact"], {
      requiredArtifactKind: "plan",
      artifacts: [
        { kind: "plan", id: "001" },
        { kind: "deliverable", id: "002" },
      ],
    });
    assert.equal(overall, "passed");
  });

  it("fails when artifact missing", async () => {
    const engine = await createGateEngineWithBuiltins();
    const { overall, results } = await engine.evaluate(["artifact"], {
      requiredArtifactKind: "plan",
      artifacts: [{ kind: "deliverable", id: "002" }],
    });
    assert.equal(overall, "failed");
    assert.ok(results[0].reason.includes("plan"));
  });

  it("fails when specific artifact id not found", async () => {
    const engine = await createGateEngineWithBuiltins();
    const { overall } = await engine.evaluate(["artifact"], {
      requiredArtifactKind: "plan",
      requiredArtifactId: "099",
      artifacts: [{ kind: "plan", id: "001" }],
    });
    assert.equal(overall, "failed");
  });

  it("passes when no artifact kind specified", async () => {
    const engine = await createGateEngineWithBuiltins();
    const { overall } = await engine.evaluate(["artifact"], {});
    assert.equal(overall, "passed");
  });

  it("fails with available artifacts in metadata", async () => {
    const engine = await createGateEngineWithBuiltins();
    const { results } = await engine.evaluate(["artifact"], {
      requiredArtifactKind: "plan",
      artifacts: [{ kind: "deliverable", id: "001" }],
    });
    assert.deepEqual(results[0].metadata.availableArtifacts, ["deliverable:001"]);
  });
});

// --- built-in policy gate tests ---

describe("policy gate (built-in)", () => {
  it("passes when no policy configured", async () => {
    const engine = await createGateEngineWithBuiltins();
    const { overall } = await engine.evaluate(["policy"], { operation: "push" });
    assert.equal(overall, "passed");
  });

  it("passes when operation not in policy", async () => {
    const engine = await createGateEngineWithBuiltins();
    const { overall } = await engine.evaluate(["policy"], {
      policy: { approvals: {} },
      operation: "push",
    });
    assert.equal(overall, "passed");
  });

  it("passes when operation does not require approval", async () => {
    const engine = await createGateEngineWithBuiltins();
    const { overall } = await engine.evaluate(["policy"], {
      policy: { approvals: { push: { required: false } } },
      operation: "push",
    });
    assert.equal(overall, "passed");
  });

  it("fails when operation requires approval but none granted", async () => {
    const engine = await createGateEngineWithBuiltins();
    const { overall } = await engine.evaluate(["policy"], {
      policy: { approvals: { push: { required: true } } },
      operation: "push",
    });
    assert.equal(overall, "failed");
  });

  it("passes when operation requires approval and is approved", async () => {
    const engine = await createGateEngineWithBuiltins();
    const { overall } = await engine.evaluate(["policy"], {
      policy: { approvals: { push: { required: true } } },
      operation: "push",
      approvalStatus: "approved",
    });
    assert.equal(overall, "passed");
  });

  it("passes when policy has no approvals section", async () => {
    const engine = await createGateEngineWithBuiltins();
    const { overall } = await engine.evaluate(["policy"], {
      policy: { routing: {} },
      operation: "push",
    });
    assert.equal(overall, "passed");
  });
});

// --- built-in test gate tests ---

describe("test gate (built-in)", () => {
  it("passes when all tests pass", async () => {
    const engine = await createGateEngineWithBuiltins();
    const { overall } = await engine.evaluate(["test"], {
      testResults: { passed: 10, failed: 0, total: 10 },
    });
    assert.equal(overall, "passed");
  });

  it("fails when tests fail", async () => {
    const engine = await createGateEngineWithBuiltins();
    const { overall, results } = await engine.evaluate(["test"], {
      testResults: { passed: 8, failed: 2, total: 10 },
    });
    assert.equal(overall, "failed");
    assert.ok(results[0].reason.includes("2 test(s) failed"));
  });

  it("passes when no test results available", async () => {
    const engine = await createGateEngineWithBuiltins();
    const { overall } = await engine.evaluate(["test"], {});
    assert.equal(overall, "passed");
  });

  it("passes when tests fail but requireAllPass is false", async () => {
    const engine = await createGateEngineWithBuiltins();
    const { overall } = await engine.evaluate(["test"], {
      testResults: { passed: 8, failed: 2, total: 10 },
      requireAllPass: false,
    });
    assert.equal(overall, "passed");
  });

  it("passes when total is zero", async () => {
    const engine = await createGateEngineWithBuiltins();
    const { overall } = await engine.evaluate(["test"], {
      testResults: { passed: 0, failed: 0, total: 0 },
    });
    assert.equal(overall, "passed");
  });
});

// --- createGateEngineWithBuiltins tests ---

describe("createGateEngineWithBuiltins", () => {
  it("loads all four built-in gates", async () => {
    const engine = await createGateEngineWithBuiltins();
    assert.equal(engine.has("approval"), true);
    assert.equal(engine.has("artifact"), true);
    assert.equal(engine.has("policy"), true);
    assert.equal(engine.has("test"), true);
    assert.equal(engine.list().length, 4);
  });

  it("allows registering additional gates", async () => {
    const engine = await createGateEngineWithBuiltins();
    engine.register({
      type: "custom",
      evaluate: async () => gatePassed({ gateType: "custom" }),
    });
    assert.equal(engine.list().length, 5);
    assert.equal(engine.has("custom"), true);
  });
});

// --- multi-gate pipeline simulation ---

describe("multi-gate pipeline simulation", () => {
  it("approval + artifact + test all pass", async () => {
    const engine = await createGateEngineWithBuiltins();
    const { overall, results } = await engine.evaluate(
      ["approval", "artifact", "test"],
      {
        approvalStatus: "approved",
        actor: "bob",
        requiredArtifactKind: "plan",
        artifacts: [{ kind: "plan", id: "001" }],
        testResults: { passed: 5, failed: 0, total: 5 },
      },
    );
    assert.equal(overall, "passed");
    assert.equal(results.length, 3);
  });

  it("stops at first failing gate", async () => {
    const engine = await createGateEngineWithBuiltins();
    const { overall, results } = await engine.evaluate(
      ["approval", "artifact", "test"],
      {
        approvalStatus: "approved",
        requiredArtifactKind: "plan",
        artifacts: [],
      },
    );
    assert.equal(overall, "failed");
    assert.equal(results.length, 2); // approval passed, artifact failed
    assert.equal(results[0].status, "passed");
    assert.equal(results[1].status, "failed");
  });
});
