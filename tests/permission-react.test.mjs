import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  evaluatePermissionDecision,
  validateRole,
} from "../server/services/permission-matrix.js";

const CPB_ROOT = path.resolve("/tmp/cpb-test-react");
const PROJECT = "test-project";

describe("evaluatePermissionDecision — ReAct-style decision envelope", () => {
  it("allows read for normal project files", () => {
    const decision = evaluatePermissionDecision(
      "planner", "plan", "read",
      path.join(CPB_ROOT, "wiki", "projects", PROJECT, "inbox", "plan-001.md"),
      CPB_ROOT, PROJECT
    );
    assert.deepStrictEqual(decision.allowed, true);
    assert.deepStrictEqual(decision.classification, "allow");
    assert.deepStrictEqual(decision.action, "read");
    assert.deepStrictEqual(decision.observable, true);
  });

  it("denies read for .env paths", () => {
    const decision = evaluatePermissionDecision(
      "planner", "plan", "read",
      path.join(CPB_ROOT, ".env"),
      CPB_ROOT, PROJECT
    );
    assert.deepStrictEqual(decision.allowed, false);
    assert.deepStrictEqual(decision.classification, "deny");
    assert.deepStrictEqual(decision.action, "read");
    assert.ok(decision.reason.includes("secret"));
    assert.ok(decision.recoveryGuidance !== null);
    assert.deepStrictEqual(decision.observable, true);
  });

  it("denies read for *.pem paths", () => {
    const decision = evaluatePermissionDecision(
      "executor", "execute", "read",
      "/etc/ssl/certs/server.pem",
      CPB_ROOT, PROJECT
    );
    assert.deepStrictEqual(decision.allowed, false);
    assert.deepStrictEqual(decision.classification, "deny");
    assert.ok(decision.reason.includes("secret"));
  });

  it("denies read for *.key paths", () => {
    const decision = evaluatePermissionDecision(
      "verifier", "verify", "read",
      "/home/user/.ssh/id_rsa.key",
      CPB_ROOT, PROJECT
    );
    assert.deepStrictEqual(decision.allowed, false);
    assert.deepStrictEqual(decision.classification, "deny");
  });

  it("denies read for paths containing 'secret'", () => {
    const decision = evaluatePermissionDecision(
      "executor", "execute", "read",
      path.join(CPB_ROOT, "config", "secrets.json"),
      CPB_ROOT, PROJECT
    );
    assert.deepStrictEqual(decision.allowed, false);
    assert.deepStrictEqual(decision.classification, "deny");
  });

  it("denies read for paths containing 'token'", () => {
    const decision = evaluatePermissionDecision(
      "planner", "plan", "read",
      path.join(CPB_ROOT, "tokens", "access-token.json"),
      CPB_ROOT, PROJECT
    );
    assert.deepStrictEqual(decision.allowed, false);
    assert.deepStrictEqual(decision.classification, "deny");
  });

  it("allows write within phase scope", () => {
    const decision = evaluatePermissionDecision(
      "planner", "plan", "write",
      path.join(CPB_ROOT, "wiki", "projects", PROJECT, "inbox", "plan-001.md"),
      CPB_ROOT, PROJECT
    );
    assert.deepStrictEqual(decision.allowed, true);
    assert.deepStrictEqual(decision.classification, "allow");
    assert.deepStrictEqual(decision.action, "write");
  });

  it("denies write outside scope with infra_block classification", () => {
    const decision = evaluatePermissionDecision(
      "planner", "plan", "write",
      path.join(CPB_ROOT, "wiki", "projects", PROJECT, "outputs", "rogue.md"),
      CPB_ROOT, PROJECT
    );
    assert.deepStrictEqual(decision.allowed, false);
    assert.deepStrictEqual(decision.classification, "infra_block");
    assert.deepStrictEqual(decision.action, "write");
    assert.ok(typeof decision.reason === "string" && decision.reason.length > 0);
    assert.ok(decision.recoveryGuidance !== null);
    assert.deepStrictEqual(decision.observable, true);
  });

  it("classifies executor write to denied path as infra_block", () => {
    const decision = evaluatePermissionDecision(
      "executor", "execute", "write",
      path.join(CPB_ROOT, "wiki", "projects", PROJECT, "inbox", "sneaky.md"),
      CPB_ROOT, PROJECT
    );
    assert.deepStrictEqual(decision.allowed, false);
    assert.deepStrictEqual(decision.classification, "infra_block");
  });

  it("classifies verifier execute of mutation command as infra_block", () => {
    const decision = evaluatePermissionDecision(
      "verifier", "verify", "execute",
      "rm -rf /tmp/test",
      CPB_ROOT, PROJECT
    );
    assert.deepStrictEqual(decision.allowed, false);
    assert.deepStrictEqual(decision.classification, "infra_block");
  });

  it("allows executor execute for safe commands", () => {
    const decision = evaluatePermissionDecision(
      "executor", "execute", "execute",
      "npm test",
      CPB_ROOT, PROJECT
    );
    assert.deepStrictEqual(decision.allowed, true);
    assert.deepStrictEqual(decision.classification, "allow");
  });

  it("decision envelope has all required fields", () => {
    const decision = evaluatePermissionDecision(
      "planner", "plan", "read",
      path.join(CPB_ROOT, "wiki", "projects", PROJECT, "inbox", "plan-001.md"),
      CPB_ROOT, PROJECT
    );
    const requiredFields = ["allowed", "classification", "action", "role", "phase", "reason", "recoveryGuidance", "observable"];
    for (const field of requiredFields) {
      assert.ok(field in decision, `missing field: ${field}`);
    }
    assert.deepStrictEqual(decision.role, "planner");
    assert.deepStrictEqual(decision.phase, "plan");
  });

  it("recoveryGuidance is non-null when denied", () => {
    // Read denial (secret path)
    const readDenial = evaluatePermissionDecision(
      "planner", "plan", "read",
      path.join(CPB_ROOT, ".env.production"),
      CPB_ROOT, PROJECT
    );
    assert.deepStrictEqual(readDenial.allowed, false);
    assert.ok(readDenial.recoveryGuidance !== null);
    assert.ok(typeof readDenial.recoveryGuidance === "string");
    assert.ok(readDenial.recoveryGuidance.length > 0);

    // Write denial (out of scope)
    const writeDenial = evaluatePermissionDecision(
      "verifier", "verify", "write",
      path.join(CPB_ROOT, "wiki", "projects", PROJECT, "inbox", "bad.md"),
      CPB_ROOT, PROJECT
    );
    assert.deepStrictEqual(writeDenial.allowed, false);
    assert.ok(writeDenial.recoveryGuidance !== null);
    assert.ok(typeof writeDenial.recoveryGuidance === "string");
    assert.ok(writeDenial.recoveryGuidance.length > 0);

    // Execute denial (unsafe command)
    const execDenial = evaluatePermissionDecision(
      "planner", "plan", "execute",
      "npm install",
      CPB_ROOT, PROJECT
    );
    assert.deepStrictEqual(execDenial.allowed, false);
    assert.ok(execDenial.recoveryGuidance !== null);
    assert.ok(typeof execDenial.recoveryGuidance === "string");
    assert.ok(execDenial.recoveryGuidance.length > 0);
  });

  it("observable is always true for all decision types", () => {
    const cases = [
      // allowed reads
      { role: "planner", phase: "plan", action: "read", target: "/tmp/normal-file.txt" },
      { role: "executor", phase: "execute", action: "read", target: "/tmp/src/index.js" },
      { role: "verifier", phase: "verify", action: "read", target: "/tmp/test/result.txt" },
      // denied reads (secret)
      { role: "planner", phase: "plan", action: "read", target: "/tmp/.env" },
      // allowed writes
      { role: "planner", phase: "plan", action: "write", target: path.join(CPB_ROOT, "wiki", "projects", PROJECT, "inbox", "plan-001.md") },
      { role: "executor", phase: "execute", action: "write", target: path.join(CPB_ROOT, "wiki", "projects", PROJECT, "outputs", "deliverable-001.md") },
      // denied writes
      { role: "planner", phase: "plan", action: "write", target: path.join(CPB_ROOT, "wiki", "projects", PROJECT, "outputs", "rogue.md") },
      // allowed execute
      { role: "executor", phase: "execute", action: "execute", target: "npm test" },
      // denied execute
      { role: "verifier", phase: "verify", action: "execute", target: "rm -rf /tmp" },
    ];

    for (const c of cases) {
      const decision = evaluatePermissionDecision(c.role, c.phase, c.action, c.target, CPB_ROOT, PROJECT);
      assert.deepStrictEqual(decision.observable, true, `observable not true for ${c.role}/${c.action}/${c.target}`);
    }
  });

  it("returns deny for unknown actions", () => {
    const decision = evaluatePermissionDecision(
      "planner", "plan", "delete",
      "/tmp/file.txt",
      CPB_ROOT, PROJECT
    );
    assert.deepStrictEqual(decision.allowed, false);
    assert.deepStrictEqual(decision.classification, "deny");
    assert.ok(decision.reason.includes("unknown action"));
    assert.deepStrictEqual(decision.observable, true);
  });

  it("works for all valid roles", () => {
    const roles = ["planner", "executor", "verifier", "repairer", "reviewer"];
    for (const role of roles) {
      const decision = evaluatePermissionDecision(
        role, "plan", "read",
        "/tmp/some/file.js",
        CPB_ROOT, PROJECT
      );
      assert.deepStrictEqual(decision.allowed, true, `${role} read should be allowed`);
      assert.deepStrictEqual(decision.role, role);
    }
  });
});
