import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import {
  evaluatePermissionDecision,
  validateRole,
} from "../server/services/permission-matrix.js";
import { createJob } from "../server/services/job-store.js";
import { readEvents } from "../server/services/event-store.js";
import {
  validatePolicy,
  defaultPolicy,
  requiresApproval,
  approvalOperations,
} from "../core/policy/team-policy.js";

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

describe("D46 - team-policy schema and enforcement", () => {
  // --- Schema validation ---

  it("validatePolicy accepts a valid policy object", () => {
    const policy = {
      approvals: {
        write: { required: true, channels: ["slack"] },
        shell: { required: false },
        network: { required: true, channels: ["slack", "email"] },
        push: { required: true, channels: ["slack"] },
        PR: { required: true, channels: ["slack"] },
        merge: { required: true, channels: ["slack"], minReviewers: 2 },
      },
      routing: { defaultAgent: "codex" },
      channels: {
        slack: { enabled: true, allowedActions: ["run", "status"], requireSignedRequests: true },
      },
      protectedOperations: ["merge"],
    };
    const result = validatePolicy(policy);
    assert.deepStrictEqual(result.valid, true);
    assert.deepStrictEqual(result.errors.length, 0);
  });

  it("validatePolicy rejects null", () => {
    const result = validatePolicy(null);
    assert.deepStrictEqual(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it("validatePolicy rejects non-object", () => {
    const result = validatePolicy("not a policy");
    assert.deepStrictEqual(result.valid, false);
  });

  it("validatePolicy rejects policy with invalid approval operation name", () => {
    const result = validatePolicy({
      approvals: {
        write: { required: true },
        [Symbol("bad")]: { required: true },
      },
    });
    assert.deepStrictEqual(result.valid, false);
  });

  it("validatePolicy rejects approval entry without required field", () => {
    const result = validatePolicy({
      approvals: { write: { channels: ["slack"] } },
    });
    assert.deepStrictEqual(result.valid, false);
  });

  // --- Default policy ---

  it("defaultPolicy returns local-first policy with no approvals required", () => {
    const policy = defaultPolicy();
    const ops = approvalOperations();
    for (const op of ops) {
      assert.deepStrictEqual(
        requiresApproval(policy, op),
        false,
        `default policy should not require approval for ${op}`
      );
    }
  });

  it("defaultPolicy passes validatePolicy", () => {
    const result = validatePolicy(defaultPolicy());
    assert.deepStrictEqual(result.valid, true);
  });

  // --- Approval checking ---

  it("requiresApproval returns true when policy mandates approval for write", () => {
    const policy = {
      approvals: { write: { required: true, channels: ["slack"] } },
    };
    assert.deepStrictEqual(requiresApproval(policy, "write"), true);
  });

  it("requiresApproval returns false when policy marks shell as not required", () => {
    const policy = {
      approvals: { shell: { required: false } },
    };
    assert.deepStrictEqual(requiresApproval(policy, "shell"), false);
  });

  it("requiresApproval returns false for operation not listed in policy", () => {
    const policy = {
      approvals: { write: { required: true, channels: ["slack"] } },
    };
    assert.deepStrictEqual(requiresApproval(policy, "network"), false);
  });

  it("requiresApproval returns true for network when configured", () => {
    const policy = {
      approvals: { network: { required: true, channels: ["email"] } },
    };
    assert.deepStrictEqual(requiresApproval(policy, "network"), true);
  });

  it("requiresApproval returns true for push when configured", () => {
    const policy = {
      approvals: { push: { required: true, channels: ["slack"] } },
    };
    assert.deepStrictEqual(requiresApproval(policy, "push"), true);
  });

  it("requiresApproval returns true for PR when configured", () => {
    const policy = {
      approvals: { PR: { required: true, channels: ["slack"] } },
    };
    assert.deepStrictEqual(requiresApproval(policy, "PR"), true);
  });

  it("requiresApproval returns true for merge when configured", () => {
    const policy = {
      approvals: { merge: { required: true, channels: ["slack"], minReviewers: 2 } },
    };
    assert.deepStrictEqual(requiresApproval(policy, "merge"), true);
  });

  it("approvalOperations returns all six operation categories", () => {
    const ops = approvalOperations();
    assert.ok(ops.includes("write"));
    assert.ok(ops.includes("shell"));
    assert.ok(ops.includes("network"));
    assert.ok(ops.includes("push"));
    assert.ok(ops.includes("PR"));
    assert.ok(ops.includes("merge"));
  });

  // --- Invalid policy blocks job creation ---

  it("validatePolicy rejects policy with unknown top-level keys", () => {
    const result = validatePolicy({
      approvals: { write: { required: false } },
      bogusExtra: true,
    });
    assert.deepStrictEqual(result.valid, false);
  });

  it("validatePolicy rejects approvals.channels with non-array", () => {
    const result = validatePolicy({
      approvals: { write: { required: true, channels: "slack" } },
    });
    assert.deepStrictEqual(result.valid, false);
  });

  it("validatePolicy rejects approvals.minReviewers with non-number", () => {
    const result = validatePolicy({
      approvals: { merge: { required: true, minReviewers: "two" } },
    });
    assert.deepStrictEqual(result.valid, false);
  });

  it("validatePolicy rejects malformed routing, channels, and protected operations", () => {
    assert.deepStrictEqual(validatePolicy({ routing: "codex" }).valid, false);
    assert.deepStrictEqual(validatePolicy({
      routing: { defaultAgent: 42 },
    }).valid, false);
    assert.deepStrictEqual(validatePolicy({ channels: "slack" }).valid, false);
    assert.deepStrictEqual(validatePolicy({
      channels: { slack: { enabled: "yes" } },
    }).valid, false);
    assert.deepStrictEqual(validatePolicy({
      channels: { slack: { enabled: true, allowedActions: "run" } },
    }).valid, false);
    assert.deepStrictEqual(validatePolicy({
      channels: { slack: { enabled: true, allowedActions: [42] } },
    }).valid, false);
    assert.deepStrictEqual(validatePolicy({
      channels: { slack: { requireSignedRequests: "yes" } },
    }).valid, false);
    assert.deepStrictEqual(validatePolicy({
      channels: { slack: [] },
    }).valid, false);
    assert.deepStrictEqual(validatePolicy({ protectedOperations: "merge" }).valid, false);
    assert.deepStrictEqual(validatePolicy({ protectedOperations: ["destroy"] }).valid, false);
    assert.deepStrictEqual(validatePolicy({
      protectedOperations: [Symbol("merge")],
    }).valid, false);
  });

  it("createJob rejects invalid teamPolicy before writing job events", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "cpb-invalid-team-policy-"));
    const project = "policy-project";
    const jobId = "job-invalid-team-policy";
    try {
      await assert.rejects(
        () => createJob(tmp, {
          project,
          jobId,
          task: "invalid policy should not create a job",
          teamPolicy: {
            approvals: { write: { required: "yes" } },
          },
        }),
        /invalid team policy/i,
      );

      const events = await readEvents(tmp, project, jobId);
      assert.equal(events.length, 0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
